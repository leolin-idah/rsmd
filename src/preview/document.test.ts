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

describe("document registry", () => {
  let doc: Doc;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.resetModules(); // 清空模块级 registry / activeId
    enhanceMock.mockClear();
    doc = await import("./document");
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    doc.attachHost(host);
  });

  it("keeps per-doc generations isolated: doc B refresh does not stale doc A", async () => {
    await doc.openDoc(opened(1));
    await doc.openDoc(opened(2));
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
    await doc.openDoc(opened(1, "One"));
    await doc.openDoc(opened(2, "Two"));
    expect(document.title).toBe("Two");

    await doc.updateDoc({ docId: 1, html: "<p>x</p>", title: "One!" });
    expect(document.title).toBe("Two"); // 后台刷新不改标题

    doc.applyFocus(1);
    expect(document.title).toBe("One!"); // 切回时取最新标题
  });

  it("shows exactly one pane and switching does not re-enhance", async () => {
    await doc.openDoc(opened(1));
    await doc.openDoc(opened(2));
    const pane1 = host.querySelector<HTMLElement>('[data-doc-id="1"]')!;
    const pane2 = host.querySelector<HTMLElement>('[data-doc-id="2"]')!;
    expect(pane1.style.display).toBe("none");
    expect(pane2.style.display).toBe("");

    doc.applyFocus(1);
    expect(pane1.style.display).toBe("");
    expect(pane2.style.display).toBe("none");
    expect(enhanceMock).toHaveBeenCalledTimes(2); // 切换零重渲染
  });

  it("applyFocus is idempotent for the already-active doc", async () => {
    await doc.openDoc(opened(1));
    const pane1 = host.querySelector<HTMLElement>('[data-doc-id="1"]')!;
    pane1.style.display = ""; // 基准
    doc.applyFocus(1); // Rust 回声
    expect(doc.activeDocId()).toBe(1);
    expect(host.querySelectorAll(".pane").length).toBe(1);
  });

  it("closeDoc removes the pane and activates nextActive", async () => {
    await doc.openDoc(opened(1));
    await doc.openDoc(opened(2, "Two"));
    doc.closeDoc(2, 1);
    expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
    expect(doc.activeDocId()).toBe(1);
    expect(document.title).toBe("Title 1");
  });

  it("closing the last doc resets the title and active state", async () => {
    await doc.openDoc(opened(1));
    doc.closeDoc(1, null);
    expect(host.querySelectorAll(".pane").length).toBe(0);
    expect(doc.activeDocId()).toBeNull();
    expect(document.title).toBe("rsmd");
  });

  it("closing a background doc keeps the active pane untouched", async () => {
    await doc.openDoc(opened(1));
    await doc.openDoc(opened(2, "Two"));
    doc.closeDoc(1, 2); // 关非 active：Rust 规则 active 不变
    expect(doc.activeDocId()).toBe(2);
    expect(document.title).toBe("Two");
  });

  it("builds a toc for headed docs and rebuilds it on update", async () => {
    await doc.openDoc({
      ...opened(1),
      html: `<h1><a id="a"></a>A</h1><h2><a id="b"></a>B</h2>`,
    });
    const pane = host.querySelector<HTMLElement>('[data-doc-id="1"]')!;
    expect(pane.querySelectorAll("nav.toc a").length).toBe(2);

    await doc.updateDoc({
      docId: 1,
      html: `<h1><a id="a"></a>A</h1>`,
      title: "T",
    });
    expect(pane.querySelectorAll("nav.toc").length).toBe(1);
    expect(pane.querySelectorAll("nav.toc a").length).toBe(1);
  });

  it("creates no toc for docs without headings", async () => {
    await doc.openDoc(opened(1)); // html 是 <p>doc 1</p>
    const pane = host.querySelector<HTMLElement>('[data-doc-id="1"]')!;
    expect(pane.querySelector("nav.toc")).toBeNull();
  });

  it("re-syncs the toc highlight when a background doc is shown again", async () => {
    const headed = `<h1><a id="a"></a>A</h1><h2><a id="b"></a>B</h2>`;
    await doc.openDoc({ ...opened(1), html: headed });
    await doc.openDoc(opened(2)); // doc 1 转入后台（display:none）
    await doc.updateDoc({ docId: 1, html: headed, title: "T1" }); // 后台热刷新：rect 全 0 → 末标题 b 被标 active
    const pane1 = host.querySelector<HTMLElement>('[data-doc-id="1"]')!;
    expect(pane1.querySelector("a.active")!.getAttribute("href")).toBe("#b");

    // 模拟切回后的真实布局：a 在顶部附近、b 在下方
    const tops = [10, 600];
    Array.from(pane1.querySelectorAll<HTMLElement>(".markdown-body h1, .markdown-body h2")).forEach((h, i) => {
      h.getBoundingClientRect = () => ({ top: tops[i] }) as DOMRect;
    });
    doc.applyFocus(1);
    expect(pane1.querySelector("a.active")!.getAttribute("href")).toBe("#a");
  });
  describe("background open (lazy materialization)", () => {
    it("does not render, enhance, or retitle a background doc", async () => {
      await doc.openDoc(opened(1, "One"));
      enhanceMock.mockClear();
      await doc.openDoc(background(2, "Two"));

      expect(doc.activeDocId()).toBe(1);
      expect(document.title).toBe("One");
      const pane2 = host.querySelector<HTMLElement>('[data-doc-id="2"]')!;
      expect(pane2.style.display).toBe("none");
      expect(pane2.querySelector(".markdown-body")!.innerHTML).toBe("");
      expect(enhanceMock).not.toHaveBeenCalled();
    });

    it("materializes a background doc on first focus", async () => {
      await doc.openDoc(opened(1, "One"));
      await doc.openDoc({
        ...background(2, "Two"),
        html: `<h1><a id="a"></a>A</h1><p>doc 2</p>`,
      });
      enhanceMock.mockClear();

      doc.applyFocus(2);

      const pane2 = host.querySelector<HTMLElement>('[data-doc-id="2"]')!;
      expect(pane2.style.display).toBe("");
      expect(pane2.querySelector(".markdown-body")!.innerHTML).toContain("doc 2");
      expect(pane2.querySelectorAll("nav.toc a").length).toBe(1);
      expect(document.title).toBe("Two");
      expect(enhanceMock).toHaveBeenCalledTimes(1);
    });

    it("materializes only once: refocusing does not re-render", async () => {
      await doc.openDoc(opened(1));
      await doc.openDoc(background(2));
      doc.applyFocus(2);
      enhanceMock.mockClear();

      doc.applyFocus(1);
      doc.applyFocus(2);
      expect(enhanceMock).not.toHaveBeenCalled();
    });

    it("hot-reload of a pending doc only updates the stored payload", async () => {
      await doc.openDoc(opened(1, "One"));
      await doc.openDoc(background(2, "Two"));
      enhanceMock.mockClear();

      await doc.updateDoc({ docId: 2, html: "<p>fresh</p>", title: "Two!" });

      const pane2 = host.querySelector<HTMLElement>('[data-doc-id="2"]')!;
      expect(pane2.querySelector(".markdown-body")!.innerHTML).toBe(""); // 仍未物化
      expect(enhanceMock).not.toHaveBeenCalled();
      expect(document.title).toBe("One");

      doc.applyFocus(2);
      expect(pane2.querySelector(".markdown-body")!.innerHTML).toBe("<p>fresh</p>");
      expect(document.title).toBe("Two!");
    });

    it("closing a pending doc removes its pane without touching the active one", async () => {
      await doc.openDoc(opened(1, "One"));
      await doc.openDoc(background(2));
      doc.closeDoc(2, 1);
      expect(host.querySelector('[data-doc-id="2"]')).toBeNull();
      expect(doc.activeDocId()).toBe(1);
      expect(document.title).toBe("One");
    });

    it("a background doc becomes visible when it is the nextActive after close", async () => {
      await doc.openDoc(opened(1, "One"));
      await doc.openDoc(background(2, "Two"));
      enhanceMock.mockClear();

      doc.closeDoc(1, 2);

      const pane2 = host.querySelector<HTMLElement>('[data-doc-id="2"]')!;
      expect(pane2.style.display).toBe("");
      expect(pane2.querySelector(".markdown-body")!.innerHTML).toContain("doc 2");
      expect(document.title).toBe("Two");
      expect(enhanceMock).toHaveBeenCalledTimes(1);
    });
  });
});
