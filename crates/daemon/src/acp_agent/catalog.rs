use std::{
    collections::HashMap,
    fs,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    app_data::{self, AppPaths},
    logger, render_skills,
};

pub(super) const REGISTRY_JSON: &str = include_str!("registry.json");
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// AgentDeck's built-in agent: the registry's OpenCode limited to its free
/// models, keeping its own sessions apart from the user's OpenCode.
const FREE_AGENT_ID: &str = "free";
const FREE_AGENT_NAME: &str = "Free";
const FREE_AGENT_BASE: &str = "opencode";

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

/// Select a distribution for the host before deriving its CLI or launch args.
fn candidates_for_platform(registry: Registry, platform: &str) -> Vec<AgentCandidate> {
    let mut candidates = Vec::new();
    for agent in registry.agents {
        if let Some(binary) = agent
            .distribution
            .binary
            .and_then(|mut targets| targets.remove(platform))
        {
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
            if agent.id == FREE_AGENT_BASE {
                // Always the managed binary, never the user's own CLI.
                candidates.insert(
                    0,
                    AgentCandidate {
                        id: FREE_AGENT_ID.to_string(),
                        name: FREE_AGENT_NAME.to_string(),
                        cli: None,
                        launch: AgentLaunch::Binary {
                            version: agent.version.clone(),
                            target: binary.clone(),
                        },
                    },
                );
            }
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
            candidates.push(AgentCandidate {
                id: agent.id,
                name: agent.name,
                cli: None,
                launch: AgentLaunch::Npx {
                    package: npx.package,
                    args: npx.args,
                    env: npx.env,
                },
            });
        } else if let Some(uvx) = agent.distribution.uvx {
            candidates.push(AgentCandidate {
                id: agent.id,
                name: agent.name,
                cli: None,
                launch: AgentLaunch::Uvx {
                    package: uvx.package,
                    args: uvx.args,
                    env: uvx.env,
                },
            });
        }
    }
    candidates
}

/// AgentDeck launch env layered over the registry's, resolved when the agent
/// starts.
fn agentdeck_env(id: &str) -> Result<Vec<(String, String)>> {
    Ok(match id {
        // Codex's bundled visualize plugin answers chart requests with `visualize{...}`
        // references only the Codex app renders.
        "codex-acp" => vec![(
            "CODEX_CONFIG".to_string(),
            r#"{"plugins":{"visualize@openai-bundled":{"enabled":false}}}"#.to_string(),
        )],
        // The free agent: its own session database, no user login, only the free
        // OpenCode provider, and every render skill (OpenCode does not take
        // per-session `additionalDirectories`).
        FREE_AGENT_ID => {
            let data_dir = AppPaths::discover()?.agent(FREE_AGENT_ID).data_dir();
            app_data::ensure_dir(&data_dir)?;
            let config = serde_json::json!({
                "enabled_providers": ["opencode"],
                "skills": { "paths": render_skills::all_skill_paths() },
            });
            vec![
                (
                    "OPENCODE_DB".to_string(),
                    data_dir.join("opencode.db").to_string_lossy().into_owned(),
                ),
                ("OPENCODE_AUTH_CONTENT".to_string(), "{}".to_string()),
                ("OPENCODE_CONFIG_CONTENT".to_string(), config.to_string()),
            ]
        }
        _ => Vec::new(),
    })
}

/// Agent whose directory holds the managed binary: the free agent shares
/// OpenCode's install and keeps only its data apart.
pub(super) fn managed_binary_agent(id: &str) -> &str {
    if id == FREE_AGENT_ID {
        FREE_AGENT_BASE
    } else {
        id
    }
}

pub(super) fn agent_candidate(id: &str) -> Result<AgentCandidate> {
    let mut candidate =
        candidates_for_platform((*current_registry()).clone(), &registry_platform())
            .into_iter()
            .find(|candidate| candidate.id == id)
            .with_context(|| format!("Unknown ACP agent: {id}"))?;
    let env = match &mut candidate.launch {
        AgentLaunch::Binary { target, .. } => &mut target.env,
        AgentLaunch::Npx { env, .. } | AgentLaunch::Uvx { env, .. } => env,
    };
    env.extend(agentdeck_env(id)?);
    Ok(candidate)
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
    use super::{
        AgentLaunch, agentdeck_env, bundled_registry, candidates_for_platform, managed_binary_agent,
    };

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
    fn free_agent_is_first_and_always_uses_the_managed_opencode() {
        let candidates = candidates_for_platform(bundled_registry(), "darwin-aarch64");
        let free = &candidates[0];
        assert_eq!(free.id, "free");
        assert!(free.cli.is_none());
        let opencode = candidates
            .iter()
            .find(|candidate| candidate.id == "opencode")
            .unwrap();
        assert_eq!(opencode.cli.as_deref(), Some("opencode"));
        let (
            AgentLaunch::Binary { target: free, .. },
            AgentLaunch::Binary {
                target: opencode, ..
            },
        ) = (&free.launch, &opencode.launch)
        else {
            panic!("free and opencode launch the registry binary");
        };
        assert_eq!(free.archive, opencode.archive);
        assert_eq!(managed_binary_agent("free"), "opencode");
    }

    #[test]
    fn codex_launch_disables_the_visualize_plugin() {
        let env = agentdeck_env("codex-acp").unwrap();
        let (_, config) = env.iter().find(|(name, _)| name == "CODEX_CONFIG").unwrap();
        let config: serde_json::Value = serde_json::from_str(config).unwrap();
        assert_eq!(
            config["plugins"]["visualize@openai-bundled"]["enabled"],
            false
        );
    }
}
