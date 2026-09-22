use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use fd_lock::RwLock;

use crate::app_data;

/// Ensures single instance of the daemon process at runtime using an advisory file lock.
pub struct InstanceLock {
    _guard: fd_lock::RwLockWriteGuard<'static, std::fs::File>,
}

impl fmt::Debug for InstanceLock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstanceLock").finish()
    }
}

impl InstanceLock {
    /// Attempt to acquire exclusive single-instance lock on the default lock file.
    /// Fails immediately if another instance of the daemon is already running.
    pub fn acquire() -> Result<Self> {
        Self::acquire_at(&lock_file_path()?)
    }

    /// Attempt to acquire exclusive single-instance lock at a specific path.
    pub fn acquire_at(lock_path: &Path) -> Result<Self> {
        if let Some(parent) = lock_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .with_context(|| format!("failed to open lock file at {}", lock_path.display()))?;

        let rwlock = Box::leak(Box::new(RwLock::new(file)));
        let mut guard = match rwlock.try_write() {
            Ok(g) => g,
            Err(_) => {
                let existing_pid = fs::read_to_string(lock_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());
                if let Some(pid) = existing_pid {
                    bail!("another instance of agentdeckd is already running (PID: {pid})");
                } else {
                    bail!("another instance of agentdeckd is already running");
                }
            }
        };

        let pid = std::process::id();
        let _ = guard.set_len(0);
        let _ = guard.seek(SeekFrom::Start(0));
        let _ = guard.write_all(format!("{pid}\n").as_bytes());
        let _ = guard.flush();

        Ok(Self { _guard: guard })
    }

    /// Check if another daemon process currently holds the lock, returning its PID if known.
    pub fn check_running() -> Result<Option<u32>> {
        Self::check_running_at(&lock_file_path()?)
    }

    /// Check if another daemon process currently holds the lock at a specific path.
    pub fn check_running_at(lock_path: &Path) -> Result<Option<u32>> {
        if !lock_path.exists() {
            return Ok(None);
        }

        let file = match OpenOptions::new().read(true).write(true).open(lock_path) {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };

        let mut rwlock = RwLock::new(file);
        match rwlock.try_write() {
            Ok(_) => {
                // Lock was successfully acquired, meaning no active daemon is holding the lock.
                Ok(None)
            }
            Err(_) => {
                // Lock is held by another process. Read the PID from the file.
                let pid = fs::read_to_string(lock_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());
                Ok(pid.or(Some(0)))
            }
        }
    }
}

/// Attempt to terminate a running daemon process by PID.
pub fn kill_process(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(unix)]
    {
        use std::process::Command;
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Ok(None) = InstanceLock::check_running() {
                return;
            }
        }
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
}

pub fn lock_file_path() -> Result<PathBuf> {
    Ok(app_data::root_dir()?.join("daemon.lock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lock_file_path() {
        let path = lock_file_path().unwrap();
        assert!(path.ends_with("daemon.lock"));
    }

    #[test]
    fn test_singleton_lock() {
        let temp_dir =
            std::env::temp_dir().join(format!("test_daemon_lock_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let lock_path = temp_dir.join("test.lock");

        // Initially nothing is running
        assert_eq!(InstanceLock::check_running_at(&lock_path).unwrap(), None);

        // First acquisition should succeed
        let lock1 = InstanceLock::acquire_at(&lock_path);
        assert!(lock1.is_ok());

        // Lock is now active, check_running should report Some(PID)
        let running = InstanceLock::check_running_at(&lock_path).unwrap();
        assert_eq!(running, Some(std::process::id()));

        // Second acquisition on the same file should fail
        let lock2 = InstanceLock::acquire_at(&lock_path);
        assert!(lock2.is_err());
        let err_msg = lock2.unwrap_err().to_string();
        assert!(err_msg.contains("another instance of agentdeckd is already running"));

        // Clean up
        let _ = fs::remove_file(lock_path);
        let _ = fs::remove_dir_all(temp_dir);
    }
}
