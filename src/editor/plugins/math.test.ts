import { afterEach, describe, expect, it } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { editingBlockFeature } from "./editingBlock";
import { mathFeature } from "./math";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});
const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(text: string, editable = false): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [editingBlockFeature, mathFeature] });
  return editor;
}
function posOf(e: PmEditor, typeName: string): number {
  let found = -1;
  e.doc().descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === typeName) found = pos;
    return found < 0;
  });
  return found;
}

const MD = "Inline $x_1 + y$ math.\n\n$$\n\\alpha_1 + \\beta_2\n$$\n";

describe("math", () => {
  it("round-trips inline and block math without escaping underscores", async () => {
    const e = await open(MD);
    expect(e.getMarkdown().trim()).toBe(MD.trim());
  });

  it("renders inline math with KaTeX", async () => {
    const e = await open(MD);
    const span = e.view().dom.querySelector<HTMLElement>('span.rsmd-math-inline[data-type="math_inline"]')!;
    expect(span.dataset.value).toBe("x_1 + y");
    expect(span.querySelector(".katex")).not.toBeNull();
  });

  it("shows the block preview when the cursor is outside and the source when inside", async () => {
    const e = await open(MD, true);
    const v = e.view();
    const block = v.dom.querySelector<HTMLElement>('.rsmd-preview-block[data-type="math_block"]')!;
    expect(block.dataset.editing).toBe("false");
    expect(block.querySelector(".rsmd-preview-block__preview .katex-display")).not.toBeNull();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posOf(e, "math_block") + 2)));
    expect(block.dataset.editing).toBe("true");
    expect(block.querySelector("pre.rsmd-preview-block__source > code")?.textContent).toBe("\\alpha_1 + \\beta_2");
  });

  it("re-renders the block preview after leaving with edited source", async () => {
    const e = await open("$$\na\n$$\n\ntail\n", true);
    const v = e.view();
    const pos = posOf(e, "math_block");
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 2)).insertText("b", pos + 2));
    // 光标移到 tail 段落里：块离开编辑态，用最新源码重绘
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 2)));
    const preview = v.dom.querySelector<HTMLElement>('.rsmd-preview-block[data-type="math_block"] .rsmd-preview-block__preview')!;
    expect(preview.textContent).toContain("ab");
    expect(e.getMarkdown().trim()).toBe("$$\nab\n$$\n\ntail");
  });

  it("opens the popup when an inline formula is selected and commits on Enter", async () => {
    const e = await open("see $a$ here\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(e, "math_inline"))));
    await flush();
    const pop = e.host.querySelector<HTMLElement>(".rsmd-mathpop")!;
    expect(pop.dataset.show).toBe("true");
    const input = pop.querySelector("input")!;
    expect(input.placeholder).toBe("LaTeX");
    expect(input.value).toBe("a");
    input.value = "a+b";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(e.getMarkdown().trim()).toBe("see $a+b$ here");
    await flush();
    expect(pop.dataset.show).toBe("false");
  });

  it("does not open the popup when read-only", async () => {
    const e = await open("see $a$ here\n", false);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(e, "math_inline"))));
    await flush();
    expect(e.host.querySelector<HTMLElement>(".rsmd-mathpop")?.dataset.show ?? "false").toBe("false");
  });

  it("turns `$x$` typed at the end of a paragraph into inline math", async () => {
    const e = await open("p\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.insertText("$y", 2));
    const handled = v.someProp("handleTextInput", (f) => f(v, 4, 4, "$", () => v.state.tr));
    expect(handled).toBe(true);
    expect(e.getMarkdown().trim()).toBe("p$y$");
    expect(posOf(e, "math_inline")).toBeGreaterThan(0);
  });

  it("turns `$$ ` at the start of an empty paragraph into a math block", async () => {
    const e = await open("p\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.split(2)); // 在 "p" 后新起一段
    const start = v.state.doc.content.size - 1; // 新空段落内部
    v.dispatch(v.state.tr.insertText("$$", start));
    v.someProp("handleTextInput", (f) => f(v, start + 2, start + 2, " ", () => v.state.tr));
    expect(posOf(e, "math_block")).toBeGreaterThan(0);
  });

  it("keeps an in-progress popup edit when the doc updates for an unrelated reason", async () => {
    const e = await open("see $a$ here\n", true);
    const v = e.view();
    const mathPos = posOf(e, "math_inline");
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, mathPos)));
    await flush();
    const pop = e.host.querySelector<HTMLElement>(".rsmd-mathpop")!;
    const input = pop.querySelector("input")!;
    input.focus();
    input.value = "draft";
    // 文档因其他原因更新（段落末尾插入字符），选区映射后仍留在公式节点上
    const endPos = v.state.doc.content.size - 1;
    let tr = v.state.tr.insertText("!", endPos);
    tr = tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(mathPos)));
    v.dispatch(tr);
    await flush();
    expect(input.value).toBe("draft");
  });

  it("cancels the popup edit on Escape without committing changes", async () => {
    const e = await open("see $a$ here\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(e, "math_inline"))));
    await flush();
    const pop = e.host.querySelector<HTMLElement>(".rsmd-mathpop")!;
    const input = pop.querySelector("input")!;
    input.value = "junk";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(pop.dataset.show).toBe("false");
    expect(e.getMarkdown().trim()).toBe("see $a$ here");
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(e, "math_inline"))));
    await flush();
    expect(input.value).toBe("a");
  });

  it("does not turn an unpaired `$` price followed by more text and `$` into inline math", async () => {
    const e = await open("p\n", true);
    const v = e.view();
    // 直接用事务拼出文本（不经 markdown 往返），保留结尾空格：模拟逐字输入 "It costs $5 and " 后再敲 "$"
    v.dispatch(v.state.tr.insertText("It costs $5 and ", 2));
    const end = v.state.doc.content.size - 1;
    const handled = v.someProp("handleTextInput", (f) => f(v, end, end, "$", () => v.state.tr));
    expect(handled).toBeFalsy();
    expect(posOf(e, "math_inline")).toBe(-1);
  });

  it("still turns `$a b$` (internal space) typed at the end of a paragraph into inline math", async () => {
    const e = await open("p\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.insertText("$a b", 2));
    const end = v.state.doc.content.size - 1;
    const handled = v.someProp("handleTextInput", (f) => f(v, end, end, "$", () => v.state.tr));
    expect(handled).toBe(true);
    expect(e.getMarkdown().trim()).toBe("p$a b$");
    expect(posOf(e, "math_inline")).toBeGreaterThan(0);
  });
});
