import { afterEach, describe, expect, it, vi } from "vitest";
import { createPmEditor, headingsOf, type PmEditor } from "./pmEditor";

let editors: PmEditor[] = [];

async function make(text: string, editable = false, onDocChanged?: () => void): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const e = await createPmEditor({ parent, text, editable, onDocChanged });
  editors.push(e);
  return e;
}

afterEach(async () => {
  for (const e of editors) await e.destroy();
  editors = [];
  document.body.innerHTML = "";
});

describe("createPmEditor", () => {
  it("mounts a .milkdown host holding the ProseMirror view and round-trips markdown", async () => {
    const e = await make("# Title\n\nbody *em*\n");
    expect(e.host.classList.contains("milkdown")).toBe(true);
    expect(e.view().dom.closest(".milkdown")).toBe(e.host);
    expect(e.view().dom.classList.contains("markdown-body")).toBe(true);
    expect(e.getMarkdown().trim()).toBe("# Title\n\nbody *em*");
  });

  it("normalizes list markers and rules to the configured style", async () => {
    const e = await make("* a\n* b\n\n***\n");
    expect(e.getMarkdown().trim()).toBe("- a\n- b\n\n---");
    expect(e.normalize("* x\n").trim()).toBe("- x");
    expect(e.getMarkdown().trim()).toBe("- a\n- b\n\n---"); // normalize 不动当前文档
  });

  it("keeps the original emphasis markers", async () => {
    const e = await make("_a_ and __b__\n");
    expect(e.getMarkdown().trim()).toBe("_a_ and __b__");
  });

  it("gives headings GitHub-style ids in the DOM and in headings()", async () => {
    const e = await make("# Hello, World!\n\n## Setup & Deps\n");
    expect(e.headings()).toEqual([
      { id: "hello-world", text: "Hello, World!", level: 1 },
      { id: "setup-deps", text: "Setup & Deps", level: 2 },
    ]);
    expect(e.view().dom.querySelector("h1")?.id).toBe("hello-world");
    expect(headingsOf(e.doc())).toEqual(e.headings());
    // 重复标题由 commonmark 的 syncHeadingIdPlugin 编号成 dup / dup-#2；source 侧的 slug.ts 复刻同一规则
    const dup = await make("# Dup\n\ntext\n\n## Dup\n");
    expect(dup.headings().map((h) => h.id)).toEqual(["dup", "dup-#2"]);
  });

  it("starts read-only when asked and toggles editable", async () => {
    const e = await make("x\n", false);
    expect(e.view().editable).toBe(false);
    expect(e.isEditable()).toBe(false);
    e.setEditable(true);
    expect(e.view().editable).toBe(true);
    expect(e.isEditable()).toBe(true);
  });

  it("replaceAll swaps the document", async () => {
    const e = await make("old\n", true);
    e.replaceAll("new\n");
    expect(e.getMarkdown().trim()).toBe("new");
    expect(e.view().dom.textContent).toContain("new");
  });

  it("re-reads the .milkdown host after replaceAll recreates it", async () => {
    const e = await make("old\n", true);
    const parent = e.host.parentElement!;
    e.replaceAll("new\n");
    // replaceAll(text, true) 重建 EditorState → plugin view 全部重建 → core 换了一个新的 .milkdown 容器
    expect(e.host.isConnected).toBe(true);
    expect(e.view().dom.closest(".milkdown")).toBe(e.host);
    expect(parent.querySelectorAll(".milkdown").length).toBe(1);
  });

  it("reports doc changes through onDocChanged", async () => {
    const changed = vi.fn();
    const e = await make("a\n", true, changed);
    const v = e.view();
    v.dispatch(v.state.tr.insertText("b", 2));
    expect(changed).toHaveBeenCalled();
    expect(e.getMarkdown().trim()).toBe("ab");
  });

  it("does not resize table columns (no column-resizing plugin)", async () => {
    const e = await make("| a |\n|---|\n| 1 |\n");
    expect(e.view().dom.querySelector(".column-resize-handle")).toBeNull();
    expect(e.view().state.plugins.some((p) => String((p as { key?: string }).key ?? "").includes("tableColumnResizing"))).toBe(false);
  });
});
