import { describe, expect, it } from "vitest";
import { buildToc, pickCurrent, type TocEntry } from "./toc";

const ENTRIES: TocEntry[] = [
  { id: "intro", text: "Intro", level: 1 },
  { id: "setup", text: "Setup", level: 2 },
  { id: "deps", text: "Deps", level: 3 },
];

describe("buildToc", () => {
  it("returns null when there are no headings", () => {
    expect(buildToc([])).toBeNull();
  });

  it("builds nav.toc with per-heading links", () => {
    const nav = buildToc(ENTRIES)!;
    expect(nav.matches("nav.toc")).toBe(true);
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#intro", "#setup", "#deps"]);
    expect(links.map((a) => a.dataset.target)).toEqual(["intro", "setup", "deps"]);
    expect(links[0].textContent).toBe("Intro");
  });

  it("indents by level relative to the shallowest heading", () => {
    const nav = buildToc(ENTRIES)!;
    const [h1, h2, h3] = Array.from(nav.querySelectorAll<HTMLElement>("a"));
    const pad = (a: HTMLElement) => parseInt(a.style.paddingLeft, 10);
    expect(pad(h2) - pad(h1)).toBe(14);
    expect(pad(h3) - pad(h2)).toBe(14);
    const nav2 = buildToc([{ id: "a", text: "A", level: 2 }, { id: "b", text: "B", level: 3 }])!;
    const [a, b] = Array.from(nav2.querySelectorAll<HTMLElement>("a"));
    expect(pad(a)).toBe(pad(h1));
    expect(pad(b) - pad(a)).toBe(14);
  });

  it("skips entries without id or text", () => {
    expect(buildToc([{ id: "", text: "x", level: 1 }, { id: "y", text: "  ", level: 1 }])).toBeNull();
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
    expect(pickCurrent([{ id: "a", top: -300 }, { id: "b", top: 10 }, { id: "c", top: 500 }])).toBe("b");
  });

  // 标题的 scroll-margin-top = --rsmd-header-h(40) + 8：TOC 跳转后目标就停在 top≈48，必须算"当前"
  it("counts a heading parked at its scroll-margin offset as current", () => {
    expect(pickCurrent([{ id: "a", top: -100 }, { id: "b", top: 48 }, { id: "c", top: 600 }])).toBe("b");
  });
});
