use std::{fs, io::ErrorKind};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use serde::{Deserialize, Serialize};

use crate::app_data::{self, AppPaths};

pub(crate) const DEFAULT_RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";

#[derive(Default)]
pub(crate) struct RelayOptions {
    pub relay_id: Option<String>,
    pub relay_url: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct DaemonConfig {
    relay_id: Option<String>,
    relay_url: Option<String>,
}

impl DaemonConfig {
    pub fn relay_id(&self) -> &str {
        self.relay_id.as_deref().expect("initialized pairing ID")
    }

    pub fn relay_url(&self) -> &str {
        self.relay_url.as_deref().unwrap_or(DEFAULT_RELAY_URL)
    }

    /// Normal starts reuse saved values unless explicitly overridden.
    pub fn load_or_init(paths: &AppPaths, options: &RelayOptions) -> Result<Self> {
        let path = paths.config_file();
        let mut config: Self = match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).with_context(|| {
                format!(
                    "invalid daemon config at {}; run `agentdeckd reset` to recover",
                    path.display()
                )
            })?,
            Err(error) if error.kind() == ErrorKind::NotFound => Self::default(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read daemon config at {}", path.display()));
            }
        };
        let mut changed = false;
        if let Some(id) = &options.relay_id {
            config.relay_id = Some(id.clone());
            changed = true;
        }
        if let Some(url) = &options.relay_url {
            config.relay_url = Some(url.clone());
            changed = true;
        }
        if config
            .relay_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
        {
            config.relay_id = Some(generate_pairing_id());
            changed = true;
        }
        if changed {
            config.save(paths)?;
        }
        Ok(config)
    }

    /// Reset starts from defaults, never from the old configuration.
    pub fn reset(paths: &AppPaths, options: &RelayOptions) -> Result<Self> {
        let config = Self {
            relay_id: Some(
                options
                    .relay_id
                    .clone()
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or_else(generate_pairing_id),
            ),
            relay_url: Some(
                options
                    .relay_url
                    .clone()
                    .unwrap_or_else(|| DEFAULT_RELAY_URL.to_owned()),
            ),
        };
        config.save(paths)?;
        Ok(config)
    }

    fn save(&self, paths: &AppPaths) -> Result<()> {
        app_data::ensure_dir(paths.root())?;
        let path = paths.config_file();
        fs::write(&path, serde_json::to_string_pretty(self)?)
            .with_context(|| format!("failed to write daemon config to {}", path.display()))
    }
}

fn generate_pairing_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("adk1_{}", URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_config(
        paths: &AppPaths,
        relay_id: Option<String>,
        relay_url: Option<String>,
    ) -> Result<DaemonConfig> {
        DaemonConfig::load_or_init(
            paths,
            &RelayOptions {
                relay_id,
                relay_url,
            },
        )
    }

    fn reset_config(
        paths: &AppPaths,
        relay_id: Option<String>,
        relay_url: Option<String>,
    ) -> Result<DaemonConfig> {
        DaemonConfig::reset(
            paths,
            &RelayOptions {
                relay_id,
                relay_url,
            },
        )
    }

    #[test]
    fn config_persists_custom_relay_and_preserves_pairing_id() {
        let root = std::env::temp_dir().join(format!("agentdeck-config-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = AppPaths::new(root.clone());
        let initial = load_config(&paths, None, None).unwrap();
        assert!(initial.relay_id.as_deref().unwrap().starts_with("adk1_"));
        let custom = "wss://relay.example/custom";
        load_config(&paths, None, Some(custom.into())).unwrap();
        let reloaded = load_config(&paths, None, None).unwrap();
        assert_eq!(reloaded.relay_url(), custom);
        assert_eq!(reloaded.relay_id, initial.relay_id);
        let updated = load_config(&paths, Some("replacement-id".into()), None).unwrap();
        assert_eq!(updated.relay_url(), custom);
        assert_eq!(updated.relay_id.as_deref(), Some("replacement-id"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reset_rotates_pairing_id_and_restores_default_relay() {
        let root = std::env::temp_dir().join(format!("agentdeck-rotate-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = AppPaths::new(root.clone());
        let relay_url = "wss://relay.example/custom";
        let original = load_config(&paths, None, Some(relay_url.into())).unwrap();
        let reset = reset_config(&paths, None, None).unwrap();
        assert_ne!(reset.relay_id, original.relay_id);
        assert_eq!(reset.relay_url(), DEFAULT_RELAY_URL);
        let new_id = reset.relay_id.as_deref().unwrap();
        let new_codec = crate::relay_encryption::RelayEncryption::new(new_id).unwrap();
        let old_codec =
            crate::relay_encryption::RelayEncryption::new(original.relay_id.as_deref().unwrap())
                .unwrap();
        assert_ne!(new_codec.route_id, old_codec.route_id);
        let reloaded = load_config(&paths, None, None).unwrap();
        assert_eq!(reloaded.relay_id, reset.relay_id);
        assert_eq!(reloaded.relay_url(), DEFAULT_RELAY_URL);
        assert_ne!(
            reset_config(&paths, None, None).unwrap().relay_id,
            reset.relay_id
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reset_applies_relay_overrides_and_persists_them() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-reset-options-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = AppPaths::new(root.clone());
        let initial = load_config(&paths, None, None).unwrap();
        let custom_url = "wss://relay.example/custom";
        let url_only = reset_config(&paths, None, Some(custom_url.into())).unwrap();
        assert_eq!(url_only.relay_url(), custom_url);
        assert_ne!(url_only.relay_id, initial.relay_id);

        let custom_id = generate_pairing_id();
        let id_only = reset_config(&paths, Some(custom_id.clone()), None).unwrap();
        assert_eq!(id_only.relay_id.as_deref(), Some(custom_id.as_str()));
        assert_eq!(id_only.relay_url(), DEFAULT_RELAY_URL);

        let next_url = "ws://localhost:8080/ws";
        let next_id = generate_pairing_id();
        reset_config(&paths, Some(next_id.clone()), Some(next_url.into())).unwrap();
        let reloaded = load_config(&paths, None, None).unwrap();
        assert_eq!(reloaded.relay_id.as_deref(), Some(next_id.as_str()));
        assert_eq!(reloaded.relay_url(), next_url);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reset_recovers_corrupt_config_without_reading_old_values() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-corrupt-config-{}", std::process::id()));
        let paths = AppPaths::new(root.clone());
        app_data::ensure_dir(paths.root()).unwrap();
        fs::write(paths.config_file(), "invalid json").unwrap();
        assert!(DaemonConfig::load_or_init(&paths, &RelayOptions::default()).is_err());
        let reset = DaemonConfig::reset(&paths, &RelayOptions::default()).unwrap();
        assert!(reset.relay_id().starts_with("adk1_"));
        assert_eq!(reset.relay_url(), DEFAULT_RELAY_URL);
        assert_eq!(
            DaemonConfig::load_or_init(&paths, &RelayOptions::default())
                .unwrap()
                .relay_id(),
            reset.relay_id()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_config_uses_default_relay() {
        let config: DaemonConfig = serde_json::from_str(r#"{"relay_id":"existing-id"}"#).unwrap();
        assert_eq!(config.relay_url(), DEFAULT_RELAY_URL);
        assert_eq!(config.relay_id.as_deref(), Some("existing-id"));
    }
}
