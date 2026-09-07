import katex from "katex";
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import { TooltipProvider } from "@milkdown/plugin-tooltip";
import { InputRule } from "@milkdown/prose/inputrules";
import type { Node as PmNode } from "@milkdown/prose/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/prose/state";
import type { Decoration, EditorView, NodeView } from "@milkdown/prose/view";
import { $inputRule, $nodeSchema, $prose, $remark, $view } from "@milkdown/utils";
import type { Feature } from "../pmEditor";
import { isEditingDecoration } from "./editingBlock";

type MdLiteral = { value?: string };

export const remarkMathPlugin = $remark("rsmdRemarkMath", () => remarkMath);

export const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { value: { default: "", validate: "string" } },
  parseDOM: [
    {
      tag: 'span[data-type="math_inline"]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? "" }),
    },
  ],
  toDOM: (node) => ["span", { "data-type": "math_inline", "data-value": node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => {
      state.addNode(type, { value: String((node as MdLiteral).value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => {
      state.addNode("inlineMath", undefined, String(node.attrs.value));
    },
  },
}));

export const mathBlockSchema = $nodeSchema("math_block", () => ({
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [{ tag: 'div[data-type="math_block"]', preserveWhitespace: "full" }],
  toDOM: () => ["div", { "data-type": "math_block" }, 0],
  parseMarkdown: {
    match: (node) => node.type === "math",
    runner: (state, node, type) => {
      state.openNode(type);
      const value = String((node as MdLiteral).value ?? "");
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_block",
    runner: (state, node) => {
      state.addNode("math", undefined, node.textContent);
    },
  },
}));

/// KaTeX 渲染：throwOnError:false 让语法错误以红字显示在公式里；其余异常写成文本
export function renderKatex(el: HTMLElement, src: string, displayMode: boolean): void {
  try {
    katex.render(src, el, { displayMode, throwOnError: false });
    el.dataset.enhanced = "katex";
    delete el.dataset.error;
  } catch (err) {
    el.textContent = `katex: ${err instanceof Error ? err.message : String(err)}`;
    el.dataset.error = "katex";
  }
}

const mathInlineView = $view(mathInlineSchema.node, () => (node): NodeView => {
  const dom = document.createElement("span");
  dom.className = "rsmd-math-inline";
  dom.dataset.type = "math_inline";
  let current = node;
  const render = (n: PmNode): void => {
    dom.dataset.value = String(n.attrs.value);
    renderKatex(dom, String(n.attrs.value), false);
  };
  render(node);
  return {
    dom,
    update(n) {
      if (n.type !== current.type) return false;
      if (n.attrs.value !== current.attrs.value) render(n);
      current = n;
      return true;
    },
    selectNode() {
      dom.classList.add("ProseMirror-selectednode");
    },
    deselectNode() {
      dom.classList.remove("ProseMirror-selectednode");
    },
    ignoreMutation: () => true,
  };
});

/// 块级公式：光标在内显示源码（contentDOM），离开显示 KaTeX。是否"在内"由 editingBlock 的节点装饰告知
const mathBlockView = $view(mathBlockSchema.node, () => (node, _view, _getPos, decorations): NodeView => {
  const dom = document.createElement("div");
  dom.className = "rsmd-preview-block";
  dom.dataset.type = "math_block";
  const preview = document.createElement("div");
  preview.className = "rsmd-preview-block__preview";
  preview.contentEditable = "false";
  const source = document.createElement("pre");
  source.className = "rsmd-preview-block__source";
  const contentDOM = document.createElement("code");
  source.appendChild(contentDOM);
  dom.append(preview, source);
  let rendered: string | null = null;
  const sync = (n: PmNode, decos: readonly Decoration[]): void => {
    const editing = isEditingDecoration(decos);
    dom.dataset.editing = editing ? "true" : "false";
    if (!editing && rendered !== n.textContent) {
      renderKatex(preview, n.textContent, true);
      rendered = n.textContent;
    }
  };
  sync(node, decorations);
  return {
    dom,
    contentDOM,
    update(n, decos) {
      if (n.type !== node.type) return false;
      sync(n, decos);
      return true;
    },
    // 预览区的 DOM 变化不是文档变化；但 selection 类型的 mutation 必须放行，
    // 否则光标进出源码区（contentDOM 之外）时会被当成"可忽略"而不重新读取选区
    ignoreMutation: (m) => m.type !== "selection" && !(m.target === contentDOM || contentDOM.contains(m.target)),
  };
});

const popupKey = new PluginKey("rsmdMathPopup");
const selectedMath = (state: EditorState): NodeSelection | null =>
  state.selection instanceof NodeSelection && state.selection.node.type.name === "math_inline" ? state.selection : null;

/// 行内公式弹窗：选中原子节点（点击即选中）时浮出单行输入框；Enter 写回、Esc 取消、清空即删除
const mathPopup = $prose(
  () =>
    new Plugin({
      key: popupKey,
      view: (editorView: EditorView) => {
        const content = document.createElement("div");
        content.className = "rsmd-mathpop";
        const input = document.createElement("input");
        input.placeholder = "LaTeX";
        input.spellcheck = false;
        content.appendChild(input);
        const provider = new TooltipProvider({
          content,
          debounce: 0,
          shouldShow: (view) => view.editable && selectedMath(view.state) !== null,
        });
        provider.onShow = () => {
          const sel = selectedMath(editorView.state);
          if (!sel) return;
          // 选区/文档只要变化就会再次触发 onShow；用户正在弹窗里输入时（input 是当前焦点）
          // 不能用节点当前值覆盖掉还没提交的草稿
          if (document.activeElement !== input) input.value = String(sel.node.attrs.value);
          requestAnimationFrame(() => input.focus());
        };
        const commit = (): void => {
          const sel = selectedMath(editorView.state);
          if (!sel) return;
          const value = input.value.trim();
          let tr = editorView.state.tr;
          tr = value ? tr.setNodeMarkup(sel.from, undefined, { value }) : tr.delete(sel.from, sel.to);
          tr = tr.setSelection(TextSelection.create(tr.doc, value ? sel.to : sel.from));
          editorView.dispatch(tr);
          editorView.focus();
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            const sel = selectedMath(editorView.state);
            if (sel) {
              // 还原输入框内容（丢弃未提交的编辑），并把选区移到公式节点之后，
              // 让 shouldShow 在下次更新时判定为 false，弹窗随之关闭
              input.value = String(sel.node.attrs.value);
              editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, sel.to)));
            }
            editorView.focus();
          }
        });
        return {
          update: (view, prev) => provider.update(view, prev),
          destroy: () => provider.destroy(),
        };
      },
    })
);

const mathInlineInputRule = $inputRule(
  (ctx) =>
    // 内容首尾不能是空白：避免 "It costs $5 and $" 这类未成对的美元符号（价格 $ + 之后无关的 $）
    // 被误判成公式——真正的公式内容不会以空格开头或结尾
    new InputRule(/(?<!\$)\$([^\s$](?:[^$\n]*?[^\s$])?)\$$/, (state, match, start, end) => {
      const value = (match[1] ?? "").trim();
      if (!value) return null;
      return state.tr.replaceWith(start, end, mathInlineSchema.type(ctx).create({ value }));
    })
);

const mathBlockInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      const type = mathBlockSchema.type(ctx);
      if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type)) return null;
      return state.tr.delete(start, end).setBlockType(start, start, type);
    })
);

export const mathFeature: Feature = {
  plugins: [
    remarkMathPlugin,
    mathInlineSchema,
    mathBlockSchema,
    mathInlineView,
    mathBlockView,
    mathPopup,
    mathInlineInputRule,
    mathBlockInputRule,
  ].flat(),
};
