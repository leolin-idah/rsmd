import { buildToc, pickCurrent, type TocEntry } from "../preview/toc";

/// 大纲的数据源（由 EditorHandle 实现）：标题条目、各标题相对可视区顶部的位置、滚动事件
export interface OutlineSource {
  headings(): TocEntry[];
  headingTops(): { id: string; top: number }[];
  onScroll(cb: () => void): () => void;
}

export function refreshOutline(pane: HTMLElement, headings: TocEntry[]): void {
  pane.querySelector("nav.toc")?.remove();
  const toc = buildToc(headings);
  if (toc) pane.appendChild(toc);
}

/// 高亮当前章节：位置由数据源给（PM 模式读标题 DOM，source 模式读 CM 高度图）
export function syncOutline(pane: HTMLElement, source: OutlineSource | null): void {
  const toc = pane.querySelector<HTMLElement>("nav.toc");
  if (!toc || !source) return;
  const current = pickCurrent(source.headingTops());
  for (const a of Array.from(toc.querySelectorAll<HTMLElement>("a"))) {
    const active = a.dataset.target === current;
    a.classList.toggle("active", active);
    if (active) a.scrollIntoView?.({ block: "nearest" });
  }
}

// pane 生命周期内只挂一次
const spied = new WeakSet<HTMLElement>();

export function installOutlineSpy(pane: HTMLElement, source: OutlineSource): void {
  if (spied.has(pane)) return;
  spied.add(pane);
  let pending = false;
  source.onScroll(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      syncOutline(pane, source);
    });
  });
}
