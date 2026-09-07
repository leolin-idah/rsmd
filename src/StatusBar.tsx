import type { DocMode } from "./ipc";
import { setDocMode } from "./preview/document";
import { useShellStore } from "./store";

const MODES: { value: DocMode; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "live", label: "Live" },
  { value: "source", label: "Source" },
];

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

// 底部状态栏：路径 · 字数 · 模式切换。只订阅 active 文档的原子切片（字符串 / 枚举 / 单条 stats），
// 其它 tab 的变化不会重渲这里。切模式走 document.ts 的 setDocMode，store、编辑器与 Rust 菜单勾选一并同步。
export function StatusBar() {
  const active = useShellStore((s) => s.active);
  const path = useShellStore((s) => s.tabs.find((t) => t.docId === s.active)?.path ?? null);
  const mode = useShellStore((s) => (s.active === null ? "preview" : (s.modes[s.active] ?? "preview")));
  const stats = useShellStore((s) => (s.active === null ? undefined : s.stats[s.active]));
  // 目录段可截断、文件名永远完整：窄窗口下先牺牲前面的路径
  const cut = path === null ? 0 : path.lastIndexOf("/") + 1;
  return (
    <footer id="statusbar">
      <span className="status-path" title={path ?? undefined}>
        {path !== null && (
          <>
            <span className="status-dir">{path.slice(0, cut)}</span>
            <span className="status-name">{path.slice(cut)}</span>
          </>
        )}
      </span>
      {stats && (
        <span className="status-stats">
          {plural(stats.words, "word")} · {plural(stats.chars, "char")}
        </span>
      )}
      <div className="segmented segmented-compact" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <label key={m.value} className="segment">
            <input
              type="radio"
              name="mode"
              value={m.value}
              checked={mode === m.value}
              disabled={active === null}
              onChange={() => {
                if (active !== null) setDocMode(active, m.value);
              }}
            />
            {m.label}
          </label>
        ))}
      </div>
    </footer>
  );
}
