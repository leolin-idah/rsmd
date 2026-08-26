use crate::render;
use crate::settings::Settings;
use crate::watcher::{FileEvent, FileEventKind, FileWatcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct OpenDoc {
    pub id: u64,
    pub path: PathBuf,                // canonicalize 后
    pub title: String,                // 首个 heading 或文件名 stem
    pub watcher: Option<FileWatcher>, // None = watch 启动失败，已降级
}

#[derive(Default)]
pub struct AppState {
    pub docs: Mutex<Vec<OpenDoc>>, // 权威列表，顺序即 tab 顺序，新文档追加尾部
    pub active: Mutex<Option<u64>>,
    pub next_id: AtomicU64,
    pub settings: Mutex<Settings>,
    pub initial: Mutex<Vec<PathBuf>>, // macOS Opened 可一次携带多个 url
    pub ready: AtomicBool,
}

#[derive(Clone, serde::Serialize)]
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUpdatedPayload {
    pub doc_id: u64,
    pub html: String,
    pub title: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocClosedPayload {
    pub doc_id: u64,
    pub next_active: Option<u64>,
}

/// document-focus / document-removed / watch-unavailable 共用：只带 docId。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRefPayload {
    pub doc_id: u64,
}

struct RenderedDoc {
    html: String,
    title: String,
    base_dir: String,
}

fn load_and_render(path: &Path) -> Result<RenderedDoc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let base_dir = path
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?;
    let result = render::render(&text, base_dir);
    let title = result.first_heading.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "rsmd".into())
    });
    Ok(RenderedDoc {
        html: result.html,
        title,
        base_dir: base_dir.to_string_lossy().into_owned(),
    })
}

/// path → docId 反查；两侧均为 canonicalize 后的路径。
pub(crate) fn find_doc(docs: &[OpenDoc], canon: &Path) -> Option<u64> {
    docs.iter().find(|d| d.path == canon).map(|d| d.id)
}

/// 关闭 `closing` 后应激活谁：关 active 右侧优先、无右侧取左侧、关最后一个为 None；
/// 关非 active 不改变 active。`ids` 为关闭前的列表。
pub(crate) fn next_active(ids: &[u64], closing: u64, active: Option<u64>) -> Option<u64> {
    if active != Some(closing) {
        return active;
    }
    let i = ids.iter().position(|&x| x == closing)?;
    ids.get(i + 1)
        .or_else(|| i.checked_sub(1).and_then(|j| ids.get(j)))
        .copied()
}

/// Next/Prev/⌃Tab 共用的循环取模；空列表为 None。循环逻辑只存在于这一处。
pub(crate) fn relative_target(ids: &[u64], active: Option<u64>, offset: i64) -> Option<u64> {
    if ids.is_empty() {
        return None;
    }
    let len = ids.len() as i64;
    let cur = active
        .and_then(|a| ids.iter().position(|&x| x == a))
        .unwrap_or(0) as i64;
    Some(ids[(cur + offset).rem_euclid(len) as usize])
}

fn set_native_title(app: &AppHandle, title: &str) {
    // Tauri 2 不会把 document.title 镜像到原生标题栏，需手动同步
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(title);
    }
}

/// 一切 active 变更的统一出口：更新 active、原生标题栏、菜单勾选，
/// emit `document-focus`（前端 applyFocus 幂等）。doc 不存在则忽略。
pub(crate) fn focus_doc(app: &AppHandle, doc_id: u64) {
    let state = app.state::<AppState>();
    let title = {
        let docs = state.docs.lock().unwrap();
        docs.iter().find(|d| d.id == doc_id).map(|d| d.title.clone())
    };
    let Some(title) = title else { return };
    *state.active.lock().unwrap() = Some(doc_id);
    set_native_title(app, &title);
    crate::rebuild_menu(app);
    let _ = app.emit("document-focus", &DocRefPayload { doc_id });
}

fn on_file_event(app: &AppHandle, ev: FileEvent) {
    let state = app.state::<AppState>();
    // 锁内只做反查：查不到说明 tab 已关（去抖事件可能晚于关闭落地），忽略
    let doc_id = find_doc(&state.docs.lock().unwrap(), &ev.path);
    let Some(doc_id) = doc_id else { return };
    match ev.kind {
        FileEventKind::Modified => {
            // 瞬态读失败（如写入中途）忽略，下一次事件会补上
            let Ok(r) = load_and_render(&ev.path) else { return };
            // render 期间 doc 可能已被关闭：title 更新与存在性检查同临界区
            let still_open = {
                let mut docs = state.docs.lock().unwrap();
                docs.iter_mut()
                    .find(|d| d.id == doc_id)
                    .map(|d| d.title = r.title.clone())
                    .is_some()
            };
            if !still_open {
                return;
            }
            let _ = app.emit(
                "document-updated",
                &DocUpdatedPayload { doc_id, html: r.html, title: r.title.clone() },
            );
            // 仅 active doc 同步原生标题栏：后台 tab 热刷新不得改窗口标题
            if *state.active.lock().unwrap() == Some(doc_id) {
                set_native_title(app, &r.title);
            }
        }
        FileEventKind::Removed => {
            let _ = app.emit("document-removed", &DocRefPayload { doc_id });
        }
    }
}

/// open-or-focus：已打开则聚焦已有 tab，否则新开。
/// `activate=false`（批量打开的非首个文档）：新开的追加到列表末尾但不改 active、
/// 不动原生标题；已打开的也不抢焦点。
pub fn open_document(app: &AppHandle, path: PathBuf, activate: bool) -> Result<(), String> {
    let path = path.canonicalize().map_err(|e| format!("Cannot open: {e}"))?;
    let state = app.state::<AppState>();

    // 第一重检查：判重与插入必须同临界区（见下方第二重检查），读文件/render 不持锁
    let existing = find_doc(&state.docs.lock().unwrap(), &path);
    if let Some(id) = existing {
        if activate {
            focus_doc(app, id);
        }
        return Ok(());
    }

    let rendered = load_and_render(&path)?;
    let handle = app.clone();
    let (watcher, watch_failed) = match FileWatcher::watch(&path, move |ev| on_file_event(&handle, ev)) {
        Ok(w) => (Some(w), false),
        Err(_) => (None, true), // 降级：doc 照常打开，watcher = None
    };

    // 第二重检查：render 期间可能已被并发打开——丢弃本次 render 结果，聚焦已有 tab
    let inserted = {
        let mut docs = state.docs.lock().unwrap();
        match find_doc(&docs, &path) {
            Some(id) => Err(id),
            None => {
                let id = state.next_id.fetch_add(1, Ordering::SeqCst);
                docs.push(OpenDoc {
                    id,
                    path: path.clone(),
                    title: rendered.title.clone(),
                    watcher, // 竞态失败分支不 push：本次 watcher 随作用域 Drop 停止
                });
                Ok(id)
            }
        }
    };
    let doc_id = match inserted {
        Err(id) => {
            if activate {
                focus_doc(app, id);
            }
            return Ok(());
        }
        Ok(id) => id,
    };

    if activate {
        *state.active.lock().unwrap() = Some(doc_id);
        set_native_title(app, &rendered.title);
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let _ = app.emit(
        "document-opened",
        &DocOpenedPayload {
            doc_id,
            path: path.to_string_lossy().into_owned(),
            file_name,
            html: rendered.html,
            title: rendered.title,
            base_dir: rendered.base_dir,
            activate,
        },
    );
    if watch_failed {
        let _ = app.emit("watch-unavailable", &DocRefPayload { doc_id });
    }

    // 记录最近文件并刷新菜单
    let cfg = app.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::recent::add(&cfg, &path);
    crate::rebuild_menu(app);
    Ok(())
}

/// 单个打开（菜单 Recent 等）并设为 active；失败时通过 `open-error` 事件上报前端。
pub fn open_or_report(app: &AppHandle, path: PathBuf) {
    if let Err(e) = open_document(app, path, true) {
        let _ = app.emit("open-error", e);
    }
}

/// 批量打开（CLI 多参数、Finder 多选、⌘O 多选、拖放多文件）：
/// 按给定顺序追加，**首个成功打开的**（含聚焦已存在 tab）设为 active，其余后台待命。
/// 以"首个成功"而非"首个路径"为准：首个文件打不开时由下一个补位，
/// 避免出现有 tab 却无 active 的空白态。单个失败经 `open-error` 上报，不中断其余。
pub fn open_batch(app: &AppHandle, paths: Vec<PathBuf>) {
    let mut activated = false;
    for p in paths {
        match open_document(app, p, !activated) {
            Ok(()) => activated = true,
            Err(e) => {
                let _ = app.emit("open-error", e);
            }
        }
    }
}

pub fn pending_or_open(app: &AppHandle, paths: Vec<PathBuf>) {
    let state = app.state::<AppState>();
    // 与 frontend_ready 在 `initial` 锁上串行化：ready 的读取必须发生在锁内，
    // 否则 ready 置位 + initial 排空可能插在 check 与 act 之间，导致本次打开被丢弃。
    // 决策在临界区内完成，open 动作在释放锁之后执行，避免与打开链路重入锁。
    let to_open = {
        let mut initial = state.initial.lock().unwrap();
        if state.ready.load(Ordering::SeqCst) {
            Some(paths)
        } else {
            initial.extend(paths); // ready 前到达的多批合并为一批，首个成功的为 active
            None
        }
    };
    if let Some(ps) = to_open {
        open_batch(app, ps);
    }
}

/// 菜单 ⌘W 入口：关闭当前 active tab。
pub fn close_active(app: &AppHandle) {
    let active = *app.state::<AppState>().active.lock().unwrap();
    if let Some(id) = active {
        let _ = close_doc(app.clone(), id);
    }
}

/// 菜单 Next/Prev 与 ⌃Tab 共用入口。
pub fn cycle(app: &AppHandle, offset: i64) {
    let state = app.state::<AppState>();
    let ids: Vec<u64> = state.docs.lock().unwrap().iter().map(|d| d.id).collect();
    let active = *state.active.lock().unwrap();
    if let Some(target) = relative_target(&ids, active, offset) {
        focus_doc(app, target);
    }
}

/// 拖放入口：整批一次提交。失败经 `open-error` 事件上报，命令本身不返回错误。
#[tauri::command]
pub fn open_paths(app: AppHandle, paths: Vec<String>) {
    open_batch(&app, paths.into_iter().map(PathBuf::from).collect());
}

#[tauri::command]
pub fn open_relative(
    app: AppHandle,
    state: State<AppState>,
    doc_id: u64,
    href: String,
) -> Result<(), String> {
    // 以链接所在 doc 的 parent 解析相对路径，而非全局 current
    let base = {
        let docs = state.docs.lock().unwrap();
        docs.iter()
            .find(|d| d.id == doc_id)
            .and_then(|d| d.path.parent().map(Path::to_path_buf))
    }
    .ok_or_else(|| "Source document is no longer open".to_string())?;
    open_document(&app, base.join(href), true)
}

#[tauri::command]
pub fn close_doc(app: AppHandle, doc_id: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    // 唯一的锁嵌套点，固定锁序 docs → active
    let next = {
        let mut docs = state.docs.lock().unwrap();
        let ids: Vec<u64> = docs.iter().map(|d| d.id).collect();
        if !ids.contains(&doc_id) {
            return Ok(()); // 已关闭（重复 ⌘W / 竞态）
        }
        let next = next_active(&ids, doc_id, *state.active.lock().unwrap());
        docs.retain(|d| d.id != doc_id); // FileWatcher 随 OpenDoc Drop 自动停监听
        *state.active.lock().unwrap() = next;
        next
    };
    let title = next.and_then(|id| {
        state.docs.lock().unwrap().iter().find(|d| d.id == id).map(|d| d.title.clone())
    });
    set_native_title(&app, title.as_deref().unwrap_or("rsmd"));
    crate::rebuild_menu(&app);
    let _ = app.emit("document-closed", &DocClosedPayload { doc_id, next_active: next });
    Ok(())
}

#[tauri::command]
pub fn set_active_doc(app: AppHandle, doc_id: u64) -> Result<(), String> {
    focus_doc(&app, doc_id);
    Ok(())
}

#[tauri::command]
pub fn activate_relative(app: AppHandle, offset: i64) -> Result<(), String> {
    cycle(&app, offset);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    *state.settings.lock().unwrap()
}

#[tauri::command]
pub fn frontend_ready(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // ready 置位与 initial 排空在同一 `initial` 临界区内完成（与 pending_or_open 串行化），
    // 打开动作在锁释放后执行。
    let initial = {
        let mut guard = state.initial.lock().unwrap();
        state.ready.store(true, Ordering::SeqCst);
        std::mem::take(&mut *guard)
    };
    // 启动路径打开失败也要经 open-error 事件上报（前端弹横幅），而不是吞进 invoke 错误
    open_batch(&app, initial);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn load_and_render_produces_payload() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "# Hi\n\nbody").unwrap();
        let p = load_and_render(&file).unwrap();
        assert!(p.html.contains("Hi"));
        assert_eq!(p.title, "Hi");
        assert_eq!(p.base_dir, dir.path().to_string_lossy());
    }

    #[test]
    fn title_falls_back_to_file_stem() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("my-note.md");
        fs::write(&file, "no heading here").unwrap();
        assert_eq!(load_and_render(&file).unwrap().title, "my-note");
    }

    #[test]
    fn non_utf8_is_rendered_lossily() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bad.md");
        fs::write(&file, [b'o', b'k', 0xFF, 0xFE, b'!']).unwrap();
        let p = load_and_render(&file).unwrap();
        assert!(p.html.contains("ok"));
    }

    #[test]
    fn missing_file_is_error() {
        assert!(load_and_render(std::path::Path::new("/no/such.md")).is_err());
    }

    #[test]
    fn next_active_prefers_right_neighbor() {
        assert_eq!(next_active(&[1, 2, 3], 2, Some(2)), Some(3));
    }

    #[test]
    fn next_active_takes_left_when_closing_rightmost() {
        assert_eq!(next_active(&[1, 2, 3], 3, Some(3)), Some(2));
    }

    #[test]
    fn next_active_is_none_when_closing_last_doc() {
        assert_eq!(next_active(&[1], 1, Some(1)), None);
    }

    #[test]
    fn next_active_keeps_active_when_closing_inactive() {
        assert_eq!(next_active(&[1, 2, 3], 1, Some(3)), Some(3));
    }

    #[test]
    fn relative_target_wraps_forward() {
        assert_eq!(relative_target(&[1, 2, 3], Some(3), 1), Some(1));
    }

    #[test]
    fn relative_target_wraps_backward() {
        assert_eq!(relative_target(&[1, 2, 3], Some(1), -1), Some(3));
    }

    #[test]
    fn relative_target_single_tab_stays_put() {
        assert_eq!(relative_target(&[7], Some(7), 1), Some(7));
        assert_eq!(relative_target(&[7], Some(7), -1), Some(7));
    }

    #[test]
    fn relative_target_empty_is_none() {
        assert_eq!(relative_target(&[], None, 1), None);
    }

    fn doc(id: u64, path: &Path) -> OpenDoc {
        OpenDoc { id, path: path.to_path_buf(), title: format!("t{id}"), watcher: None }
    }

    #[test]
    fn find_doc_dedupes_through_symlink_after_canonicalize() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        fs::write(&real, "x").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let canon_real = real.canonicalize().unwrap();
        let docs = vec![doc(1, &canon_real)];
        // 经符号链接打开同一文件：canonicalize 后判重命中
        assert_eq!(find_doc(&docs, &link.canonicalize().unwrap()), Some(1));
    }

    #[test]
    fn id_allocation_is_monotonic_and_unique() {
        let counter = AtomicU64::new(0);
        let a = counter.fetch_add(1, Ordering::SeqCst);
        let b = counter.fetch_add(1, Ordering::SeqCst);
        let c = counter.fetch_add(1, Ordering::SeqCst);
        assert!(a < b && b < c);
    }
}
