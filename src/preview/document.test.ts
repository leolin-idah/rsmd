import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocMode, DocUpdatedPayload } from "../ipc";
import type { EditorHandle, EditorOptions } from "../editor/mdEditor";

// 假编辑器：记录调用、可模拟用户输入触发 onDirtyChange
interface FakeHandle extends EditorHandle {
  type(text: string): void;
}
const editors = vi.hoisted(() => ({ created: [] as Array<{ opts: EditorOptions; handle: FakeHandle }> }));
// 置 true 让下一次 createEditor 抛错（一次性），用于覆盖物化失败路径
const failNext = vi.hoisted(() => ({ value: false }));

function makeFake(opts: EditorOptions): FakeHandle {
  let text = opts.text;
  let dirty = false;
  let mode: DocMode = "preview";
  let scrollTop = 0;
  const setDirty = (v: boolean) => {
    if (v === dirty) return;
    dirty = v;
    opts.onDirtyChange(v);
  };
  const handle: FakeHandle = {
    setMode: vi.fn((m: DocMode) => {
      mode = m;
    }),
    getMode: () => mode,
    getText: () => text,
    isDirty: () => dirty,
    markSaved: vi.fn((saved: string) => {
      text = saved;
      setDirty(false);
    }),
    applyExternal: vi.fn((t: string) => {
      text = t;
      setDirty(false);
    }),
    headings: () => [],
    stats: () => ({ words: text.split(/\s+/).filter(Boolean).length, chars: text.replace(/\s/g, "").length }),
    headingTops: () => [],
    onScroll: () => () => {},
    scrollToAnchor: vi.fn(),
    scrollTop: () => scrollTop,
    setScrollTop: vi.fn((v: number) => {
      scrollTop = v;
    }),
    focus: vi.fn(),
    destroy: vi.fn(),
    type(t: string) {
      text += t;
      setDirty(true);
    },
  };
  return handle;
}

vi.mock("../editor/mdEditor", () => ({
  createEditor: async (opts: EditorOptions) => {
    if (failNext.value) {
      failNext.value = false;
      throw new Error("boom");
    }
    const handle = makeFake(opts);
    editors.created.push({ opts, handle });
    const el = document.createElement("div");
    el.className = "milkdown";
    opts.parent.appendChild(el);
    return handle;
  },
}));
const outline = vi.hoisted(() => ({
  refreshOutline: vi.fn(),
  syncOutline: vi.fn(),
  installOutlineSpy: vi.fn(),
}));
vi.mock("../editor/outline", () => outline);
const ipc = vi.hoisted(() => ({
  saveDoc: vi.fn(async (_id: number, _text: string) => {}),
  setDocState: vi.fn(async (_id: number, _mode: string, _dirty: boolean, _title?: string) => {}),
  closeDoc: vi.fn(async (_id: number) => {}),
  openExternal: vi.fn(async (_url: string) => {}),
  openRelative: vi.fn(async (_id: number, _href: string) => {}),
}));
vi.mock("../ipc", () => ipc);

type Doc = typeof import("./document");
type Store = typeof import("../store");

const flush = () => new Promise((r) => setTimeout(r, 0));

function opened(docId: number, title = `Title ${docId}`) {
  return { docId, path: `/docs/${docId}.md`, fileName: `${docId}.md`, text: `# ${title}\n`, title, baseDir: "/docs", activate: true };
}
const background = (docId: number, title?: string) => ({ ...opened(docId, title), activate: false });
function updated(docId: number, text: string, external: boolean, title = `Title ${docId}`): DocUpdatedPayload {
  return { docId, text, title, external };
}

describe("document lifecycle", () => {
  let doc: Doc;
  let store: Store["useShellStore"];
  let host: HTMLElement;

  beforeEach(async () => {
    vi.resetModules(); // 清空模块级 registry 与 store（二者在同一次 reset 后导入，共享实例）
    vi.clearAllMocks();
    editors.created.length = 0;
    failNext.value = false;
    store = (await import("../store")).useShellStore;
    doc = await import("./document");
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    doc.attachHost(host);
  });

  const active = () => store.getState().active;
  const focus = (id: number) => store.getState().setActive(id);
  const pane = (id: number) => host.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)!;
  const editorOf = (id: number) => editors.created.find((e) => e.opts.parent === pane(id))!.handle;
  const open = async (p: ReturnType<typeof opened>) => {
    doc.openDoc(p);
    await flush(); // 编辑器异步创建
  };

  it("registers the opened doc as the active tab and creates its editor asynchronously", async () => {
    doc.openDoc(opened(1));
    expect(store.getState().tabs.map((t) => t.docId)).toEqual([1]);
    expect(active()).toBe(1);
    expect(doc.editorFor(1)).toBeNull(); // 尚未创建完
    await flush();
    expect(editors.created).toHaveLength(1);
    expect(editors.created[0].opts.text).toBe("# Title 1\n");
    expect(editors.created[0].opts.baseDir).toBe("/docs");
    expect(doc.editorFor(1)).toBe(editorOf(1));
    expect(editorOf(1).getMode()).toBe("preview");
    expect(outline.refreshOutline).toHaveBeenCalledWith(pane(1), []);
    expect(outline.installOutlineSpy).toHaveBeenCalledTimes(1);
  });

  it("shows exactly one pane, restores scroll position and window title on switch", async () => {
    await open(opened(1, "One"));
    editorOf(1).setScrollTop(120);
    await open(opened(2, "Two"));
    expect(pane(1).style.display).toBe("none");
    expect(pane(2).style.display).toBe("");
    expect(document.title).toBe("Two");
    // 清掉"测试自己种值"和物化时那次调用，只留切回时 showActive 的恢复
    vi.mocked(editorOf(1).setScrollTop).mockClear();
    focus(1);
    expect(pane(1).style.display).toBe("");
    expect(editorOf(1).setScrollTop).toHaveBeenCalledTimes(1);
    expect(editorOf(1).setScrollTop).toHaveBeenCalledWith(120);
    expect(document.title).toBe("One");
    expect(outline.syncOutline).toHaveBeenLastCalledWith(pane(1), editorOf(1));
  });

  describe("background open (lazy materialization)", () => {
    it("creates no editor for a background doc until it is shown", async () => {
      await open(opened(1, "One"));
      await open(background(2, "Two"));
      expect(editors.created).toHaveLength(1);
      expect(active()).toBe(1);
      expect(document.title).toBe("One");
      focus(2);
      await flush();
      expect(editors.created).toHaveLength(2);
      expect(editors.created[1].opts.text).toBe("# Two\n");
      expect(document.title).toBe("Two");
    });

    it("an update to a pending doc only replaces the stored text", async () => {
      await open(opened(1));
      await open(background(2));
      doc.updateDoc(updated(2, "fresh", true, "Two!"));
      expect(editors.created).toHaveLength(1);
      focus(2);
      await flush();
      expect(editors.created[1].opts.text).toBe("fresh");
      expect(document.title).toBe("Two!");
    });

    it("an update arriving while the editor is being created is applied afterwards", async () => {
      doc.openDoc(opened(1));
      doc.updateDoc(updated(1, "late", true, "Late"));
      await flush();
      expect(editorOf(1).applyExternal).toHaveBeenCalledWith("late");
      expect(document.title).toBe("Late");
    });

    it("a failed editor creation shows the banner, keeps the text and retries on next show", async () => {
      failNext.value = true;
      doc.openDoc(opened(1));
      await flush();
      expect(store.getState().error).toBe(`${doc.RENDER_FAILED_TEXT} Error: boom`);
      expect(pane(1).querySelector(".milkdown")).toBeNull();
      expect(editors.created).toHaveLength(0);
      expect(doc.editorFor(1)).toBeNull();
      // 文本留在 pending：切走再切回时重试物化
      await open(opened(2, "Two"));
      focus(1);
      await flush();
      const retried = editors.created.find((e) => e.opts.parent === pane(1));
      expect(retried?.opts.text).toBe("# Title 1\n");
      expect(doc.editorFor(1)).toBe(retried!.handle);
    });
  });

  describe("modes", () => {
    it("the live menu item toggles live ↔ preview, updating editor, store and Rust", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      expect(editorOf(1).setMode).toHaveBeenLastCalledWith("live");
      expect(editorOf(1).focus).toHaveBeenCalled(); // setMode 不改焦点，可见 tab 由本模块补 focus
      expect(store.getState().modes[1]).toBe("live");
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, "live", false, "Title 1");
      doc.onModeMenu(1, "live");
      expect(editorOf(1).setMode).toHaveBeenLastCalledWith("preview");
      expect(store.getState().modes[1]).toBeUndefined();
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, "preview", false, "Title 1");
    });

    it("the source menu item enters source and returns to the mode it came from", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "source"); // preview → source
      expect(editorOf(1).setMode).toHaveBeenLastCalledWith("source");
      expect(store.getState().modes[1]).toBe("source");
      doc.onModeMenu(1, "source"); // source → 回 preview
      expect(store.getState().modes[1]).toBeUndefined();
      doc.onModeMenu(1, "live");
      doc.onModeMenu(1, "source"); // live → source
      expect(store.getState().modes[1]).toBe("source");
      doc.onModeMenu(1, "source"); // source → 回 live
      expect(store.getState().modes[1]).toBe("live");
    });

    it("⌘E from source jumps straight to live; the preview item always lands on preview", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "source");
      doc.onModeMenu(1, "live");
      expect(store.getState().modes[1]).toBe("live");
      doc.onModeMenu(1, "preview");
      expect(store.getState().modes[1]).toBeUndefined();
      expect(editorOf(1).setMode).toHaveBeenLastCalledWith("preview");
    });

    it("re-selecting the current mode is a no-op", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "preview");
      expect(editorOf(1).setMode).not.toHaveBeenCalled();
      expect(ipc.setDocState).not.toHaveBeenCalled();
    });

    it("a mode chosen while the editor is still being created is applied once it exists", async () => {
      doc.openDoc(opened(1));
      doc.onModeMenu(1, "live");
      expect(store.getState().modes[1]).toBe("live"); // 菜单勾选不等编辑器
      await flush();
      expect(editorOf(1).setMode).toHaveBeenCalledWith("live");
      expect(editorOf(1).focus).not.toHaveBeenCalled(); // 补应用不抢焦点
    });

    it("typing marks the doc dirty in the store and in Rust", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      expect(store.getState().dirty[1]).toBe(true);
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, "live", true, "Title 1");
    });

    it("a title change from the editor updates the window title and Rust", async () => {
      await open(opened(1));
      editors.created[0].opts.onTitleChange("Renamed");
      expect(document.title).toBe("Renamed");
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, "preview", false, "Renamed");
      editors.created[0].opts.onTitleChange(null); // 没有 H1：退到文件名 stem
      expect(document.title).toBe("1");
    });

    it("headings from the editor refresh the outline", async () => {
      await open(opened(1));
      const headings = [{ id: "a", text: "A", level: 1 }];
      editors.created[0].opts.onHeadingsChange(headings);
      expect(outline.refreshOutline).toHaveBeenLastCalledWith(pane(1), headings);
    });

    it("the editor's initial stats land in the store once it is created", async () => {
      doc.openDoc(opened(1)); // "# Title 1\n"
      expect(store.getState().stats[1]).toBeUndefined();
      await flush();
      expect(store.getState().stats[1]).toEqual({ words: 3, chars: 7 });
    });

    it("stats reported by the editor update the store", async () => {
      await open(opened(1));
      editors.created[0].opts.onStatsChange({ words: 5, chars: 9 });
      expect(store.getState().stats[1]).toEqual({ words: 5, chars: 9 });
    });

    it("saveDoc hands the editor text to Rust and clears dirty", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      await doc.saveDoc(1);
      expect(ipc.saveDoc).toHaveBeenCalledWith(1, "# Title 1\nx");
      expect(editorOf(1).markSaved).toHaveBeenCalledWith("# Title 1\nx");
      expect(store.getState().dirty[1]).toBeUndefined();
      expect(ipc.closeDoc).not.toHaveBeenCalled();
    });

    it("saveDoc with closeAfter closes the doc after a successful save", async () => {
      await open(opened(1));
      await doc.saveDoc(1, true);
      expect(ipc.closeDoc).toHaveBeenCalledWith(1);
    });

    it("saveDoc waits for an editor that is still being created", async () => {
      doc.openDoc(opened(1));
      await doc.saveDoc(1, true);
      expect(ipc.saveDoc).toHaveBeenCalledWith(1, "# Title 1\n");
      expect(ipc.closeDoc).toHaveBeenCalledWith(1);
    });

    it("a failed save becomes the global error banner and does not close", async () => {
      await open(opened(1));
      ipc.saveDoc.mockRejectedValueOnce("Failed to save: EACCES");
      await doc.saveDoc(1, true);
      expect(store.getState().error).toBe("Failed to save: EACCES");
      expect(ipc.closeDoc).not.toHaveBeenCalled();
    });
  });

  describe("external updates", () => {
    it("a clean doc applies the external text and refreshes the outline", async () => {
      await open(opened(1));
      store.getState().setNotice(1, "File was deleted");
      doc.updateDoc(updated(1, "new", true, "New"));
      expect(editorOf(1).applyExternal).toHaveBeenCalledWith("new");
      expect(store.getState().notices[1]).toBeUndefined();
      expect(document.title).toBe("New");
      expect(outline.refreshOutline).toHaveBeenLastCalledWith(pane(1), []);
    });

    it("a clean doc's external text refreshes the stats", async () => {
      await open(opened(1));
      doc.updateDoc(updated(1, "new words", true, "New"));
      expect(store.getState().stats[1]).toEqual({ words: 2, chars: 8 });
    });

    it("an own-save echo only refreshes the title and never reloads the editor", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      await doc.saveDoc(1);
      editorOf(1).type("y");
      doc.updateDoc(updated(1, "# Title 1\nx", false, "Echo"));
      expect(editorOf(1).applyExternal).not.toHaveBeenCalled();
      expect(editorOf(1).getText()).toBe("# Title 1\nxy");
      expect(editorOf(1).isDirty()).toBe(true);
      expect(document.title).toBe("Echo");
    });

    it("an external change while dirty raises a conflict instead of overwriting", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true));
      expect(editorOf(1).applyExternal).not.toHaveBeenCalled();
      expect(store.getState().conflicts[1]).toBe(true);
      expect(editorOf(1).getText()).toBe("# Title 1\nx");
    });

    it("reloadFromDisk applies the conflicting text, clears dirty + conflict and refocuses", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true, "Theirs"));
      doc.reloadFromDisk(1);
      expect(editorOf(1).applyExternal).toHaveBeenCalledWith("theirs");
      expect(store.getState().conflicts[1]).toBeUndefined();
      expect(store.getState().dirty[1]).toBeUndefined();
      expect(document.title).toBe("Theirs");
      expect(editorOf(1).focus).toHaveBeenCalled();
    });

    it("saving over a conflict keeps the local text and clears the banner", async () => {
      await open(opened(1));
      doc.onModeMenu(1, "live");
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true));
      await doc.saveDoc(1);
      expect(ipc.saveDoc).toHaveBeenCalledWith(1, "# Title 1\nx");
      expect(store.getState().conflicts[1]).toBeUndefined();
    });
  });

  describe("close", () => {
    it("closeDoc destroys the editor, removes the pane and activates nextActive", async () => {
      await open(opened(1));
      await open(opened(2, "Two"));
      const gone = editorOf(2);
      doc.closeDoc(2, 1);
      expect(gone.destroy).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(active()).toBe(1);
      expect(document.title).toBe("Title 1");
    });

    it("closing a doc while its editor is being created destroys the editor once it arrives", async () => {
      doc.openDoc(opened(1));
      doc.closeDoc(1, null);
      await flush();
      expect(editors.created[0].handle.destroy).toHaveBeenCalledTimes(1);
      expect(doc.editorFor(1)).toBeNull();
    });

    it("closing the last doc resets the title", async () => {
      await open(opened(1));
      doc.closeDoc(1, null);
      expect(active()).toBeNull();
      expect(document.title).toBe("rsmd");
    });

    it("closing a pending doc needs no editor", async () => {
      await open(opened(1));
      await open(background(2));
      doc.closeDoc(2, 1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(editors.created).toHaveLength(1);
    });

    it("closeDoc / onModeMenu / saveDoc for unknown docs are no-ops", async () => {
      await open(opened(1));
      doc.closeDoc(9, null);
      doc.onModeMenu(9, "live");
      await doc.saveDoc(9);
      expect(active()).toBe(1);
      expect(ipc.saveDoc).not.toHaveBeenCalled();
    });
  });
});
