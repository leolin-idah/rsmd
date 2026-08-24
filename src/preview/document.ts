import { updatePreview } from "./dom";
import { enhance } from "./enhance";
import type { DocId } from "../tabs";

export interface DocOpenedPayload {
  docId: DocId;
  path: string;
  fileName: string;
  html: string;
  title: string;
  baseDir: string;
}

export interface DocUpdatedPayload {
  docId: DocId;
  html: string;
  title: string;
}

interface DocEntry {
  pane: HTMLElement; // 滚动容器 .pane（display 显隐）
  content: HTMLElement; // .markdown-body，morph 目标
  title: string;
  // 文档代际（per-doc）：enhance 的异步任务完成后必须仍属于该 doc 的当前代际
  // 才允许写 DOM。若为模块级单变量，doc A 渲染中 doc B 热刷新会把 A 的
  // mermaid/shiki 结果全部作废且 data-enhanced 未设，A 永久停留在未高亮态。
  generation: number;
  scrollTop: number; // 隐藏前保存，显示时恢复
}

let host: HTMLElement | null = null;
const registry = new Map<DocId, DocEntry>();
let activeId: DocId | null = null;

export function attachHost(el: HTMLElement): void {
  host = el;
}

export function activeDocId(): DocId | null {
  return activeId;
}

function showPane(docId: DocId): void {
  const entry = registry.get(docId);
  if (!entry) return;
  if (activeId !== null && activeId !== docId) {
    const prev = registry.get(activeId);
    if (prev) {
      prev.scrollTop = prev.pane.scrollTop;
      prev.pane.style.display = "none";
    }
  }
  entry.pane.style.display = "";
  entry.pane.scrollTop = entry.scrollTop;
  activeId = docId;
  document.title = entry.title;
}

export async function openDoc(doc: DocOpenedPayload): Promise<void> {
  if (!host || registry.has(doc.docId)) return;
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.docId = String(doc.docId);
  const content = document.createElement("div");
  content.className = "markdown-body";
  pane.appendChild(content);
  host.appendChild(pane);
  const entry: DocEntry = { pane, content, title: doc.title, generation: 0, scrollTop: 0 };
  registry.set(doc.docId, entry);
  showPane(doc.docId); // 新开即 active（Rust 侧同步设置）
  updatePreview(content, doc.html);
  const gen = ++entry.generation;
  await enhance(content, () => registry.get(doc.docId) === entry && gen === entry.generation);
}

export async function updateDoc(doc: DocUpdatedPayload): Promise<void> {
  const entry = registry.get(doc.docId);
  if (!entry) return;
  entry.title = doc.title;
  // 标题只跟随 active doc：后台 tab 热刷新不得改窗口标题
  if (activeId === doc.docId) {
    document.title = doc.title;
  }
  updatePreview(entry.content, doc.html);
  const gen = ++entry.generation;
  // display:none 下热刷新安全：mermaid 用自身临时元素测量、KaTeX 纯 CSS、shiki 纯字符串
  await enhance(entry.content, () => registry.get(doc.docId) === entry && gen === entry.generation);
}

/// 一切 active 变更的统一入口，幂等：已 active 则 no-op。
/// 点击 tab 先本地调用（零延迟切 DOM），Rust 的 document-focus 回声再到达时不抖动。
export function applyFocus(docId: DocId): void {
  if (activeId === docId) return;
  showPane(docId);
}

export function closeDoc(docId: DocId, nextActive: DocId | null): void {
  const entry = registry.get(docId);
  if (!entry) return;
  entry.generation++; // 使在途 enhance 过期
  registry.delete(docId);
  entry.pane.remove();
  if (activeId !== docId) return;
  activeId = null;
  if (nextActive !== null && registry.has(nextActive)) {
    showPane(nextActive);
  } else {
    document.title = "rsmd";
  }
}
