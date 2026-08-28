import type { BlockKind, BlockRange } from "../ipc";

export interface RenderedBlock {
  from: number;
  to: number;
  kind: BlockKind;
  html: string; // kind=footnote 恒为 ""（渲染版在 footnotesHtml）
}

export interface Heading {
  id: string;
  line: number; // 所在顶层块的首行（容器块内的标题也归到块首）
}

export interface SplitResult {
  blocks: RenderedBlock[];
  footnotesHtml: string | null; // <section class="footnotes">，作为文末 trailer widget
  headings: Heading[];
}

export interface Segment {
  fromLine: number;
  toLine: number;
  kind: BlockKind;
  html: string;
}

function sourceposStartLine(el: Element): number | null {
  const sp = el.getAttribute("data-sourcepos"); // "3:1-4:0"
  if (!sp) return null;
  const line = Number.parseInt(sp, 10);
  return Number.isFinite(line) ? line : null;
}

function outerHtml(node: Node): string {
  if (node instanceof Element) return node.outerHTML;
  // 文本 / 注释节点：原生 HTML 块可能只输出一个 <!-- -->
  const wrap = document.createElement("div");
  wrap.appendChild(node.cloneNode(true));
  return wrap.innerHTML;
}

function collectHeadings(el: Element, line: number, out: Heading[]): void {
  const hs = el.matches("h1,h2,h3,h4,h5,h6") ? [el] : Array.from(el.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  for (const h of hs) {
    // comrak header_ids 把 id 放在内嵌 <a class="anchor"> 上；兼容直接写在 h 上的 id
    const id = h.id || h.querySelector("a[id]")?.id;
    if (id) out.push({ id, line });
  }
}

/// 把 comrak 整页 HTML 的顶层节点与 Rust 给出的顶层块行范围对位。
/// - 带 data-sourcepos 的元素按起始行匹配（只向前匹配，防止重复起始行回绕）；
/// - 无 sourcepos 的节点（原生 HTML 块的输出）归入"下一个 kind=html 的范围"，没有则并入当前块；
/// - 脚注 <section>（sourcepos = 首个脚注定义）单独取出作为 trailer，脚注范围本身 html 留空。
/// 已知限制：相邻两个 HTML 块各输出多个顶层节点时会串块（极罕见）。
export function splitBlocks(html: string, ranges: BlockRange[]): SplitResult {
  const blocks: RenderedBlock[] = [...ranges]
    .sort((a, b) => a.from - b.from)
    .map((r) => ({ ...r, html: "" }));
  const headings: Heading[] = [];
  let footnotesHtml: string | null = null;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let current = -1; // 最近匹配到的块下标
  for (const node of Array.from(tpl.content.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim()) continue;
    const startLine = node instanceof Element ? sourceposStartLine(node) : null;
    if (startLine !== null) {
      const el = node as Element;
      if (el.classList.contains("footnotes") && blocks.some((b) => b.kind === "footnote" && b.from === startLine)) {
        footnotesHtml = el.outerHTML;
        continue; // 不改 current：section 在 HTML 末尾，与源码顺序无关
      }
      const idx = blocks.findIndex((b, i) => i > current && b.kind !== "footnote" && b.from === startLine);
      if (idx < 0) continue; // 对不上的元素丢弃（理论上不会发生）
      blocks[idx].html += el.outerHTML;
      collectHeadings(el, blocks[idx].from, headings);
      current = idx;
      continue;
    }
    const nextHtml = blocks.findIndex((b, i) => i > current && b.kind === "html");
    const onlyFootnotesBetween = nextHtml >= 0 && blocks.slice(current + 1, nextHtml).every((b) => b.kind === "footnote");
    const target = onlyFootnotesBetween ? nextHtml : current;
    if (target < 0) continue;
    blocks[target].html += outerHtml(node);
    current = target;
  }
  return {
    blocks: blocks.filter((b) => b.kind === "footnote" || b.html !== ""),
    footnotesHtml,
    headings,
  };
}

/// 把块范围扩成互不重叠、覆盖全文的段：每段从块首行起，吞掉其后直到下一块首行之前的所有行
/// （空行、引用定义、未引用脚注等无渲染输出的行）；首段从第 1 行起，末段到文末。
/// 只读态因此没有裸露的源码行；编辑态露出某段时，这些行随段显示。
export function segment(blocks: RenderedBlock[], lineCount: number): Segment[] {
  const sorted = [...blocks].sort((a, b) => a.from - b.from);
  const out: Segment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const fromLine = i === 0 ? 1 : sorted[i].from;
    if (fromLine > lineCount) break;
    const rawTo = i + 1 < sorted.length ? sorted[i + 1].from - 1 : lineCount;
    out.push({
      fromLine,
      toLine: Math.max(fromLine, Math.min(rawTo, lineCount)),
      kind: sorted[i].kind,
      html: sorted[i].html,
    });
  }
  return out;
}
