import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOutlineSpy, refreshOutline, syncOutline, type OutlineSource } from "./outline";

function source(tops: { id: string; top: number }[]) {
  const listeners = new Set<() => void>();
  const s: OutlineSource & { scroll(): void } = {
    headings: () => tops.map((t) => ({ id: t.id, text: t.id.toUpperCase(), level: 1 })),
    headingTops: () => tops,
    onScroll: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    scroll: () => listeners.forEach((cb) => cb()),
  };
  return s;
}

describe("outline", () => {
  let pane: HTMLElement;
  beforeEach(() => {
    pane = document.createElement("div");
    document.body.appendChild(pane);
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("refreshOutline replaces nav.toc from the given headings", () => {
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }]);
    refreshOutline(pane, [{ id: "b", text: "B", level: 1 }, { id: "c", text: "C", level: 2 }]);
    expect(pane.querySelectorAll("nav.toc")).toHaveLength(1);
    expect(Array.from(pane.querySelectorAll("nav.toc a")).map((a) => a.textContent)).toEqual(["B", "C"]);
    refreshOutline(pane, []);
    expect(pane.querySelector("nav.toc")).toBeNull();
  });

  it("syncOutline highlights the heading chosen by pickCurrent", () => {
    const s = source([{ id: "a", top: -100 }, { id: "b", top: 10 }, { id: "c", top: 600 }]);
    refreshOutline(pane, s.headings());
    syncOutline(pane, s);
    // 偏离 brief：querySelector 默认返回 Element，没有 dataset；标注 <HTMLElement> 消除 tsc 报错，断言不变
    expect(pane.querySelector<HTMLElement>("a.active")?.dataset.target).toBe("b");
    syncOutline(pane, null); // 无编辑器：保持原样
    expect(pane.querySelector<HTMLElement>("a.active")?.dataset.target).toBe("b");
  });

  it("installOutlineSpy re-syncs once per frame on scroll", () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(0), 0);
      return 1;
    });
    const s = source([{ id: "a", top: -100 }, { id: "b", top: 600 }]);
    refreshOutline(pane, s.headings());
    installOutlineSpy(pane, s);
    installOutlineSpy(pane, s); // 幂等：同一 pane 只挂一次
    s.scroll();
    s.scroll();
    expect(raf).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(pane.querySelector<HTMLElement>("a.active")?.dataset.target).toBe("a");
  });
});
