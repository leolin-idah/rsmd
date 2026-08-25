pub mod cli_install;
pub mod commands;
pub mod recent;
pub mod render;
pub mod settings;
pub mod watcher;

use commands::AppState;
use settings::Layout;
use std::path::{Path, PathBuf};
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub fn build_menu(app: &AppHandle, recent: &[PathBuf]) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let docs: Vec<(u64, String)> = state
        .docs
        .lock()
        .unwrap()
        .iter()
        .map(|d| {
            let name = d.path.file_name().map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| d.path.to_string_lossy().into_owned());
            (d.id, name)
        })
        .collect();
    let active = *state.active.lock().unwrap();
    let settings = *state.settings.lock().unwrap();
    let layout = settings.layout;

    let install_cli = MenuItemBuilder::with_id("install-cli", "Install 'md' Command").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "rsmd")
        .item(&install_cli)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    // macOS WKWebView 的 ⌘C/⌘A 需要菜单路由，否则快捷键不生效
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let open = MenuItemBuilder::with_id("open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let mut recent_menu = SubmenuBuilder::new(app, "Open Recent");
    for (i, p) in recent.iter().enumerate() {
        let label = p.file_name().map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string_lossy().into_owned());
        recent_menu = recent_menu.item(
            &MenuItemBuilder::with_id(format!("recent:{i}"), label).build(app)?,
        );
    }
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&recent_menu.build()?)
        .build()?;

    let layout_tabs = CheckMenuItemBuilder::with_id("layout:tabs", "Tabs")
        .checked(layout == Layout::Tabs)
        .build(app)?;
    let layout_side = CheckMenuItemBuilder::with_id("layout:sideList", "Side List")
        .checked(layout == Layout::SideList)
        .build(app)?;
    let toc_item = CheckMenuItemBuilder::with_id("toggle-toc", "Table of Contents")
        .accelerator("Alt+CmdOrCtrl+T")
        .checked(settings.toc)
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&SubmenuBuilder::new(app, "Layout").item(&layout_tabs).item(&layout_side).build()?)
        .item(&toc_item)
        .build()?;

    // ⌘W 必须走菜单（macOS 强语义 + 焦点不在 webview 时 keydown 收不到）；
    // 无 tab 时 disable，避免误触系统默认行为
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .enabled(!docs.is_empty())
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next-tab", "Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .enabled(!docs.is_empty())
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev-tab", "Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .enabled(!docs.is_empty())
        .build(app)?;
    let mut window_menu = SubmenuBuilder::new(app, "Window")
        .item(&close_tab)
        .separator()
        .item(&next_tab)
        .item(&prev_tab);
    if !docs.is_empty() {
        window_menu = window_menu.separator();
    }
    let n = docs.len();
    for (i, (id, name)) in docs.iter().enumerate() {
        let mut item = CheckMenuItemBuilder::with_id(format!("doc:{id}"), name)
            .checked(Some(*id) == active);
        // 前 8 个依次 ⌘1~8；⌘9 固定最后一个（浏览器惯例）；其余无快捷键但仍列出
        if i < 8 {
            item = item.accelerator(format!("CmdOrCtrl+{}", i + 1));
        } else if i == n - 1 {
            item = item.accelerator("CmdOrCtrl+9");
        }
        window_menu = window_menu.item(&item.build(app)?);
    }

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &file_menu, &view_menu, &window_menu.build()?])
        .build()
}

/// open / close / set_active / layout 切换后统一重建菜单（勾选态与 enable 态）。
pub fn rebuild_menu(app: &AppHandle) {
    let recent = recent::load(&config_dir(app));
    if let Ok(menu) = build_menu(app, &recent) {
        let _ = app.set_menu(menu);
    }
}

fn set_layout(app: &AppHandle, layout: Layout) {
    let state = app.state::<AppState>();
    let s = {
        let mut guard = state.settings.lock().unwrap();
        guard.layout = layout;
        *guard
    };
    settings::save(&config_dir(app), &s);
    let _ = app.emit("settings-changed", &s);
    rebuild_menu(app);
}

fn toggle_toc(app: &AppHandle) {
    let state = app.state::<AppState>();
    let s = {
        let mut guard = state.settings.lock().unwrap();
        guard.toc = !guard.toc;
        *guard
    };
    settings::save(&config_dir(app), &s);
    let _ = app.emit("settings-changed", &s);
    rebuild_menu(app);
}

fn config_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_config_dir().expect("config dir must resolve")
}

/// Install 'md' Command 菜单项：把启动脚本写入 ~/.local/bin，结果弹窗反馈。
/// `tauri dev` 跑裸二进制时找不到 .app，脚本退化为仅按 bundle id 解析。
fn install_cli(app: &AppHandle) {
    let bundle = std::env::current_exe().ok().and_then(|exe| {
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf)
    });
    let result = app.path().home_dir().map_err(|e| e.to_string()).and_then(|home| {
        cli_install::install(&home.join(".local/bin"), bundle.as_deref(), &app.config().identifier)
    });
    let (kind, msg) = match result {
        Ok(target) => (
            MessageDialogKind::Info,
            format!(
                "Installed {}.\nMake sure ~/.local/bin is on your PATH.",
                target.display()
            ),
        ),
        Err(e) => (MessageDialogKind::Error, e),
    };
    app.dialog().message(msg).title("Install 'md' Command").kind(kind).show(|_| {});
}

pub fn run() {
    let builder = tauri::Builder::default()
        // 必须是第一个 plugin：第二实例的 argv 转发到已有实例后立即退出
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 第二实例可能一次传多个文件；相对路径要基于其 cwd 解析，而非本实例的
            for arg in argv.iter().skip(1) {
                let p = PathBuf::from(arg);
                let p = if p.is_relative() {
                    std::path::Path::new(&cwd).join(p)
                } else {
                    p
                };
                commands::pending_or_open(app, p);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // settings 先于菜单构建装载：build_menu 读取 Layout 勾选态
            *app.state::<AppState>().settings.lock().unwrap() =
                settings::load(&config_dir(app.handle()));
            // CLI 入口：rsmd <file...>；frontend_ready 握手后才真正打开，
            // 避免事件早于前端监听器注册（spec §4）
            let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
            app.state::<AppState>().initial.lock().unwrap().extend(args);
            let menu = build_menu(app.handle(), &recent::load(&config_dir(app.handle())))?;
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
                            // 逐个 open-or-focus；最后一个成为 active（设计 §4）
                            for f in files.into_iter().flatten() {
                                if let Ok(p) = f.into_path() {
                                    commands::open_or_report(&handle, p);
                                }
                            }
                        });
                }
                "install-cli" => install_cli(app),
                "close-tab" => commands::close_active(app),
                "next-tab" => commands::cycle(app, 1),
                "prev-tab" => commands::cycle(app, -1),
                "layout:tabs" => set_layout(app, Layout::Tabs),
                "layout:sideList" => set_layout(app, Layout::SideList),
                "toggle-toc" => toggle_toc(app),
                _ => {
                    if let Some(idx) = id.strip_prefix("recent:")
                        && let Ok(i) = idx.parse::<usize>()
                    {
                        let list = recent::load(&config_dir(app));
                        if let Some(p) = list.get(i) {
                            commands::open_or_report(app, p.clone());
                        }
                    } else if let Some(raw) = id.strip_prefix("doc:")
                        && let Ok(doc_id) = raw.parse::<u64>()
                    {
                        commands::focus_doc(app, doc_id);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_path,
            commands::open_relative,
            commands::close_doc,
            commands::set_active_doc,
            commands::activate_relative,
            commands::get_settings,
            commands::frontend_ready
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS Finder 双击/"打开方式"走 RunEvent::Opened；
    // Opened 可能早于前端就绪——pending_or_open 已处理暂存（spec §4 握手闭环）
    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    commands::pending_or_open(app_handle, path);
                }
            }
        }
    });
}
