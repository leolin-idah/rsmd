/// 状态栏用的字数统计。统计对象是 Markdown 源文（三种模式同一口径，切模式数字不跳）。
export interface TextStats {
  words: number; // CJK 按字计，其余脚本按词计（Typora / Pages 口径）
  chars: number; // 非空白字符数
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
// 字母/数字串，内部允许 ' ’ . - 连接（don't / re-enter / 3.14 各算一个词）
const WORD = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

export function countText(text: string): TextStats {
  const chars = text.replace(/\s/gu, "").length;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, " ");
  const words = cjk + (rest.match(WORD)?.length ?? 0);
  return { words, chars };
}
