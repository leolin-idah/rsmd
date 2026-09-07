import { afterEach, describe, expect, it } from "vitest";
import { TextSelection } from "@milkdown/prose/state";
import { CellSelection } from "@milkdown/prose/tables";
import { createPmEditor, type PmEditor } from "../pmEditor";
import { tableBarFeature } from "./tableBar";

let editor: PmEditor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";

async function open(text: string, editable = true): Promise<PmEditor> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  editor = await createPmEditor({ parent, text, editable, features: [tableBarFeature()] });
  return editor;
}
function cellPos(e: PmEditor, text: string): number {
  let found = -1;
  e.doc().descendants((node, pos) => {
    if (found >= 0) return false;
    if ((node.type.name === "table_cell" || node.type.name === "table_header") && node.textContent === text) found = pos + 2;
    return found < 0;
  });
  return found;
}
async function inCell(e: PmEditor, text: string): Promise<HTMLElement> {
  const v = e.view();
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, cellPos(e, text))));
  await flush();
  return e.host.querySelector<HTMLElement>(".rsmd-tablebar")!;
}
// 跨单元格拖选出的 CellSelection：整行 / 整列操作按矩形范围生效，与单光标不同
async function selectCells(e: PmEditor, from: string, to: string): Promise<HTMLElement> {
  const v = e.view();
  // cellPos 给的是单元格内部位置（+2），CellSelection 要的是单元格节点本身的位置
  const sel = CellSelection.create(v.state.doc, cellPos(e, from) - 2, cellPos(e, to) - 2);
  v.dispatch(v.state.tr.setSelection(sel));
  await flush();
  return e.host.querySelector<HTMLElement>(".rsmd-tablebar")!;
}
const press = (bar: HTMLElement, action: string) => bar.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click();
const rows = (e: PmEditor) => {
  let n = 0;
  e.doc().descendants((node) => {
    if (node.type.name === "table_row" || node.type.name === "table_header_row") n++;
    return true;
  });
  return n;
};

describe("table bar", () => {
  it("appears with ten labelled buttons when the cursor is in a table", async () => {
    const e = await open(TABLE);
    const bar = await inCell(e, "1");
    expect(bar.dataset.show).toBe("true");
    const labels = Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Insert row above", "Insert row below", "Insert column left", "Insert column right",
      "Delete row", "Delete column", "Align left", "Align center", "Align right", "Delete table",
    ]);
  });

  it("stays hidden in read-only mode and outside tables", async () => {
    const e = await open(TABLE + "\ntail\n", false);
    await inCell(e, "1");
    expect(e.host.querySelector<HTMLElement>(".rsmd-tablebar")?.dataset.show ?? "false").toBe("false");
    e.setEditable(true);
    const v = e.view();
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, v.state.doc.content.size - 2)));
    await flush();
    expect(e.host.querySelector<HTMLElement>(".rsmd-tablebar")?.dataset.show ?? "false").toBe("false");
  });

  it("inserts and deletes rows and columns", async () => {
    const e = await open(TABLE);
    let bar = await inCell(e, "1");
    press(bar, "row-below");
    expect(rows(e)).toBe(4);
    bar = await inCell(e, "1");
    press(bar, "delete-row");
    expect(rows(e)).toBe(3);
    expect(e.getMarkdown()).not.toContain("| 1 ");
    bar = await inCell(e, "3");
    press(bar, "col-right");
    expect(e.doc().firstChild?.firstChild?.childCount).toBe(3);
    bar = await inCell(e, "3");
    press(bar, "delete-col");
    expect(e.doc().firstChild?.firstChild?.childCount).toBe(2);
  });

  it("aligns the whole column through the header cell", async () => {
    const e = await open(TABLE);
    const bar = await inCell(e, "4");
    press(bar, "align-center");
    const md = e.getMarkdown();
    expect(md).toMatch(/\|\s*-+\s*\|\s*:-+:\s*\|/);
  });

  it("deletes the table", async () => {
    const e = await open(TABLE + "\ntail\n");
    const bar = await inCell(e, "1");
    press(bar, "delete-table");
    expect(e.getMarkdown().trim()).toBe("tail");
  });

  it("does not delete or insert above the header row", async () => {
    const e = await open(TABLE);
    const bar = await inCell(e, "a");
    const deleteRowBtn = bar.querySelector<HTMLButtonElement>('button[data-action="delete-row"]')!;
    const rowAboveBtn = bar.querySelector<HTMLButtonElement>('button[data-action="row-above"]')!;
    const rowBelowBtn = bar.querySelector<HTMLButtonElement>('button[data-action="row-below"]')!;
    expect(deleteRowBtn.disabled).toBe(true);
    expect(rowAboveBtn.disabled).toBe(true);
    expect(rowBelowBtn.disabled).toBe(false);
    press(bar, "delete-row");
    expect(rows(e)).toBe(3);
    expect(e.getMarkdown()).toContain("| a | b |");
    press(bar, "row-above");
    expect(rows(e)).toBe(3);
  });

  it("keeps the last body row", async () => {
    const e = await open("| a | b |\n|---|---|\n| 1 | 2 |\n");
    const bar = await inCell(e, "1");
    expect(bar.querySelector<HTMLButtonElement>('button[data-action="delete-row"]')!.disabled).toBe(true);
    press(bar, "delete-row");
    expect(rows(e)).toBe(2);
  });

  it("keeps the body rows when a cell selection covers all of them", async () => {
    const e = await open(TABLE); // 表头 + 2 行数据
    const bar = await selectCells(e, "1", "3"); // 竖着选中两行数据
    expect(bar.querySelector<HTMLButtonElement>('button[data-action="delete-row"]')!.disabled).toBe(true);
    press(bar, "delete-row");
    expect(rows(e)).toBe(3);
    expect(e.getMarkdown()).toContain("| 1 ");
  });

  it("still deletes a row when the cell selection leaves other body rows", async () => {
    const e = await open("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n"); // 3 行数据
    const bar = await selectCells(e, "1", "2"); // 只选中第一行数据的两个单元格
    expect(bar.querySelector<HTMLButtonElement>('button[data-action="delete-row"]')!.disabled).toBe(false);
    press(bar, "delete-row");
    expect(rows(e)).toBe(3);
  });
});
