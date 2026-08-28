import { beforeEach, describe, expect, it } from "vitest";
import { disambiguate, selectBanner, useShellStore } from "./store";

const meta = (docId: number, path = `/x/${docId}.md`) => ({
  docId,
  path,
  fileName: path.split("/").pop()!,
});

describe("disambiguate", () => {
  it("uses bare file names when unique", () => {
    expect(disambiguate(["/a/one.md", "/b/two.md"])).toEqual(["one.md", "two.md"]);
  });

  it("extends duplicated names by one parent segment", () => {
    expect(disambiguate(["/a/readme.md", "/b/readme.md"])).toEqual([
      "a/readme.md",
      "b/readme.md",
    ]);
  });

  it("keeps extending while still ambiguous (同名同父不同祖父)", () => {
    expect(
      disambiguate(["/x/docs/readme.md", "/y/docs/readme.md", "/z/other.md"])
    ).toEqual(["x/docs/readme.md", "y/docs/readme.md", "other.md"]);
  });

  it("only extends the colliding group, not unrelated tabs", () => {
    expect(
      disambiguate(["/a/readme.md", "/b/readme.md", "/c/unique.md"])
    ).toEqual(["a/readme.md", "b/readme.md", "unique.md"]);
  });

  it("stops extending at the root", () => {
    expect(disambiguate(["/readme.md", "/a/readme.md"])).toEqual([
      "readme.md",
      "a/readme.md",
    ]);
  });
});

describe("shell store", () => {
  beforeEach(() => {
    useShellStore.setState({
      tabs: [],
      active: null,
      notices: {},
      error: null,
      dirty: {},
      editing: {},
      conflicts: {},
    });
  });
  const s = () => useShellStore.getState();

  describe("addDoc", () => {
    it("appends in open order and activates when activate=true", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      expect(s().tabs.map((t) => t.docId)).toEqual([1, 2]);
      expect(s().active).toBe(2);
    });

    it("keeps the current active when a background doc is added", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), false);
      expect(s().tabs.map((t) => t.docId)).toEqual([1, 2]);
      expect(s().active).toBe(1);
    });

    it("does not duplicate an already-open doc but still focuses it", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().addDoc(meta(1), true);
      expect(s().tabs.map((t) => t.docId)).toEqual([1, 2]);
      expect(s().active).toBe(1);
    });

    it("dismisses the global error banner (a successful open supersedes it)", () => {
      s().setError("boom");
      s().addDoc(meta(1), false);
      expect(s().error).toBeNull();
    });

    it("labels colliding file names by their parent segments", () => {
      s().addDoc(meta(1, "/a/readme.md"), true);
      s().addDoc(meta(2, "/b/readme.md"), false);
      expect(s().tabs.map((t) => t.label)).toEqual(["a/readme.md", "b/readme.md"]);
    });
  });

  describe("setActive", () => {
    it("switches to a known doc and dismisses the global error banner", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().setError("boom");
      s().setActive(1);
      expect(s().active).toBe(1);
      expect(s().error).toBeNull();
    });

    it("ignores unknown doc ids", () => {
      s().addDoc(meta(1), true);
      s().setActive(99);
      expect(s().active).toBe(1);
    });

    it("is a no-op for the already-active doc (Rust document-focus echo)", () => {
      s().addDoc(meta(1), true);
      const before = useShellStore.getState();
      s().setActive(1);
      expect(useShellStore.getState()).toBe(before); // 同一状态对象：订阅者不会被唤醒
    });
  });

  describe("removeDoc", () => {
    it("activates nextActive when the active doc is removed", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().removeDoc(2, 1);
      expect(s().tabs.map((t) => t.docId)).toEqual([1]);
      expect(s().active).toBe(1);
    });

    it("falls back to no active doc when nextActive is not open", () => {
      s().addDoc(meta(1), true);
      s().removeDoc(1, 42);
      expect(s().active).toBeNull();
    });

    it("keeps the active doc when a background doc is removed", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().removeDoc(1, 2);
      expect(s().active).toBe(2);
    });

    it("ignores unknown doc ids", () => {
      s().addDoc(meta(1), true);
      const before = useShellStore.getState();
      s().removeDoc(7, null);
      expect(useShellStore.getState()).toBe(before);
    });

    it("drops the removed doc's notice", () => {
      s().addDoc(meta(1), true);
      s().setNotice(1, "gone");
      s().removeDoc(1, null);
      expect(s().notices[1]).toBeUndefined();
    });

    it("shrinks labels back once a collision disappears", () => {
      s().addDoc(meta(1, "/a/readme.md"), true);
      s().addDoc(meta(2, "/b/readme.md"), false);
      s().removeDoc(2, 1);
      expect(s().tabs[0].label).toBe("readme.md");
    });
  });

  describe("notices and error", () => {
    it("stores one notice per doc and clears it", () => {
      s().addDoc(meta(1), true);
      s().setNotice(1, "File was deleted");
      expect(s().notices[1]).toBe("File was deleted");
      s().clearNotice(1);
      expect(s().notices[1]).toBeUndefined();
    });

    it("clearNotice is a no-op when there is nothing to clear", () => {
      const before = useShellStore.getState();
      s().clearNotice(1);
      expect(useShellStore.getState()).toBe(before);
    });
  });

  describe("selectBanner", () => {
    it("prefers the global error over any per-doc notice", () => {
      s().addDoc(meta(1), true);
      s().setNotice(1, "notice");
      s().setError("error");
      expect(selectBanner(s())).toEqual({ text: "error", action: null });
    });

    it("shows only the active doc's notice", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().setNotice(1, "notice for 1");
      expect(selectBanner(s())).toBeNull();
      s().setActive(1);
      expect(selectBanner(s())).toEqual({ text: "notice for 1", action: null });
    });

    it("is null with no docs and no error", () => {
      expect(selectBanner(s())).toBeNull();
    });
  });

  describe("editing flags", () => {
    it("tracks dirty per doc and drops it when the doc is removed", () => {
      s().addDoc(meta(1), true);
      s().setDirty(1, true);
      expect(s().dirty[1]).toBe(true);
      s().setDirty(1, false);
      expect(s().dirty[1]).toBeUndefined();
      s().setDirty(1, true);
      s().setEditing(1, true);
      s().setConflict(1, true);
      s().removeDoc(1, null);
      expect(s().dirty[1]).toBeUndefined();
      expect(s().editing[1]).toBeUndefined();
      expect(s().conflicts[1]).toBeUndefined();
    });

    it("clearing an absent flag is a no-op (no subscriber wake-up)", () => {
      const before = useShellStore.getState();
      s().setEditing(1, false);
      s().setConflict(1, false);
      expect(useShellStore.getState()).toBe(before);
    });

    it("conflict banner outranks the doc notice but not the global error", () => {
      s().addDoc(meta(1), true);
      s().setNotice(1, "notice");
      s().setConflict(1, true);
      expect(selectBanner(s())).toEqual({
        text: "File changed on disk. Reload to discard your unsaved edits.",
        action: "reload",
      });
      s().setError("error");
      expect(selectBanner(s())).toEqual({ text: "error", action: null });
    });

    it("conflict banner follows the active doc", () => {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true);
      s().setConflict(1, true);
      expect(selectBanner(s())).toBeNull();
      s().setActive(1);
      expect(selectBanner(s())?.action).toBe("reload");
    });
  });
});
