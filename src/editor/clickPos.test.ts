import { Text } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import { byteColToOffset, caretAt, clickPosition, parseSourcepos } from "./clickPos";

function block(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body rsmd-block";
  el.innerHTML = html;
  return el;
}

/// 块内第一个内容恰为 text 的文本节点
function findText(root: Element, text: string): Node {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent === text) return n;
  }
  throw new Error(`text node ${JSON.stringify(text)} not found`);
}

function docOf(src: string): Text {
  return Text.of(src.split("\n"));
}

function seg(doc: Text, fromLine: number, toLine: number): { from: number; to: number } {
  return { from: doc.line(fromLine).from, to: doc.line(toLine).to };
}

describe("parseSourcepos", () => {
  it("parses comrak's line:col-line:col", () => {
    expect(parseSourcepos("3:1-4:12")).toEqual({ startLine: 3, startCol: 1, endLine: 4, endCol: 12 });
  });

  it("returns null for missing or malformed attributes", () => {
    expect(parseSourcepos(null)).toBeNull();
    expect(parseSourcepos("")).toBeNull();
    expect(parseSourcepos("garbage")).toBeNull();
    expect(parseSourcepos("3:1")).toBeNull();
  });
});

describe("byteColToOffset", () => {
  it("is the identity minus one for ASCII", () => {
    expect(byteColToOffset("abc", 1)).toBe(0);
    expect(byteColToOffset("abc", 3)).toBe(2);
    expect(byteColToOffset("abc", 4)).toBe(3); // 末尾之后（inclusive 止列 + 1）
  });

  it("clamps columns past the end of the line", () => {
    expect(byteColToOffset("abc", 99)).toBe(3);
    expect(byteColToOffset("", 1)).toBe(0);
  });

  it("counts CJK characters as 3 bytes", () => {
    expect(byteColToOffset("中文ab", 1)).toBe(0);
    expect(byteColToOffset("中文ab", 4)).toBe(1);
    expect(byteColToOffset("中文ab", 7)).toBe(2);
    expect(byteColToOffset("中文ab", 8)).toBe(3);
  });

  it("maps a column inside a multi-byte character to that character", () => {
    expect(byteColToOffset("中文", 2)).toBe(0);
    expect(byteColToOffset("中文", 5)).toBe(1);
  });

  it("counts a 4-byte emoji as two UTF-16 units", () => {
    expect(byteColToOffset("😀x", 1)).toBe(0);
    expect(byteColToOffset("😀x", 5)).toBe(2);
  });
});

describe("clickPosition", () => {
  // 1 "# T"  2 ""  3 "Hello *world*!"  4 ""
  const PARA = "# T\n\nHello *world*!\n";
  const PARA_HTML = '<p data-sourcepos="3:1-3:14">Hello <em data-sourcepos="3:7-3:13">world</em>!</p>';

  it("lands on the clicked character inside an inline element", () => {
    const doc = docOf(PARA);
    const b = block(PARA_HTML);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "world"), offset: 2 }, doc, seg: seg(doc, 3, 4), first: false });
    expect(pos).toBe(doc.line(3).from + "Hello *wo".length);
  });

  it("lands on the clicked character in the paragraph's own text", () => {
    const doc = docOf(PARA);
    const b = block(PARA_HTML);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "Hello "), offset: 3 }, doc, seg: seg(doc, 3, 4), first: false });
    expect(pos).toBe(doc.line(3).from + 3);
  });

  it("finds text that comes after an inline element", () => {
    const doc = docOf(PARA);
    const b = block(PARA_HTML);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "!"), offset: 0 }, doc, seg: seg(doc, 3, 4), first: false });
    expect(pos).toBe(doc.line(3).from + "Hello *world*".length);
  });

  it("a caret at the end of a text node lands right after it", () => {
    const doc = docOf(PARA);
    const b = block(PARA_HTML);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "world"), offset: 5 }, doc, seg: seg(doc, 3, 4), first: false });
    expect(pos).toBe(doc.line(3).from + "Hello *world".length);
  });

  it("anchors stale absolute sourcepos lines to the segment's current position", () => {
    // 渲染后上方插入了两行，HTML 里仍写着第 3 行；段本身已映射到第 6 行
    const doc = docOf("# T\n\nnew\nlines\n\nHello *world*!\n");
    const b = block(PARA_HTML);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "world"), offset: 2 }, doc, seg: seg(doc, 6, 7), first: false });
    expect(pos).toBe(doc.line(6).from + "Hello *wo".length);
  });

  it("uses the line offset within a multi-line block (stale list)", () => {
    // 列表渲染时在 3–4 行，现在在 5–6 行
    const doc = docOf("# T\n\nx\n\n- a\n- b\n");
    const b = block(
      '<ul data-sourcepos="3:1-4:3"><li data-sourcepos="3:1-3:3">a</li><li data-sourcepos="4:1-4:3">b</li></ul>'
    );
    const pos = clickPosition({ block: b, caret: { node: findText(b, "b"), offset: 0 }, doc, seg: seg(doc, 5, 7), first: false });
    expect(pos).toBe(doc.line(6).from + 2);
  });

  it("the first segment is anchored at line 1 even when its block starts later", () => {
    // 文首两个空行归入首段；块本身从第 3 行开始
    const doc = docOf("\n\n# T\n");
    const b = block('<h1 data-sourcepos="3:1-3:3"><a href="#t" aria-hidden="true" class="anchor" id="t"></a>T</h1>');
    const pos = clickPosition({ block: b, caret: { node: findText(b, "T"), offset: 0 }, doc, seg: seg(doc, 1, 4), first: true });
    expect(pos).toBe(doc.line(3).from + 2);
  });

  it("converts byte columns for CJK text", () => {
    const doc = docOf("中文 *强调* 后\n");
    const b = block('<p data-sourcepos="1:1-1:19">中文 <em data-sourcepos="1:8-1:15">强调</em> 后</p>');
    const pos = clickPosition({ block: b, caret: { node: findText(b, "强调"), offset: 1 }, doc, seg: seg(doc, 1, 2), first: true });
    expect(pos).toBe("中文 *强".length);
  });

  it("disambiguates repeated words through the innermost sourcepos range", () => {
    const doc = docOf("foo *foo* foo\n");
    const b = block('<p data-sourcepos="1:1-1:13">foo <em data-sourcepos="1:5-1:9">foo</em> foo</p>');
    const inEm = clickPosition({ block: b, caret: { node: findText(b, "foo"), offset: 0 }, doc, seg: seg(doc, 1, 2), first: true });
    expect(inEm).toBe("foo *".length);
    const last = clickPosition({ block: b, caret: { node: findText(b, " foo"), offset: 1 }, doc, seg: seg(doc, 1, 2), first: true });
    expect(last).toBe("foo *foo* ".length);
  });

  it("falls back to a narrower window when the rendered text differs from the source (escapes)", () => {
    const doc = docOf("a \\*b\\* c\n");
    const b = block('<p data-sourcepos="1:1-1:9">a *b* c</p>');
    const pos = clickPosition({ block: b, caret: { node: findText(b, "a *b* c"), offset: 3 }, doc, seg: seg(doc, 1, 2), first: true });
    expect(pos).toBe("a \\*".length);
  });

  it("lands at the element's start when the caret is on an element with no text (image)", () => {
    const doc = docOf("see ![alt](x.png)\n");
    const b = block('<p data-sourcepos="1:1-1:17">see <img src="x.png" alt="alt" data-sourcepos="1:5-1:17"></p>');
    const img = b.querySelector("img")!;
    const pos = clickPosition({ block: b, caret: { node: img, offset: 0 }, doc, seg: seg(doc, 1, 2), first: true });
    expect(pos).toBe("see ".length);
  });

  it("searches the whole segment when the block carries no sourcepos (raw HTML block)", () => {
    const doc = docOf("<div>\nhi there\n</div>\n");
    const b = block("<div>\nhi there\n</div>");
    const pos = clickPosition({ block: b, caret: { node: findText(b, "\nhi there\n"), offset: 4 }, doc, seg: seg(doc, 1, 4), first: true });
    expect(pos).toBe("<div>\nhi ".length);
  });

  it("stays inside the segment when sourcepos points past it", () => {
    const doc = docOf("# T\n\npara\n\n- a\n");
    const b = block('<p data-sourcepos="3:1-3:4"><em data-sourcepos="9:1-9:4">para</em></p>');
    const s = seg(doc, 3, 4);
    const pos = clickPosition({ block: b, caret: { node: findText(b, "para"), offset: 2 }, doc, seg: s, first: false });
    expect(pos).toBeGreaterThanOrEqual(s.from);
    expect(pos).toBeLessThanOrEqual(s.to);
  });

  it("falls back to the segment start for a caret outside the block", () => {
    const doc = docOf(PARA);
    const b = block(PARA_HTML);
    const outside = document.createTextNode("elsewhere");
    const s = seg(doc, 3, 4);
    expect(clickPosition({ block: b, caret: { node: outside, offset: 3 }, doc, seg: s, first: false })).toBe(s.from);
  });
});

describe("caretAt", () => {
  interface CaretDoc {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  }
  const d = document as unknown as CaretDoc;
  const hadRange = Object.prototype.hasOwnProperty.call(d, "caretRangeFromPoint");
  const hadPosition = Object.prototype.hasOwnProperty.call(d, "caretPositionFromPoint");

  afterEach(() => {
    if (!hadRange) delete d.caretRangeFromPoint;
    if (!hadPosition) delete d.caretPositionFromPoint;
  });

  it("returns null when the platform offers neither API (jsdom)", () => {
    delete d.caretRangeFromPoint;
    delete d.caretPositionFromPoint;
    expect(caretAt(10, 10)).toBeNull();
  });

  it("uses caretRangeFromPoint's start container and offset", () => {
    const text = document.createTextNode("hello");
    d.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(text, 3);
      r.collapse(true);
      return r;
    };
    expect(caretAt(10, 10)).toEqual({ node: text, offset: 3 });
  });

  it("prefers caretPositionFromPoint when available", () => {
    const text = document.createTextNode("hello");
    d.caretRangeFromPoint = () => {
      throw new Error("should not be called");
    };
    d.caretPositionFromPoint = () => ({ offsetNode: text, offset: 4 });
    expect(caretAt(10, 10)).toEqual({ node: text, offset: 4 });
  });
});
