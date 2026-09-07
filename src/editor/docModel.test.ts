import { describe, expect, it, vi } from "vitest";
import { afterSave, applyExternal, initialModel, isDirty, switchMode, textForSave, type Engines } from "./docModel";

/// 假引擎：ProseMirror 侧用"归一化 = `*` 列表符换成 `-`"模拟 remark 的改写；CM 侧就是一段文本
function fakeEngines(text: string) {
  const norm = (t: string) => t.replace(/^\* /gm, "- ");
  const state = { pm: norm(text), cm: "" };
  const e: Engines & { state: typeof state; typePm(s: string): void; typeCm(s: string): void } = {
    state,
    pmMarkdown: () => state.pm,
    pmNormalize: (t) => norm(t),
    pmReplace: vi.fn((t: string) => {
      state.pm = norm(t);
    }),
    cmText: () => state.cm,
    cmSet: vi.fn((t: string) => {
      state.cm = t;
    }),
    cmApplyDiff: vi.fn((t: string) => {
      state.cm = t;
    }),
    typePm: (s) => {
      state.pm += s;
    },
    typeCm: (s) => {
      state.cm += s;
    },
  };
  return e;
}

const ORIGINAL = "* a\n* b\n";

describe("docModel", () => {
  it("a freshly opened doc is clean and would save the normalized text", () => {
    const e = fakeEngines(ORIGINAL);
    const m = initialModel(ORIGINAL, e);
    expect(isDirty(m, e)).toBe(false);
    expect(textForSave(m, e)).toBe("- a\n- b\n");
  });

  it("editing in live marks dirty; afterSave re-baselines on the saved text", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "live");
    e.typePm("x");
    expect(isDirty(m, e)).toBe(true);
    const saved = textForSave(m, e);
    m = afterSave(m, e, saved);
    expect(m.savedText).toBe(saved);
    expect(isDirty(m, e)).toBe(false);
  });

  it("afterSave baselines on the text that was written, not on edits landing during the save", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "live");
    e.typePm("x");
    const saved = textForSave(m, e); // 交给 Rust 写盘的那份文本
    e.typePm("z"); // 保存 IPC 往返期间用户又改了一下
    m = afterSave(m, e, saved);
    expect(m.pmSavedMarkdown).toBe(saved);
    expect(isDirty(m, e)).toBe(true); // 这一下改动不能被吸进干净基线
  });

  it("entering source from a clean doc shows the original file text, not the normalized one", () => {
    const e = fakeEngines(ORIGINAL);
    const m = switchMode(initialModel(ORIGINAL, e), e, "source");
    expect(e.cmSet).toHaveBeenCalledWith(ORIGINAL);
    expect(m.cmEnteredText).toBe(ORIGINAL);
    expect(isDirty(m, e)).toBe(false);
  });

  it("entering source from a dirty doc hands over the serialized markdown", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "live");
    e.typePm("x");
    m = switchMode(m, e, "source");
    expect(e.cmSet).toHaveBeenCalledWith("- a\n- b\nx");
    expect(isDirty(m, e)).toBe(true); // 文本 ≠ 磁盘
  });

  it("in source, any byte difference (even whitespace) is dirty and saves verbatim", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "source");
    e.typeCm(" ");
    expect(isDirty(m, e)).toBe(true);
    expect(textForSave(m, e)).toBe(ORIGINAL + " ");
    m = afterSave(m, e, textForSave(m, e));
    expect(m.pmSavedMarkdown).toBeNull(); // PM 落后于磁盘
    expect(isDirty(m, e)).toBe(false);
  });

  it("leaving source with changes re-parses into PM and re-baselines from the saved text", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "source");
    e.typeCm("\n* c\n");
    m = afterSave(m, e, textForSave(m, e)); // 在 source 里保存
    m = switchMode(m, e, "live");
    expect(e.pmReplace).toHaveBeenCalledWith("* a\n* b\n\n* c\n");
    expect(m.pmSavedMarkdown).toBe("- a\n- b\n\n- c\n");
    expect(isDirty(m, e)).toBe(false);
  });

  it("leaving source with unsaved changes keeps them and stays dirty", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "source");
    e.typeCm("tail");
    m = switchMode(m, e, "preview");
    expect(e.pmReplace).toHaveBeenCalledWith(ORIGINAL + "tail");
    expect(isDirty(m, e)).toBe(true);
  });

  it("leaving source without changes does not touch PM (undo history survives)", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "source");
    m = switchMode(m, e, "live");
    expect(e.pmReplace).not.toHaveBeenCalled();
    expect(m.mode).toBe("live");
  });

  it("preview ↔ live only changes the mode", () => {
    const e = fakeEngines(ORIGINAL);
    const m0 = initialModel(ORIGINAL, e);
    const m1 = switchMode(m0, e, "live");
    expect(m1).toEqual({ ...m0, mode: "live" });
    expect(switchMode(m1, e, "live")).toBe(m1);
  });

  it("an external update in preview replaces PM and re-baselines", () => {
    const e = fakeEngines(ORIGINAL);
    const m = applyExternal(initialModel(ORIGINAL, e), e, "* z\n");
    expect(e.pmReplace).toHaveBeenCalledWith("* z\n");
    expect(m.savedText).toBe("* z\n");
    expect(m.pmSavedMarkdown).toBe("- z\n");
    expect(isDirty(m, e)).toBe(false);
  });

  it("an external update in source diffs into CM and marks PM stale", () => {
    const e = fakeEngines(ORIGINAL);
    let m = switchMode(initialModel(ORIGINAL, e), e, "source");
    m = applyExternal(m, e, "* z\n");
    expect(e.cmApplyDiff).toHaveBeenCalledWith("* z\n");
    expect(m).toMatchObject({ savedText: "* z\n", cmEnteredText: "* z\n", pmSavedMarkdown: null });
    expect(isDirty(m, e)).toBe(false);
    m = switchMode(m, e, "preview");
    expect(e.pmReplace).toHaveBeenCalledWith("* z\n");
    expect(isDirty(m, e)).toBe(false);
  });
});
