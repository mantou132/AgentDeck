mod power;

use std::{
    fs,
    sync::{Mutex, OnceLock, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anstream::println;
use anyhow::Result;
use clap::Subcommand;
use serde::{Deserialize, Serialize};

use crate::{
    app_data::{self, AppPaths},
    config::DaemonConfig,
    daemon, ui,
};

#[derive(Subcommand, Debug)]
pub(crate) enum AwakeCommand {
    /// Always prevent automatic sleep while the daemon runs
    Always,
    /// Prevent automatic sleep on external power
    #[command(alias = "on")]
    Plugged,
    /// Stay awake for one hour after the last RPC activity
    Active,
    /// Let the operating system sleep normally
    #[command(alias = "off")]
    Never,
    /// Show the saved mode and actual runtime state
    Status,
}

pub(crate) async fn run_command(paths: &AppPaths, command: Option<AwakeCommand>) -> Result<()> {
    let mode = match command {
        Some(AwakeCommand::Always) => Some(Mode::Always),
        Some(AwakeCommand::Plugged) => Some(Mode::Plugged),
        Some(AwakeCommand::Active) => Some(Mode::Active),
        Some(AwakeCommand::Never) => Some(Mode::Never),
        None | Some(AwakeCommand::Status) => None,
    };
    let config = match mode {
        Some(mode) => DaemonConfig::set_awake(paths, mode)?,
        None => DaemonConfig::read(paths)?,
    };
    let Some(pid) = daemon::InstanceLock::check_running_at(&paths.lock_file())? else {
        ui::kv("Keep awake", config.awake);
        println!(
            "{}",
            ui::dim("Daemon is not running. Setting will take effect when it starts.")
        );
        return Ok(());
    };
    for _ in 0..40 {
        if let Some(status) = read_status(paths, pid, config.awake) {
            let state = if status.on {
                ui::green("on")
            } else {
                ui::dim("off")
            };
            ui::kv("Keep awake", format!("{} ({state})", status.mode));
            if let Some(error) = status.error {
                anyhow::bail!("Keep awake unavailable: {error}");
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    ui::kv(
        "Keep awake",
        format!(
            "{} ({})",
            config.awake,
            ui::yellow("runtime status unavailable")
        ),
    );
    println!(
        "{}",
        ui::dim(
            "Setting saved. The running daemon has not confirmed it; restart it if it predates \
             awake support."
        )
    );
    Ok(())
}

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
    (status.pid == pid && status.mode == mode).then_some(status)
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
                let mut last_written: Option<(Mode, bool, Option<String>)> = None;
                loop {
                    let mut mode = Mode::Never;
                    let result = (|| -> Result<()> {
                        mode = DaemonConfig::read(&paths)?.awake;
                        let wanted = match mode {
                            Mode::Always => true,
                            Mode::Plugged => power::plugged()?,
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
                            tracing::warn!("Keep awake: {error}");
                        }
                        previous_error = error.clone();
                    }
                    let state = (mode, inhibitor.is_some(), error);
                    if last_written.as_ref() != Some(&state) {
                        let status = Status {
                            pid: std::process::id(),
                            mode: state.0,
                            on: state.1,
                            error: state.2.clone(),
                            updated: now(),
                        };
                        match app_data::write_file_atomic(
                            &paths.awake_status_file(),
                            serde_json::to_vec(&status).unwrap(),
                        ) {
                            Ok(()) => last_written = Some(state),
                            Err(error) => {
                                tracing::debug!("Cannot write keep-awake status: {error:#}");
                            }
                        }
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
                            || (mode == Mode::Plugged && power::plugged().unwrap())
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

    #[test]
    fn monitor_writes_status_only_on_change_and_cleans_up() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-awake-idle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let paths = AppPaths::new(root.clone());
        DaemonConfig::set_awake(&paths, Mode::Never).unwrap();

        let monitor = Monitor::start(&paths).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let initial = loop {
            if let Some(status) = read_status(&paths, std::process::id(), Mode::Never) {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "monitor did not write initial status"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(!initial.on);
        assert!(initial.error.is_none());
        let initial_modified = fs::metadata(paths.awake_status_file())
            .unwrap()
            .modified()
            .unwrap();

        // Wait past one monitor tick: unchanged state should not rewrite the
        // status file.
        thread::sleep(Duration::from_millis(1200));
        let later_modified = fs::metadata(paths.awake_status_file())
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(later_modified, initial_modified);

        // Status remains readable regardless of age as long as pid and mode
        // match.
        let stale = Status {
            pid: std::process::id(),
            mode: Mode::Never,
            on: false,
            error: None,
            updated: 0,
        };
        app_data::write_file_atomic(
            &paths.awake_status_file(),
            serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();
        assert!(read_status(&paths, std::process::id(), Mode::Never).is_some());
        assert!(read_status(&paths, std::process::id(), Mode::Always).is_none());
        assert!(read_status(&paths, std::process::id() + 1, Mode::Never).is_none());

        drop(monitor);
        assert!(!paths.awake_status_file().exists());
        fs::remove_dir_all(root).unwrap();
    }
}
