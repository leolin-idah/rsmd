export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/// comrak header_ids 把 id 生成在标题内嵌的 <a class="anchor"> 上，
/// 但也兼容直接写在 h 元素上的 id（文档内嵌 HTML 的情形）。
function headingId(h: HTMLElement): string | null {
  return h.id || h.querySelector("a[id]")?.id || null;
}

export function extractHeadings(content: HTMLElement): TocEntry[] {
  const out: TocEntry[] = [];
  for (const h of Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
  )) {
    const id = headingId(h);
    const text = (h.textContent ?? "").trim();
    if (!id || !text) continue;
    out.push({ id, text, level: Number(h.tagName[1]) });
  }
  return out;
}

export function buildToc(content: HTMLElement): HTMLElement | null {
  const entries = extractHeadings(content);
  if (entries.length === 0) return null;
  const minLevel = Math.min(...entries.map((e) => e.level));
  const nav = document.createElement("nav");
  nav.className = "toc";
  const ul = document.createElement("ul");
  for (const e of entries) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.setAttribute("href", `#${e.id}`); // links.ts 的 pane 内锚点委托处理跳转
    // 高亮比对用 data-target 存原始 id，避免与 href 的编码形式（.href 属性会百分号转义）耦合
    a.dataset.target = e.id;
    a.textContent = e.text;
    a.style.paddingLeft = `${8 + (e.level - minLevel) * 14}px`;
    li.appendChild(a);
    ul.appendChild(li);
  }
  nav.appendChild(ul);
  return nav;
}

/// tops：各标题顶边相对 pane 可视区顶部的偏移。当前章节 = 越过阈值线的
/// 最后一个标题；都没越过（文档开头）取第一个。
export function pickCurrent(
  tops: { id: string; top: number }[],
  threshold = 32
): string | null {
  if (tops.length === 0) return null;
  let current = tops[0].id;
  for (const t of tops) {
    if (t.top <= threshold) current = t.id;
  }
  return current;
}

export function syncActive(pane: HTMLElement): void {
  const toc = pane.querySelector<HTMLElement>("nav.toc");
  const content = pane.querySelector<HTMLElement>(".markdown-body");
  if (!toc || !content) return;
  const paneTop = pane.getBoundingClientRect().top;
  const tops: { id: string; top: number }[] = [];
  for (const h of Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
  )) {
    const id = headingId(h);
    if (!id) continue;
    tops.push({ id, top: h.getBoundingClientRect().top - paneTop });
  }
  const current = pickCurrent(tops);
  for (const a of Array.from(toc.querySelectorAll<HTMLElement>("a"))) {
    const active = a.dataset.target === current;
    a.classList.toggle("active", active);
    // 高亮项保持在 TOC 可视区内；jsdom 无 scrollIntoView，特性防御
    if (active) a.scrollIntoView?.({ block: "nearest" });
  }
}

// pane 生命周期内只挂一次；pane 移除后 WeakSet 允许回收
const spied = new WeakSet<HTMLElement>();

export function installTocSpy(pane: HTMLElement): void {
  if (spied.has(pane)) return;
  spied.add(pane);
  let pending = false;
  pane.addEventListener(
    "scroll",
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        syncActive(pane);
      });
    },
    { passive: true }
  );
}

/// open/热刷新的统一入口：TOC 与 content 是兄弟节点，morphdom 只 morph
/// content，TOC 直接整棵重建即可。
export function refreshToc(pane: HTMLElement, content: HTMLElement): void {
  pane.querySelector("nav.toc")?.remove();
  const toc = buildToc(content);
  if (!toc) return;
  pane.appendChild(toc);
  syncActive(pane);
}
