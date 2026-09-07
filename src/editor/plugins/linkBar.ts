import type { Ctx } from "@milkdown/ctx";
import { TooltipProvider } from "@milkdown/plugin-tooltip";
import type { Mark } from "@milkdown/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose, $useKeymap } from "@milkdown/utils";
import type { Feature } from "../pmEditor";

export interface LinkRange {
  from: number;
  to: number;
  href: string;
  title: string | null;
}

interface LinkBarState {
  /// ⌘K / Edit 进入的编辑范围；随文档变化映射；null = 显示态
  edit: { from: number; to: number } | null;
}

export const linkBarKey = new PluginKey<LinkBarState>("rsmdLinkBar");

/// 光标所在的链接：同一文本块里带相同 link 标记的连续子节点，取覆盖选区的那一段
export function linkRangeAt(state: EditorState): LinkRange | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;
  const { $from, from, to } = state.selection;
  const mark: Mark | undefined =
    linkType.isInSet($from.marks()) ??
    (state.doc.rangeHasMark(from, to, linkType) ? linkType.isInSet($from.nodeAfter?.marks ?? []) : undefined);
  if (!mark) return null;
  const parent = $from.parent;
  const start = $from.start();
  let offset = 0;
  let runFrom = -1;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const a = start + offset;
    const b = a + child.nodeSize;
    offset += child.nodeSize;
    if (!child.marks.some((m) => m.eq(mark))) {
      runFrom = -1;
      continue;
    }
    if (runFrom < 0) runFrom = a;
    const next = i + 1 < parent.childCount ? parent.child(i + 1) : null;
    const runEnds = !next || !next.marks.some((m) => m.eq(mark));
    if (!runEnds) continue;
    if (runFrom <= from && to <= b) {
      return { from: runFrom, to: b, href: String(mark.attrs.href ?? ""), title: (mark.attrs.title as string | null) ?? null };
    }
    runFrom = -1;
  }
  return null;
}

class LinkBarView {
  private readonly provider: TooltipProvider;
  private readonly content = document.createElement("div");
  private readonly hrefEl = document.createElement("span");
  private readonly input = document.createElement("input");

  constructor(
    private readonly view: EditorView,
    private readonly onOpen: (href: string) => void
  ) {
    this.content.className = "rsmd-linkbar";
    this.hrefEl.className = "rsmd-linkbar__href";
    this.input.className = "rsmd-linkbar__input";
    this.input.placeholder = "https://";
    this.input.spellcheck = false;
    const btn = (action: string, label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.action = action;
      b.textContent = label;
      return b;
    };
    this.content.append(this.hrefEl, btn("edit", "Edit"), btn("open", "Open"), btn("remove", "Remove"), this.input);
    this.content.addEventListener("mousedown", (e) => {
      if (e.target !== this.input) e.preventDefault(); // 点按钮不让编辑器失焦
    });
    this.content.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.action;
      if (action === "edit") this.beginEdit();
      else if (action === "open") this.open();
      else if (action === "remove") this.remove();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    // 失焦即取消编辑态：用户不按 Enter/Esc、而是直接点到文档别处继续编辑时，
    // 浮条不能永远停在编辑态（否则位置和光标脱节）。Enter/Esc 已经把 edit 置空，
    // 之后触发的这个 blur 只是 no-op；这里不 focus() 编辑器——失焦通常就是用户主动点走了。
    this.input.addEventListener("blur", () => {
      if (linkBarKey.getState(this.view.state)?.edit) {
        this.view.dispatch(this.view.state.tr.setMeta(linkBarKey, { edit: null }));
      }
    });
    this.provider = new TooltipProvider({
      content: this.content,
      debounce: 0,
      shouldShow: (v) => v.editable && this.target(v.state) !== null,
    });
    this.provider.onShow = () => this.render();
  }

  private target(state: EditorState): (LinkRange & { editing: boolean }) | null {
    const edit = linkBarKey.getState(state)?.edit ?? null;
    const range = linkRangeAt(state);
    if (edit) return { from: edit.from, to: edit.to, href: range?.href ?? "", title: range?.title ?? null, editing: true };
    return range ? { ...range, editing: false } : null;
  }

  private render(): void {
    const t = this.target(this.view.state);
    if (!t) return;
    this.content.dataset.mode = t.editing ? "edit" : "show";
    this.hrefEl.textContent = t.href;
    if (t.editing && document.activeElement !== this.input) {
      this.input.value = t.href;
      requestAnimationFrame(() => {
        this.input.focus();
        this.input.select();
      });
    }
  }

  private beginEdit(): void {
    const r = linkRangeAt(this.view.state);
    if (!r) return;
    this.view.dispatch(this.view.state.tr.setMeta(linkBarKey, { edit: { from: r.from, to: r.to } }));
  }

  private open(): void {
    const r = linkRangeAt(this.view.state);
    if (r?.href) this.onOpen(r.href);
  }

  private remove(): void {
    const r = linkRangeAt(this.view.state);
    if (!r) return;
    this.view.dispatch(this.view.state.tr.removeMark(r.from, r.to, this.view.state.schema.marks.link));
    this.view.focus();
  }

  private commit(): void {
    const t = this.target(this.view.state);
    if (!t?.editing) return;
    const linkType = this.view.state.schema.marks.link;
    const href = this.input.value.trim();
    let tr = this.view.state.tr.setMeta(linkBarKey, { edit: null }).removeMark(t.from, t.to, linkType);
    if (href) tr = tr.addMark(t.from, t.to, linkType.create({ href, title: t.title }));
    tr = tr.setSelection(TextSelection.create(tr.doc, t.to));
    this.view.dispatch(tr);
    this.view.focus();
  }

  private cancel(): void {
    this.view.dispatch(this.view.state.tr.setMeta(linkBarKey, { edit: null }));
    this.view.focus();
  }

  update(view: EditorView, prevState?: EditorState): void {
    this.provider.update(view, prevState);
    // ⌘K / beginEdit / cancel 都只是 setMeta，不改 doc 也不改 selection：TooltipProvider.#onUpdate
    // 内部按 (doc, selection) 相等短路跳过 show()/hide()，导致纯靠 meta 触发的显隐永远追不上来。
    // 用我们自己算的 target 状态和当前 dataset.show 对比，不一致时不带 prevState 再 update 一次，
    // 让 isSame 判定失效，走完整的 shouldShow → show/hide（含定位）流程。
    const wantShow = view.editable && this.target(view.state) !== null;
    if (wantShow !== (this.content.dataset.show === "true")) this.provider.update(view);
    if (this.content.dataset.show === "true") this.render();
  }

  destroy(): void {
    this.provider.destroy();
  }
}

export function linkBarFeature(opts: { onOpen(href: string): void }): Feature {
  const plugin = $prose(
    (_ctx: Ctx) =>
      new Plugin<LinkBarState>({
        key: linkBarKey,
        state: {
          init: () => ({ edit: null }),
          apply(tr, prev) {
            const meta = tr.getMeta(linkBarKey) as LinkBarState | undefined;
            if (meta) return meta;
            if (prev.edit && tr.docChanged) {
              const from = tr.mapping.map(prev.edit.from);
              const to = tr.mapping.map(prev.edit.to);
              // 编辑区间内容被整体删除后映射会塌缩成 from >= to（零宽甚至倒挂）：
              // 这时区间已经没有意义，清空 edit，避免 commit() 在空区间上悄悄丢弃用户的修改
              if (from >= to) return { edit: null };
              return { edit: { from, to } };
            }
            return prev;
          },
        },
        view: (view) => new LinkBarView(view, opts.onOpen),
      })
  );
  const keymap = $useKeymap("rsmdLinkBar", {
    EditLink: {
      shortcuts: "Mod-k",
      command: () => (state, dispatch) => {
        const range = linkRangeAt(state);
        const target = range ?? (state.selection.empty ? null : { from: state.selection.from, to: state.selection.to });
        if (!target) return false;
        dispatch?.(state.tr.setMeta(linkBarKey, { edit: { from: target.from, to: target.to } }));
        return true;
      },
    },
  });
  return { plugins: [plugin, keymap].flat() };
}
