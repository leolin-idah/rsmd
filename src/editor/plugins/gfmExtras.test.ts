import { afterEach, describe, expect, it, vi } from "vitest";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { gfmExtrasFeature } from "./gfmExtras";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});
async function open(text: string, editable: boolean): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [gfmExtrasFeature] });
  return editor;
}

describe("task items", () => {
  it("renders a checkbox per task item reflecting its state", async () => {
    const e = await open("- [ ] todo\n- [x] done\n- plain\n", false);
    const boxes = e.view().dom.querySelectorAll<HTMLInputElement>("li.task-list-item input.task-list-item-checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect(e.view().dom.querySelectorAll("li")[2].classList.contains("task-list-item")).toBe(false);
    expect(e.getMarkdown().trim()).toBe("- [ ] todo\n- [x] done\n- plain");
  });

  it("toggles the item when clicked in live mode", async () => {
    const e = await open("- [ ] todo\n", true);
    const box = e.view().dom.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(e.getMarkdown().trim()).toBe("- [x] todo");
    expect(e.view().dom.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!.checked).toBe(true);
  });

  it("ignores clicks in preview mode", async () => {
    const e = await open("- [ ] todo\n", false);
    const box = e.view().dom.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(e.getMarkdown().trim()).toBe("- [ ] todo");
  });
});

describe("footnotes", () => {
  it("scrolls to the definition when a reference is clicked", async () => {
    const e = await open("hi[^1]\n\n[^1]: note\n", false);
    const dl = e.view().dom.querySelector<HTMLElement>('dl[data-type="footnote_definition"]')!;
    const spy = vi.spyOn(dl, "scrollIntoView");
    const sup = e.view().dom.querySelector<HTMLElement>('sup[data-type="footnote_reference"]')!;
    let refPos = -1;
    e.doc().descendants((node, pos) => {
      if (node.type.name === "footnote_reference") refPos = pos;
      return refPos < 0;
    });
    const node = e.doc().nodeAt(refPos)!;
    const handled = e.view().someProp("handleClickOn", (f) => f(e.view(), refPos, node, refPos, new MouseEvent("click"), true));
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(sup.dataset.label).toBe("1");
  });
});
