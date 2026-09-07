import { afterEach, describe, expect, it, vi } from "vitest";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createSourceEditor, type SourceEditor } from "./sourceEditor";

let editors: SourceEditor[] = [];
function make(text: string, onDocChanged?: (t: string) => void): SourceEditor {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const e = createSourceEditor({ parent, text, onDocChanged });
  editors.push(e);
  return e;
}
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
  document.body.innerHTML = "";
});

describe("createSourceEditor", () => {
  it("mounts a .cm-editor under parent and exposes the text", () => {
    const e = make("# A\n\nbody\n");
    expect(e.view.dom.parentElement?.querySelector(".cm-editor")).toBe(e.view.dom);
    expect(e.getText()).toBe("# A\n\nbody\n");
  });

  it("setText replaces the whole document and clears undo history", () => {
    const e = make("old");
    e.view.dispatch({ changes: { from: 3, insert: "!" } });
    expect(undoDepth(e.view.state)).toBe(1);
    e.setText("new");
    expect(e.getText()).toBe("new");
    expect(undoDepth(e.view.state)).toBe(0);
  });

  it("applyDiff keeps the cursor on its text and does not enter undo history", () => {
    const e = make("ab");
    e.view.dispatch({ selection: { anchor: 2 } });
    e.applyDiff("Xab");
    expect(e.getText()).toBe("Xab");
    expect(e.view.state.selection.main.head).toBe(3);
    expect(undoDepth(e.view.state)).toBe(0);
  });

  it("reports document changes with the new text", () => {
    const changed = vi.fn();
    const e = make("a", changed);
    e.view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(changed).toHaveBeenLastCalledWith("ab");
  });

  it("finds headings by slug and scrolls to their line", () => {
    const e = make("intro\n\n# Intro\n\n## Setup & Deps\n");
    const spy = vi.spyOn(e, "scrollToLine");
    expect(e.scrollToHeading("setup-deps")).toBe(true);
    expect(spy).toHaveBeenCalledWith(5);
    expect(e.scrollToHeading("nope")).toBe(false);
  });

  it("exposes the first h1 and toggles visibility", () => {
    const e = make("## h2\n\n# Real *one*\n");
    expect(e.firstH1()).toBe("Real one");
    e.show(false);
    expect(e.view.dom.style.display).toBe("none");
    // CM6 的 baseTheme 里 `.cm-editor { display: flex !important }`，不带 important 的内联样式
    // 在真实浏览器里根本盖不住它（jsdom 不跑层叠，只有这条断言能守住）
    expect(e.view.dom.style.getPropertyPriority("display")).toBe("important");
    e.show(true);
    expect(e.view.dom.style.display).toBe("");
    expect(e.view.dom.getAttribute("style") ?? "").not.toContain("display");
  });

  it("keeps the OS-current theme after setText, instead of reverting to the theme at construction", () => {
    // jsdom 没有 matchMedia，手搭一个假实现，保存 change 回调以便手动触发
    let onScheme: ((e: MediaQueryListEvent) => void) | undefined;
    const fakeMedia = {
      matches: false,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        onScheme = cb;
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(fakeMedia));

    const e = make("x");
    fakeMedia.matches = true;
    onScheme?.({ matches: true } as MediaQueryListEvent);
    expect(e.view.state.facet(EditorView.darkTheme)).toBe(true);

    e.setText("x");
    // 修复前：setText 用捕获时（matches: false）的静态 extensions 重建 state，主题回退为 light
    expect(e.view.state.facet(EditorView.darkTheme)).toBe(true);

    vi.unstubAllGlobals();
  });
});
