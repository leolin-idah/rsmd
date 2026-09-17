import { buildToc, patchToc, pickCurrent, type TocEntry } from "../preview/toc";

/// 大纲的数据源（由 EditorHandle 实现）：标题条目、各标题相对可视区顶部的位置、滚动事件
export interface OutlineSource {
  headings(): TocEntry[];
  headingTops(): { id: string; top: number }[];
  onScroll(cb: () => void): () => void;
}

/// 刷新 TOC。已有 nav 时原地协调（patchToc），不删除重建：mdEditor 的 meta 防抖每次打字停顿都会
/// 带着（多半没变的）标题调到这里，重建会丢 .active 与侧栏滚动位置，随后 syncOutline 补回 .active
/// 时 .toc a 的颜色过渡从"非当前"起跳，表现为 TOC 每 300ms 闪一下
export function refreshOutline(pane: HTMLElement, headings: TocEntry[]): void {
  const nav = pane.querySelector<HTMLElement>("nav.toc");
  if (!nav) {
    const toc = buildToc(headings);
    if (toc) pane.appendChild(toc);
    return;
  }
  patchToc(nav, headings);
  if (!nav.querySelector("li")) nav.remove(); // 标题全没了：与首次无标题一致，不留空 nav
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
