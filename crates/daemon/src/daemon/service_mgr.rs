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

    manager
        .install(ServiceInstallCtx {
            label: SERVICE_LABEL
                .parse()
                .map_err(|e| anyhow::anyhow!("invalid service label: {e}"))?,
            program,
            args: vec![OsString::from("run")],
            contents: None,
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

/// 注册自启服务，并且如果未运行则立即运行
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

/// 取消自启注册，并且尝试关闭运行中的守护进程
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
