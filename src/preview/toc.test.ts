import { describe, expect, it } from "vitest";
import { buildToc, extractHeadings, pickCurrent, refreshToc, syncActive } from "./toc";

// 模拟 comrak header_ids + ammonia 清洗后的输出：id 在内嵌 <a class="anchor"> 上
const HTML = `
<h1><a href="#intro" class="anchor" id="intro"></a>Intro</h1>
<p>text</p>
<h2><a href="#setup" class="anchor" id="setup"></a>Setup</h2>
<h3><a href="#deps" class="anchor" id="deps"></a>Deps</h3>`;

function content(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  return el;
}

describe("extractHeadings", () => {
  it("extracts id/text/level from comrak-style anchors", () => {
    expect(extractHeadings(content(HTML))).toEqual([
      { id: "intro", text: "Intro", level: 1 },
      { id: "setup", text: "Setup", level: 2 },
      { id: "deps", text: "Deps", level: 3 },
    ]);
  });

  it("falls back to the heading's own id", () => {
    const c = content(`<h2 id="direct">Direct</h2>`);
    expect(extractHeadings(c)).toEqual([{ id: "direct", text: "Direct", level: 2 }]);
  });

  it("skips headings without id or without text", () => {
    const c = content(`<h2>NoId</h2><h2><a id="empty"></a>   </h2>`);
    expect(extractHeadings(c)).toEqual([]);
  });
});

describe("buildToc", () => {
  it("returns null when there are no headings", () => {
    expect(buildToc(content("<p>plain</p>"))).toBeNull();
  });

  it("builds nav.toc with per-heading links", () => {
    const nav = buildToc(content(HTML))!;
    expect(nav.matches("nav.toc")).toBe(true);
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#intro", "#setup", "#deps"]);
    expect(links.map((a) => a.dataset.target)).toEqual(["intro", "setup", "deps"]);
    expect(links[0].textContent).toBe("Intro");
  });

  it("indents by level relative to the shallowest heading", () => {
    const nav = buildToc(content(HTML))!;
    const [h1, h2, h3] = Array.from(nav.querySelectorAll<HTMLElement>("a"));
    const pad = (a: HTMLElement) => parseInt(a.style.paddingLeft, 10);
    expect(pad(h2) - pad(h1)).toBe(14);
    expect(pad(h3) - pad(h2)).toBe(14);
    // 从 h2 起头的文档：h2 是基准零缩进
    const nav2 = buildToc(content(`<h2><a id="a"></a>A</h2><h3><a id="b"></a>B</h3>`))!;
    const [a, b] = Array.from(nav2.querySelectorAll<HTMLElement>("a"));
    expect(pad(a)).toBe(pad(h1));
    expect(pad(b) - pad(a)).toBe(14);
  });
});

describe("pickCurrent", () => {
  it("returns null for empty input", () => {
    expect(pickCurrent([])).toBeNull();
  });

  it("returns the first heading when none has passed the threshold", () => {
    expect(pickCurrent([{ id: "a", top: 200 }, { id: "b", top: 400 }])).toBe("a");
  });

  it("returns the last heading that passed the threshold", () => {
    expect(
      pickCurrent([
        { id: "a", top: -300 },
        { id: "b", top: 10 },
        { id: "c", top: 500 },
      ])
    ).toBe("b");
  });
});

function pane(html: string): { p: HTMLElement; c: HTMLElement } {
  const p = document.createElement("div");
  p.className = "pane";
  const c = content(html);
  p.appendChild(c);
  document.body.appendChild(p);
  return { p, c };
}

// jsdom 无布局：手动指定各标题相对视口的 top（pane rect 全 0，等价于相对 pane 顶）
function layout(c: HTMLElement, tops: number[]): void {
  Array.from(c.querySelectorAll<HTMLElement>("h1,h2,h3")).forEach((h, i) => {
    h.getBoundingClientRect = () => ({ top: tops[i] }) as DOMRect;
  });
}

describe("refreshToc / syncActive", () => {
  it("appends nav.toc to the pane and highlights the current section", () => {
    const { p, c } = pane(HTML);
    layout(c, [-100, 10, 300]); // setup 刚越过阈值线
    refreshToc(p, c);
    const active = p.querySelectorAll("nav.toc a.active");
    expect(active.length).toBe(1);
    expect((active[0] as HTMLElement).dataset.target).toBe("setup");
  });

  it("rebuilds instead of duplicating on refresh", () => {
    const { p, c } = pane(HTML);
    refreshToc(p, c);
    c.innerHTML = `<h1><a id="only"></a>Only</h1>`;
    refreshToc(p, c);
    expect(p.querySelectorAll("nav.toc").length).toBe(1);
    expect(p.querySelectorAll("nav.toc a").length).toBe(1);
  });

  it("removes the toc when headings disappear after refresh", () => {
    const { p, c } = pane(HTML);
    refreshToc(p, c);
    c.innerHTML = "<p>no headings anymore</p>";
    refreshToc(p, c);
    expect(p.querySelector("nav.toc")).toBeNull();
  });

  it("syncActive moves the highlight as measurements change", () => {
    const { p, c } = pane(HTML);
    layout(c, [-500, -200, 5]); // 滚到 deps
    refreshToc(p, c);
    syncActive(p);
    expect(p.querySelector("a.active")!.getAttribute("href")).toBe("#deps");
  });

  it("syncActive is a no-op on a pane without toc", () => {
    const { p } = pane("<p>x</p>");
    expect(() => syncActive(p)).not.toThrow();
  });
});
