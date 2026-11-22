use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use planif::com::ComRuntime;
use planif::enums::TaskCreationFlags;
use planif::schedule_builder::{Action, ScheduleBuilder};

use super::{service_program, singleton::InstanceLock, status::Status};

pub const TASK_NAME: &str = "AgentDeck Daemon";

pub fn install_daemon() -> Result<()> {
    let com =
        ComRuntime::new().map_err(|e| anyhow!("failed to initialize TaskScheduler COM: {e}"))?;
    let sb = ScheduleBuilder::new(&com)
        .map_err(|e| anyhow!("failed to create TaskScheduler builder: {e}"))?;

    let exe = service_program()?;
    let exe_str = exe.to_string_lossy();

    sb.create_logon()
        .author("AgentDeck")
        .map_err(|e| anyhow!("planif author error: {e}"))?
        .description("AgentDeck local daemon for ACP agents")
        .map_err(|e| anyhow!("planif description error: {e}"))?
        .action(Action::new("agentdeckd", &exe_str, "run", ""))
        .map_err(|e| anyhow!("planif action error: {e}"))?
        .build()
        .map_err(|e| anyhow!("planif build error: {e}"))?
        .register(TASK_NAME, TaskCreationFlags::CreateOrUpdate as i32)
        .map_err(|e| anyhow!("failed to register scheduled task: {e}"))?;

    Ok(())
}

pub fn uninstall_daemon() -> Result<()> {
    let query = Command::new("schtasks")
        .args(["/query", "/tn", TASK_NAME])
        .output()
        .context("failed to execute schtasks /query")?;
    if !query.status.success() {
        return Ok(());
    }

    let output = Command::new("schtasks")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .output()
        .context("failed to execute schtasks /delete")?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!("schtasks /delete failed: {err}");
    }

    Ok(())
}

/// Register autostart service and start it immediately if not already running.
pub fn start_daemon() -> Result<()> {
    // 1. Register autostart task
    install_daemon()?;

    // 2. Check if already running
    if let Ok(Some(_)) = InstanceLock::check_running() {
        return Ok(());
    }

    // 3. Run task
    let output = Command::new("schtasks")
        .args(["/run", "/tn", TASK_NAME])
        .output()
        .context("failed to execute schtasks /run")?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!("schtasks /run failed: {err}");
    }

    Ok(())
}

/// Unregister autostart service and try to terminate the running daemon process.
pub fn stop_daemon() -> Result<()> {
    // 1. Stop scheduled task
    let _ = Command::new("schtasks")
        .args(["/end", "/tn", TASK_NAME])
        .output();

    // 2. Unregister
    let _ = uninstall_daemon();

    // 3. Try to terminate running process
    if let Ok(Some(pid)) = InstanceLock::check_running() {
        if pid > 0 {
            super::singleton::kill_process(pid);
        }
    }

    Ok(())
}

pub fn restart_daemon() -> Result<()> {
    let _ = stop_daemon();
    std::thread::sleep(std::time::Duration::from_millis(500));
    start_daemon()
}

pub fn daemon_status() -> Result<Status> {
    if let Ok(Some(_)) = InstanceLock::check_running() {
        return Ok(Status::Running);
    }

    let output = Command::new("schtasks")
        .args(["/query", "/tn", TASK_NAME, "/xml"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Ok(Status::NotInstalled),
    };

    if !output.status.success() {
        return Ok(Status::NotInstalled);
    }

    if xml_task_disabled(&output.stdout) {
        Ok(Status::Stopped(Some("disabled".into())))
    } else {
        Ok(Status::Stopped(None))
    }
}

fn decode_schtasks_xml(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.contains(&0) {
        let content = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
        let units: Vec<u16> = content
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn xml_task_disabled(bytes: &[u8]) -> bool {
    let xml = decode_schtasks_xml(bytes);
    let section = xml
        .split_once("<Settings>")
        .and_then(|(_, rest)| rest.split_once("</Settings>"))
        .map_or(xml.as_str(), |(settings, _)| settings);
    section
        .split_once("<Enabled>")
        .and_then(|(_, rest)| rest.split_once("</Enabled>"))
        .is_some_and(|(value, _)| value.trim().eq_ignore_ascii_case("false"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_enabled_state_from_utf8_and_utf16_task_xml() {
        let enabled = "<Task><Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>";
        let disabled = "<Task><Settings><Enabled>false</Enabled></Settings></Task>";
        assert!(!xml_task_disabled(enabled.as_bytes()));
        assert!(xml_task_disabled(disabled.as_bytes()));

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in disabled.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(xml_task_disabled(&utf16));
    }
}
