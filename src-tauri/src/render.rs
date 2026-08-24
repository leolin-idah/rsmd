use comrak::nodes::NodeValue;
use comrak::{format_html, parse_document, Arena, Options};
use std::path::Path;

pub struct RenderResult {
    pub html: String,
    pub first_heading: Option<String>,
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

    let mut out = Vec::new();
    format_html(root, &options, &mut out).expect("write to Vec cannot fail");
    let raw_html = String::from_utf8(out).expect("comrak emits UTF-8");

    let html = ammonia::Builder::default()
        .add_generic_attribute_prefixes(&["data-"])
        .add_tags(["input"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("code", ["class"])
        .add_tag_attributes("a", ["id", "class"])
        .url_relative(ammonia::UrlRelative::PassThrough)
        .clean(&raw_html)
        .to_string();

    RenderResult { html, first_heading }
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
}
