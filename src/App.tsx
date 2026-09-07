import { PreviewPane } from "./preview/PreviewPane";
import { reloadFromDisk } from "./preview/document";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { SettingsPanel } from "./settings/SettingsPanel";
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
  const settingsOpen = useShellStore((s) => s.settingsOpen);

  return (
    <div id="shell">
      {/* TabBar 常驻：隐藏式标题栏下没有文档时它就是一条空标题栏——
          红绿灯的落点与整窗唯一的拖拽区，条件渲染会让欢迎页无处拖窗 */}
      <TabBar />
      <div id="main">
        {banner && (
          <div className="banner">
            <svg className="banner-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 1.3 15.4 14H.6L8 1.3Zm0 3.9c-.4 0-.7.3-.7.8l.2 3.5h1l.2-3.5c0-.5-.3-.8-.7-.8Zm0 7.3a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
              />
            </svg>
            <span>{banner.text}</span>
            {banner.action === "reload" && active !== null && (
              <button className="banner-action" onClick={() => reloadFromDisk(active)}>
                Reload
              </button>
            )}
          </div>
        )}
        {!hasDoc && (
          <div className="welcome">
            {/* Markdown 官方标志形状的空态图标，纯装饰 */}
            <svg className="welcome-mark" viewBox="0 0 208 128" aria-hidden="true">
              <rect x="5" y="5" width="198" height="118" rx="12" fill="none" stroke="currentColor" strokeWidth="10" />
              <path
                fill="currentColor"
                d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39Zm125 0-30-33h20V30h20v35h20Z"
              />
            </svg>
            <p className="welcome-title">No document open</p>
            <div className="welcome-hints">
              <div className="welcome-hint">
                <span>Open a Markdown file</span>
                <kbd>⌘O</kbd>
              </div>
              <div className="welcome-hint">
                <span>Toggle edit mode</span>
                <kbd>⌘E</kbd>
              </div>
              <div className="welcome-hint">
                <span>Settings</span>
                <kbd>⌘,</kbd>
              </div>
            </div>
            <p className="welcome-drop">…or drop a file here</p>
          </div>
        )}
        <PreviewPane />
        <StatusBar />
      </div>
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}
