import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  closeDoc,
  openDoc,
  updateDoc,
  applyFocus,
  type DocOpenedPayload,
  type DocUpdatedPayload,
} from "./document";
import { addTab, clearMark, markTab, removeTab, setActiveTab, type DocId } from "../tabs";

interface DocRefPayload {
  docId: DocId;
}

interface DocClosedPayload {
  docId: DocId;
  nextActive: DocId | null;
}

export interface Settings {
  layout: "tabs" | "sideList";
  toc: boolean;
  tocSide: "left" | "right";
}

function globalBanner(message: string): void {
  window.dispatchEvent(new CustomEvent("rsmd:banner", { detail: message }));
}

function docBanner(docId: DocId, message: string): void {
  window.dispatchEvent(new CustomEvent("rsmd:doc-banner", { detail: { docId, message } }));
}

function docBannerClear(docId: DocId): void {
  window.dispatchEvent(new CustomEvent("rsmd:doc-banner-clear", { detail: { docId } }));
}

function applySettings(s: Settings): void {
  document.body.dataset.layout = s.layout === "sideList" ? "side-list" : "tabs";
  document.body.dataset.toc = s.toc ? "on" : "off";
  document.body.dataset.tocSide = s.tocSide;
}

function installKeyboardShortcuts(): void {
  // ⌃Tab/⌃⇧Tab 是 Next/Prev 的别名：菜单 accelerator 已被 ⌘⇧]/⌘⇧[ 占用，
  // 在前端拦截后调 activate_relative——循环逻辑只存在于 Rust 一处
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      void invoke("activate_relative", { offset: e.shiftKey ? -1 : 1 }).catch(() => {});
    }
  });
}

export async function initTauriBridge(): Promise<void> {
  await listen<DocOpenedPayload>("document-opened", (e) => {
    // 同步清全局横幅（open-error）：必须早于 enhance（异步）
    window.dispatchEvent(new CustomEvent("rsmd:banner-clear"));
    addTab(e.payload.docId, e.payload.path, e.payload.fileName);
    void openDoc(e.payload);
  });
  await listen<DocUpdatedPayload>("document-updated", (e) => {
    // 该 doc 的横幅与异常标记清除（文件恢复后 watcher 继续触发 Modified）
    docBannerClear(e.payload.docId);
    clearMark(e.payload.docId);
    void updateDoc(e.payload);
  });
  await listen<DocRefPayload>("document-focus", (e) => {
    // 一切 active 变更的统一回执；applyFocus 幂等，点击 tab 的本地先行不抖动
    window.dispatchEvent(new CustomEvent("rsmd:banner-clear"));
    applyFocus(e.payload.docId);
    setActiveTab(e.payload.docId);
  });
  await listen<DocClosedPayload>("document-closed", (e) => {
    docBannerClear(e.payload.docId);
    closeDoc(e.payload.docId, e.payload.nextActive);
    removeTab(e.payload.docId, e.payload.nextActive);
  });
  await listen<DocRefPayload>("document-removed", (e) => {
    docBanner(e.payload.docId, "File was deleted or moved. Showing the last rendered version.");
    markTab(e.payload.docId);
  });
  await listen<DocRefPayload>("watch-unavailable", (e) => {
    docBanner(e.payload.docId, "Live reload is unavailable for this file.");
    markTab(e.payload.docId);
  });
  await listen<Settings>("settings-changed", (e) => {
    applySettings(e.payload);
  });
  await listen<string>("open-error", (e) => {
    globalBanner(e.payload);
  });
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") {
      for (const path of e.payload.paths) {
        invoke("open_path", { path }).catch((err) => globalBanner(String(err)));
      }
    }
  });

  installKeyboardShortcuts();
  applySettings(await invoke<Settings>("get_settings"));
  await invoke("frontend_ready");
}
