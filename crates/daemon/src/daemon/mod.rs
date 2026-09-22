pub mod singleton;
pub mod status;

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

pub use platform::{daemon_status, install_daemon, start_daemon, stop_daemon, uninstall_daemon};
