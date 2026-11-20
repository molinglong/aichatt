//! 系统托盘(2026-11-20 用户拍板):关闭主窗口 = 收进托盘后台常驻(小鸡图标),
//! 托盘左键/菜单「显示」把窗口拉回来,菜单「退出」才真正结束进程。
//!
//! 与监管模式的边界:锁定期不允许退出/收起(fl_is_locked 时关闭仍被拦),
//! 托盘「退出」同样走 request_quit —— 锁中会转成「剩余时间」提示,不破锁。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub const TRAY_ID: &str = "aichatt-tray";

/// 关闭时是否把陪学小鸡一并收起(恢复时再放出来);避免关窗后桌面上只剩一只鸡
static PET_WAS_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    // 已存在则跳过(热重载/重复调用安全)
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "show", "显示 aichatt", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 aichatt", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    // 32px 下细节会糊,用 64px 让系统自己缩(Windows 托盘按 DPI 取合适尺寸)
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-chick.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("aichatt")
        .menu(&menu)
        // 左键默认展开菜单会挡住「点一下就出来」的习惯:左键直接显示窗口,
        // 右键(系统默认)才出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => crate::request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 记下关闭时小鸡是否在台面上,供 show_main 还原
pub fn note_pet_visibility(app: &tauri::AppHandle) {
    let visible = app
        .get_webview_window(crate::pet_window::PET_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    PET_WAS_VISIBLE.store(visible, std::sync::atomic::Ordering::Relaxed);
    if visible {
        if let Some(pet) = app.get_webview_window(crate::pet_window::PET_LABEL) {
            let _ = pet.hide();
        }
    }
}

/// 把主窗口(和关闭前在台面的小鸡)拉回来
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if PET_WAS_VISIBLE.swap(false, std::sync::atomic::Ordering::Relaxed) {
        if let Some(pet) = app.get_webview_window(crate::pet_window::PET_LABEL) {
            let _ = pet.show();
        }
    }
}