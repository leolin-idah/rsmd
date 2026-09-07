import { listItemSchema } from "@milkdown/preset-commonmark";
import type { Node as PmNode } from "@milkdown/prose/model";
import { Plugin } from "@milkdown/prose/state";
import type { NodeView } from "@milkdown/prose/view";
import { $prose, $view } from "@milkdown/utils";
import type { Feature } from "../pmEditor";

/// gfm 只给 list_item 一个 checked 属性（toDOM 写成 data-checked），勾选框要自己画。
/// 复用 github-markdown-css 的 .task-list-item / .task-list-item-checkbox 样式
const taskItemView = $view(listItemSchema.node, () => (node, view, getPos): NodeView => {
  const li = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-list-item-checkbox rsmd-task-checkbox";
  checkbox.contentEditable = "false";
  const content = document.createElement("div");
  content.className = "rsmd-li-content";
  li.appendChild(content);

  const apply = (n: PmNode): void => {
    const checked = n.attrs.checked as boolean | null | undefined;
    li.dataset.label = String(n.attrs.label ?? "");
    li.dataset.listType = String(n.attrs.listType ?? "");
    li.dataset.spread = String(n.attrs.spread ?? "");
    if (checked == null) {
      li.classList.remove("task-list-item");
      delete li.dataset.itemType;
      delete li.dataset.checked;
      checkbox.remove();
      return;
    }
    li.classList.add("task-list-item");
    li.dataset.itemType = "task";
    li.dataset.checked = String(checked);
    checkbox.checked = checked;
    if (!checkbox.isConnected) li.prepend(checkbox);
  };
  checkbox.addEventListener("mousedown", (e) => e.preventDefault()); // 不移动光标、不让 PM 处理选区
  checkbox.addEventListener("click", (e) => {
    // jsdom/浏览器对 checkbox 的 click 有"预激活"语义：分派 click 前先乐观翻转 checked，
    // 若监听器里调用了 preventDefault，分派结束前会把 checked 强制复原——即使监听器里手动
    // 再赋值也会被复原覆盖（复原发生在所有监听器跑完之后，仍在同一次 dispatchEvent 内，
    // 无法用微任务规避，因为测试在 dispatchEvent 后同步断言）。所以只读态用 preventDefault
    // 复原原生翻转；可编辑态不 preventDefault，让原生翻转落地，再用它同步落库
    if (!view.editable) {
      e.preventDefault();
      return;
    }
    const pos = getPos();
    if (pos === undefined) return;
    const n = view.state.doc.nodeAt(pos);
    if (!n) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, checked: !n.attrs.checked }));
  });
  apply(node);
  return {
    dom: li,
    contentDOM: content,
    update(n) {
      if (n.type !== node.type) return false;
      apply(n);
      return true;
    },
    ignoreMutation: (m) => m.type !== "selection" && !(m.target === content || content.contains(m.target)),
  };
});

/// 点击脚注引用滚到定义（定义就地渲染成 dl，见 theme.css）
const footnoteJump = $prose(
  () =>
    new Plugin({
      props: {
        handleClickOn(view, _pos, node, _nodePos, event) {
          if (node.type.name !== "footnote_reference") return false;
          const label = String(node.attrs.label);
          const def = Array.from(view.dom.querySelectorAll<HTMLElement>('dl[data-type="footnote_definition"]')).find(
            (d) => d.dataset.label === label
          );
          if (!def) return false;
          def.scrollIntoView({ block: "start", behavior: "smooth" });
          event.preventDefault();
          return true;
        },
      },
    })
);

export const gfmExtrasFeature: Feature = { plugins: [taskItemView, footnoteJump] };
