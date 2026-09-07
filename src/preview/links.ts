import * as ipc from "../ipc";
import type { DocId } from "../ipc";
import { useShellStore } from "../store";
import { editorFor } from "./document";

const reportError = (err: unknown) => useShellStore.getState().setError(String(err));

// StrictMode 下 effect 会双跑：同一宿主只挂一次监听
const installed = new WeakSet<HTMLElement>();

/// 链接跟随规则（TOC、渲染正文、链接浮条共用）：外链（含 mailto: / tel:）交系统默认处理程序；
/// 相对 .md 开新 tab；锚点滚到标题（目标在 DOM 里，source 模式按行）。返回是否已处理
export function followLink(docId: DocId, href: string): boolean {
  // mailto: / tel: 与 http(s) 一样交给系统：WKWebView 自己打不开，放行只会变成一次失败的顶层跳转
  if (/^(?:https?|mailto|tel):/i.test(href)) {
    void ipc.openExternal(href).catch(reportError);
    return true;
  }
  if (/\.(md|markdown|mdown)$/i.test(href.split("#")[0])) {
    // 去掉 fragment（./other.md#intro）并解码百分号转义，否则后端按整串找文件
    void ipc.openRelative(docId, decodeURIComponent(href.split("#")[0])).catch(reportError);
    return true;
  }
  if (href.startsWith("#")) {
    editorFor(docId)?.scrollToAnchor(decodeURIComponent(href.slice(1)));
    return true;
  }
  return false;
}

/// 挂在 #panes 宿主上事件委托：一个 listener 服务所有 pane（正文与 TOC）。
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
    // live 下正文里的点击用于放置光标，跟随链接须 ⌘+点击；TOC 与 preview 不受影响
    if (a.closest(".ProseMirror") && useShellStore.getState().modes[docId] === "live" && !e.metaKey) return;
    // pane 内的锚点一律拦掉默认导航，再看能不能跟随：followLink 处理不了的 href（相对图片、
    // 非 .md 的相对文件、被净化成空串的 javascript: 链接）若放行，WKWebView 会做顶层跳转，
    // 整个前端被替换掉且没有后退路径
    e.preventDefault();
    followLink(docId, a.getAttribute("href") ?? "");
  });
}
