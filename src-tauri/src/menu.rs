//! 原生菜单的构建：纯"状态 → 菜单树"，不做任何状态变更。
//! 菜单项 id 的分发在 `lib.rs`（组合根），变更类动作在 `shell.rs` / `session.rs`。

use crate::session::AppState;
use crate::settings::{Layout, TocSide};
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
    let settings = *state.settings.lock().unwrap();
    let layout = settings.layout;
    let toc_side = settings.toc_side;

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
    let toc_show = CheckMenuItemBuilder::with_id("toggle-toc", "Show")
        .accelerator("Alt+CmdOrCtrl+T")
        .checked(settings.toc)
        .build(app)?;
    // TOC 隐藏时位置无从谈起，置灰而非默默失效
    let toc_left = CheckMenuItemBuilder::with_id("toc-side:left", "Left")
        .checked(toc_side == TocSide::Left)
        .enabled(settings.toc)
        .build(app)?;
    let toc_right = CheckMenuItemBuilder::with_id("toc-side:right", "Right")
        .checked(toc_side == TocSide::Right)
        .enabled(settings.toc)
        .build(app)?;
    let toc_menu = SubmenuBuilder::new(app, "Table of Contents")
        .item(&toc_show)
        .separator()
        .item(&toc_left)
        .item(&toc_right)
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&SubmenuBuilder::new(app, "Layout").item(&layout_tabs).item(&layout_side).build()?)
        .item(&toc_menu)
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
