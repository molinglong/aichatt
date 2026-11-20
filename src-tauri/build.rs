fn main() {
    // 应用自定义命令显式注册进 ACL:打包后主窗口加载远程页面(chat.yuban.icu),
    // Tauri 2 对远程源默认拒绝一切未授权 IPC —— 不在此声明的命令,
    // 远程页面调用会报 "Command x not allowed by ACL"。
    // 声明后各命令生成 allow-<命令名> 权限,由 capabilities/default.json 授给远程窗口。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            // 窗口/系统
            "close_window",
            "minimize_window",
            "toggle_maximize",
            "toggle_fullscreen",
            "get_window_state",
            "show_settings_window",
            "get_screen_size",
            // 搭子窗口
            "show_buddy_window",
            "hide_buddy_window",
            "toggle_buddy_window",
            "create_buddy_window",
            "move_buddy_window",
            "focus_main_window",
            "get_buddy_position",
            "set_buddy_position",
            // 本地文件沙箱(lf_*)
            "lf_set_base",
            "lf_get_base",
            "lf_write_file",
            "lf_delete_file",
            "lf_read_file",
            "lf_read_full_file",
            "lf_list_dir",
            "lf_overview",
            "lf_search",
            "lf_edit_file",
            "lf_move_file",
            "lf_exists",
            "lf_reveal",
            "lf_undo",
            "lf_exec",
            // 应用内自更新(仅安卓)
            "updater_check",
            "updater_status",
            "updater_download",
            "updater_install",
            // 监管模式(focus_lock.rs)
            "focus_lock_start",
            "focus_lock_status",
            "focus_lock_stop",
            "focus_lock_end",
            // 桌面小鸡(pet_window.rs)
            "pet_probe",
            "pet_set_click_through",
            "pet_move_window",
            "pet_set_position",
            "pet_home_position",
            "pet_close",
            "pet_show",
            "open_main_path",
            // 性能采样(perf.rs,仅 Windows)
            "perf_probe",
            "perf_history",
            "perf_log_event",
            // 浏览器深链带图提问(lib.rs,仅桌面)
            "deep_link_ask_take",
            // 课堂分栏浏览器(course_browser.rs)
            "course_panel_show",
            "course_panel_hide",
            "course_panel_resize",
            "course_navigate",
            "course_home",
            "course_go_back",
            "course_go_forward",
            "course_reload",
            "course_get_state",
            "course_screenshot",
            "course_set_veiled",
            // 托盘模式:真退出(关闭键长按/右键菜单)
            "quit_app",
        ])),
    )
    .unwrap();
}
