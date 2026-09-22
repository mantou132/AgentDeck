use anyhow::{Result, bail};

use super::status::Status;

pub fn install_daemon() -> Result<()> {
    bail!("daemon service installation is not supported on this platform");
}

pub fn uninstall_daemon() -> Result<()> {
    bail!("daemon service uninstallation is not supported on this platform");
}

pub fn start_daemon() -> Result<()> {
    bail!("starting daemon service is not supported on this platform");
}

pub fn stop_daemon() -> Result<()> {
    bail!("stopping daemon service is not supported on this platform");
}

pub fn daemon_status() -> Result<Status> {
    Ok(Status::NotInstalled)
}
