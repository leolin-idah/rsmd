import { convertFileSrc } from "@tauri-apps/api/core";
import katex from "katex";
import mermaid from "mermaid";
import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import "katex/dist/katex.min.css";

let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

let mermaidReady = false;
function initMermaid(): void {
  if (mermaidReady) return;
  // jsdom（vitest 环境）没有 matchMedia，做特性检测；真实 WebView 始终存在。
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    theme: prefersDark ? "dark" : "default",
  });
  mermaidReady = true;
}

let mermaidSeq = 0;

function markError(el: HTMLElement, kind: string, err: unknown): void {
  el.dataset.enhanced = `${kind}-error`;
  const note = document.createElement("div");
  note.className = "enhance-error";
  note.textContent = `${kind}: ${err instanceof Error ? err.message : String(err)}`;
  el.appendChild(note);
}

async function enhanceCodeBlock(
  pre: HTMLElement,
  code: HTMLElement,
  isCurrent: () => boolean
): Promise<void> {
  const lang = /language-(\S+)/.exec(code.className)?.[1];
  if (!lang) return;
  const raw = code.textContent ?? "";
  pre.dataset.raw = raw;

  if (lang === "mermaid") {
    initMermaid();
    try {
      const { svg } = await mermaid.render(`rsmd-mermaid-${mermaidSeq++}`, raw);
      // await 之后文档可能已被替换：过期结果不许写 DOM（否则被 data-enhanced 钉死）
      if (!isCurrent()) return;
      pre.dataset.enhanced = "mermaid";
      pre.classList.add("mermaid-block");
      pre.innerHTML = svg;
    } catch (err) {
      if (!isCurrent()) return;
      markError(pre, "mermaid", err);
    }
    return;
  }

  try {
    const hl = await getHighlighter();
    if (!hl.getLoadedLanguages().includes(lang)) {
      try {
        await hl.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0]);
      } catch {
        if (!isCurrent()) return;
        pre.dataset.enhanced = "plain"; // 未知语言：按纯文本保留（spec §3）
        return;
      }
    }
    if (!isCurrent()) return;
    const html = hl.codeToHtml(raw, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    });
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const shikiPre = tmp.firstElementChild as HTMLElement;
    for (const attr of Array.from(shikiPre.attributes)) {
      if (attr.name !== "data-raw" && attr.name !== "data-enhanced") {
        pre.setAttribute(attr.name, attr.value);
      }
    }
    pre.innerHTML = shikiPre.innerHTML;
    pre.dataset.enhanced = "shiki";
    pre.dataset.raw = raw;
  } catch (err) {
    if (!isCurrent()) return;
    markError(pre, "highlight", err);
  }
}

function enhanceMathSpan(span: HTMLElement): void {
  const raw = span.textContent ?? "";
  span.dataset.raw = raw;
  try {
    katex.render(raw, span, {
      displayMode: span.dataset.mathStyle === "display",
      throwOnError: false,
    });
    span.dataset.enhanced = "katex";
  } catch (err) {
    markError(span, "katex", err);
  }
}

function enhanceImage(img: HTMLImageElement): void {
  const src = img.getAttribute("src");
  if (!src || !src.startsWith("/")) return;
  img.dataset.raw = src;
  img.setAttribute("src", convertFileSrc(src));
  img.dataset.enhanced = "img";
}

export async function enhance(
  root: HTMLElement,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const jobs: Promise<void>[] = [];

  for (const code of Array.from(
    root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')
  )) {
    const pre = code.parentElement as HTMLElement;
    if (pre.dataset.enhanced !== undefined) continue;
    jobs.push(enhanceCodeBlock(pre, code, isCurrent));
  }

  for (const span of Array.from(
    root.querySelectorAll<HTMLElement>("span[data-math-style]")
  )) {
    if (span.dataset.enhanced !== undefined) continue;
    enhanceMathSpan(span);
  }

  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    if (img.dataset.enhanced !== undefined) continue;
    enhanceImage(img);
  }

  await Promise.all(jobs);
}
