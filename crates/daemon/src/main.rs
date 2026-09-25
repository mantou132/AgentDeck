use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod acp_agent;
mod agent_rpc;
mod app_data;
mod awake;
mod config;
pub mod daemon;
mod logger;
mod peer;
mod power;
mod push;
mod relay_client;
mod relay_encryption;

use agent_rpc::AgentService;
use app_data::AppPaths;
use config::{DaemonConfig, RelayOptions};

#[derive(Parser, Debug)]
#[command(
    name = "agentdeckd",
    about = "AgentDeck local daemon for ACP agents",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Custom pairing ID (adk1_... or plain UUID)
    #[arg(long, global = true)]
    pairing_id: Option<String>,

    /// Relay WebSocket URL (saved for subsequent starts)
    #[arg(long, global = true, value_parser = parse_relay_url)]
    relay_url: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the daemon directly in the foreground (default when no subcommand is given)
    Run,
    /// Register autostart service and start the daemon if not already running
    Start,
    /// Unregister autostart service and stop any running daemon process
    Stop,
    /// Restart the background daemon service
    Restart,
    /// Rotate the Pairing ID, clear local state and restore the previous service state
    Reset,
    /// Check daemon status and display Pairing ID
    Status,
    /// Configure automatic sleep prevention, or show its current status
    #[command(arg(clap::Arg::new("pairing_id").long("pairing-id").hide(true)))]
    #[command(arg(clap::Arg::new("relay_url").long("relay-url").hide(true)))]
    Awake {
        #[command(subcommand)]
        command: Option<AwakeCommand>,
    },
}

#[derive(Subcommand, Debug)]
enum AwakeCommand {
    /// Always prevent automatic sleep while the daemon runs
    Always,
    /// Prevent automatic sleep on external power
    #[command(alias = "on")]
    Plugged,
    /// Stay awake for one hour after the last RPC activity
    Active,
    /// Let the operating system sleep normally
    Never,
    /// Show the saved mode and actual runtime state
    Status,
}

async fn awake_command(paths: &AppPaths, command: Option<AwakeCommand>) -> Result<()> {
    let mode = match command {
        Some(AwakeCommand::Always) => Some(awake::Mode::Always),
        Some(AwakeCommand::Plugged) => Some(awake::Mode::Plugged),
        Some(AwakeCommand::Active) => Some(awake::Mode::Active),
        Some(AwakeCommand::Never) => Some(awake::Mode::Never),
        None | Some(AwakeCommand::Status) => None,
    };
    let config = match mode {
        Some(mode) => DaemonConfig::set_awake(paths, mode)?,
        None => DaemonConfig::read(paths)?,
    };
    let Some(pid) = daemon::InstanceLock::check_running_at(&paths.lock_file())? else {
        println!("Keep awake: {}", config.awake);
        println!("Daemon is not running. Setting will take effect when it starts.");
        return Ok(());
    };
    for _ in 0..40 {
        if let Some(status) = awake::read_status(paths, pid, config.awake) {
            println!(
                "Keep awake: {} ({})",
                status.mode,
                if status.on { "on" } else { "off" }
            );
            if let Some(error) = status.error {
                anyhow::bail!("Keep awake unavailable: {error}");
            }
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    println!("Keep awake: {} (runtime status unavailable)", config.awake);
    println!(
        "Setting saved. The running daemon has not confirmed it; restart it if it predates awake support."
    );
    Ok(())
}

fn parse_relay_url(value: &str) -> std::result::Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
        return Err("expected a ws:// or wss:// URL with a host".into());
    }
    Ok(value.to_owned())
}

fn print_daemon_status(paths: &AppPaths) -> Result<()> {
    let status = daemon::daemon_status()?;
    let running_pid = daemon::InstanceLock::check_running_at(&paths.lock_file())?;
    let config = DaemonConfig::load_or_init(paths, &RelayOptions::default())?;
    print_daemon_info(&config, Some((status, running_pid)));
    Ok(())
}

fn print_daemon_info(config: &DaemonConfig, status: Option<(daemon::Status, Option<u32>)>) {
    println!("AgentDeck Daemon v{}", env!("CARGO_PKG_VERSION"));
    if let Some((status, pid)) = status {
        println!("Service: {status}");
        if let Some(pid) = pid.filter(|pid| *pid > 0) {
            println!("PID: {pid}");
        }
    }
    println!("Relay URL : {}", config.relay_url());
    println!("Pairing ID: {}", config.relay_id());
    println!();
    let uri = format!("agentdeck://connect?pairingId={}", config.relay_id());
    if let Err(error) = qr2term::print_qr(&uri) {
        crate::logger::log(&format!("Cannot print QR code: {error}"));
        println!("URI: {uri}");
    }
    println!();
    println!("⚠️  KEEP THIS SECRET: Anyone with this output can access your agent.");
}

async fn run_daemon(paths: &AppPaths, options: &RelayOptions) -> Result<()> {
    // 确保运行时单例
    let _instance_lock =
        daemon::InstanceLock::acquire_at(&paths.lock_file()).context("cannot start daemon")?;

    logger::info(&format!(
        "Starting AgentDeck daemon v{}",
        env!("CARGO_PKG_VERSION")
    ));

    let config = DaemonConfig::load_or_init(paths, options)?;
    let _awake_monitor = awake::Monitor::start(paths)?;
    let relay_id = config.relay_id();

    let service = Arc::new(AgentService::new());

    logger::info("Connecting to Relay");

    let _remote_manager = relay_client::start(config.relay_url(), relay_id, &service)
        .context("failed to start Relay remote peer manager")?;

    print_daemon_info(&config, None);

    tokio::signal::ctrl_c().await?;
    println!("\nShutting down AgentDeck daemon...");
    logger::info("AgentDeck daemon stopped");

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = AppPaths::discover()?;
    let options = RelayOptions {
        relay_id: cli.pairing_id,
        relay_url: cli.relay_url,
    };

    match cli.command {
        None | Some(Commands::Run) => {
            run_daemon(&paths, &options).await?;
        }
        Some(Commands::Start) => {
            if (options.relay_id.is_some() || options.relay_url.is_some())
                && daemon::InstanceLock::check_running()?.is_some()
            {
                anyhow::bail!(
                    "daemon is already running; use `agentdeckd restart` with these options to change its settings"
                );
            }
            let config = DaemonConfig::load_or_init(&paths, &options)?;
            daemon::start_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&config, None);
        }
        Some(Commands::Stop) => {
            daemon::stop_daemon()?;
            println!("AgentDeck daemon service stopped.");
        }
        Some(Commands::Restart) => {
            let config = DaemonConfig::load_or_init(&paths, &options)?;
            let _ = daemon::stop_daemon();
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            daemon::start_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&config, None);
        }
        Some(Commands::Reset) => {
            let previous_status = daemon::reset_daemon(&paths, &options)?;
            println!("Previous service: {previous_status}");
            println!(
                "Reset complete. Cleared local connection state, logs and temporary downloads."
            );
            println!("Pair your devices again using the Pairing ID and Relay URL below.");
            print_daemon_status(&paths)?;
        }
        Some(Commands::Awake { command }) => {
            awake_command(&paths, command).await?;
        }
        Some(Commands::Status) => {
            print_daemon_status(&paths)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn awake_commands_parse() {
        for command in ["always", "plugged", "on", "active", "never", "status"] {
            assert!(matches!(
                Cli::try_parse_from(["agentdeckd", "awake", command])
                    .unwrap()
                    .command,
                Some(Commands::Awake { .. })
            ));
        }
        assert!(matches!(
            Cli::try_parse_from(["agentdeckd", "awake", "on"])
                .unwrap()
                .command,
            Some(Commands::Awake {
                command: Some(AwakeCommand::Plugged)
            })
        ));
        assert!(Cli::try_parse_from(["agentdeckd", "awake"]).is_ok());
        assert!(Cli::try_parse_from(["agentdeckd", "awake", "invalid"]).is_err());
    }

    #[test]
    fn awake_hides_relay_options() {
        for args in [
            vec!["agentdeckd", "awake", "--help"],
            vec!["agentdeckd", "awake", "active", "--help"],
        ] {
            let help = Cli::try_parse_from(args).unwrap_err();
            assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
            assert!(!help.to_string().contains("--relay-url"));
            assert!(!help.to_string().contains("--pairing-id"));
        }
    }

    #[test]
    fn awake_relay_options_are_local_and_do_not_validate_urls() {
        for (option, value) in [("--pairing-id", "test-id"), ("--relay-url", "not-a-url")] {
            assert!(Cli::try_parse_from(["agentdeckd", "awake", option, value]).is_ok());
            for command in ["always", "plugged", "on", "active", "never", "status"] {
                assert!(
                    Cli::try_parse_from(["agentdeckd", "awake", option, value, command]).is_ok()
                );
                let error = Cli::try_parse_from(["agentdeckd", "awake", command, option, value])
                    .unwrap_err();
                assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
            }
        }
        assert!(Cli::try_parse_from(["agentdeckd", "--relay-url", "not-a-url", "awake"]).is_err());
    }

    #[test]
    fn relay_options_are_global() {
        for command in ["run", "start", "restart", "status", "stop", "reset"] {
            for args in [
                vec![
                    "agentdeckd",
                    "--relay-url",
                    "ws://localhost:8080/ws",
                    "--pairing-id",
                    "test-id",
                    command,
                ],
                vec![
                    "agentdeckd",
                    command,
                    "--relay-url",
                    "ws://localhost:8080/ws",
                    "--pairing-id",
                    "test-id",
                ],
            ] {
                let cli = Cli::try_parse_from(args).unwrap();
                assert_eq!(cli.relay_url.as_deref(), Some("ws://localhost:8080/ws"));
                assert_eq!(cli.pairing_id.as_deref(), Some("test-id"));
            }
        }
        for url in ["https://example.com/ws", "not-a-url", "ws://"] {
            assert!(Cli::try_parse_from(["agentdeckd", "--relay-url", url]).is_err());
        }
    }
}
