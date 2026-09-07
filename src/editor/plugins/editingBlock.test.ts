import { afterEach, describe, expect, it } from "vitest";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { EDITING_CLASS, editingBlockFeature, editingDecorations, isEditingDecoration } from "./editingBlock";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

async function open(text: string, editable: boolean): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [editingBlockFeature] });
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

describe("editingDecorations", () => {
  it("marks the code block containing the cursor when editable", async () => {
    const e = await open("para\n\n```js\ncode\n```\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posOf(e, "code_block") + 2)));
    const set = editingDecorations(v.state, true)!;
    const decos = set.find();
    expect(decos).toHaveLength(1);
    expect(decos[0].spec.rsmdEditing).toBe(true);
    expect(isEditingDecoration(decos)).toBe(true);
    expect(v.dom.querySelector(`pre.${EDITING_CLASS}`)).not.toBeNull(); // 插件已把 class 画到 DOM
  });

  it("marks a node-selected code block too", async () => {
    const e = await open("```js\ncode\n```\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, posOf(e, "code_block"))));
    expect(editingDecorations(v.state, true)!.find()).toHaveLength(1);
  });

  it("decorates nothing in a paragraph or when read-only", async () => {
    const e = await open("para\n\n```js\ncode\n```\n", false);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posOf(e, "code_block") + 2)));
    expect(editingDecorations(v.state, false)).toBeNull();
    expect(v.dom.querySelector(`.${EDITING_CLASS}`)).toBeNull();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
    expect(editingDecorations(v.state, true)).toBeNull();
    expect(isEditingDecoration([])).toBe(false);
  });

  it("does not decorate a selection that spans out of the block, but still decorates a non-empty selection contained in it", async () => {
    const e = await open("para\n\n```js\ncode\n```\n\ntail\n", true);
    const v = e.view();
    const codeFrom = posOf(e, "code_block") + 2;
    const tailFrom = v.state.doc.content.size - 2; // "tail" 段落内部的某个位置
    // 从块内拖选到块外：整个选区没有落在同一个可预览块里，不算"在块内编辑"
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, codeFrom, tailFrom)));
    expect(editingDecorations(v.state, true)).toBeNull();
    expect(v.dom.querySelector(`.${EDITING_CLASS}`)).toBeNull();
    // 整体落在块内的非空选区仍要装饰
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, codeFrom, codeFrom + 2)));
    expect(editingDecorations(v.state, true)!.find()).toHaveLength(1);
  });

  it("recomputes decorations through the real setEditable() → meta transaction path", async () => {
    const e = await open("para\n\n```js\ncode\n```\n", true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, posOf(e, "code_block") + 2)));
    expect(v.dom.querySelector(`pre.${EDITING_CLASS}`)).not.toBeNull();

    e.setEditable(false);
    expect(e.view().dom.querySelector(`.${EDITING_CLASS}`)).toBeNull();

    e.setEditable(true);
    expect(e.view().dom.querySelector(`pre.${EDITING_CLASS}`)).not.toBeNull();
  });
});
