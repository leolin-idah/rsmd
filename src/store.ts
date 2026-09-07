import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DocId, DocMode, Settings } from "./ipc";
import type { TextStats } from "./editor/textStats";

export interface TabInfo {
  docId: DocId;
  path: string;
  fileName: string;
  label: string;
}

export type DocMeta = Omit<TabInfo, "label">;

export interface Banner {
  text: string;
  action: "reload" | null; // reload = 编辑中收到外部改动，按钮丢弃本地改动重载
}

/// 前端唯一的文档状态。权威列表在 Rust，这里是只由事件更新的派生副本
/// （唯一例外是切 tab 的本地先行）。pane DOM 由 preview/document.ts 订阅本 store 投影。
export interface ShellState {
  tabs: TabInfo[]; // 顺序即 Rust docs 顺序
  active: DocId | null;
  // per-doc 异常提示（文件被删 / watch 失败）；有提示即 tab 打异常标记，二者同一事实
  notices: Readonly<Record<DocId, string>>;
  // 全局横幅：open-error 等尚无 doc 可归属的错误
  error: string | null;
  // 以下三组都是稀疏表：dirty/conflicts 只存 true，置 false 即删键；
  // modes 只存非默认模式，preview 即删键
  dirty: Readonly<Record<DocId, boolean>>; // 编辑器有未保存改动 → tab ●
  modes: Readonly<Record<DocId, DocMode>>; // 文档展示模式（live 下链接需 ⌘+点击）
  conflicts: Readonly<Record<DocId, boolean>>; // 编辑中收到外部改动，等 Reload
  // 状态栏字数：编辑器创建后写入，之后随 meta 防抖更新；无编辑器（后台待命）即无键
  stats: Readonly<Record<DocId, TextStats>>;
  // Rust Settings 的投影：null = 握手前尚未收到。面板改值本地先行写这里，
  // body.dataset 的 DOM 投影订阅本字段（settings/projection.ts），Rust 回声幂等
  settings: Settings | null;
  settingsOpen: boolean; // Settings 面板是否打开（open-settings 事件 / Esc / ✕）

  addDoc(meta: DocMeta, activate: boolean): void;
  removeDoc(docId: DocId, nextActive: DocId | null): void;
  setActive(docId: DocId): void;
  setNotice(docId: DocId, message: string): void;
  clearNotice(docId: DocId): void;
  setError(message: string): void;
  setDirty(docId: DocId, dirty: boolean): void;
  setMode(docId: DocId, mode: DocMode): void;
  setConflict(docId: DocId, conflict: boolean): void;
  setStats(docId: DocId, stats: TextStats): void;
  setSettings(settings: Settings): void;
  openSettings(): void;
  closeSettings(): void;
}

type FlagKey = "dirty" | "conflicts";

/// 稀疏布尔表的统一写法：不变则返回原对象（订阅者不被唤醒）
function setFlag(
  s: ShellState,
  key: FlagKey,
  docId: DocId,
  value: boolean
): Partial<ShellState> | ShellState {
  const table = s[key];
  const has = table[docId] === true;
  if (has === value) return s;
  const next = { ...table };
  if (value) next[docId] = true;
  else delete next[docId];
  return { [key]: next } as Partial<ShellState>;
}

function without<T>(table: Readonly<Record<DocId, T>>, docId: DocId): Record<DocId, T> {
  const next = { ...table };
  delete next[docId];
  return next;
}

/// Settings 是扁平的原始值对象：逐键比较，新增字段无需改这里
function sameSettings(a: Settings, b: Settings): boolean {
  return (Object.keys(b) as (keyof Settings)[]).every((k) => a[k] === b[k]);
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
    dirty: {},
    modes: {},
    conflicts: {},
    stats: {},
    settings: null,
    settingsOpen: false,

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
        return {
          tabs,
          notices,
          active,
          dirty: without(s.dirty, docId),
          modes: without(s.modes, docId),
          conflicts: without(s.conflicts, docId),
          stats: without(s.stats, docId),
        };
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

    setDirty(docId, dirty) {
      set((s) => setFlag(s, "dirty", docId, dirty));
    },
    setMode(docId, mode) {
      set((s) => {
        if ((s.modes[docId] ?? "preview") === mode) return s; // 不变则原对象，订阅者不被唤醒
        const modes = { ...s.modes };
        if (mode === "preview") delete modes[docId];
        else modes[docId] = mode;
        return { modes };
      });
    },
    setConflict(docId, conflict) {
      set((s) => setFlag(s, "conflicts", docId, conflict));
    },
    setStats(docId, stats) {
      set((s) => {
        const cur = s.stats[docId];
        if (cur && cur.words === stats.words && cur.chars === stats.chars) return s; // 值相同不唤醒订阅者
        return { stats: { ...s.stats, [docId]: stats } };
      });
    },
    setSettings(settings) {
      set((s) => (s.settings !== null && sameSettings(s.settings, settings) ? s : { settings }));
    },
    openSettings() {
      set((s) => (s.settingsOpen ? s : { settingsOpen: true }));
    },
    closeSettings() {
      set((s) => (s.settingsOpen ? { settingsOpen: false } : s));
    },
  }))
);

export const CONFLICT_TEXT = "File changed on disk. Reload to discard your unsaved edits.";

/// 横幅只渲染一条：全局错误 > active doc 的冲突 > active doc 的提示。
export function selectBanner(s: ShellState): Banner | null {
  if (s.error !== null) return { text: s.error, action: null };
  if (s.active === null) return null;
  if (s.conflicts[s.active]) return { text: CONFLICT_TEXT, action: "reload" };
  const notice = s.notices[s.active];
  return notice !== undefined ? { text: notice, action: null } : null;
}
