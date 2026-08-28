import { PreviewPane } from "./preview/PreviewPane";
import { reloadFromDisk } from "./preview/document";
import { TabBar } from "./TabBar";
import { useShallow } from "zustand/react/shallow";
import { selectBanner, useShellStore } from "./store";

// 外壳只订阅 store 的原子切片（布尔 / 字符串），任何 tab 变化都不会重渲 PreviewPane。
// store 更新经 useSyncExternalStore 以同步优先级提交（同一任务的微任务内、下一次绘制前），
// 因此 events.ts 在同一任务里插入正文 DOM 时，欢迎语不会与正文同显一帧。
export default function App() {
  const hasDoc = useShellStore((s) => s.tabs.length > 0);
  const active = useShellStore((s) => s.active);
  // selectBanner 每次返回新对象：不做浅比较 useSyncExternalStore 会判定快照不稳定而无限重渲
  const banner = useShellStore(useShallow(selectBanner));

  return (
    <div id="shell">
      {hasDoc && <TabBar />}
      <div id="main">
        {banner && (
          <div className="banner">
            <span>{banner.text}</span>
            {banner.action === "reload" && active !== null && (
              <button className="banner-action" onClick={() => reloadFromDisk(active)}>
                Reload
              </button>
            )}
          </div>
        )}
        {!hasDoc && (
          <p className="welcome">Open a Markdown file (⌘O) or drop it here.</p>
        )}
        <PreviewPane />
      </div>
    </div>
  );
}
