import * as ipc from "../ipc";
import type { Settings } from "../ipc";
import { useShellStore } from "../store";
import { closeDoc, openDoc, saveDoc, toggleEdit, updateDoc } from "./document";

// Rust 事件 → 前端动作 的接线表。每个事件只对应一个调用：
// 文档生命周期交给 document.ts（它同时维护 pane 与 store），其余直接改 store。

function applySettings(s: Settings): void {
  // 与 Rust 的 serde 拼写一致（"tabs" | "sideList"），CSS 选择器按同一拼写匹配
  document.body.dataset.layout = s.layout;
  document.body.dataset.toc = s.toc ? "on" : "off";
  document.body.dataset.tocSide = s.tocSide;
}

function installKeyboardShortcuts(): void {
  // ⌃Tab/⌃⇧Tab 是 Next/Prev 的别名：菜单 accelerator 已被 ⌘⇧]/⌘⇧[ 占用，
  // 在前端拦截后调 activate_relative——循环逻辑只存在于 Rust 一处
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      void ipc.activateRelative(e.shiftKey ? -1 : 1).catch(() => {});
    }
  });
}

export async function initTauriBridge(): Promise<void> {
  const store = useShellStore.getState(); // actions 引用稳定，可提前解构
  await ipc.on("document-opened", openDoc);
  await ipc.on("document-updated", updateDoc);
  // ⌘E / ⌘S 是菜单加速键，按键被菜单截获，只能由 Rust 转成事件
  await ipc.on("toggle-edit", (p) => toggleEdit(p.docId));
  await ipc.on("save-requested", (p) => void saveDoc(p.docId, p.closeAfter));
  // 一切 active 变更的统一回执；setActive 幂等，点击 tab 的本地先行不抖动
  await ipc.on("document-focus", (p) => store.setActive(p.docId));
  await ipc.on("document-closed", (p) => closeDoc(p.docId, p.nextActive));
  await ipc.on("document-removed", (p) =>
    store.setNotice(p.docId, "File was deleted or moved. Showing the last rendered version.")
  );
  await ipc.on("watch-unavailable", (p) =>
    store.setNotice(p.docId, "Live reload is unavailable for this file.")
  );
  await ipc.on("settings-changed", applySettings);
  await ipc.on("open-error", store.setError);
  await ipc.onFileDrop((paths) => {
    // 整批一次提交：Rust 只把首个成功的设为 active，其余后台待命；
    // 单文件失败经 open-error 事件上报，不中断其余文件
    void ipc.openPaths(paths).catch((err) => store.setError(String(err)));
  });

  installKeyboardShortcuts();
  applySettings(await ipc.getSettings());
  await ipc.frontendReady();
}
