import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Segment } from "./blocks";
import {
  blockWidgets,
  blocksField,
  buildDecorations,
  pruneCache,
  revealed,
  segmentIndexAt,
  setBlocks,
  toPositions,
  type BlockModel,
  type WidgetCache,
} from "./blockWidgets";
import { enhance } from "../preview/enhance";

// enhance 会拉起 mermaid/shiki/katex：本单元测试只关心 DOM 池的认领/归还与"每个池元素只增强一次"
vi.mock("../preview/enhance", () => ({ enhance: vi.fn(() => Promise.resolve()) }));
const enhanceMock = vi.mocked(enhance);

// 7 行（尾部空行）：1 "# T" [0,3]  2 "" [4,4]  3 "para" [5,9]  4 "" [10,10]  5 "- a" [11,14]  6 "- b" [15,18]  7 "" [19,19]
const DOC = "# T\n\npara\n\n- a\n- b\n";
const SEGS: Segment[] = [
  { fromLine: 1, toLine: 2, kind: "node", html: "<h1>T</h1>" },
  { fromLine: 3, toLine: 4, kind: "node", html: "<p>para</p>" },
  { fromLine: 5, toLine: 7, kind: "node", html: "<ul></ul>" },
];

function make(editable: boolean, head = 0, model: BlockModel = { segments: SEGS, footnotesHtml: null }) {
  const base = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(head),
    extensions: [blockWidgets(new Map()), EditorView.editable.of(editable), EditorState.readOnly.of(!editable)],
  });
  return base.update({ effects: setBlocks.of(model) }).state;
}

interface Deco {
  from: number;
  to: number;
  widget: boolean;
}
function decos(state: EditorState): Deco[] {
  const out: Deco[] = [];
  buildDecorations(state, new Map()).between(0, state.doc.length, (from, to, d) => {
    out.push({ from, to, widget: d.spec.widget !== undefined });
  });
  return out;
}

const views: EditorView[] = [];
function makeView(editable: boolean, head = 0, model: BlockModel = { segments: SEGS, footnotesHtml: null }, cache: WidgetCache = new Map()) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(head),
      extensions: [blockWidgets(cache), EditorView.editable.of(editable), EditorState.readOnly.of(!editable)],
    }),
    parent,
  });
  view.dispatch({ effects: setBlocks.of(model) });
  views.push(view);
  return view;
}

/// widget 的 ignoreEvent 让 CM 丢弃块内事件，reveal 走的是 contentDOM 上的原生监听，
/// 所以测试必须让事件真实冒泡，而不是调用 CM 的事件处理器
function mousedown(target: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function keydown(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/// jsdom 没有 caretRangeFromPoint：临时装一个总是返回 (node, offset) 的实现，模拟浏览器按坐标算出的插入点
function withCaret(node: Node, offset: number, run: () => void): void {
  const d = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  d.caretRangeFromPoint = () => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    return r;
  };
  try {
    run();
  } finally {
    delete d.caretRangeFromPoint;
  }
}

afterEach(() => {
  for (const v of views.splice(0)) {
    v.destroy();
    v.dom.parentElement?.remove();
  }
  enhanceMock.mockClear();
});

describe("blocksField", () => {
  it("converts line segments to whole-line character positions", () => {
    expect(make(false).field(blocksField).segments.map((s) => [s.from, s.to])).toEqual([
      [0, 4],
      [5, 10],
      [11, 19],
    ]);
  });

  it("follows edits: typing at the end of a segment grows that segment and shifts the rest", () => {
    const s1 = make(true, 9).update({ changes: { from: 9, insert: "!" } }).state;
    expect(s1.field(blocksField).segments.map((s) => [s.from, s.to])).toEqual([
      [0, 4],
      [5, 11],
      [12, 20],
    ]);
  });

  it("typing at the very start of a segment keeps the text in that segment", () => {
    const s1 = make(true, 5).update({ changes: { from: 5, insert: "x" } }).state;
    expect(s1.field(blocksField).segments[1]).toMatchObject({ from: 5, to: 11 });
    expect(s1.field(blocksField).segments[0]).toMatchObject({ from: 0, to: 4 });
  });

  it("replaces the whole model on a later setBlocks", () => {
    const s1 = make(false).update({
      effects: setBlocks.of({
        segments: [{ fromLine: 1, toLine: 7, kind: "node", html: "<p>all</p>" }],
        footnotesHtml: "<section>fn</section>",
      }),
    }).state;
    expect(s1.field(blocksField).segments.map((s) => [s.from, s.to])).toEqual([[0, 19]]);
    expect(s1.field(blocksField).footnotesHtml).toBe("<section>fn</section>");
  });
});

describe("toPositions", () => {
  it("drops segments starting past the end of the doc and clamps an overlong end", () => {
    const doc = make(false).doc;
    const model: BlockModel = {
      segments: [
        { fromLine: 5, toLine: 99, kind: "node", html: "a" },
        { fromLine: 8, toLine: 9, kind: "node", html: "b" },
      ],
      footnotesHtml: null,
    };
    expect(toPositions(model, doc).map((s) => [s.from, s.to])).toEqual([[11, 19]]);
  });

  it("clamps toLine back up to fromLine when the model has them inverted", () => {
    const doc = make(false).doc;
    const model: BlockModel = { segments: [{ fromLine: 3, toLine: 1, kind: "node", html: "a" }], footnotesHtml: null };
    expect(toPositions(model, doc).map((s) => [s.from, s.to])).toEqual([[5, 9]]);
  });
});

describe("revealed / segmentIndexAt", () => {
  it("reveals nothing while read-only", () => {
    const s = make(false, 6);
    expect(revealed(s.field(blocksField).segments, s.selection, false)).toEqual([false, false, false]);
  });

  it("reveals the segment holding the cursor, including a cursor exactly at its end", () => {
    const s = make(true, 4); // 第 2 行（空行）行尾 = 段 1 的 to
    expect(revealed(s.field(blocksField).segments, s.selection, true)).toEqual([true, false, false]);
    expect(segmentIndexAt(s.field(blocksField).segments, 5)).toBe(1);
  });

  it("reveals every segment a range selection touches", () => {
    const s = make(true).update({ selection: EditorSelection.create([EditorSelection.range(2, 12)]) }).state;
    expect(revealed(s.field(blocksField).segments, s.selection, true)).toEqual([true, true, true]);
  });

  it("reports -1 for a position outside every segment", () => {
    expect(segmentIndexAt([], 0)).toBe(-1);
    const segs = make(false).field(blocksField).segments;
    expect(segmentIndexAt(segs, 20)).toBe(-1);
  });
});

describe("buildDecorations", () => {
  it("read-only: every segment becomes one block widget", () => {
    expect(decos(make(false))).toEqual([
      { from: 0, to: 4, widget: true },
      { from: 5, to: 10, widget: true },
      { from: 11, to: 19, widget: true },
    ]);
  });

  it("editable: the cursor's segment is left undecorated (source shows through)", () => {
    expect(decos(make(true, 7)).map((d) => d.from)).toEqual([0, 11]);
  });

  it("footnote segments are invisible replacements and the section is a trailing widget at doc end", () => {
    const model: BlockModel = {
      segments: [
        { fromLine: 1, toLine: 2, kind: "node", html: "<p>a</p>" },
        { fromLine: 3, toLine: 7, kind: "footnote", html: "" },
      ],
      footnotesHtml: "<section>fn</section>",
    };
    expect(decos(make(false, 0, model))).toEqual([
      { from: 0, to: 4, widget: true },
      { from: 5, to: 19, widget: false },
      { from: 19, to: 19, widget: true },
    ]);
  });

  it("snaps a segment whose mapped end fell mid-line back to the line end", () => {
    // 删掉第 4、5 行之间的换行：段 2 的 to 落到行中，段 3 的 from 也不再是行首
    const s = make(true, 0).update({ changes: { from: 10, to: 11 } }).state;
    for (const d of decos(s)) {
      expect(s.doc.lineAt(d.from).from).toBe(d.from);
      expect(s.doc.lineAt(d.to).to).toBe(d.to);
    }
  });

  it("skips a segment that a merging edit pushed into the previous one (no overlapping block decorations)", () => {
    const s = make(true, 0).update({ changes: { from: 10, to: 11 } }).state;
    // 段 2、段 3 合并到同一行上，只能出装饰一条：CM 不接受重叠的 block 装饰
    expect(decos(s)).toEqual([{ from: 5, to: 13, widget: true }]);
  });
});

describe("widget DOM pool", () => {
  function widgetsOf(state: EditorState, cache: WidgetCache) {
    const out: { toDOM: () => HTMLElement; destroy: (dom: HTMLElement) => void }[] = [];
    buildDecorations(state, cache).between(0, state.doc.length, (_f, _t, d) => {
      const w = d.spec.widget;
      if (w) out.push(w);
    });
    return out;
  }

  const twin: BlockModel = {
    segments: [
      { fromLine: 1, toLine: 2, kind: "node", html: "<p>same</p>" },
      { fromLine: 3, toLine: 4, kind: "node", html: "<p>same</p>" },
    ],
    footnotesHtml: null,
  };

  it("gives two same-html blocks distinct elements even before either is inserted", () => {
    // CM 在一次更新里先为所有新 widget 调 toDOM、之后才挂载，所以不能按 isConnected 判空闲
    const cache: WidgetCache = new Map();
    const [a, b] = widgetsOf(make(false, 0, twin), cache);
    const da = a.toDOM();
    const db = b.toDOM();
    expect(da).not.toBe(db);
    expect(cache.get("<p>same</p>")).toHaveLength(2);
    expect(enhanceMock).toHaveBeenCalledTimes(2);
    expect(da.className).toBe("markdown-body rsmd-block");
    expect(da.innerHTML).toBe("<p>same</p>");
  });

  it("reuses a released element instead of re-enhancing it", () => {
    const cache: WidgetCache = new Map();
    const [a] = widgetsOf(make(false, 0, twin), cache);
    const first = a.toDOM();
    a.destroy(first);
    enhanceMock.mockClear();
    const again = a.toDOM();
    expect(again).toBe(first);
    expect(cache.get("<p>same</p>")).toHaveLength(1);
    expect(enhanceMock).not.toHaveBeenCalled();
  });

  it("keeps a claimed element even after CM detaches it from the document", () => {
    const cache: WidgetCache = new Map();
    const [a, b] = widgetsOf(make(false, 0, twin), cache);
    const da = a.toDOM();
    document.body.appendChild(da);
    da.remove(); // 卸载但未 destroy：仍属 a，b 不得别名到它
    expect(b.toDOM()).not.toBe(da);
  });

  it("pruneCache drops the html no longer present and keeps the rest", () => {
    const cache: WidgetCache = new Map([
      ["<p>a</p>", [document.createElement("div")]],
      ["<p>b</p>", [document.createElement("div")]],
    ]);
    pruneCache(cache, ["<p>b</p>"]);
    expect([...cache.keys()]).toEqual(["<p>b</p>"]);
  });

  it("stops enhance from writing into an element that was pruned away", () => {
    const cache: WidgetCache = new Map();
    const [a] = widgetsOf(make(false, 0, twin), cache);
    a.toDOM();
    const isCurrent = enhanceMock.mock.calls[0][1]; // enhance 的 isCurrent 形参有默认值，故类型可选
    expect(isCurrent?.()).toBe(true);
    pruneCache(cache, []);
    expect(isCurrent?.()).toBe(false);
  });
});

describe("click to reveal", () => {
  const LINKED: BlockModel = {
    segments: [
      { fromLine: 1, toLine: 2, kind: "node", html: "<h1>T</h1>" },
      { fromLine: 3, toLine: 4, kind: "node", html: "<p><a href=\"x\">l</a></p>" },
      { fromLine: 5, toLine: 7, kind: "node", html: "<ul></ul>" },
    ],
    footnotesHtml: null,
  };

  it("moves the cursor into the clicked block, which then shows its source", () => {
    const view = makeView(true, 0);
    const blocks = view.contentDOM.querySelectorAll<HTMLElement>(".rsmd-block");
    expect(blocks).toHaveLength(2); // 光标所在段 1 已露出源码
    mousedown(blocks[1]);
    expect(view.state.selection.main.head).toBe(11);
    expect(revealed(view.state.field(blocksField).segments, view.state.selection, true)).toEqual([false, false, true]);
  });

  it("does nothing while read-only", () => {
    const view = makeView(false, 0);
    const blocks = view.contentDOM.querySelectorAll<HTMLElement>(".rsmd-block");
    expect(blocks).toHaveLength(3);
    const e = mousedown(blocks[2]);
    expect(view.state.selection.main.head).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves a cmd+click on a link alone so links.ts can follow it", () => {
    const view = makeView(true, 0, LINKED);
    const link = view.contentDOM.querySelector<HTMLElement>(".rsmd-block a");
    expect(link).not.toBeNull();
    const e = mousedown(link!, { metaKey: true });
    expect(view.state.selection.main.head).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("still reveals on a plain click on a link", () => {
    const view = makeView(true, 0, LINKED);
    const link = view.contentDOM.querySelector<HTMLElement>(".rsmd-block a")!;
    mousedown(link);
    expect(view.state.selection.main.head).toBe(5);
  });

  it("puts the cursor at the clicked character when the platform reports a caret position", () => {
    const model: BlockModel = {
      segments: [
        { fromLine: 1, toLine: 2, kind: "node", html: '<h1 data-sourcepos="1:1-1:3">T</h1>' },
        { fromLine: 3, toLine: 4, kind: "node", html: '<p data-sourcepos="3:1-3:4">para</p>' },
        {
          fromLine: 5,
          toLine: 7,
          kind: "node",
          html: '<ul data-sourcepos="5:1-6:3"><li data-sourcepos="5:1-5:3">a</li><li data-sourcepos="6:1-6:3">b</li></ul>',
        },
      ],
      footnotesHtml: null,
    };
    const view = makeView(true, 0, model);
    const li = view.contentDOM.querySelectorAll<HTMLElement>(".rsmd-block li")[1];
    withCaret(li.firstChild!, 1, () => mousedown(li, { clientX: 40, clientY: 90 }));
    expect(view.state.selection.main.head).toBe(18); // 第 6 行 "- b" 的 b 之后
  });

  it("keeps the footnotes trailer's old behaviour: cursor at the end of the document", () => {
    const model: BlockModel = {
      segments: SEGS,
      footnotesHtml: '<section data-sourcepos="7:1-7:0" class="footnotes"><ol><li id="fn-1"><p>note</p></li></ol></section>',
    };
    const view = makeView(true, 0, model);
    const p = view.contentDOM.querySelector<HTMLElement>(".footnotes p")!;
    withCaret(p.firstChild!, 2, () => mousedown(p));
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("ignores a mousedown on bare source text (CM keeps handling it)", () => {
    const view = makeView(true, 0);
    const line = view.contentDOM.querySelector<HTMLElement>(".cm-line")!;
    mousedown(line);
    // 光标不被带到别的段（reveal 会跳到某个 widget 段的段首）；落点由 CM 自己的 mousedown 决定，
    // jsdom 无布局所以不断言具体位置。CM 的选区拖拽本身会 preventDefault，该标志无法区分两条路径。
    expect(segmentIndexAt(view.state.field(blocksField).segments, view.state.selection.main.head)).toBe(0);
  });
});

// jsdom 无布局：view.moveVertically 从段中直接落到文档首/尾，永远"离开本段"，
// 所以这里只能验证跨段那条分支；软换行段落内部不跨段的分支需要真实布局，无法在此断言
describe("arrow keys across segments", () => {
  it("ArrowDown from the revealed segment lands at the start of the next one", () => {
    const view = makeView(true, 7);
    keydown(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(11);
  });

  it("ArrowUp lands on the last line of the previous segment", () => {
    const view = makeView(true, 7);
    keydown(view, "ArrowUp");
    expect(view.state.selection.main.head).toBe(4); // 段 1 末行（空行）行首
  });

  it("does not move past the first or last segment", () => {
    const first = makeView(true, 0);
    keydown(first, "ArrowUp");
    expect(first.state.selection.main.head).toBe(0);
    const last = makeView(true, 19);
    keydown(last, "ArrowDown");
    expect(last.state.selection.main.head).toBe(19);
  });

  it("does nothing while read-only", () => {
    const view = makeView(false, 7);
    keydown(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(7);
  });
});
