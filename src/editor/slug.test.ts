import { describe, expect, it } from "vitest";
import { firstH1FromText, headingLine, headingLines, slugify, stripInline } from "./slug";

describe("slugify", () => {
  it("lowercases, strips punctuation and joins words with hyphens", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Setup & Deps  ")).toBe("setup-deps");
  });

  it("keeps CJK, digits, hyphens and underscores", () => {
    expect(slugify("第 2 章 概述")).toBe("第-2-章-概述");
    expect(slugify("snake_case-name")).toBe("snake_case-name");
  });
});

describe("stripInline", () => {
  // 与 ProseMirror textContent / Rust first_heading 同一套语义：图片与行内公式都是原子节点，不贡献文本
  it("removes emphasis/code markers and link targets, and drops images and inline math", () => {
    expect(stripInline("Hello **World** `x` $x_1$ [doc](./a.md) ![img](p.png)")).toBe("Hello World x doc");
  });

  it("keeps bare dollar amounts (not valid inline math)", () => {
    expect(stripInline("Revenue $5M and $10M")).toBe("Revenue $5M and $10M");
  });

  // PM 侧的 inline html 是原子节点（原文存在 attrs.value 里），textContent 只剩标签之间的字；
  // 有定义的脚注引用同样是无文本的原子节点
  it("drops inline html tags and footnote references, like ProseMirror's textContent", () => {
    expect(stripInline("Foo<sup>1</sup> bar[^1]")).toBe("Foo1 bar");
    expect(stripInline("Line<br/>break")).toBe("Linebreak");
  });

  it("keeps bare angle brackets that are not tags", () => {
    expect(stripInline("5 < 6 and <b>bold</b>")).toBe("5 < 6 and bold");
  });
});

describe("firstH1FromText", () => {
  it("finds an ATX h1 and strips inline markup", () => {
    expect(firstH1FromText("intro\n\n# Hello **World** [x](y)\n")).toBe("Hello World x");
  });

  it("skips an h1 that is empty after stripping and takes the next one", () => {
    expect(firstH1FromText("# ![alt](a.png)\n\n# Real\n")).toBe("Real");
  });

  it("returns null when the only h1 is empty after stripping", () => {
    expect(firstH1FromText("# ![alt](a.png)\n")).toBeNull();
  });

  it("finds a setext h1", () => {
    expect(firstH1FromText("Title\n=====\n\nbody")).toBe("Title");
  });

  it("skips front matter and fenced code", () => {
    expect(firstH1FromText("---\ntitle: fm\n---\n```\n# not me\n```\n# Real\n")).toBe("Real");
  });

  it("ignores h2 and returns null without an h1", () => {
    expect(firstH1FromText("## only h2\n")).toBeNull();
  });
});

describe("headingLine", () => {
  const text = "# Intro\n\ntext\n\n## Setup & Deps\n\n```\n# fenced\n```\n\nSub\n---\n";
  it("finds ATX and setext headings by slug, skipping fences", () => {
    expect(headingLine(text, "intro")).toBe(1);
    expect(headingLine(text, "setup-deps")).toBe(5);
    expect(headingLine(text, "sub")).toBe(11);
    expect(headingLine(text, "fenced")).toBeNull();
  });

  it("returns null for unknown ids", () => {
    expect(headingLine(text, "nope")).toBeNull();
  });

  // Milkdown 的 syncHeadingIdPlugin 给重复 slug 编号成 dup / dup-#2 / dup-#3，TOC 拿到的就是这些 id
  it("resolves Milkdown's -#N suffix for duplicate headings", () => {
    const dup = "# Dup\n\ntext\n\n## Dup\n\n### Dup\n";
    expect(headingLine(dup, "dup")).toBe(1);
    expect(headingLine(dup, "dup-#2")).toBe(5);
    expect(headingLine(dup, "dup-#3")).toBe(7);
  });
});

describe("headingLines", () => {
  const text = "# Intro\n\ntext\n\n## Setup & Deps\n\n```\n# fenced\n```\n\nSub\n---\n";
  it("maps every slug to its line in one pass, skipping fences and keeping the first duplicate", () => {
    expect(Object.fromEntries(headingLines(text))).toEqual({ intro: 1, "setup-deps": 5, sub: 11 });
    expect(headingLines(text).has("fenced")).toBe(false);
    expect(headingLines("# ![i](p.png)\n\n# Real\n").has("")).toBe(false); // 空标题不进表
    expect(headingLines("# Dup\n\ntext\n\n## Dup\n").get("dup")).toBe(1);
  });

  it("numbers duplicate slugs exactly like Milkdown's syncHeadingIdPlugin", () => {
    expect(Object.fromEntries(headingLines("# Dup\n\ntext\n\n## Dup\n"))).toEqual({ dup: 1, "dup-#2": 5 });
  });
});
