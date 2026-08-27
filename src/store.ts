import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DocId } from "./ipc";

export interface TabInfo {
  docId: DocId;
  path: string;
  fileName: string;
  label: string;
}

export type DocMeta = Omit<TabInfo, "label">;

/// 前端唯一的文档状态。权威列表在 Rust，这里是只由事件更新的派生副本
/// （唯一例外是切 tab 的本地先行）。pane DOM 由 preview/document.ts 订阅本 store 投影。
export interface ShellState {
  tabs: TabInfo[]; // 顺序即 Rust docs 顺序
  active: DocId | null;
  // per-doc 异常提示（文件被删 / watch 失败）；有提示即 tab 打异常标记，二者同一事实
  notices: Readonly<Record<DocId, string>>;
  // 全局横幅：open-error 等尚无 doc 可归属的错误
  error: string | null;

  addDoc(meta: DocMeta, activate: boolean): void;
  removeDoc(docId: DocId, nextActive: DocId | null): void;
  setActive(docId: DocId): void;
  setNotice(docId: DocId, message: string): void;
  clearNotice(docId: DocId): void;
  setError(message: string): void;
}

/// 标签消歧：默认 fileName；重名时从路径末尾向前逐段追加（docs/README.md），
/// 直到组内互不相同或到根。
export function disambiguate(paths: string[]): string[] {
  const segs = paths.map((p) => p.split("/").filter(Boolean));
  const depth = segs.map(() => 1);
  const label = (i: number) => segs[i].slice(-depth[i]).join("/");
  // 上界防御：路径段耗尽后 changed 恒为 false，正常在此之前收敛
  for (let round = 0; round < 100; round++) {
    const groups = new Map<string, number[]>();
    segs.forEach((_, i) => {
      const l = label(i);
      groups.set(l, [...(groups.get(l) ?? []), i]);
    });
    let changed = false;
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      for (const i of idxs) {
        if (depth[i] < segs[i].length) {
          depth[i]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return segs.map((_, i) => label(i));
}

function withLabels(tabs: DocMeta[]): TabInfo[] {
  const labels = disambiguate(tabs.map((t) => t.path));
  return tabs.map((t, i) => ({ ...t, label: labels[i] }));
}

export const useShellStore = create<ShellState>()(
  subscribeWithSelector((set) => ({
    tabs: [],
    active: null,
    notices: {},
    error: null,

    // 成功打开（含聚焦已打开的）即撕掉上一次的全局错误横幅
    addDoc(meta, activate) {
      set((s) => {
        const known = s.tabs.some((t) => t.docId === meta.docId);
        const tabs = known ? s.tabs : withLabels([...s.tabs, meta]);
        return { tabs, active: activate ? meta.docId : s.active, error: null };
      });
    },

    removeDoc(docId, nextActive) {
      set((s) => {
        if (!s.tabs.some((t) => t.docId === docId)) return s;
        const tabs = withLabels(s.tabs.filter((t) => t.docId !== docId));
        const notices = { ...s.notices };
        delete notices[docId];
        const active =
          s.active !== docId
            ? s.active
            : nextActive !== null && tabs.some((t) => t.docId === nextActive)
              ? nextActive
              : null;
        return { tabs, notices, active };
      });
    },

    setActive(docId) {
      set((s) => {
        if (s.active === docId || !s.tabs.some((t) => t.docId === docId)) return s;
        return { active: docId, error: null };
      });
    },

    setNotice(docId, message) {
      set((s) => ({ notices: { ...s.notices, [docId]: message } }));
    },

    clearNotice(docId) {
      set((s) => {
        if (!(docId in s.notices)) return s;
        const notices = { ...s.notices };
        delete notices[docId];
        return { notices };
      });
    },

    setError(message) {
      set({ error: message });
    },
  }))
);

/// 横幅只渲染一条：全局错误优先，否则 active doc 自己的提示。
export function selectBanner(s: ShellState): string | null {
  if (s.error !== null) return s.error;
  return s.active !== null ? (s.notices[s.active] ?? null) : null;
}
