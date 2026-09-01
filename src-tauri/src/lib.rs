//! 组合根：装配插件与状态、注册命令、把原生菜单/系统事件分发到 session / shell。
//! 依赖方向：lib → {shell, menu, commands} → session → {ipc, render, watcher, settings, recent}。

pub mod cli_install;
pub mod commands;
pub mod ipc;
pub mod menu;
pub mod recent;
pub mod render;
pub mod session;
pub mod settings;
pub mod shell;
pub mod watcher;

use session::AppState;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub fn run() {
    let builder = tauri::Builder::default()
        // 必须是第一个 plugin：第二实例的 argv 转发到已有实例后立即退出
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 第二实例可能一次传多个文件；相对路径要基于其 cwd 解析，而非本实例的
            let paths: Vec<PathBuf> = argv
                .iter()
                .skip(1)
                .map(|arg| {
                    let p = PathBuf::from(arg);
                    if p.is_relative() {
                        std::path::Path::new(&cwd).join(p)
                    } else {
                        p
                    }
                })
                .collect();
            session::pending_or_open(app, paths);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle();
            // settings 先于菜单构建装载：build_menu 读取 Layout 勾选态
            *app.state::<AppState>().settings.lock().unwrap() =
                settings::load(&shell::config_dir(handle));
            // CLI 入口：rsmd <file...>；frontend_ready 握手后才真正打开，
            // 避免事件早于前端监听器注册（spec §4）
            let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
            app.state::<AppState>().initial.lock().unwrap().extend(args);
            let recent = recent::load(&shell::config_dir(handle));
            let menu = menu::build_menu(handle, &app.state::<AppState>(), &recent)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "open" => {
                    let handle = app.clone();
                    app.dialog()
                        .file()
                        .add_filter("Markdown", &["md", "markdown", "mdown"])
                        .pick_files(move |files| {
                            // 整批 open-or-focus；首个成功的成为 active，其余后台待命（设计 §4）
                            let paths: Vec<PathBuf> = files
                                .into_iter()
                                .flatten()
                                .filter_map(|f| f.into_path().ok())
                                .collect();
                            session::open_batch(&handle, paths);
                        });
                }
                "install-cli" => shell::install_cli(app),
                "mode-preview" => session::request_mode(app, ipc::DocMode::Preview),
                "mode-live" => session::request_mode(app, ipc::DocMode::Live),
                "mode-source" => session::request_mode(app, ipc::DocMode::Source),
                "save" => session::request_save(app),
                // 自定义 Quit：脏文档先问（request_quit 返回 true 表示已弹框）；干净则走 exit → ExitRequested 放行
                "quit" => {
                    if !session::request_quit(app) {
                        app.exit(0);
                    }
                }
                "close-tab" => session::close_active(app),
                "next-tab" => session::cycle(app, 1),
                "prev-tab" => session::cycle(app, -1),
                "settings" => shell::open_settings(app),
                _ => {
                    if let Some(idx) = id.strip_prefix("recent:")
                        && let Ok(i) = idx.parse::<usize>()
                    {
                        let list = recent::load(&shell::config_dir(app));
                        if let Some(p) = list.get(i) {
                            session::open_or_report(app, p.clone());
                        }
                    } else if let Some(raw) = id.strip_prefix("doc:")
                        && let Ok(doc_id) = raw.parse::<u64>()
                    {
                        session::focus_doc(app, doc_id);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_paths,
            commands::open_relative,
            commands::close_doc,
            commands::set_active_doc,
            commands::activate_relative,
            commands::get_settings,
            commands::frontend_ready,
            commands::render_markdown,
            commands::save_doc,
            commands::set_doc_state,
            commands::set_settings
        ])
        .on_window_event(|window, event| {
            // 红点关窗：有脏文档先问；用户选丢弃后 session 调 app.exit，再次进入时不再脏
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if session::any_dirty(app) {
                    api.prevent_close();
                    session::request_quit(app);
                }
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS Finder 双击/"打开方式"走 RunEvent::Opened；
    // Opened 可能早于前端就绪——pending_or_open 已处理暂存（spec §4 握手闭环）
    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            session::pending_or_open(app_handle, paths);
        }
        // ⌘Q / 所有窗口关闭：有脏文档先问
        tauri::RunEvent::ExitRequested { api, .. } => {
            if session::any_dirty(app_handle) {
                api.prevent_exit();
                session::request_quit(app_handle);
            }
        }
        _ => {}
    });
}
