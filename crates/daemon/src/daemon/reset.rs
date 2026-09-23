use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use super::{InstanceLock, Status, daemon_status, start_daemon, stop_daemon};
use crate::{
    app_data::AppPaths,
    config::{DaemonConfig, RelayOptions},
};

/// Stop before clearing state, then restore the previous service state.
pub(crate) fn reset_daemon(paths: &AppPaths, options: &RelayOptions) -> Result<Status> {
    let previous_status = daemon_status()?;
    let was_running = previous_status == Status::Running;
    if was_running {
        stop_daemon()?;
    }
    let reset_result = (|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while InstanceLock::check_running_at(&paths.lock_file())?.is_some()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        reset_local_data(paths, options)
    })();

    // Restore even when cleanup fails, so a filesystem error does not disable autostart.
    if was_running {
        start_daemon()
            .context("failed to restore daemon service; run `agentdeckd start` to retry")?;
    }
    reset_result?;
    if was_running {
        let deadline = Instant::now() + Duration::from_secs(5);
        while InstanceLock::check_running_at(&paths.lock_file())?.is_none() {
            anyhow::ensure!(
                Instant::now() < deadline,
                "daemon did not restart; run `agentdeckd status` to check or `agentdeckd start` to retry"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(previous_status)
}

fn reset_local_data(paths: &AppPaths, options: &RelayOptions) -> Result<()> {
    let _lock = InstanceLock::acquire_at(&paths.lock_file())
        .context("daemon did not stop; no files were cleared")?;
    paths.clear_runtime_state()?;
    DaemonConfig::reset(paths, options)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reset_requires_exclusive_lock_and_replaces_local_state() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-reset-flow-{}", std::process::id()));
        let paths = AppPaths::new(root.clone());
        let options = RelayOptions::default();
        let original = DaemonConfig::load_or_init(&paths, &options).unwrap();
        fs::write(paths.peers_file(), "old peers").unwrap();
        let lock = InstanceLock::acquire_at(&paths.lock_file()).unwrap();
        assert!(reset_local_data(&paths, &options).is_err());
        assert_eq!(fs::read_to_string(paths.peers_file()).unwrap(), "old peers");
        assert_eq!(
            DaemonConfig::load_or_init(&paths, &options)
                .unwrap()
                .relay_id(),
            original.relay_id()
        );
        drop(lock);

        reset_local_data(&paths, &options).unwrap();
        assert!(!paths.peers_file().exists());
        assert!(paths.lock_file().exists());
        assert_ne!(
            DaemonConfig::load_or_init(&paths, &options)
                .unwrap()
                .relay_id(),
            original.relay_id()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
