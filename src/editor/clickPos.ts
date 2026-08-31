import type { Text } from "@codemirror/state";

/// comrak `data-sourcepos="3:1-4:12"`：1-based，列是**字节**偏移，止列 inclusive
export interface Sourcepos {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export function parseSourcepos(attr: string | null): Sourcepos | null {
  const m = attr?.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!m) return null;
  const [startLine, startCol, endLine, endCol] = m.slice(1).map(Number);
  return { startLine, startCol, endLine, endCol };
}

function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/// 1-based 字节列 → 该行内的 UTF-16 偏移。落在多字节字符中间时归到该字符；越过行尾夹到行尾
export function byteColToOffset(text: string, col: number): number {
  const target = col - 1;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    const len = utf8Len(cp);
    if (bytes + len > target) break;
    bytes += len;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

export interface Caret {
  node: Node;
  offset: number;
}

interface CaretApis {
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
}

/// 视口坐标下的插入点。标准 API 优先，WebKit 旧 API 兜底；两者都没有（jsdom）返回 null
export function caretAt(x: number, y: number): Caret | null {
  const d = document as unknown as CaretApis;
  if (typeof d.caretPositionFromPoint === "function") {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (typeof d.caretRangeFromPoint === "function") {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

export interface ClickArgs {
  block: Element; // .rsmd-block
  caret: Caret;
  doc: Text;
  seg: { from: number; to: number }; // 该块所在段的当前字符范围（已随编辑映射）
  first: boolean; // 是否首段：首段从第 1 行起，块本身可能从更后的行开始
}

/// 块首元素的 sourcepos 起行 = 该段渲染时的首行（首段例外，恒为 1）。
/// HTML 里的绝对行号在未重渲染的编辑后会过期，但段的 from/to 是准的：所有行号都换成相对锚行的行差再落到当前段
function anchorLine(block: Element, first: boolean): number | null {
  if (first) return 1;
  for (const child of Array.from(block.children)) {
    const line = parseSourcepos(child.getAttribute("data-sourcepos"))?.startLine;
    if (line !== undefined) return line;
  }
  return null;
}

/// 在源码 hay 中定位渲染文本 needle 的第 offset 个字符。整串命中最可靠；渲染文本与源码有出入
/// （转义、实体、续行缩进）时逐步缩到点击处附近的窗口，最后退到点击处那个字 / 前一个字
function findText(hay: string, needle: string, offset: number): number | null {
  if (!needle) return null;
  const windows: [number, number][] = [
    [0, needle.length],
    [offset - 8, offset + 8],
    [offset - 2, offset + 2],
    [offset, offset + 1],
    [offset - 1, offset],
  ];
  for (const [a, b] of windows) {
    const start = Math.max(0, a);
    const end = Math.min(needle.length, b);
    if (end <= start) continue;
    const idx = hay.indexOf(needle.slice(start, end));
    if (idx >= 0) return idx + (offset - start);
  }
  return null;
}

/// 渲染块内的插入点 → 源码位置。
/// 1. 最近带 data-sourcepos 的祖先给出源码范围（行号相对锚定、字节列换算）；
/// 2. 在该范围里搜文本节点内容；搜不到落到元素起点（行是对的）；
/// 3. 没有 sourcepos（原生 HTML 块）就在整段里搜；再不中落到段首。
export function clickPosition({ block, caret, doc, seg, first }: ClickArgs): number {
  if (!block.contains(caret.node)) return seg.from;
  const clamp = (pos: number): number => Math.min(Math.max(pos, seg.from), seg.to);
  const needle = caret.node.nodeType === Node.TEXT_NODE ? (caret.node.textContent ?? "") : "";
  const offset = Math.min(caret.offset, needle.length);

  const base = caret.node instanceof Element ? caret.node : caret.node.parentElement;
  const owner = base?.closest("[data-sourcepos]") ?? null;
  const sp = owner && block.contains(owner) ? parseSourcepos(owner.getAttribute("data-sourcepos")) : null;
  const anchor = anchorLine(block, first);

  let range = seg;
  let elementStart: number | null = null;
  if (sp && anchor !== null) {
    const firstLine = doc.lineAt(seg.from).number;
    const lastLine = doc.lineAt(seg.to).number;
    const lineNo = (l: number): number => Math.min(Math.max(firstLine + (l - anchor), firstLine), lastLine);
    const startLine = doc.line(lineNo(sp.startLine));
    const endLine = doc.line(lineNo(sp.endLine));
    const from = clamp(startLine.from + byteColToOffset(startLine.text, sp.startCol));
    const to = clamp(Math.max(from, endLine.from + byteColToOffset(endLine.text, sp.endCol + 1)));
    range = { from, to };
    elementStart = from;
  }

  const hit = findText(doc.sliceString(range.from, range.to), needle, offset);
  if (hit !== null) return clamp(range.from + hit);
  return elementStart ?? seg.from;
}
