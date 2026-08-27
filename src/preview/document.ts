import { updatePreview } from "./dom";
import { enhance } from "./enhance";
import { installTocSpy, refreshToc, syncActive } from "./toc";
import type { DocId, DocOpenedPayload, DocUpdatedPayload } from "../ipc";
import { useShellStore } from "../store";

// 文档生命周期的唯一入口：openDoc / updateDoc / closeDoc 同时维护 pane DOM 与 store。
// "哪个文档是 active" 只存在于 store；本模块订阅它并把结果投影到 pane 的显隐上。

interface DocEntry {
  pane: HTMLElement; // 滚动容器 .pane（display 显隐）
  content: HTMLElement; // .markdown-body，morph 目标
  title: string;
  // 文档代际（per-doc）：enhance 的异步任务完成后必须仍属于该 doc 的当前代际
  // 才允许写 DOM。若为模块级单变量，doc A 渲染中 doc B 热刷新会把 A 的
  // mermaid/shiki 结果全部作废且 data-enhanced 未设，A 永久停留在未高亮态。
  generation: number;
  scrollTop: number; // 隐藏前保存，显示时恢复
  // 非 null = 尚未物化：pane 是隐藏空壳，html 暂存于此，首次显示时才注入 + TOC + enhance。
  // 批量打开 N 个文件只渲染 active 那一个，其余各自在切到时付渲染成本（与单开一文件等价）。
  pendingHtml: string | null;
}

let host: HTMLElement | null = null;
const registry = new Map<DocId, DocEntry>();

export function attachHost(el: HTMLElement): void {
  host = el;
}

function isShown(entry: DocEntry): boolean {
  return entry.pane.style.display !== "none";
}

/// store.active 变化的投影：隐藏其余可见 pane（保存滚动位置），显示 active 的那一个。
/// 由 subscribeWithSelector 保证只在 active 真正变化时调用，同 id 回声不会到达这里。
function showActive(active: DocId | null): void {
  for (const [id, entry] of registry) {
    if (id !== active && isShown(entry)) {
      entry.scrollTop = entry.pane.scrollTop;
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
  entry.pane.scrollTop = entry.scrollTop;
  if (entry.pendingHtml !== null) {
    materialize(active, entry); // 首次显示：注入正文（含 refreshToc → syncActive）
  } else {
    // 后台 pane（display:none）热刷新时 rect 全 0 → 末标题被标 active；恢复 scrollTop=0
    // 不触发 scroll 事件，spy 无法补救，故显示时必须显式重同步高亮。
    syncActive(entry.pane);
  }
  document.title = entry.title;
}

useShellStore.subscribe((s) => s.active, showActive);

/// 把暂存的 html 真正渲染进 pane。必须在 pane 可见后调用：refreshToc 里的
/// syncActive 依赖真实布局。enhance 不等待——没有调用方阻塞在其完成上。
function materialize(docId: DocId, entry: DocEntry): void {
  const html = entry.pendingHtml;
  if (html === null) return;
  entry.pendingHtml = null;
  updatePreview(entry.content, html);
  refreshToc(entry.pane, entry.content);
  installTocSpy(entry.pane);
  const gen = ++entry.generation;
  void enhance(entry.content, () => registry.get(docId) === entry && gen === entry.generation);
}

export function openDoc(doc: DocOpenedPayload): void {
  if (!host || registry.has(doc.docId)) return;
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.docId = String(doc.docId);
  pane.style.display = "none"; // 显隐只由 showActive 决定
  const content = document.createElement("div");
  content.className = "markdown-body";
  pane.appendChild(content);
  host.appendChild(pane);
  registry.set(doc.docId, {
    pane,
    content,
    title: doc.title,
    generation: 0,
    scrollTop: 0,
    pendingHtml: doc.html,
  });
  // 先建 pane 再进 store：activate=true 时 store 的 active 变化会同步触发 showActive
  useShellStore.getState().addDoc(
    { docId: doc.docId, path: doc.path, fileName: doc.fileName },
    doc.activate
  );
}

export async function updateDoc(doc: DocUpdatedPayload): Promise<void> {
  const entry = registry.get(doc.docId);
  if (!entry) return;
  // 文件又能读了（删除后恢复 / watcher 继续触发 Modified）：撕掉该 doc 的异常提示
  useShellStore.getState().clearNotice(doc.docId);
  entry.title = doc.title;
  if (entry.pendingHtml !== null) {
    // 未物化的后台文档：只替换暂存内容，零 DOM 开销；首次显示时取最新版
    entry.pendingHtml = doc.html;
    return;
  }
  // 标题只跟随 active doc：后台 tab 热刷新不得改窗口标题
  if (useShellStore.getState().active === doc.docId) {
    document.title = doc.title;
  }
  updatePreview(entry.content, doc.html);
  refreshToc(entry.pane, entry.content);
  const gen = ++entry.generation;
  // display:none 下热刷新安全：mermaid 用自身临时元素测量、KaTeX 纯 CSS、shiki 纯字符串
  await enhance(entry.content, () => registry.get(doc.docId) === entry && gen === entry.generation);
}

export function closeDoc(docId: DocId, nextActive: DocId | null): void {
  const entry = registry.get(docId);
  if (!entry) return;
  entry.generation++; // 使在途 enhance 过期
  registry.delete(docId);
  entry.pane.remove();
  // pane 已移除再改 store：若 active 因此变化，showActive 只会看到仍存在的 pane
  useShellStore.getState().removeDoc(docId, nextActive);
}
