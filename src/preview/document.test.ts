import { beforeEach, describe, expect, it, vi } from "vitest";

const enhanceMock = vi.fn(async (_root: HTMLElement, _isCurrent?: () => boolean) => {});
vi.mock("./enhance", () => ({
  enhance: (root: HTMLElement, isCurrent?: () => boolean) => enhanceMock(root, isCurrent),
}));
vi.mock("./dom", () => ({
  updatePreview: (c: HTMLElement, html: string) => {
    c.innerHTML = html;
  },
}));

type Doc = typeof import("./document");
type Store = typeof import("../store");

function opened(docId: number, title = `Title ${docId}`) {
  return {
    docId,
    path: `/docs/${docId}.md`,
    fileName: `${docId}.md`,
    html: `<p>doc ${docId}</p>`,
    title,
    baseDir: "/docs",
    activate: true,
  };
}

/// 批量打开里的非首个文档：Rust 不设 active，前端只建空壳、不渲染
function background(docId: number, title = `Title ${docId}`) {
  return { ...opened(docId, title), activate: false };
}

describe("document lifecycle", () => {
  let doc: Doc;
  let store: Store["useShellStore"];
  let host: HTMLElement;

  beforeEach(async () => {
    vi.resetModules(); // 清空模块级 registry 与 store（二者在同一次 reset 后导入，共享实例）
    enhanceMock.mockClear();
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

  it("registers the opened doc in the store as the active tab", () => {
    doc.openDoc(opened(1));
    expect(store.getState().tabs.map((t) => t.docId)).toEqual([1]);
    expect(active()).toBe(1);
  });

  it("keeps per-doc generations isolated: doc B refresh does not stale doc A", async () => {
    doc.openDoc(opened(1));
    doc.openDoc(opened(2));
    const isCurrentA = enhanceMock.mock.calls[0][1]!;
    expect(isCurrentA()).toBe(true);

    // doc B 热刷新（相当于 A 的 mermaid 仍在渲染中）
    await doc.updateDoc({ docId: 2, html: "<p>new</p>", title: "T2" });
    expect(isCurrentA()).toBe(true); // A 的在途 enhance 结果仍允许写入

    // A 自己刷新才会使旧代际过期
    await doc.updateDoc({ docId: 1, html: "<p>new</p>", title: "T1" });
    expect(isCurrentA()).toBe(false);
  });

  it("window title follows only the active doc", async () => {
    doc.openDoc(opened(1, "One"));
    doc.openDoc(opened(2, "Two"));
    expect(document.title).toBe("Two");

    await doc.updateDoc({ docId: 1, html: "<p>x</p>", title: "One!" });
    expect(document.title).toBe("Two"); // 后台刷新不改标题

    focus(1);
    expect(document.title).toBe("One!"); // 切回时取最新标题
  });

  it("shows exactly one pane and switching does not re-enhance", () => {
    doc.openDoc(opened(1));
    doc.openDoc(opened(2));
    expect(pane(1).style.display).toBe("none");
    expect(pane(2).style.display).toBe("");

    focus(1); // 只改 store：pane 显隐由 document.ts 的订阅完成
    expect(pane(1).style.display).toBe("");
    expect(pane(2).style.display).toBe("none");
    expect(enhanceMock).toHaveBeenCalledTimes(2); // 切换零重渲染
  });

  it("restores the scroll position of a pane when it is shown again", () => {
    doc.openDoc(opened(1));
    pane(1).scrollTop = 120;
    doc.openDoc(opened(2));
    expect(pane(1).style.display).toBe("none");
    pane(1).scrollTop = 0; // 隐藏期间 jsdom 不会自己清零，手动模拟浏览器丢失布局
    focus(1);
    expect(pane(1).scrollTop).toBe(120);
  });

  it("re-focusing the already-active doc leaves the DOM untouched (Rust echo)", () => {
    doc.openDoc(opened(1));
    const before = pane(1).style.display;
    focus(1);
    expect(active()).toBe(1);
    expect(pane(1).style.display).toBe(before);
    expect(host.querySelectorAll(".pane").length).toBe(1);
  });

  it("closeDoc removes the pane and tab and activates nextActive", () => {
    doc.openDoc(opened(1));
    doc.openDoc(opened(2, "Two"));
    doc.closeDoc(2, 1);
    expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
    expect(store.getState().tabs.map((t) => t.docId)).toEqual([1]);
    expect(active()).toBe(1);
    expect(pane(1).style.display).toBe("");
    expect(document.title).toBe("Title 1");
  });

  it("closing the last doc resets the title and active state", () => {
    doc.openDoc(opened(1));
    doc.closeDoc(1, null);
    expect(host.querySelectorAll(".pane").length).toBe(0);
    expect(active()).toBeNull();
    expect(document.title).toBe("rsmd");
  });

  it("closing a background doc keeps the active pane untouched", () => {
    doc.openDoc(opened(1));
    doc.openDoc(opened(2, "Two"));
    doc.closeDoc(1, 2); // 关非 active：Rust 规则 active 不变
    expect(active()).toBe(2);
    expect(document.title).toBe("Two");
  });

  it("closeDoc for an unknown doc is a no-op", () => {
    doc.openDoc(opened(1));
    doc.closeDoc(9, null);
    expect(active()).toBe(1);
    expect(host.querySelectorAll(".pane").length).toBe(1);
  });

  it("updateDoc clears the doc's notice (the file is reachable again)", async () => {
    doc.openDoc(opened(1));
    store.getState().setNotice(1, "File was deleted");
    await doc.updateDoc({ docId: 1, html: "<p>back</p>", title: "T" });
    expect(store.getState().notices[1]).toBeUndefined();
  });

  it("builds a toc for headed docs and rebuilds it on update", async () => {
    doc.openDoc({
      ...opened(1),
      html: `<h1><a id="a"></a>A</h1><h2><a id="b"></a>B</h2>`,
    });
    expect(pane(1).querySelectorAll("nav.toc a").length).toBe(2);

    await doc.updateDoc({
      docId: 1,
      html: `<h1><a id="a"></a>A</h1>`,
      title: "T",
    });
    expect(pane(1).querySelectorAll("nav.toc").length).toBe(1);
    expect(pane(1).querySelectorAll("nav.toc a").length).toBe(1);
  });

  it("creates no toc for docs without headings", () => {
    doc.openDoc(opened(1)); // html 是 <p>doc 1</p>
    expect(pane(1).querySelector("nav.toc")).toBeNull();
  });

  it("re-syncs the toc highlight when a background doc is shown again", async () => {
    const headed = `<h1><a id="a"></a>A</h1><h2><a id="b"></a>B</h2>`;
    doc.openDoc({ ...opened(1), html: headed });
    doc.openDoc(opened(2)); // doc 1 转入后台（display:none）
    await doc.updateDoc({ docId: 1, html: headed, title: "T1" }); // 后台热刷新：rect 全 0 → 末标题 b 被标 active
    expect(pane(1).querySelector("a.active")!.getAttribute("href")).toBe("#b");

    // 模拟切回后的真实布局：a 在顶部附近、b 在下方
    const tops = [10, 600];
    Array.from(
      pane(1).querySelectorAll<HTMLElement>(".markdown-body h1, .markdown-body h2")
    ).forEach((h, i) => {
      h.getBoundingClientRect = () => ({ top: tops[i] }) as DOMRect;
    });
    focus(1);
    expect(pane(1).querySelector("a.active")!.getAttribute("href")).toBe("#a");
  });

  describe("background open (lazy materialization)", () => {
    it("does not render, enhance, activate, or retitle a background doc", () => {
      doc.openDoc(opened(1, "One"));
      enhanceMock.mockClear();
      doc.openDoc(background(2, "Two"));

      expect(active()).toBe(1);
      expect(store.getState().tabs.map((t) => t.docId)).toEqual([1, 2]);
      expect(document.title).toBe("One");
      expect(pane(2).style.display).toBe("none");
      expect(pane(2).querySelector(".markdown-body")!.innerHTML).toBe("");
      expect(enhanceMock).not.toHaveBeenCalled();
    });

    it("materializes a background doc on first focus", () => {
      doc.openDoc(opened(1, "One"));
      doc.openDoc({
        ...background(2, "Two"),
        html: `<h1><a id="a"></a>A</h1><p>doc 2</p>`,
      });
      enhanceMock.mockClear();

      focus(2);

      expect(pane(2).style.display).toBe("");
      expect(pane(2).querySelector(".markdown-body")!.innerHTML).toContain("doc 2");
      expect(pane(2).querySelectorAll("nav.toc a").length).toBe(1);
      expect(document.title).toBe("Two");
      expect(enhanceMock).toHaveBeenCalledTimes(1);
    });

    it("materializes only once: refocusing does not re-render", () => {
      doc.openDoc(opened(1));
      doc.openDoc(background(2));
      focus(2);
      enhanceMock.mockClear();

      focus(1);
      focus(2);
      expect(enhanceMock).not.toHaveBeenCalled();
    });

    it("hot-reload of a pending doc only updates the stored payload", async () => {
      doc.openDoc(opened(1, "One"));
      doc.openDoc(background(2, "Two"));
      enhanceMock.mockClear();

      await doc.updateDoc({ docId: 2, html: "<p>fresh</p>", title: "Two!" });

      expect(pane(2).querySelector(".markdown-body")!.innerHTML).toBe(""); // 仍未物化
      expect(enhanceMock).not.toHaveBeenCalled();
      expect(document.title).toBe("One");

      focus(2);
      expect(pane(2).querySelector(".markdown-body")!.innerHTML).toBe("<p>fresh</p>");
      expect(document.title).toBe("Two!");
    });

    it("closing a pending doc removes its pane without touching the active one", () => {
      doc.openDoc(opened(1, "One"));
      doc.openDoc(background(2));
      doc.closeDoc(2, 1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(active()).toBe(1);
      expect(document.title).toBe("One");
    });

    it("a background doc becomes visible when it is the nextActive after close", () => {
      doc.openDoc(opened(1, "One"));
      doc.openDoc(background(2, "Two"));
      enhanceMock.mockClear();

      doc.closeDoc(1, 2);

      expect(pane(2).style.display).toBe("");
      expect(pane(2).querySelector(".markdown-body")!.innerHTML).toContain("doc 2");
      expect(document.title).toBe("Two");
      expect(enhanceMock).toHaveBeenCalledTimes(1);
    });
  });
});
