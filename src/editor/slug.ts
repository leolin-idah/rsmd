/// GitHub 风格 slug：小写、去标点（保留字母 / 数字 / 空白 / 连字符 / 下划线，含 CJK）、空白转 -。
/// 与 Milkdown 的 headingIdGenerator 共用（Task 2），source 模式的锚点扫描（headingLine）按同一规则生成 id 才对得上。
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/// 去掉行内标记，对齐 ProseMirror heading 的 textContent（渲染后的纯文本）与 Rust 的 first_heading：
/// 图片是原子节点，alt **不算**文本；行内公式（math_inline）同样是无文本内容的原子节点，整段丢弃；
/// 链接只留可见文字；行内代码留字面量。最后压掉被丢弃节点留下的连续空白。
/// `$…$` 的两个 (?!\s) / [^\s$] 守卫照 CommonMark math 的规则写（定界符不能贴空白），
/// 免得把 "Revenue $5M and $10M" 这种金额当成公式吃掉；不用后行断言，WKWebView 老版本不支持。
/// 行内 HTML 在 PM 里是原子的 html 节点（原文存在 attrs.value），textContent 只剩标签之间的字，
/// 所以标签要去掉、里面的文字要留（`Foo<sup>1</sup>` → `Foo1`）。`<` 后必须紧跟字母或 `/` 才算标签，
/// `[^<>]*` 不跨下一个 `<`：`5 < 6` 这种比较号 CommonMark 不当 HTML，PM 会原样留着。
/// 脚注引用（footnote_reference）也是无文本的原子节点，一并丢掉——已知偏差：没有对应定义的
/// `[^1]` 在 PM 里退化成普通文本会被留下，这里仍按引用剥掉（悬空引用极少见，不值得为它扫全文）。
export function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\$\$[^\n]*?\$\$/g, "")
    .replace(/\$(?![\s$])(?:[^$\n]*[^\s$])?\$/g, "")
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface HeadingHit {
  line: number; // 1-based
  level: number;
  text: string;
}

/// 逐行扫描标题：跳过文首 front matter 与围栏代码；识别 ATX 与 setext（下一行全 = 或全 -）。
function* headings(text: string): Generator<HeadingHit> {
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*(?:\s#+\s*)?$/.exec(line);
    if (atx) {
      const text = stripInline(atx[2]);
      // 纯图片 / 纯公式的标题剥完是空串：不算标题（与 PM 的 headingsOf、Rust 的 first_heading 一致），
      // 否则 firstH1FromText 会给出空标题、headingLine(s) 会造出一个 "" 的 slug
      if (text) yield { line: i + 1, level: atx[1].length, text };
      continue;
    }
    const next = lines[i + 1];
    if (line.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next)) {
      const text = stripInline(line);
      if (text) yield { line: i + 1, level: next.trim().startsWith("=") ? 1 : 2, text };
      i++; // 下划线行不再当正文（无论上面那行剥完是不是空串）
    }
  }
}

/// 源码文本里的首个 H1（source 模式下的标题来源；Rust 在 open / update / save 时按 comrak 同规则取）
export function firstH1FromText(text: string): string | null {
  for (const h of headings(text)) {
    if (h.level === 1) return h.text;
  }
  return null;
}

/// 给 headings() 逐个编 id，规则与 Milkdown 的 syncHeadingIdPlugin 逐字一致（见
/// @milkdown/preset-commonmark：同一 slug 第二次出现起加 `-#2` / `-#3` …）。TOC 的条目来自 PM，
/// source 模式必须用同一套编号才认得出重复标题，否则第二个及以后的重复标题永远跳不过去。
function* headingIds(text: string): Generator<{ id: string; line: number }> {
  const seen = new Map<string, number>();
  for (const h of headings(text)) {
    const base = slugify(h.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    yield { id: n === 1 ? base : `${base}-#${n}`, line: h.line };
  }
}

/// 源码里 id 对应的标题行号（1-based）。
/// 保留独立实现（不走 headingLines）：单次查询能在命中处提前退出，也不必建 Map
export function headingLine(text: string, id: string): number | null {
  for (const h of headingIds(text)) {
    if (h.id === id) return h.line;
  }
  return null;
}

/// 全篇一趟扫出 slug → 行号（1-based）的表。给"要一次问所有标题位置"的调用方用：
/// source 模式的 scrollspy 每帧都要算全部标题的位置，逐个调 headingLine 是
/// O(标题数 × 文档长度)（headings 每次都重切一遍行数组），大文档单帧能到几百毫秒
export function headingLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of headingIds(text)) {
    // headingIds 已保证 id 唯一；这一层只是兜底，命中时与 headingLine 一样保留第一个
    if (!out.has(h.id)) out.set(h.id, h.line);
  }
  return out;
}
