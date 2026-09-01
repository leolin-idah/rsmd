import * as ipc from "../ipc";
import type { BlockRange, DocId, DocMode, DocOpenedPayload, DocUpdatedPayload, RenderPayload } from "../ipc";
import { createEditor, type EditorHandle } from "../editor/markdownEditor";
import { installOutlineSpy, refreshOutline, syncOutline } from "../editor/outline";
import { useShellStore } from "../store";

// 文档生命周期的唯一入口：open / update / close / setDocMode / save / reload 同时维护 pane、编辑器与 store。
// "哪个文档是 active" 只存在于 store；本模块订阅它并投影到 pane 的显隐上。

interface Pending {
  text: string;
  html: string;
  blocks: BlockRange[];
}

interface DocEntry {
  pane: HTMLElement;
  editor: EditorHandle | null; // null = 尚未物化（后台打开），首次显示时创建
  pending: Pending | null;     // 未物化期间的最新载荷
  title: string;
  scrollTop: number;           // 隐藏前保存，显示时恢复（display:none 会丢滚动位置）
  conflict: DocUpdatedPayload | null; // 编辑中收到的外部改动，等用户 Reload
  modeBeforeSource: DocMode;   // 进入 source 前的模式；⌘/ 退出 source 时回到这里
}

let host: HTMLElement | null = null;
const registry = new Map<DocId, DocEntry>();

export function attachHost(el: HTMLElement): void {
  host = el;
}

export function editorFor(docId: DocId): EditorHandle | null {
  return registry.get(docId)?.editor ?? null;
}

const isShown = (entry: DocEntry): boolean => entry.pane.style.display !== "none";
const scroller = (entry: DocEntry): HTMLElement | null => entry.editor?.view.scrollDOM ?? null;

function showActive(active: DocId | null): void {
  for (const [id, entry] of registry) {
    if (id !== active && isShown(entry)) {
      entry.scrollTop = scroller(entry)?.scrollTop ?? 0;
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
  if (entry.pending) materialize(active, entry);
  const s = scroller(entry);
  if (s) s.scrollTop = entry.scrollTop;
  // 后台期间（display:none 无布局）的高亮可能失真，显示时重同步
  syncOutline(entry.pane, entry.editor);
  document.title = entry.title;
}

useShellStore.subscribe((s) => s.active, showActive);

const modeOf = (docId: DocId): DocMode => useShellStore.getState().modes[docId] ?? "preview";

function onDirtyChange(docId: DocId, dirty: boolean): void {
  useShellStore.getState().setDirty(docId, dirty);
  void ipc.setDocState(docId, modeOf(docId), dirty).catch(() => {});
}

function onRendered(docId: DocId, r: RenderPayload): void {
  const entry = registry.get(docId);
  if (!entry) return;
  entry.title = r.title;
  refreshOutline(entry.pane, r.html);
  syncOutline(entry.pane, entry.editor);
  if (useShellStore.getState().active === docId) document.title = r.title;
}

/// 创建编辑器（只读、全 widget）。必须在 pane 可见后调用：CM 首次测量依赖真实布局。
function materialize(docId: DocId, entry: DocEntry): void {
  const p = entry.pending;
  if (!p) return;
  entry.pending = null;
  const editor = createEditor({
    parent: entry.pane,
    text: p.text,
    html: p.html,
    blocks: p.blocks,
    onDirtyChange: (dirty) => onDirtyChange(docId, dirty),
    requestRender: (text) => ipc.renderMarkdown(docId, text).catch(() => null),
    onRendered: (r) => onRendered(docId, r),
  });
  entry.editor = editor;
  refreshOutline(entry.pane, p.html);
  installOutlineSpy(entry.pane, editor);
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
    pending: { text: doc.text, html: doc.html, blocks: doc.blocks },
    title: doc.title,
    scrollTop: 0,
    conflict: null,
    modeBeforeSource: "preview",
  });
  // 先建 pane 再进 store：activate=true 时 store 的 active 变化会同步触发 showActive → materialize
  useShellStore.getState().addDoc({ docId: doc.docId, path: doc.path, fileName: doc.fileName }, doc.activate);
}

function applyPayload(docId: DocId, entry: DocEntry, editor: EditorHandle, p: DocUpdatedPayload): void {
  entry.title = p.title;
  editor.applyExternal(p.text, p.html, p.blocks);
  entry.conflict = null;
  useShellStore.getState().setConflict(docId, false);
  refreshOutline(entry.pane, p.html);
  syncOutline(entry.pane, editor);
  if (useShellStore.getState().active === docId) document.title = p.title;
}

export function updateDoc(doc: DocUpdatedPayload): void {
  const entry = registry.get(doc.docId);
  if (!entry) return;
  const store = useShellStore.getState();
  // 文件又能读了（删除后恢复 / watcher 继续触发 Modified）：撕掉该 doc 的异常提示
  store.clearNotice(doc.docId);
  if (!entry.editor) {
    entry.pending = { text: doc.text, html: doc.html, blocks: doc.blocks };
    entry.title = doc.title;
    return;
  }
  if (!doc.external && doc.text !== entry.editor.getText()) {
    // 自己保存的回声，但保存后用户又继续输入了：回声文本已落后于编辑器，
    // 用它做 diff 会把新输入抹掉且不进撤销栈；新文本由编辑器自己的渲染管线处理
    return;
  }
  if (doc.external && entry.editor.isDirty()) {
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
  if (entry.pending) materialize(docId, entry); // 只对 active（已物化）触发，防御性处理
  const editor = entry.editor!;
  if (mode === "source") entry.modeBeforeSource = current;
  void editor.setMode(mode); // mode 先行提交（菜单勾选须紧跟按键），编辑器过渡异步完成
  useShellStore.getState().setMode(docId, mode);
  void ipc.setDocState(docId, mode, editor.isDirty()).catch(() => {});
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
  const editor = entry?.editor;
  if (!entry || !editor) return;
  try {
    await ipc.saveDoc(docId, editor.getText());
  } catch (err) {
    useShellStore.getState().setError(String(err));
    return;
  }
  editor.markSaved(); // → onDirtyChange(false) → store + Rust
  entry.conflict = null; // 保存即以本地为准
  useShellStore.getState().setConflict(docId, false);
  if (closeAfter) void ipc.closeDoc(docId).catch(() => {});
}

export function reloadFromDisk(docId: DocId): void {
  const entry = registry.get(docId);
  if (!entry?.editor || !entry.conflict) return;
  applyPayload(docId, entry, entry.editor, entry.conflict);
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
