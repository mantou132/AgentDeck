use std::sync::Arc;

use anstream::println;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::Serialize;

mod acp_agent;
mod agent_rpc;
mod app_data;
mod awake;
mod config;
pub mod daemon;
mod logger;
mod peer;
mod push;
mod relay;
mod render_skills;
mod screen_capture;
mod tasks;
mod ui;

use agent_rpc::AgentService;
use app_data::AppPaths;
use awake::AwakeCommand;
use config::{ConfigOptions, DaemonConfig};

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

    /// Comma-separated features or groups offered to clients (e.g. `basic`), or
    /// `all` (saved for subsequent starts)
    #[arg(long, global = true, value_parser = parse_features)]
    features: Option<FeatureList>,
}

/// `--features` value; `None` is `all`.
#[derive(Clone, Debug)]
struct FeatureList(Option<Vec<String>>);

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the daemon directly in the foreground (default when no subcommand is
    /// given)
    Run,
    /// Register autostart service and start the daemon if not already running
    Start,
    /// Unregister autostart service and stop any running daemon process
    Stop,
    /// Restart the background daemon service
    Restart,
    /// Rotate the Pairing ID, clear local state and restore the previous
    /// service state
    Reset,
    /// Check daemon status and display Pairing ID
    Status {
        /// Output status as JSON
        #[arg(long)]
        json: bool,
    },
    /// Configure automatic sleep prevention, or show its current status
    #[command(arg(clap::Arg::new("pairing_id").long("pairing-id").hide(true)))]
    #[command(arg(clap::Arg::new("relay_url").long("relay-url").hide(true)))]
    #[command(arg(
        clap::Arg::new("features")
            .long("features")
            .hide(true)
            .value_parser(parse_features)
    ))]
    Awake {
        #[command(subcommand)]
        command: Option<AwakeCommand>,
    },
}

fn parse_relay_url(value: &str) -> std::result::Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "ws" | "wss") || url.host_str().is_none() {
        return Err("expected a ws:// or wss:// URL with a host".into());
    }
    Ok(value.to_owned())
}

fn parse_features(value: &str) -> std::result::Result<FeatureList, String> {
    let features: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    if features.is_empty() {
        return Err("expected feature or group names, or `all`".into());
    }
    if features.iter().any(|name| name == "all") {
        return Ok(FeatureList(None));
    }
    Ok(FeatureList(Some(features)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    version: &'static str,
    running: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    relay_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    features: Option<Vec<String>>,
    awake: AwakeStatusOutput,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AwakeStatusOutput {
    mode: awake::Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    on: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn build_status_output(
    paths: &AppPaths,
    status: daemon::Status,
    running_pid: Option<u32>,
    config: &DaemonConfig,
) -> StatusOutput {
    let running = matches!(status, daemon::Status::Running);
    let (status_str, status_reason) = match status {
        daemon::Status::Running => ("running", None),
        daemon::Status::Stopped(reason) => ("stopped", reason),
        daemon::Status::NotInstalled => ("not_installed", None),
    };
    let pid = running_pid.filter(|pid| *pid > 0);
    let relay_url = config.relay_url().to_owned();
    let pairing_id = config.pairing_id().map(str::to_owned);
    let pairing_uri = pairing_id.as_deref().map(|id| pairing_uri(id, &relay_url));
    let awake_runtime = pid.and_then(|pid| awake::read_status(paths, pid, config.awake));
    let awake = AwakeStatusOutput {
        mode: config.awake,
        on: awake_runtime.as_ref().map(|status| status.on),
        error: awake_runtime.and_then(|status| status.error),
    };

    StatusOutput {
        version: env!("CARGO_PKG_VERSION"),
        running,
        status: status_str,
        status_reason,
        pid,
        relay_url,
        pairing_id,
        pairing_uri,
        features: config.features.clone(),
        awake,
    }
}

fn print_daemon_status(paths: &AppPaths) -> Result<()> {
    let status = daemon::daemon_status()?;
    let running_pid = daemon::InstanceLock::check_running_at(&paths.lock_file())?;
    let config = DaemonConfig::load_or_init(paths, &ConfigOptions::default())?;
    print_daemon_info(&config, Some((status, running_pid)));
    Ok(())
}

fn print_daemon_status_json(paths: &AppPaths) -> Result<()> {
    let status = daemon::daemon_status()?;
    let running_pid = daemon::InstanceLock::check_running_at(&paths.lock_file())?;
    let config = DaemonConfig::read(paths)?;
    let output = build_status_output(paths, status, running_pid, &config);
    std::println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

/// The QR pairing URI; `relayUrl` is only included for a non-default relay so
/// default QR codes stay unchanged.
fn pairing_uri(relay_id: &str, relay_url: &str) -> String {
    let mut params = vec![("pairingId", relay_id)];
    if relay_url != config::DEFAULT_RELAY_URL {
        params.push(("relayUrl", relay_url));
    }
    reqwest::Url::parse_with_params("agentdeck://connect", params)
        .expect("valid pairing URI")
        .into()
}

fn print_daemon_info(config: &DaemonConfig, status: Option<(daemon::Status, Option<u32>)>) {
    println!(
        "{} {}",
        ui::cyan("AgentDeck Daemon"),
        ui::dim(format!("v{}", env!("CARGO_PKG_VERSION")))
    );
    if let Some((status, pid)) = status {
        let status_desc = match status {
            daemon::Status::Running => ui::green(format!("● {status}")),
            daemon::Status::Stopped(_) => ui::yellow(format!("○ {status}")),
            daemon::Status::NotInstalled => ui::red(format!("× {status}")),
        };
        let pid_str = if let Some(pid) = pid.filter(|pid| *pid > 0) {
            format!(" {}", ui::dim(format!("(PID: {pid})")))
        } else {
            String::new()
        };
        ui::kv("Service", format!("{status_desc}{pid_str}"));
    }
    ui::kv("Relay URL", ui::underline(config.relay_url()));
    if let Some(features) = &config.features {
        ui::kv("Features", features.join(", "));
    }
    ui::kv("Pairing ID", ui::cyan(config.relay_id()));
    println!();
    let uri = pairing_uri(config.relay_id(), config.relay_url());
    if let Err(error) = qr2term::print_qr(&uri) {
        tracing::debug!("Cannot print QR code: {error}");
        ui::kv("URI", uri);
    }
    println!();
    ui::print_security_warning();
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm =
            signal(SignalKind::terminate()).context("failed to install SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("failed to listen for Ctrl+C")?;
            }
            _ = sigterm.recv() => {}
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .context("failed to listen for Ctrl+C")
    }
}

async fn run_daemon(paths: &AppPaths, options: &ConfigOptions) -> Result<()> {
    // Ensure runtime singleton
    let _instance_lock =
        daemon::InstanceLock::acquire_at(&paths.lock_file()).context("cannot start daemon")?;
    logger::init(paths).context("cannot initialize logging")?;

    tracing::info!("Starting AgentDeck daemon v{}", env!("CARGO_PKG_VERSION"));

    let config = DaemonConfig::load_or_init(paths, options)?;
    render_skills::init_features(config.features.clone());
    let _awake_monitor = awake::Monitor::start(paths)?;
    let relay_id = config.relay_id();

    let service = Arc::new(AgentService::with_paths(paths));

    tracing::info!("Connecting to Relay");

    let tasks = service.init_tasks(paths.clone());
    let remote_manager = relay::start(paths, config.relay_url(), relay_id, &service)
        .context("failed to start Relay remote peer manager")?;
    tasks.start(remote_manager);

    print_daemon_info(&config, None);

    shutdown_signal().await?;
    println!("\n{}", ui::dim("Shutting down AgentDeck daemon..."));
    tracing::info!("Shutting down AgentDeck daemon...");
    service.shutdown().await;
    tracing::info!("AgentDeck daemon stopped");

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = AppPaths::discover()?;
    let options = ConfigOptions {
        relay_id: cli.pairing_id,
        relay_url: cli.relay_url,
        features: cli.features.map(|list| list.0),
    };

    match cli.command {
        None | Some(Commands::Run) => {
            run_daemon(&paths, &options).await?;
        }
        Some(Commands::Start) => {
            if (options.relay_id.is_some()
                || options.relay_url.is_some()
                || options.features.is_some())
                && daemon::InstanceLock::check_running()?.is_some()
            {
                anyhow::bail!(
                    "daemon is already running; use `agentdeckd restart` with these options to \
                     change its settings"
                );
            }
            let config = DaemonConfig::load_or_init(&paths, &options)?;
            daemon::start_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&config, None);
        }
        Some(Commands::Stop) => {
            daemon::stop_daemon()?;
            ui::note("AgentDeck daemon service stopped.");
        }
        Some(Commands::Restart) => {
            let config = DaemonConfig::load_or_init(&paths, &options)?;
            daemon::restart_daemon()?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            print_daemon_info(&config, None);
        }
        Some(Commands::Reset) => {
            let previous_status = daemon::reset_daemon(&paths, &options)?;
            println!("{}: {previous_status}", ui::bold("Previous service"));
            ui::success(
                "Reset complete. Cleared local connection state, logs and temporary downloads.",
            );
            println!("Pair your devices again using the Pairing ID and Relay URL below.\n");
            print_daemon_status(&paths)?;
        }
        Some(Commands::Awake { command }) => {
            awake::run_command(&paths, command).await?;
        }
        Some(Commands::Status { json }) => {
            if json {
                print_daemon_status_json(&paths)?;
            } else {
                print_daemon_status(&paths)?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_uri_includes_custom_relay_only() {
        assert_eq!(
            pairing_uri("adk1_abc", config::DEFAULT_RELAY_URL),
            "agentdeck://connect?pairingId=adk1_abc"
        );
        assert_eq!(
            pairing_uri("adk1_abc", "wss://relay.example/ws?a=1"),
            "agentdeck://connect?pairingId=adk1_abc&relayUrl=wss%3A%2F%2Frelay.example%2Fws%3Fa%\
             3D1"
        );
    }

    #[test]
    fn awake_commands_parse() {
        for command in [
            "always", "plugged", "on", "active", "never", "off", "status",
        ] {
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
        assert!(matches!(
            Cli::try_parse_from(["agentdeckd", "awake", "off"])
                .unwrap()
                .command,
            Some(Commands::Awake {
                command: Some(AwakeCommand::Never)
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
            assert!(!help.to_string().contains("--features"));
        }
    }

    #[test]
    fn awake_relay_options_are_local_and_do_not_validate_urls() {
        for (option, value) in [
            ("--pairing-id", "test-id"),
            ("--relay-url", "not-a-url"),
            ("--features", "basic"),
        ] {
            assert!(Cli::try_parse_from(["agentdeckd", "awake", option, value]).is_ok());
            for command in [
                "always", "plugged", "on", "active", "never", "off", "status",
            ] {
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
        let features = |value| Cli::try_parse_from(["agentdeckd", "--features", value, "start"]);
        assert_eq!(
            features("basic, job").unwrap().features.unwrap().0,
            Some(vec!["basic".to_string(), "job".to_string()])
        );
        assert_eq!(features("all").unwrap().features.unwrap().0, None);
        assert!(features(",").is_err());
        for url in ["https://example.com/ws", "not-a-url", "ws://"] {
            assert!(Cli::try_parse_from(["agentdeckd", "--relay-url", url]).is_err());
        }
    }

    #[test]
    fn status_json_flag_parses() {
        assert!(matches!(
            Cli::try_parse_from(["agentdeckd", "status"])
                .unwrap()
                .command,
            Some(Commands::Status { json: false })
        ));
        assert!(matches!(
            Cli::try_parse_from(["agentdeckd", "status", "--json"])
                .unwrap()
                .command,
            Some(Commands::Status { json: true })
        ));
    }

    #[test]
    fn status_output_serializes_running_and_uninitialized_states() {
        let root = std::env::temp_dir().join(format!(
            "agentdeck-status-json-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = AppPaths::new(root.clone());

        // Uninitialized config stays read-only and omits pairing fields.
        let empty_config = DaemonConfig::read(&paths).unwrap();
        let uninit = serde_json::to_value(build_status_output(
            &paths,
            daemon::Status::NotInstalled,
            None,
            &empty_config,
        ))
        .unwrap();
        assert!(!paths.config_file().exists());
        assert_eq!(uninit["running"], false);
        assert_eq!(uninit["status"], "not_installed");
        assert_eq!(uninit["relayUrl"], config::DEFAULT_RELAY_URL);
        assert_eq!(uninit["awake"], serde_json::json!({ "mode": "never" }));
        assert!(uninit.get("pid").is_none());
        assert!(uninit.get("pairingId").is_none());
        assert!(uninit.get("pairingUri").is_none());

        // Running daemon with awake runtime status and custom relay/features.
        DaemonConfig::load_or_init(
            &paths,
            &ConfigOptions {
                relay_id: Some("adk1_test".into()),
                relay_url: Some("wss://relay.example/ws".into()),
                features: Some(Some(vec!["basic".into()])),
            },
        )
        .unwrap();
        let config = DaemonConfig::set_awake(&paths, awake::Mode::Plugged).unwrap();
        let pid = 4242;
        std::fs::write(
            paths.awake_status_file(),
            serde_json::to_string(&awake::Status {
                pid,
                mode: awake::Mode::Plugged,
                on: true,
                error: None,
                updated: 1,
            })
            .unwrap(),
        )
        .unwrap();
        let running = serde_json::to_value(build_status_output(
            &paths,
            daemon::Status::Running,
            Some(pid),
            &config,
        ))
        .unwrap();
        assert_eq!(running["running"], true);
        assert_eq!(running["status"], "running");
        assert_eq!(running["pid"], pid);
        assert_eq!(running["relayUrl"], "wss://relay.example/ws");
        assert_eq!(running["pairingId"], "adk1_test");
        assert_eq!(
            running["pairingUri"],
            "agentdeck://connect?pairingId=adk1_test&relayUrl=wss%3A%2F%2Frelay.example%2Fws"
        );
        assert_eq!(running["features"], serde_json::json!(["basic"]));
        assert_eq!(
            running["awake"],
            serde_json::json!({ "mode": "plugged", "on": true })
        );

        let stopped = serde_json::to_value(build_status_output(
            &paths,
            daemon::Status::Stopped(Some("disabled".into())),
            None,
            &config,
        ))
        .unwrap();
        assert_eq!(stopped["running"], false);
        assert_eq!(stopped["status"], "stopped");
        assert_eq!(stopped["statusReason"], "disabled");

        let _ = std::fs::remove_dir_all(&root);
    }
}
