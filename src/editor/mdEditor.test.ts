import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Highlighter } from "shiki";

vi.mock("../ipc", () => ({ assetUrl: (p: string) => `asset://localhost${p}` }));

import { createEditor, type EditorHandle, type EditorOptions } from "./mdEditor";
import type { PmEditor } from "./pmEditor";
import type { SourceEditor } from "./sourceEditor";

// 假 shiki：不加载任何语言，避免测试里拉起真实高亮器
const highlighter = {
  getLoadedLanguages: () => [] as string[],
  getLoadedThemes: () => ["github-light", "github-dark"],
  loadLanguage: vi.fn(async () => {}),
  codeToTokens: vi.fn(() => ({ tokens: [], fg: "", bg: "" })),
} as unknown as Highlighter;

let handle: EditorHandle | null = null;
const cbs = {
  onDirtyChange: vi.fn(),
  onTitleChange: vi.fn(),
  onHeadingsChange: vi.fn(),
  onStatsChange: vi.fn(),
  onOpenLink: vi.fn(),
};

async function open(text: string, overrides: Partial<EditorOptions> = {}): Promise<EditorHandle> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  handle = await createEditor({
    parent,
    text,
    baseDir: "/docs",
    highlighter,
    exposeInternals: (i) => {
      internals = i;
    },
    ...cbs,
    ...overrides,
  });
  return handle;
}
const pmView = (parent: HTMLElement) => parent.querySelector<HTMLElement>(".milkdown .ProseMirror")!;
const cmText = (parent: HTMLElement) => parent.querySelector<HTMLElement>(".cm-content")!.textContent ?? "";
// 经 exposeInternals 拿到两个引擎的视图，用来模拟输入
let internals: { pm: PmEditor; cm(): SourceEditor | null } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.useRealTimers();
});

const ORIGINAL = "# Title\n\n* a\n* b\n";
// 与 mdEditor.ts 的 DIRTY_DEBOUNCE_MS 同值
const DIRTY_DEBOUNCE_MS = 300;

describe("createEditor", () => {
  it("opens clean in preview with the milkdown host visible", async () => {
    const h = await open(ORIGINAL);
    expect(h.getMode()).toBe("preview");
    expect(h.isDirty()).toBe(false);
    expect(h.getText().trim()).toBe("# Title\n\n- a\n- b");
    const host = document.querySelector<HTMLElement>(".milkdown")!;
    expect(host.hidden).toBe(false);
    expect(pmView(host).getAttribute("contenteditable")).toBe("false");
    expect(h.headings()).toEqual([{ id: "title", text: "Title", level: 1 }]);
  });

  it("live typing marks dirty; markSaved clears it", async () => {
    const h = await open(ORIGINAL);
    h.setMode("live");
    const parent = document.querySelector<HTMLElement>(".milkdown")!.parentElement!;
    expect(pmView(parent).getAttribute("contenteditable")).toBe("true");
    const view = internals!.pm.view();
    view.dispatch(view.state.tr.insertText("!", 6)); // "Title" 末尾
    expect(h.isDirty()).toBe(true);
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(h.getText()).toContain("# Title!");
    h.markSaved(h.getText());
    expect(h.isDirty()).toBe(false);
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("recomputes dirty once at the start of a burst and once after it settles", async () => {
    const h = await open(ORIGINAL);
    h.setMode("live");
    const view = internals!.pm.view();
    const serialize = vi.spyOn(internals!.pm, "getMarkdown");
    // 连打三下：只有第一下同步重算，脏位立刻上报（⌘W 守卫读的就是这个）
    for (let i = 0; i < 3; i++) view.dispatch(view.state.tr.insertText("!", 6 + i));
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(true);
    // 停手后补算一次：这里把改动删回原文，尾部重算要把 ● 清掉
    view.dispatch(view.state.tr.delete(6, 9));
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(DIRTY_DEBOUNCE_MS);
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(h.isDirty()).toBe(false);
  });

  it("recomputes immediately when an edit lands right after markSaved inside the debounce window", async () => {
    const h = await open(ORIGINAL);
    h.setMode("live");
    const view = internals!.pm.view();
    view.dispatch(view.state.tr.insertText("!", 6));
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(true);
    // 保存落在防抖窗口内：脏位被清成 false，尾部定时器还挂着
    h.markSaved(h.getText());
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(false);
    // 紧接着再打一下（仍在 300ms 内）：必须同步重算，否则 ⌘W 守卫 / Save 会读到过期的"不脏"
    view.dispatch(view.state.tr.insertText("?", 7));
    expect(cbs.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(h.isDirty()).toBe(true);
  });

  it("entering source from a clean doc shows the original bytes and hides the milkdown host", async () => {
    const h = await open(ORIGINAL);
    h.setMode("source");
    const parent = document.querySelector<HTMLElement>(".milkdown")!.parentElement!;
    expect(document.querySelector<HTMLElement>(".milkdown")!.hidden).toBe(true);
    expect(parent.querySelector<HTMLElement>(".cm-editor")!.style.display).toBe("");
    expect(cmText(parent)).toContain("* a");
    expect(h.getText()).toBe(ORIGINAL);
    expect(h.isDirty()).toBe(false);
  });

  it("source edits are dirty by bytes and flow back into live on return", async () => {
    const h = await open(ORIGINAL);
    h.setMode("source");
    const cm = internals!.cm()!.view;
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: "* c\n" } });
    expect(h.isDirty()).toBe(true);
    expect(h.getText()).toBe(ORIGINAL + "* c\n");
    h.markSaved(h.getText());
    expect(h.isDirty()).toBe(false);
    h.setMode("live");
    expect(document.querySelector<HTMLElement>(".milkdown")!.hidden).toBe(false);
    expect(h.getText().trim()).toBe("# Title\n\n- a\n- b\n- c");
    expect(h.isDirty()).toBe(false);
  });

  it("leaving source with changes shows exactly one milkdown host and hides the CM view", async () => {
    const h = await open(ORIGINAL);
    const parent = document.querySelector<HTMLElement>(".milkdown")!.parentElement!;
    h.setMode("source");
    const cm = internals!.cm()!.view;
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: "* c\n" } });
    h.setMode("live");
    // switchMode 走 pmReplace，core 会换掉 .milkdown 容器：旧引用作废，可见性要落在新容器上
    const hosts = parent.querySelectorAll<HTMLElement>(".milkdown");
    expect(hosts.length).toBe(1);
    expect(internals!.pm.host).toBe(hosts[0]);
    expect(hosts[0].isConnected).toBe(true);
    expect(hosts[0].hidden).toBe(false);
    const cmEl = parent.querySelector<HTMLElement>(".cm-editor")!;
    expect(cmEl.style.display).toBe("none");
    // CM6 baseTheme 的 `display: flex !important` 只能被内联 !important 压住（见 sourceEditor.show）
    expect(cmEl.style.getPropertyPriority("display")).toBe("important");
    // 滚动中继要跟到重建后的那个容器上
    const cb = vi.fn();
    h.onScroll(cb);
    hosts[0].dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("applyExternal keeps the milkdown host valid", async () => {
    const h = await open(ORIGINAL);
    const parent = document.querySelector<HTMLElement>(".milkdown")!.parentElement!;
    h.applyExternal("# New\n\ntext\n");
    const hosts = parent.querySelectorAll<HTMLElement>(".milkdown");
    expect(hosts.length).toBe(1);
    expect(internals!.pm.host).toBe(hosts[0]);
    expect(hosts[0].isConnected).toBe(true);
    expect(hosts[0].hidden).toBe(false);
    expect(() => h.scrollTop()).not.toThrow();
    const cb = vi.fn();
    h.onScroll(cb);
    hosts[0].dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("applyExternal in preview replaces the document, keeps it clean and refreshes headings", async () => {
    const h = await open(ORIGINAL);
    h.applyExternal("# New\n\ntext\n");
    expect(h.getText().trim()).toBe("# New\n\ntext");
    expect(h.isDirty()).toBe(false);
    vi.advanceTimersByTime(300);
    expect(cbs.onHeadingsChange).toHaveBeenLastCalledWith([{ id: "new", text: "New", level: 1 }]);
    expect(cbs.onTitleChange).toHaveBeenLastCalledWith("New");
  });

  it("applyExternal does not report a spurious dirty while the document is being replaced", async () => {
    const h = await open(ORIGINAL);
    cbs.onDirtyChange.mockClear();
    // replaceAll 重建全部 plugin view，commonmark 的 syncHeadingIdPlugin 会在 view 钩子里
    // 立刻回填 heading id 并 dispatch；那一下若被当成用户编辑，就会拿替换前的旧 model 算出"脏"
    h.applyExternal("# New\n\ntext\n");
    expect(cbs.onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(h.isDirty()).toBe(false);
  });

  it("reports the first h1 as title after typing settles", async () => {
    const h = await open("intro\n");
    h.setMode("live");
    const view = internals!.pm.view();
    const heading = view.state.schema.nodes.heading.create({ level: 1 }, view.state.schema.text("Hello"));
    view.dispatch(view.state.tr.insert(0, heading));
    expect(cbs.onTitleChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(cbs.onTitleChange).toHaveBeenLastCalledWith("Hello");
  });

  it("stats() counts the markdown source and reads the same in source mode", async () => {
    const h = await open(ORIGINAL);
    // "# Title\n\n- a\n- b"：3 个词、10 个非空白字符
    expect(h.stats()).toEqual({ words: 3, chars: 10 });
    h.setMode("source");
    expect(h.stats()).toEqual({ words: 3, chars: 10 });
  });

  it("reports stats after typing settles", async () => {
    const h = await open(ORIGINAL);
    h.setMode("live");
    cbs.onStatsChange.mockClear();
    const view = internals!.pm.view();
    view.dispatch(view.state.tr.insertText("!", 6)); // "Title" 末尾
    expect(cbs.onStatsChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(cbs.onStatsChange).toHaveBeenLastCalledWith({ words: 3, chars: 11 });
  });

  it("scrollToAnchor scrolls the heading element; headingTops lists ids", async () => {
    const h = await open("# A\n\n## B\n");
    const el = document.querySelector<HTMLElement>("h2#b")!;
    const spy = vi.spyOn(el, "scrollIntoView");
    h.scrollToAnchor("b");
    expect(spy).toHaveBeenCalledWith({ block: "start" });
    expect(h.headingTops().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("headingTops in source resolves every heading through the source text", async () => {
    const h = await open("# A\n\ntext\n\n## B\n");
    h.setMode("source");
    const tops = h.headingTops();
    expect(tops.map((t) => t.id)).toEqual(["a", "b"]);
    // jsdom 无布局，只断言拿到了数字位置，不断言像素
    for (const t of tops) expect(typeof t.top).toBe("number");
  });

  it("scrollToAnchor in source delegates to the source editor", async () => {
    const h = await open("# A\n\n## B\n");
    h.setMode("source");
    const spy = vi.spyOn(internals!.cm()!, "scrollToHeading");
    h.scrollToAnchor("b");
    expect(spy).toHaveBeenCalledWith("b");
  });

  it("onScroll relays scroll events from the active scroller", async () => {
    const h = await open(ORIGINAL);
    const cb = vi.fn();
    const off = h.onScroll(cb);
    document.querySelector<HTMLElement>(".milkdown")!.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    document.querySelector<HTMLElement>(".milkdown")!.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onScroll also relays scroll from the lazily created CM scroller", async () => {
    const h = await open(ORIGINAL);
    h.setMode("source");
    const cb = vi.fn();
    h.onScroll(cb);
    // CM 是进 source 才建的，靠 opts.parent 上那条捕获监听兜住（scroll 不冒泡，但捕获阶段会经过祖先）
    internals!.cm()!.view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
