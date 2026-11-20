// 监管模式(Focus Lock):桌面壳窗口硬锁。
// 方案与验收判据: design/focus-lock-plan.md (§3.1/§6 第 1 波)
//
// - 锁定期主窗口全屏 + 置顶;关闭/最小化/全屏切换/最大化/设置子窗口命令一律拒绝
// - 失焦自动抢回:Windows 前台锁定策略下,后台进程 SetForegroundWindow 会被拒,
//   经典绕法 = 模拟一次 Alt 键按下/释放(让系统视为存在用户输入)再 set_focus,
//   仍失败则最小化-还原强制激活兜底
// - 锁状态落盘 app_config_dir/focus-lock.json:进程被杀/重启后 boot 自动续锁剩余时间,
//   正常到点解锁会删除该文件,故文件存在即代表上次异常中断
// - 异常中断记破戒留痕 focus-breaks.json(环形 50 条,v1 仅落盘无 UI)
// - 到点自动放行:还原窗口原状态、删锁文件、emit focus-lock://ended
#![allow(unused_imports)]
use super::*;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/// 锁状态(内存权威;落盘仅供重启恢复)。
#[derive(Clone)]
struct FlState {
    ends_at_ms: u64,
    started_at_ms: u64,
    /// 正计时档(D13):无截止时刻,从 started_at_ms 起累计,唯一出口 focus_lock_end
    count_up: bool,
    total_min: u32,
    refocus: bool,
    course_url: Option<String>,
    /// 锁定前主窗口是否最大化(解锁还原用;普通窗口退出全屏后自动回到原 bounds)
    pre_maximized: bool,
}

static FL_LOCK: Mutex<Option<FlState>> = Mutex::new(None);
/// 本次进程启动是否由 boot 续锁(前端 status 据此弹「已恢复锁定」提示)。
static FL_RESTORED: AtomicBool = AtomicBool::new(false);
/// 退场流程进行中(防重入:到点线程与手动暂停命令可能并发调 fl_unlock)。
static FL_ENDING: AtomicBool = AtomicBool::new(false);

/// 退场过场时长:广播 ending 后固定等待前端播完黑场退场再还原窗口。
/// 不依赖前端 ACK —— 前端无响应(卡死/刷新中)也按时还原,此即兜底。
const FL_ENDING_CROSS_MS: u64 = 2700;

/// 落盘锁记录(camelCase 与文件内容一致)。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlRecord {
    ends_at_ms: u64,
    started_at_ms: u64,
    /// 正计时档标记(ends_at_ms=0 哨兵);serde default 兼容旧版锁文件
    #[serde(default)]
    count_up: bool,
    total_min: u32,
    refocus: bool,
    /// 第 2 波课程画中画窗口的 URL;第 1 波仅透传落盘
    course_url: Option<String>,
}

/// focus_lock_status 返回体(serde camelCase 对齐前端)。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FlStatus {
    locked: bool,
    ends_at_ms: u64,
    remaining_ms: u64,
    /// 正计时档:remaining_ms 恒 0,前端按 startedAtMs 自行累计
    count_up: bool,
    /// 锁开始时刻(正计时计秒起点;倒计时档用于续锁展示)
    started_at_ms: u64,
    refocus: bool,
    course_url: Option<String>,
    /// 本次启动由 boot 续锁(进程上次被异常终止)
    restored: bool,
}

fn fl_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fl_lock_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {}", e))?;
    Ok(dir.join("focus-lock.json"))
}

fn fl_breaks_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {}", e))?;
    Ok(dir.join("focus-breaks.json"))
}

/// 破戒留痕环形上限。
const FL_BREAKS_MAX: usize = 50;

/// 上次强制拉回全屏的时间戳(节流:set_fullscreen 自身也触发 Moved/Resized)。
static FL_LAST_FORCE: AtomicU64 = AtomicU64::new(0);

/// 追加一条破戒记录(文件损坏/写失败静默放弃 —— 留痕是旁路,不阻断主流程)。
fn fl_record_break(app: &tauri::AppHandle, leftover_ms: u64) {
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FlBreak {
        at_ms: u64,
        leftover_ms: u64,
    }
    #[derive(Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct FlBreaks {
        breaks: Vec<FlBreak>,
    }

    let Ok(path) = fl_breaks_path(app) else { return };
    let mut store: FlBreaks = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    store.breaks.push(FlBreak { at_ms: fl_now_ms(), leftover_ms });
    let overflow = store.breaks.len().saturating_sub(FL_BREAKS_MAX);
    if overflow > 0 {
        store.breaks.drain(0..overflow);
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(&store) {
        let _ = fs::write(&path, raw);
    }
}

fn fl_read_record(app: &tauri::AppHandle) -> Option<FlRecord> {
    let path = fl_lock_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn fl_write_record(app: &tauri::AppHandle, rec: &FlRecord) -> Result<(), String> {
    let path = fl_lock_path(app)?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let raw = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("写入锁状态失败: {}", e))
}

fn fl_delete_record(app: &tauri::AppHandle) {
    if let Ok(path) = fl_lock_path(app) {
        let _ = fs::remove_file(path);
    }
}

/// 锁定中?(window_cmds/lib.rs 拦截面与事件分支共用)
pub fn fl_is_locked() -> bool {
    FL_LOCK.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 剩余毫秒(被拦时回传前端提示用;未锁为 0)。
/// 正计时档无「剩余」概念,返回已专注时长,前端按 countUp 换文案。
pub fn fl_remaining_ms() -> u64 {
    FL_LOCK.lock().ok().and_then(|g| {
        g.as_ref().map(|s| {
            if s.count_up {
                fl_now_ms().saturating_sub(s.started_at_ms)
            } else {
                s.ends_at_ms.saturating_sub(fl_now_ms())
            }
        })
    }).unwrap_or(0)
}

fn fl_refocus_on() -> bool {
    FL_LOCK
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.refocus))
        .unwrap_or(false)
}

/// boot 续锁后的课程 URL(读内存锁状态;未锁/未带课程链接为 None)。
/// 供 course_browser 的 cb_boot 在 webview 就绪后重建面板进课程模式。
pub fn fl_boot_course_url() -> Option<String> {
    FL_LOCK
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|s| s.course_url.clone()))
}

/// 锁文件 → 内存状态 → 全屏置顶,被 start 与 boot restore 共用。
/// 成功后启动到点放行线程(轮询墙钟,休眠唤醒后到点立即解锁)。
fn fl_engage(app: &tauri::AppHandle, rec: &FlRecord) -> Result<FlStatus, String> {
    let mut guard = FL_LOCK.lock().map_err(|_| "锁状态异常".to_string())?;
    if guard.is_some() {
        return Err("已在锁定中".into());
    }
    let win = app.get_window("main").ok_or("主窗口不存在")?;
    let pre_maximized = win.is_maximized().unwrap_or(false);
    win.set_fullscreen(true).map_err(|e| format!("进入全屏失败: {}", e))?;
    win.set_always_on_top(true).map_err(|e| format!("置顶失败: {}", e))?;
    // 锁定期小鸡陪学(2026-11-19 拍板):重新提顶盖在锁定画面之上+强制穿透。
    // boot 续锁路径 pet 窗口尚未创建(pet_ensure_window 在 setup 里靠后),
    // 此处静默跳过 —— 新建窗的置顶调用晚于主窗口提顶,层级天然在上。
    pet_window::pet_raise_for_lock(app);
    // 锁前已打开的设置子窗口藏起来(锁定期 show_settings_window 命令已拒)
    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.hide();
    }
    *guard = Some(FlState {
        ends_at_ms: rec.ends_at_ms,
        started_at_ms: rec.started_at_ms,
        count_up: rec.count_up,
        total_min: rec.total_min,
        refocus: rec.refocus,
        course_url: rec.course_url.clone(),
        pre_maximized,
    });
    drop(guard);
    // 锁定开始广播(全局):pet 前端可监听做陪学表现;主窗口 FocusLock 不监听
    // 此事件,additive 无冲突。载荷 = 设定分钟数(正计时档为 0)
    let _ = app.emit("focus-lock://started", rec.total_min);

    let ends = rec.ends_at_ms;
    let count_up = rec.count_up;
    let app2 = app.clone();
    std::thread::spawn(move || loop {
        // 系统级最小化兜底:失焦事件可能不触发/抢回线程可能失败,而窗口已在
        // 后台时不会再有新失焦事件。锁定期间每 500ms 检查一次,发现最小化
        // 立即还原,保证窗口不驻留后台(锁定管理 UI 永远可达)。
        if let Some(win) = app2.get_window("main") {
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }
        // 正计时档(D14):无到点不自动放行;锁被 focus_lock_end 手动结束后
        // (fl_unlock take 内存态)循环随之退出,最小化兜底在退场过场内继续生效
        if count_up {
            if FL_LOCK.lock().map(|g| g.is_none()).unwrap_or(true) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let now = fl_now_ms();
        if now >= ends {
            fl_unlock(&app2);
            break;
        }
        std::thread::sleep(Duration::from_millis((ends - now).min(500)));
    });

    Ok(fl_status_impl())
}

/// 解锁(到点自动放行 / 测试阶段手动暂停共用):两段式。
/// 第 1 段:广播 focus-lock://ending(前端播 ~2.7s 退场黑场);锁保持内存中,
///   窗口拦截/全屏兜底继续生效,过场期间关闭与最小化仍被拒。
/// 第 2 段:固定延迟(FL_ENDING_CROSS_MS)后清内存/清盘/还原窗口/广播 ended。
/// 立即返回,全流程在独立线程 —— 到点调用方(轮询线程)与命令调用方都不阻塞。
fn fl_unlock(app: &tauri::AppHandle) {
    if FL_ENDING.swap(true, Ordering::SeqCst) {
        return; // 已在退场流程中
    }
    let Some(st) = FL_LOCK.lock().ok().and_then(|g| g.as_ref().cloned()) else {
        FL_ENDING.store(false, Ordering::Relaxed);
        return;
    };
    let app2 = app.clone();
    std::thread::spawn(move || {
        // 2.2 到点收起:面板随退场黑场一起收起(前端收 DOM 壳恢复全宽 + Rust 隐 webview)
        crate::course_browser::cb_on_lock_end(&app2);
        // 结束时长:倒计时 = 设定档;正计时 = 实际累计分钟(不足 1 分钟记 1)
        let end_min = if st.count_up {
            ((fl_now_ms().saturating_sub(st.started_at_ms) / 60_000) as u32).max(1)
        } else {
            st.total_min
        };
        let _ = app2.emit("focus-lock://ending", end_min);
        std::thread::sleep(Duration::from_millis(FL_ENDING_CROSS_MS));
        let total_min = FL_LOCK
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .map(|s| if s.count_up { end_min } else { s.total_min })
            .unwrap_or(st.total_min);
        fl_delete_record(&app2);
        if let Some(win) = app2.get_window("main") {
            let _ = win.set_always_on_top(false);
            let _ = win.set_fullscreen(false);
            if st.pre_maximized {
                let _ = win.maximize();
            }
            let _ = win.set_focus();
            #[cfg(windows)]
            fl_apply_corner_round(&win);
        }
        FL_RESTORED.store(false, Ordering::Relaxed);
        FL_ENDING.store(false, Ordering::Relaxed);
        let _ = app2.emit("focus-lock://ended", total_min);
    });
}

fn fl_status_impl() -> FlStatus {
    let guard = FL_LOCK.lock().ok();
    if let Some(st) = guard.as_ref().and_then(|g| g.as_ref()) {
        let now = fl_now_ms();
        return FlStatus {
            locked: true,
            ends_at_ms: st.ends_at_ms,
            remaining_ms: st.ends_at_ms.saturating_sub(now),
            count_up: st.count_up,
            started_at_ms: st.started_at_ms,
            refocus: st.refocus,
            course_url: st.course_url.clone(),
            restored: FL_RESTORED.load(Ordering::Relaxed),
        };
    }
    FlStatus {
        locked: false,
        ends_at_ms: 0,
        remaining_ms: 0,
        count_up: false,
        started_at_ms: 0,
        refocus: false,
        course_url: None,
        restored: false,
    }
}

/// 开启锁定(倒计时锁定期无任何退出入口,仅到点自动放行;正计时唯一出口 focus_lock_end)。
/// test_seconds: 测试档(1–300 秒),传入时忽略 minutes;total_min 记 0 作标记。
/// count_up: 正计时档(D13)——无截止时刻,忽略 minutes,ends_at_ms 落 0 哨兵;
/// test_seconds 与 count_up 同传时测试档优先(rec.count_up=false,本质是秒级倒计时)。
#[tauri::command]
pub fn focus_lock_start(
    app: tauri::AppHandle,
    minutes: u32,
    refocus: bool,
    course_url: Option<String>,
    test_seconds: Option<u32>,
    count_up: Option<bool>,
) -> Result<FlStatus, String> {
    let cu_flag = count_up.unwrap_or(false) && test_seconds.is_none();
    let (end_ms, total_min) = match test_seconds {
        Some(s) => {
            if !(1..=300).contains(&s) {
                return Err("测试时长须在 1–300 秒".into());
            }
            (fl_now_ms() + s as u64 * 1000, 0u32)
        }
        None if cu_flag => (0u64, 0u32),
        None => {
            if !(5..=360).contains(&minutes) {
                return Err("锁定时长须在 5–360 分钟".into());
            }
            (fl_now_ms() + minutes as u64 * 60_000, minutes)
        }
    };
    let cu = course_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let rec = FlRecord {
        ends_at_ms: end_ms,
        started_at_ms: fl_now_ms(),
        count_up: cu_flag,
        total_min,
        refocus,
        course_url: cu.clone(),
    };
    // 先上锁(窗口操作可能失败,失败时盘上不留悬空锁),成功后落盘
    let status = fl_engage(&app, &rec)?;
    fl_write_record(&app, &rec)?;
    // 2.2 锁定收紧:带课程链接 → 面板自动开 + 导航进课程模式;不带但面板已开 → 补净化
    crate::course_browser::cb_on_lock_start(&app, cu);
    Ok(status)
}

/// 查询锁状态(前端刷新/回前台后恢复 UI 用)。
#[tauri::command]
pub fn focus_lock_status(_app: tauri::AppHandle) -> FlStatus {
    fl_status_impl()
}

/// 测试阶段逃生口:手动暂停锁定(方案定案正式版锁定期无解锁入口,
/// 此命令仅用于第 1 波自测,验收通过后随测试入口一并移除)。不记破戒。
/// 两段式退场:返回时锁仍在内存中(locked=true,过场中),窗口在过场播完后
/// 才真正还原;前端一律以 ending/ended 事件驱动 UI,不依赖本返回值。
#[tauri::command]
pub fn focus_lock_stop(app: tauri::AppHandle) -> Result<FlStatus, String> {
    fl_unlock(&app);
    Ok(fl_status_impl())
}

/// 正计时档唯一出口(D15/D16):徽章面板「结束专注」两击确认后调用。
/// 仅正计时锁可手动结束;倒计时锁拒绝(D2「到点自动放行」不回退)。主动结束
/// 不算破戒(不写 focus-breaks.json,破戒只记异常中断)。两段式退场:返回时
/// 锁仍在内存中,前端以 ending/ended 事件驱动 UI;ended 载荷 = 实际累计分钟。
#[tauri::command]
pub fn focus_lock_end(app: tauri::AppHandle) -> Result<FlStatus, String> {
    let count_up = FL_LOCK
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.count_up))
        .unwrap_or(false);
    if !count_up {
        return Err("倒计时锁定无手动退出入口".into());
    }
    fl_unlock(&app);
    Ok(fl_status_impl())
}

/// boot 恢复:锁文件存在 = 上次未正常结束 → 记破戒;未到期则自动续锁。
/// 正计时档无到期概念:直接续锁继续累计,leftover 记当时已专注时长作留痕。
/// 在 lib.rs setup 里调用(窗口已按配置创建完毕)。
pub fn fl_boot_restore(app: &tauri::AppHandle) {
    let Some(rec) = fl_read_record(app) else { return };
    let leftover = if rec.count_up {
        fl_now_ms().saturating_sub(rec.started_at_ms)
    } else {
        rec.ends_at_ms.saturating_sub(fl_now_ms())
    };
    fl_record_break(app, leftover);
    if !rec.count_up && leftover == 0 {
        fl_delete_record(app);
        return;
    }
    match fl_engage(app, &rec) {
        Ok(_) => {
            FL_RESTORED.store(true, Ordering::Relaxed);
            let _ = app.emit("focus-lock://restored", leftover);
        }
        Err(_) => {
            // 恢复失败(如窗口缺失)就清盘,不留幽灵锁
            fl_delete_record(app);
        }
    }
}

/// 主窗口失焦 → 延迟检查后抢回(120ms 给可能的窗口切换落定;两轮抢回提高成功率)。
/// 锁定期发现窗口被系统级最小化(Win+D/任务栏,不走命令层)则无条件还原——
/// 拦最小化属锁定行为(D4),不受 refocus 开关约束(refocus 只管「切走拉回」)。
pub fn fl_handle_focus_lost(app: &tauri::AppHandle) {
    if !fl_is_locked() {
        return;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        let Some(win) = app2.get_window("main") else { return };
        if win.is_focused().unwrap_or(true) {
            return;
        }
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
        // 锁定期点陪学小鸡(D19 定稿「全部开放」):前台 = 小鸡窗口属锁定场景
        // 内互动,放行不抢回 —— 否则每次点击都会触发 Alt 模拟抢焦点
        if pet_window::pet_is_foreground(&app2) {
            return;
        }
        if !fl_refocus_on() {
            return;
        }
        fl_steal_focus(&win);
        std::thread::sleep(Duration::from_millis(300));
        if !win.is_focused().unwrap_or(true) {
            fl_steal_focus(&win);
        }
    });
}

/// 把焦点抢回主窗口。
#[cfg(windows)]
fn fl_steal_focus(win: &tauri::Window) {
    // Windows 前台锁定策略:后台进程直接 SetForegroundWindow 会被系统拒绝。
    // 绕法:模拟一次 Alt 按下/释放,让系统认为存在用户输入,再走正常 set_focus。
    {
        #[link(name = "user32")]
        extern "system" {
            fn keybd_event(bvk: u8, bscan: u8, dwflags: u32, dwextrainfo: usize);
        }
        const VK_MENU: u8 = 0x12;
        const KEYEVENTF_KEYUP: u32 = 0x2;
        unsafe {
            keybd_event(VK_MENU, 0, 0, 0);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        }
    }
    let _ = win.set_focus();
    if !win.is_focused().unwrap_or(true) {
        // 兜底:最小化-还原在 Windows 上会强制激活窗口(锁定期间用户手动最小化
        // 走命令层已被拒,这里仅作内部抢回手段)
        let _ = win.minimize();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(not(windows))]
fn fl_steal_focus(win: &tauri::Window) {
    let _ = win.set_focus();
}

/// CloseRequested 拦截时的广播(Rust → 前端弹「锁定中 · 剩余 mm:ss」)。
pub fn fl_emit_blocked(app: &tauri::AppHandle) {
    let _ = app.emit("focus-lock://blocked", fl_remaining_ms());
}

/// 把 Win11 窗口圆角钉为 ROUND:undecorated 窗口(WS_POPUP 样式)在系统默认
/// 策略(DWMWCP_DEFAULT)下不给圆角,全屏来回切换后也不会自动恢复 ——
/// 显式设置窗口层真圆角(DWM 渲染,与网页 CSS 无关)。启动时与解锁还原后各调一次。
/// 注意:Win10 无 DWMWA_WINDOW_CORNER_PREFERENCE(33)属性(E_INVALIDARG 静默失败),
/// Win10 的圆角走 tauri.conf transparent:true + globals.css [data-tauri] 圆角路线。
#[cfg(windows)]
pub fn fl_apply_corner_round(win: &tauri::Window) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const u32, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    if let Ok(h) = win.hwnd() {
        unsafe {
            DwmSetWindowAttribute(h.0 as isize, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_ROUND, 4);
        }
    }
}

#[cfg(not(windows))]
pub fn fl_apply_corner_round(_win: &tauri::Window) {}

/// 主窗口 Moved/Resized 兜底:锁定中窗口被拖离全屏(顶栏 drag region 长按拖动、
/// Alt+Space 系统菜单「移动/还原」)时强制拉回全屏+置顶。
/// 必须 try_lock:engage/unlock 在持有 FL_LOCK 期间做窗口操作,会同步触发
/// Moved/Resized 回到这里 —— 再 lock 同一把 Mutex = 死锁。拿不到锁说明正处
/// 锁状态变更中,直接跳过;节流 600ms 防 set_fullscreen 自身事件的抖动。
pub fn fl_force_fullscreen(app: &tauri::AppHandle) {
    let Ok(guard) = FL_LOCK.try_lock() else { return };
    if guard.is_none() {
        return;
    }
    let now = fl_now_ms();
    if now.saturating_sub(FL_LAST_FORCE.load(Ordering::Relaxed)) < 600 {
        return;
    }
    let Some(win) = app.get_window("main") else { return };
    if win.is_fullscreen().unwrap_or(true) {
        return;
    }
    drop(guard);
    FL_LAST_FORCE.store(now, Ordering::Relaxed);
    let _ = win.set_fullscreen(true);
    let _ = win.set_always_on_top(true);
    // 拉回置顶会把陪学小鸡重新盖掉,提回锁定画面之上
    pet_window::pet_raise_for_lock(app);
    let _ = win.set_focus();
}
