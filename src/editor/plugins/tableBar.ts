import { TooltipProvider } from "@milkdown/plugin-tooltip";
import { Plugin, PluginKey, type Command, type EditorState } from "@milkdown/prose/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
} from "@milkdown/prose/tables";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import type { Feature } from "../pmEditor";

type Alignment = "left" | "center" | "right";

const BUTTONS: ReadonlyArray<{ action: string; label: string; glyph: string }> = [
  { action: "row-above", label: "Insert row above", glyph: "⤒" },
  { action: "row-below", label: "Insert row below", glyph: "⤓" },
  { action: "col-left", label: "Insert column left", glyph: "⇤" },
  { action: "col-right", label: "Insert column right", glyph: "⇥" },
  { action: "delete-row", label: "Delete row", glyph: "⌫↔" },
  { action: "delete-col", label: "Delete column", glyph: "⌫↕" },
  { action: "align-left", label: "Align left", glyph: "⫷" },
  { action: "align-center", label: "Align center", glyph: "☰" },
  { action: "align-right", label: "Align right", glyph: "⫸" },
  { action: "delete-table", label: "Delete table", glyph: "✕" },
];

/// Markdown 的对齐是按列的：gfm 的 keepTableAlignPlugin 会把表头单元格的 alignment 同步到整列，
/// 所以只改光标所在列的表头单元格
export function alignColumn(view: EditorView, alignment: Alignment): boolean {
  if (!isInTable(view.state)) return false;
  const rect = selectedRect(view.state);
  const headerPos = rect.tableStart + rect.map.map[rect.left];
  const cell = view.state.doc.nodeAt(headerPos);
  if (!cell) return false;
  view.dispatch(view.state.tr.setNodeMarkup(headerPos, undefined, { ...cell.attrs, alignment }));
  return true;
}

const COMMANDS: Record<string, Command> = {
  "row-above": addRowBefore,
  "row-below": addRowAfter,
  "col-left": addColumnBefore,
  "col-right": addColumnAfter,
  "delete-row": deleteRow,
  "delete-col": deleteColumn,
  "delete-table": deleteTable,
};

/// gfm 的 table schema 是 `table_header_row table_row+`：表头行不能删、不能在表头前插入普通行，
/// 且至少要保留一行数据——prosemirror-tables 的通用命令不知道这条约束，需要在浮条这一层堵住
function disabledActions(state: EditorState): Set<string> {
  const disabled = new Set<string>();
  if (!isInTable(state)) return disabled;
  const rect = selectedRect(state);
  if (rect.top === 0) {
    disabled.add("delete-row"); // 表头行本身不能删
    disabled.add("row-above"); // 表头前面不能插普通行
  }
  if (rect.map.height <= 2) {
    disabled.add("delete-row"); // 只剩表头 + 1 行数据时，删了就只剩表头，违反 table_row+
  }
  // 跨行的 CellSelection 会把矩形内的行全删掉：选区盖住了全部数据行时同样不能删
  // （rect 的 bottom 是开区间，height 含表头行，故"全部数据行" ⇔ bottom - top ≥ height - 1）
  if (rect.bottom - rect.top >= rect.map.height - 1) {
    disabled.add("delete-row");
  }
  return disabled;
}

class TableBarView {
  private readonly provider: TooltipProvider;
  private readonly content = document.createElement("div");

  constructor(private readonly view: EditorView) {
    this.content.className = "rsmd-tablebar";
    for (const b of BUTTONS) {
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.action = b.action;
      el.setAttribute("aria-label", b.label);
      el.title = b.label;
      el.textContent = b.glyph;
      this.content.appendChild(el);
    }
    this.content.addEventListener("mousedown", (e) => e.preventDefault()); // 保持编辑器焦点与选区
    this.content.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.action;
      if (!action) return;
      this.run(action);
    });
    this.provider = new TooltipProvider({
      content: this.content,
      debounce: 0,
      offset: 8,
      floatingUIOptions: { placement: "top-start" },
      shouldShow: (v) => v.editable && isInTable(v.state),
    });
  }

  private run(action: string): void {
    if (disabledActions(this.view.state).has(action)) return; // 按钮理应已 disabled，双重保险
    if (action.startsWith("align-")) {
      alignColumn(this.view, action.slice("align-".length) as Alignment);
    } else {
      COMMANDS[action]?.(this.view.state, this.view.dispatch);
    }
    this.view.focus();
  }

  update(view: EditorView, prevState?: EditorState): void {
    this.provider.update(view, prevState);
    if (isInTable(view.state)) {
      const disabled = disabledActions(view.state);
      for (const el of this.content.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
        el.disabled = disabled.has(el.dataset.action ?? "");
      }
    }
  }

  destroy(): void {
    this.provider.destroy();
  }
}

export function tableBarFeature(): Feature {
  const plugin = $prose(
    () =>
      new Plugin({
        key: new PluginKey("rsmdTableBar"),
        view: (view) => new TableBarView(view),
      })
  );
  return { plugins: [plugin] };
}
