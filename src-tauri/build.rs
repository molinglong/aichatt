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
        ])),
    )
    .unwrap();
}
