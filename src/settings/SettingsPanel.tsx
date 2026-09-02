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
//
// 控件外观是 macOS 式分段控件 / 开关，但语义仍是原生 radio / checkbox：
// input 视觉隐藏（不可用 display:none，焦点测试与键盘导航都要求它可聚焦），
// label 包裹让点击照常命中 input，勾选态由 :has(input:checked) 投影到样式。
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
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <section className="settings-group">
          <h3>Layout</h3>
          <div className="segmented" role="radiogroup" aria-label="Layout">
            <label className="segment">
              <input
                ref={firstControl}
                type="radio"
                name="layout"
                checked={settings.layout === "tabs"}
                onChange={() => update({ layout: "tabs" })}
              />
              <span>Tabs</span>
            </label>
            <label className="segment">
              <input
                type="radio"
                name="layout"
                checked={settings.layout === "sideList"}
                onChange={() => update({ layout: "sideList" })}
              />
              <span>Side list</span>
            </label>
          </div>
        </section>

        <section className="settings-group">
          <h3>Table of contents</h3>
          <label className="switch-row">
            <span>Show table of contents</span>
            <input
              type="checkbox"
              checked={settings.toc}
              onChange={(e) => update({ toc: e.target.checked })}
            />
            <span className="switch" aria-hidden="true" />
          </label>
          <div className="settings-inline" aria-disabled={!settings.toc}>
            <span>Position</span>
            <div className="segmented" role="radiogroup" aria-label="Position">
              <label className="segment">
                <input
                  type="radio"
                  name="tocSide"
                  disabled={!settings.toc}
                  checked={settings.tocSide === "left"}
                  onChange={() => update({ tocSide: "left" })}
                />
                <span>Left</span>
              </label>
              <label className="segment">
                <input
                  type="radio"
                  name="tocSide"
                  disabled={!settings.toc}
                  checked={settings.tocSide === "right"}
                  onChange={() => update({ tocSide: "right" })}
                />
                <span>Right</span>
              </label>
            </div>
          </div>
          <p className="settings-hint">Hidden automatically when the window is narrow.</p>
        </section>

        <section className="settings-group">
          <h3>Code blocks</h3>
          <label className="switch-row">
            <span>Wrap long lines</span>
            <input
              type="checkbox"
              checked={settings.wrapCode}
              onChange={(e) => update({ wrapCode: e.target.checked })}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        </section>

        <footer className="settings-footer">Changes are saved automatically.</footer>
      </div>
    </div>
  );
}
