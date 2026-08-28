import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { Heading } from "./blocks";
import type { EditorHandle } from "./markdownEditor";
import { installOutlineSpy, refreshOutline, syncOutline } from "./outline";

const HTML = `
<h1><a href="#intro" class="anchor" id="intro"></a>Intro</h1>
<h2><a href="#setup" class="anchor" id="setup"></a>Setup</h2>
<h2><a href="#deps" class="anchor" id="deps"></a>Deps</h2>`;

/// 假编辑器：只实现 syncOutline 用到的高度图接口。行 n 的文档偏移取 n*100，
/// lineBlockAt 按 `tops` 表返回该行的纵向位置（未列出的行 top=0）。
function fakeEditor(headings: Heading[], tops: Record<number, number>, opts: { lines?: number; scrollTop?: number } = {}) {
  const scrollDOM = document.createElement("div");
  scrollDOM.scrollTop = opts.scrollTop ?? 0;
  const lines = opts.lines ?? 1000;
  const view = {
    scrollDOM,
    state: { doc: { lines, line: (n: number) => ({ from: n * 100 }) } },
    lineBlockAt: vi.fn((from: number) => ({ top: tops[from / 100] ?? 0 })),
  } as unknown as EditorView;
  const handle = { view, headings: vi.fn(() => headings) } as unknown as EditorHandle;
  return { handle, view, scrollDOM, lineBlockAt: view.lineBlockAt as unknown as ReturnType<typeof vi.fn> };
}

const heads = (...ids: Array<[string, number]>): Heading[] =>
  ids.map(([id, line]) => ({ id, line, level: 1, text: id }) as unknown as Heading);

const links = (pane: HTMLElement) => Array.from(pane.querySelectorAll<HTMLElement>("nav.toc a"));
const activeIds = (pane: HTMLElement) =>
  links(pane)
    .filter((a) => a.classList.contains("active"))
    .map((a) => a.dataset.target);

describe("refreshOutline", () => {
  let pane: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    pane = document.createElement("div");
    document.body.appendChild(pane);
  });

  it("appends a nav.toc built from the rendered html", () => {
    refreshOutline(pane, HTML);
    expect(links(pane).map((a) => a.dataset.target)).toEqual(["intro", "setup", "deps"]);
  });

  it("replaces the previous outline instead of stacking a second one", () => {
    refreshOutline(pane, HTML);
    refreshOutline(pane, `<h1><a id="only"></a>Only</h1>`);
    expect(pane.querySelectorAll("nav.toc")).toHaveLength(1);
    expect(links(pane).map((a) => a.dataset.target)).toEqual(["only"]);
  });

  it("drops the outline when the new html has no headings", () => {
    refreshOutline(pane, HTML);
    refreshOutline(pane, "<p>plain</p>");
    expect(pane.querySelector("nav.toc")).toBeNull();
  });

  it("does not run scripts or fetch anything from the html it parses", () => {
    // innerHTML 解析不执行 <script>；断言此处防止将来改用会执行脚本的方式挂载
    refreshOutline(pane, `<h1><a id="a"></a>A</h1><script>globalThis.__pwned = true;</script>`);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe("syncOutline", () => {
  let pane: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    pane = document.createElement("div");
    document.body.appendChild(pane);
    refreshOutline(pane, HTML);
  });

  it("highlights the last heading scrolled past the threshold", () => {
    const { handle } = fakeEditor(heads(["intro", 1], ["setup", 10], ["deps", 40]), { 1: 0, 10: 500, 40: 1200 }, {
      scrollTop: 600,
    });
    syncOutline(pane, handle);
    expect(activeIds(pane)).toEqual(["setup"]);
  });

  it("moves the highlight as the scroll position changes", () => {
    const f = fakeEditor(heads(["intro", 1], ["setup", 10], ["deps", 40]), { 1: 0, 10: 500, 40: 1200 });
    syncOutline(pane, f.handle);
    expect(activeIds(pane)).toEqual(["intro"]);
    f.scrollDOM.scrollTop = 1300;
    syncOutline(pane, f.handle);
    expect(activeIds(pane)).toEqual(["deps"]);
  });

  it("clamps heading lines to the document so a stale index cannot throw", () => {
    // headings() 来自上一次渲染，可能领先/落后于当前 doc（外部同步、快速输入）
    const f = fakeEditor(heads(["intro", 0], ["setup", 999]), { 1: 0, 3: 900 }, { lines: 3 });
    expect(() => syncOutline(pane, f.handle)).not.toThrow();
    expect(f.lineBlockAt.mock.calls.map((c) => c[0])).toEqual([100, 300]);
  });

  it("is a no-op without an editor or without an outline", () => {
    expect(() => syncOutline(pane, null)).not.toThrow();
    expect(activeIds(pane)).toEqual([]);
    const bare = document.createElement("div");
    const f = fakeEditor(heads(["intro", 1]), { 1: 0 });
    syncOutline(bare, f.handle);
    expect(f.handle.headings).not.toHaveBeenCalled();
  });
});

describe("installOutlineSpy", () => {
  let pane: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    pane = document.createElement("div");
    document.body.appendChild(pane);
    refreshOutline(pane, HTML);
  });

  /// 让已排队的 rAF 回调跑完（本测试的回调先入队，故此 Promise 后于它 resolve）
  const flushFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  it("coalesces a burst of scroll events into a single sync per frame", async () => {
    const f = fakeEditor(heads(["intro", 1], ["setup", 10]), { 1: 0, 10: 500 });
    installOutlineSpy(pane, f.handle);
    f.scrollDOM.dispatchEvent(new Event("scroll"));
    f.scrollDOM.dispatchEvent(new Event("scroll"));
    f.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(f.handle.headings).not.toHaveBeenCalled(); // 同步阶段不测量
    await flushFrame();
    expect(f.handle.headings).toHaveBeenCalledTimes(1);
    expect(activeIds(pane)).toEqual(["intro"]);
  });

  it("subscribes a pane only once (StrictMode double-mount)", async () => {
    const f = fakeEditor(heads(["intro", 1]), { 1: 0 });
    installOutlineSpy(pane, f.handle);
    installOutlineSpy(pane, f.handle);
    f.scrollDOM.dispatchEvent(new Event("scroll"));
    await flushFrame();
    expect(f.handle.headings).toHaveBeenCalledTimes(1);
  });
});
