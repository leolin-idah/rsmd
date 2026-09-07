import { NodeSelection, Plugin, PluginKey, type EditorState } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import { editableCtx, type Feature } from "../pmEditor";

export const EDITING_CLASS = "rsmd-editing";
/// 光标进入时切到源码视图的块类型；节点视图据 decorations 里的 rsmdEditing spec 判断
export const PREVIEW_BLOCKS = new Set(["code_block", "math_block"]);
const key = new PluginKey("rsmdEditingBlock");

export function editingDecorations(state: EditorState, editable: boolean): DecorationSet | null {
  if (!editable) return null;
  const { selection } = state;
  const deco = (from: number, size: number) =>
    DecorationSet.create(state.doc, [Decoration.node(from, from + size, { class: EDITING_CLASS }, { rsmdEditing: true })]);
  if (selection instanceof NodeSelection && PREVIEW_BLOCKS.has(selection.node.type.name)) {
    return deco(selection.from, selection.node.nodeSize);
  }
  const { $from } = selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (!PREVIEW_BLOCKS.has(node.type.name)) continue;
    const from = $from.before(d);
    // 跨块选区不算在块内编辑：选区尾部超出了这个块的范围（比如从块内拖选到后面的段落），
    // 就不装饰；更浅层的祖先不可能再是可预览块，直接返回，不用继续往上找
    if (selection.to > from + node.nodeSize) return null;
    return deco(from, node.nodeSize);
  }
  return null;
}

export const isEditingDecoration = (decorations: readonly Decoration[]): boolean =>
  decorations.some((d) => d.spec.rsmdEditing === true);

const editingBlock = $prose(
  (ctx) =>
    new Plugin({
      key,
      props: {
        decorations: (state) => editingDecorations(state, ctx.get(editableCtx.key).editable),
      },
    })
);

export const editingBlockFeature: Feature = { plugins: [editingBlock] };
