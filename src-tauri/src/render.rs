use comrak::nodes::{AstNode, NodeValue};
use comrak::{format_html, parse_document, Arena, Options};
use serde::Serialize;
use std::path::Path;

/// 顶层块的类别：前端据此把整页 HTML 的顶层元素与源码行范围对位。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Node,
    /// 原生 HTML 块：comrak 原样输出、不带 data-sourcepos，只能按顺序对位
    Html,
    /// 脚注定义：comrak 挪到 AST 末尾统一渲染成 <section class="footnotes">，源码行留在原处
    Footnote,
}

/// 顶层块的源码行范围（1-based，含首尾行）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRange {
    pub from: usize,
    pub to: usize,
    pub kind: BlockKind,
}

pub struct RenderResult {
    pub html: String,
    pub blocks: Vec<BlockRange>,
    pub first_heading: Option<String>,
}

fn top_level_blocks<'a>(root: &'a AstNode<'a>) -> Vec<BlockRange> {
    root.children()
        .filter_map(|node| {
            let data = node.data.borrow();
            if data.sourcepos.start.line == 0 {
                return None; // 无位置信息的节点不产出 0 行的块
            }
            let kind = match data.value {
                NodeValue::HtmlBlock(_) => BlockKind::Html,
                NodeValue::FootnoteDefinition(_) => BlockKind::Footnote,
                _ => BlockKind::Node,
            };
            Some(BlockRange {
                from: data.sourcepos.start.line,
                to: data.sourcepos.end.line,
                kind,
            })
        })
        .collect()
}

fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.footnotes = true;
    o.extension.math_dollars = true;
    o.extension.header_ids = Some(String::new());
    o.render.sourcepos = true;
    // 允许文档内嵌 HTML，安全由 ammonia 兜底
    o.render.unsafe_ = true;
    o
}

pub fn render(markdown: &str, base_dir: &Path) -> RenderResult {
    let options = options();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);

    let mut first_heading: Option<String> = None;
    for node in root.descendants() {
        let is_h1 = matches!(
            &node.data.borrow().value,
            NodeValue::Heading(h) if h.level == 1
        );
        if is_h1 && first_heading.is_none() {
            let mut text = String::new();
            for d in node.descendants().skip(1) {
                if let NodeValue::Text(t) = &d.data.borrow().value {
                    text.push_str(t);
                }
            }
            first_heading = Some(text.trim().to_string());
        }
        if let NodeValue::Image(link) = &mut node.data.borrow_mut().value {
            let url = &link.url;
            if !url.starts_with('/') && !url.contains("://") {
                link.url = base_dir.join(url.as_str()).to_string_lossy().into_owned();
            }
        }
    }
    let blocks = top_level_blocks(root);

    let mut out = Vec::new();
    format_html(root, &options, &mut out).expect("write to Vec cannot fail");
    let raw_html = String::from_utf8(out).expect("comrak emits UTF-8");

    let html = ammonia::Builder::default()
        .add_generic_attribute_prefixes(&["data-"])
        .add_tags(["input"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("code", ["class"])
        .add_tag_attributes("a", ["id", "class"])
        // 脚注 <section class="footnotes"> 与 <li id="fn-…">：前端按 section 提取文末 trailer，id 供脚注往返链接
        .add_tags(["section"])
        .add_tag_attributes("section", ["class"])
        .add_tag_attributes("li", ["id"])
        .url_relative(ammonia::UrlRelative::PassThrough)
        .clean(&raw_html)
        .to_string();

    RenderResult { html, blocks, first_heading }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn html(md: &str) -> String {
        render(md, Path::new("/docs")).html
    }

    #[test]
    fn renders_gfm_table() {
        assert!(html("| a | b |\n|---|---|\n| 1 | 2 |").contains("<table"));
    }

    #[test]
    fn renders_tasklist_checkbox() {
        // ammonia 默认剥 <input>，必须显式放行，此测试守住这一点
        assert!(html("- [x] done").contains("type=\"checkbox\""));
    }

    #[test]
    fn renders_strikethrough() {
        // sourcepos 开启后 <del> 会带 data-sourcepos 属性，不再是精确的 "<del>"
        assert!(html("~~gone~~").contains("<del"));
    }

    #[test]
    fn renders_footnote() {
        assert!(html("hi[^1]\n\n[^1]: note").contains("footnote"));
    }

    #[test]
    fn renders_math_span() {
        assert!(html("$x^2$").contains("data-math-style=\"inline\""));
    }

    #[test]
    fn emits_sourcepos() {
        assert!(html("# hi\n\npara").contains("data-sourcepos"));
    }

    #[test]
    fn heading_gets_anchor_id() {
        assert!(html("# Hello World").contains("hello-world"));
    }

    #[test]
    fn strips_script_keeps_plain_html() {
        let out = html("<script>alert(1)</script>\n\n<div>ok</div>");
        assert!(!out.contains("<script"));
        assert!(out.contains("<div>"));
    }

    #[test]
    fn code_block_keeps_language_class() {
        assert!(html("```rust\nfn main() {}\n```").contains("language-rust"));
    }

    #[test]
    fn rewrites_relative_image_src() {
        assert!(html("![](img.png)").contains("src=\"/docs/img.png\""));
    }

    #[test]
    fn keeps_absolute_and_remote_image_src() {
        assert!(html("![](/abs/a.png)").contains("src=\"/abs/a.png\""));
        assert!(html("![](https://x.com/a.png)").contains("https://x.com/a.png"));
    }

    #[test]
    fn extracts_first_h1_as_heading() {
        let r = render("intro\n\n# My Title\n\n# Second", Path::new("/d"));
        assert_eq!(r.first_heading.as_deref(), Some("My Title"));
    }

    #[test]
    fn no_h1_means_no_heading() {
        assert!(render("## only h2", Path::new("/d")).first_heading.is_none());
    }

    #[test]
    fn blocks_cover_top_level_nodes_in_order() {
        let r = render("# T\n\npara\n\n- a\n- b\n", Path::new("/d"));
        let ranges: Vec<(usize, usize, BlockKind)> =
            r.blocks.iter().map(|b| (b.from, b.to, b.kind)).collect();
        assert_eq!(
            ranges,
            vec![(1, 1, BlockKind::Node), (3, 3, BlockKind::Node), (5, 6, BlockKind::Node)]
        );
    }

    #[test]
    fn raw_html_block_is_marked_html() {
        // HTML 块原样输出且不带 data-sourcepos，前端只能靠 kind 按顺序对位
        let r = render("<div>x</div>\n\npara", Path::new("/d"));
        assert_eq!(r.blocks[0], BlockRange { from: 1, to: 1, kind: BlockKind::Html });
        assert_eq!(r.blocks[1].from, 3);
        assert!(!r.html.contains("<div data-sourcepos"));
    }

    #[test]
    fn footnote_definitions_are_last_but_keep_source_lines() {
        // comrak 把脚注定义挪到 AST 末尾统一渲染成 <section class="footnotes">，sourcepos 仍是原始行
        let r = render("hi[^1]\n\n[^1]: note\n\ntail\n", Path::new("/d"));
        let kinds: Vec<BlockKind> = r.blocks.iter().map(|b| b.kind).collect();
        assert_eq!(kinds, vec![BlockKind::Node, BlockKind::Node, BlockKind::Footnote]);
        assert_eq!(r.blocks[2].from, 3);
        assert_eq!(r.blocks[1], BlockRange { from: 5, to: 5, kind: BlockKind::Node });
        assert!(r.html.contains("<section data-sourcepos=\"3:1-4:0\" class=\"footnotes\""));
    }

    #[test]
    fn reference_definitions_and_unused_footnotes_produce_no_block() {
        let r = render(
            "see [x][r]\n\n[r]: https://e.com\n\n[^u]: unused\n\nend",
            Path::new("/d"),
        );
        let froms: Vec<usize> = r.blocks.iter().map(|b| b.from).collect();
        assert_eq!(froms, vec![1, 7]);
    }
}
