import {
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import type { BlockKind } from "../ipc";
import { enhance } from "../preview/enhance";
import type { Segment } from "./blocks";
import { caretAt, clickPosition } from "./clickPos";

export interface BlockModel {
  segments: Segment[];
  footnotesHtml: string | null;
}

/// 段的字符位置版：from = 首行行首，to = 末行行尾；随编辑经 ChangeSet 映射
export interface PosSegment {
  from: number;
  to: number;
  kind: BlockKind;
  html: string;
}

export interface BlockState {
  segments: PosSegment[];
  footnotesHtml: string | null;
}

export const setBlocks = StateEffect.define<BlockModel>();

export function toPositions(model: BlockModel, doc: Text): PosSegment[] {
  const out: PosSegment[] = [];
  for (const s of model.segments) {
    if (s.fromLine < 1 || s.fromLine > doc.lines) continue;
    const toLine = Math.min(Math.max(s.toLine, s.fromLine), doc.lines);
    out.push({ from: doc.line(s.fromLine).from, to: doc.line(toLine).to, kind: s.kind, html: s.html });
  }
  return out;
}

export const blocksField = StateField.define<BlockState>({
  create: () => ({ segments: [], footnotesHtml: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      // 段首取 -1 侧：在段首插入的文字归本段；段尾取 +1 侧：在段尾追加的文字也归本段
      next = {
        ...value,
        segments: value.segments.map((s) => ({
          ...s,
          from: tr.changes.mapPos(s.from, -1),
          to: tr.changes.mapPos(s.to, 1),
        })),
      };
    }
    for (const e of tr.effects) {
      if (e.is(setBlocks)) {
        next = { segments: toPositions(e.value, tr.state.doc), footnotesHtml: e.value.footnotesHtml };
      }
    }
    return next;
  },
});

/// 段与选区相交即"光标所在段"（含光标恰在段尾）
function intersectsSelection(sel: EditorSelection, from: number, to: number): boolean {
  return sel.ranges.some((r) => r.from <= to && r.to >= from);
}

/// 哪些段露出源码：只读态一个都不露；编辑态露出与选区相交的段。与 segments 等长。
export function revealed(segments: PosSegment[], sel: EditorSelection, editable: boolean): boolean[] {
  return segments.map((s) => editable && intersectsSelection(sel, s.from, s.to));
}

export function segmentIndexAt(segments: PosSegment[], pos: number): number {
  return segments.findIndex((s) => s.from <= pos && pos <= s.to);
}

/// 同一 html 的 DOM 池：CM 会卸载视口外 widget 的 DOM，再滚回来时复用已增强（mermaid/shiki）的节点，
/// 不重跑 enhance；同一 html 在文中出现两次时各取一个未被认领的实例。
export type WidgetCache = Map<string, HTMLElement[]>;

/// 正在被某个 widget 持有的元素。不能用 isConnected 判断空闲：CM 在同一次更新里先为所有新 widget
/// 调 toDOM、之后才把它们挂进 DOM，此时池中元素都还是"未连接"的。toDOM 认领、destroy 归还。
const inUse = new WeakSet<HTMLElement>();

/// blocks 更新后逐出不再出现的 html，防止池子无限增长；被逐出元素的在途 enhance 结果随之作废
export function pruneCache(cache: WidgetCache, keep: Iterable<string>): void {
  const live = new Set(keep);
  for (const key of Array.from(cache.keys())) {
    if (!live.has(key)) cache.delete(key);
  }
}

class BlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    private readonly cache: WidgetCache
  ) {
    super();
  }

  eq(other: BlockWidget): boolean {
    return other.html === this.html;
  }

  toDOM(): HTMLElement {
    const pool = this.cache.get(this.html) ?? [];
    let el = pool.find((e) => !inUse.has(e));
    if (!el) {
      el = document.createElement("div");
      el.className = "markdown-body rsmd-block";
      el.innerHTML = this.html;
      pool.push(el);
      this.cache.set(this.html, pool);
      const owned = el;
      void enhance(owned, () => (this.cache.get(this.html) ?? []).includes(owned));
    }
    inUse.add(el);
    return el;
  }

  destroy(dom: HTMLElement): void {
    inUse.delete(dom);
  }

  // 事件交给 DOM：链接点击由 links.ts 的 pane 级委托处理，块内点击由下面 revealOnClick 里的原生监听处理
  ignoreEvent(): boolean {
    return true;
  }
}

export function buildDecorations(state: EditorState, cache: WidgetCache): DecorationSet {
  const { segments, footnotesHtml } = state.field(blocksField);
  const editable = state.facet(EditorView.editable);
  const show = revealed(segments, state.selection, editable);
  const ranges: Range<Decoration>[] = [];
  let lastTo = -1;
  segments.forEach((s, i) => {
    if (show[i]) return;
    // 映射后可能不再对齐行边界（编辑把两段并成一行）：吸附到整行；与前一段重叠则跳过，等下次渲染修正。
    // block 装饰必须覆盖整行、不得重叠、不得为空
    const from = state.doc.lineAt(s.from).from;
    const to = state.doc.lineAt(Math.max(s.to, from)).to;
    if (from <= lastTo || from === to) return;
    const deco =
      s.kind === "footnote"
        ? Decoration.replace({ block: true }) // 脚注定义：隐藏，渲染版在文末 trailer
        : Decoration.replace({ block: true, widget: new BlockWidget(s.html, cache) });
    ranges.push(deco.range(from, to));
    lastTo = to;
  });
  if (footnotesHtml) {
    ranges.push(
      Decoration.widget({ block: true, side: 1, widget: new BlockWidget(footnotesHtml, cache) }).range(state.doc.length)
    );
  }
  return Decoration.set(ranges, true);
}

/// 编辑态点击渲染块 → 光标移到点击处对应的源码位置（该块随之露出源码）。⌘+点击块内链接留给 links.ts 跟随。
function revealOnMousedown(e: MouseEvent, view: EditorView): boolean {
  if (!view.state.facet(EditorView.editable)) return false;
  const target = e.target as Element | null;
  const block = target?.closest(".rsmd-block");
  if (!block) return false;
  if (e.metaKey && target?.closest("a")) return false;
  view.dispatch({ selection: { anchor: clickedPosition(view, block, e) } });
  view.focus();
  e.preventDefault();
  return true;
}

/// 点击处的源码位置：浏览器给得出插入点时按 sourcepos + 文本对位精确到字（clickPos.ts），否则退到块首
function clickedPosition(view: EditorView, block: Element, e: MouseEvent): number {
  const start = view.posAtDOM(block);
  // 脚注 trailer 挂在文末，源码行却在别处（kind=footnote 的隐藏段）：没有可对位的段，保持落到文末
  if (block.firstElementChild?.classList.contains("footnotes")) return start;
  const caret = caretAt(e.clientX, e.clientY);
  if (!caret) return start;
  const segs = view.state.field(blocksField).segments;
  const i = segmentIndexAt(segs, start);
  if (i < 0) return start;
  return clickPosition({ block, caret, doc: view.state.doc, seg: segs[i], first: i === 0 });
}

/// 编辑态点击渲染块 → 光标移到该块首行。必须用原生 DOM 监听而不是 EditorView.domEventHandlers：
/// widget 的 ignoreEvent 让 CM 完全不处理块内事件（只读态因此保留原生选中/复制与链接点击），
/// 而 CM 的事件管线也据此丢弃块内 mousedown，facet 处理器永远收不到
const revealOnClick = ViewPlugin.define((view) => {
  const onMousedown = (e: MouseEvent): void => {
    revealOnMousedown(e, view);
  };
  view.contentDOM.addEventListener("mousedown", onMousedown);
  return {
    destroy() {
      view.contentDOM.removeEventListener("mousedown", onMousedown);
    },
  };
});

/// 方向键在露出段的首/末行继续移动时跨到相邻段（相邻段是 block widget，CM 默认的垂直移动会被挡住）。
/// 先让 CM 试着按视觉行移动：软换行段落一个逻辑行有多个视觉行，只有当结果离开本段（落进隐藏的
/// widget 范围）或原地不动时才算到了边界
function moveAcross(dir: 1 | -1) {
  return (view: EditorView): boolean => {
    const { state } = view;
    if (!state.facet(EditorView.editable)) return false;
    const main = state.selection.main;
    const segs = state.field(blocksField).segments;
    const i = segmentIndexAt(segs, main.head);
    if (i < 0) return false;
    const tried = view.moveVertically(main, dir === 1);
    if (tried.head !== main.head && segmentIndexAt(segs, tried.head) === i) return false; // 仍在本段内：交给默认行为
    const target = segs[i + dir];
    if (!target) return false;
    // 下移落到下一段首行行首；上移落到上一段末行行首
    const pos = dir === 1 ? state.doc.lineAt(target.from).from : state.doc.lineAt(target.to).from;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    return true;
  };
}

export function blockWidgets(cache: WidgetCache): Extension {
  return [
    blocksField,
    // block 装饰只能由 facet/StateField 提供（不能来自 ViewPlugin）
    EditorView.decorations.compute([blocksField, "selection", EditorView.editable], (state) =>
      buildDecorations(state, cache)
    ),
    revealOnClick,
    Prec.high(
      keymap.of([
        { key: "ArrowDown", run: moveAcross(1) },
        { key: "ArrowUp", run: moveAcross(-1) },
      ])
    ),
  ];
}
