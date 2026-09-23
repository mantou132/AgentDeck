use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

/// The on-disk layout. Resolving a path never creates or deletes anything.
pub(crate) struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self> {
        let root = dirs::data_local_dir()
            .context("failed to resolve the local application data directory")?
            .join("agentdeck");
        Ok(Self::new(root))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("daemon.json")
    }

    pub fn awake_status_file(&self) -> PathBuf {
        self.root.join("awake_status.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join("daemon.lock")
    }

    pub fn peers_file(&self) -> PathBuf {
        self.root.join("remote_peers_v1.json")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn log_file(&self) -> PathBuf {
        self.logs_dir().join("agentdeckd.log")
    }

    fn agents_dir(&self) -> PathBuf {
        self.root.join("agents")
    }

    pub fn agent(&self, id: &str) -> AgentPaths {
        AgentPaths::new(self.agents_dir().join(id))
    }

    /// Caller must hold the instance lock. Configuration and installed agents are preserved.
    pub fn clear_runtime_state(&self) -> Result<()> {
        remove_if_present(&self.awake_status_file(), |path| fs::remove_file(path))?;
        remove_if_present(&self.peers_file(), |path| fs::remove_file(path))?;
        remove_if_present(&self.logs_dir(), |path| fs::remove_dir_all(path))?;
        match fs::read_dir(self.agents_dir()) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    if entry.file_type()?.is_dir() {
                        let agent = AgentPaths::new(entry.path());
                        remove_if_present(&agent.install_dir(), |path| fs::remove_dir_all(path))?;
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("failed to read agent runtime directory"),
        }
        Ok(())
    }
}

/// Installed binaries and disposable download staging for one managed agent.
pub(crate) struct AgentPaths {
    root: PathBuf,
}

impl AgentPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn install_dir(&self) -> PathBuf {
        self.root.join("install")
    }

    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.root.join("versions").join(version)
    }

    pub fn manifest_file(&self) -> PathBuf {
        self.root.join("managed-binary.json")
    }
}

pub(crate) fn ensure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("failed to create directory: {}", path.display()))
}

fn remove_if_present(path: &Path, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<()> {
    match remove(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_removes_state_but_preserves_configuration_and_installed_agents() {
        let root = std::env::temp_dir().join(format!("agentdeck-reset-{}", std::process::id()));
        let preserved = [
            "daemon.json",
            "daemon.lock",
            "agents/codex/managed-binary.json",
            "agents/codex/versions/1.0/agent",
        ];
        let removed = [
            "remote_peers_v1.json",
            "logs/agentdeckd.log",
            "agents/codex/install/partial/archive.zip",
        ];
        for file in preserved.iter().chain(removed.iter()) {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "test data").unwrap();
        }
        AppPaths::new(root.clone()).clear_runtime_state().unwrap();
        AppPaths::new(root.clone()).clear_runtime_state().unwrap();
        for file in preserved {
            assert_eq!(fs::read_to_string(root.join(file)).unwrap(), "test data");
        }
        for file in removed {
            assert!(!root.join(file).exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
