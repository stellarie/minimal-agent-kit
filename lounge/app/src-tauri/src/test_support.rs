use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub fn temp_home(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-home")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("test home");
    dir
}

pub fn sleeper() -> Child {
    Command::new("node")
        .args(["-e", "setTimeout(() => {}, 60000)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("node on PATH")
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let out = Command::new("tasklist")
        .args(["/NH", "/FO", "CSV", "/FI", &filter])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

#[cfg(not(windows))]
pub fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .expect("kill")
        .success()
}
