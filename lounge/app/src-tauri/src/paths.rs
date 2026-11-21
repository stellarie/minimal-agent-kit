use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn lounge_home() -> PathBuf {
    resolve_home(env::var_os("AGENT_LOUNGE_HOME"), &user_profile())
}

fn resolve_home(over: Option<OsString>, profile: &Path) -> PathBuf {
    match over {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => profile.join(".agent-lounge"),
    }
}

pub fn core_entry() -> PathBuf {
    let over = env::var_os("AGENT_LOUNGE_CORE_ENTRY");
    resolve_core_entry(over, env::current_exe().ok().as_deref())
}

fn resolve_core_entry(over: Option<OsString>, exe: Option<&Path>) -> PathBuf {
    if let Some(value) = over.filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }
    let beside = exe
        .and_then(Path::parent)
        .map(|dir| dir.join("core").join("src").join("main.ts"));
    match beside {
        Some(entry) if entry.is_file() => entry,
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/src/main.ts"),
    }
}

pub fn install_root(exe: &Path) -> Result<PathBuf, String> {
    let lounge = exe
        .parent()
        .filter(|dir| dir.file_name().is_some_and(|name| name == "lounge"))
        .filter(|dir| dir.join("core").join("src").join("main.ts").is_file());
    lounge
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "this is not an installed lounge".to_string())
}

fn user_profile() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::{resolve_core_entry, resolve_home};
    use crate::test_support::temp_home;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn dev_entry() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/src/main.ts")
    }

    fn install_with_core(name: &str) -> PathBuf {
        let dir = temp_home(name);
        let entry = dir.join("core").join("src");
        fs::create_dir_all(&entry).expect("core dir");
        fs::write(entry.join("main.ts"), "").expect("main.ts");
        dir
    }

    #[test]
    fn c4_1_home_env_set() {
        let profile = Path::new("C:/Users/someone");
        let home = resolve_home(Some("D:/lounge-data".into()), profile);
        assert_eq!(home, PathBuf::from("D:/lounge-data"));
    }

    #[test]
    fn c4_1_home_default() {
        let profile = Path::new("C:/Users/someone");
        let expected = profile.join(".agent-lounge");
        assert_eq!(resolve_home(None, profile), expected);
        assert_eq!(resolve_home(Some("".into()), profile), expected);
    }

    #[test]
    fn c4_1_env_set() {
        let dir = install_with_core("c4-env");
        let exe = dir.join("agent-lounge.exe");
        let over = Some("D:/elsewhere/main.ts".into());
        let entry = resolve_core_entry(over, Some(&exe));
        assert_eq!(entry, PathBuf::from("D:/elsewhere/main.ts"));
    }

    #[test]
    fn c4_1_zip_layout() {
        let dir = install_with_core("c4-zip");
        let exe = dir.join("agent-lounge.exe");
        let entry = resolve_core_entry(None, Some(&exe));
        assert_eq!(entry, dir.join("core").join("src").join("main.ts"));
    }

    #[test]
    fn c4_1_dev_layout() {
        let dir = temp_home("c4-dev");
        let exe = dir.join("agent-lounge.exe");
        assert_eq!(resolve_core_entry(None, Some(&exe)), dev_entry());
        assert_eq!(resolve_core_entry(None, None), dev_entry());
        let empty = Some("".into());
        assert_eq!(resolve_core_entry(empty, Some(&exe)), dev_entry());
    }
}
