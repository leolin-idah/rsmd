import { describe, expect, it } from "vitest";
import { disambiguate } from "./tabs";

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
