import { useLayoutEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { applyFocus } from "./preview/document";
import { setActiveTab, type DocId, type TabInfo } from "./tabs";

// tabs 与 sideList 共用同一组件与同一份数据，方向由 body[data-layout] 的 CSS 决定
export function TabBar({ tabs, active }: { tabs: TabInfo[]; active: DocId | null }) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  // tab 条溢出后可横向滚动（side-list 布局则是纵向）：切文档时把 active tab 拉回可见区，
  // 否则从菜单/快捷键切到滚动区外的文档时看不到高亮。用 layout effect 而非 useEffect，
  // 与 App 里 tabs 事件的同步提交保持一致，避免错位的滚动位置被看到一帧。
  useLayoutEffect(() => {
    // jsdom 不实现 scrollIntoView
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
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
          ref={t.docId === active ? activeRef : null}
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
