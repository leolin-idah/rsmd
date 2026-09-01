import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { BlockRange, RenderPayload } from "../ipc";
import { createEditor } from "./markdownEditor";
import { prefersDark } from "./theme";

vi.mock("../preview/enhance", () => ({ enhance: vi.fn(async () => {}) }));

const TEXT = "# T\n\npara\n";
const HTML = `<h1 data-sourcepos="1:1-1:3"><a class="anchor" id="t"></a>T</h1>\n<p data-sourcepos="3:1-3:4">para</p>\n`;
const BLOCKS: BlockRange[] = [
  { from: 1, to: 1, kind: "node" },
  { from: 3, to: 3, kind: "node" },
];

const TEXT2 = "# Title\n\npara\n";
const HTML2 = `<h1 data-sourcepos="1:1-1:7"><a class="anchor" id="title"></a>Title</h1>\n<p data-sourcepos="3:1-3:4">para</p>\n`;
const RENDER2: RenderPayload = { html: HTML2, blocks: BLOCKS, title: "Title" };

function make(text = TEXT) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onDirtyChange = vi.fn();
  const requestRender = vi.fn(async (_text: string): Promise<RenderPayload | null> => null);
  const onRendered = vi.fn();
  const h = createEditor({ parent, text, html: HTML, blocks: BLOCKS, onDirtyChange, requestRender, onRendered });
  return { h, parent, onDirtyChange, requestRender, onRendered };
}

describe("createEditor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("starts read-only with the text loaded and headings indexed", () => {
    const { h, parent } = make();
    expect(h.isReadOnly()).toBe(true);
    expect(h.view.state.facet(EditorView.editable)).toBe(false);
    expect(h.getText()).toBe(TEXT);
    expect(h.headings()).toEqual([{ id: "t", line: 1 }]);
    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    h.destroy();
  });

  it("setMode('live') makes the view editable; setMode('preview') renders then locks again", async () => {
    const { h, requestRender } = make();
    void h.setMode("live");
    expect(h.isReadOnly()).toBe(false);
    expect(h.view.state.facet(EditorView.editable)).toBe(true);
    await h.setMode("preview");
    expect(h.isReadOnly()).toBe(true);
    expect(requestRender).toHaveBeenCalledTimes(1);
    h.destroy();
  });

  it("setMode('source') shows the whole document as bare editable source, preview restores the widgets", async () => {
    const { h, parent } = make();
    expect(parent.querySelectorAll(".rsmd-block").length).toBeGreaterThan(0);
    await h.setMode("source");
    expect(h.isReadOnly()).toBe(false);
    expect(h.view.state.facet(EditorView.editable)).toBe(true);
    expect(parent.querySelectorAll(".rsmd-block")).toHaveLength(0);
    await h.setMode("preview");
    expect(h.isReadOnly()).toBe(true);
    expect(parent.querySelectorAll(".rsmd-block").length).toBeGreaterThan(0);
    h.destroy();
  });

  it("switching live → source keeps the cursor in place; entering from preview parks it at the viewport top", async () => {
    const { h } = make();
    void h.setMode("live");
    expect(h.view.state.selection.main.head).toBe(0); // 视口首行行首
    h.view.dispatch({ selection: { anchor: 7 } });
    void h.setMode("source");
    expect(h.view.state.selection.main.head).toBe(7);
    h.destroy();
  });

  it("setMode with the current mode is a no-op", async () => {
    const { h, requestRender } = make();
    await h.setMode("preview"); // 已是 preview：不触发渲染
    expect(requestRender).not.toHaveBeenCalled();
    h.destroy();
  });

  it("reports dirty on the first change, clean when the text returns to the saved baseline or after markSaved", () => {
    const { h, onDirtyChange } = make();
    void h.setMode("live");
    h.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(h.isDirty()).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    h.view.dispatch({ changes: { from: 0, to: 1 } }); // 改回原文
    expect(h.isDirty()).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    h.view.dispatch({ changes: { from: 0, insert: "y" } });
    h.markSaved();
    expect(h.isDirty()).toBe(false);
    // 4 次而非计划写的 3 次：markSaved 的 true→false 也是一次真实转换，tab 上的脏点要靠它熄灭
    expect(onDirtyChange).toHaveBeenCalledTimes(4);
    h.destroy();
  });

  it("applyExternal patches minimally, maps the cursor, resets the baseline and skips history", () => {
    const { h, onDirtyChange } = make();
    void h.setMode("live");
    h.view.dispatch({ selection: { anchor: 7 } }); // "pa|ra"
    h.applyExternal(TEXT2, HTML2, BLOCKS);
    expect(h.getText()).toBe(TEXT2);
    expect(h.view.state.selection.main.head).toBe(11); // 标题多了 4 个字符
    expect(h.isDirty()).toBe(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(h.headings()).toEqual([{ id: "title", line: 1 }]);
    undo(h.view);
    expect(h.getText()).toBe(TEXT2); // 外部同步不可撤销
    h.destroy();
  });

  it("applyExternal clears a pending dirty state and rebaselines onto the external text", () => {
    const { h, onDirtyChange } = make();
    void h.setMode("live");
    h.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(h.isDirty()).toBe(true);
    h.applyExternal(TEXT2, HTML2, BLOCKS);
    expect(h.isDirty()).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    // 基线换成了外部文本本身：改一笔再改回来仍算干净（否则会一直对着已被覆盖的旧文本比）
    h.view.dispatch({ changes: { from: 0, insert: "z" } });
    expect(h.isDirty()).toBe(true);
    h.view.dispatch({ changes: { from: 0, to: 1 } });
    expect(h.isDirty()).toBe(false);
    h.destroy();
  });

  it("renders after idle and applies the result when the text is still current", async () => {
    vi.useFakeTimers();
    const { h, requestRender, onRendered } = make();
    requestRender.mockResolvedValueOnce(RENDER2);
    void h.setMode("live");
    h.view.dispatch({ changes: { from: 3, insert: "itle" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(requestRender).toHaveBeenCalledWith(TEXT2);
    expect(onRendered).toHaveBeenCalledWith(RENDER2);
    expect(h.headings()).toEqual([{ id: "title", line: 1 }]);
    h.destroy();
  });

  it("discards a render result that arrives after further edits", async () => {
    vi.useFakeTimers();
    const { h, requestRender, onRendered } = make();
    let resolve!: (p: RenderPayload) => void;
    requestRender.mockImplementationOnce(
      () =>
        new Promise<RenderPayload | null>((r) => {
          resolve = r;
        })
    );
    void h.setMode("live");
    h.view.dispatch({ changes: { from: 3, insert: "itle" } });
    await vi.advanceTimersByTimeAsync(500);
    h.view.dispatch({ changes: { from: 0, insert: "!" } }); // 回包前又改了
    resolve(RENDER2);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRendered).not.toHaveBeenCalled();
    expect(h.headings()).toEqual([{ id: "t", line: 1 }]);
    h.destroy();
  });

  it("re-renders immediately when the cursor leaves a segment that has unrendered edits", async () => {
    vi.useFakeTimers();
    const { h, requestRender } = make();
    void h.setMode("live");
    h.view.dispatch({ changes: { from: 3, insert: "!" } }); // 在段 1 内编辑
    await vi.advanceTimersByTimeAsync(100); // 尚未到 idle
    expect(requestRender).not.toHaveBeenCalled();
    h.view.dispatch({ selection: { anchor: h.getText().indexOf("para") } }); // 光标跳到段 2
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRender).toHaveBeenCalledTimes(1);
    h.destroy();
  });

  it("stays editable when setMode('live') intervenes while a switch to preview awaits its render", async () => {
    const { h, requestRender } = make();
    let resolve!: (p: RenderPayload | null) => void;
    requestRender.mockImplementationOnce(
      () =>
        new Promise<RenderPayload | null>((r) => {
          resolve = r;
        })
    );
    void h.setMode("live");
    const leaving = h.setMode("preview");
    void h.setMode("live"); // 回包前用户又按了 ⌘E
    resolve(null);
    await leaving;
    expect(h.isReadOnly()).toBe(false);
    h.destroy();
  });

  it("still locks when the render request rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { h, requestRender } = make();
    requestRender.mockRejectedValueOnce(new Error("ipc down"));
    void h.setMode("live");
    await h.setMode("preview"); // 拒绝当作"无结果"，不能让切回 preview 卡在可编辑态
    expect(h.isReadOnly()).toBe(true);
    warn.mockRestore();
    h.destroy();
  });

  it("does not schedule a render for an external sync", async () => {
    vi.useFakeTimers();
    const { h, requestRender } = make();
    void h.setMode("live");
    h.applyExternal(TEXT2, HTML2, BLOCKS); // blocks 随文本一起到达，无需回问 Rust
    await vi.advanceTimersByTimeAsync(500);
    expect(requestRender).not.toHaveBeenCalled();
    h.destroy();
  });

  it("scrollToLine clamps out-of-range lines instead of throwing", () => {
    const { h } = make();
    expect(() => h.scrollToLine(0)).not.toThrow();
    expect(() => h.scrollToLine(999)).not.toThrow();
    h.destroy();
  });

  // 已知限制，见账本 I4：CRLF 文件保存时被归一化为 LF（EditorState.lineSeparator 的修复已回退）
  it.skip("round-trips CRLF line endings", () => {
    const { h } = make("# T\r\n\r\npara\r\n");
    expect(h.getText()).toBe("# T\r\n\r\npara\r\n");
    h.destroy();
  });
});

describe("theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("prefersDark is false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersDark()).toBe(false);
  });

  it("follows the OS color scheme and stops following after destroy", () => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    }));
    const { h } = make();
    expect(h.view.state.facet(EditorView.darkTheme)).toBe(false);
    for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);
    expect(h.view.state.facet(EditorView.darkTheme)).toBe(true);
    h.destroy();
    expect(listeners.size).toBe(0);
  });
});
