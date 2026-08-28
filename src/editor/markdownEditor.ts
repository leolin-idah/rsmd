import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { diff } from "@codemirror/merge";
import { Compartment, EditorState, Transaction, type Text } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import type { BlockRange, RenderPayload } from "../ipc";
import { segment, splitBlocks, type Heading } from "./blocks";
import { blockWidgets, pruneCache, setBlocks, type WidgetCache } from "./blockWidgets";
import { externalSync, renderBridge } from "./renderBridge";
import { prefersDark, themeFor } from "./theme";

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  html: string;
  blocks: BlockRange[];
  onDirtyChange(dirty: boolean): void;
  requestRender(text: string): Promise<RenderPayload | null>;
  onRendered?(payload: RenderPayload): void;
}

export interface EditorHandle {
  readonly view: EditorView;
  beginEditing(): void;
  endEditing(): Promise<void>;
  isReadOnly(): boolean;
  getText(): string;
  isDirty(): boolean;
  markSaved(): void;
  applyExternal(text: string, html: string, blocks: BlockRange[]): void;
  headings(): Heading[];
  scrollToLine(line: number): void;
  destroy(): void;
}

/// 每个文档一个实例：光标、撤销栈、滚动位置都在实例里，切 tab 不丢。
export function createEditor(opts: EditorOptions): EditorHandle {
  const cache: WidgetCache = new Map();
  const access = new Compartment(); // readOnly + editable 一起切
  const theme = new Compartment();
  let headings: Heading[] = [];
  let savedDoc: Text | null = null; // 已保存基线；dirty = doc 与之不等
  let dirty = false;
  let syncing = false; // applyExternal 期间抑制脏判定
  let accessGen = 0; // beginEditing/endEditing 每次自增；endEditing 等待渲染期间若被 beginEditing 抢先，放弃回锁

  const applyBlocks = (view: EditorView, html: string, blocks: BlockRange[]): void => {
    const split = splitBlocks(html, blocks);
    headings = split.headings;
    pruneCache(cache, [...split.blocks.map((b) => b.html), ...(split.footnotesHtml ? [split.footnotesHtml] : [])]);
    view.dispatch({
      effects: setBlocks.of({ segments: segment(split.blocks, view.state.doc.lines), footnotesHtml: split.footnotesHtml }),
    });
  };
  const bridge = renderBridge(opts.requestRender, (view, p) => {
    applyBlocks(view, p.html, p.blocks);
    opts.onRendered?.(p);
  });
  const setDirty = (value: boolean): void => {
    if (value === dirty) return;
    dirty = value;
    opts.onDirtyChange(value);
  };

  const state = EditorState.create({
    doc: opts.text,
    extensions: [
      history(),
      drawSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ codeLanguages: languages }),
      EditorView.lineWrapping,
      access.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      theme.of(themeFor(prefersDark())),
      blockWidgets(cache),
      bridge,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || syncing || !savedDoc) return;
        setDirty(!u.state.doc.eq(savedDoc));
      }),
    ],
  });
  const view = new EditorView({ state, parent: opts.parent });
  applyBlocks(view, opts.html, opts.blocks);
  savedDoc = view.state.doc;

  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const onScheme = (e: MediaQueryListEvent): void => view.dispatch({ effects: theme.reconfigure(themeFor(e.matches)) });
  media?.addEventListener("change", onScheme);

  const setAccess = (readOnly: boolean): void =>
    view.dispatch({ effects: access.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });

  return {
    view,
    beginEditing() {
      accessGen++;
      setAccess(false);
      // 光标落到视口首行：该段露出源码，用户看到的就是刚才在看的位置
      const top = view.state.doc.lineAt(view.viewport.from).from;
      view.dispatch({ selection: { anchor: top } });
      view.focus();
    },
    async endEditing() {
      const gen = ++accessGen;
      await (view.plugin(bridge)?.renderNow() ?? Promise.resolve());
      if (gen !== accessGen) return; // 期间又进入了编辑态：保持可编辑
      setAccess(true);
    },
    isReadOnly: () => view.state.readOnly,
    getText: () => view.state.doc.toString(),
    isDirty: () => dirty,
    markSaved() {
      savedDoc = view.state.doc;
      setDirty(false);
    },
    applyExternal(text, html, blocks) {
      const current = view.state.doc.toString();
      const changes = diff(current, text).map((c) => ({ from: c.fromA, to: c.toA, insert: text.slice(c.fromB, c.toB) }));
      syncing = true;
      try {
        // 不进撤销栈：⌘Z 不应撤掉别人在磁盘上做的修改
        view.dispatch({ changes, annotations: [externalSync.of(true), Transaction.addToHistory.of(false)] });
      } finally {
        syncing = false;
      }
      savedDoc = view.state.doc;
      setDirty(false);
      applyBlocks(view, html, blocks);
    },
    headings: () => headings,
    scrollToLine(line) {
      const n = Math.min(Math.max(line, 1), view.state.doc.lines);
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "start" }) });
    },
    destroy() {
      media?.removeEventListener("change", onScheme);
      view.destroy();
    },
  };
}
