//! Rust → 前端 的事件契约：载荷 DTO 与事件枚举，事件名只在这里出现一次。
//! 前端镜像见 `src/ipc.ts`（serde camelCase）。

use crate::settings::Settings;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenedPayload {
    pub doc_id: u64,
    pub path: String,
    pub file_name: String,
    pub html: String,
    pub title: String,
    pub base_dir: String,
    // 批量打开只有首个成功的文档为 true：前端据此决定是否设 active 并立即渲染，
    // 其余文档只建空壳、切到时再渲染
    pub activate: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUpdatedPayload {
    pub doc_id: u64,
    pub html: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocClosedPayload {
    pub doc_id: u64,
    pub next_active: Option<u64>,
}

/// document-focus / document-removed / watch-unavailable 共用：只带 docId。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRefPayload {
    pub doc_id: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    DocumentOpened(DocOpenedPayload),
    DocumentUpdated(DocUpdatedPayload),
    DocumentFocus(DocRefPayload),
    DocumentClosed(DocClosedPayload),
    DocumentRemoved(DocRefPayload),
    WatchUnavailable(DocRefPayload),
    SettingsChanged(Settings),
    OpenError(String),
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::DocumentOpened(_) => "document-opened",
            Event::DocumentUpdated(_) => "document-updated",
            Event::DocumentFocus(_) => "document-focus",
            Event::DocumentClosed(_) => "document-closed",
            Event::DocumentRemoved(_) => "document-removed",
            Event::WatchUnavailable(_) => "watch-unavailable",
            Event::SettingsChanged(_) => "settings-changed",
            Event::OpenError(_) => "open-error",
        }
    }

    pub fn send(&self, app: &AppHandle) -> tauri::Result<()> {
        let name = self.name();
        match self {
            Event::DocumentOpened(p) => app.emit(name, p),
            Event::DocumentUpdated(p) => app.emit(name, p),
            Event::DocumentFocus(p) => app.emit(name, p),
            Event::DocumentClosed(p) => app.emit(name, p),
            Event::DocumentRemoved(p) => app.emit(name, p),
            Event::WatchUnavailable(p) => app.emit(name, p),
            Event::SettingsChanged(p) => app.emit(name, p),
            Event::OpenError(msg) => app.emit(name, msg),
        }
    }
}
