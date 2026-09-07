import mermaid from "mermaid";
import { codeBlockSchema } from "@milkdown/preset-commonmark";
import type { Node as PmNode } from "@milkdown/prose/model";
import type { Decoration, NodeView } from "@milkdown/prose/view";
import { $view } from "@milkdown/utils";
import type { Feature } from "../pmEditor";
import { isEditingDecoration } from "./editingBlock";

let mermaidReady = false;
function initMermaid(): void {
  if (mermaidReady) return;
  // jsdom 没有 matchMedia，做特性检测；真实 WebView 始终存在
  const dark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" });
  mermaidReady = true;
}
let seq = 0;

export async function renderMermaid(target: HTMLElement, source: string): Promise<void> {
  initMermaid();
  const id = `rsmd-mermaid-${seq++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    target.innerHTML = svg;
    target.dataset.enhanced = "mermaid";
    delete target.dataset.error;
  } catch (err) {
    // mermaid.render(id, source) 在无容器参数时会先往 document.body 挂一个 `#d${id}` 临时节点，
    // 解析失败时它内部的 removeTempElements() 在 throw 之后才跑，导致该节点永久残留；这里补一刀清掉
    document.getElementById(`d${id}`)?.remove();
    target.textContent = `mermaid: ${err instanceof Error ? err.message : String(err)}`;
    target.dataset.error = "mermaid";
  }
}

/// 进入视口再执行：大文档里几十张图不会在打开瞬间一起跑 mermaid。返回取消函数
export function whenVisible(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb();
    return () => {};
  }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      cb();
    }
  });
  io.observe(el);
  return () => io.disconnect();
}

const isMermaid = (n: PmNode): boolean => String(n.attrs.language ?? "").toLowerCase() === "mermaid";

/// 覆盖 code_block 的默认渲染：普通语言仍是 pre[data-language] > code（shiki 装饰落在 contentDOM 里）；
/// mermaid 外加预览区，光标在内显示源码、离开显示 SVG。语言在 mermaid 与非 mermaid 间切换时返回 false 让 PM 重建视图
const codeBlockView = $view(codeBlockSchema.node, () => (node, _view, _getPos, decorations): NodeView => {
  const mermaidMode = isMermaid(node);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  pre.appendChild(code);
  let dom: HTMLElement = pre;
  let preview: HTMLElement | null = null;
  if (mermaidMode) {
    dom = document.createElement("div");
    dom.className = "rsmd-preview-block";
    dom.dataset.type = "mermaid";
    preview = document.createElement("div");
    preview.className = "rsmd-preview-block__preview";
    preview.contentEditable = "false";
    pre.className = "rsmd-preview-block__source";
    dom.append(preview, pre);
  }
  let rendered: string | null = null;
  let cancelVisible: (() => void) | null = null;
  const sync = (n: PmNode, decos: readonly Decoration[]): void => {
    const lang = String(n.attrs.language ?? "");
    if (lang) pre.dataset.language = lang;
    else delete pre.dataset.language;
    if (!preview) return;
    const editing = isEditingDecoration(decos);
    dom.dataset.editing = editing ? "true" : "false";
    // 挂载时光标可能已经落在块内（比如它是文档第一个节点，ProseMirror 默认选区取 atStart）：
    // 此时 editing 从一开始就是 true，若严格按 !editing 门控会导致预览永远没渲染过。
    // rendered === null 表示"还没渲染过一次"，只在这种首次场景下豁免 editing 门控；
    // 一旦渲染过一次，后续仍然严格遵守"编辑中不重绘"。
    if ((rendered === null || !editing) && rendered !== n.textContent) {
      const src = n.textContent;
      rendered = src;
      cancelVisible?.();
      const target = preview;
      cancelVisible = whenVisible(dom, () => void renderMermaid(target, src));
    }
  };
  sync(node, decorations);
  return {
    dom,
    contentDOM: code,
    update(n, decos) {
      if (n.type !== node.type || isMermaid(n) !== mermaidMode) return false;
      sync(n, decos);
      return true;
    },
    destroy() {
      cancelVisible?.();
    },
    // selection 类型的 mutation 不能被无差别吞掉：光标落在 pre/外层 dom（比如预览区、source 容器本身）
    // 上产生的选区变化也要放行给 PM，否则 PM 会把这次选区变化当成没发生过
    ignoreMutation: (m) => m.type !== "selection" && !(m.target === code || code.contains(m.target)),
  };
});

export const mermaidFeature: Feature = { plugins: [codeBlockView] };
