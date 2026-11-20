use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;

use crate::job::Job;
use crate::tray;
use crate::{health, paths, token};

const DEFAULT_PORT: u16 = 47621;
const POLL_EVERY: Duration = Duration::from_secs(2);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const FAILED_POLLS_BEFORE_RESTART: u32 = 3;
const HEALTHY_MINUTE: Duration = Duration::from_secs(60);
const START_GRACE: Duration = Duration::from_secs(30);
const CORE_LOG: &str = "core.log";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn backoff(attempt: u32) -> Duration {
    const STEPS: [u64; 6] = [1, 2, 4, 8, 16, 30];
    Duration::from_secs(STEPS.get(attempt as usize).copied().unwrap_or(30))
}

pub fn read_port(home: &Path) -> u16 {
    let Ok(text) = fs::read_to_string(home.join("config.json")) else {
        return DEFAULT_PORT;
    };
    let Ok(config) = serde_json::from_str::<Value>(&text) else {
        return DEFAULT_PORT;
    };
    config
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn core_log(home: &Path) -> PathBuf {
    home.join(CORE_LOG)
}

pub fn in_start_grace(started_child: bool, seen_healthy: bool, waited: Duration) -> bool {
    started_child && !seen_healthy && waited < START_GRACE
}

pub fn should_restart(failures: u32, in_grace: bool) -> bool {
    !in_grace && failures >= FAILED_POLLS_BEFORE_RESTART
}

pub fn status_text(last_error: Option<&str>, log: &Path) -> String {
    let mut text = String::from("The lounge core is not ready yet.");
    if let Some(error) = last_error {
        text.push_str(&format!(" Last error: {error}."));
    }
    text.push_str(&format!(" Core log: {}", log.display()));
    text
}

pub fn lounge_url(port: u16, token: Option<&str>) -> String {
    match token {
        Some(value) => {
            let encoded = health::encode_fragment_value(value);
            format!("http://127.0.0.1:{port}/#token={encoded}")
        }
        None => format!("http://127.0.0.1:{port}/"),
    }
}

struct Slot {
    child: Option<Child>,
    owned: bool,
}

pub struct Shared {
    slot: Mutex<Slot>,
    url: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    stopped: AtomicBool,
    job: Option<Job>,
}

impl Shared {
    pub fn new() -> Arc<Self> {
        let job = Job::new()
            .map_err(|err| eprintln!("cannot create the core job: {err}"))
            .ok();
        Arc::new(Self {
            slot: Mutex::new(Slot {
                child: None,
                owned: false,
            }),
            url: Mutex::new(None),
            last_error: Mutex::new(None),
            stopped: AtomicBool::new(false),
            job,
        })
    }

    pub fn url(&self) -> Option<String> {
        self.url.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let Ok(mut slot) = self.slot.lock() else {
            return;
        };
        let owned = std::mem::replace(&mut slot.owned, false);
        let child = slot.child.take();
        drop(slot);
        if let (true, Some(child)) = (owned, child) {
            kill(child);
        }
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn owns_child(&self) -> bool {
        self.slot.lock().map(|slot| slot.owned).unwrap_or(false)
    }

    fn child_alive(&self) -> bool {
        let Ok(mut slot) = self.slot.lock() else {
            return false;
        };
        let Some(child) = slot.child.as_mut() else {
            return false;
        };
        let exit = match child.try_wait() {
            Ok(None) => return true,
            Ok(Some(status)) => format!("the core exited with {status}"),
            Err(err) => format!("cannot check the core: {err}"),
        };
        drop(slot);
        self.set_error(exit);
        false
    }

    fn adopt(&self, child: Child) {
        if let Some(job) = &self.job {
            if let Err(err) = job.assign(&child) {
                eprintln!("cannot add the core to the job: {err}");
            }
        }
        let Ok(mut slot) = self.slot.lock() else {
            kill(child);
            return;
        };
        // Checked under the lock.
        if self.stopped() {
            drop(slot);
            kill(child);
            return;
        }
        slot.child = Some(child);
        slot.owned = true;
    }

    fn stop_child(&self) {
        let Ok(mut slot) = self.slot.lock() else {
            return;
        };
        let owned = std::mem::replace(&mut slot.owned, false);
        let child = slot.child.take();
        drop(slot);
        if let (true, Some(child)) = (owned, child) {
            kill(child);
        }
    }

    fn set_url(&self, url: String) {
        if let Ok(mut slot) = self.url.lock() {
            *slot = Some(url);
        }
    }

    fn set_error(&self, error: String) {
        eprintln!("{error}");
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = Some(error);
        }
    }
}

fn kill(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub fn start(app: AppHandle, shared: Arc<Shared>) {
    thread::spawn(move || supervise(&app, &shared));
}

fn supervise(app: &AppHandle, shared: &Shared) {
    let home = paths::lounge_home();
    let entry = paths::core_entry();
    let port = read_port(&home);
    let mut attempt = 0;
    let mut announced = false;

    while !shared.stopped() {
        let mut started_child = false;
        if !healthy(&home, port) {
            match start_core(&home, &entry, shared) {
                Ok(()) => started_child = true,
                Err(err) => shared.set_error(format!("cannot start the core: {err}")),
            }
        }
        let started_at = Instant::now();
        let mut seen_healthy = false;
        let mut failures = 0;
        let mut healthy_since: Option<Instant> = None;

        loop {
            thread::sleep(POLL_EVERY);
            if shared.stopped() {
                return;
            }
            if healthy(&home, port) {
                seen_healthy = true;
                failures = 0;
                let since = *healthy_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= HEALTHY_MINUTE {
                    attempt = 0;
                }
                if !announced {
                    announced = true;
                    announce(app, &home, port, shared);
                }
            } else {
                failures += 1;
                healthy_since = None;
            }
            if shared.owns_child() && !shared.child_alive() {
                break;
            }
            let grace = in_start_grace(started_child, seen_healthy, started_at.elapsed());
            if should_restart(failures, grace) {
                if started_child && !seen_healthy {
                    let secs = START_GRACE.as_secs();
                    shared.set_error(format!("the core did not answer within {secs} s"));
                }
                break;
            }
        }

        if shared.stopped() {
            return;
        }
        shared.stop_child();
        thread::sleep(backoff(attempt));
        attempt = attempt.saturating_add(1);
    }
}

fn announce(app: &AppHandle, home: &Path, port: u16, shared: &Shared) {
    let token = token::read_owner_token(home)
        .map_err(|err| eprintln!("{err}"))
        .ok();
    let url = lounge_url(port, token.as_deref());
    shared.set_url(url.clone());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || tray::open_window(&handle, url));
}

fn start_core(home: &Path, entry: &Path, shared: &Shared) -> std::io::Result<()> {
    shared.adopt(core_command(home, entry)?.spawn()?);
    Ok(())
}

fn core_command(home: &Path, entry: &Path) -> std::io::Result<Command> {
    fs::create_dir_all(home)?;
    let log = File::create(core_log(home))?;
    let mut command = Command::new("node");
    command
        .arg(entry)
        .env("AGENT_LOUNGE_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

fn healthy(home: &Path, port: u16) -> bool {
    let Ok(token) = token::read_owner_token(home) else {
        return false;
    };
    let Some(challenge) = health::challenge() else {
        return false;
    };
    let url = format!("http://127.0.0.1:{port}/health?challenge={challenge}");
    match ureq::get(&url).timeout(HEALTH_TIMEOUT).call() {
        Ok(response) => response
            .into_string()
            .map(|body| health::proves_identity(&body, &token, &challenge))
            .unwrap_or(false),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backoff, core_log, in_start_grace, lounge_url, read_port, should_restart, status_text,
        Shared, START_GRACE,
    };
    use crate::test_support::{alive, sleeper, temp_home};
    use std::fs;
    use std::time::Duration;

    #[test]
    fn quit_before_adopt_kills_the_new_child() {
        let shared = Shared::new();
        shared.shutdown();
        let child = sleeper();
        let pid = child.id();
        shared.adopt(child);
        assert!(!shared.owns_child());
        assert!(!alive(pid), "pid {pid} outlived quit");
    }

    #[test]
    fn quit_after_adopt_kills_the_child() {
        let shared = Shared::new();
        let child = sleeper();
        let pid = child.id();
        shared.adopt(child);
        assert!(shared.owns_child());
        assert!(alive(pid));
        shared.shutdown();
        assert!(!shared.owns_child());
        assert!(!alive(pid), "pid {pid} outlived quit");
    }

    #[test]
    fn a_fresh_child_gets_a_start_grace() {
        let early = Duration::from_secs(6);
        assert!(in_start_grace(true, false, early));
        assert!(!should_restart(3, in_start_grace(true, false, early)));
        assert!(should_restart(3, in_start_grace(true, false, START_GRACE)));
    }

    #[test]
    fn the_grace_ends_at_the_first_healthy_poll() {
        assert!(!in_start_grace(true, true, Duration::from_secs(6)));
        assert!(should_restart(3, false));
        assert!(!should_restart(2, false));
    }

    #[test]
    fn an_attached_core_gets_no_grace() {
        assert!(!in_start_grace(false, false, Duration::ZERO));
    }

    #[test]
    fn status_names_the_error_and_the_log() {
        let log = core_log(&temp_home("status"));
        let text = status_text(Some("cannot start the core: not found"), &log);
        assert!(text.contains("not found"), "{text}");
        assert!(text.contains("core.log"), "{text}");
        assert!(!status_text(None, &log).contains("Last error"));
    }

    #[test]
    fn the_token_is_percent_encoded_in_the_url() {
        assert_eq!(
            lounge_url(47621, Some("a+b&c")),
            "http://127.0.0.1:47621/#token=a%2Bb%26c"
        );
        assert_eq!(lounge_url(47621, None), "http://127.0.0.1:47621/");
    }

    #[test]
    fn backoff_steps_up_and_caps() {
        let steps: Vec<u64> = (0..8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(steps, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(u32::MAX), Duration::from_secs(30));
    }

    #[test]
    fn port_defaults_without_a_config() {
        assert_eq!(read_port(&temp_home("port-default")), 47621);
    }

    #[test]
    fn port_comes_from_the_config() {
        let home = temp_home("port-set");
        fs::write(home.join("config.json"), r#"{"port":51000}"#).expect("write");
        assert_eq!(read_port(&home), 51000);
    }

    #[test]
    fn a_junk_port_falls_back_to_the_default() {
        let home = temp_home("port-junk");
        fs::write(home.join("config.json"), r#"{"port":70000000}"#).expect("write");
        assert_eq!(read_port(&home), 47621);
    }
}
