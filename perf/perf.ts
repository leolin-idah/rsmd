// perf/ 只在开发期手动跑（vite dev + /perf/perf.html），不参与构建与门禁，也不在 tsconfig.include 里
import "github-markdown-css/github-markdown.css";
import { TextSelection } from "@milkdown/prose/state";
import { createEditor } from "../src/editor/mdEditor";
import type { PmEditor } from "../src/editor/pmEditor";

// perf 页在裸 WebKit 里跑，没有 Tauri 注入：给 ipc.assetUrl 用到的 convertFileSrc 打桩，
// 否则 localImage 的 NodeView 第一次取图就抛（imports 已求值完才执行到这里，够早）
(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ??= {
  convertFileSrc: (p: string) => p,
};

const params = new URLSearchParams(location.search);
const name = params.get("doc") ?? "synthetic";
const out = document.getElementById("out")!;
const log = (s: string): void => {
  out.textContent += s + "\n";
};
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

const text = await (await fetch(`/perf/fixtures/${name}.md`)).text();
const parent = document.getElementById("editor")!;

// Task 20 复测的是全插件装配（shiki / mermaid / katex / 装饰 / 浮条），所以走 mdEditor.createEditor
// 而不是 Task 3 的裸 createPmEditor；exposeInternals 是测试与 perf 页专用后门（见 mdEditor.ts）
let internals: { pm: PmEditor } | null = null;
const t0 = performance.now();
const handle = await createEditor({
  parent,
  text,
  baseDir: "/tmp",
  onDirtyChange: () => {},
  onTitleChange: () => {},
  onHeadingsChange: () => {},
  onOpenLink: () => {},
  exposeInternals: (i) => {
    internals = i;
  },
});
handle.setMode("live");
await nextFrame();
log(`doc=${name} lines=${text.split("\n").length}`);
log(`mount: ${(performance.now() - t0).toFixed(0)} ms`);

// mount 之后仍有异步渲染：shiki 按需 loadLanguage、mermaid.render、katex 的节点视图。
// 等编辑器 DOM 连续 300ms 不再变动（上限 8s）算稳定，纯参考量，不设门槛
const settled = await new Promise<number>((resolve) => {
  const root = internals!.pm.host;
  let quiet: ReturnType<typeof setTimeout>;
  const obs = new MutationObserver(() => {
    clearTimeout(quiet);
    quiet = setTimeout(done, 300);
  });
  const cap = setTimeout(done, 8000);
  function done(): void {
    clearTimeout(cap);
    clearTimeout(quiet);
    obs.disconnect();
    resolve(performance.now() - t0);
  }
  quiet = setTimeout(done, 300);
  obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
});
log(`settled: ${settled.toFixed(0)} ms`);

const t1 = performance.now();
handle.getText();
log(`serialize: ${(performance.now() - t1).toFixed(0)} ms`);

// 按键延迟：文档中部的文本块里连续插入 20 个字符，每次测 dispatch → 下一帧
const view = internals!.pm.view();
const middle = Math.floor(view.state.doc.content.size / 2);
let at = -1;
view.state.doc.descendants((node, pos) => {
  if (at >= 0) return false;
  if (pos >= middle && node.isTextblock) {
    at = pos + 1;
    return false;
  }
  return true;
});
view.dispatch(view.state.tr.scrollIntoView().setSelection(TextSelection.near(view.state.doc.resolve(at))));
const samples: number[] = [];
for (let i = 0; i < 20; i++) {
  const s = performance.now();
  view.dispatch(view.state.tr.insertText("x", at + i));
  await nextFrame();
  samples.push(performance.now() - s);
}
samples.sort((a, b) => a - b);
log(`keystroke p50=${samples[10].toFixed(1)} ms  p95=${samples[18].toFixed(1)} ms`);
log("scroll the page now and watch for dropped frames");
