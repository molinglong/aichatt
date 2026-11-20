// 桌面壳专属命令:红绿灯窗口控制、设置子窗口、搭子悬浮球。
// 安卓 target 上 tauri::WebviewWindow 根本没有这些方法(编译期即缺)，故整模块 cfg(desktop) 隔离。
#![allow(unused_imports)]
use super::*;

/// 当前窗口是否为最大化(全屏)状态,前端用于红绿灯"绿色按钮"图标切换。
/// 参数用 Webview 而非 WebviewWindow:cb_demote_main 把主 webview 降级为
/// child 后,窗口级 WebviewWindow 参数注入会报 "current webview is not a
/// WebviewWindow",多 webview 窗口下必须走当前 webview → window() 链。
#[derive(Serialize)]
pub struct WindowState {
    maximized: bool,
    fullscreen: bool,
}

#[tauri::command]
pub fn get_window_state(webview: tauri::Webview) -> WindowState {
    let window = webview.window();
    WindowState {
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    }
}

/// 锁定期窗口操作统一拒绝口(监管模式 focus_lock)。
fn fl_guard() -> Result<(), String> {
    if super::focus_lock::fl_is_locked() {
        Err("监管模式锁定中,窗口操作已被拦截".into())
    } else {
        Ok(())
    }
}

/// macOS 风格:绿色按钮 = 进入/退出全屏(不是 Windows 的"最大化")。
/// 在 Windows 上行为对齐 macOS:点一次进全屏,再点一次退出。
#[tauri::command]
pub fn toggle_fullscreen(webview: tauri::Webview) -> Result<(), String> {
    fl_guard()?;
    let window = webview.window();
    let is_fs = window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(!is_fs)
        .map_err(|e| e.to_string())
}

/// 最小化窗口(对应 macOS 黄色按钮)。
#[tauri::command]
pub fn minimize_window(webview: tauri::Webview) -> Result<(), String> {
    fl_guard()?;
    webview.window().minimize().map_err(|e| e.to_string())
}

/// 关闭窗口(对应 macOS 红色按钮)。
/// 2026-11-20 起:关闭 = 收进系统托盘(应用后台常驻),不再退出进程;
/// 真退出走托盘菜单「退出」或关闭键长按/右键菜单(quit_app)。
#[tauri::command]
pub fn close_window(webview: tauri::Webview) -> Result<(), String> {
    fl_guard()?;
    webview.window().hide().map_err(|e| e.to_string())
}

/// 双击标题栏切换最大化(Windows 习惯,补充 macOS 红绿灯没有的行为)。
#[tauri::command]
pub fn toggle_maximize(webview: tauri::Webview) -> Result<(), String> {
    fl_guard()?;
    let window = webview.window();
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// 给窗口应用系统毛玻璃材质。优先 Mica(Win11,拖动不掉帧),
/// 失败退 Acrylic(Win10);都失败静默跳过(保持不透明现状)。
// ============ 设置子窗口管理 ============

/// 打开设置子窗口:窗口常驻保活,但 WebView 可能被留在别的页面(如服务异常时
/// 的 404 页上点了“返回主页”→ 停在 /)。show 前校验当前 URL,不在设置页则
/// eval 拉回,保证弹出的永远是设置页。JS 侧无法跨 WebView 读 URL/导航(权限
/// 表未提供),故此逻辑收口在 Rust。
#[tauri::command]
pub fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    // 监管模式锁定期禁止打开设置(设置里也没有解锁入口,藏起防混淆)
    fl_guard()?;
    let win = app
        .get_webview_window("settings")
        .ok_or("settings 窗口不存在")?;
    let url = win.url().map(|u| u.to_string()).unwrap_or_default();
    if !url.contains("/settings-window") {
        let _ = win.eval("location.replace('/settings-window/')");
    }
    win.show().map_err(|e| e.to_string())?;
    win.unminimize().ok();
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

// ============ 搭子窗口管理 ============

/// 显示搭子窗口
#[tauri::command]
pub fn show_buddy_window(app: tauri::AppHandle) -> Result<(), String> {
    // 如果窗口不存在,先创建
    if app.get_webview_window("buddy").is_none() {
        let _window = tauri::WebviewWindowBuilder::new(
            &app,
            "buddy",
            tauri::WebviewUrl::App("/buddy/".into()),
        )
        .title("搭子")
        .inner_size(120.0, 120.0)
        .position(20.0, 100.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let buddy = app.get_webview_window("buddy").unwrap();
    buddy.show().map_err(|e| e.to_string())?;
    buddy.unminimize().ok();
    Ok(())
}

/// 隐藏搭子窗口
#[tauri::command]
pub fn hide_buddy_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(buddy) = app.get_webview_window("buddy") {
        buddy.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 切换搭子窗口显示/隐藏
#[tauri::command]
pub fn toggle_buddy_window(app: tauri::AppHandle) -> Result<bool, String> {
    // 如果窗口不存在,创建并显示
    if app.get_webview_window("buddy").is_none() {
        let _window = tauri::WebviewWindowBuilder::new(
            &app,
            "buddy",
            tauri::WebviewUrl::App("/buddy/".into()),
        )
        .title("搭子")
        .inner_size(120.0, 120.0)
        .position(20.0, 100.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let buddy = app.get_webview_window("buddy").unwrap();
    let is_visible = buddy.is_visible().unwrap_or(false);
    if is_visible {
        buddy.hide().map_err(|e| e.to_string())?;
    } else {
        buddy.show().map_err(|e| e.to_string())?;
    }
    Ok(!is_visible)
}

/// 设置搭子窗口位置
#[tauri::command]
pub fn set_buddy_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(buddy) = app.get_webview_window("buddy") {
        buddy
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 获取搭子窗口位置
#[tauri::command]
pub fn get_buddy_position(app: tauri::AppHandle) -> Result<Option<(i32, i32)>, String> {
    if let Some(buddy) = app.get_webview_window("buddy") {
        let pos = buddy.outer_position().map_err(|e| e.to_string())?;
        Ok(Some((pos.x, pos.y)))
    } else {
        Ok(None)
    }
}

/// 获取屏幕尺寸
#[tauri::command]
pub fn get_screen_size(app: tauri::AppHandle) -> Result<Option<(u32, u32)>, String> {
    if let Some(buddy) = app.get_webview_window("buddy") {
        if let Some(monitor) = buddy.current_monitor().map_err(|e| e.to_string())? {
            let size = monitor.size();
            Ok(Some((size.width, size.height)))
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
}

/// 创建搭子窗口（如果不存在）
#[tauri::command]
pub async fn create_buddy_window(app: tauri::AppHandle) -> Result<(), String> {
    // 检查是否已存在
    if app.get_webview_window("buddy").is_some() {
        return Ok(());
    }

    // 创建新窗口
    let _window = tauri::WebviewWindowBuilder::new(
        &app,
        "buddy",
        WebviewUrl::App("/buddy/".into()),
    )
    .title("搭子")
    .inner_size(120.0, 120.0)
    .position(20.0, 100.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(true)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 移动搭子窗口（相对于当前位置的偏移）
#[tauri::command]
pub fn move_buddy_window(app: tauri::AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    if let Some(buddy) = app.get_webview_window("buddy") {
        let pos = buddy.outer_position().map_err(|e| e.to_string())?;
        buddy
            .set_position(PhysicalPosition::new(pos.x + delta_x, pos.y + delta_y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 聚焦主窗口
#[tauri::command]
pub fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.unminimize().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
