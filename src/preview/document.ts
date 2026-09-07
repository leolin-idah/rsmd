import * as ipc from "../ipc";
import type { DocId, DocMode, DocOpenedPayload, DocUpdatedPayload } from "../ipc";
import { createEditor, type EditorHandle } from "../editor/mdEditor";
import { installOutlineSpy, refreshOutline, syncOutline } from "../editor/outline";
import type { TocEntry } from "./toc";
import { useShellStore } from "../store";
import { followLink } from "./links";

// 文档生命周期的唯一入口：open / update / close / setDocMode / save / reload 同时维护 pane、编辑器与 store。
// "哪个文档是 active" 只存在于 store；本模块订阅它并投影到 pane 的显隐上。
// 编辑器创建是异步的（Milkdown.create）：创建期间的更新 / 模式切换先记账，完成后补应用。

interface DocEntry {
  pane: HTMLElement;
  editor: EditorHandle | null;    // null = 尚未物化（后台打开 / 正在创建）
  creating: Promise<void> | null; // 创建中的 promise
  pending: string | null;         // 未物化期间的最新文本
  baseDir: string;
  title: string;
  fileName: string;
  scrollTop: number;              // 隐藏前保存，显示时恢复（display:none 会丢滚动位置）
  conflict: DocUpdatedPayload | null; // 编辑中收到的外部改动，等用户 Reload
  modeBeforeSource: DocMode;      // 进入 source 前的模式；⌘/ 退出 source 时回到这里
}

export const RENDER_FAILED_TEXT = "Could not render this document.";

let host: HTMLElement | null = null;
const registry = new Map<DocId, DocEntry>();

export function attachHost(el: HTMLElement): void {
  host = el;
}

export function editorFor(docId: DocId): EditorHandle | null {
  return registry.get(docId)?.editor ?? null;
}

const isShown = (entry: DocEntry): boolean => entry.pane.style.display !== "none";
const modeOf = (docId: DocId): DocMode => useShellStore.getState().modes[docId] ?? "preview";
const isActive = (docId: DocId): boolean => useShellStore.getState().active === docId;
const stem = (fileName: string): string => fileName.replace(/\.[^.]+$/, "") || "rsmd";

function showActive(active: DocId | null): void {
  for (const [id, entry] of registry) {
    if (id !== active && isShown(entry)) {
      entry.scrollTop = entry.editor?.scrollTop() ?? entry.scrollTop;
      entry.pane.style.display = "none";
    }
  }
  if (active === null) {
    document.title = "rsmd";
    return;
  }
  const entry = registry.get(active);
  if (!entry) return; // openDoc 先建 pane 再写 store，正常不会到这里
  entry.pane.style.display = "";
  document.title = entry.title;
  if (!entry.editor) {
    void materialize(active, entry);
    return;
  }
  entry.editor.setScrollTop(entry.scrollTop);
  // 后台期间（display:none 无布局）的高亮可能失真，显示时重同步
  syncOutline(entry.pane, entry.editor);
}

useShellStore.subscribe((s) => s.active, showActive);

function pushState(docId: DocId, entry: DocEntry, dirty: boolean): void {
  void ipc.setDocState(docId, modeOf(docId), dirty, entry.title).catch(() => {});
}

function onDirtyChange(docId: DocId, dirty: boolean): void {
  const entry = registry.get(docId);
  if (!entry) return;
  useShellStore.getState().setDirty(docId, dirty);
  pushState(docId, entry, dirty);
}

function onTitleChange(docId: DocId, title: string | null): void {
  const entry = registry.get(docId);
  if (!entry) return;
  const next = title ?? stem(entry.fileName);
  if (next === entry.title) return;
  entry.title = next;
  if (isActive(docId)) document.title = next;
  pushState(docId, entry, entry.editor?.isDirty() ?? false);
}

function onHeadingsChange(docId: DocId, headings: TocEntry[]): void {
  const entry = registry.get(docId);
  if (!entry) return;
  refreshOutline(entry.pane, headings);
  syncOutline(entry.pane, entry.editor);
}

/// 创建编辑器。必须在 pane 可见后调用（ProseMirror / CM 首次测量依赖布局）。
/// 创建期间到达的文本更新存入 pending，完成后补应用；创建期间被关闭则销毁刚建好的实例。
function materialize(docId: DocId, entry: DocEntry): Promise<void> {
  if (entry.creating) return entry.creating;
  if (entry.editor || entry.pending === null) return Promise.resolve();
  const text = entry.pending;
  entry.pending = null;
  entry.creating = (async () => {
    let editor: EditorHandle;
    try {
      editor = await createEditor({
        parent: entry.pane,
        text,
        baseDir: entry.baseDir,
        onDirtyChange: (dirty) => onDirtyChange(docId, dirty),
        onTitleChange: (title) => onTitleChange(docId, title),
        onHeadingsChange: (headings) => onHeadingsChange(docId, headings),
        onStatsChange: (stats) => useShellStore.getState().setStats(docId, stats),
        onOpenLink: (href) => {
          followLink(docId, href);
        },
      });
    } catch (err) {
      entry.creating = null;
      entry.pending = text; // 保留文本，下次显示再试
      useShellStore.getState().setError(`${RENDER_FAILED_TEXT} ${String(err)}`);
      return;
    }
    entry.creating = null;
    // 身份比较而非 has()：同一 docId 在创建期间被关闭又重开时，registry 里已是新 entry，
    // 用 has() 会把这个旧实例挂到已移除的 pane 上且永不销毁（Rust id 单调递增，目前不可达）
    if (registry.get(docId) !== entry) {
      editor.destroy();
      return;
    }
    entry.editor = editor;
    refreshOutline(entry.pane, editor.headings());
    useShellStore.getState().setStats(docId, editor.stats());
    installOutlineSpy(entry.pane, editor);
    if (entry.pending !== null) {
      const late = entry.pending;
      entry.pending = null;
      editor.applyExternal(late);
    }
    const mode = modeOf(docId);
    // 创建期间用户已切模式：补应用但不 focus（后台 tab 不该抢焦点）
    if (mode !== "preview") editor.setMode(mode);
    if (isActive(docId)) {
      editor.setScrollTop(entry.scrollTop);
      syncOutline(entry.pane, editor);
    }
  })();
  return entry.creating;
}

export function openDoc(doc: DocOpenedPayload): void {
  if (!host || registry.has(doc.docId)) return;
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.docId = String(doc.docId);
  pane.style.display = "none"; // 显隐只由 showActive 决定
  host.appendChild(pane);
  registry.set(doc.docId, {
    pane,
    editor: null,
    creating: null,
    pending: doc.text,
    baseDir: doc.baseDir,
    title: doc.title,
    fileName: doc.fileName,
    scrollTop: 0,
    conflict: null,
    modeBeforeSource: "preview",
  });
  // 先建 pane 再进 store：activate=true 时 store 的 active 变化会同步触发 showActive → materialize
  useShellStore.getState().addDoc({ docId: doc.docId, path: doc.path, fileName: doc.fileName }, doc.activate);
}

function applyPayload(docId: DocId, entry: DocEntry, editor: EditorHandle, p: DocUpdatedPayload): void {
  entry.title = p.title;
  editor.applyExternal(p.text);
  entry.conflict = null;
  useShellStore.getState().setConflict(docId, false);
  refreshOutline(entry.pane, editor.headings());
  useShellStore.getState().setStats(docId, editor.stats());
  syncOutline(entry.pane, editor);
  if (isActive(docId)) document.title = p.title;
}

export function updateDoc(doc: DocUpdatedPayload): void {
  const entry = registry.get(doc.docId);
  if (!entry) return;
  const store = useShellStore.getState();
  // 文件又能读了（删除后恢复 / watcher 继续触发 Modified）：撕掉该 doc 的异常提示
  store.clearNotice(doc.docId);
  if (!entry.editor) {
    entry.pending = doc.text;
    entry.title = doc.title;
    if (isActive(doc.docId)) document.title = doc.title;
    return;
  }
  if (!doc.external) {
    // 自己保存的回声：磁盘内容就是我们刚写的，不必重载（重载会丢光标）；标题以 Rust 为准
    entry.title = doc.title;
    if (isActive(doc.docId)) document.title = doc.title;
    return;
  }
  if (entry.editor.isDirty()) {
    // 外部改了文件而本地有未保存改动：不覆盖，挂横幅等用户决定（Reload 或 Save 覆盖磁盘）
    entry.conflict = doc;
    store.setConflict(doc.docId, true);
    return;
  }
  applyPayload(doc.docId, entry, entry.editor, doc);
}

export function setDocMode(docId: DocId, mode: DocMode): void {
  const entry = registry.get(docId);
  if (!entry) return;
  const current = modeOf(docId);
  if (mode === current) return;
  if (mode === "source") entry.modeBeforeSource = current;
  useShellStore.getState().setMode(docId, mode); // 菜单勾选须紧跟按键
  if (entry.editor) {
    entry.editor.setMode(mode);
    // setMode 不改焦点：用户主动切当前可见 tab 的模式时，焦点交给新引擎
    if (isActive(docId)) entry.editor.focus();
    pushState(docId, entry, entry.editor.isDirty());
    return;
  }
  pushState(docId, entry, false);
  void materialize(docId, entry); // 尾部会按 store 里的 mode 切换
}

/// 菜单/快捷键语义：Live（⌘E）在 live↔preview 间切换；Source（⌘/）进出源码模式，
/// 退出回到进入前的模式；Preview 直达。
export function onModeMenu(docId: DocId, item: DocMode): void {
  const entry = registry.get(docId);
  if (!entry) return;
  const current = modeOf(docId);
  const target =
    item === "live"
      ? current === "live"
        ? "preview"
        : "live"
      : item === "source"
        ? current === "source"
          ? entry.modeBeforeSource
          : "source"
        : "preview";
  setDocMode(docId, target);
}

export async function saveDoc(docId: DocId, closeAfter = false): Promise<void> {
  const entry = registry.get(docId);
  if (!entry) return;
  if (!entry.editor) {
    if (!entry.creating) return;
    await entry.creating;
    if (!entry.editor) return;
  }
  const editor = entry.editor;
  const text = editor.getText();
  try {
    await ipc.saveDoc(docId, text);
  } catch (err) {
    useShellStore.getState().setError(String(err));
    return;
  }
  editor.markSaved(text); // → onDirtyChange(false) → store + Rust
  entry.conflict = null; // 保存即以本地为准
  useShellStore.getState().setConflict(docId, false);
  if (closeAfter) void ipc.closeDoc(docId).catch(() => {});
}

export function reloadFromDisk(docId: DocId): void {
  const entry = registry.get(docId);
  if (!entry?.editor || !entry.conflict) return;
  applyPayload(docId, entry, entry.editor, entry.conflict);
  entry.editor.focus();
}

export function closeDoc(docId: DocId, nextActive: DocId | null): void {
  const entry = registry.get(docId);
  if (!entry) return;
  registry.delete(docId);
  entry.editor?.destroy();
  entry.pane.remove();
  // pane 已移除再改 store：若 active 因此变化，showActive 只会看到仍存在的 pane
  useShellStore.getState().removeDoc(docId, nextActive);
}
