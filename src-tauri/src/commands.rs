//! 前端 → Rust 的 `#[tauri::command]` 薄壳：只做参数适配，逻辑全在 `session`。
//! 签名与 `src/ipc.ts` 一一对应。

use crate::ipc::DocMode;
use crate::session::{self, AppState};
use crate::shell;
use crate::settings::Settings;
use std::path::PathBuf;
use tauri::{AppHandle, State};

/// 拖放入口：整批一次提交。失败经 `open-error` 事件上报，命令本身不返回错误。
#[tauri::command]
pub fn open_paths(app: AppHandle, paths: Vec<String>) {
    session::open_batch(&app, paths.into_iter().map(PathBuf::from).collect());
}

#[tauri::command]
pub fn open_relative(app: AppHandle, doc_id: u64, href: String) -> Result<(), String> {
    session::open_relative(&app, doc_id, href)
}

#[tauri::command]
pub fn close_doc(app: AppHandle, doc_id: u64) -> Result<(), String> {
    session::close_doc(&app, doc_id);
    Ok(())
}

#[tauri::command]
pub fn set_active_doc(app: AppHandle, doc_id: u64) -> Result<(), String> {
    session::focus_doc(&app, doc_id);
    Ok(())
}

#[tauri::command]
pub fn activate_relative(app: AppHandle, offset: i64) -> Result<(), String> {
    session::cycle(&app, offset);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    *state.settings.lock().unwrap()
}

#[tauri::command]
pub fn frontend_ready(app: AppHandle) -> Result<(), String> {
    session::frontend_ready(&app);
    Ok(())
}

#[tauri::command]
pub fn save_doc(app: AppHandle, doc_id: u64, text: String) -> Result<(), String> {
    session::save_doc(&app, doc_id, &text)
}

#[tauri::command]
pub fn set_doc_state(
    app: AppHandle,
    doc_id: u64,
    mode: DocMode,
    dirty: bool,
    title: Option<String>,
) -> Result<(), String> {
    session::set_doc_state(&app, doc_id, mode, dirty, title);
    Ok(())
}

/// Settings 面板整体写回：与逐项修改走同一条路径（落盘 → settings-changed → 重建菜单），
/// 前端本地先行后由回声确认。
#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) {
    shell::update_settings(&app, |s| *s = settings);
}
