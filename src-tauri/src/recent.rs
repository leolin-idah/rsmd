use std::path::{Path, PathBuf};

pub const MAX_RECENT: usize = 10;

fn file(config_dir: &Path) -> PathBuf {
    config_dir.join("recent.json")
}

pub fn load(config_dir: &Path) -> Vec<PathBuf> {
    std::fs::read(file(config_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn add(config_dir: &Path, path: &Path) -> Vec<PathBuf> {
    let mut list = load(config_dir);
    list.retain(|p| p != path);
    list.insert(0, path.to_path_buf());
    list.truncate(MAX_RECENT);
    let _ = std::fs::create_dir_all(config_dir);
    if let Ok(json) = serde_json::to_vec(&list) {
        let _ = std::fs::write(file(config_dir), json);
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_from_empty_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).is_empty());
    }

    #[test]
    fn add_persists_and_loads() {
        let dir = tempfile::tempdir().unwrap();
        add(dir.path(), Path::new("/a.md"));
        add(dir.path(), Path::new("/b.md"));
        assert_eq!(load(dir.path()), vec![PathBuf::from("/b.md"), PathBuf::from("/a.md")]);
    }

    #[test]
    fn re_adding_moves_to_front_without_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        add(dir.path(), Path::new("/a.md"));
        add(dir.path(), Path::new("/b.md"));
        let list = add(dir.path(), Path::new("/a.md"));
        assert_eq!(list, vec![PathBuf::from("/a.md"), PathBuf::from("/b.md")]);
    }

    #[test]
    fn list_is_capped_at_max() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..15 {
            add(dir.path(), Path::new(&format!("/f{i}.md")));
        }
        assert_eq!(load(dir.path()).len(), MAX_RECENT);
    }

    #[test]
    fn corrupt_json_degrades_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("recent.json"), "not json").unwrap();
        assert!(load(dir.path()).is_empty());
    }
}
