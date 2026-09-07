import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  rootDOMCtx,
  serializerCtx,
} from "@milkdown/core";
import type { Ctx, MilkdownPlugin } from "@milkdown/ctx";
import { commonmark, headingIdGenerator } from "@milkdown/preset-commonmark";
import { columnResizingPlugin, gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { cursor } from "@milkdown/plugin-cursor";
import { indent } from "@milkdown/plugin-indent";
import { $ctx, getMarkdown, replaceAll } from "@milkdown/utils";
import type { Node as PmNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import "@milkdown/prose/view/style/prosemirror.css";
import "@milkdown/prose/tables/style/tables.css";
import "@milkdown/prose/gapcursor/style/gapcursor.css";
import { slugify } from "./slug";

/// 一组 Milkdown 插件 + 可选的 ctx 配置。每个功能（数学 / mermaid / 链接浮条…）导出一个 Feature，
/// 由 mdEditor.ts 汇总传入；测试可以只装需要的那一个。
export interface Feature {
  plugins: MilkdownPlugin[];
  configure?(ctx: Ctx): void;
}

export interface PmHeading {
  id: string;
  text: string;
  level: number;
}

export interface PmEditorOptions {
  parent: HTMLElement;
  text: string;
  editable: boolean;
  features?: Feature[];
  onDocChanged?(doc: PmNode, prevDoc: PmNode | null): void;
}

export interface PmEditor {
  readonly ctx: Ctx;
  /// .milkdown：滚动容器，也是浮条（TooltipProvider）的默认挂载根。
  /// **每次都要现读，不要缓存**（实现里是 getter）：见 createPmEditor 里的说明
  readonly host: HTMLElement;
  view(): EditorView;
  doc(): PmNode;
  parse(text: string): PmNode;
  getMarkdown(): string;
  /// serialize(parse(text))：拿到某段文本经模型一趟后的样子，不动当前文档
  normalize(text: string): string;
  /// 整文替换，重建 EditorState（撤销栈清空）
  replaceAll(text: string): void;
  setEditable(editable: boolean): void;
  isEditable(): boolean;
  headings(): PmHeading[];
  destroy(): Promise<void>;
}

/// 只读态标志：装饰插件（editingBlock）与浮条据此决定是否工作。
/// ProseMirror 自己的 view.editable 在 decorations(state) 回调里拿不到，所以单独存一份。
export const editableCtx = $ctx({ editable: false }, "rsmdEditable");

export function headingsOf(doc: PmNode): PmHeading[] {
  const out: PmHeading[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "heading") return true;
    const text = node.textContent.trim();
    // attrs.id 由 syncHeadingIdPlugin 在编辑后回填，刚解析完是空串：与 toDOM 一样退到生成器
    if (text) out.push({ id: String(node.attrs.id || slugify(text)), text, level: Number(node.attrs.level) });
    return false;
  });
  return out;
}

export async function createPmEditor(opts: PmEditorOptions): Promise<PmEditor> {
  const features = opts.features ?? [];

  const editor = Editor.make()
    .config((ctx) => {
      // 不自己建 .milkdown 容器：core 的 editorView 内部插件会在 rootCtx 元素下自建一个同名容器
      // 再把 ProseMirror dom 挪进去（见 @milkdown/core createViewContainer），自建的话会套两层 .milkdown。
      // 真正的 host 要在 create() 之后从 rootDOMCtx 取。
      ctx.set(rootCtx, opts.parent);
      ctx.set(defaultValueCtx, opts.text);
      ctx.set(editableCtx.key, { editable: opts.editable });
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        editable: () => ctx.get(editableCtx.key).editable,
        // .ProseMirror 挂 markdown-body：后续任务的样式表按 `.milkdown .markdown-body` 选择器写（设计 §6.4）
        attributes: { class: "markdown-body" },
        // plugin-listener 的 updated 回调内部用 lodash debounce(200ms)（7.22.1 源码确认），onDocChanged 需要
        // 随派发同步触发（源码高亮等下游任务据此重算），故接管 dispatchTransaction 自己同步回调；
        // 既然一条回调都不经 listenerCtx，plugin-listener 也就不再装（依赖已移除）。
        // 这里的 apply/updateState 与 EditorView 默认 dispatch 实现完全一致。
        // 用 this 取 view 而非 ctx.get(editorViewCtx)：commonmark 的 syncHeadingIdPlugin 在 EditorView
        // 构造函数收尾的 updatePluginViews() 里就会立刻 dispatch 一次，此时构造还没返回，
        // ctx.set(editorViewCtx, view) 还没执行；但 EditorView 把 dispatch 按 `dispatchTransaction.call(this, tr)`
        // 调用，this.state 在构造函数最前面已经赋值，用 this 拿到的永远是当次这个 view。
        dispatchTransaction(this: EditorView, tr) {
          const prevDoc = this.state.doc;
          const newState = this.state.apply(tr);
          this.updateState(newState);
          if (tr.docChanged) opts.onDocChanged?.(newState.doc, prevDoc);
        },
      }));
      // 序列化风格（设计 §6.3）。强调 / 加粗标记 Milkdown 按原符号回写，不在此配置
      // 字面量都要 as const：ctx.update 的 updater 没标注返回类型，TS 不会用 Options 反向收窄这几个
      // 联合类型字段，不加会被推成 string 而报类型不匹配
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
        fences: true,
        listItemIndent: "one" as const,
      }));
      ctx.set(headingIdGenerator.key, (node: PmNode) => slugify(node.textContent));
      for (const f of features) f.configure?.(ctx);
    })
    .use(editableCtx)
    .use(commonmark)
    // 列宽拖拽对 Markdown 无意义（设计 §6.2 tableBar）
    .use(gfm.filter((p) => p !== columnResizingPlugin))
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(indent)
    .use(features.flatMap((f) => f.plugins));
  await editor.create();

  const ctx = editor.ctx;
  const view = (): EditorView => ctx.get(editorViewCtx);
  return {
    ctx,
    // host 每次从 rootDOMCtx 现取，不能在 create() 后缓存一次：`replaceAll(text, true)` 用
    // EditorState.create 重建 state，新 state 的 plugins 是新数组，而 prosemirror-view 的
    // updatePluginViews 按引用比较（`prevState.plugins != this.state.plugins`），于是销毁并重建
    // 全部 plugin view；core 的 editorView 内部插件（MILKDOWN_VIEW_CLEAR）正是在 view 钩子里
    // createViewContainer 的——每次重建都新造一个 .milkdown 并重新 ctx.set(rootDOMCtx, …)，
    // 旧容器在自己的 destroy 里被 remove。缓存下来的引用替换后就是游离节点，往上写 hidden /
    // 读 scrollTop / getBoundingClientRect 全部静默失效（Task 19 现场：两个视图同时可见）。
    get host() {
      return ctx.get(rootDOMCtx);
    },
    view,
    doc: () => view().state.doc,
    parse: (text) => ctx.get(parserCtx)(text),
    getMarkdown: () => editor.action(getMarkdown()),
    normalize: (text) => ctx.get(serializerCtx)(ctx.get(parserCtx)(text)),
    replaceAll: (text) => editor.action(replaceAll(text, true)),
    setEditable(editable) {
      ctx.set(editableCtx.key, { editable });
      const v = view();
      v.setProps({ editable: () => editable });
      // 空事务让依赖 editable 的装饰插件重算（editingBlock / 浮条的 shouldShow）
      v.dispatch(v.state.tr.setMeta("rsmdEditable", editable));
    },
    isEditable: () => ctx.get(editableCtx.key).editable,
    headings: () => headingsOf(view().state.doc),
    async destroy() {
      // core 的 view 插件在自己的 destroy 里会把 .milkdown 容器换回裸 ProseMirror dom（见 createViewContainer
      // 的 handleDOM），EditorView.destroy() 之后那个裸 dom 还留在 parent 里，这里补一刀清掉
      const dom = view().dom;
      await editor.destroy();
      dom.remove();
    },
  };
}
