import { afterEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "@milkdown/prose/state";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { linkBarFeature, linkBarKey, linkRangeAt } from "./linkBar";

let editor: PmEditor | null = null;
const onOpen = vi.fn();
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  onOpen.mockClear();
});
const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(text: string, editable = true): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [linkBarFeature({ onOpen })] });
  return editor;
}
const bar = (e: PmEditor) => e.host.querySelector<HTMLElement>(".rsmd-linkbar");
const button = (e: PmEditor, action: string) => bar(e)!.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
function place(e: PmEditor, pos: number): void {
  const v = e.view();
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

// "see [docs](https://e.com "T") now" → 文档位置：p 开 1，"see " 1–5，"docs" 5–9
const MD = 'see [docs](https://e.com "T") now\n';

describe("linkRangeAt", () => {
  it("returns the link range under a collapsed cursor", async () => {
    const e = await open(MD);
    place(e, 7);
    expect(linkRangeAt(e.view().state)).toEqual({ from: 5, to: 9, href: "https://e.com", title: "T" });
  });

  it("returns null outside links", async () => {
    const e = await open(MD);
    place(e, 2);
    expect(linkRangeAt(e.view().state)).toBeNull();
  });
});

describe("link bar", () => {
  it("shows the href with Edit / Open / Remove when the cursor enters a link", async () => {
    const e = await open(MD);
    place(e, 7);
    await flush();
    const el = bar(e)!;
    expect(el.dataset.show).toBe("true");
    expect(el.dataset.mode).toBe("show");
    expect(el.querySelector(".rsmd-linkbar__href")?.textContent).toBe("https://e.com");
    expect(["edit", "open", "remove"].map((a) => button(e, a).textContent)).toEqual(["Edit", "Open", "Remove"]);
  });

  it("hides when read-only or outside a link", async () => {
    const e = await open(MD, false);
    place(e, 7);
    await flush();
    expect(bar(e)?.dataset.show ?? "false").toBe("false");
    e.setEditable(true);
    place(e, 2);
    await flush();
    expect(bar(e)?.dataset.show ?? "false").toBe("false");
  });

  it("Open hands the href to the callback; Remove strips the mark", async () => {
    const e = await open(MD);
    place(e, 7);
    await flush();
    button(e, "open").click();
    expect(onOpen).toHaveBeenCalledWith("https://e.com");
    button(e, "remove").click();
    expect(e.getMarkdown().trim()).toBe("see docs now");
  });

  it("Edit switches to an input; Enter rewrites the href and keeps the title", async () => {
    const e = await open(MD);
    place(e, 7);
    await flush();
    button(e, "edit").click();
    await flush();
    const el = bar(e)!;
    expect(el.dataset.mode).toBe("edit");
    const input = el.querySelector<HTMLInputElement>("input.rsmd-linkbar__input")!;
    expect(input.placeholder).toBe("https://");
    expect(input.value).toBe("https://e.com");
    input.value = "https://new.dev";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(e.getMarkdown().trim()).toBe('see [docs](https://new.dev "T") now');
    expect(linkBarKey.getState(e.view().state)?.edit).toBeNull();
  });

  it("⌘K on a plain selection opens the input and Enter creates the link", async () => {
    const e = await open("plain text\n");
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    const handled = v.someProp("handleKeyDown", (f) => f(v, new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    expect(handled).toBe(true);
    await flush();
    const el = bar(e)!;
    expect(el.dataset.show).toBe("true");
    expect(el.dataset.mode).toBe("edit");
    const input = el.querySelector<HTMLInputElement>("input")!;
    input.value = "https://x.io";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(e.getMarkdown().trim()).toBe("[plain](https://x.io) text");
  });

  it("Escape cancels editing without touching the document", async () => {
    const e = await open(MD);
    place(e, 7);
    await flush();
    button(e, "edit").click();
    await flush();
    bar(e)!.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(linkBarKey.getState(e.view().state)?.edit).toBeNull();
    expect(e.getMarkdown().trim()).toBe(MD.trim());
  });

  it("blur cancels editing", async () => {
    const e = await open(MD);
    place(e, 7);
    await flush();
    button(e, "edit").click();
    await flush();
    const el = bar(e)!;
    const input = el.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new FocusEvent("blur"));
    expect(linkBarKey.getState(e.view().state)?.edit).toBeNull();
    await flush();
    // 光标仍在链接内，浮条应该还显示，只是退回展示态
    expect(el.dataset.mode).toBe("show");
    expect(e.getMarkdown().trim()).toBe(MD.trim());
  });

  it("a collapsed edit range clears the edit state", async () => {
    const e = await open("plain text\n");
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
    v.someProp("handleKeyDown", (f) => f(v, new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    await flush();
    // 编辑范围内的内容被整体删除，映射后 from >= to：应该清空 edit，而不是留着一个零宽区间
    v.dispatch(v.state.tr.delete(1, 6));
    expect(linkBarKey.getState(v.state)?.edit).toBeNull();
    const input = bar(e)!.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // 序列化器把行首空格转义成 &#x20;（避免被误认成缩进代码块），断言用 trim 后按字面比较即可：
    // 关键是没有多出链接标记、也没有抛错，删除后的输入原样保留
    expect(e.getMarkdown().replace(/&#x20;/g, " ").trim()).toBe("text");
  });
});
