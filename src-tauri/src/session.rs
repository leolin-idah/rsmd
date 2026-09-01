//! 文档会话：权威文档列表、active、打开/关闭/聚焦编排。
//! 对宿主（窗口标题、原生菜单、事件推送、最近文件）的依赖全部经 [`Shell`] trait，
//! 由 `shell.rs` 为 `AppHandle` 实现；测试用记录调用的 fake 替代。

use crate::ipc::{
    DocClosedPayload, DocMode, DocOpenedPayload, DocRefPayload, DocUpdatedPayload, Event,
    ModeMenuPayload, RenderPayload, SaveRequestedPayload,
};
use crate::render::{self, BlockRange};
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
    /// 最近一次"看到的磁盘内容"的 hash：打开 / 外部改动 / 自己保存后更新。
    /// watcher 事件读到的内容 hash 与之相等 = 自己保存的回声，不算外部改动。
    pub disk_hash: u64,
    /// 前端编辑器有未保存改动（前端经 set_doc_state 同步）；驱动标题 ●、Save 菜单、关闭/退出守卫
    pub dirty: bool,
    /// 前端展示模式（模式菜单的勾选态）
    pub mode: DocMode,
}

pub fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseChoice {
    Save,
    Discard,
    Cancel,
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
    /// 关闭脏文档前的原生确认框（Save / Don't Save / Cancel）；用户选择后回调，可能在别的线程。
    fn confirm_close(&self, title: &str, on_choice: Box<dyn FnOnce(CloseChoice) + Send + 'static>);
    /// 退出前的原生确认框，只提供"丢弃并退出 / 取消"；仅丢弃时回调。
    fn confirm_quit(&self, dirty_count: usize, on_discard: Box<dyn FnOnce() + Send + 'static>);
    fn quit(&self);
}

fn mark_clean(state: &AppState, doc_id: u64) {
    if let Some(d) = state.docs.lock().unwrap().iter_mut().find(|d| d.id == doc_id) {
        d.dirty = false;
    }
}

pub fn any_dirty<S: Shell>(shell: &S) -> bool {
    shell.state().docs.lock().unwrap().iter().any(|d| d.dirty)
}

/// 退出守卫：有脏文档则拦截并弹框，返回 true；用户选丢弃 → 全部标记干净后 quit
/// （quit 会再次触发 ExitRequested，此时 any_dirty 为 false 放行）。
pub fn request_quit<S: Shell>(shell: &S) -> bool {
    let n = shell.state().docs.lock().unwrap().iter().filter(|d| d.dirty).count();
    if n == 0 {
        return false;
    }
    let sh = shell.clone();
    shell.confirm_quit(
        n,
        Box::new(move || {
            for d in sh.state().docs.lock().unwrap().iter_mut() {
                d.dirty = false;
            }
            sh.quit();
        }),
    );
    true
}

struct RenderedDoc {
    text: String,
    html: String,
    blocks: Vec<BlockRange>,
    title: String,
    base_dir: String,
    hash: u64,
}

/// 首个 H1，否则文件名 stem，再否则 "rsmd"（与 V1 行为一致）。
fn doc_title(path: &Path, first_heading: Option<String>) -> String {
    first_heading.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "rsmd".into())
    })
}

fn load_and_render(path: &Path) -> Result<RenderedDoc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    let hash = content_hash(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let base_dir = path
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?;
    let result = render::render(&text, base_dir);
    Ok(RenderedDoc {
        title: doc_title(path, result.first_heading),
        text,
        html: result.html,
        blocks: result.blocks,
        base_dir: base_dir.to_string_lossy().into_owned(),
        hash,
    })
}

/// 原生标题：脏文档前缀 ●（Tauri 未暴露 NSWindow.documentEdited，用标题前缀代替）。
fn window_title(title: &str, dirty: bool) -> String {
    if dirty {
        format!("● {title}")
    } else {
        title.to_string()
    }
}

/// 一切原生标题变更的唯一出口：按 active doc 的 title/dirty 重算；无 active 为 "rsmd"。
/// 先取 active（立即释放）再取 docs，不嵌套持锁。
fn sync_title<S: Shell>(shell: &S) {
    let state = shell.state();
    let active = *state.active.lock().unwrap();
    let title = active.and_then(|id| {
        state
            .docs
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id == id)
            .map(|d| window_title(&d.title, d.dirty))
    });
    shell.set_title(title.as_deref().unwrap_or("rsmd"));
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
    let exists = state.docs.lock().unwrap().iter().any(|d| d.id == doc_id);
    if !exists {
        return;
    }
    *state.active.lock().unwrap() = Some(doc_id);
    sync_title(shell);
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
            let Ok(r) = load_and_render(&ev.path) else { return };
            // render 期间 doc 可能已被关闭：存在性检查、title 更新、回声判定同临界区
            let external = {
                let mut docs = state.docs.lock().unwrap();
                let Some(d) = docs.iter_mut().find(|d| d.id == doc_id) else {
                    return;
                };
                let external = d.disk_hash != r.hash;
                d.disk_hash = r.hash; // 磁盘上现在就是这份内容：之后的事件以它为基线
                d.title = r.title.clone();
                external
            };
            shell.emit(Event::DocumentUpdated(DocUpdatedPayload {
                doc_id,
                text: r.text,
                html: r.html,
                blocks: r.blocks,
                title: r.title,
                external,
            }));
            // 仅 active doc 同步原生标题栏：后台 tab 热刷新不得改窗口标题
            if *state.active.lock().unwrap() == Some(doc_id) {
                sync_title(shell);
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
                    disk_hash: rendered.hash,
                    dirty: false,
                    mode: DocMode::Preview,
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
        sync_title(shell);
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    shell.emit(Event::DocumentOpened(DocOpenedPayload {
        doc_id,
        path: path.to_string_lossy().into_owned(),
        file_name,
        text: rendered.text,
        html: rendered.html,
        blocks: rendered.blocks,
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
    let dirty_title = state
        .docs
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id == doc_id && d.dirty)
        .map(|d| d.title.clone());
    if let Some(title) = dirty_title {
        // 脏文档：交给用户决定。Save 由前端保存后再次调用 close_doc（那时已不脏）完成关闭
        let sh = shell.clone();
        shell.confirm_close(
            &title,
            Box::new(move |choice| match choice {
                CloseChoice::Save => sh.emit(Event::SaveRequested(SaveRequestedPayload {
                    doc_id,
                    close_after: true,
                })),
                CloseChoice::Discard => {
                    mark_clean(sh.state(), doc_id);
                    close_doc(&sh, doc_id);
                }
                CloseChoice::Cancel => {}
            }),
        );
        return;
    }
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
    sync_title(shell);
    shell.refresh_menu();
    shell.emit(Event::DocumentClosed(DocClosedPayload {
        doc_id,
        next_active: next,
    }));
}

fn path_of(state: &AppState, doc_id: u64) -> Result<PathBuf, String> {
    state
        .docs
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id == doc_id)
        .map(|d| d.path.clone())
        .ok_or_else(|| "Document is no longer open".to_string())
}

/// 编辑中的按需渲染：用文档目录解析相对图片路径；顺带更新 title（active 时同步原生标题）。
pub fn render_markdown<S: Shell>(
    shell: &S,
    doc_id: u64,
    text: &str,
) -> Result<RenderPayload, String> {
    let state = shell.state();
    let path = path_of(state, doc_id)?;
    let base_dir = path
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?;
    let result = render::render(text, base_dir);
    let title = doc_title(&path, result.first_heading);
    if let Some(d) = state.docs.lock().unwrap().iter_mut().find(|d| d.id == doc_id) {
        d.title = title.clone();
    }
    if *state.active.lock().unwrap() == Some(doc_id) {
        sync_title(shell);
    }
    Ok(RenderPayload {
        html: result.html,
        blocks: result.blocks,
        title,
    })
}

/// 原地写而非临时文件 + rename：保留 inode / 权限 / xattr；路径已 canonicalize，不会覆盖符号链接本身。
/// 写入期间 watcher 可能收到事件，但 200ms 防抖后再读时写已完成，hash 判定为回声。
pub fn save_doc<S: Shell>(shell: &S, doc_id: u64, text: &str) -> Result<(), String> {
    let state = shell.state();
    let path = path_of(state, doc_id)?;
    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("Failed to save: {e}"))?;
    let hash = content_hash(text.as_bytes());
    if let Some(d) = state.docs.lock().unwrap().iter_mut().find(|d| d.id == doc_id) {
        d.disk_hash = hash;
        d.dirty = false;
    }
    sync_title(shell);
    shell.refresh_menu();
    Ok(())
}

/// 前端在 mode / dirty 变化时回写；驱动标题 ●、模式菜单勾选、Save enable。
pub fn set_doc_state<S: Shell>(shell: &S, doc_id: u64, mode: DocMode, dirty: bool) {
    let state = shell.state();
    let found = {
        let mut docs = state.docs.lock().unwrap();
        match docs.iter_mut().find(|d| d.id == doc_id) {
            Some(d) => {
                d.mode = mode;
                d.dirty = dirty;
                true
            }
            None => false,
        }
    };
    if !found {
        return;
    }
    sync_title(shell);
    shell.refresh_menu();
}

/// 模式菜单（Preview / Live ⌘E / Source ⌘/）：模式归前端，Rust 只把被点的项转发给 active doc。
pub fn request_mode<S: Shell>(shell: &S, item: DocMode) {
    let active = *shell.state().active.lock().unwrap();
    if let Some(doc_id) = active {
        shell.emit(Event::ModeMenu(ModeMenuPayload { doc_id, item }));
    }
}

/// 菜单 Save（⌘S）：让前端把编辑器文本交回 save_doc。
pub fn request_save<S: Shell>(shell: &S) {
    let active = *shell.state().active.lock().unwrap();
    if let Some(doc_id) = active {
        shell.emit(Event::SaveRequested(SaveRequestedPayload { doc_id, close_after: false }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::Event;
    use crate::watcher::{FileEvent, FileEventKind};
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    /// 待应答的关闭确认框：测试手动调用 `answer` 模拟用户选择。
    struct ClosePrompt {
        title: String,
        answer: Box<dyn FnOnce(CloseChoice) + Send>,
    }

    /// 待应答的退出确认框：只有"丢弃并退出"会回调。
    struct QuitPrompt {
        count: usize,
        on_discard: Box<dyn FnOnce() + Send>,
    }

    /// 记录一切宿主副作用的 fake：断言"编排层对宿主说了什么"。
    #[derive(Clone, Default)]
    struct Fake {
        state: Arc<AppState>,
        events: Arc<Mutex<Vec<Event>>>,
        titles: Arc<Mutex<Vec<String>>>,
        menu_refreshes: Arc<AtomicUsize>,
        recents: Arc<Mutex<Vec<PathBuf>>>,
        close_prompts: Arc<Mutex<Vec<ClosePrompt>>>,
        quit_prompts: Arc<Mutex<Vec<QuitPrompt>>>,
        quits: Arc<AtomicUsize>,
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
        fn confirm_close(
            &self,
            title: &str,
            on_choice: Box<dyn FnOnce(CloseChoice) + Send + 'static>,
        ) {
            self.close_prompts.lock().unwrap().push(ClosePrompt {
                title: title.to_string(),
                answer: on_choice,
            });
        }
        fn confirm_quit(&self, dirty_count: usize, on_discard: Box<dyn FnOnce() + Send + 'static>) {
            self.quit_prompts.lock().unwrap().push(QuitPrompt {
                count: dirty_count,
                on_discard,
            });
        }
        fn quit(&self) {
            self.quits.fetch_add(1, Ordering::SeqCst);
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
        fn take_close_prompt(&self) -> Option<ClosePrompt> {
            self.close_prompts.lock().unwrap().pop()
        }
        fn take_quit_prompt(&self) -> Option<QuitPrompt> {
            self.quit_prompts.lock().unwrap().pop()
        }
        /// 直接塞一个已打开的 doc（不起 watcher），供文件事件测试确定性使用
        fn push_doc(&self, id: u64, path: &Path, title: &str, disk_hash: u64) {
            self.state.docs.lock().unwrap().push(OpenDoc {
                id,
                path: path.to_path_buf(),
                title: title.to_string(),
                watcher: None,
                disk_hash,
                dirty: false,
                mode: DocMode::Preview,
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
        sh.push_doc(1, &a, "A", 0);
        sh.push_doc(2, &b, "B", 0);
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
        sh.push_doc(1, &a, "A", 0);
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
            disk_hash: 0,
            dirty: false,
            mode: DocMode::Preview,
        }];
        // 经符号链接打开同一文件：canonicalize 后判重命中
        assert_eq!(find_doc(&docs, &link.canonicalize().unwrap()), Some(1));
    }

    // ---- 载荷源码 / 块范围 / 回声判定 / 脏标记（Task 2）----

    #[test]
    fn own_save_echo_is_not_external() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A\n\nbody");
        let sh = Fake::default();
        // disk_hash 与文件内容一致 = 我们自己刚写进去的
        sh.push_doc(1, &a.canonicalize().unwrap(), "A", content_hash(b"# A\n\nbody"));

        on_file_event(
            &sh,
            FileEvent {
                path: a.canonicalize().unwrap(),
                kind: FileEventKind::Modified,
            },
        );

        let evs = sh.events();
        let Event::DocumentUpdated(p) = &evs[0] else {
            panic!("expected document-updated")
        };
        assert!(!p.external);
        assert_eq!(p.text, "# A\n\nbody");
        assert_eq!(p.blocks.len(), 2);
    }

    #[test]
    fn external_change_is_flagged_and_becomes_the_new_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A\n\nchanged outside");
        let canon = a.canonicalize().unwrap();
        let sh = Fake::default();
        sh.push_doc(1, &canon, "A", content_hash(b"# A\n\nold"));

        on_file_event(
            &sh,
            FileEvent {
                path: canon.clone(),
                kind: FileEventKind::Modified,
            },
        );
        let Event::DocumentUpdated(p) = &sh.events()[0] else {
            panic!()
        };
        assert!(p.external);

        // 同一内容再来一次事件（编辑器二次 touch）：磁盘现值已是基线，不再算外部改动
        on_file_event(
            &sh,
            FileEvent {
                path: canon,
                kind: FileEventKind::Modified,
            },
        );
        let Event::DocumentUpdated(p2) = &sh.events()[1] else {
            panic!()
        };
        assert!(!p2.external);
    }

    #[test]
    fn opened_payload_carries_text_and_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A\n\nbody");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let evs = sh.events();
        let p = opened(&evs[0]).unwrap();
        assert_eq!(p.text, "# A\n\nbody");
        assert_eq!(p.blocks.iter().map(|b| b.from).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(
            sh.state.docs.lock().unwrap()[0].disk_hash,
            content_hash(b"# A\n\nbody")
        );
    }

    #[test]
    fn dirty_doc_shows_a_marker_in_the_window_title() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id = sh.ids()[0];
        sh.state.docs.lock().unwrap()[0].dirty = true;
        focus_doc(&sh, id);
        assert_eq!(sh.titles().last().unwrap(), "● A");
    }

    // ---- render_markdown / save_doc / set_doc_state（Task 3）----

    #[test]
    fn save_doc_writes_the_file_clears_dirty_and_updates_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a.clone(), true).unwrap();
        let id = sh.ids()[0];
        set_doc_state(&sh, id, DocMode::Live, true);
        assert_eq!(sh.titles().last().unwrap(), "● A");

        save_doc(&sh, id, "# A\n\nsaved").unwrap();

        assert_eq!(fs::read_to_string(&a).unwrap(), "# A\n\nsaved");
        {
            let docs = sh.state.docs.lock().unwrap();
            assert!(!docs[0].dirty);
            assert_eq!(docs[0].disk_hash, content_hash(b"# A\n\nsaved"));
        }
        assert_eq!(sh.titles().last().unwrap(), "A");
    }

    #[test]
    fn save_doc_for_unknown_doc_is_an_error() {
        let sh = Fake::default();
        assert!(save_doc(&sh, 42, "x").is_err());
    }

    #[test]
    fn render_markdown_rerenders_and_retitles_the_active_doc() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id = sh.ids()[0];

        let p = render_markdown(&sh, id, "# Renamed\n\n![](img.png)").unwrap();

        assert_eq!(p.title, "Renamed");
        assert_eq!(p.blocks.len(), 2);
        assert!(p.html.contains("img.png")); // 相对图片路径按该文档目录改写
        assert_eq!(sh.title_of(id), "Renamed");
        assert_eq!(sh.titles().last().unwrap(), "Renamed");
        assert!(render_markdown(&sh, 99, "x").is_err());
    }

    #[test]
    fn set_doc_state_refreshes_menu_and_title() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        let id = sh.ids()[0];
        assert_eq!(sh.state.docs.lock().unwrap()[0].mode, DocMode::Preview); // 新开文档默认 preview
        let before = sh.menu_refreshes.load(Ordering::SeqCst);

        set_doc_state(&sh, id, DocMode::Source, false);

        assert_eq!(sh.menu_refreshes.load(Ordering::SeqCst), before + 1);
        let docs = sh.state.docs.lock().unwrap();
        assert_eq!(docs[0].mode, DocMode::Source);
        assert!(!docs[0].dirty);
    }

    // ---- 脏文档关闭 / 退出守卫（Task 4）----

    fn open_dirty(sh: &Fake, dir: &Path, name: &str) -> u64 {
        let p = md(dir, name, "# A");
        open_document(sh, p, true).unwrap();
        let id = *sh.ids().last().unwrap();
        set_doc_state(sh, id, DocMode::Live, true);
        id
    }

    #[test]
    fn closing_a_dirty_doc_prompts_and_cancel_keeps_it_open() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let id = open_dirty(&sh, dir.path(), "a.md");

        close_doc(&sh, id);

        assert_eq!(sh.ids(), vec![id]); // 未关闭，等用户选择
        let prompt = sh.take_close_prompt().expect("prompted");
        assert_eq!(prompt.title, "A");
        (prompt.answer)(CloseChoice::Cancel);
        assert_eq!(sh.ids(), vec![id]);
        assert!(!sh.events().iter().any(|e| matches!(e, Event::DocumentClosed(_))));
    }

    #[test]
    fn choosing_save_requests_a_save_that_closes_afterwards() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let id = open_dirty(&sh, dir.path(), "a.md");
        close_doc(&sh, id);
        (sh.take_close_prompt().unwrap().answer)(CloseChoice::Save);
        assert_eq!(
            sh.events().last(),
            Some(&Event::SaveRequested(SaveRequestedPayload {
                doc_id: id,
                close_after: true
            }))
        );
        assert_eq!(sh.ids(), vec![id]); // 关闭由前端保存后再次调用 close_doc 完成
    }

    #[test]
    fn choosing_discard_closes_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        let id = open_dirty(&sh, dir.path(), "a.md");
        close_doc(&sh, id);
        (sh.take_close_prompt().unwrap().answer)(CloseChoice::Discard);
        assert!(sh.ids().is_empty());
        assert!(matches!(sh.events().last(), Some(Event::DocumentClosed(_))));
    }

    #[test]
    fn a_clean_doc_closes_without_prompting() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        close_doc(&sh, sh.ids()[0]);
        assert!(sh.ids().is_empty());
        assert!(sh.take_close_prompt().is_none());
    }

    #[test]
    fn request_quit_prompts_when_dirty_and_discard_quits() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Fake::default();
        open_dirty(&sh, dir.path(), "a.md");
        let b = md(dir.path(), "b.md", "# B");
        open_document(&sh, b, false).unwrap();

        assert!(request_quit(&sh));
        let prompt = sh.take_quit_prompt().expect("prompted");
        assert_eq!(prompt.count, 1);
        assert_eq!(sh.quits.load(Ordering::SeqCst), 0);

        (prompt.on_discard)();
        assert!(!any_dirty(&sh));
        assert_eq!(sh.quits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn request_quit_without_dirty_docs_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        assert!(!request_quit(&sh));
        assert!(sh.take_quit_prompt().is_none());
    }

    // ---- 菜单转发（Task 5）----

    #[test]
    fn mode_and_save_menus_target_the_active_doc() {
        let dir = tempfile::tempdir().unwrap();
        let a = md(dir.path(), "a.md", "# A");
        let b = md(dir.path(), "b.md", "# B");
        let sh = Fake::default();
        open_document(&sh, a, true).unwrap();
        open_document(&sh, b, true).unwrap();
        let id_b = sh.ids()[1];

        request_mode(&sh, DocMode::Source);
        assert_eq!(
            sh.events().last(),
            Some(&Event::ModeMenu(ModeMenuPayload {
                doc_id: id_b,
                item: DocMode::Source
            }))
        );

        request_save(&sh);
        assert_eq!(
            sh.events().last(),
            Some(&Event::SaveRequested(SaveRequestedPayload {
                doc_id: id_b,
                close_after: false
            }))
        );
    }

    #[test]
    fn mode_and_save_menus_without_docs_are_noops() {
        let sh = Fake::default();
        request_mode(&sh, DocMode::Live);
        request_save(&sh);
        assert!(sh.events().is_empty());
    }
}
