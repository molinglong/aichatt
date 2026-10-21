// 应用内自更新(仅安卓壳):版本检查 + APK 下载 + 唤起系统安装器。
// 官方 tauri-plugin-updater 不支持 Android(平台表打叉),链路自建:
// 纯 Rust HTTP(ureq,rustls 内置根证书,无需系统证书库)→ 下载到 app_cache_dir
// → FileProvider content:// URI → ACTION_VIEW 安装意图。
// 清单与安装包托管在 VPS nginx 的 /apk/ 路径(不进 Next 静态目录,防整站部署覆盖)。

use super::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// 版本清单地址(nginx location /apk/ → VPS /opt/aichatt-apk/)
const MANIFEST_URL: &str = "https://chat.yuban.icu/apk/latest.json";
/// FileProvider authority = `${applicationId}.fileprovider`(applicationId 见 gen/android build.gradle.kts)
const FILE_PROVIDER_AUTHORITY: &str = "com.aichatt.app.fileprovider";

/// 下载并发闸:同一时刻只允许一个下载任务
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// 当前任务进度(原子量给 updater_status 用;推送事件仍按 200ms 节流)
static PROGRESS_RECEIVED: AtomicU64 = AtomicU64::new(0);
static PROGRESS_TOTAL: AtomicU64 = AtomicU64::new(0);
/// 最近一次失败文案。WebView 切后台会冻住 JS,done/error 事件可能丢,
/// 回前台后靠 updater_status 把结果补齐。
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn last_error() -> Option<String> {
    match LAST_ERROR.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn set_last_error(message: Option<String>) {
    match LAST_ERROR.lock() {
        Ok(mut guard) => *guard = message,
        Err(poisoned) => *poisoned.into_inner() = message,
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    version: String,
    url: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    size: u64,
}

/// pub:updater_check 现为 pub 命令,返回类型必须可见(否则 E0446 private type)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: String,
    size: u64,
    /// update.apk 已完整落盘(重启 App 后不必重下,直接可装)
    downloaded: bool,
    /// 已落盘的半成品字节数(同一版本才作数),用于「继续下载」展示
    partial_bytes: u64,
}

/// pub:updater_status 的返回类型,同样必须可见。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    downloading: bool,
    received: u64,
    total: u64,
    partial_bytes: u64,
    /// 后台下载失败时 WebView 收不到事件,回前台靠这里补错误文案
    last_error: Option<String>,
    /// 已完整落盘的版本号(没有则为 None)
    downloaded_version: Option<String>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    received: u64,
    total: u64,
}

/// 缓存目录里的四个文件:完成包 / 断点包 / 断点归属信息 / 完成包归属信息。
/// 元数据解决两件事:半成品只对同一版本有效;旧版本的同名 update.apk 不会被误判为已下载。
struct UpdatePaths {
    target: PathBuf,
    part: PathBuf,
    part_meta: PathBuf,
    done_meta: PathBuf,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PackageMeta {
    version: String,
    url: String,
    size: u64,
}

fn update_paths(app: &tauri::AppHandle) -> Result<UpdatePaths, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位缓存目录: {e}"))?;
    Ok(UpdatePaths {
        target: dir.join("update.apk"),
        part: dir.join("update.apk.part"),
        part_meta: dir.join("update.apk.part.json"),
        done_meta: dir.join("update.apk.json"),
    })
}

fn download_target(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(update_paths(app)?.target)
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn read_package_meta(path: &Path) -> Option<PackageMeta> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_package_meta(path: &Path, m: &UpdateManifest, size: u64) -> Result<(), String> {
    let meta = PackageMeta {
        version: m.version.clone(),
        url: m.url.clone(),
        size,
    };
    let bytes = serde_json::to_vec(&meta).map_err(|e| format!("下载元数据序列化失败: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("写入下载元数据失败: {e}"))
}

/// 与当前清单同一版本的半成品字节数;版本变了就丢弃旧断点,避免把 A 包的尾巴接在 B 包上。
fn resumable_bytes(app: &tauri::AppHandle, m: &UpdateManifest) -> u64 {
    let Ok(paths) = update_paths(app) else {
        return 0;
    };
    let Some(meta) = read_package_meta(&paths.part_meta) else {
        return 0;
    };
    if meta.version != m.version || (m.size > 0 && meta.size != m.size) {
        let _ = fs::remove_file(&paths.part);
        let _ = fs::remove_file(&paths.part_meta);
        return 0;
    }
    let len = file_len(&paths.part);
    if m.size > 0 && len > m.size {
        let _ = fs::remove_file(&paths.part);
        let _ = fs::remove_file(&paths.part_meta);
        return 0;
    }
    len
}

fn http_get(url: &str) -> Result<ureq::Response, String> {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("网络请求失败: {e}"))
}

fn fetch_manifest() -> Result<UpdateManifest, String> {
    let resp = http_get(MANIFEST_URL)?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(64 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取版本清单失败: {e}"))?;
    // 发布脚本偶发 BOM 也会让 serde_json 拒解析,容忍它
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        buf.drain(..3);
    }
    serde_json::from_slice(&buf).map_err(|e| format!("版本清单解析失败: {e}"))
}

fn manifest_is_newer(m: &UpdateManifest, app: &tauri::AppHandle) -> bool {
    let current = &app.package_info().version;
    semver::Version::parse(&m.version)
        .map(|v| v > *current)
        .unwrap_or(false)
}

/// 完成包必须同时满足:归属元数据是当前版本 + 文件大小与清单一致。
/// 只比大小不够:两次构建的大小可能碰巧相同,会把旧包当成新包直接装。
fn is_downloaded(app: &tauri::AppHandle, m: &UpdateManifest) -> bool {
    let Ok(paths) = update_paths(app) else {
        return false;
    };
    let Some(meta) = read_package_meta(&paths.done_meta) else {
        return false;
    };
    if meta.version != m.version || (m.size > 0 && meta.size != m.size) {
        return false;
    }
    let len = file_len(&paths.target);
    len > 0 && (m.size == 0 || len == m.size)
}

/// 检查更新:清单版本比当前新才返回 Some(旧 APK 上无此命令,JS 侧报错静默)。
/// pub 是硬要求:tauri 命令宏只对 pub fn 导出 __cmd__* 宏,私有命令在
/// lib.rs 的 generate_handler 里因宏作用域不可见(tauri-macros wrapper.rs 实证)。
#[tauri::command]
pub fn updater_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let m = fetch_manifest()?;
    if !manifest_is_newer(&m, &app) {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        version: m.version.clone(),
        notes: m.notes.clone(),
        size: m.size,
        downloaded: is_downloaded(&app, &m),
        // 顺带清理换代遗留的旧断点,并告诉前端还有多少可以续
        partial_bytes: resumable_bytes(&app, &m),
    }))
}

/// 状态查询:WebView 被系统冻住期间错过的事件,回前台后从这里补齐。
#[tauri::command]
pub fn updater_status(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let paths = update_paths(&app)?;
    let downloaded_version = read_package_meta(&paths.done_meta)
        .filter(|meta| {
            let len = file_len(&paths.target);
            len > 0 && (meta.size == 0 || len == meta.size)
        })
        .map(|meta| meta.version);
    Ok(UpdateStatus {
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        received: PROGRESS_RECEIVED.load(Ordering::SeqCst),
        total: PROGRESS_TOTAL.load(Ordering::SeqCst),
        partial_bytes: file_len(&paths.part),
        last_error: last_error(),
        downloaded_version,
    })
}

/// 下载更新包:后台线程流式写 update.apk.part,完成后改名 update.apk。
/// 失败保留 .part;下次调用带 Range 从断点续传(服务端支持 Accept-Ranges)。
/// 进度经事件 updater://progress {received,total} 推送,结束推 updater://done,失败推 updater://error。
#[tauri::command]
pub fn updater_download(app: tauri::AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("已有下载任务进行中".into());
    }
    let result = (|| {
        let m = fetch_manifest()?;
        if !manifest_is_newer(&m, &app) {
            return Err("当前已是最新版本".into());
        }
        let paths = update_paths(&app)?;
        if is_downloaded(&app, &m) {
            let _ = app.emit("updater://done", ());
            return Ok(());
        }
        set_last_error(None);
        PROGRESS_RECEIVED.store(0, Ordering::SeqCst);
        PROGRESS_TOTAL.store(m.size, Ordering::SeqCst);
        // 切后台/息屏时 CPU 不休眠,下载线程才能继续跑;失败只影响后台续航,不拦下载
        set_download_wakelock(&app, true);
        let emitter = app.clone();
        std::thread::spawn(move || {
            let result = run_download(&emitter, &m, &paths);
            set_download_wakelock(&emitter, false);
            DOWNLOADING.store(false, Ordering::SeqCst);
            match result {
                Ok(()) => {
                    let _ = emitter.emit("updater://done", ());
                }
                Err(e) => {
                    // 关键:不再删 .part —— 断点续传的全部价值都在这里
                    set_last_error(Some(e.clone()));
                    let _ = emitter.emit("updater://error", e);
                }
            }
        });
        Ok(())
    })();
    if result.is_err() {
        DOWNLOADING.store(false, Ordering::SeqCst);
        set_download_wakelock(&app, false);
    }
    result
}

/// 解析 `Content-Range: bytes 100-199/2000`。
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.trim().parse().ok()?,
        end.trim().parse().ok()?,
        total.trim().parse().ok()?,
    ))
}

fn run_download(
    app: &tauri::AppHandle,
    m: &UpdateManifest,
    paths: &UpdatePaths,
) -> Result<(), String> {
    if let Some(dir) = paths.target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法准备缓存目录: {e}"))?;
    }
    let expected = m.size;
    let mut received = resumable_bytes(app, m);
    if expected > 0 && received >= expected {
        if received == expected {
            // 上次写到最后一个字节但没来得及改名:直接收尾
            fs::rename(&paths.part, &paths.target).map_err(|e| format!("落盘失败: {e}"))?;
            write_package_meta(&paths.done_meta, m, expected)?;
            let _ = fs::remove_file(&paths.part_meta);
            PROGRESS_RECEIVED.store(expected, Ordering::SeqCst);
            PROGRESS_TOTAL.store(expected, Ordering::SeqCst);
            return Ok(());
        }
        received = 0;
    }

    // 半成品归属当前版本,续传前先落这份凭证
    write_package_meta(&paths.part_meta, m, m.size)?;

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build();
    let mut req = agent.get(&m.url);
    if received > 0 {
        req = req.set("Range", &format!("bytes={received}-"));
    }
    let resp = req.call().map_err(|e| format!("网络请求失败: {e}"))?;
    let status = resp.status();
    let mut total = expected;
    let mut out;
    if received > 0 && status == 206 {
        let content_range = resp.header("Content-Range").unwrap_or_default();
        match parse_content_range(content_range) {
            Some((start, _end, remote_total)) if start == received => {
                if expected > 0 && remote_total != expected {
                    let _ = fs::remove_file(&paths.part);
                    return Err(format!(
                        "服务器上的安装包已变化({remote_total}/{expected} 字节),已丢弃旧断点"
                    ));
                }
                if expected == 0 {
                    total = remote_total;
                }
                out = fs::OpenOptions::new()
                    .append(true)
                    .open(&paths.part)
                    .map_err(|e| format!("无法写入缓存: {e}"))?;
            }
            _ => {
                let _ = fs::remove_file(&paths.part);
                return Err("续传响应缺少合法的 Content-Range,已丢弃旧断点".into());
            }
        }
    } else if status == 200 || status == 206 {
        // 200 = 服务端忽略 Range(或本来就从 0 开始):截断重写
        received = 0;
        out = fs::File::create(&paths.part).map_err(|e| format!("无法写入缓存: {e}"))?;
        if total == 0 {
            total = resp
                .header("Content-Length")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
        }
    } else {
        return Err(format!("下载请求失败: HTTP {status}"));
    }

    PROGRESS_RECEIVED.store(received, Ordering::SeqCst);
    PROGRESS_TOTAL.store(total, Ordering::SeqCst);
    let _ = app.emit("updater://progress", ProgressPayload { received, total });

    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit = Instant::now();
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("写入失败: {e}"))?;
        received += n as u64;
        PROGRESS_RECEIVED.store(received, Ordering::SeqCst);
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            let _ = app.emit("updater://progress", ProgressPayload { received, total });
        }
    }
    drop(reader);
    drop(out);
    if total > 0 && received != total {
        return Err(format!(
            "下载不完整({received}/{total} 字节),断点已保留,点重试可继续"
        ));
    }
    fs::rename(&paths.part, &paths.target).map_err(|e| format!("落盘失败: {e}"))?;
    write_package_meta(&paths.done_meta, m, if total > 0 { total } else { received })?;
    let _ = fs::remove_file(&paths.part_meta);
    let _ = app.emit("updater://progress", ProgressPayload { received, total });
    Ok(())
}

/// 下载期间持有 PARTIAL_WAKE_LOCK:切后台/息屏后 CPU 不休眠,网络继续跑。
/// Kotlin 实现在 MainActivity(方法名由 JNI 按字符串调用,R8 开启时记得加 keep)。
#[cfg(target_os = "android")]
fn set_download_wakelock(app: &tauri::AppHandle, hold: bool) {
    let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
    else {
        return;
    };
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let dispatched = window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _wv| {
                let method = if hold {
                    "acquireDownloadWakeLock"
                } else {
                    "releaseDownloadWakeLock"
                };
                let _ = tx.send(env.call_method(activity, method, "()V", &[]).is_ok());
            });
        })
        .is_ok();
    if dispatched {
        let _ = rx.recv_timeout(Duration::from_secs(3));
    }
}

#[cfg(not(target_os = "android"))]
fn set_download_wakelock(_app: &tauri::AppHandle, _hold: bool) {}


/// 唤起系统安装器:cache/update.apk 经 FileProvider content URI + ACTION_VIEW。
/// 未授予「安装未知应用」时系统会先弹授权页,允许后回到 App 再点一次安装。
#[tauri::command]
pub fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    let target = download_target(&app)?;
    if !target.exists() {
        return Err("安装包尚未下载".into());
    }
    install_apk(&app, &target)
}

/// 走 tauri 官方通道取 Activity/JNIEnv:tao 0.35 起的栈里
/// `ndk_context::android_context()` 全局量**没有任何人初始化**(全 registry 只有它自己的
/// expect 提到它),直接调用就是 panic → 上层 stop_unwind → abort → 点安装即闪退。
/// `with_webview` 拿到 PlatformWebview,其 `jni_handle().exec` 的闭包在 Android 平台线程
/// 上执行,startActivity 的线程契约天然满足。
#[cfg(target_os = "android")]
fn install_apk(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
        .ok_or_else(|| "找不到主窗口,无法唤起安装器".to_string())?;
    let path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _wv| {
                let _ = tx.send(android_install_apk(env, &activity, &path));
            });
        })
        .map_err(|e| format!("无法派发到 WebView 线程: {e}"))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "安装意图派发超时,请重试".to_string())?
}

#[cfg(not(target_os = "android"))]
fn install_apk(_app: &tauri::AppHandle, _path: &Path) -> Result<(), String> {
    Err("仅安卓壳支持应用内安装".into())
}

#[cfg(target_os = "android")]
fn android_install_apk(
    env: &mut jni::JNIEnv<'_>,
    activity: &jni::objects::JObject<'_>,
    path: &Path,
) -> Result<(), String> {
    // 这条链上冒出的任何 Rust panic 都会被入口的 stop_unwind 接住并 std::process::abort():
    // 真机表现就是"打开中"一闪即闪退、零提示、logcat 里只有 SIGABRT 没有 panic 文本
    // (本工程未接 log 后端,eprintln 也无人收)。在自己的边界兜住:不杀进程,
    // 载荷交回前端上屏,同时 panic hook 已把原文落进 cache/panic.log。
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let result = request_install(env, activity, path);
        // 成败都先把可能挂着的 Java 异常收干净再返回:漏着异常回 Kotlin 帧 = 未捕获异常。
        let leaked = drain_pending_exception(env);
        match (result, leaked) {
            (Ok(()), None) => Ok(()),
            (Ok(()), Some(text)) => Err(format!("安装器调用抛异常(已回收): {text}")),
            (Err(e), Some(text)) => Err(format!("{e} — {text}")),
            (Err(e), None) => Err(e),
        }
    }));
    match outcome {
        Ok(result) => result,
        Err(payload) => Err(format!("安装调用内 panic: {}", panic_payload(&payload))),
    }
}

#[cfg(target_os = "android")]
fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_else(|| "非字符串 panic 载荷".to_string())
}

/// 取走并清除挂着的 Java 异常,把 toString() 带回给前端;
/// 同时 ExceptionDescribe 把全栈打进 logcat(接数据线可直接查)。
#[cfg(target_os = "android")]
fn drain_pending_exception(env: &mut jni::JNIEnv<'_>) -> Option<String> {
    if !env.exception_check().ok()? {
        return None;
    }
    let thrown = match env.exception_occurred() {
        Ok(t) => t,
        Err(_) => {
            let _ = env.exception_clear();
            return None;
        }
    };
    let _ = env.exception_describe();
    let _ = env.exception_clear();
    let text = env
        .call_method(&thrown, "toString", "()Ljava/lang/String;", &[])
        .and_then(|v| v.l())
        .map(jni::objects::JString::from)
        .and_then(|js| env.get_string(&js).map(String::from))
        .unwrap_or_default();
    Some(if text.is_empty() {
        "Java 异常(toString 无内容)".to_string()
    } else {
        text
    })
}

/// 组装 content URI + ACTION_VIEW 拉起系统安装器。任何一步失败只回 Err 文本,
/// 不在这里碰异常状态——统一由外层 drain 收尾。
#[cfg(target_os = "android")]
fn request_install(
    env: &mut jni::JNIEnv<'_>,
    activity: &jni::objects::JObject<'_>,
    path: &Path,
) -> Result<(), String> {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JNIEnv;

    fn jerr<T>(r: jni::errors::Result<T>) -> Result<T, String> {
        r.map_err(|e| format!("JNI 调用失败: {e}"))
    }

    /// androidx 类不在系统 boot classpath,须借 Activity 的 classloader 加载
    fn load_class<'a>(
        env: &mut JNIEnv<'a>,
        activity: &JObject,
        name: &str,
    ) -> Result<JClass<'a>, String> {
        let cls = jerr(jerr(env.call_method(activity, "getClass", "()Ljava/lang/Class;", &[]))?.l())?;
        let loader =
            jerr(jerr(env.call_method(&cls, "getClassLoader", "()Ljava/lang/ClassLoader;", &[]))?
                .l())?;
        let jname = env.new_string(name).map_err(|e| e.to_string())?;
        let loaded = jerr(jerr(env.call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&jname).into()],
        ))?
        .l())?;
        Ok(unsafe { JClass::from_raw(loaded.into_raw()) })
    }

    let pstr = path.to_string_lossy().into_owned();
    let file_path = env.new_string(&pstr).map_err(|e| e.to_string())?;
    let file = jerr(env.new_object(
        "java/io/File",
        "(Ljava/lang/String;)V",
        &[(&file_path).into()],
    ))?;

    let authority = env
        .new_string(FILE_PROVIDER_AUTHORITY)
        .map_err(|e| e.to_string())?;
    let provider = load_class(env, activity, "androidx/core/content/FileProvider")?;
    let uri = jerr(jerr(env.call_static_method(
        provider,
        "getUriForFile",
        "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
        &[JValue::Object(activity), (&authority).into(), (&file).into()],
    ))?
    .l())?;

    let action = env
        .new_string("android.intent.action.VIEW")
        .map_err(|e| e.to_string())?;
    let intent = jerr(env.new_object(
        "android/content/Intent",
        "(Ljava/lang/String;)V",
        &[(&action).into()],
    ))?;
    let mime = env
        .new_string("application/vnd.android.package-archive")
        .map_err(|e| e.to_string())?;
    jerr(env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[(&uri).into(), (&mime).into()],
    ))?;
    // FLAG_GRANT_READ_URI_PERMISSION(1) | FLAG_ACTIVITY_NEW_TASK(0x10000000)
    jerr(env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(0x1000_0001)],
    ))?;
    jerr(env.call_method(
        activity,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[(&intent).into()],
    ))?;

    Ok(())
}
