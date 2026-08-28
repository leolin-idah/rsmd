import { describe, expect, it } from "vitest";
import type { BlockRange } from "../ipc";
import { segment, splitBlocks, type RenderedBlock } from "./blocks";

// comrak 0.39 对 "# T\n\npara\n\n- a\n- b\n" 的真实输出
const BASIC_HTML = `<h1 data-sourcepos="1:1-1:3"><a inert href="#t" aria-hidden="true" class="anchor" id="t"></a>T</h1>
<p data-sourcepos="3:1-3:4">para</p>
<ul data-sourcepos="5:1-6:3">
<li data-sourcepos="5:1-5:3">a</li>
<li data-sourcepos="6:1-6:3">b</li>
</ul>
`;
const BASIC_RANGES: BlockRange[] = [
  { from: 1, to: 1, kind: "node" },
  { from: 3, to: 3, kind: "node" },
  { from: 5, to: 6, kind: "node" },
];

describe("splitBlocks", () => {
  it("zips top-level elements with ranges by their sourcepos start line", () => {
    const r = splitBlocks(BASIC_HTML, BASIC_RANGES);
    expect(r.blocks.map((b) => [b.from, b.to, b.html.slice(0, 3)])).toEqual([
      [1, 1, "<h1"],
      [3, 3, "<p "],
      [5, 6, "<ul"],
    ]);
    expect(r.blocks[2].html).toContain("<li data-sourcepos=\"6:1-6:3\">b</li>");
    expect(r.headings).toEqual([{ id: "t", line: 1 }]);
    expect(r.footnotesHtml).toBeNull();
  });

  it("assigns sourcepos-less output to the html block that follows in order", () => {
    // 原生 HTML 块原样输出、无 data-sourcepos；<!-- --> 是 Comment 节点也要归进去
    const html = `<div>x</div>\n<!-- note -->\n<p data-sourcepos="4:1-4:4">para</p>\n`;
    const r = splitBlocks(html, [
      { from: 1, to: 2, kind: "html" },
      { from: 4, to: 4, kind: "node" },
    ]);
    expect(r.blocks[0]).toEqual({ from: 1, to: 2, kind: "html", html: "<div>x</div><!-- note -->" });
    expect(r.blocks[1].from).toBe(4);
  });

  it("lifts the footnotes section out as a trailer and keeps footnote ranges as hidden blocks", () => {
    const html = `<p data-sourcepos="1:1-1:6">hi<sup data-sourcepos="1:3-1:6" class="footnote-ref"><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup></p>
<p data-sourcepos="5:1-5:4">tail</p>
<section data-sourcepos="3:1-4:0" class="footnotes" data-footnotes>
<ol>
<li data-sourcepos="3:1-4:0" id="fn-1"><p data-sourcepos="3:7-3:10">note</p></li>
</ol>
</section>
`;
    // Rust 给的顺序是 AST 顺序（脚注在末尾），splitBlocks 按行排序
    const r = splitBlocks(html, [
      { from: 1, to: 1, kind: "node" },
      { from: 5, to: 5, kind: "node" },
      { from: 3, to: 4, kind: "footnote" },
    ]);
    expect(r.blocks.map((b) => [b.from, b.kind])).toEqual([[1, "node"], [3, "footnote"], [5, "node"]]);
    expect(r.blocks[1].html).toBe("");
    expect(r.footnotesHtml).toMatch(/^<section data-sourcepos="3:1-4:0" class="footnotes"/);
    expect(r.blocks[2].html).toBe('<p data-sourcepos="5:1-5:4">tail</p>');
  });

  it("collects headings nested inside a container block at the block's first line", () => {
    const html = `<blockquote data-sourcepos="2:1-3:5"><h2><a id="q"></a>Q</h2></blockquote>`;
    const r = splitBlocks(html, [{ from: 2, to: 3, kind: "node" }]);
    expect(r.headings).toEqual([{ id: "q", line: 2 }]);
  });

  it("drops node ranges that never matched any element", () => {
    const r = splitBlocks(`<p data-sourcepos="1:1-1:1">a</p>`, [
      { from: 1, to: 1, kind: "node" },
      { from: 9, to: 9, kind: "node" },
    ]);
    expect(r.blocks.map((b) => b.from)).toEqual([1]);
  });
});

describe("segment", () => {
  const block = (from: number, to: number, html = "x"): RenderedBlock => ({ from, to, kind: "node", html });

  it("covers every line: leading gap joins the first block, trailing gaps join the previous block", () => {
    expect(segment([block(2, 2, "a"), block(5, 6, "b")], 9)).toEqual([
      { fromLine: 1, toLine: 4, kind: "node", html: "a" },
      { fromLine: 5, toLine: 9, kind: "node", html: "b" },
    ]);
  });

  it("sorts blocks by line (footnote ranges arrive out of order)", () => {
    const fn: RenderedBlock = { from: 3, to: 4, kind: "footnote", html: "" };
    expect(segment([block(1, 1), block(5, 5), fn], 6).map((s) => [s.fromLine, s.toLine, s.kind])).toEqual([
      [1, 2, "node"],
      [3, 4, "footnote"],
      [5, 6, "node"],
    ]);
  });

  it("clamps to the document length and never emits a segment past the end", () => {
    expect(segment([block(1, 3), block(7, 7)], 2)).toEqual([{ fromLine: 1, toLine: 2, kind: "node", html: "x" }]);
  });

  it("yields nothing for an empty block list", () => {
    expect(segment([], 1)).toEqual([]);
  });
});
