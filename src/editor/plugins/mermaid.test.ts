import { afterEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "@milkdown/prose/state";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  // 贴近真实 mermaid.render 行为：解析失败前会先往 document.body 挂一个 `#d${id}` 临时节点，
  // 该库自身的 removeTempElements() 是在 throw 之后才跑的，所以这里在 throw 之前手动模拟挂载
  render: vi.fn(async (id: string, src: string) => {
    if (src.includes("bad")) {
      document.body.appendChild(Object.assign(document.createElement("div"), { id: `d${id}` }));
      throw new Error("Parse error");
    }
    return { svg: `<svg data-src="${src.length}"></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

import { createPmEditor, type PmEditor } from "../pmEditor";
import { editingBlockFeature } from "./editingBlock";
import { mermaidFeature } from "./mermaid";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(text: string, editable = false): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [editingBlockFeature, mermaidFeature] });
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

describe("code block view", () => {
  it("renders ordinary code blocks as pre[data-language] > code and round-trips", async () => {
    const e = await open("```ts\nconst a = 1;\n```\n");
    const pre = e.view().dom.querySelector<HTMLElement>("pre[data-language='ts']")!;
    expect(pre.querySelector("code")?.textContent).toBe("const a = 1;");
    expect(e.getMarkdown().trim()).toBe("```ts\nconst a = 1;\n```");
  });

  it("renders mermaid blocks as an SVG preview once visible", async () => {
    const e = await open("```mermaid\ngraph TD\nA-->B\n```\n");
    await flush();
    const block = e.view().dom.querySelector<HTMLElement>('.rsmd-preview-block[data-type="mermaid"]')!;
    expect(block.dataset.editing).toBe("false");
    expect(block.querySelector(".rsmd-preview-block__preview svg")).not.toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(e.getMarkdown().trim()).toBe("```mermaid\ngraph TD\nA-->B\n```");
  });

  it("shows the source while the cursor is inside and re-renders on leaving", async () => {
    const e = await open("```mermaid\ngraph TD\n```\n\ntail\n", true);
    await flush();
    const v = e.view();
    const block = v.dom.querySelector<HTMLElement>('.rsmd-preview-block[data-type="mermaid"]')!;
    const pos = posOf(e, "code_block");
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos + 1 + "graph TD".length)));
    expect(block.dataset.editing).toBe("true");
    v.dispatch(v.state.tr.insertText("\nA-->B"));
    expect(mermaid.render).toHaveBeenCalledTimes(1); // 编辑中不重绘
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 1)));
    await flush();
    expect(block.dataset.editing).toBe("false");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.render.mock.calls[1][1]).toBe("graph TD\nA-->B");
  });

  it("shows the error inline when mermaid fails", async () => {
    const e = await open("```mermaid\nbad\n```\n");
    await flush();
    const preview = e.view().dom.querySelector<HTMLElement>(".rsmd-preview-block__preview")!;
    expect(preview.textContent).toBe("mermaid: Parse error");
    expect(preview.dataset.error).toBe("mermaid");
    // mermaid.render 在解析失败前挂到 body 上的临时节点要被清理掉，不能残留
    expect(document.body.querySelector('div[id^="drsmd-mermaid-"]')).toBeNull();
  });
});
