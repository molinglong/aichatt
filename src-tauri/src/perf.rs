// 性能采样:CPU / 内存 / GPU。桌面小鸡的「过热」表现靠它驱动。
//
// 三条指标各走最省的路(全部零新依赖,复用依赖树里已有的 windows 0.61):
//   CPU  = GetSystemTimes 两次采样求差(kernel 含 idle,故 1 - idle/(kernel+user))
//   内存 = GlobalMemoryStatusEx 的 dwMemoryLoad(本身就是百分比)
//   GPU  = PDH 计数器 "\GPU Engine(*)\Utilization Percentage",按实例取最大值
//          (对齐任务管理器口径:多引擎里取最忙的那个,而不是把各引擎加起来超 100)
//
// PDH query 常驻复用(PDH_HQUERY 是进程级句柄,这几个调用线程安全),
// 每 3s 由前端拉一次 perf_probe,单次开销 <1%。
#![allow(unused_imports)]
use super::*;

use std::sync::{Mutex, OnceLock};

use windows::core::HSTRING;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

use std::ffi::c_void;
use windows::core::PCSTR;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

#[derive(Serialize)]
pub struct PerfSample {
    /// CPU 占用百分比(0~100,一位小数)
    cpu: f64,
    /// 物理内存占用百分比
    mem: f64,
    /// GPU 最忙引擎占用百分比;读不到时为 null(前端隐藏该项)
    gpu: Option<f64>,
    /// GPU 温度(摄氏度);仅 NVIDIA(nvml.dll 动态加载)可读,其它卡为 null
    gpu_temp: Option<f64>,
}

fn ft_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/** 上一次 CPU 采样(kernel, idle, user 累计值) */
static LAST_CPU: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

fn read_cpu() -> f64 {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
        return 0.0;
    }
    let cur = (ft_to_u64(kernel), ft_to_u64(idle), ft_to_u64(user));
    let mut guard = match LAST_CPU.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let prev = guard.replace(cur);
    let Some(prev) = prev else {
        return 0.0; // 首次没有基准值
    };
    let d_kernel = cur.0.saturating_sub(prev.0);
    let d_idle = cur.1.saturating_sub(prev.1);
    let d_user = cur.2.saturating_sub(prev.2);
    let total = d_kernel + d_user; // kernel 已含 idle
    if total == 0 {
        return 0.0;
    }
    let busy = total.saturating_sub(d_idle) as f64;
    (busy / total as f64 * 1000.0).round() / 10.0
}

fn read_mem() -> f64 {
    let mut st = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut st) }.is_err() {
        return 0.0;
    }
    st.dwMemoryLoad as f64
}

/** 常驻的 GPU 计数器(PDH 句柄进程级,跨线程调用安全) */
struct GpuQuery {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}
unsafe impl Send for GpuQuery {}

static GPU_QUERY: OnceLock<Mutex<Option<GpuQuery>>> = OnceLock::new();

fn gpu_query_slot() -> &'static Mutex<Option<GpuQuery>> {
    GPU_QUERY.get_or_init(|| Mutex::new(None))
}

fn gpu_open() -> Option<GpuQuery> {
    let mut query = PDH_HQUERY::default();
    if unsafe { PdhOpenQueryW(None, 0, &mut query) } != 0 {
        return None;
    }
    let mut counter = PDH_HCOUNTER::default();
    let path = HSTRING::from(r"\GPU Engine(*)\Utilization Percentage");
    let status = unsafe { PdhAddEnglishCounterW(query, &path, 0, &mut counter) };
    if status != 0 {
        unsafe {
            let _ = PdhCloseQuery(query);
        }
        return None;
    }
    Some(GpuQuery { query, counter })
}

fn read_gpu() -> Option<f64> {
    let slot = gpu_query_slot();
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if guard.is_none() {
        *guard = gpu_open();
    }
    let q = guard.as_ref()?;

    // 速率型计数器:每次采集取的是「上次采集到现在」的区间值,故查询常驻只采一次
    if unsafe { PdhCollectQueryData(q.query) } != 0 {
        return None;
    }

    let mut size: u32 = 0;
    let mut count: u32 = 0;
    let first = unsafe {
        PdhGetFormattedCounterArrayW(q.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
    };
    if first != PDH_MORE_DATA || size == 0 {
        return None;
    }
    // u64 缓冲保证 8 字节对齐(条目里有 f64)
    let words = size.div_ceil(8) as usize;
    let mut buf: Vec<u64> = vec![0; words];
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            q.counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            Some(buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W),
        )
    };
    if status != 0 {
        return None;
    }
    let items = unsafe {
        std::slice::from_raw_parts(
            buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W,
            count as usize,
        )
    };
    let mut peak = 0.0f64;
    for it in items {
        let ok = it.FmtValue.CStatus == PDH_CSTATUS_VALID_DATA || it.FmtValue.CStatus == PDH_CSTATUS_NEW_DATA;
        if !ok {
            continue;
        }
        let v = unsafe { it.FmtValue.Anonymous.doubleValue };
        if v.is_finite() && v > peak {
            peak = v;
        }
    }
    if count == 0 {
        return None;
    }
    Some((peak.min(100.0) * 10.0).round() / 10.0)
}

// ── GPU 温度:只有 NVIDIA 有免驱动、免管理员的读法(nvml.dll 随驱动分发) ──
// 不用 nvml crate:动态加载 nvml.dll,拿到 3 个函数指针就够。
// AMD / Intel 核显没有等价轻量接口,那些机器上返回 None,前端显示「—」。

type NvmlInit = unsafe extern "system" fn() -> i32;
type NvmlShutdown = unsafe extern "system" fn() -> i32;
type NvmlGetHandle = unsafe extern "system" fn(u32, *mut *mut c_void) -> i32;
type NvmlGetTemp = unsafe extern "system" fn(*mut c_void, i32, *mut u32) -> i32;

struct Nvml {
    handle: *mut c_void,
    get_temp: NvmlGetTemp,
    _shutdown: NvmlShutdown,
}

unsafe impl Send for Nvml {}

static NVML: OnceLock<Mutex<Option<Nvml>>> = OnceLock::new();

fn nvml_slot() -> &'static Mutex<Option<Nvml>> {
    NVML.get_or_init(|| Mutex::new(None))
}

fn nvml_open() -> Option<Nvml> {
    unsafe {
        let lib_name = HSTRING::from("nvml.dll");
        let lib = LoadLibraryW(&lib_name).ok()?;
        let sym = |name: &str| -> Option<*const c_void> {
            let c = std::ffi::CString::new(name).ok()?;
            let p = GetProcAddress(lib, PCSTR::from_raw(c.as_ptr() as *const u8));
            p.map(|f| f as *const c_void)
        };
        let init: NvmlInit = std::mem::transmute(sym("nvmlInit_v2")?);
        let shutdown: NvmlShutdown = std::mem::transmute(sym("nvmlShutdown")?);
        let get_handle: NvmlGetHandle = std::mem::transmute(sym("nvmlDeviceGetHandleByIndex_v2")?);
        let get_temp: NvmlGetTemp = std::mem::transmute(sym("nvmlDeviceGetTemperature")?);
        if init() != 0 {
            return None;
        }
        let mut handle: *mut c_void = std::ptr::null_mut();
        if get_handle(0, &mut handle) != 0 || handle.is_null() {
            let _ = shutdown();
            return None;
        }
        Some(Nvml {
            handle,
            get_temp,
            _shutdown: shutdown,
        })
    }
}

fn read_gpu_temp() -> Option<f64> {
    let slot = nvml_slot();
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if guard.is_none() {
        *guard = nvml_open();
    }
    let n = guard.as_ref()?;
    let mut temp: u32 = 0;
    // NVML_TEMPERATURE_GPU = 0
    if unsafe { (n.get_temp)(n.handle, 0, &mut temp) } != 0 {
        return None;
    }
    if temp == 0 || temp > 150 {
        return None;
    }
    Some(temp as f64)
}

/// 一次取齐 CPU / 内存 / GPU;前端 3s 轮询
#[tauri::command]
pub fn perf_probe() -> PerfSample {
    let sample = PerfSample {
        cpu: read_cpu(),
        mem: read_mem(),
        gpu: read_gpu(),
        gpu_temp: read_gpu_temp(),
    };
    // 前几次采样打证据(只在 debug 构建):CPU 首采无基准、GPU 速率计数器首采无区间,
    // 都要看第 2 次以后才准
    #[cfg(debug_assertions)]
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        if n < 4 {
            eprintln!(
                "[perf_probe #{}] cpu={:.1}% mem={:.1}% gpu={:?} temp={:?}",
                n + 1,
                sample.cpu,
                sample.mem,
                sample.gpu,
                sample.gpu_temp
            );
        }
    }
    sample
}

// ══════════ 历史体检:后台线程 10s 一笔,环形缓冲 ~24h,重启清零 ══════════
// 采样复用上面三条最省路径;与宠物页 3s 轮询交错安全
// (read_cpu 按真实间隔求差;PDH 速率计数器按「上次采集到现在」区间归一,谁采都准)。
// 线程在首个 perf_probe / perf_history 调用时拉起,进程级只此一条,零新依赖。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct HistPoint {
    /// unix 秒
    ts: i64,
    cpu: f64,
    mem: f64,
    gpu: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct HistEvent {
    /// 过热开始(unix 秒)
    start: i64,
    /// 持续秒数
    dur: i64,
    /// "CPU" | "内存" | "GPU"(与蛋壳标签同源)
    kind: String,
}

#[derive(Serialize)]
pub struct PerfHistory {
    points: Vec<HistPoint>,
    events: Vec<HistEvent>,
}

const HIST_CAP: usize = 8640; // 10s × 8640 ≈ 24 小时
const EVENT_CAP: usize = 500;

static HIST: Mutex<Vec<HistPoint>> = Mutex::new(Vec::new());
static EVENTS: Mutex<Vec<HistEvent>> = Mutex::new(Vec::new());
static HIST_THREAD: OnceLock<()> = OnceLock::new();

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn ensure_hist_thread() {
    HIST_THREAD.get_or_init(|| {
        std::thread::spawn(|| loop {
            let pt = HistPoint {
                ts: now_unix(),
                cpu: read_cpu(),
                mem: read_mem(),
                gpu: read_gpu(),
            };
            let mut guard = match HIST.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(), // 中毒也要继续记:历史线程不能哑火
            };
            guard.push(pt);
            let excess = guard.len().saturating_sub(HIST_CAP);
            guard.drain(0..excess);
            drop(guard);
            std::thread::sleep(Duration::from_secs(10));
        });
    });
}

/// 全量历史(前端自行按档位切片/抽稀);重启清零,导出留档走前端 JSON 下载
#[tauri::command]
pub fn perf_history() -> PerfHistory {
    ensure_hist_thread();
    let points = match HIST.lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    };
    let events = match EVENTS.lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    };
    PerfHistory { points, events }
}

/// 宠物页过热红蛋破壳后记账:真实「缩红蛋」时刻,与宠物动画同源
#[tauri::command]
pub fn perf_log_event(start: i64, dur: i64, kind: String) {
    let mut guard = match EVENTS.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    guard.push(HistEvent { start, dur, kind });
    let excess = guard.len().saturating_sub(EVENT_CAP);
    guard.drain(0..excess);
}