// 桌面小鸡窗口(pet):透明无边框置顶小窗,加载 /pet/ 路由,沿任务栏上沿漫步。
// 与 buddy 同模板;关键差异:窗口横跨任务栏上沿,整窗必须默认「点击穿透」,
// 由前端轮询 pet_probe 做「光标落在小鸡上才收穿透」的动态命中 —— 否则会吃掉
// 任务栏整条区域的鼠标点击。
#![allow(unused_imports)]
use super::*;

pub const PET_LABEL: &str = "pet";

/// 窗口逻辑尺寸:440×176 —— 440 给小鸡留 ~330px 漫步道,
/// 176 = 地面 10 + 小鸡 74 + 气泡/Zzz 头部空间
const PET_W: f64 = 440.0;
const PET_H: f64 = 176.0;
/// 距屏幕右缘的物理间隙
const PET_GAP: i32 = 24;

#[derive(Serialize)]
pub struct PetProbe {
    /// 全局光标物理坐标
    cx: f64,
    cy: f64,
    /// 窗口左上物理坐标
    wx: i32,
    wy: i32,
    /// 窗口物理尺寸
    ww: u32,
    wh: u32,
    /// DPI 缩放(逻辑 = 物理 / scale)
    scale: f64,
}

#[derive(Serialize)]
pub struct PetHome {
    x: i32,
    y: i32,
    scale: f64,
}

fn pet_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(PET_LABEL)
        .ok_or_else(|| "pet 窗口不存在".into())
}

/// 默认落点:所在显示器 work_area 右下角,底边贴任务栏上沿(物理坐标)。
/// work_area 拿不到时退回 monitor 全尺寸(任务栏会被盖住一截,可接受)。
pub fn pet_home(app: &tauri::AppHandle) -> Result<(i32, i32), String> {
    let win = pet_window(app)?;
    let mon = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| win.primary_monitor().ok().flatten())
        .ok_or("无可用显示器")?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let wa = mon.work_area();
    let x = wa.position.x + wa.size.width as i32 - size.width as i32 - PET_GAP;
    let y = wa.position.y + wa.size.height as i32 - size.height as i32;
    Ok((x, y))
}

/// 生产包线上站点(与 src-tauri/splash/config.js 的 AICHATT_ORIGIN 同一域名,改域名两处同步)
const PROD_ORIGIN: &str = "https://chat.yuban.icu";

/// 创建 pet 窗口(不存在时)。先整窗穿透 + 落到任务栏上沿,再交给前端接管。
pub fn pet_ensure_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(PET_LABEL).is_some() {
        return Ok(());
    }
    // 生产包 frontendDist 只有 splash 兜底页:App("/pet/") 会落在壳内 404 = 白屏
    // (2026-11-20 用户报「小鸡一直加载中」的根因)。生产必须直连线上站点;
    // dev/调试构建仍走 devUrl(localhost:3456)。
    let pet_url = if cfg!(debug_assertions) {
        tauri::WebviewUrl::App("/pet/".into())
    } else {
        tauri::WebviewUrl::External(
            format!("{PROD_ORIGIN}/pet/")
                .parse()
                .map_err(|e| format!("pet url: {e}"))?,
        )
    };
    let win = tauri::WebviewWindowBuilder::new(app, PET_LABEL, pet_url)
    .title("桌面小鸡")
    .inner_size(PET_W, PET_H)
    .position(0.0, 0.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(true)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;

    // 整窗穿透先开(前端轮询命中小鸡时再收),再落到右下角任务栏上沿
    let _ = win.set_ignore_cursor_events(true);
    match pet_home(app) {
        Ok((x, y)) => {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        Err(e) => eprintln!("pet home position failed: {}", e),
    }
    Ok(())
}

/// 一次取齐命中判定所需的一切(光标/窗口矩形/缩放),前端 ~130ms 轮询一次
#[tauri::command]
pub fn pet_probe(app: tauri::AppHandle) -> Result<PetProbe, String> {
    let win = pet_window(&app)?;
    let cur = win.cursor_position().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    Ok(PetProbe {
        cx: cur.x,
        cy: cur.y,
        wx: pos.x,
        wy: pos.y,
        ww: size.width,
        wh: size.height,
        scale,
    })
}

/// 切换整窗点击穿透
#[tauri::command]
pub fn pet_set_click_through(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    // 锁定期不做覆盖(D19 定稿「全部开放」):穿透由前端 130ms 轮询动态命中
    // 管理,与锁外完全一致
    pet_window(&app)?
        .set_ignore_cursor_events(on)
        .map_err(|e| e.to_string())
}

/// 锁定期陪学位(2026-11-19 拍板「小鸡当陪学吉祥物」;同日修订定稿:
/// 全部开放,和外面一样——初版强制整窗穿透已按用户口径作废):
/// 主窗口锁定置顶(fl_engage/fl_force_fullscreen)会把本窗盖住,每次主窗口
/// 提顶后调本函数把小鸡重新提到锁定画面之上。交互与锁外完全一致:可拖可点
/// 可逗;点击小鸡获前台时由 fl_handle_focus_lost 的 pet 放行分支免抢回。
/// 解锁无需还原:主窗口退置顶后层级自然回落。pet 窗口不存在(boot 续锁
/// 路径/用户收起)静默跳过。
pub fn pet_raise_for_lock(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(PET_LABEL) {
        // 不能走 set_always_on_top(true):tao 的 apply_diff 先算 flag 差异,
        // 已置顶(创建时就是 always_on_top)则 diff 为空直接 return,SetWindowPos
        // 根本不执行 —— 一次都没真正提过层,小鸡一直压在全屏主窗底下。
        // 改直调 Win32:HWND_TOPMOST 对已在置顶带的窗口同样生效,重插到带顶。
        #[cfg(windows)]
        if let Ok(h) = win.hwnd() {
            #[link(name = "user32")]
            extern "system" {
                fn SetWindowPos(
                    hWnd: isize,
                    hWndInsertAfter: isize,
                    x: i32,
                    y: i32,
                    cx: i32,
                    cy: i32,
                    uFlags: u32,
                ) -> i32;
            }
            const HWND_TOPMOST: isize = -1;
            const SWP_NOSIZE: u32 = 0x0001;
            const SWP_NOMOVE: u32 = 0x0002;
            const SWP_NOACTIVATE: u32 = 0x0010;
            unsafe {
                SetWindowPos(
                    h.0 as isize,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
        #[cfg(not(windows))]
        let _ = win.set_always_on_top(true);
    }
}

/// 前台窗口是否为 pet(锁定期失焦抢回放行用:点小鸡属锁定场景内互动,
/// 不抢回,否则每次点击都会触发 Alt 模拟抢焦点,点击体验被毁)。
#[cfg(windows)]
pub fn pet_is_foreground(app: &tauri::AppHandle) -> bool {
    let Some(win) = app.get_webview_window(PET_LABEL) else { return false };
    let Ok(h) = win.hwnd() else { return false };
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
    }
    unsafe { GetForegroundWindow() == h.0 as isize }
}

#[cfg(not(windows))]
pub fn pet_is_foreground(_app: &tauri::AppHandle) -> bool {
    false
}

/// 相对移动窗口;dx/dy 是逻辑坐标增量,内部按 DPI 换算成物理
#[tauri::command]
pub fn pet_move_window(app: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    let win = pet_window(&app)?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(
        pos.x + (dx * scale).round() as i32,
        pos.y + (dy * scale).round() as i32,
    ))
    .map_err(|e| e.to_string())
}

/// 绝对定位(物理坐标;前端存取位置记忆用)
#[tauri::command]
pub fn pet_set_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    pet_window(&app)?
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// 回窝:返回默认落点(前端拿到后 set_position + 清位置记忆)
#[tauri::command]
pub fn pet_home_position(app: tauri::AppHandle) -> Result<PetHome, String> {
    let scale = pet_window(&app)?
        .scale_factor()
        .map_err(|e| e.to_string())?;
    let (x, y) = pet_home(&app)?;
    Ok(PetHome { x, y, scale })
}

/// 收起 = 销毁窗口(下次应用启动回窝;避免 hidden 窗口永久占坑)
#[tauri::command]
pub fn pet_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(PET_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

/// 再入口:不存在则重建(供后续设置项/托盘接)
#[tauri::command]
pub fn pet_show(app: tauri::AppHandle) -> Result<(), String> {
    pet_ensure_window(&app)?;
    let win = pet_window(&app)?;
    win.show().map_err(|e| e.to_string())
}

/// 把主窗提到前台并跳到指定路由(如 /study?panel=review)。
/// 桌面小鸡点牌直达用;只接受站内相对路径,拒绝外链与 javascript:。
#[tauri::command]
pub fn open_main_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = path.trim();
    if !p.starts_with('/') || p.starts_with("//") || p.to_ascii_lowercase().contains("javascript:") {
        return Err("只允许站内相对路径".into());
    }
    let main = app.get_webview_window("main").ok_or("主窗不存在")?;
    main.show().map_err(|e| e.to_string())?;
    main.unminimize().ok();
    main.set_focus().map_err(|e| e.to_string())?;
    // 单引号转义:路径已在上面白名单化(站内相对、无 javascript:),这里只防拼串
    let safe = p.replace('\'', "%27");
    main.eval(format!("location.href = '{}'", safe))
        .map_err(|e| e.to_string())
}
