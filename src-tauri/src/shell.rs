//! `session::Shell` 在 Tauri 上的实现，以及只有宿主才做的动作：
//! 重建菜单、变更并持久化 settings、安装 `md` 命令。

use crate::ipc::Event;
use crate::session::{AppState, CloseChoice, Shell};
use crate::settings::{self, Settings};
use crate::{cli_install, menu, recent};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

pub fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("config dir must resolve")
}

/// open / close / set_active / settings 变更后统一重建菜单（勾选态与 enable 态）。
pub fn rebuild_menu(app: &AppHandle) {
    let recent = recent::load(&config_dir(app));
    if let Ok(menu) = menu::build_menu(app, Shell::state(app), &recent) {
        let _ = app.set_menu(menu);
    }
}

/// 所有 settings 变更的唯一路径：改 → 落盘 → 通知前端 → 重建菜单。
pub fn update_settings(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let s = {
        let mut guard = Shell::state(app).settings.lock().unwrap();
        change(&mut guard);
        *guard
    };
    settings::save(&config_dir(app), &s);
    Shell::emit(app, Event::SettingsChanged(s));
    rebuild_menu(app);
}

/// Install 'md' Command 菜单项：把启动脚本写入 ~/.local/bin，结果弹窗反馈。
/// `tauri dev` 跑裸二进制时找不到 .app，脚本退化为仅按 bundle id 解析。
pub fn install_cli(app: &AppHandle) {
    let bundle = std::env::current_exe().ok().and_then(|exe| {
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf)
    });
    let result = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())
        .and_then(|home| {
            cli_install::install(
                &home.join(".local/bin"),
                bundle.as_deref(),
                &app.config().identifier,
            )
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
    app.dialog()
        .message(msg)
        .title("Install 'md' Command")
        .kind(kind)
        .show(|_| {});
}

impl Shell for AppHandle {
    fn state(&self) -> &AppState {
        Manager::state::<AppState>(self).inner()
    }

    fn emit(&self, event: Event) {
        let _ = event.send(self);
    }

    fn set_title(&self, title: &str) {
        if let Some(w) = self.get_webview_window("main") {
            let _ = w.set_title(title);
        }
    }

    fn refresh_menu(&self) {
        rebuild_menu(self);
    }

    fn remember_recent(&self, path: &Path) {
        recent::add(&config_dir(self), path);
    }

    fn confirm_close(&self, title: &str, on_choice: Box<dyn FnOnce(CloseChoice) + Send + 'static>) {
        let mut dialog = self
            .dialog()
            .message(format!(
                "Do you want to save the changes you made to \u{201c}{title}\u{201d}?"
            ))
            .title("Unsaved Changes")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Save".into(),
                "Don't Save".into(),
                "Cancel".into(),
            ));
        // 必须显式挂到主窗口：rfd 在 macOS 上找不到 parent 时退到 NSApp.windows 的首个窗口，
        // 可能是进程里不可见的辅助窗口，sheet 挂上去后永远看不到、关闭流程悬空
        if let Some(w) = self.get_webview_window("main") {
            dialog = dialog.parent(&w);
        }
        dialog.show_with_result(move |result| {
                // 自定义按钮在不同平台可能回 Yes/No 或 Custom(label)，两种都接
                let choice = match result {
                    MessageDialogResult::Yes => CloseChoice::Save,
                    MessageDialogResult::No => CloseChoice::Discard,
                    MessageDialogResult::Custom(label) if label == "Save" => CloseChoice::Save,
                    MessageDialogResult::Custom(label) if label == "Don't Save" => CloseChoice::Discard,
                    _ => CloseChoice::Cancel,
                };
                on_choice(choice);
            });
    }

    fn confirm_quit(&self, dirty_count: usize, on_discard: Box<dyn FnOnce() + Send + 'static>) {
        let message = if dirty_count == 1 {
            "1 document has unsaved changes. Quit and discard it?".to_string()
        } else {
            format!("{dirty_count} documents have unsaved changes. Quit and discard them?")
        };
        let mut dialog = self
            .dialog()
            .message(message)
            .title("Unsaved Changes")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Discard and Quit".into(),
                "Cancel".into(),
            ));
        if let Some(w) = self.get_webview_window("main") {
            dialog = dialog.parent(&w);
        }
        dialog.show(move |ok| {
                if ok {
                    on_discard();
                }
            });
    }

    fn quit(&self) {
        self.exit(0);
    }
}
