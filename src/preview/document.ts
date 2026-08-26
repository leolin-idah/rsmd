import { updatePreview } from "./dom";
import { enhance } from "./enhance";
import { installTocSpy, refreshToc, syncActive } from "./toc";
import type { DocId } from "../tabs";

export interface DocOpenedPayload {
  docId: DocId;
  path: string;
  fileName: string;
  html: string;
  title: string;
  baseDir: string;
  // 批量打开时只有首个成功的文档为 true；false = 后台待命，不设 active、不渲染
  activate: boolean;
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
  // 非 null = 尚未物化：pane 是隐藏空壳，html 暂存于此，首次显示时才注入 + TOC + enhance。
  // 批量打开 N 个文件只渲染 active 那一个，其余各自在切到时付渲染成本（与单开一文件等价）。
  pendingHtml: string | null;
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
  if (entry.pendingHtml !== null) {
    materialize(docId, entry); // 首次显示：注入正文（含 refreshToc → syncActive）
  } else {
    // 后台 pane（display:none）热刷新时 rect 全 0 → 末标题被标 active；恢复 scrollTop=0
    // 不触发 scroll 事件，spy 无法补救，故显示时必须显式重同步高亮。
    syncActive(entry.pane);
  }
  activeId = docId;
  document.title = entry.title;
}

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
  pane.style.display = "none"; // 显隐只由 showPane 决定
  const content = document.createElement("div");
  content.className = "markdown-body";
  pane.appendChild(content);
  host.appendChild(pane);
  const entry: DocEntry = {
    pane,
    content,
    title: doc.title,
    generation: 0,
    scrollTop: 0,
    pendingHtml: doc.html,
  };
  registry.set(doc.docId, entry);
  if (doc.activate) {
    showPane(doc.docId); // Rust 侧已同步设为 active
  }
}

export async function updateDoc(doc: DocUpdatedPayload): Promise<void> {
  const entry = registry.get(doc.docId);
  if (!entry) return;
  entry.title = doc.title;
  if (entry.pendingHtml !== null) {
    // 未物化的后台文档：只替换暂存内容，零 DOM 开销；首次显示时取最新版
    entry.pendingHtml = doc.html;
    return;
  }
  // 标题只跟随 active doc：后台 tab 热刷新不得改窗口标题
  if (activeId === doc.docId) {
    document.title = doc.title;
  }
  updatePreview(entry.content, doc.html);
  refreshToc(entry.pane, entry.content);
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
