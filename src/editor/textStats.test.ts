import { describe, expect, it } from "vitest";
import { countText } from "./textStats";

describe("countText", () => {
  it("returns zeros for empty text", () => {
    expect(countText("")).toEqual({ words: 0, chars: 0 });
  });

  it("counts Latin words and non-whitespace characters", () => {
    expect(countText("Hello,  world!\n")).toEqual({ words: 2, chars: 12 });
  });

  it("keeps contractions, hyphenations and decimals as single words", () => {
    expect(countText("don't re-enter 3.14")).toEqual({ words: 3, chars: 17 });
  });

  it("counts every CJK ideograph as one word", () => {
    // 与 Typora / Pages 一致：中文按字计词，全角标点只计入字符
    expect(countText("中文分词，测试。")).toEqual({ words: 6, chars: 8 });
  });

  it("mixes CJK characters and Latin words", () => {
    expect(countText("Hello 世界 world")).toEqual({ words: 4, chars: 12 });
  });

  it("does not count markdown punctuation as words", () => {
    expect(countText("# Title\n\n- **bold** item\n")).toEqual({ words: 3, chars: 19 });
  });
});
