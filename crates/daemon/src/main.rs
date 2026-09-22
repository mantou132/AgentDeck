use std::{fs, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use clap::Parser;
use serde::{Deserialize, Serialize};

mod acp_agent;
mod agent_rpc;
mod app_data;
mod logger;
mod peer;
mod push;
mod relay_client;
mod relay_encryption;

use agent_rpc::AgentService;

#[derive(Parser, Debug)]
#[command(name = "agentdeckd", about = "AgentDeck local daemon for ACP agents", version)]
struct Cli {
    /// Custom pairing ID (adk1_... or plain UUID)
    #[arg(long)]
    relay_id: Option<String>,
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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    logger::info(&format!(
        "Starting AgentDeck daemon v{}",
        env!("CARGO_PKG_VERSION")
    ));

    let relay_id = load_or_init_config(cli.relay_id)?;

    let service = Arc::new(AgentService::new());

    logger::info(&format!(
        "Connecting to Relay with pairing ID prefix: {}",
        &relay_id[..relay_id.len().min(10)]
    ));

    let _remote_manager = relay_client::start(&relay_id, &service)
        .context("failed to start Relay remote peer manager")?;

    let default_url = if cfg!(debug_assertions) {
        "ws://127.0.0.1:39371/ws"
    } else {
        "wss://agent-deck.xianqiao.wang/ws"
    };
    let relay_url = default_url;

    println!("=======================================================");
    println!("  AgentDeck Daemon v{}", env!("CARGO_PKG_VERSION"));
    println!("=======================================================");
    println!("  Relay URL : {relay_url}");
    println!("  Pairing ID: {relay_id}");
    println!("-------------------------------------------------------");
    println!("  Connect your AgentDeck Mobile App or Browser Extension");
    println!("  using the Pairing ID above.");
    println!("=======================================================");

    tokio::signal::ctrl_c().await?;
    println!("\nShutting down AgentDeck daemon...");
    logger::info("AgentDeck daemon stopped");

    Ok(())
}
