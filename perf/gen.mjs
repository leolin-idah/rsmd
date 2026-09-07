// 生成性能门用的合成文档：3384 行、150 标题、30 代码块（其中 5 个 mermaid）、22 张图、10 个表格
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "fixtures");
mkdirSync(out, { recursive: true });

const para = "Lorem ipsum dolor sit amet, **consectetur** adipiscing elit, sed do `eiusmod` tempor incididunt ut labore et dolore magna aliqua. 中文段落用于测试宽字符的排版与测量。";
const lines = [];
for (let s = 0; s < 150; s++) {
  lines.push(`${s % 3 === 0 ? "#" : "##"} Section ${s}`, "");
  for (let p = 0; p < 6; p++) lines.push(`${para} (${s}.${p})`, "");
  lines.push("- item one", "- item two", "  - nested", "- [ ] task", "");
  if (s % 5 === 0) {
    const mermaid = s % 30 === 0;
    lines.push(mermaid ? "```mermaid" : "```ts", ...(mermaid ? ["graph TD", `  A${s}[Start] --> B${s}[End]`] : Array.from({ length: 12 }, (_, i) => `export const v${s}_${i} = ${i} * ${s}; // line ${i}`)), "```", "");
  }
  if (s % 7 === 0) lines.push(`![picture ${s}](./missing-${s}.png)`, "");
  if (s % 15 === 0) lines.push("| Col A | Col B | Col C |", "|:------|:-----:|------:|", ...Array.from({ length: 6 }, (_, i) => `| a${i} | b${i} | c${i} |`), "");
}
writeFileSync(join(out, "synthetic.md"), lines.join("\n") + "\n");
// 第二份真实文档来自 tmp/（git 忽略），别的克隆上没有：缺了就跳过，只跑 synthetic
const plan = join(here, "..", "tmp", "plan-rsmd-editor-implementation.md");
if (existsSync(plan)) copyFileSync(plan, join(out, "plan.md"));
else console.warn(`skipped plan.md: ${plan} not found (tmp/ is git-ignored)`);
console.log(`synthetic.md: ${lines.length} lines`);
