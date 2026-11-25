use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

mod reset;
pub mod singleton;
pub mod status;

pub(crate) use reset::reset_daemon;
pub use singleton::InstanceLock;
pub use status::Status;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod service_mgr;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use service_mgr as platform;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod fallback;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use fallback as platform;
pub use platform::{
    daemon_status, install_daemon, restart_daemon, start_daemon, stop_daemon, uninstall_daemon,
};

/// Executable path registered with the OS service manager. Maps versioned
/// Homebrew (`Cellar/<formula>/<version>/bin/<name>`) and Scoop
/// (`apps/<app>/<version>/<name>`) paths to their stable entry points so
/// upgrading and pruning old versions does not break autostart.
fn service_program() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("failed to get current executable path")?;
    Ok(resolve_stable_program(&exe))
}

fn resolve_stable_program(exe: &Path) -> PathBuf {
    let canonical_exe = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    for candidate in stable_candidates(exe) {
        if std::fs::canonicalize(&candidate).ok().as_deref() == Some(canonical_exe.as_path()) {
            return candidate;
        }
    }
    exe.to_path_buf()
}

fn stable_candidates(exe: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(file_name) = exe.file_name() else {
        return candidates;
    };

    // Homebrew: <prefix>/Cellar/<formula>/<version>/bin/<name> ->
    // <prefix>/bin/<name>
    if let Some(bin_dir) = exe.parent()
        && bin_dir.file_name().and_then(|n| n.to_str()) == Some("bin")
        && let Some(cellar_dir) = bin_dir
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
        && cellar_dir.file_name().and_then(|n| n.to_str()) == Some("Cellar")
        && let Some(prefix) = cellar_dir.parent()
    {
        candidates.push(prefix.join("bin").join(file_name));
    }

    // Scoop: .../apps/<app>/<version>/<name> -> .../apps/<app>/current/<name>
    if let Some(version_dir) = exe.parent()
        && version_dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| !name.eq_ignore_ascii_case("current"))
        && let Some(app_dir) = version_dir.parent()
        && let Some(apps_dir) = app_dir.parent()
        && apps_dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("apps"))
    {
        candidates.push(app_dir.join("current").join(file_name));
    }

    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn resolves_homebrew_and_scoop_stable_paths() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "agentdeck-stable-exe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // Homebrew layout: <prefix>/Cellar/agentdeckd/0.9.0/bin/agentdeckd
        let brew_prefix = root.join("homebrew");
        let brew_real = brew_prefix.join("Cellar/agentdeckd/0.9.0/bin/agentdeckd");
        std::fs::create_dir_all(brew_real.parent().unwrap()).unwrap();
        std::fs::write(&brew_real, b"bin").unwrap();
        let brew_link = brew_prefix.join("bin/agentdeckd");
        std::fs::create_dir_all(brew_link.parent().unwrap()).unwrap();
        symlink(&brew_real, &brew_link).unwrap();
        assert_eq!(resolve_stable_program(&brew_real), brew_link);

        // Scoop layout: <root>/scoop/apps/agentdeckd/0.9.0/agentdeckd.exe
        let scoop_app = root.join("scoop/apps/agentdeckd");
        let scoop_version = scoop_app.join("0.9.0");
        let scoop_real = scoop_version.join("agentdeckd.exe");
        std::fs::create_dir_all(&scoop_version).unwrap();
        std::fs::write(&scoop_real, b"bin").unwrap();
        symlink(&scoop_version, scoop_app.join("current")).unwrap();
        assert_eq!(
            resolve_stable_program(&scoop_real),
            scoop_app.join("current/agentdeckd.exe")
        );

        // Regular path stays unchanged.
        let plain = root.join("plain/agentdeckd");
        std::fs::create_dir_all(plain.parent().unwrap()).unwrap();
        std::fs::write(&plain, b"bin").unwrap();
        assert_eq!(resolve_stable_program(&plain), plain);

        let _ = std::fs::remove_dir_all(&root);
    }
}
