use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Layout {
    #[default]
    Tabs,
    SideList,
}

#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TocSide {
    Left,
    #[default]
    Right,
}

// `default` 保证未来加字段时旧 settings.json 仍可读
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub layout: Layout,
    pub toc: bool,
    pub toc_side: TocSide,
    pub wrap_code: bool, // 代码块换行显示而非块内横滚（View → Wrap Code Lines）
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            layout: Layout::default(),
            toc: true,
            toc_side: TocSide::default(),
            wrap_code: false,
        }
    }
}

fn file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
    std::fs::read(file(config_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, settings: &Settings) {
    let _ = std::fs::create_dir_all(config_dir);
    if let Ok(json) = serde_json::to_vec(settings) {
        let _ = std::fs::write(file(config_dir), json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_from_empty_dir_is_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        assert_eq!(Settings::default().layout, Layout::Tabs);
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            layout: Layout::SideList,
            toc: true,
            toc_side: TocSide::Right,
            wrap_code: false,
        };
        save(dir.path(), &s);
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn corrupt_json_degrades_to_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "not json").unwrap();
        assert_eq!(load(dir.path()), Settings::default());
    }

    #[test]
    fn missing_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{}").unwrap();
        assert_eq!(load(dir.path()), Settings::default());
    }

    #[test]
    fn toc_defaults_to_on() {
        assert!(Settings::default().toc);
    }

    #[test]
    fn missing_toc_field_defaults_to_on() {
        // 旧版本写出的 settings.json 没有 toc 字段
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"layout":"sideList"}"#).unwrap();
        let s = load(dir.path());
        assert_eq!(s.layout, Layout::SideList);
        assert!(s.toc);
    }

    #[test]
    fn toc_off_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            layout: Layout::Tabs,
            toc: false,
            toc_side: TocSide::Right,
            wrap_code: false,
        };
        save(dir.path(), &s);
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn toc_side_defaults_to_right() {
        assert_eq!(Settings::default().toc_side, TocSide::Right);
    }

    #[test]
    fn missing_toc_side_field_defaults_to_right() {
        // 旧版本写出的 settings.json 没有 tocSide 字段
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"layout":"tabs","toc":false}"#)
            .unwrap();
        let s = load(dir.path());
        assert!(!s.toc);
        assert_eq!(s.toc_side, TocSide::Right);
    }

    #[test]
    fn toc_side_left_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            layout: Layout::Tabs,
            toc: true,
            toc_side: TocSide::Left,
            wrap_code: false,
        };
        save(dir.path(), &s);
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn wrap_code_defaults_to_off() {
        assert!(!Settings::default().wrap_code);
    }

    #[test]
    fn missing_wrap_code_field_defaults_to_off() {
        // 旧版本写出的 settings.json 没有 wrapCode 字段
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"layout":"tabs","toc":true,"tocSide":"left"}"#,
        )
        .unwrap();
        let s = load(dir.path());
        assert_eq!(s.toc_side, TocSide::Left);
        assert!(!s.wrap_code);
    }

    #[test]
    fn wrap_code_on_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings { wrap_code: true, ..Settings::default() };
        save(dir.path(), &s);
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn wrap_code_serializes_as_camel_case_for_the_frontend() {
        let s = Settings { wrap_code: true, ..Settings::default() };
        assert!(serde_json::to_string(&s).unwrap().contains(r#""wrapCode":true"#));
    }
}
