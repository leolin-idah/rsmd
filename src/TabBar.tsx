import { useLayoutEffect, useRef } from "react";
import * as ipc from "./ipc";
import { useShellStore } from "./store";
import type { DocId } from "./ipc";

// tabs 与 sideList 共用同一组件与同一份数据，方向由 body[data-layout] 的 CSS 决定
export function TabBar() {
  const tabs = useShellStore((s) => s.tabs);
  const active = useShellStore((s) => s.active);
  const notices = useShellStore((s) => s.notices);
  const activeRef = useRef<HTMLDivElement | null>(null);
  // tab 条溢出后可横向滚动（side-list 布局则是纵向）：切文档时把 active tab 拉回可见区，
  // 否则从菜单/快捷键切到滚动区外的文档时看不到高亮。layout effect 在提交内同步执行，
  // 不会让错位的滚动位置被看到一帧。
  useLayoutEffect(() => {
    // jsdom 不实现 scrollIntoView
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);
  const select = (docId: DocId) => {
    // 切 tab 不改权威列表：前端先切 store（零延迟，pane 显隐随之投影），
    // 再 fire-and-forget 让 Rust 更新原生标题栏与菜单勾选（document-focus 回声幂等）
    useShellStore.getState().setActive(docId);
    void ipc.setActiveDoc(docId).catch(() => {});
  };
  const close = (e: React.MouseEvent, docId: DocId) => {
    e.stopPropagation();
    void ipc.closeDoc(docId).catch(() => {});
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
          {notices[t.docId] !== undefined && (
            <span className="tab-dot" aria-label="File unavailable" />
          )}
          <span className="tab-label">{t.label}</span>
          <button className="tab-close" aria-label="Close tab" onClick={(e) => close(e, t.docId)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
