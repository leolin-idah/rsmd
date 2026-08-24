import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

function banner(message: string): void {
  window.dispatchEvent(new CustomEvent("rsmd:banner", { detail: message }));
}

// StrictMode 下 effect 会双跑：同一宿主只挂一次监听
const installed = new WeakSet<HTMLElement>();

/// 挂在 #panes 宿主上事件委托：一个 listener 服务所有 pane。
export function installLinkHandler(host: HTMLElement): void {
  if (installed.has(host)) return;
  installed.add(host);
  host.addEventListener("click", (e) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    const pane = a.closest<HTMLElement>(".pane");
    if (!pane) return;
    const href = a.getAttribute("href") ?? "";

    if (/^https?:/i.test(href)) {
      e.preventDefault();
      void openUrl(href).catch((err) => banner(String(err)));
    } else if (/\.(md|markdown|mdown)$/i.test(href.split("#")[0])) {
      e.preventDefault();
      const docId = Number(pane.dataset.docId);
      if (!Number.isFinite(docId)) return;
      // 去掉 fragment（./other.md#intro）并解码百分号转义，否则后端按整串找文件
      void invoke("open_relative", {
        docId,
        href: decodeURIComponent(href.split("#")[0]),
      }).catch((err) => banner(String(err)));
    } else if (href.startsWith("#")) {
      e.preventDefault();
      // 锚点必须限定在当前 pane 内查找：comrak 生成的标题 id 极易跨文档重名，
      // document.getElementById 可能命中隐藏 pane 里的元素而静默失败
      const id = href.slice(1).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      pane.querySelector(`[id="${id}"]`)?.scrollIntoView();
    }
  });
}
