import * as ipc from "../ipc";
import { useShellStore } from "../store";
import { editorFor } from "./document";

const reportError = (err: unknown) => useShellStore.getState().setError(String(err));

// StrictMode 下 effect 会双跑：同一宿主只挂一次监听
const installed = new WeakSet<HTMLElement>();

/// 挂在 #panes 宿主上事件委托：一个 listener 服务所有 pane（含 CM widget 内的链接与 TOC）。
export function installLinkHandler(host: HTMLElement): void {
  if (installed.has(host)) return;
  installed.add(host);
  host.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    const pane = a.closest<HTMLElement>(".pane");
    if (!pane) return;
    const docId = Number(pane.dataset.docId);
    if (!Number.isFinite(docId)) return;
    // 编辑态下渲染块内的点击用于把光标移进该块（blockWidgets 的 mousedown），跟随链接须 ⌘+点击；
    // 块外的链接（TOC）不受影响
    if (a.closest(".rsmd-block") && useShellStore.getState().editing[docId] === true && !e.metaKey) return;
    const href = a.getAttribute("href") ?? "";

    if (/^https?:/i.test(href)) {
      e.preventDefault();
      void ipc.openExternal(href).catch(reportError);
    } else if (/\.(md|markdown|mdown)$/i.test(href.split("#")[0])) {
      e.preventDefault();
      // 去掉 fragment（./other.md#intro）并解码百分号转义，否则后端按整串找文件
      void ipc.openRelative(docId, decodeURIComponent(href.split("#")[0])).catch(reportError);
    } else if (href.startsWith("#")) {
      e.preventDefault();
      // 目标标题可能在视口外、尚未渲染成 DOM：按最近一次渲染的"标题 id → 行"表滚动
      const id = decodeURIComponent(href.slice(1));
      const editor = editorFor(docId);
      const line = editor?.headings().find((h) => h.id === id)?.line;
      if (editor && line !== undefined) editor.scrollToLine(line);
    }
  });
}
