import type { Settings } from "../ipc";
import { useShellStore } from "../store";

/// store.settings → body data-* 属性。值的拼写与 Rust serde 一致（"tabs" | "sideList"），
/// theme.css 的 body[data-*] 选择器按同一拼写匹配。
export function applySettingsToBody(s: Settings): void {
  document.body.dataset.layout = s.layout;
  document.body.dataset.toc = s.toc ? "on" : "off";
  document.body.dataset.tocSide = s.tocSide;
  document.body.dataset.wrapCode = s.wrapCode ? "on" : "off";
}

/// DOM 只认 store：面板的本地先行与 Rust 的 settings-changed 回声都先写 store，再由这里投影。
/// 返回退订函数（测试用）；应用里在 initTauriBridge 装一次、永不退订。
export function installSettingsProjection(): () => void {
  return useShellStore.subscribe(
    (s) => s.settings,
    (settings) => {
      if (settings !== null) applySettingsToBody(settings);
    }
  );
}
