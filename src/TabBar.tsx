import { useLayoutEffect, useRef } from "react";
import * as ipc from "./ipc";
import { useShellStore } from "./store";
import type { DocId } from "./ipc";

// tabs 与 sideList 共用同一组件与同一份数据，方向由 body[data-layout] 的 CSS 决定。
// 隐藏式标题栏（titleBarStyle: Overlay）下这条兼任标题栏：data-tauri-drag-region 只在
// mousedown 的 target 恰为打了该属性的元素本身时才启动拖窗，落在 tab / 按钮上的点击不受影响，
// 所以属性打在 #tablist 上即可——空白处（含红绿灯让出的内边距）拖窗口，tab 照常点。
export function TabBar() {
  const tabs = useShellStore((s) => s.tabs);
  const active = useShellStore((s) => s.active);
  const notices = useShellStore((s) => s.notices);
  const dirty = useShellStore((s) => s.dirty);
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
    <div id="tablist" role="tablist" data-tauri-drag-region="">
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
          {/* 尾槽：脏点与关闭按钮共用一个 18px 位（VS Code 式）——未悬停时脏文档显示圆点，
              悬停后圆点让位给 ×；两者叠放避免 hover 时布局抖动。显隐全在 CSS。 */}
          <span className="tab-trailing">
            {dirty[t.docId] === true && (
              <span className="tab-dirty" aria-label="Unsaved changes" />
            )}
            <button className="tab-close" aria-label="Close tab" onClick={(e) => close(e, t.docId)}>
              <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
