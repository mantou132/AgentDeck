use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod acp_agent;
mod agent_rpc;
mod app_data;
mod config;
pub mod daemon;
mod logger;
mod peer;
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
    relay_id: Option<String>,

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
    println!("Relay URL: {}", config.relay_url());
    println!();
    println!("{}", pairing_notice(config.relay_id()));
}

fn pairing_notice(relay_id: &str) -> String {
    let pairing = format!("Pairing ID: {relay_id}");
    let lines = [
        "⚠️  KEEP THIS SECRET: Anyone with this Pairing ID can access your agent.",
        "Do not share this ID in screenshots, chats, or issue reports.",
        "",
        &pairing,
        "",
        "Paste into AgentDeck Settings to pair your device.",
    ];
    let width = lines.iter().map(|line| line.chars().count()).max().unwrap();
    let border = "═".repeat(width + 2);
    let mut output = format!("╔{border}╗\n");
    for line in lines {
        let padding = " ".repeat(width - line.chars().count());
        output.push_str(&format!("║ {line}{padding} ║\n"));
    }
    output.push_str(&format!("╚{border}╝"));
    output
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
        relay_id: cli.relay_id,
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
    fn relay_options_are_global() {
        for command in ["run", "start", "restart", "status", "stop", "reset"] {
            for args in [
                vec![
                    "agentdeckd",
                    "--relay-url",
                    "ws://localhost:8080/ws",
                    "--relay-id",
                    "test-id",
                    command,
                ],
                vec![
                    "agentdeckd",
                    command,
                    "--relay-url",
                    "ws://localhost:8080/ws",
                    "--relay-id",
                    "test-id",
                ],
            ] {
                let cli = Cli::try_parse_from(args).unwrap();
                assert_eq!(cli.relay_url.as_deref(), Some("ws://localhost:8080/ws"));
                assert_eq!(cli.relay_id.as_deref(), Some("test-id"));
            }
        }
        for url in ["https://example.com/ws", "not-a-url", "ws://"] {
            assert!(Cli::try_parse_from(["agentdeckd", "--relay-url", url]).is_err());
        }
    }
}
