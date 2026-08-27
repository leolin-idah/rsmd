//! 文档会话：权威文档列表、active、打开/关闭/聚焦编排。
//! 对宿主（窗口标题、原生菜单、事件推送、最近文件）的依赖全部经 [`Shell`] trait，
//! 由 `shell.rs` 为 `AppHandle` 实现；测试用记录调用的 fake 替代。

use crate::ipc::{DocClosedPayload, DocOpenedPayload, DocRefPayload, DocUpdatedPayload, Event};
use crate::render;
use crate::settings::Settings;
use crate::watcher::{FileEvent, FileEventKind, FileWatcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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

/// 会话对宿主的全部要求。`Clone + 'static` 是因为 watcher 回调要在别的线程持有它。
pub trait Shell: Clone + Send + Sync + 'static {
    fn state(&self) -> &AppState;
    fn emit(&self, event: Event);
    /// 原生窗口标题（Tauri 2 不会把 document.title 镜像到原生标题栏）
    fn set_title(&self, title: &str);
    /// open / close / focus 后重建原生菜单（勾选态与 enable 态）
    fn refresh_menu(&self);
    fn remember_recent(&self, path: &Path);
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
fn find_doc(docs: &[OpenDoc], canon: &Path) -> Option<u64> {
    docs.iter().find(|d| d.path == canon).map(|d| d.id)
}

/// 关闭 `closing` 后应激活谁：关 active 右侧优先、无右侧取左侧、关最后一个为 None；
/// 关非 active 不改变 active。`ids` 为关闭前的列表。
fn next_active(ids: &[u64], closing: u64, active: Option<u64>) -> Option<u64> {
    if active != Some(closing) {
        return active;
    }
    let i = ids.iter().position(|&x| x == closing)?;
    ids.get(i + 1)
        .or_else(|| i.checked_sub(1).and_then(|j| ids.get(j)))
        .copied()
}

/// Next/Prev/⌃Tab 共用的循环取模；空列表为 None。循环逻辑只存在于这一处。
fn relative_target(ids: &[u64], active: Option<u64>, offset: i64) -> Option<u64> {
    if ids.is_empty() {
        return None;
    }
    let len = ids.len() as i64;
    let cur = active
        .and_then(|a| ids.iter().position(|&x| x == a))
        .unwrap_or(0) as i64;
    Some(ids[(cur + offset).rem_euclid(len) as usize])
}

/// 一切 active 变更的统一出口：更新 active、原生标题栏、菜单勾选，
/// emit `document-focus`（前端 setActive 幂等）。doc 不存在则忽略。
pub fn focus_doc<S: Shell>(shell: &S, doc_id: u64) {
    let state = shell.state();
    let title = {
        let docs = state.docs.lock().unwrap();
        docs.iter()
            .find(|d| d.id == doc_id)
            .map(|d| d.title.clone())
    };
    let Some(title) = title else { return };
    *state.active.lock().unwrap() = Some(doc_id);
    shell.set_title(&title);
    shell.refresh_menu();
    shell.emit(Event::DocumentFocus(DocRefPayload { doc_id }));
}

/// watcher 回调（非主线程）：重渲并推送；文件消失只通知，内容保留。
pub fn on_file_event<S: Shell>(shell: &S, ev: FileEvent) {
    let state = shell.state();
    // 锁内只做反查：查不到说明 tab 已关（去抖事件可能晚于关闭落地），忽略
    let doc_id = find_doc(&state.docs.lock().unwrap(), &ev.path);
    let Some(doc_id) = doc_id else { return };
    match ev.kind {
        FileEventKind::Modified => {
            // 瞬态读失败（如写入中途）忽略，下一次事件会补上
            let Ok(r) = load_and_render(&ev.path) else {
                return;
            };
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
            shell.emit(Event::DocumentUpdated(DocUpdatedPayload {
                doc_id,
                html: r.html,
                title: r.title.clone(),
            }));
            // 仅 active doc 同步原生标题栏：后台 tab 热刷新不得改窗口标题
            if *state.active.lock().unwrap() == Some(doc_id) {
                shell.set_title(&r.title);
            }
        }
        FileEventKind::Removed => {
            shell.emit(Event::DocumentRemoved(DocRefPayload { doc_id }));
        }
    }
}

/// open-or-focus：已打开则聚焦已有 tab，否则新开。
/// `activate=false`（批量打开的非首个文档）：新开的追加到列表末尾但不改 active、
/// 不动原生标题；已打开的也不抢焦点。
pub fn open_document<S: Shell>(shell: &S, path: PathBuf, activate: bool) -> Result<(), String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Cannot open: {e}"))?;
    let state = shell.state();

    // 第一重检查：判重与插入必须同临界区（见下方第二重检查），读文件/render 不持锁
    let existing = find_doc(&state.docs.lock().unwrap(), &path);
    if let Some(id) = existing {
        if activate {
            focus_doc(shell, id);
        }
        return Ok(());
    }

    let rendered = load_and_render(&path)?;
    let watcher_shell = shell.clone();
    let (watcher, watch_failed) =
        match FileWatcher::watch(&path, move |ev| on_file_event(&watcher_shell, ev)) {
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
                focus_doc(shell, id);
            }
            return Ok(());
        }
        Ok(id) => id,
    };

    if activate {
        *state.active.lock().unwrap() = Some(doc_id);
        shell.set_title(&rendered.title);
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    shell.emit(Event::DocumentOpened(DocOpenedPayload {
        doc_id,
        path: path.to_string_lossy().into_owned(),
        file_name,
        html: rendered.html,
        title: rendered.title,
        base_dir: rendered.base_dir,
        activate,
    }));
    if watch_failed {
        shell.emit(Event::WatchUnavailable(DocRefPayload { doc_id }));
    }

    shell.remember_recent(&path);
    shell.refresh_menu();
    Ok(())
}

/// 单个打开（菜单 Recent 等）并设为 active；失败时通过 `open-error` 事件上报前端。
pub fn open_or_report<S: Shell>(shell: &S, path: PathBuf) {
    if let Err(e) = open_document(shell, path, true) {
        shell.emit(Event::OpenError(e));
    }
}

/// 批量打开（CLI 多参数、Finder 多选、⌘O 多选、拖放多文件）：
/// 按给定顺序追加，**首个成功打开的**（含聚焦已存在 tab）设为 active，其余后台待命。
/// 以"首个成功"而非"首个路径"为准：首个文件打不开时由下一个补位，
/// 避免出现有 tab 却无 active 的空白态。单个失败经 `open-error` 上报，不中断其余。
pub fn open_batch<S: Shell>(shell: &S, paths: Vec<PathBuf>) {
    let mut activated = false;
    for p in paths {
        match open_document(shell, p, !activated) {
            Ok(()) => activated = true,
            Err(e) => shell.emit(Event::OpenError(e)),
        }
    }
}

/// 前端就绪前到达的路径先暂存，就绪后由 [`frontend_ready`] 一并打开。
pub fn pending_or_open<S: Shell>(shell: &S, paths: Vec<PathBuf>) {
    let state = shell.state();
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
        open_batch(shell, ps);
    }
}

/// 前端监听器全部注册完毕的握手：置位 ready 并打开启动时暂存的路径。
pub fn frontend_ready<S: Shell>(shell: &S) {
    let state = shell.state();
    // ready 置位与 initial 排空在同一 `initial` 临界区内完成（与 pending_or_open 串行化），
    // 打开动作在锁释放后执行。
    let initial = {
        let mut guard = state.initial.lock().unwrap();
        state.ready.store(true, Ordering::SeqCst);
        std::mem::take(&mut *guard)
    };
    // 启动路径打开失败也要经 open-error 事件上报（前端弹横幅），而不是吞进 invoke 错误
    open_batch(shell, initial);
}

/// 相对 .md 链接：以链接所在 doc 的 parent 解析，而非全局 current。
pub fn open_relative<S: Shell>(shell: &S, doc_id: u64, href: String) -> Result<(), String> {
    let base = {
        let docs = shell.state().docs.lock().unwrap();
        docs.iter()
            .find(|d| d.id == doc_id)
            .and_then(|d| d.path.parent().map(Path::to_path_buf))
    }
    .ok_or_else(|| "Source document is no longer open".to_string())?;
    open_document(shell, base.join(href), true)
}

/// 菜单 ⌘W 入口：关闭当前 active tab。
pub fn close_active<S: Shell>(shell: &S) {
    let active = *shell.state().active.lock().unwrap();
    if let Some(id) = active {
        close_doc(shell, id);
    }
}

/// 菜单 Next/Prev 与 ⌃Tab 共用入口。
pub fn cycle<S: Shell>(shell: &S, offset: i64) {
    let state = shell.state();
    let ids: Vec<u64> = state.docs.lock().unwrap().iter().map(|d| d.id).collect();
    let active = *state.active.lock().unwrap();
    if let Some(target) = relative_target(&ids, active, offset) {
        focus_doc(shell, target);
    }
}

/// 移除 doc，计算 nextActive，emit `document-closed`，重建菜单。已关闭则忽略。
pub fn close_doc<S: Shell>(shell: &S, doc_id: u64) {
    let state = shell.state();
    // 唯一的锁嵌套点，固定锁序 docs → active
    let next = {
        let mut docs = state.docs.lock().unwrap();
        let ids: Vec<u64> = docs.iter().map(|d| d.id).collect();
        if !ids.contains(&doc_id) {
            return; // 已关闭（重复 ⌘W / 竞态）
        }
        let next = next_active(&ids, doc_id, *state.active.lock().unwrap());
        docs.retain(|d| d.id != doc_id); // FileWatcher 随 OpenDoc Drop 自动停监听
        *state.active.lock().unwrap() = next;
        next
    };
    let title = next.and_then(|id| {
        state
            .docs
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.title.clone())
    });
    shell.set_title(title.as_deref().unwrap_or("rsmd"));
    shell.refresh_menu();
    shell.emit(Event::DocumentClosed(DocClosedPayload {
        doc_id,
        next_active: next,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::Event;
    use crate::watcher::{FileEvent, FileEventKind};
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    /// 记录一切宿主副作用的 fake：断言"编排层对宿主说了什么"。
    #[derive(Clone, Default)]
    struct Fake {
        state: Arc<AppState>,
        events: Arc<Mutex<Vec<Event>>>,
        titles: Arc<Mutex<Vec<String>>>,
        menu_refreshes: Arc<AtomicUsize>,
        recents: Arc<Mutex<Vec<PathBuf>>>,
    }

    impl Shell for Fake {
        fn state(&self) -> &AppState {
            &self.state
        }
        fn emit(&self, event: Event) {
            self.events.lock().unwrap().push(event);
        }
        fn set_title(&self, title: &str) {
            self.titles.lock().unwrap().push(title.to_string());
        }
        fn refresh_menu(&self) {
            self.menu_refreshes.fetch_add(1, Ordering::SeqCst);
        }
        fn remember_recent(&self, path: &Path) {
            self.recents.lock().unwrap().push(path.to_path_buf());
        }
    }

    impl Fake {
        fn events(&self) -> Vec<Event> {
            self.events.lock().unwrap().clone()
        }
        fn titles(&self) -> Vec<String> {
            self.titles.lock().unwrap().clone()
        }
        fn ids(&self) -> Vec<u64> {
            self.state
                .docs
                .lock()
                .unwrap()
                .iter()
                .map(|d| d.id)
                .collect()
        }
        fn active(&self) -> Option<u64> {
            *self.state.active.lock().unwrap()
        }
        fn title_of(&self, id: u64) -> String {
            self.state
                .docs
                .lock()
                .unwrap()
                .iter()
                .find(|d| d.id == id)
                .unwrap()
                .title
                .clone()
        }
        /// 直接塞一个已打开的 doc（不起 watcher），供文件事件测试确定性使用
        fn push_doc(&self, id: u64, path: &Path, title: &str) {
            self.state.docs.lock().unwrap().push(OpenDoc {
                id,
                path: path.to_path_buf(),
                title: title.to_string(),
                watcher: None,
            });
        }
    }

    fn md(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    fn opened(ev: &Event) -> Option<&DocOpenedPayload> {
        match ev {
            Event::DocumentOpened(p) => Some(p),
            _ => None,
        }
    }

    // ---- open ----

    #[test]
    fn open_activates_announces_and_records_recent() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();

        open_document(&sh, a.clone(), true).unwrap();

        let id = sh.ids()[0];
        assert_eq!(sh.active(), Some(id));
        let evs = sh.events();
        let p = opened(&evs[0]).expect("first event is document-opened");
        assert_eq!(p.doc_id, id);
        assert!(p.activate);
        assert_eq!(p.title, "A");
        assert_eq!(p.path, a.canonicalize().unwrap().to_string_lossy());
        assert_eq!(sh.titles(), vec!["A"]);
        assert_eq!(sh.menu_refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            sh.recents.lock().unwrap().as_slice(),
            &[a.canonicalize().unwrap()]
        );
    }

    #[test]
    fn reopening_focuses_the_existing_doc_without_duplicating() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a.clone(), true).unwrap();
        let id = sh.ids()[0];

        open_document(&sh, a, true).unwrap();

        assert_eq!(sh.ids(), vec![id]);
        assert_eq!(
            sh.events().last(),
            Some(&Event::DocumentFocus(DocRefPayload { doc_id: id }))
        );
        assert_eq!(sh.recents.lock().unwrap().len(), 1);
    }

    #[test]
    fn background_open_appends_without_stealing_focus_or_title() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let b = md(dir.path(), "b.md", "# B");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id_a = sh.ids()[0];

        open_document(&sh, b, false).unwrap();

        assert_eq!(sh.ids().len(), 2);
        assert_eq!(sh.active(), Some(id_a));
        assert_eq!(sh.titles(), vec!["A"]); // 后台打开不动原生标题
        let evs = sh.events();
        assert!(!opened(evs.last().unwrap()).unwrap().activate);
    }

    #[test]
    fn opening_a_missing_file_is_an_error_and_leaves_no_trace() {
        let sh = Fake::default();
        let err = open_document(&sh, PathBuf::from("/no/such.md"), true).unwrap_err();
        assert!(err.starts_with("Cannot open"), "{err}");
        assert!(sh.ids().is_empty());
        assert!(sh.events().is_empty());
        assert!(sh.titles().is_empty());
    }

    #[test]
    fn open_batch_makes_the_first_success_active_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let b = md(dir.path(), "b.md", "# B");
        let sh = Fake::default();

        open_batch(&sh, vec![dir.path().join("missing.md"), a, b]);

        let evs = sh.events();
        assert!(matches!(evs[0], Event::OpenError(_)));
        let flags: Vec<bool> = evs.iter().filter_map(opened).map(|p| p.activate).collect();
        assert_eq!(flags, vec![true, false]); // 首个成功的为 active，而非首个路径
        assert_eq!(sh.active(), Some(sh.ids()[0]));
    }

    #[test]
    fn open_relative_resolves_against_the_source_docs_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let a = md(dir.path(), "a.md", "# A");
        md(&dir.path().join("sub"), "b.md", "# B");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id_a = sh.ids()[0];

        open_relative(&sh, id_a, "sub/b.md".into()).unwrap();
        assert_eq!(sh.ids().len(), 2);
        assert_eq!(sh.title_of(sh.ids()[1]), "B");

        let err = open_relative(&sh, 99, "x.md".into()).unwrap_err();
        assert!(err.contains("no longer open"), "{err}");
    }

    // ---- frontend_ready 握手 ----

    #[test]
    fn paths_arriving_before_frontend_ready_are_queued_then_opened() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();

        pending_or_open(&sh, vec![a]);
        assert!(sh.events().is_empty());
        assert_eq!(sh.state.initial.lock().unwrap().len(), 1);

        frontend_ready(&sh);
        assert!(sh.state.ready.load(Ordering::SeqCst));
        assert!(sh.state.initial.lock().unwrap().is_empty());
        assert!(opened(&sh.events()[0]).unwrap().activate);
    }

    #[test]
    fn paths_arriving_after_frontend_ready_open_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        frontend_ready(&sh);

        pending_or_open(&sh, vec![a]);
        assert_eq!(sh.ids().len(), 1);
    }

    // ---- focus / cycle / close ----

    fn three_docs(sh: &Fake, dir: &Path) -> Vec<u64> {
        for (n, t) in [("a.md", "# A"), ("b.md", "# B"), ("c.md", "# C")] {
            open_document(sh, md(dir, n, t), true).unwrap();
        }
        sh.ids()
    }

    #[test]
    fn focus_doc_updates_active_title_menu_and_echoes() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let ids = three_docs(&sh, dir.path());
        let before = sh.menu_refreshes.load(Ordering::SeqCst);

        focus_doc(&sh, ids[0]);

        assert_eq!(sh.active(), Some(ids[0]));
        assert_eq!(sh.titles().last().unwrap(), "A");
        assert_eq!(sh.menu_refreshes.load(Ordering::SeqCst), before + 1);
        assert_eq!(
            sh.events().last(),
            Some(&Event::DocumentFocus(DocRefPayload { doc_id: ids[0] }))
        );
    }

    #[test]
    fn focus_on_unknown_doc_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let ids = three_docs(&sh, dir.path());
        let n = sh.events().len();
        focus_doc(&sh, 99);
        assert_eq!(sh.active(), Some(ids[2]));
        assert_eq!(sh.events().len(), n);
    }

    #[test]
    fn cycle_wraps_around_in_both_directions() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let ids = three_docs(&sh, dir.path()); // active = c
        cycle(&sh, 1);
        assert_eq!(sh.active(), Some(ids[0]));
        cycle(&sh, -1);
        assert_eq!(sh.active(), Some(ids[2]));
    }

    #[test]
    fn closing_the_active_doc_moves_to_its_right_neighbour() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let ids = three_docs(&sh, dir.path());
        focus_doc(&sh, ids[0]);

        close_doc(&sh, ids[0]);

        assert_eq!(sh.ids(), vec![ids[1], ids[2]]);
        assert_eq!(sh.active(), Some(ids[1]));
        assert_eq!(sh.titles().last().unwrap(), "B");
        assert_eq!(
            sh.events().last(),
            Some(&Event::DocumentClosed(DocClosedPayload {
                doc_id: ids[0],
                next_active: Some(ids[1])
            }))
        );
    }

    #[test]
    fn closing_the_last_doc_resets_the_title() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id = sh.ids()[0];

        close_active(&sh);

        assert!(sh.ids().is_empty());
        assert_eq!(sh.active(), None);
        assert_eq!(sh.titles().last().unwrap(), "rsmd");
        assert_eq!(
            sh.events().last(),
            Some(&Event::DocumentClosed(DocClosedPayload {
                doc_id: id,
                next_active: None
            }))
        );
    }

    #[test]
    fn closing_an_unknown_doc_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        three_docs(&sh, dir.path());
        let n = sh.events().len();
        close_doc(&sh, 99);
        assert_eq!(sh.events().len(), n);
        assert_eq!(sh.ids().len(), 3);
    }

    // ---- 文件事件 ----

    #[test]
    fn modified_file_rerenders_and_retitles_the_native_window_only_when_active() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let b = md(dir.path(), "b.md", "# B");
        let sh = Fake::default();
        sh.push_doc(1, &a, "A");
        sh.push_doc(2, &b, "B");
        *sh.state.active.lock().unwrap() = Some(1);

        fs::write(&b, "# B2").unwrap();
        on_file_event(
            &sh,
            FileEvent {
                path: b.clone(),
                kind: FileEventKind::Modified,
            },
        );
        assert_eq!(sh.title_of(2), "B2");
        assert!(sh.titles().is_empty()); // 后台 doc 不动原生标题
        assert!(matches!(
            sh.events().last(),
            Some(Event::DocumentUpdated(DocUpdatedPayload { doc_id: 2, title, .. })) if title == "B2"
        ));

        fs::write(&a, "# A2").unwrap();
        on_file_event(
            &sh,
            FileEvent {
                path: a,
                kind: FileEventKind::Modified,
            },
        );
        assert_eq!(sh.titles(), vec!["A2"]);
    }

    #[test]
    fn removed_file_emits_document_removed() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        sh.push_doc(1, &a, "A");
        on_file_event(
            &sh,
            FileEvent {
                path: a,
                kind: FileEventKind::Removed,
            },
        );
        assert_eq!(
            sh.events(),
            vec![Event::DocumentRemoved(DocRefPayload { doc_id: 1 })]
        );
    }

    #[test]
    fn file_events_for_closed_docs_are_ignored() {
        let sh = Fake::default();
        on_file_event(
            &sh,
            FileEvent {
                path: PathBuf::from("/gone.md"),
                kind: FileEventKind::Modified,
            },
        );
        assert!(sh.events().is_empty());
    }

    // ---- 纯函数 ----

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
        assert!(load_and_render(Path::new("/no/such.md")).is_err());
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

    #[test]
    fn find_doc_dedupes_through_symlink_after_canonicalize() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        fs::write(&real, "x").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let canon_real = real.canonicalize().unwrap();
        let docs = vec![OpenDoc {
            id: 1,
            path: canon_real,
            title: "t1".into(),
            watcher: None,
        }];
        // 经符号链接打开同一文件：canonicalize 后判重命中
        assert_eq!(find_doc(&docs, &link.canonicalize().unwrap()), Some(1));
    }
}
