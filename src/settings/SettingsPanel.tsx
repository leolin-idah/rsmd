import { useEffect, useRef } from "react";
import * as ipc from "../ipc";
import type { Settings } from "../ipc";
import { editorFor } from "../preview/document";
import { useShellStore } from "../store";

/// 关闭并把键盘焦点还给当前文档的编辑器：面板打开时把焦点拿走了，
/// 不还回去的话关掉后 ⌘E / 方向键无处可去。
function closePanel(): void {
  const store = useShellStore.getState();
  store.closeSettings();
  if (store.active !== null) editorFor(store.active)?.view.focus();
}

// 面板是 store.settings 的纯投影：改值先写 store（勾选零延迟，body.dataset 投影同步跟随），
// 再 fire-and-forget set_settings；Rust 的 settings-changed 回声与本地值相同时 store 不变。
export function SettingsPanel() {
  const settings = useShellStore((s) => s.settings);
  const firstControl = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 编辑态下 CodeMirror 持有焦点，不移走的话按键会落进被遮住的编辑器
    firstControl.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (settings === null) return null; // 握手前没有值可显示

  const update = (patch: Partial<Settings>): void => {
    const next = { ...settings, ...patch };
    useShellStore.getState().setSettings(next);
    void ipc.setSettings(next).catch((err) => useShellStore.getState().setError(String(err)));
  };

  return (
    <div className="settings-backdrop" onClick={closePanel}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button className="settings-close" aria-label="Close settings" onClick={closePanel}>
            ×
          </button>
        </header>

        <section className="settings-group">
          <h3>Layout</h3>
          <label>
            <input
              ref={firstControl}
              type="radio"
              name="layout"
              checked={settings.layout === "tabs"}
              onChange={() => update({ layout: "tabs" })}
            />
            Tabs
          </label>
          <label>
            <input
              type="radio"
              name="layout"
              checked={settings.layout === "sideList"}
              onChange={() => update({ layout: "sideList" })}
            />
            Side list
          </label>
        </section>

        <section className="settings-group">
          <h3>Table of contents</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.toc}
              onChange={(e) => update({ toc: e.target.checked })}
            />
            Show table of contents
          </label>
          <div className="settings-inline" aria-disabled={!settings.toc}>
            <span>Position</span>
            <label>
              <input
                type="radio"
                name="tocSide"
                disabled={!settings.toc}
                checked={settings.tocSide === "left"}
                onChange={() => update({ tocSide: "left" })}
              />
              Left
            </label>
            <label>
              <input
                type="radio"
                name="tocSide"
                disabled={!settings.toc}
                checked={settings.tocSide === "right"}
                onChange={() => update({ tocSide: "right" })}
              />
              Right
            </label>
          </div>
          <p className="settings-hint">Hidden automatically when the window is narrow.</p>
        </section>

        <section className="settings-group">
          <h3>Code blocks</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.wrapCode}
              onChange={(e) => update({ wrapCode: e.target.checked })}
            />
            Wrap long lines
          </label>
        </section>

        <footer className="settings-footer">Changes are saved automatically.</footer>
      </div>
    </div>
  );
}
