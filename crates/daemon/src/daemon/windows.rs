use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use planif::com::ComRuntime;
use planif::enums::TaskCreationFlags;
use planif::schedule_builder::{Action, ScheduleBuilder};

use super::{singleton::InstanceLock, status::Status};

pub const TASK_NAME: &str = "AgentDeck Daemon";

pub fn install_daemon() -> Result<()> {
    let com =
        ComRuntime::new().map_err(|e| anyhow!("failed to initialize TaskScheduler COM: {e}"))?;
    let sb = ScheduleBuilder::new(&com)
        .map_err(|e| anyhow!("failed to create TaskScheduler builder: {e}"))?;

    let exe = std::env::current_exe().context("failed to get current executable path")?;
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
    let output = Command::new("schtasks")
        .args(["/delete", "/tn", TASK_NAME, "/f"])
        .output()
        .context("failed to execute schtasks /delete")?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        if !err.contains("cannot find") && !err.contains("could not find") {
            bail!("schtasks /delete failed: {err}");
        }
    }

    Ok(())
}

/// 注册自启服务，并且如果未运行则立即运行
pub fn start_daemon() -> Result<()> {
    // 1. 注册自启任务
    install_daemon()?;

    // 2. 检查是否已经在运行
    if let Ok(Some(_)) = InstanceLock::check_running() {
        return Ok(());
    }

    // 3. 运行任务
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

/// 取消自启注册，并且尝试关闭运行中的守护进程
pub fn stop_daemon() -> Result<()> {
    // 1. 停止计划任务
    let _ = Command::new("schtasks")
        .args(["/end", "/tn", TASK_NAME])
        .output();

    // 2. 取消注册
    let _ = uninstall_daemon();

    // 3. 尝试关闭运行中的进程
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

    let output = Command::new("schtasks")
        .args(["/query", "/tn", TASK_NAME, "/fo", "csv", "/nh"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Ok(Status::NotInstalled),
    };

    if !output.status.success() {
        return Ok(Status::NotInstalled);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("Running") {
        Ok(Status::Running)
    } else if stdout.contains("Ready") {
        Ok(Status::Stopped(None))
    } else if stdout.contains("Disabled") {
        Ok(Status::Stopped(Some("disabled".into())))
    } else {
        Ok(Status::Stopped(None))
    }
}
