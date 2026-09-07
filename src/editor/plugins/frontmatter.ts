import remarkFrontmatter from "remark-frontmatter";
import { $nodeSchema, $remark } from "@milkdown/utils";
import type { Feature } from "../pmEditor";

type MdLiteral = { value?: string };

/// remark-frontmatter 默认只认文首的 `---` YAML 块，文中的 `---` 仍是分隔线。
/// $remark 不传第三个 initialOptions 时会用 `{}` 当选项喂给 remarkFrontmatter（milkdown/core 的
/// `acc.use(plug.plugin, plug.options)`，plug.options 默认 `initialOptions ?? {}`）；remark-frontmatter
/// 内部是 `options || 'yaml'`，`{}` 是真值会盖掉默认值，喂给 micromark-extension-frontmatter 的
/// `toMatters` 后因为空对象缺 `type` 字段直接抛 `Missing \`type\` in matter \`{}\``。显式传 "yaml" 绕开。
export const remarkFrontmatterPlugin = $remark("rsmdRemarkFrontmatter", () => remarkFrontmatter, "yaml");

/// 文首 front matter：弱化的等宽源码块，可编辑；回环时原样写回（设计 §6.2）
export const frontmatterSchema = $nodeSchema("frontmatter", () => ({
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [{ tag: 'pre[data-type="frontmatter"]', preserveWhitespace: "full" }],
  toDOM: () => ["pre", { "data-type": "frontmatter", class: "rsmd-frontmatter" }, ["code", 0]],
  parseMarkdown: {
    match: (node) => node.type === "yaml",
    runner: (state, node, type) => {
      state.openNode(type);
      const value = String((node as MdLiteral).value ?? "");
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "frontmatter",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.textContent);
    },
  },
}));

export const frontmatterFeature: Feature = { plugins: [remarkFrontmatterPlugin, frontmatterSchema].flat() };
