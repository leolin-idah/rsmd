import { beforeEach, describe, expect, it, vi } from "vitest";
import { disambiguate } from "./tabs";

type Tabs = typeof import("./tabs");

describe("disambiguate", () => {
  it("uses bare file names when unique", () => {
    expect(disambiguate(["/a/one.md", "/b/two.md"])).toEqual(["one.md", "two.md"]);
  });

  it("extends duplicated names by one parent segment", () => {
    expect(disambiguate(["/a/readme.md", "/b/readme.md"])).toEqual([
      "a/readme.md",
      "b/readme.md",
    ]);
  });

  it("keeps extending while still ambiguous (同名同父不同祖父)", () => {
    expect(
      disambiguate(["/x/docs/readme.md", "/y/docs/readme.md", "/z/other.md"])
    ).toEqual(["x/docs/readme.md", "y/docs/readme.md", "other.md"]);
  });

  it("only extends the colliding group, not unrelated tabs", () => {
    expect(
      disambiguate(["/a/readme.md", "/b/readme.md", "/c/unique.md"])
    ).toEqual(["a/readme.md", "b/readme.md", "unique.md"]);
  });

  it("stops extending at the root", () => {
    expect(disambiguate(["/readme.md", "/a/readme.md"])).toEqual([
      "readme.md",
      "a/readme.md",
    ]);
  });
});

describe("addTab", () => {
  let tabs: Tabs;

  beforeEach(async () => {
    vi.resetModules(); // 清空模块级 tabs / active
    tabs = await import("./tabs");
  });

  it("activates the tab when opened with activate=true", () => {
    tabs.addTab(1, "/x/a.md", "a.md", true);
    tabs.addTab(2, "/x/b.md", "b.md", true);
    expect(tabs.getTabs().active).toBe(2);
  });

  it("keeps the current active when a background tab is added", () => {
    tabs.addTab(1, "/x/a.md", "a.md", true);
    tabs.addTab(2, "/x/b.md", "b.md", false);
    const state = tabs.getTabs();
    expect(state.tabs.map((t) => t.docId)).toEqual([1, 2]); // 仍按打开顺序追加
    expect(state.active).toBe(1);
  });
});
