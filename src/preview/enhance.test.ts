import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(async () => ({
    getLoadedLanguages: () => ["rust"],
    loadLanguage: vi.fn(async (lang: string) => {
      if (lang === "nosuchlang") throw new Error("unknown");
    }),
    codeToHtml: (code: string, opts: { lang: string }) =>
      `<pre class="shiki"><code>HL:${opts.lang}:${code}</code></pre>`,
  })),
}));
vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine: vi.fn(() => ({})),
}));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => {
      if (code.includes("bad")) throw new Error("parse error");
      return { svg: `<svg data-graph="${code}"></svg>` };
    }),
  },
}));
vi.mock("katex", () => ({
  default: {
    render: vi.fn((tex: string, el: HTMLElement) => {
      el.innerHTML = `K:${tex}`;
    }),
  },
}));
vi.mock("../ipc", () => ({
  assetUrl: (p: string) => `asset://localhost${p}`,
}));

import { enhance } from "./enhance";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

beforeEach(() => vi.clearAllMocks());

describe("enhance", () => {
  it("highlights code blocks and records raw", async () => {
    const r = root('<pre><code class="language-rust">fn x() {}</code></pre>');
    await enhance(r);
    const pre = r.querySelector("pre")!;
    expect(pre.dataset.enhanced).toBe("shiki");
    expect(pre.dataset.raw).toBe("fn x() {}");
    expect(pre.innerHTML).toContain("HL:rust:fn x() {}");
  });

  it("renders mermaid blocks to svg", async () => {
    const r = root('<pre><code class="language-mermaid">graph TD</code></pre>');
    await enhance(r);
    const pre = r.querySelector("pre")!;
    expect(pre.dataset.enhanced).toBe("mermaid");
    expect(pre.querySelector("svg")).not.toBeNull();
  });

  it("isolates a failing mermaid block", async () => {
    const r = root(
      '<pre><code class="language-mermaid">bad graph</code></pre>' +
        '<pre><code class="language-rust">ok()</code></pre>'
    );
    await enhance(r);
    const [broken, fine] = Array.from(r.querySelectorAll("pre"));
    expect(broken.querySelector(".enhance-error")).not.toBeNull();
    expect(broken.textContent).toContain("bad graph"); // 原文保留
    expect(fine.dataset.enhanced).toBe("shiki");
  });

  it("renders math spans with katex", async () => {
    const r = root('<span data-math-style="inline">x^2</span>');
    await enhance(r);
    const span = r.querySelector("span")!;
    expect(span.dataset.enhanced).toBe("katex");
    expect(span.innerHTML).toBe("K:x^2");
  });

  it("converts absolute local image src", async () => {
    const r = root('<img src="/docs/img.png">');
    await enhance(r);
    const img = r.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/docs/img.png");
    expect(img.dataset.raw).toBe("/docs/img.png");
  });

  it("is idempotent: enhanced blocks are not re-processed", async () => {
    const mermaid = (await import("mermaid")).default;
    const r = root('<pre><code class="language-mermaid">graph TD</code></pre>');
    await enhance(r);
    await enhance(r);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("skips DOM writes when the document generation is stale", async () => {
    const mermaid = (await import("mermaid")).default;
    // 可控的慢渲染：enhance 已挂起在 await 上之后才手动放行
    let release!: () => void;
    (mermaid.render as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ svg: '<svg data-stale="1"></svg>' });
        })
    );
    const r = root('<pre><code class="language-mermaid">graph TD</code></pre>');
    const done = enhance(r, () => false); // 文档已被新一代替换
    release();
    await done;
    const pre = r.querySelector("pre")!;
    expect(pre.querySelector("svg")).toBeNull();
    expect(pre.dataset.enhanced).toBeUndefined();
    expect(pre.textContent).toContain("graph TD");
  });

  it("leaves unknown languages as plain text", async () => {
    const r = root('<pre><code class="language-nosuchlang">x</code></pre>');
    await enhance(r);
    const pre = r.querySelector("pre")!;
    expect(pre.dataset.enhanced).toBe("plain");
    expect(pre.textContent).toContain("x");
  });

  it("defers each highlight to a later task so the browser can paint first", async () => {
    const r = root(
      '<pre><code class="language-rust">a()</code></pre>' +
        '<pre><code class="language-rust">b()</code></pre>'
    );
    vi.useFakeTimers();
    try {
      const done = enhance(r);
      // 只放行微任务：高亮器已就绪，但同步高亮不得在本任务内执行
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(r.querySelectorAll("pre[data-enhanced]").length).toBe(0);
      await vi.runAllTimersAsync();
      await done;
      expect(r.querySelectorAll('pre[data-enhanced="shiki"]').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("highlights each document independently of another document's backlog", async () => {
    const a = root(
      '<pre><code class="language-rust">a1()</code></pre>' +
        '<pre><code class="language-rust">a2()</code></pre>' +
        '<pre><code class="language-rust">a3()</code></pre>'
    );
    const b = root('<pre><code class="language-rust">b1()</code></pre>');
    vi.useFakeTimers();
    try {
      const doneA = enhance(a);
      const doneB = enhance(b);
      // 放行微任务：高亮器就绪，各块进入队列等待帧边界（20 远大于实际需要的跳数）
      for (let i = 0; i < 20; i++) await Promise.resolve();
      vi.advanceTimersToNextFrame(); // 一次 rAF
      await vi.advanceTimersByTimeAsync(1); // 其后的 setTimeout(0)
      // 一帧之后：B 的块不应排在 A 的三块之后
      expect(a.querySelectorAll('pre[data-enhanced="shiki"]').length).toBe(1);
      expect(b.querySelectorAll('pre[data-enhanced="shiki"]').length).toBe(1);
      await vi.runAllTimersAsync();
      await Promise.all([doneA, doneB]);
      expect(a.querySelectorAll('pre[data-enhanced="shiki"]').length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
