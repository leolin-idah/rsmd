//! Markdown 侧只剩一件事：取首个 H1 作为文档标题。渲染在前端（Milkdown）完成。

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena, Options};

fn options() -> Options<'static> {
    let mut o = Options::default();
    // 与前端 remark 的识别范围对齐：front matter 不算标题；其余扩展不影响标题提取但保持解析一致
    o.extension.front_matter_delimiter = Some("---".into());
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.math_dollars = true;
    o
}

/// 按 ProseMirror `textContent` 的语义逐层收集行内纯文本（三处标题 / slug 来源同一套规则：
/// 这里、前端 `slug.ts` 的 stripInline、PM 的 headingsOf）：
/// - Text 与 Code（行内代码）取字面量；
/// - Image 整棵子树跳过——PM 的 image 是原子节点，alt 不进 textContent；
/// - Math（`$x$` / `$$x$$`）跳过——我们的 math_inline 同样是没有文本内容的原子节点；
/// - SoftBreak / LineBreak 都算一个空格，多行 setext 标题因此不会粘成一个词；
/// - 其余行内容器（Emph / Strong / Link / Strikethrough / Escaped…）继续下钻，
///   HtmlInline / FootnoteReference 这类没有 Text 子节点的自然贡献空串。
fn collect_text<'a>(node: &'a comrak::nodes::AstNode<'a>, out: &mut String) {
    for child in node.children() {
        // 先在 match 里取完字面量、只留一个"要不要下钻"的判断，递归时不再持着这个节点的 RefCell
        let recurse = match &child.data.borrow().value {
            NodeValue::Text(t) => {
                out.push_str(t);
                false
            }
            NodeValue::Code(c) => {
                out.push_str(&c.literal);
                false
            }
            NodeValue::SoftBreak | NodeValue::LineBreak => {
                out.push(' ');
                false
            }
            NodeValue::Image(_) | NodeValue::Math(_) => false,
            _ => true,
        };
        if recurse {
            collect_text(child, out);
        }
    }
}

/// 首个一级标题的纯文本（行内标记剥掉、连续空白压成一个空格、首尾空白去掉）；没有则 None。
pub fn first_heading(markdown: &str) -> Option<String> {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options());
    for node in root.descendants() {
        let is_h1 = matches!(&node.data.borrow().value, NodeValue::Heading(h) if h.level == 1);
        if !is_h1 {
            continue;
        }
        let mut text = String::new();
        collect_text(node, &mut text);
        // 换行已经在 collect_text 里变成空格；跳过的原子节点（图片 / 公式）会在两侧留下双空格，一并压掉
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        // 纯图片 / 纯公式的 H1 收集下来是空串：不算标题，继续往下找下一个 H1
        // （与 PM 的 headingsOf 跳过空标题、前端 firstH1FromText 一致；全空则 None，由调用方回退文件名）
        if text.is_empty() {
            continue;
        }
        return Some(text);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_first_h1_text_without_inline_markup() {
        assert_eq!(first_heading("intro\n\n# Hello **World** `x` [y](z)\n\n# Second"), Some("Hello World x y".into()));
    }

    #[test]
    fn recognizes_setext_h1() {
        assert_eq!(first_heading("Title\n=====\n\nbody"), Some("Title".into()));
    }

    #[test]
    fn joins_a_multiline_setext_h1_with_a_space() {
        assert_eq!(first_heading("Title\nSecond Line\n=====\n\nbody"), Some("Title Second Line".into()));
    }

    #[test]
    fn follows_prosemirror_text_content_for_images_and_inline_math() {
        // PM 的 image / math_inline 都是原子节点、没有文本内容：alt 与公式源码都不进标题
        assert_eq!(first_heading("# ![alt](img.png) Caption"), Some("Caption".into()));
        assert_eq!(first_heading("# Revenue $x^2$ growth"), Some("Revenue growth".into()));
        // 行内代码的字面量照旧算文本
        assert_eq!(first_heading("# a `code` b"), Some("a code b".into()));
    }

    #[test]
    fn skips_an_empty_h1_and_takes_the_next_one() {
        assert_eq!(first_heading("# ![alt](a.png)\n\n# Real"), Some("Real".into()));
    }

    #[test]
    fn returns_none_when_every_h1_is_empty() {
        assert_eq!(first_heading("# ![alt](a.png)"), None);
    }

    #[test]
    fn ignores_lower_levels_and_front_matter() {
        assert_eq!(first_heading("## only h2"), None);
        assert_eq!(first_heading("---\ntitle: fm\n---\n\ntext"), None);
        assert_eq!(first_heading("---\ntitle: fm\n---\n\n# Real"), Some("Real".into()));
    }

    #[test]
    fn ignores_headings_inside_fenced_code() {
        assert_eq!(first_heading("```\n# not me\n```\n\n# Real\n"), Some("Real".into()));
    }
}
