export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

const valid = (entries: TocEntry[]): TocEntry[] => entries.filter((e) => e.id && e.text.trim());

/// 把一条标题写到链接上。只写有差异的属性：条目没变时零 DOM 变更，节点身份、hover、
/// 正在进行的颜色过渡都不受打扰（patchToc 按位置复用节点时依赖这一点）
function applyEntry(a: HTMLElement, e: TocEntry, minLevel: number): void {
  const href = `#${e.id}`; // links.ts 的 pane 内锚点委托处理跳转
  if (a.getAttribute("href") !== href) a.setAttribute("href", href);
  // 高亮比对用 data-target 存原始 id，避免与 href 的编码形式耦合
  if (a.dataset.target !== e.id) a.dataset.target = e.id;
  if (a.textContent !== e.text) a.textContent = e.text;
  const pad = `${8 + (e.level - minLevel) * 14}px`;
  if (a.style.paddingLeft !== pad) a.style.paddingLeft = pad;
}

/// 把标题条目按位置协调到已有的 nav.toc 上：第 i 个 li 复用第 i 个既有节点，多余的删、不够的补。
/// 按位置而非按 id 键控：id 是 slug，在标题里打字每次防抖到期都会换 id，按 id 会恰好重建
/// 正在编辑的那一项（.active 丢失 → 颜色过渡从头闪一次）；按位置则同一节点原地改文本。
/// 位置发生错位（前面插入 / 删除标题）时高亮由随后的 syncOutline 纠正。
/// 业界同类（MarkText / Zettlr / Tiptap TOC / VitePress）均为 keyed 协调，无一整段重建
export function patchToc(nav: HTMLElement, entries: TocEntry[]): void {
  const items = valid(entries);
  const ul = nav.querySelector("ul") ?? nav.appendChild(document.createElement("ul"));
  const minLevel = items.length ? Math.min(...items.map((e) => e.level)) : 1;
  const lis = Array.from(ul.children);
  items.forEach((e, i) => {
    let a = lis[i]?.querySelector("a");
    if (!a) {
      const li = document.createElement("li");
      a = document.createElement("a");
      li.appendChild(a);
      ul.appendChild(li);
    }
    applyEntry(a, e, minLevel);
  });
  for (const extra of lis.slice(items.length)) extra.remove();
}

/// 从标题条目构建 TOC（条目来自 ProseMirror doc，见 editor/outline.ts）。无有效条目返回 null
export function buildToc(entries: TocEntry[]): HTMLElement | null {
  if (valid(entries).length === 0) return null;
  const nav = document.createElement("nav");
  nav.className = "toc";
  patchToc(nav, entries);
  return nav;
}

/// tops：各标题顶边相对 pane 可视区顶部的偏移。当前章节 = 越过阈值线的最后一个标题；都没越过取第一个。
/// 阈值取 49 = --rsmd-header-h(40) + 8 + 1：标题的 scroll-margin-top 正是 header 高 + 8px，
/// TOC 跳过去之后目标标题就停在 top≈48，阈值小于它会把上一个标题高亮成"当前"
export function pickCurrent(tops: { id: string; top: number }[], threshold = 49): string | null {
  if (tops.length === 0) return null;
  let current = tops[0].id;
  for (const t of tops) {
    if (t.top <= threshold) current = t.id;
  }
  return current;
}
