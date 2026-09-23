use crate::{app_data::AppPaths, config::DaemonConfig};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::{Mutex, OnceLock, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod platform;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    Always,
    Plugged,
    Active,
    #[default]
    Never,
}
impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Always => "always",
            Self::Plugged => "plugged",
            Self::Active => "active",
            Self::Never => "never",
        })
    }
}
#[derive(Default)]
struct Activity {
    last: Option<Instant>,
}
impl Activity {
    fn active(&self, now: Instant) -> bool {
        self.last
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(3600))
    }
}
fn activity() -> &'static Mutex<Activity> {
    static ACTIVITY: OnceLock<Mutex<Activity>> = OnceLock::new();
    ACTIVITY.get_or_init(Mutex::default)
}
/// Every incoming or outgoing RPC frame renews the idle deadline.
pub(crate) fn record_activity() {
    activity().lock().unwrap().last = Some(Instant::now());
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Status {
    pub pid: u32,
    pub mode: Mode,
    pub on: bool,
    pub error: Option<String>,
    pub updated: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub(crate) fn read_status(paths: &AppPaths, pid: u32, mode: Mode) -> Option<Status> {
    let status: Status = serde_json::from_slice(&fs::read(paths.awake_status_file()).ok()?).ok()?;
    (status.pid == pid && status.mode == mode && now().saturating_sub(status.updated) <= 5)
        .then_some(status)
}
pub(crate) struct Monitor {
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Monitor {
    pub fn start(paths: &AppPaths) -> Result<Self> {
        let paths = AppPaths::new(paths.root().to_owned());
        let (stop, rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                let mut inhibitor = None;
                let mut previous_error = None;
                loop {
                    let mut mode = Mode::Never;
                    let result = (|| -> Result<()> {
                        mode = DaemonConfig::read(&paths)?.awake;
                        let wanted = match mode {
                            Mode::Always => true,
                            Mode::Plugged => platform::plugged()?,
                            Mode::Active => activity().lock().unwrap().active(Instant::now()),
                            Mode::Never => false,
                        };
                        if wanted && inhibitor.is_none() {
                            inhibitor = Some(
                                keepawake::Builder::default()
                                    .idle(true)
                                    .reason("AgentDeck keep awake")
                                    .app_name("AgentDeck")
                                    .app_reverse_domain("com.agentdeck.daemon")
                                    .create()?,
                            );
                        }
                        if !wanted {
                            inhibitor = None;
                        }
                        Ok(())
                    })();
                    let error = result.err().map(|e| format!("{e:#}"));
                    if error.is_some() {
                        inhibitor = None;
                    }
                    if error != previous_error {
                        if let Some(error) = &error {
                            crate::logger::log(&format!("Keep awake: {error}"));
                        }
                        previous_error = error.clone();
                    }
                    let status = Status {
                        pid: std::process::id(),
                        mode,
                        on: inhibitor.is_some(),
                        error,
                        updated: now(),
                    };
                    // The CLI retries partial reads; this file is runtime information, never configuration.
                    if let Err(error) = fs::write(
                        paths.awake_status_file(),
                        serde_json::to_vec(&status).unwrap(),
                    ) {
                        crate::logger::log(&format!("Cannot write keep-awake status: {error}"));
                    }
                    if !matches!(
                        rx.recv_timeout(Duration::from_secs(1)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        break;
                    }
                }
                drop(inhibitor);
                let _ = fs::remove_file(paths.awake_status_file());
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "temporarily acquires a real system sleep assertion"]
    fn monitor_applies_changes_and_releases_assertion() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-awake-monitor-{}", std::process::id()));
        let paths = AppPaths::new(root.clone());
        DaemonConfig::set_awake(&paths, Mode::Never).unwrap();
        let monitor = Monitor::start(&paths).unwrap();
        for mode in [Mode::Never, Mode::Always, Mode::Plugged, Mode::Never] {
            DaemonConfig::set_awake(&paths, mode).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(status) = read_status(&paths, std::process::id(), mode) {
                    assert!(status.error.is_none(), "{:?}", status.error);
                    assert_eq!(
                        status.on,
                        mode == Mode::Always
                            || (mode == Mode::Plugged && platform::plugged().unwrap())
                    );
                    break;
                }
                assert!(Instant::now() < deadline, "monitor did not apply {mode}");
                thread::sleep(Duration::from_millis(50));
            }
        }
        DaemonConfig::set_awake(&paths, Mode::Always).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while read_status(&paths, std::process::id(), Mode::Always).is_none() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(50));
        }
        let assertions = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&assertions.stdout).contains("AgentDeck keep awake"));
        drop(monitor);
        assert!(!paths.awake_status_file().exists());
        let assertions = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&assertions.stdout).contains("AgentDeck keep awake"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activity_expires_one_hour_after_the_last_rpc() {
        let start = Instant::now();
        let mut state = Activity::default();
        assert!(!state.active(start));
        state.last = Some(start);
        assert!(state.active(start + Duration::from_secs(3599)));
        assert!(!state.active(start + Duration::from_secs(3600)));
        state.last = Some(start + Duration::from_secs(3600));
        assert!(state.active(start + Duration::from_secs(7199)));
        assert!(!state.active(start + Duration::from_secs(7200)));
    }
}
