import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Events, Settings } from "../ipc";

// 假 ipc：记录事件处理器，测试里手动触发；命令全部是 spy
const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const drop: { handler: ((paths: string[]) => void) | null } = { handler: null };
  return {
    handlers,
    drop,
    on: vi.fn(async (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => {};
    }),
    onFileDrop: vi.fn(async (handler: (paths: string[]) => void) => {
      drop.handler = handler;
      return () => {};
    }),
    getSettings: vi.fn(
      async (): Promise<Settings> => ({ layout: "sideList", toc: false, tocSide: "left", wrapCode: true })
    ),
    frontendReady: vi.fn(async () => {}),
    openPaths: vi.fn(async (_paths: string[]) => {}),
    activateRelative: vi.fn(async (_offset: 1 | -1) => {}),
  };
});
vi.mock("../ipc", () => ipc);

const lifecycle = vi.hoisted(() => ({
  openDoc: vi.fn(),
  updateDoc: vi.fn(),
  closeDoc: vi.fn(),
  toggleEdit: vi.fn(),
  saveDoc: vi.fn(async () => {}),
}));
vi.mock("./document", () => lifecycle);

import { initTauriBridge } from "./events";
import { useShellStore } from "../store";

function fire<K extends keyof Events>(name: K, payload: Events[K]): void {
  const h = ipc.handlers.get(name);
  if (!h) throw new Error(`no listener registered for ${name}`);
  h(payload);
}

const meta = (docId: number) => ({ docId, path: `/x/${docId}.md`, fileName: `${docId}.md` });
const s = () => useShellStore.getState();

describe("initTauriBridge", () => {
  // 只初始化一次：init 会在 window 上装全局快捷键监听，重复装会让 spy 被调用多次
  beforeAll(async () => {
    await initTauriBridge();
  });

  beforeEach(() => {
    useShellStore.setState({
      tabs: [],
      active: null,
      notices: {},
      error: null,
      dirty: {},
      editing: {},
      conflicts: {},
      settingsOpen: false,
    });
    lifecycle.openDoc.mockClear();
    lifecycle.updateDoc.mockClear();
    lifecycle.closeDoc.mockClear();
    lifecycle.toggleEdit.mockClear();
    lifecycle.saveDoc.mockClear();
    ipc.openPaths.mockClear();
    ipc.activateRelative.mockClear();
  });

  it("signals frontend_ready only after every listener is registered (spec §4 handshake)", () => {
    const lastListen = Math.max(
      ...ipc.on.mock.invocationCallOrder,
      ...ipc.onFileDrop.mock.invocationCallOrder
    );
    expect(ipc.frontendReady.mock.invocationCallOrder[0]).toBeGreaterThan(lastListen);
  });

  it("feeds the initial settings into the store and onto body data attributes", () => {
    expect(s().settings).toEqual({ layout: "sideList", toc: false, tocSide: "left", wrapCode: true });
    expect(document.body.dataset.layout).toBe("sideList");
    expect(document.body.dataset.toc).toBe("off");
    expect(document.body.dataset.tocSide).toBe("left");
    expect(document.body.dataset.wrapCode).toBe("on");
  });

  it("re-applies settings on settings-changed via the store", () => {
    const next = { layout: "tabs", toc: true, tocSide: "right", wrapCode: false } as const;
    fire("settings-changed", next);
    expect(s().settings).toEqual(next);
    expect(document.body.dataset.layout).toBe("tabs");
    expect(document.body.dataset.toc).toBe("on");
    expect(document.body.dataset.tocSide).toBe("right");
    expect(document.body.dataset.wrapCode).toBe("off");
  });

  it("open-settings opens the panel", () => {
    fire("open-settings", null);
    expect(s().settingsOpen).toBe(true);
  });

  it("document-opened hands the payload to the lifecycle", () => {
    const payload = {
      ...meta(1),
      text: "# T",
      html: "<h1/>",
      blocks: [{ from: 1, to: 1, kind: "node" as const }],
      title: "T",
      baseDir: "/x",
      activate: true,
    };
    fire("document-opened", payload);
    expect(lifecycle.openDoc).toHaveBeenCalledWith(payload);
  });

  it("document-updated hands the payload to the lifecycle", () => {
    const payload = {
      docId: 1,
      text: "2",
      html: "<p>2</p>",
      blocks: [],
      title: "T2",
      external: true,
    };
    fire("document-updated", payload);
    expect(lifecycle.updateDoc).toHaveBeenCalledWith(payload);
  });

  it("toggle-edit and save-requested reach the lifecycle with their doc", () => {
    fire("toggle-edit", { docId: 3 });
    expect(lifecycle.toggleEdit).toHaveBeenCalledWith(3);
    fire("save-requested", { docId: 3, closeAfter: true });
    expect(lifecycle.saveDoc).toHaveBeenCalledWith(3, true);
  });

  it("document-closed hands docId and nextActive to the lifecycle", () => {
    fire("document-closed", { docId: 2, nextActive: 1 });
    expect(lifecycle.closeDoc).toHaveBeenCalledWith(2, 1);
  });

  it("document-focus switches the active doc in the store", () => {
    s().addDoc(meta(1), true);
    s().addDoc(meta(2), true);
    fire("document-focus", { docId: 1 });
    expect(s().active).toBe(1);
  });

  it("document-removed attaches a notice to that doc", () => {
    s().addDoc(meta(1), true);
    fire("document-removed", { docId: 1 });
    expect(s().notices[1]).toMatch(/deleted or moved/);
  });

  it("watch-unavailable attaches a notice to that doc", () => {
    s().addDoc(meta(1), true);
    fire("watch-unavailable", { docId: 1 });
    expect(s().notices[1]).toMatch(/Live reload is unavailable/);
  });

  it("open-error becomes the global error banner", () => {
    fire("open-error", "Cannot open: nope");
    expect(s().error).toBe("Cannot open: nope");
  });

  it("file drop submits the whole batch in one command", () => {
    ipc.drop.handler!(["/a.md", "/b.md"]);
    expect(ipc.openPaths).toHaveBeenCalledWith(["/a.md", "/b.md"]);
  });

  it("a rejected drop command becomes the global error banner", async () => {
    ipc.openPaths.mockRejectedValueOnce("boom");
    ipc.drop.handler!(["/a.md"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(s().error).toBe("boom");
  });

  it("⌃Tab / ⌃⇧Tab cycle through docs via Rust (the only place with wrap-around logic)", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }));
    expect(ipc.activateRelative).toHaveBeenLastCalledWith(1);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true })
    );
    expect(ipc.activateRelative).toHaveBeenLastCalledWith(-1);
  });
});
