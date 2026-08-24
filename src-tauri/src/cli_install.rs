use std::path::{Path, PathBuf};

/// 标记行：install 据此区分"我们装的脚本"与用户已有的同名命令，避免误覆盖。
pub const MARKER: &str = "# Installed by rsmd";

/// 把 `md` 启动脚本写入 `bin_dir`。`app_bundle` 是当前 .app 的绝对路径（dev
/// 裸二进制时为 None，脚本退化为仅按 bundle id 解析）。
pub fn install(
    bin_dir: &Path,
    app_bundle: Option<&Path>,
    bundle_id: &str,
) -> Result<PathBuf, String> {
    let target = bin_dir.join("md");
    if let Ok(existing) = std::fs::read_to_string(&target)
        && !existing.contains(MARKER)
    {
        return Err(format!(
            "{} already exists and was not installed by rsmd; remove it manually first.",
            target.display()
        ));
    }
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let app = app_bundle.map(|p| p.display().to_string()).unwrap_or_default();
    let script = format!(
        "#!/bin/sh\n{MARKER}\nAPP=\"{app}\"\nif [ -n \"$APP\" ] && [ -d \"$APP\" ]; then\n  exec open -a \"$APP\" \"$@\"\nfi\nexec open -b {bundle_id} \"$@\"\n"
    );
    std::fs::write(&target, script).map_err(|e| e.to_string())?;
    let perms = std::os::unix::fs::PermissionsExt::from_mode(0o755);
    std::fs::set_permissions(&target, perms).map_err(|e| e.to_string())?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_writes_executable_marked_script() {
        let dir = tempfile::tempdir().unwrap();
        let target = install(dir.path(), None, "com.leo.rsmd").unwrap();

        assert_eq!(target, dir.path().join("md"));
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.starts_with("#!/bin/sh"));
        assert!(content.contains(MARKER));
        assert!(content.contains("open -b com.leo.rsmd"));

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn bakes_app_path_ahead_of_bundle_id_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let app = Path::new("/Applications/rsmd.app");
        let target = install(dir.path(), Some(app), "com.leo.rsmd").unwrap();

        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("APP=\"/Applications/rsmd.app\""));
        assert!(content.contains("exec open -a \"$APP\""));
        // 烘焙路径失效时仍要能按 bundle id 回退
        assert!(content.contains("open -b com.leo.rsmd"));
    }

    #[test]
    fn creates_missing_bin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("nested").join("bin");
        let target = install(&bin, None, "com.leo.rsmd").unwrap();
        assert!(target.exists());
    }

    #[test]
    fn refuses_to_overwrite_foreign_md_command() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("md"), "#!/bin/sh\nmkdir \"$@\"\n").unwrap();

        let err = install(dir.path(), None, "com.leo.rsmd").unwrap_err();
        assert!(err.contains("not installed by rsmd"), "unexpected error: {err}");
        // 原文件必须原样保留
        let content = std::fs::read_to_string(dir.path().join("md")).unwrap();
        assert!(content.contains("mkdir"));
    }

    #[test]
    fn reinstall_over_own_script_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), None, "com.leo.rsmd").unwrap();
        let target = install(dir.path(), Some(Path::new("/new/rsmd.app")), "com.leo.rsmd").unwrap();
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(content.contains("/new/rsmd.app"));
    }
}
