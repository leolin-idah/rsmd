//! 原生菜单的构建：纯"状态 → 菜单树"，不做任何状态变更。
//! 菜单项 id 的分发在 `lib.rs`（组合根），变更类动作在 `shell.rs` / `session.rs`。

use crate::ipc::DocMode;
use crate::session::AppState;
use std::path::PathBuf;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Wry};

pub fn build_menu(
    app: &AppHandle,
    state: &AppState,
    recent: &[PathBuf],
) -> tauri::Result<Menu<Wry>> {
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
    let (active_mode, active_dirty) = state
        .docs
        .lock()
        .unwrap()
        .iter()
        .find(|d| Some(d.id) == active)
        .map(|d| (d.mode, d.dirty))
        .unwrap_or((DocMode::Preview, false));

    let install_cli = MenuItemBuilder::with_id("install-cli", "Install 'md' Command").build(app)?;
    // 所有显示设置都在面板里（View 菜单已移除）；Settings… 放应用菜单、⌘, 是 macOS 惯例
    let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "rsmd")
        .item(&settings_item)
        .separator()
        .item(&install_cli)
        .separator()
        // 不能用 PredefinedMenuItem::quit：它直接向 NSApp 发 terminate:，tao 没有 applicationShouldTerminate，
        // 进程会立刻退出而不经过 RunEvent::ExitRequested，脏文档守卫拿不到机会
        .item(
            &MenuItemBuilder::with_id("quit", "Quit rsmd")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;
    // macOS WKWebView 的剪贴板 / 撤销快捷键需要菜单路由，否则编辑器里 ⌘V / ⌘Z 不生效；
    // CodeMirror 通过 beforeinput(historyUndo/Redo) 与 cut/copy/paste DOM 事件接住它们
    // 三种模式做成互斥勾选项（Tauri 无原生 radio）；切换语义在前端，这里只报"哪个被点了"
    let mode_item = |id: &str, label: &str, accel: Option<&str>, mode: DocMode| {
        let mut b = CheckMenuItemBuilder::with_id(id, label)
            .checked(active.is_some() && active_mode == mode)
            .enabled(active.is_some());
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let mode_preview = mode_item("mode-preview", "Preview", None, DocMode::Preview)?;
    let mode_live = mode_item("mode-live", "Live Editing", Some("CmdOrCtrl+E"), DocMode::Live)?;
    let mode_source = mode_item("mode-source", "Source Mode", Some("CmdOrCtrl+/"), DocMode::Source)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&mode_preview)
        .item(&mode_live)
        .item(&mode_source)
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
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .enabled(active_dirty)
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&recent_menu.build()?)
        .separator()
        .item(&save)
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
        .items(&[&app_menu, &edit_menu, &file_menu, &window_menu.build()?])
        .build()
}
