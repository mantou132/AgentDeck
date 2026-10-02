use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::{app_data::AppPaths, logger};

pub(super) const REGISTRY_JSON: &str = include_str!("registry.json");
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

#[derive(Clone, Debug)]
pub(super) enum AgentLaunch {
    Binary {
        version: String,
        target: RegistryBinaryTarget,
    },
    Npx {
        package: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Uvx {
        package: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
}

/// A supported agent, its user CLI, and how to launch or provision ACP.
#[derive(Clone, Debug)]
pub(super) struct AgentCandidate {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) cli: Option<String>,
    pub(super) launch: AgentLaunch,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct Registry {
    pub(super) version: String,
    pub(super) agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryAgent {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) description: Option<String>,
    pub(super) icon: Option<String>,
    pub(super) distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryDistribution {
    pub(super) binary: Option<HashMap<String, RegistryBinaryTarget>>,
    pub(super) npx: Option<RegistryNpxTarget>,
    pub(super) uvx: Option<RegistryUvxTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryBinaryTarget {
    pub(super) archive: String,
    pub(super) cmd: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
    pub(super) sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryNpxTarget {
    pub(super) package: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryUvxTarget {
    pub(super) package: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
}

/// The registry in use; only replaced by a newer fetch, never by an older copy.
static REGISTRY: Mutex<Option<Arc<Registry>>> = Mutex::new(None);
static REGISTRY_REFRESHING: AtomicBool = AtomicBool::new(false);

pub(super) fn bundled_registry() -> Registry {
    serde_json::from_str(REGISTRY_JSON).expect("valid bundled registry")
}

fn saved_registry() -> Option<Registry> {
    let path = AppPaths::discover().ok()?.registry_file();
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The last fetched registry, else the bundled one; never waits on the network.
fn current_registry() -> Arc<Registry> {
    REGISTRY
        .lock()
        .expect("registry lock poisoned")
        .get_or_insert_with(|| Arc::new(saved_registry().unwrap_or_else(bundled_registry)))
        .clone()
}

async fn fetch_registry() -> Result<(Registry, String)> {
    let body = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("agentdeckd/{}", env!("CARGO_PKG_VERSION")))
        .build()?
        .get(REGISTRY_URL)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok((serde_json::from_str(&body)?, body))
}

/// Fetch the latest registry in the background and keep it for later runs.
/// The current launch is not delayed; later launches use the new one.
pub(super) fn refresh_registry() {
    if REGISTRY_REFRESHING.swap(true, Ordering::AcqRel) {
        return;
    }
    tokio::spawn(async {
        match fetch_registry().await {
            Ok((registry, body)) => {
                if let Err(err) = AppPaths::discover().and_then(|paths| {
                    fs::write(paths.registry_file(), body)
                        .context("failed to save the ACP registry")
                }) {
                    logger::info(&format!("{err:#}"));
                }
                *REGISTRY.lock().expect("registry lock poisoned") = Some(Arc::new(registry));
            }
            Err(err) => logger::info(&format!("Failed to fetch the ACP registry: {err:#}")),
        }
        REGISTRY_REFRESHING.store(false, Ordering::Release);
    });
}

fn registry_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// AgentDeck launch env layered over the registry's for an agent.
fn agentdeck_env(id: &str) -> &'static [(&'static str, &'static str)] {
    match id {
        // Codex's bundled visualize plugin answers chart requests with `visualize{...}`
        // references only the Codex app renders.
        "codex-acp" => &[(
            "CODEX_CONFIG",
            r#"{"plugins":{"visualize@openai-bundled":{"enabled":false}}}"#,
        )],
        _ => &[],
    }
}

fn with_agentdeck_env(id: &str, mut env: HashMap<String, String>) -> HashMap<String, String> {
    for (name, value) in agentdeck_env(id) {
        env.insert(name.to_string(), value.to_string());
    }
    env
}

/// Select a distribution for the host before deriving its CLI or launch args.
fn candidates_for_platform(registry: Registry, platform: &str) -> Vec<AgentCandidate> {
    let mut candidates = Vec::new();
    for agent in registry.agents {
        if let Some(mut binary) = agent
            .distribution
            .binary
            .and_then(|mut targets| targets.remove(platform))
        {
            binary.env = with_agentdeck_env(&agent.id, binary.env);
            // Registry Windows paths can mix '/' and '\\', including when
            // inspecting another platform's catalog in a test.
            let cmd_name = binary.cmd.rsplit(['/', '\\']).next().unwrap_or_default();
            // Let PATHEXT probe both native executables and package-manager
            // shims (for example, kilo.exe or kilo.cmd) on Windows.
            let cmd_name = if platform.starts_with("windows-") {
                cmd_name
                    .rsplit_once('.')
                    .filter(|(_, extension)| {
                        ["exe", "cmd", "bat", "com"]
                            .iter()
                            .any(|suffix| extension.eq_ignore_ascii_case(suffix))
                    })
                    .map_or(cmd_name, |(name, _)| name)
            } else {
                cmd_name
            };
            let cli = (!cmd_name.is_empty()).then(|| cmd_name.to_string());
            candidates.push(AgentCandidate {
                id: agent.id.clone(),
                name: agent.name,
                cli,
                launch: AgentLaunch::Binary {
                    version: agent.version,
                    target: binary,
                },
            });
        } else if let Some(npx) = agent.distribution.npx {
            let id = agent.id;
            candidates.push(AgentCandidate {
                id: id.clone(),
                name: agent.name,
                cli: None,
                launch: AgentLaunch::Npx {
                    package: npx.package,
                    args: npx.args,
                    env: with_agentdeck_env(&id, npx.env),
                },
            });
        } else if let Some(uvx) = agent.distribution.uvx {
            let id = agent.id;
            candidates.push(AgentCandidate {
                id: id.clone(),
                name: agent.name,
                cli: None,
                launch: AgentLaunch::Uvx {
                    package: uvx.package,
                    args: uvx.args,
                    env: with_agentdeck_env(&id, uvx.env),
                },
            });
        }
    }
    candidates
}

pub(super) fn agent_candidate(id: &str) -> Option<AgentCandidate> {
    candidates_for_platform((*current_registry()).clone(), &registry_platform())
        .into_iter()
        .find(|candidate| candidate.id == id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub id: String,
    pub name: String,
}

/// Agents with a usable distribution for this host (binary, then npx/uvx).
pub fn available_agents() -> Vec<AvailableAgent> {
    candidates_for_platform((*current_registry()).clone(), &registry_platform())
        .into_iter()
        .map(|candidate| AvailableAgent {
            id: candidate.id,
            name: candidate.name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{AgentLaunch, bundled_registry, candidates_for_platform};

    #[test]
    fn parses_bundled_registry() {
        let registry = bundled_registry();
        assert!(!registry.agents.is_empty());
    }

    #[test]
    fn candidates_use_the_selected_platform_command() {
        for (platform, cursor_cli, poolside_cli) in [
            ("darwin-aarch64", "cursor-agent", "pool-darwin-arm64"),
            ("windows-x86_64", "cursor-agent", "pool-windows-amd64"),
        ] {
            let candidates = candidates_for_platform(bundled_registry(), platform);
            for (id, expected) in [("cursor", cursor_cli), ("poolside", poolside_cli)] {
                let candidate = candidates
                    .iter()
                    .find(|candidate| candidate.id == id)
                    .unwrap();
                assert_eq!(candidate.cli.as_deref(), Some(expected));
                assert!(matches!(candidate.launch, AgentLaunch::Binary { .. }));
            }
        }
    }

    #[test]
    fn falls_back_to_npx_when_the_platform_has_no_binary() {
        let candidates = candidates_for_platform(bundled_registry(), "windows-aarch64");
        let kilo = candidates
            .iter()
            .find(|candidate| candidate.id == "kilo")
            .unwrap();
        assert!(
            matches!(&kilo.launch, AgentLaunch::Npx { package, args, .. }
            if package.starts_with("@kilocode/cli@") && args == &["acp"])
        );
        assert!(kilo.cli.is_none());
        assert!(!candidates.iter().any(|candidate| candidate.id == "goose"));
    }

    #[test]
    fn codex_launch_disables_the_visualize_plugin() {
        let codex = candidates_for_platform(bundled_registry(), "darwin-aarch64")
            .into_iter()
            .find(|candidate| candidate.id == "codex-acp")
            .unwrap();
        let AgentLaunch::Npx { env, .. } = codex.launch else {
            panic!("codex-acp launches through npx");
        };
        let config: serde_json::Value = serde_json::from_str(&env["CODEX_CONFIG"]).unwrap();
        assert_eq!(
            config["plugins"]["visualize@openai-bundled"]["enabled"],
            false
        );
    }
}
