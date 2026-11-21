use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::paths;

const MARKER: &str = "apply.json";
const NEW_DIR: &str = ".new";
const OLD_DIR: &str = ".old";
const INCOMPLETE_FLAG: &str = "rollback-incomplete";

#[derive(Debug, Deserialize)]
pub struct Marker {
    pub version: String,
    pub root: PathBuf,
}

#[derive(Debug)]
pub enum ApplyError {
    Failed(String),
    RollbackIncomplete(String),
}

impl fmt::Display for ApplyError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(text) | Self::RollbackIncomplete(text) => out.write_str(text),
        }
    }
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

type Mover<'a> = &'a mut dyn FnMut(&Path, &Path) -> io::Result<()>;

fn marker_file(home: &Path) -> PathBuf {
    home.join("updates").join(MARKER)
}

pub fn take_marker(home: &Path) -> Option<Marker> {
    let file = marker_file(home);
    let text = fs::read_to_string(&file).ok()?;
    fs::remove_file(&file).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn cleanup(home: &Path, exe: &Path) {
    let _ = fs::remove_file(marker_file(home));
    let Ok(install) = paths::install_root(exe) else {
        return;
    };
    if install.join(OLD_DIR).join(INCOMPLETE_FLAG).exists() {
        eprintln!("keeping {OLD_DIR} and {NEW_DIR}: an earlier rollback was incomplete");
        return;
    }
    for dir in [OLD_DIR, NEW_DIR] {
        let _ = fs::remove_dir_all(install.join(dir));
    }
}

pub fn apply(home: &Path, exe: &Path, marker: &Marker) -> Result<PathBuf, ApplyError> {
    if !valid_version(&marker.version) {
        return Err(ApplyError::Failed("the update version is invalid".into()));
    }
    let install = paths::install_root(exe).map_err(ApplyError::Failed)?;
    let staged = home.join("updates").join(&marker.version).join("root");
    if marker.root != staged || !staged.is_dir() {
        let text = format!("no staged update for {}", marker.version);
        return Err(ApplyError::Failed(text));
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut rename = |from: &Path, to: &Path| fs::rename(from, to);
    swap(&install, &staged, &marker.version, stamp, &mut rename)?;
    Ok(install.join("lounge").join("agent-lounge.exe"))
}

pub fn launch(exe: &Path, home: &Path) -> io::Result<()> {
    Command::new(exe).current_dir(home).spawn().map(drop)
}

fn swap(
    install: &Path,
    staged: &Path,
    version: &str,
    stamp: u64,
    rename: Mover,
) -> Result<(), ApplyError> {
    let fresh = install.join(NEW_DIR).join(version);
    let old = install.join(OLD_DIR).join(stamp.to_string());
    let failed = |text: String| ApplyError::Failed(text);
    copy_tree(staged, &fresh).map_err(|err| failed(format!("cannot copy the update: {err}")))?;
    let lounge = fresh.join("lounge");
    if !lounge.join("agent-lounge.exe").is_file() || !lounge.join("core/src/main.ts").is_file() {
        return Err(failed("the staged update is incomplete".into()));
    }
    fs::create_dir_all(&old).map_err(|err| failed(format!("cannot make {OLD_DIR}: {err}")))?;
    let mut names =
        entry_names(&fresh).map_err(|err| failed(format!("cannot list the update: {err}")))?;
    names.sort();
    let mut moved = Vec::new();
    let mut placed = Vec::new();
    for name in &names {
        let target = install.join(name);
        let step = place(&fresh, &old, &target, name, rename, &mut moved, &mut placed);
        if let Err(err) = step {
            let cause = format!("{}: {err}", name.to_string_lossy());
            let stuck = undo(install, &fresh, &old, &moved, &placed, rename);
            return Err(rollback_result(install, cause, &stuck));
        }
    }
    Ok(())
}

fn rollback_result(install: &Path, cause: String, stuck: &[String]) -> ApplyError {
    if stuck.is_empty() {
        return ApplyError::Failed(cause);
    }
    let list = stuck.join("; ");
    eprintln!("rollback incomplete, kept {OLD_DIR}: {list}");
    let flag = install.join(OLD_DIR).join(INCOMPLETE_FLAG);
    if let Err(err) = fs::write(&flag, &list) {
        eprintln!("cannot write {}: {err}", flag.display());
    }
    ApplyError::RollbackIncomplete(format!(
        "{cause}; rollback incomplete, kept {}: {list}",
        install.join(OLD_DIR).display()
    ))
}

fn place(
    fresh: &Path,
    old: &Path,
    target: &Path,
    name: &OsString,
    rename: Mover,
    moved: &mut Vec<OsString>,
    placed: &mut Vec<OsString>,
) -> io::Result<()> {
    if target.exists() {
        rename(target, &old.join(name))?;
        moved.push(name.clone());
    }
    rename(&fresh.join(name), target)?;
    placed.push(name.clone());
    Ok(())
}

fn undo(
    install: &Path,
    fresh: &Path,
    old: &Path,
    moved: &[OsString],
    placed: &[OsString],
    rename: Mover,
) -> Vec<String> {
    let mut stuck = Vec::new();
    let mut step = |from: PathBuf, to: PathBuf| {
        if let Err(err) = rename(&from, &to) {
            stuck.push(format!("{} -> {}: {err}", from.display(), to.display()));
        }
    };
    for name in placed.iter().rev() {
        step(install.join(name), fresh.join(name));
    }
    for name in moved.iter().rev() {
        step(old.join(name), install.join(name));
    }
    stuck
}

fn entry_names(dir: &Path) -> io::Result<Vec<OsString>> {
    fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect()
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = pending.pop() {
        fs::create_dir_all(&dst)?;
        for entry in fs::read_dir(&src)? {
            let entry = entry?;
            let target = dst.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                pending.push((entry.path(), target));
            } else {
                fs::copy(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply, cleanup, swap, take_marker, valid_version, Marker};
    use crate::test_support::temp_home;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    fn write(root: &Path, rel: &str, text: &str) {
        let file = root.join(rel);
        fs::create_dir_all(file.parent().expect("parent")).expect("dirs");
        fs::write(file, text).expect("write");
    }

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap_or_default()
    }

    struct Fixture {
        home: PathBuf,
        install: PathBuf,
        exe: PathBuf,
        staged: PathBuf,
    }

    fn fixture(name: &str) -> Fixture {
        let base = temp_home(name);
        let home = base.join("home");
        let install = base.join("install");
        write(&install, "lounge/agent-lounge.exe", "old");
        write(&install, "lounge/core/src/main.ts", "old");
        write(&install, "claude/a.txt", "old");
        write(&install, "keep.txt", "mine");
        let staged = home.join("updates/1.0.0/root");
        write(&staged, "lounge/agent-lounge.exe", "new");
        write(&staged, "lounge/core/src/main.ts", "new");
        write(&staged, "claude/a.txt", "new");
        write(&staged, "codex/h.md", "new");
        let exe = install.join("lounge/agent-lounge.exe");
        Fixture {
            home,
            install,
            exe,
            staged,
        }
    }

    fn marker(f: &Fixture) -> Marker {
        Marker {
            version: "1.0.0".into(),
            root: f.staged.clone(),
        }
    }

    #[test]
    fn c6_1_refuses_non_install_layout() {
        let f = fixture("c6-refuse");
        let dev_exe = f.install.join("target/release/agent-lounge.exe");
        let err = apply(&f.home, &dev_exe, &marker(&f)).expect_err("dev layout");
        assert!(err.to_string().contains("installed"), "{err}");
        assert_eq!(read(&f.install, "lounge/agent-lounge.exe"), "old");
        assert!(!f.install.join(".new").exists());
        assert!(f.staged.is_dir());
    }

    #[test]
    fn c6_1_swap_moves_staged_entries_only() {
        let f = fixture("c6-swap");
        let exe = apply(&f.home, &f.exe, &marker(&f)).expect("swap");
        assert_eq!(exe, f.install.join("lounge/agent-lounge.exe"));
        assert_eq!(read(&f.install, "lounge/agent-lounge.exe"), "new");
        assert_eq!(read(&f.install, "claude/a.txt"), "new");
        assert_eq!(read(&f.install, "codex/h.md"), "new");
        assert_eq!(read(&f.install, "keep.txt"), "mine");
        let old: Vec<_> = fs::read_dir(f.install.join(".old")).expect("old").collect();
        assert_eq!(old.len(), 1);
        let stamp = old[0].as_ref().expect("entry").path();
        assert_eq!(
            fs::read_to_string(stamp.join("lounge/agent-lounge.exe")).expect("moved"),
            "old"
        );
        assert!(!stamp.join("keep.txt").exists());
    }

    #[test]
    fn c6_1_swap_failure_rolls_back() {
        let f = fixture("c6-rollback");
        let mut calls = 0;
        let mut rename = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 4 {
                return Err(io::Error::other("locked"));
            }
            fs::rename(from, to)
        };
        let err = swap(&f.install, &f.staged, "1.0.0", 7, &mut rename).expect_err("fails");
        let err = err.to_string();
        assert!(err.contains("lounge") && err.contains("locked"), "{err}");
        assert_eq!(read(&f.install, "lounge/agent-lounge.exe"), "old");
        assert_eq!(read(&f.install, "claude/a.txt"), "old");
        assert!(!f.install.join("codex").exists());
        assert_eq!(read(&f.install, "keep.txt"), "mine");
    }

    #[test]
    fn c6_2_marker_consumed_before_swap() {
        let f = fixture("c6-marker");
        write(
            &f.home,
            "updates/apply.json",
            r#"{"version":"1.0.0","root":"x"}"#,
        );
        let taken = take_marker(&f.home).expect("marker");
        assert_eq!(taken.version, "1.0.0");
        assert!(!f.home.join("updates/apply.json").exists());
        assert!(take_marker(&f.home).is_none());
        write(&f.home, "updates/apply.json", "not json");
        assert!(take_marker(&f.home).is_none());
        assert!(!f.home.join("updates/apply.json").exists());
    }

    #[test]
    fn c6_2_marker_outside_the_staged_root_is_refused() {
        let f = fixture("c6-outside");
        let bad = Marker {
            version: "1.0.0".into(),
            root: f.home.join("elsewhere"),
        };
        assert!(apply(&f.home, &f.exe, &bad).is_err());
        assert_eq!(read(&f.install, "lounge/agent-lounge.exe"), "old");
    }

    #[test]
    fn c6_3_cleanup_removes_old_new_and_a_stale_marker() {
        let f = fixture("c6-cleanup");
        write(&f.install, ".old/1/x.txt", "x");
        write(&f.install, ".new/1.0.0/y.txt", "y");
        write(&f.home, "updates/apply.json", "{}");
        cleanup(&f.home, &f.exe);
        assert!(!f.install.join(".old").exists());
        assert!(!f.install.join(".new").exists());
        assert!(!f.home.join("updates/apply.json").exists());
        assert_eq!(read(&f.install, "keep.txt"), "mine");
    }

    #[test]
    fn c7_1_version_must_be_three_numeric_parts() {
        let bad = [
            "",
            "1",
            "1.0",
            "1.0.0.0",
            "1.0.x",
            "a.b.c",
            "1..0",
            ".1.0",
            "1.0.",
            "1.0.0-rc",
            "1.0.0\n",
            "../1.0.0",
            "1.0.0/..",
            "1.0.\u{0663}",
            " 1.0.0",
        ];
        for version in bad {
            assert!(!valid_version(version), "{version:?}");
        }
        for version in ["0.0.0", "1.0.0", "10.20.300"] {
            assert!(valid_version(version), "{version:?}");
        }
    }

    #[test]
    fn c7_1_traversal_version_is_refused_before_any_path_is_built() {
        let f = fixture("c7-traverse");
        write(&f.home, "1.0.0/root/lounge/agent-lounge.exe", "evil");
        write(&f.home, "1.0.0/root/lounge/core/src/main.ts", "evil");
        let bad = Marker {
            version: "../1.0.0".into(),
            root: f.home.join("updates/../1.0.0/root"),
        };
        let err = apply(&f.home, &f.exe, &bad).expect_err("bad version");
        assert!(err.to_string().contains("version"), "{err}");
        assert_eq!(read(&f.install, "lounge/agent-lounge.exe"), "old");
        assert!(!f.install.join(".new").exists());
        assert!(!f.install.join(".old").exists());
    }

    #[test]
    fn c7_1_bad_version_marker_is_dropped_and_apply_fails() {
        let f = fixture("c7-drop");
        write(
            &f.home,
            "updates/apply.json",
            r#"{"version":"1.0","root":"x"}"#,
        );
        let taken = take_marker(&f.home).expect("marker");
        assert!(!f.home.join("updates/apply.json").exists());
        assert!(apply(&f.home, &f.exe, &taken).is_err());
        assert!(take_marker(&f.home).is_none());
    }

    #[test]
    fn c7_2_failed_undo_reports_rollback_incomplete_and_keeps_old() {
        let f = fixture("c7-incomplete");
        let mut calls = 0;
        let mut rename = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 4 {
                return Err(io::Error::other("locked"));
            }
            if calls == 5 {
                return Err(io::Error::other("stuck"));
            }
            fs::rename(from, to)
        };
        let err = swap(&f.install, &f.staged, "1.0.0", 7, &mut rename).expect_err("fails");
        let err = err.to_string();
        assert!(err.contains("rollback incomplete"), "{err}");
        assert!(err.contains("locked") && err.contains("stuck"), "{err}");
        assert!(err.contains("codex"), "{err}");
        assert!(f.install.join(".old/rollback-incomplete").is_file());
        assert_eq!(read(&f.install, "claude/a.txt"), "old");
    }

    #[test]
    fn c7_2_clean_undo_is_a_plain_failure_without_a_flag() {
        let f = fixture("c7-clean");
        let mut calls = 0;
        let mut rename = |from: &Path, to: &Path| {
            calls += 1;
            if calls == 4 {
                return Err(io::Error::other("locked"));
            }
            fs::rename(from, to)
        };
        let err = swap(&f.install, &f.staged, "1.0.0", 7, &mut rename).expect_err("fails");
        assert!(!err.to_string().contains("rollback incomplete"), "{err}");
        assert!(!f.install.join(".old/rollback-incomplete").exists());
    }

    #[test]
    fn c7_2_cleanup_keeps_old_when_the_flag_exists() {
        let f = fixture("c7-keep");
        write(&f.install, ".old/7/x.txt", "x");
        write(&f.install, ".old/rollback-incomplete", "codex");
        write(&f.install, ".new/1.0.0/y.txt", "y");
        write(&f.home, "updates/apply.json", "{}");
        cleanup(&f.home, &f.exe);
        assert_eq!(read(&f.install, ".old/7/x.txt"), "x");
        assert!(f.install.join(".old/rollback-incomplete").is_file());
        assert!(f.install.join(".new/1.0.0/y.txt").is_file());
        assert!(!f.home.join("updates/apply.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn c6_3_cleanup_tolerates_locked_old() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        let f = fixture("c6-locked");
        write(&f.install, ".old/1/busy.exe", "x");
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(f.install.join(".old/1/busy.exe"))
            .expect("lock");
        write(&f.install, ".new/1.0.0/y.txt", "y");
        cleanup(&f.home, &f.exe);
        assert!(f.install.join(".old/1/busy.exe").exists());
        assert!(!f.install.join(".new").exists());
        drop(held);
        cleanup(&f.home, &f.exe);
        assert!(!f.install.join(".old").exists());
    }
}
