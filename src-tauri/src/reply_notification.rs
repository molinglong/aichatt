//! 安卓壳「生成中」前台服务的桥。
//!
//! 切后台时 Tauri 会调用 `WryActivity.onPause()` 暂停 WebView,JS 随之冻结,
//! 完成那一刻无法调系统通知。这里在前台启动一个前台服务:
//!   - 通知栏常驻「正在生成回复…」;
//!   - `GenerationService.keepWebViewAlive` 置真,WryActivity 跳过 `mWebView.onPause()`
//!     让后台 JS/SSE 继续跑;
//!   - 前端在生成开始/结束时调本模块的两个命令启停。
//!
//! Kotlin 实现放在 `com.aichatt.app.MainActivity`(方法名由 JNI 按字符串调用,
//! R8 开启时需 keep;当前 release 构建 R8 关闭,但 keep 规则仍保留在 proguard 配置里)。

use tauri::Manager;

/// 走 `with_webview` 的平台线程执行 Activity 方法。
/// 直接取 `ndk_context` 会 panic(见 updater.rs 的踩坑注释),这条链路是安全的。
#[cfg(target_os = "android")]
fn call_main_activity(app: &tauri::AppHandle, method: &'static str) -> Result<(), String> {
    use std::time::Duration;

    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
        .ok_or_else(|| "找不到主窗口".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _wv| {
                let result = env
                    .call_method(activity, method, "()V", &[])
                    .map(|_| ())
                    .map_err(|e| format!("JNI 调用 {method} 失败: {e}"));
                let _ = tx.send(result);
            });
        })
        .map_err(|e| format!("无法派发到 WebView 线程: {e}"))?;

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "后台通知服务调用超时".to_string())?
}

#[tauri::command]
pub fn generation_notification_start(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call_main_activity(&app, "startGenerationNotification")
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("仅安卓壳支持后台生成通知".into())
    }
}

#[tauri::command]
pub fn generation_notification_stop(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call_main_activity(&app, "stopGenerationNotification")
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("仅安卓壳支持后台生成通知".into())
    }
}
