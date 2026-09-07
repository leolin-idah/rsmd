export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/// 从标题条目构建 TOC（条目来自 ProseMirror doc，见 editor/outline.ts）。无有效条目返回 null
export function buildToc(entries: TocEntry[]): HTMLElement | null {
  const valid = entries.filter((e) => e.id && e.text.trim());
  if (valid.length === 0) return null;
  const minLevel = Math.min(...valid.map((e) => e.level));
  const nav = document.createElement("nav");
  nav.className = "toc";
  const ul = document.createElement("ul");
  for (const e of valid) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.setAttribute("href", `#${e.id}`); // links.ts 的 pane 内锚点委托处理跳转
    // 高亮比对用 data-target 存原始 id，避免与 href 的编码形式耦合
    a.dataset.target = e.id;
    a.textContent = e.text;
    a.style.paddingLeft = `${8 + (e.level - minLevel) * 14}px`;
    li.appendChild(a);
    ul.appendChild(li);
  }
  nav.appendChild(ul);
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
