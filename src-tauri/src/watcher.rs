use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum FileEventKind {
    Modified,
    Removed,
}

#[derive(Debug, Clone)]
pub struct FileEvent {
    pub path: PathBuf,
    pub kind: FileEventKind,
}

pub struct FileWatcher {
    // 仅为持有生命周期：drop 即停止监听
    _debouncer: Box<dyn std::any::Any + Send>,
}

impl FileWatcher {
    pub fn watch(
        file: &Path,
        on_event: impl Fn(FileEvent) + Send + 'static,
    ) -> Result<Self, String> {
        let target = file.to_path_buf();
        let parent = file
            .parent()
            .ok_or_else(|| "file has no parent directory".to_string())?
            .to_path_buf();
        let file_name = file
            .file_name()
            .ok_or_else(|| "file has no file name".to_string())?
            .to_os_string();

        // macOS FSEvents report canonicalized paths (e.g. `/private/var/...`
        // instead of the tempdir's `/var/...` symlink form). Canonicalize the
        // parent directory (which is guaranteed to exist) up front and derive
        // a canonical target path used only for matching incoming event
        // paths; the path reported to `on_event` stays the caller's original
        // (non-canonicalized) `file` so the public API is unaffected.
        let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        let canonical_target = canonical_parent.join(&file_name);

        let cb_target = target.clone();
        let mut debouncer = new_debouncer(
            Duration::from_millis(200),
            None,
            move |result: DebounceEventResult| {
                let Ok(events) = result else { return };
                let relevant = events
                    .iter()
                    .any(|e| e.paths.iter().any(|p| p == &canonical_target));
                if relevant {
                    let kind = if cb_target.exists() {
                        FileEventKind::Modified
                    } else {
                        FileEventKind::Removed
                    };
                    on_event(FileEvent { path: cb_target.clone(), kind });
                }
            },
        )
        .map_err(|e| e.to_string())?;

        debouncer
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;

        Ok(Self { _debouncer: Box::new(debouncer) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;

    // 文件系统事件测试对时间敏感，超时给足余量
    const RECV: Duration = Duration::from_secs(3);

    fn setup(content: &str) -> (tempfile::TempDir, PathBuf, FileWatcher, mpsc::Receiver<FileEvent>) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("doc.md");
        fs::write(&file, content).unwrap();
        let (tx, rx) = mpsc::channel();
        let w = FileWatcher::watch(&file, move |ev| {
            let _ = tx.send(ev);
        })
        .unwrap();
        // 等 watcher 就绪
        std::thread::sleep(Duration::from_millis(300));
        (dir, file, w, rx)
    }

    #[test]
    fn plain_write_emits_modified() {
        let (_d, file, _w, rx) = setup("a");
        fs::write(&file, "b").unwrap();
        let ev = rx.recv_timeout(RECV).unwrap();
        assert_eq!(ev.kind, FileEventKind::Modified);
        assert_eq!(ev.path, file);
    }

    #[test]
    fn atomic_rename_save_emits_modified() {
        // 模拟 Vim/VSCode 原子保存：写临时文件后 rename 覆盖
        let (dir, file, _w, rx) = setup("a");
        let tmp = dir.path().join("doc.md.tmp");
        fs::write(&tmp, "b").unwrap();
        fs::rename(&tmp, &file).unwrap();
        let ev = rx.recv_timeout(RECV).unwrap();
        assert_eq!(ev.kind, FileEventKind::Modified);
    }

    #[test]
    fn rapid_writes_are_debounced_to_one_event() {
        let (_d, file, _w, rx) = setup("0");
        for i in 1..=5 {
            fs::write(&file, format!("{i}")).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let _first = rx.recv_timeout(RECV).unwrap();
        // 防抖窗口内的连续写只合并出一批；紧随其后不应再有事件
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
    }

    #[test]
    fn delete_emits_removed() {
        let (_d, file, _w, rx) = setup("a");
        fs::remove_file(&file).unwrap();
        let ev = rx.recv_timeout(RECV).unwrap();
        assert_eq!(ev.kind, FileEventKind::Removed);
    }

    #[test]
    fn sibling_file_changes_are_ignored() {
        let (dir, _file, _w, rx) = setup("a");
        fs::write(dir.path().join("other.md"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(800)).is_err());
    }
}
