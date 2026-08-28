import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { BlockRange, DocUpdatedPayload } from "../ipc";
import type { EditorHandle, EditorOptions } from "../editor/markdownEditor";

// 假编辑器：记录调用、可模拟用户输入触发 onDirtyChange
interface FakeHandle extends EditorHandle {
  type(text: string): void;
}
const editors = vi.hoisted(() => ({ created: [] as Array<{ opts: EditorOptions; handle: FakeHandle }> }));

function makeFake(opts: EditorOptions): FakeHandle {
  const scrollDOM = document.createElement("div");
  let text = opts.text;
  let dirty = false;
  let readOnly = true;
  const handle: FakeHandle = {
    view: { scrollDOM } as unknown as EditorView,
    beginEditing: vi.fn(() => {
      readOnly = false;
    }),
    endEditing: vi.fn(async () => {
      readOnly = true;
    }),
    isReadOnly: () => readOnly,
    getText: () => text,
    isDirty: () => dirty,
    markSaved: vi.fn(() => {
      if (dirty) {
        dirty = false;
        opts.onDirtyChange(false);
      }
    }),
    applyExternal: vi.fn((t: string) => {
      text = t;
      if (dirty) {
        dirty = false;
        opts.onDirtyChange(false);
      }
    }),
    headings: () => [],
    scrollToLine: vi.fn(),
    destroy: vi.fn(),
    type(t: string) {
      text += t;
      if (!dirty) {
        dirty = true;
        opts.onDirtyChange(true);
      }
    },
  };
  return handle;
}

vi.mock("../editor/markdownEditor", () => ({
  createEditor: (opts: EditorOptions) => {
    const handle = makeFake(opts);
    editors.created.push({ opts, handle });
    const el = document.createElement("div");
    el.className = "cm-editor";
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
  renderMarkdown: vi.fn(async () => null),
  saveDoc: vi.fn(async (_id: number, _text: string) => {}),
  setDocState: vi.fn(async (_id: number, _editing: boolean, _dirty: boolean) => {}),
  closeDoc: vi.fn(async (_id: number) => {}),
}));
vi.mock("../ipc", () => ipc);

type Doc = typeof import("./document");
type Store = typeof import("../store");

const BLOCKS: BlockRange[] = [{ from: 1, to: 1, kind: "node" }];
function opened(docId: number, title = `Title ${docId}`) {
  return {
    docId,
    path: `/docs/${docId}.md`,
    fileName: `${docId}.md`,
    text: `# ${title}\n`,
    html: `<h1 data-sourcepos="1:1-1:9">${title}</h1>`,
    blocks: BLOCKS,
    title,
    baseDir: "/docs",
    activate: true,
  };
}
const background = (docId: number, title?: string) => ({ ...opened(docId, title), activate: false });
function updated(docId: number, text: string, external: boolean, title = `Title ${docId}`): DocUpdatedPayload {
  return { docId, text, html: `<p data-sourcepos="1:1-1:1">${text}</p>`, blocks: BLOCKS, title, external };
}

describe("document lifecycle", () => {
  let doc: Doc;
  let store: Store["useShellStore"];
  let host: HTMLElement;

  beforeEach(async () => {
    vi.resetModules(); // 清空模块级 registry 与 store（二者在同一次 reset 后导入，共享实例）
    vi.clearAllMocks();
    editors.created.length = 0;
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

  it("registers the opened doc as the active tab and creates its editor read-only", () => {
    doc.openDoc(opened(1));
    expect(store.getState().tabs.map((t) => t.docId)).toEqual([1]);
    expect(active()).toBe(1);
    expect(editors.created).toHaveLength(1);
    expect(editors.created[0].opts.text).toBe("# Title 1\n");
    expect(editorOf(1).isReadOnly()).toBe(true);
    expect(outline.refreshOutline).toHaveBeenCalledWith(pane(1), opened(1).html);
    expect(outline.installOutlineSpy).toHaveBeenCalledTimes(1);
  });

  it("shows exactly one pane, restores scroll position and window title on switch", () => {
    doc.openDoc(opened(1, "One"));
    editorOf(1).view.scrollDOM.scrollTop = 120;
    doc.openDoc(opened(2, "Two"));
    expect(pane(1).style.display).toBe("none");
    expect(pane(2).style.display).toBe("");
    expect(document.title).toBe("Two");
    editorOf(1).view.scrollDOM.scrollTop = 0; // 隐藏期间浏览器丢失布局
    focus(1);
    expect(pane(1).style.display).toBe("");
    expect(editorOf(1).view.scrollDOM.scrollTop).toBe(120);
    expect(document.title).toBe("One");
    expect(outline.syncOutline).toHaveBeenLastCalledWith(pane(1), editorOf(1));
  });

  describe("background open (lazy materialization)", () => {
    it("creates no editor for a background doc until it is shown", () => {
      doc.openDoc(opened(1, "One"));
      doc.openDoc(background(2, "Two"));
      expect(editors.created).toHaveLength(1);
      expect(active()).toBe(1);
      expect(document.title).toBe("One");
      focus(2);
      expect(editors.created).toHaveLength(2);
      expect(editors.created[1].opts.text).toBe("# Two\n");
      expect(document.title).toBe("Two");
    });

    it("an update to a pending doc only replaces the stored payload", () => {
      doc.openDoc(opened(1));
      doc.openDoc(background(2));
      doc.updateDoc(updated(2, "fresh", true, "Two!"));
      expect(editors.created).toHaveLength(1);
      focus(2);
      expect(editors.created[1].opts.text).toBe("fresh");
      expect(document.title).toBe("Two!");
    });
  });

  describe("editing", () => {
    it("toggleEdit flips the editor, the store and tells Rust", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      expect(editorOf(1).beginEditing).toHaveBeenCalledTimes(1);
      expect(store.getState().editing[1]).toBe(true);
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, true, false);
      doc.toggleEdit(1);
      expect(editorOf(1).endEditing).toHaveBeenCalledTimes(1);
      expect(store.getState().editing[1]).toBeUndefined();
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, false, false);
    });

    // I3：菜单勾选须紧跟按键，故 editing=false 在 endEditing() 的渲染 await 之前就提交
    it("commits editing=false synchronously, without waiting for endEditing to settle", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      let settled = false;
      const handle = editorOf(1);
      vi.mocked(handle.endEditing).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              settled = true;
              resolve();
            }, 0);
          })
      );
      doc.toggleEdit(1);
      expect(settled).toBe(false);
      expect(store.getState().editing[1]).toBeUndefined();
    });

    it("typing marks the doc dirty in the store and in Rust", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      expect(store.getState().dirty[1]).toBe(true);
      expect(ipc.setDocState).toHaveBeenLastCalledWith(1, true, true);
    });

    it("saveDoc hands the editor text to Rust and clears dirty", async () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      await doc.saveDoc(1);
      expect(ipc.saveDoc).toHaveBeenCalledWith(1, "# Title 1\nx");
      expect(editorOf(1).markSaved).toHaveBeenCalledTimes(1);
      expect(store.getState().dirty[1]).toBeUndefined();
      expect(ipc.closeDoc).not.toHaveBeenCalled();
    });

    it("saveDoc with closeAfter closes the doc after a successful save", async () => {
      doc.openDoc(opened(1));
      await doc.saveDoc(1, true);
      expect(ipc.closeDoc).toHaveBeenCalledWith(1);
    });

    it("a failed save becomes the global error banner and does not close", async () => {
      doc.openDoc(opened(1));
      ipc.saveDoc.mockRejectedValueOnce("Failed to save: EACCES");
      await doc.saveDoc(1, true);
      expect(store.getState().error).toBe("Failed to save: EACCES");
      expect(ipc.closeDoc).not.toHaveBeenCalled();
    });
  });

  describe("external updates", () => {
    it("a clean doc applies the external text and refreshes the outline", () => {
      doc.openDoc(opened(1));
      store.getState().setNotice(1, "File was deleted");
      doc.updateDoc(updated(1, "new", true, "New"));
      expect(editorOf(1).applyExternal).toHaveBeenCalledWith("new", expect.any(String), BLOCKS);
      expect(store.getState().notices[1]).toBeUndefined();
      expect(document.title).toBe("New");
      expect(outline.refreshOutline).toHaveBeenLastCalledWith(pane(1), expect.stringContaining("new"));
    });

    it("an own-save echo is applied even while dirty (text is identical, blocks refresh)", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "# Title 1\nx", false));
      expect(editorOf(1).applyExternal).toHaveBeenCalledTimes(1);
      expect(store.getState().conflicts[1]).toBeUndefined();
    });

    // 回声是异步的：⌘S 之后继续输入，落后的回声若被 diff 应用会抹掉新按键且不进撤销栈
    it("keystrokes after ⌘S survive a stale echo and stay dirty", async () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      await doc.saveDoc(1);
      editorOf(1).type("y");
      doc.updateDoc(updated(1, "# Title 1\nx", false));
      expect(editorOf(1).applyExternal).not.toHaveBeenCalled();
      expect(editorOf(1).getText()).toBe("# Title 1\nxy");
      expect(editorOf(1).isDirty()).toBe(true);
      expect(store.getState().dirty[1]).toBe(true);
    });

    it("an external change while dirty raises a conflict instead of overwriting", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true));
      expect(editorOf(1).applyExternal).not.toHaveBeenCalled();
      expect(store.getState().conflicts[1]).toBe(true);
      expect(editorOf(1).getText()).toBe("# Title 1\nx");
    });

    it("reloadFromDisk applies the conflicting text and clears dirty + conflict", () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true, "Theirs"));
      doc.reloadFromDisk(1);
      expect(editorOf(1).applyExternal).toHaveBeenCalledWith("theirs", expect.any(String), BLOCKS);
      expect(store.getState().conflicts[1]).toBeUndefined();
      expect(store.getState().dirty[1]).toBeUndefined();
      expect(document.title).toBe("Theirs");
    });

    it("saving over a conflict keeps the local text and clears the banner", async () => {
      doc.openDoc(opened(1));
      doc.toggleEdit(1);
      editorOf(1).type("x");
      doc.updateDoc(updated(1, "theirs", true));
      await doc.saveDoc(1);
      expect(ipc.saveDoc).toHaveBeenCalledWith(1, "# Title 1\nx");
      expect(store.getState().conflicts[1]).toBeUndefined();
    });
  });

  describe("close", () => {
    it("closeDoc destroys the editor, removes the pane and activates nextActive", () => {
      doc.openDoc(opened(1));
      doc.openDoc(opened(2, "Two"));
      const gone = editorOf(2);
      doc.closeDoc(2, 1);
      expect(gone.destroy).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(active()).toBe(1);
      expect(document.title).toBe("Title 1");
    });

    it("closing the last doc resets the title", () => {
      doc.openDoc(opened(1));
      doc.closeDoc(1, null);
      expect(active()).toBeNull();
      expect(document.title).toBe("rsmd");
    });

    it("closing a pending doc needs no editor", () => {
      doc.openDoc(opened(1));
      doc.openDoc(background(2));
      doc.closeDoc(2, 1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(editors.created).toHaveLength(1);
    });

    it("closeDoc / toggleEdit / saveDoc for unknown docs are no-ops", async () => {
      doc.openDoc(opened(1));
      doc.closeDoc(9, null);
      doc.toggleEdit(9);
      await doc.saveDoc(9);
      expect(active()).toBe(1);
      expect(ipc.saveDoc).not.toHaveBeenCalled();
    });
  });
});
