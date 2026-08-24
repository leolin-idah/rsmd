import { invoke } from "@tauri-apps/api/core";
import { applyFocus } from "./preview/document";
import { setActiveTab, type DocId, type TabInfo } from "./tabs";

// tabs 与 sideList 共用同一组件与同一份数据，方向由 body[data-layout] 的 CSS 决定
export function TabBar({ tabs, active }: { tabs: TabInfo[]; active: DocId | null }) {
  const select = (docId: DocId) => {
    // 切 tab 不改权威列表：前端立即切 DOM（零延迟），
    // 再 fire-and-forget 让 Rust 更新原生标题栏与菜单勾选（document-focus 回声幂等）
    applyFocus(docId);
    setActiveTab(docId);
    void invoke("set_active_doc", { docId }).catch(() => {});
  };
  const close = (e: React.MouseEvent, docId: DocId) => {
    e.stopPropagation();
    void invoke("close_doc", { docId }).catch(() => {});
  };
  return (
    <div id="tablist" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.docId}
          role="tab"
          aria-selected={t.docId === active}
          className={"tab" + (t.docId === active ? " active" : "")}
          title={t.path}
          onClick={() => select(t.docId)}
        >
          {t.marked && <span className="tab-dot" aria-label="File unavailable" />}
          <span className="tab-label">{t.label}</span>
          <button className="tab-close" aria-label="Close tab" onClick={(e) => close(e, t.docId)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
