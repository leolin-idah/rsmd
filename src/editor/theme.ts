import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`;

interface Palette {
  bg: string;
  fg: string;
  selection: string;
  link: string;
  mark: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  fn: string;
  type: string;
  tag: string;
}

/// 露出源码的段与 widget 共处一列：字体/字号/行高/列宽对齐 github-markdown-css 正文，切换读写时版面不跳。
/// .cm-content 以 flex 项居中：宽度上限 860px，与原 .markdown-body 一致。
/// min-width 必须显式置 0：flex 项默认 min-width: auto，不肯收缩到子块（宽表格、长行代码）的最小内容宽度以下，
/// 窄窗口时整列撑破 .cm-scroller 出横向滚动条，还因居中而左右同时被裁；置 0 后各块在自身的 overflow: auto 内横滚。
function base(p: Palette, dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": { backgroundColor: p.bg, color: p.fg, height: "100%" },
      // 行高取 theme.css 的 --rsmd-line-height：渲染块的 .markdown-body 用同一个变量，两者必须同值
      ".cm-scroller": { overflow: "auto", justifyContent: "center", fontFamily: FONT, fontSize: "16px", lineHeight: "var(--rsmd-line-height)" },
      // 顶部内边距走 --rsmd-content-pad-top：tabs 布局的顶栏是悬浮玻璃层（theme.css），
      // 内容要从它底下穿过，起始位置由该变量抬高；sideList 布局回落到 32px
      ".cm-content": { flex: "0 1 860px", minWidth: "0", maxWidth: "860px", boxSizing: "border-box", padding: "var(--rsmd-content-pad-top, 32px) 24px 32px", caretColor: p.fg },
      "&.cm-focused": { outline: "none" },
      ".cm-line": { padding: "0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.fg },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: p.selection,
      },
    },
    { dark }
  );
}

/// GitHub 配色的 Lezer 高亮：Markdown 标记 + 代码围栏内的嵌套语言。
function highlight(p: Palette): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.heading, fontWeight: "600" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strong, fontWeight: "600" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: [t.link, t.url], color: p.link },
      { tag: t.monospace, fontFamily: MONO, fontSize: "85%" },
      // #、*、`、---、[^1] 等 Markdown 标记
      { tag: [t.processingInstruction, t.meta, t.labelName, t.contentSeparator], color: p.mark },
      { tag: t.comment, color: p.comment, fontStyle: "italic" },
      { tag: [t.keyword, t.operator, t.modifier], color: p.keyword },
      { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
      { tag: [t.number, t.bool, t.atom, t.attributeName], color: p.number },
      { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: p.fn },
      { tag: [t.typeName, t.className, t.namespace], color: p.type },
      { tag: t.tagName, color: p.tag },
    ])
  );
}

const LIGHT: Palette = {
  bg: "#ffffff", fg: "#1f2328", selection: "#b6d7ff", link: "#0969da", mark: "#6e7781", comment: "#6e7781",
  keyword: "#cf222e", string: "#0a3069", number: "#0550ae", fn: "#8250df", type: "#953800", tag: "#116329",
};
const DARK: Palette = {
  bg: "#0d1117", fg: "#e6edf3", selection: "#264f78", link: "#58a6ff", mark: "#8b949e", comment: "#8b949e",
  keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", fn: "#d2a8ff", type: "#ffa657", tag: "#7ee787",
};

export function themeFor(dark: boolean): Extension {
  const p = dark ? DARK : LIGHT;
  return [base(p, dark), highlight(p)];
}

export function prefersDark(): boolean {
  // jsdom 没有 matchMedia，做特性检测
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
