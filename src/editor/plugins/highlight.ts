import type { Ctx } from "@milkdown/ctx";
import { highlight, highlightPluginConfig } from "@milkdown/plugin-highlight";
import { createParser, type Parser } from "@milkdown/plugin-highlight/shiki";
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { Feature } from "../pmEditor";

/// 超过这个行数的代码块不高亮：shiki 的 JS 正则引擎单块可达数百 ms，会拖慢打字
export const MAX_HIGHLIGHT_LINES = 200;

let highlighterPromise: Promise<Highlighter> | null = null;
/// 进程级单例：所有文档共用一个 shiki 实例（语言按需加载、双主题）
export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).catch((err) => {
    // 失败不缓存：把单例位清空，下次调用 getHighlighter() 会重新尝试创建
    highlighterPromise = null;
    throw err;
  });
  return highlighterPromise;
}

/// 语言按需加载：已加载 → 直接出装饰；shiki 认识但未加载 → 返回加载 Promise
/// （prosemirror-highlight 在 Promise 完成后重算）；不认识 / mermaid（另有节点视图）/ 无语言 → 不高亮
export function createLazyShikiParser(highlighter: Highlighter): Parser {
  const inner = createParser(highlighter, {
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: "light",
  });
  return (options) => {
    const lang = options.language?.toLowerCase();
    if (!lang || lang === "mermaid") return [];
    if (options.content.split("\n").length > MAX_HIGHLIGHT_LINES) return [];
    if (highlighter.getLoadedLanguages().includes(lang)) return inner(options);
    if (!(lang in bundledLanguages)) return [];
    return highlighter.loadLanguage(lang as BundledLanguage).then(() => undefined);
  };
}

export function highlightFeature(highlighter: Highlighter): Feature {
  const parser = createLazyShikiParser(highlighter);
  return {
    plugins: highlight,
    configure(ctx: Ctx) {
      ctx.set(highlightPluginConfig.key, {
        parser,
        nodeTypes: ["code_block"],
        languageExtractor: (node) => String(node.attrs.language ?? ""),
      });
    },
  };
}
