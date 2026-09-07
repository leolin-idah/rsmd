import { afterEach, describe, expect, it, vi } from "vitest";
import type { Highlighter } from "shiki";
import { createLazyShikiParser } from "./highlight";

function fakeHighlighter(loaded: string[]) {
  return {
    getLoadedLanguages: () => loaded,
    getLoadedThemes: () => ["github-light", "github-dark"],
    loadLanguage: vi.fn(async (lang: string) => {
      loaded.push(lang);
    }),
    codeToTokens: vi.fn(() => ({
      tokens: [[{ content: "fn", offset: 0, color: "#f00" }]],
      fg: "#000",
      bg: "#fff",
    })),
  } as unknown as Highlighter;
}

const opts = (language: string | undefined, content = "fn main() {}") => ({ content, language, pos: 0, size: content.length + 2 });

describe("createLazyShikiParser", () => {
  it("decorates code in an already loaded language", () => {
    const hl = fakeHighlighter(["rust"]);
    const parser = createLazyShikiParser(hl);
    const out = parser(opts("rust"));
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns a loading promise for a known but not yet loaded language", async () => {
    const hl = fakeHighlighter([]);
    const parser = createLazyShikiParser(hl);
    const out = parser(opts("python"));
    expect(out).toBeInstanceOf(Promise);
    await out;
    expect(hl.loadLanguage).toHaveBeenCalledWith("python");
  });

  it("skips unknown languages, mermaid and blocks without a language", () => {
    const hl = fakeHighlighter([]);
    const parser = createLazyShikiParser(hl);
    expect(parser(opts("nosuchlang"))).toEqual([]);
    expect(parser(opts("mermaid"))).toEqual([]);
    expect(parser(opts(undefined))).toEqual([]);
    expect(hl.loadLanguage).not.toHaveBeenCalled();
  });

  it("skips very long blocks to keep typing responsive", () => {
    const hl = fakeHighlighter(["rust"]);
    const parser = createLazyShikiParser(hl);
    const long = Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n");
    expect(parser(opts("rust", long))).toEqual([]);
  });
});

// 单独 mock "shiki" 的 createHighlighter：用 vi.doMock + vi.resetModules + 动态 import
// 隔离出一份全新的 highlight 模块实例，避免污染上面几个用例已经静态 import 好的模块（及其真实 bundledLanguages）
describe("getHighlighter", () => {
  afterEach(() => {
    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("retries after a failed initialization instead of caching the rejection", async () => {
    const err = new Error("shiki init failed");
    const fakeHl = { fake: true } as unknown as Highlighter;
    const createHighlighter = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(fakeHl);

    vi.doMock("shiki", async (importOriginal) => {
      const actual = await importOriginal<typeof import("shiki")>();
      return { ...actual, createHighlighter };
    });
    vi.resetModules();

    const { getHighlighter } = await import("./highlight");

    await expect(getHighlighter()).rejects.toThrow(err);
    await expect(getHighlighter()).resolves.toBe(fakeHl);
    expect(createHighlighter).toHaveBeenCalledTimes(2);
  });
});
