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

  // 打字停顿后 onHeadingsChange 会带着一模一样的标题再来一次（mdEditor 的 meta 防抖不比对内容）。
  // 若此时删掉 nav 重建：.active 丢失 → syncOutline 先测量再补回 → .toc a 的颜色过渡从"非当前"起跳，
  // 每 300ms 闪一下；侧栏自己的滚动位置也归零。业界（MarkText / Zettlr / Tiptap / VitePress）无一重建，
  // 都是 keyed 协调原地更新
  it("refreshOutline keeps the nav node, .active and scroll position when headings are unchanged", () => {
    const s = source([{ id: "a", top: -100 }, { id: "b", top: 10 }]);
    refreshOutline(pane, s.headings());
    syncOutline(pane, s);
    const nav = pane.querySelector<HTMLElement>("nav.toc")!;
    nav.scrollTop = 120;
    refreshOutline(pane, s.headings());
    expect(pane.querySelector("nav.toc")).toBe(nav);
    expect(nav.querySelector<HTMLElement>("a.active")?.dataset.target).toBe("b");
    expect(nav.scrollTop).toBe(120);
  });

  // 在标题里打字：id（slug）跟着文本变，按位置复用同一个 a 节点，只改文本与目标
  it("refreshOutline patches the same link in place when a heading's text changes", () => {
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }, { id: "b", text: "B", level: 2 }]);
    const second = pane.querySelectorAll<HTMLElement>("nav.toc a")[1];
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }, { id: "bb", text: "BB", level: 2 }]);
    expect(pane.querySelectorAll<HTMLElement>("nav.toc a")[1]).toBe(second);
    expect(second.textContent).toBe("BB");
    expect(second.getAttribute("href")).toBe("#bb");
    expect(second.dataset.target).toBe("bb");
  });

  it("refreshOutline appends and removes items while reusing the rest", () => {
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }]);
    const first = pane.querySelector<HTMLElement>("nav.toc a")!;
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }, { id: "b", text: "B", level: 2 }]);
    expect(pane.querySelectorAll("nav.toc li")).toHaveLength(2);
    expect(pane.querySelector("nav.toc a")).toBe(first);
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }]);
    expect(pane.querySelectorAll("nav.toc li")).toHaveLength(1);
    expect(pane.querySelector("nav.toc a")).toBe(first);
  });

  // 缩进相对最浅标题：前面插入一个更浅的标题，后面已有条目的缩进要跟着重算
  it("refreshOutline re-indents existing items when the shallowest level changes", () => {
    refreshOutline(pane, [{ id: "b", text: "B", level: 2 }, { id: "c", text: "C", level: 3 }]);
    const [b0] = Array.from(pane.querySelectorAll<HTMLElement>("nav.toc a"));
    const before = parseInt(b0.style.paddingLeft, 10);
    refreshOutline(pane, [{ id: "a", text: "A", level: 1 }, { id: "b", text: "B", level: 2 }, { id: "c", text: "C", level: 3 }]);
    const [a, b, c] = Array.from(pane.querySelectorAll<HTMLElement>("nav.toc a"));
    expect(parseInt(b.style.paddingLeft, 10) - parseInt(a.style.paddingLeft, 10)).toBe(14);
    expect(parseInt(c.style.paddingLeft, 10) - parseInt(b.style.paddingLeft, 10)).toBe(14);
    expect(parseInt(a.style.paddingLeft, 10)).toBe(before);
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
