use anyhow::Result;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{EnvFilter, fmt::time::ChronoLocal};

use crate::app_data::{self, AppPaths};

/// Daily log files kept in `logs/`; older ones are deleted on rotation.
const MAX_LOG_FILES: usize = 7;

/// Writes daemon and dependency `tracing` events to daily rolling files.
/// The level defaults to `info` and can be overridden with `RUST_LOG`.
pub fn init(paths: &AppPaths) -> Result<()> {
    let dir = paths.logs_dir();
    app_data::ensure_dir(&dir)?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("agentdeckd")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_timer(ChronoLocal::new("%Y-%m-%d %H:%M:%S".into()))
        .with_ansi(false)
        .with_writer(appender)
        .init();
    Ok(())
}
