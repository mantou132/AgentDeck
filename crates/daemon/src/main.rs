use std::{fs, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

mod acp_agent;
mod agent_rpc;
mod app_data;
pub mod daemon;
mod logger;
mod peer;
mod push;
mod relay_client;
mod relay_encryption;

use agent_rpc::AgentService;

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
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the daemon directly in the foreground (default when no subcommand is given)
    Run {
        /// Custom pairing ID (adk1_... or plain UUID)
        #[arg(long)]
        relay_id: Option<String>,
    },
    /// Register autostart service and start the daemon if not already running
    Start,
    /// Unregister autostart service and stop any running daemon process
    Stop,
    /// Restart the background daemon service
    Restart,
    /// Check daemon status and display Relay ID
    Status,
}

#[derive(Serialize, Deserialize, Default)]
struct DaemonConfig {
    relay_id: Option<String>,
}

fn config_path() -> Result<PathBuf> {
    Ok(app_data::root_dir()?.join("daemon.json"))
}

fn load_or_init_config(cli_relay_id: Option<String>) -> Result<String> {
    let path = config_path()?;
    let mut config: DaemonConfig = if path.exists() {
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read daemon config at {}", path.display()))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        DaemonConfig::default()
    };

    let mut changed = false;

    if let Some(id) = cli_relay_id {
        config.relay_id = Some(id);
        changed = true;
    }

    let relay_id = match config.relay_id.take() {
        Some(id) if !id.trim().is_empty() => id,
        _ => {
            let mut bytes = [0u8; 32];
            OsRng.fill_bytes(&mut bytes);
            let id = format!("adk1_{}", URL_SAFE_NO_PAD.encode(bytes));
            config.relay_id = Some(id.clone());
            changed = true;
            id
        }
    };

    if changed {
        config.relay_id = Some(relay_id.clone());
        let content = serde_json::to_string_pretty(&config)?;
        fs::write(&path, content)
            .with_context(|| format!("failed to write daemon config to {}", path.display()))?;
    }

    Ok(relay_id)
}

fn print_daemon_info(relay_id: &str) {
    println!("=======================================================");
    println!("  AgentDeck Daemon v{}", env!("CARGO_PKG_VERSION"));
    println!("=======================================================");
    println!("  Relay URL : {}", relay_client::RELAY_URL);
    println!("  Pairing ID: {relay_id}");
    println!("-------------------------------------------------------");
    println!("  Connect your AgentDeck Mobile App or Browser Extension");
    println!("  using the Pairing ID above.");
    println!("=======================================================");
}

async fn run_daemon(cli_relay_id: Option<String>) -> Result<()> {
    // 确保运行时单例
    let _instance_lock = daemon::InstanceLock::acquire().context("cannot start daemon")?;

    logger::info(&format!(
        "Starting AgentDeck daemon v{}",
        env!("CARGO_PKG_VERSION")
    ));

    let relay_id = load_or_init_config(cli_relay_id)?;

    let service = Arc::new(AgentService::new());

    logger::info(&format!(
        "Connecting to Relay with pairing ID prefix: {}",
        &relay_id[..relay_id.len().min(10)]
    ));

    let _remote_manager = relay_client::start(&relay_id, &service)
        .context("failed to start Relay remote peer manager")?;

    print_daemon_info(&relay_id);

    tokio::signal::ctrl_c().await?;
    println!("\nShutting down AgentDeck daemon...");
    logger::info("AgentDeck daemon stopped");

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        None => {
            run_daemon(cli.relay_id).await?;
        }
        Some(Commands::Run { relay_id }) => {
            run_daemon(relay_id.or(cli.relay_id)).await?;
        }
        Some(Commands::Start) => {
            let relay_id = load_or_init_config(cli.relay_id)?;
            daemon::start_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&relay_id);
        }
        Some(Commands::Stop) => {
            daemon::stop_daemon()?;
            println!("AgentDeck daemon service stopped.");
        }
        Some(Commands::Restart) => {
            let relay_id = load_or_init_config(cli.relay_id)?;
            let _ = daemon::stop_daemon();
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            daemon::start_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&relay_id);
        }
        Some(Commands::Status) => {
            let status = daemon::daemon_status()?;
            let running_pid = daemon::InstanceLock::check_running().ok().flatten();
            let relay_id = load_or_init_config(None).unwrap_or_else(|_| "Unknown".to_string());

            println!("AgentDeck Daemon Status:");
            println!("  Service:    {status}");
            if let Some(pid) = running_pid {
                if pid > 0 {
                    println!("  PID:        {pid}");
                }
            }
            println!("  Relay ID:   {relay_id}");
        }
    }

    Ok(())
}
