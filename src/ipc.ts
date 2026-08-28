// 与 Rust 侧的全部契约收口于此：事件名与载荷类型、命令包装、平台 API。
// 这是唯一允许 import `@tauri-apps/*` 的模块——测试只需 mock 本模块一处。
// 载荷字段与 src-tauri/src/ipc.rs 一一对应（serde camelCase）。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";

export type DocId = number;

export type Layout = "tabs" | "sideList";
export type TocSide = "left" | "right";

export interface Settings {
  layout: Layout;
  toc: boolean;
  tocSide: TocSide;
}

export type BlockKind = "node" | "html" | "footnote";

/// 顶层块的源码行范围（1-based，含首尾），镜像 render.rs 的 BlockRange
export interface BlockRange {
  from: number;
  to: number;
  kind: BlockKind;
}

/// render_markdown 命令的返回值
export interface RenderPayload {
  html: string;
  blocks: BlockRange[];
  title: string;
}

export interface DocOpenedPayload {
  docId: DocId;
  path: string;
  fileName: string;
  text: string;
  html: string;
  blocks: BlockRange[];
  title: string;
  baseDir: string;
  // 批量打开时只有首个成功的文档为 true；false = 后台待命，不设 active、不渲染
  activate: boolean;
}

export interface DocUpdatedPayload {
  docId: DocId;
  text: string;
  html: string;
  blocks: BlockRange[];
  title: string;
  // false = 内容与我们最近一次看到/写入的一致（自己保存的回声）
  external: boolean;
}

export interface DocRefPayload {
  docId: DocId;
}

export interface DocClosedPayload {
  docId: DocId;
  nextActive: DocId | null;
}

export interface SaveRequestedPayload {
  docId: DocId;
  closeAfter: boolean;
}

/// Rust → 前端 事件表（事件名 → 载荷）。
export interface Events {
  "document-opened": DocOpenedPayload;
  "document-updated": DocUpdatedPayload;
  "document-focus": DocRefPayload;
  "document-closed": DocClosedPayload;
  "document-removed": DocRefPayload;
  "watch-unavailable": DocRefPayload;
  "settings-changed": Settings;
  "open-error": string;
  "toggle-edit": DocRefPayload;
  "save-requested": SaveRequestedPayload;
}

export function on<K extends keyof Events>(
  name: K,
  handler: (payload: Events[K]) => void
): Promise<UnlistenFn> {
  return listen<Events[K]>(name, (e) => handler(e.payload));
}

export function onFileDrop(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") handler(e.payload.paths);
  });
}

// ---- 前端 → Rust 命令 ----

export const openPaths = (paths: string[]): Promise<void> => invoke("open_paths", { paths });

export const openRelative = (docId: DocId, href: string): Promise<void> =>
  invoke("open_relative", { docId, href });

export const closeDoc = (docId: DocId): Promise<void> => invoke("close_doc", { docId });

export const setActiveDoc = (docId: DocId): Promise<void> =>
  invoke("set_active_doc", { docId });

export const activateRelative = (offset: 1 | -1): Promise<void> =>
  invoke("activate_relative", { offset });

export const getSettings = (): Promise<Settings> => invoke<Settings>("get_settings");

export const frontendReady = (): Promise<void> => invoke("frontend_ready");

export const renderMarkdown = (docId: DocId, text: string): Promise<RenderPayload> =>
  invoke<RenderPayload>("render_markdown", { docId, text });

export const saveDoc = (docId: DocId, text: string): Promise<void> =>
  invoke("save_doc", { docId, text });

export const setDocState = (docId: DocId, editing: boolean, dirty: boolean): Promise<void> =>
  invoke("set_doc_state", { docId, editing, dirty });

// ---- 平台 API ----

/// 交系统浏览器打开外链。
export const openExternal = (url: string): Promise<void> => openUrl(url);

/// 本地绝对路径 → asset protocol URL（<img src>）。
export const assetUrl = (path: string): string => convertFileSrc(path);
