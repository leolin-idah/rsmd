import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { diff } from "@codemirror/merge";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { firstH1FromText, headingLine } from "./slug";
import { prefersDark, themeFor } from "./theme";

export interface SourceEditorOptions {
  parent: HTMLElement;
  text: string;
  onDocChanged?(text: string): void;
}

export interface SourceEditor {
  readonly view: EditorView;
  getText(): string;
  /// 整文替换：新 EditorState，撤销栈重置（进入 source 模式时的交接）
  setText(text: string): void;
  /// 外部更新：最小 diff 派发，光标 / 滚动随 ChangeSet 映射，不进撤销栈（⌘Z 不该撤掉别人在磁盘上的改动）
  applyDiff(text: string): void;
  scrollToLine(line: number): void;
  /// 按 slug 扫描标题行；找不到返回 false
  scrollToHeading(id: string): boolean;
  firstH1(): string | null;
  show(visible: boolean): void;
  destroy(): void;
}

/// source 模式：纯 Markdown 源码 + Lezer 高亮。每个文档一个实例，首次进入 source 时创建。
export function createSourceEditor(opts: SourceEditorOptions): SourceEditor {
  const theme = new Compartment();
  // media 提前到 stateFor 之前声明：stateFor 要读它取"当前"系统主题
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const extensions: Extension = [
    history(),
    drawSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ codeLanguages: languages }),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onDocChanged?.(u.state.doc.toString());
    }),
  ];
  // theme.of(...) 不放进上面的静态 extensions：那样值在这次 createSourceEditor 调用时就定死了，
  // 之后 onScheme 只改了 view.state 里的 compartment，不改这个数组本身；setText 会用 stateFor
  // 重新 EditorState.create，若复用捕获值就会让主题跳回创建时那一刻的亮暗，直到下次 OS 主题事件才纠正。
  // 这里改成每次都按"当前" media.matches（或 prefersDark 兜底）现算，setText 后主题不会回退。
  const stateFor = (text: string): EditorState =>
    EditorState.create({ doc: text, extensions: [extensions, theme.of(themeFor(media?.matches ?? prefersDark()))] });
  const view = new EditorView({ state: stateFor(opts.text), parent: opts.parent });

  const onScheme = (e: MediaQueryListEvent): void => view.dispatch({ effects: theme.reconfigure(themeFor(e.matches)) });
  media?.addEventListener("change", onScheme);

  const scrollToLine = (line: number): void => {
    const n = Math.min(Math.max(line, 1), view.state.doc.lines);
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "start" }) });
  };

  const editor: SourceEditor = {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.setState(stateFor(text));
    },
    applyDiff(text) {
      const current = view.state.doc.toString();
      const changes = diff(current, text).map((c) => ({ from: c.fromA, to: c.toA, insert: text.slice(c.fromB, c.toB) }));
      view.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
    },
    scrollToLine,
    scrollToHeading(id) {
      const line = headingLine(view.state.doc.toString(), id);
      if (line === null) return false;
      editor.scrollToLine(line); // 经 editor 调用，测试可 spy
      return true;
    },
    firstH1: () => firstH1FromText(view.state.doc.toString()),
    show(visible) {
      // CM6 的 baseTheme 给 .cm-editor 写了 `display: flex !important`（@codemirror/view 源码），
      // 普通内联样式压不住它，隐藏必须带 important（内联 !important 是层叠里最高的一档）。
      // 显示则直接撤掉内联声明，交回 CM 自己的 flex 布局。
      if (visible) view.dom.style.removeProperty("display");
      else view.dom.style.setProperty("display", "none", "important");
    },
    destroy() {
      media?.removeEventListener("change", onScheme);
      view.destroy();
    },
  };
  return editor;
}
