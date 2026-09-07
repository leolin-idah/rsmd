import type { Highlighter } from "shiki";
import type { DocMode } from "../ipc";
import type { TocEntry } from "../preview/toc";
import {
  afterSave,
  applyExternal as applyExternalModel,
  initialModel,
  isDirty,
  switchMode,
  textForSave,
  type DocModel,
  type Engines,
} from "./docModel";
import type { OutlineSource } from "./outline";
import { createPmEditor, type PmEditor } from "./pmEditor";
import { createSourceEditor, type SourceEditor } from "./sourceEditor";
import { headingLines } from "./slug";
import { countText, type TextStats } from "./textStats";
import { editingBlockFeature } from "./plugins/editingBlock";
import { frontmatterFeature } from "./plugins/frontmatter";
import { gfmExtrasFeature } from "./plugins/gfmExtras";
import { getHighlighter, highlightFeature } from "./plugins/highlight";
import { linkBarFeature } from "./plugins/linkBar";
import { localImageFeature } from "./plugins/localImage";
import { mathFeature } from "./plugins/math";
import { mermaidFeature } from "./plugins/mermaid";
import { tableBarFeature } from "./plugins/tableBar";

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  baseDir: string;
  onDirtyChange(dirty: boolean): void;
  onTitleChange(title: string | null): void;
  onHeadingsChange(headings: TocEntry[]): void;
  /// 字数统计，与 onTitleChange / onHeadingsChange 同一个防抖尾部上报
  onStatsChange(stats: TextStats): void;
  onOpenLink(href: string): void;
  highlighter?: Highlighter;
  /// 测试与 perf 页用：拿到两个引擎的实例。正式代码不要依赖
  exposeInternals?(internals: { pm: PmEditor; cm(): SourceEditor | null }): void;
}

export interface EditorHandle extends OutlineSource {
  /// 切模式：不改变焦点，需要时由调用方自己 focus()（后台 tab 补应用模式不该抢焦点）
  setMode(mode: DocMode): void;
  getMode(): DocMode;
  /// 保存用文本：PM 模式序列化，source 模式 CM 原文
  getText(): string;
  /// 当前源文的字数统计（同步；PM 模式要整篇序列化，别在热路径上每帧调）
  stats(): TextStats;
  isDirty(): boolean;
  /// 保存成功后调用，参数是刚写入磁盘的文本
  markSaved(savedText: string): void;
  /// 外部更新（不脏）：整文替换，恢复滚动位置
  applyExternal(text: string): void;
  scrollToAnchor(id: string): void;
  scrollTop(): number;
  setScrollTop(v: number): void;
  focus(): void;
  destroy(): void;
}

/// 标题 / 大纲上报防抖：打字期间不刷菜单与 TOC
const META_DEBOUNCE_MS = 300;
/// 脏位重算防抖：isDirty 在 PM 模式要整篇序列化（Task 20 复测 198KB 文档热态 33ms），
/// 每次事务都跑会把打字延迟顶到 45ms（p95 65ms，超 §9 的 50ms 门槛）。
/// 用「首次立刻 + 尾部补一次」：连打的第一下同步算出脏（● 与 ⌘W 守卫读的是前端推给 Rust 的
/// dirty，不能等），连打期间不算，停手 300ms 后再算一次（撤销回原文要能把 ● 清掉）。
const DIRTY_DEBOUNCE_MS = 300;

/// 每个文档一个实例：Milkdown（preview / live 共用）+ 按需创建的 CM6（source），文本权威见 docModel.ts
export async function createEditor(opts: EditorOptions): Promise<EditorHandle> {
  const highlighter = opts.highlighter ?? (await getHighlighter());
  let cm: SourceEditor | null = null;
  let model: DocModel | null = null;
  let dirty = false;
  let metaTimer: ReturnType<typeof setTimeout> | null = null;
  let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  // 整文替换进行中：期间 PM 派发的事务不是用户编辑，见 engines.pmReplace
  let replacing = false;
  // source 分支 headingTops() 的 slug → 行号表缓存：outline.ts 的 scrollspy 每帧调一次
  // headingTops()，而 headingLines() 要整篇重扫；文本没变就复用上一帧的表
  let cachedText: string | null = null;
  let cachedLines: Map<string, number> | null = null;
  const scrollListeners = new Set<() => void>();
  const fireScroll = (): void => scrollListeners.forEach((cb) => cb());

  // getMarkdown 是整篇序列化（198KB 热态 33ms）：脏判定与字数统计在同一个防抖尾部都要读它，
  // 按 PM doc 身份（ProseMirror 节点不可变）缓存一份，同一状态只序列化一次
  let mdCache: { doc: unknown; md: string } | null = null;
  const engines: Engines = {
    pmMarkdown: () => {
      const doc = pm.view().state.doc;
      if (mdCache?.doc === doc) return mdCache.md;
      const md = pm.getMarkdown();
      mdCache = { doc, md };
      return md;
    },
    pmNormalize: (t) => pm.normalize(t),
    // replaceAll 重建 EditorState → 全部 plugin view 重建，commonmark 的 syncHeadingIdPlugin 在自己的
    // view 钩子里立刻回填 heading id 并 dispatch 一次；那一下会同步走到 onChange，而此时 model 还是
    // 替换前的旧值（docModel 返回后调用方才赋值），拿旧基线算脏会误报 ● 并把过期脏位推给 Rust。
    // 替换后的脏位由调用方（setMode / applyExternal）自己 recompute
    pmReplace: (t) => {
      replacing = true;
      try {
        pm.replaceAll(t);
      } finally {
        replacing = false;
      }
    },
    // docModel 只在 source 模式读它，此时 CM 必然已建好；真缺就现建，不要退回 savedText——
    // 那会让脏判定拿干净基线自比而恒为"不脏"（假阴性，用户的改动会被当成没改）
    cmText: () => (cm ?? ensureCm()).getText(),
    cmSet: (t) => ensureCm().setText(t),
    cmApplyDiff: (t) => ensureCm().applyDiff(t),
  };
  const recompute = (): void => {
    if (!model) return; // 创建期间 listener 的首次回调
    const next = isDirty(model, engines);
    if (next === dirty) return;
    dirty = next;
    opts.onDirtyChange(dirty);
  };
  const scheduleMeta = (): void => {
    if (metaTimer) clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      metaTimer = null;
      if (!model) return; // 创建期那次 onDocChanged 也会 arm 定时器；正常不可达，守卫兜底
      opts.onTitleChange(currentTitle());
      opts.onHeadingsChange(headings());
      opts.onStatsChange(stats());
    }, META_DEBOUNCE_MS);
  };
  /// 取消待跑的尾部重算：调用方紧接着会自己 recompute()，留着只会用过期基线再算一遍
  const cancelDirtyTimer = (): void => {
    if (dirtyTimer) clearTimeout(dirtyTimer);
    dirtyTimer = null;
  };
  const onChange = (): void => {
    if (!model) return; // 创建期 pmEditor 的首次回调：model 还没建，两条支路都无事可做
    if (replacing) return; // 整文替换内部派发的事务不是用户编辑
    if (dirtyTimer) clearTimeout(dirtyTimer);
    // 判据是"当前上报出去的是不脏"，不是"没有待跑的定时器"：markSaved / 撤销回原文都会把 dirty
    // 清成 false 而定时器仍挂着，此时的下一次改动若不同步重算，⌘W / ⌘Q 守卫与 Save 菜单会一直
    // 读到过期的"不脏"，直到尾部定时器才纠正
    if (!dirty) recompute();
    dirtyTimer = setTimeout(() => {
      dirtyTimer = null;
      recompute();
    }, DIRTY_DEBOUNCE_MS);
    scheduleMeta();
  };

  const pm: PmEditor = await createPmEditor({
    parent: opts.parent,
    text: opts.text,
    editable: false,
    features: [
      highlightFeature(highlighter),
      editingBlockFeature,
      mathFeature,
      mermaidFeature,
      frontmatterFeature,
      localImageFeature(opts.baseDir),
      gfmExtrasFeature,
      linkBarFeature({ onOpen: opts.onOpenLink }),
      tableBarFeature(),
    ],
    onDocChanged: onChange,
  });
  // 滚动中继只挂一条：监听 opts.parent 的**捕获**阶段。scroll 事件不冒泡，但捕获阶段仍会经过祖先，
  // 所以这一条同时覆盖 .milkdown（replaceAll 后会被 core 换成新容器，挂在元素上的监听会跟着丢）
  // 与 CM 懒建的 .cm-scroller，不必在两处各挂各摘。
  opts.parent.addEventListener("scroll", fireScroll, { capture: true, passive: true });
  model = initialModel(opts.text, engines);
  opts.exposeInternals?.({ pm, cm: () => cm });

  function ensureCm(): SourceEditor {
    if (!cm) {
      cm = createSourceEditor({ parent: opts.parent, text: model!.savedText, onDocChanged: onChange });
      cm.show(false); // 滚动中继由 opts.parent 上的捕获监听统一负责
    }
    return cm;
  }
  /// 按当前 model.mode 重设两个视图的显隐。必须在每次 docModel 调用**之后**跑：
  /// switchMode / applyExternal 内部可能走 pmReplace，core 会换掉 .milkdown 容器，
  /// 显隐要落在新容器上；而 model 是 docModel 返回后才被重新赋值，所以不能用参数里的 next 提前算。
  const syncVisibility = (): void => {
    const source = model!.mode === "source";
    pm.host.hidden = source;
    cm?.show(source);
  };
  const headings = (): TocEntry[] => pm.headings();
  const stats = (): TextStats => countText(textForSave(model!, engines));
  const currentTitle = (): string | null =>
    model!.mode === "source" ? (cm?.firstH1() ?? null) : (headings().find((h) => h.level === 1)?.text ?? null);
  const scroller = (): HTMLElement => (model!.mode === "source" && cm ? cm.view.scrollDOM : pm.host);
  const headingElements = (): HTMLElement[] =>
    Array.from(pm.view().dom.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));

  const handle: EditorHandle = {
    setMode(next) {
      if (next === model!.mode) return;
      model = switchMode(model!, engines, next);
      pm.setEditable(next === "live");
      syncVisibility();
      cancelDirtyTimer();
      recompute();
      scheduleMeta();
    },
    getMode: () => model!.mode,
    getText: () => textForSave(model!, engines),
    stats,
    isDirty: () => isDirty(model!, engines),
    markSaved(savedText) {
      model = afterSave(model!, engines, savedText);
      cancelDirtyTimer();
      recompute();
    },
    applyExternal(text) {
      const top = scroller().scrollTop;
      model = applyExternalModel(model!, engines, text);
      syncVisibility();
      scroller().scrollTop = top;
      cancelDirtyTimer();
      recompute();
      scheduleMeta();
    },
    headings,
    headingTops() {
      if (model!.mode === "source" && cm) {
        const view = cm.view;
        const text = cm.getText();
        const lines = text === cachedText && cachedLines ? cachedLines : headingLines(text);
        cachedText = text;
        cachedLines = lines;
        return headings().flatMap((h) => {
          const line = lines.get(h.id);
          if (line === undefined) return [];
          const from = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
          return [{ id: h.id, top: view.lineBlockAt(from).top - view.scrollDOM.scrollTop }];
        });
      }
      const base = pm.host.getBoundingClientRect().top;
      return headingElements()
        .filter((h) => h.id)
        .map((h) => ({ id: h.id, top: h.getBoundingClientRect().top - base }));
    },
    onScroll(cb) {
      scrollListeners.add(cb);
      return () => {
        scrollListeners.delete(cb);
      };
    },
    scrollToAnchor(id) {
      if (model!.mode === "source") {
        cm?.scrollToHeading(id);
        return;
      }
      headingElements().find((h) => h.id === id)?.scrollIntoView({ block: "start" });
    },
    scrollTop: () => scroller().scrollTop,
    setScrollTop(v) {
      scroller().scrollTop = v;
    },
    focus() {
      if (model!.mode === "source") cm?.view.focus();
      else if (model!.mode === "live") pm.view().focus();
    },
    destroy() {
      if (metaTimer) clearTimeout(metaTimer);
      cancelDirtyTimer();
      opts.parent.removeEventListener("scroll", fireScroll, { capture: true });
      cm?.destroy();
      void pm.destroy();
    },
  };
  return handle;
}
