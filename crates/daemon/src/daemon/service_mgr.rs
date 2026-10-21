use std::ffi::OsString;

use anyhow::{Context, Result};
use service_manager::{
    RestartPolicy, ServiceInstallCtx, ServiceLabel, ServiceLevel, ServiceManager, ServiceStartCtx,
    ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
};

use super::{singleton::InstanceLock, status::Status};

pub const SERVICE_LABEL: &str = "com.agentdeck.daemon";

fn get_manager() -> Result<Box<dyn ServiceManager>> {
    let mut manager = <dyn ServiceManager>::native()
        .map_err(|e| anyhow::anyhow!("failed to get native service manager: {e}"))?;
    manager
        .set_level(ServiceLevel::User)
        .map_err(|e| anyhow::anyhow!("failed to set service level to user: {e}"))?;
    Ok(manager)
}

pub fn install_daemon() -> Result<()> {
    let manager = get_manager()?;
    let program = std::env::current_exe().context("failed to get current executable path")?;

    // Rewriting the LaunchAgent makes macOS show a new "Background Items Added" notification.
    #[cfg(target_os = "macos")]
    let contents = {
        let plist = launchd::plist(&program);
        if launchd::is_current(&plist) {
            return Ok(());
        }
        Some(plist)
    };
    #[cfg(not(target_os = "macos"))]
    let contents = None;

    manager
        .install(ServiceInstallCtx {
            label: SERVICE_LABEL
                .parse()
                .map_err(|e| anyhow::anyhow!("invalid service label: {e}"))?,
            program,
            args: vec![OsString::from("run")],
            contents,
            username: None,
            working_directory: None,
            environment: None,
            autostart: true,
            restart_policy: RestartPolicy::OnFailure {
                delay_secs: Some(3),
                max_retries: None,
                reset_after_secs: None,
            },
        })
        .map_err(|e| anyhow::anyhow!("failed to register daemon service: {e}"))?;

    Ok(())
}

pub fn uninstall_daemon() -> Result<()> {
    let manager = get_manager()?;
    let label: ServiceLabel = SERVICE_LABEL
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid service label: {e}"))?;

    let _ = manager.stop(ServiceStopCtx {
        label: label.clone(),
    });
    let _ = manager.uninstall(ServiceUninstallCtx { label });

    Ok(())
}

/// Register autostart service and start it immediately if not already running.
pub fn start_daemon() -> Result<()> {
    install_daemon()?;

    if let Ok(Some(_)) = InstanceLock::check_running() {
        return Ok(());
    }

    let manager = get_manager()?;
    let label: ServiceLabel = SERVICE_LABEL
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid service label: {e}"))?;

    let _ = manager.start(ServiceStartCtx { label });

    Ok(())
}

/// Restart through launchd when the installed service is unchanged; otherwise reinstall it.
pub fn restart_daemon() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let program = std::env::current_exe().context("failed to get current executable path")?;
        if launchd::is_current(&launchd::plist(&program)) {
            return launchd::kickstart();
        }
    }

    let _ = stop_daemon();
    std::thread::sleep(std::time::Duration::from_millis(500));
    start_daemon()
}

/// Unregister autostart service and try to terminate the running daemon process.
pub fn stop_daemon() -> Result<()> {
    let _ = uninstall_daemon();

    if let Ok(Some(pid)) = InstanceLock::check_running() {
        if pid > 0 {
            super::singleton::kill_process(pid);
        }
    }

    Ok(())
}

pub fn daemon_status() -> Result<Status> {
    if let Ok(Some(_)) = InstanceLock::check_running() {
        return Ok(Status::Running);
    }

    let manager = get_manager()?;
    let label: ServiceLabel = SERVICE_LABEL
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid service label: {e}"))?;

    match manager.status(ServiceStatusCtx { label }) {
        Ok(s) => Ok(s.into()),
        Err(_) => Ok(Status::NotInstalled),
    }
}

#[cfg(target_os = "macos")]
mod launchd {
    use std::{path::Path, process::Command};

    use anyhow::{Result, bail};

    use super::SERVICE_LABEL;

    /// `launchd.plist` keeps the layout launchd leaves after `start`, so existing installs compare equal.
    pub fn plist(program: &Path) -> String {
        let program = program
            .to_string_lossy()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        include_str!("launchd.plist")
            .trim_end()
            .replace("{label}", SERVICE_LABEL)
            .replace("{program}", &program)
    }

    fn target() -> String {
        format!("gui/{}/{SERVICE_LABEL}", unsafe { libc::getuid() })
    }

    /// The plist on disk matches and launchd has it loaded.
    pub fn is_current(expected: &str) -> bool {
        let Some(home) = dirs::home_dir() else {
            return false;
        };
        let path = home.join(format!("Library/LaunchAgents/{SERVICE_LABEL}.plist"));
        std::fs::read_to_string(path).is_ok_and(|current| current == expected)
            && Command::new("launchctl")
                .args(["print", &target()])
                .output()
                .is_ok_and(|output| output.status.success())
    }

    pub fn kickstart() -> Result<()> {
        let output = Command::new("launchctl")
            .args(["kickstart", "-k", &target()])
            .output()?;
        if !output.status.success() {
            bail!(
                "launchctl kickstart failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }
}
