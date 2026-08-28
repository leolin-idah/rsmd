import { buildToc, pickCurrent } from "../preview/toc";
import type { EditorHandle } from "./markdownEditor";

/// TOC 从最近一次渲染的整页 HTML 提取（光标所在段的标题也在渲染结果里，只是没显示成 widget）。
export function refreshOutline(pane: HTMLElement, html: string): void {
  pane.querySelector("nav.toc")?.remove();
  const content = document.createElement("div");
  content.innerHTML = html;
  const toc = buildToc(content);
  if (toc) pane.appendChild(toc);
}

/// 高亮当前章节：标题的纵向位置来自 CM 高度图（lineBlockAt），视口外未渲染成 DOM 的标题也有坐标。
export function syncOutline(pane: HTMLElement, editor: EditorHandle | null): void {
  const toc = pane.querySelector<HTMLElement>("nav.toc");
  if (!toc || !editor) return;
  const { view } = editor;
  const scrollTop = view.scrollDOM.scrollTop;
  const tops = editor.headings().map((h) => {
    const line = Math.min(Math.max(h.line, 1), view.state.doc.lines);
    return { id: h.id, top: view.lineBlockAt(view.state.doc.line(line).from).top - scrollTop };
  });
  const current = pickCurrent(tops);
  for (const a of Array.from(toc.querySelectorAll<HTMLElement>("a"))) {
    const active = a.dataset.target === current;
    a.classList.toggle("active", active);
    if (active) a.scrollIntoView?.({ block: "nearest" }); // jsdom 无 scrollIntoView
  }
}

// pane 生命周期内只挂一次
const spied = new WeakSet<HTMLElement>();

export function installOutlineSpy(pane: HTMLElement, editor: EditorHandle): void {
  if (spied.has(pane)) return;
  spied.add(pane);
  let pending = false;
  editor.view.scrollDOM.addEventListener(
    "scroll",
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        syncOutline(pane, editor);
      });
    },
    { passive: true }
  );
}
