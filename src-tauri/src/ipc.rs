//! Rust → 前端 的事件契约：载荷 DTO 与事件枚举，事件名只在这里出现一次。
//! 前端镜像见 `src/ipc.ts`（serde camelCase）。

use crate::render::BlockRange;
use crate::settings::Settings;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenedPayload {
    pub doc_id: u64,
    pub path: String,
    pub file_name: String,
    pub text: String, // 编辑器初始内容（唯一真相）
    pub html: String, // 整页渲染，前端按 blocks 切成 widget
    pub blocks: Vec<BlockRange>,
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
    pub text: String,
    pub html: String,
    pub blocks: Vec<BlockRange>,
    pub title: String,
    // false = 内容 hash 与我们最近一次看到/写入的一致（自己保存的回声或无实质变化）
    pub external: bool,
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

/// `render_markdown` 命令的返回值（不是事件）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPayload {
    pub html: String,
    pub blocks: Vec<BlockRange>,
    pub title: String,
}

/// 菜单 Save / 关闭脏文档时选择 Save：让前端把编辑器文本交回 `save_doc`。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequestedPayload {
    pub doc_id: u64,
    pub close_after: bool,
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
    ToggleEdit(DocRefPayload),
    SaveRequested(SaveRequestedPayload),
    /// 应用菜单 Settings…（⌘,）：让前端打开设置面板；无载荷
    OpenSettings,
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
            Event::ToggleEdit(_) => "toggle-edit",
            Event::SaveRequested(_) => "save-requested",
            Event::OpenSettings => "open-settings",
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
            Event::ToggleEdit(p) => app.emit(name, p),
            Event::SaveRequested(p) => app.emit(name, p),
            Event::OpenSettings => app.emit(name, ()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_settings_event_name_matches_frontend_listener() {
        // 前端 src/ipc.ts 的 Events 表用这个字面量注册监听
        assert_eq!(Event::OpenSettings.name(), "open-settings");
    }
}
