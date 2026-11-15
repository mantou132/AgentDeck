use std::{fs, io::ErrorKind};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use serde::{Deserialize, Serialize};

use crate::app_data::{self, AppPaths};

pub(crate) const DEFAULT_RELAY_URL: &str = "wss://agentdeck.xianqiao.wang/ws";
/// Earlier `reset` saved the default relay explicitly; treat it as unset so it follows `DEFAULT_RELAY_URL`.
const LEGACY_DEFAULT_RELAY_URL: &str = "wss://agent-deck.xianqiao.wang/ws";

#[derive(Default)]
pub(crate) struct ConfigOptions {
    pub relay_id: Option<String>,
    pub relay_url: Option<String>,
    /// `Some(None)` lifts a saved restriction.
    pub features: Option<Option<Vec<String>>>,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct DaemonConfig {
    relay_id: Option<String>,
    relay_url: Option<String>,
    #[serde(default)]
    pub awake: crate::awake::Mode,
    /// Features offered to clients (see `features`); unset offers everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<Vec<String>>,
}

impl DaemonConfig {
    pub fn read(paths: &AppPaths) -> Result<Self> {
        let path = paths.config_file();
        let config: Self = match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).with_context(|| {
                format!(
                    "invalid daemon config at {}; run `agentdeckd reset` to recover",
                    path.display()
                )
            })?,
            Err(error) if error.kind() == ErrorKind::NotFound => Self::default(),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to read daemon config at {}", path.display())
                });
            }
        };
        Ok(config)
    }

    pub fn set_awake(paths: &AppPaths, mode: crate::awake::Mode) -> Result<Self> {
        let mut config = Self::read(paths)?;
        config.awake = mode;
        config.save(paths)?;
        Ok(config)
    }

    pub fn relay_id(&self) -> &str {
        self.relay_id.as_deref().expect("initialized pairing ID")
    }

    pub fn relay_url(&self) -> &str {
        self.relay_url
            .as_deref()
            .filter(|url| *url != LEGACY_DEFAULT_RELAY_URL)
            .unwrap_or(DEFAULT_RELAY_URL)
    }

    /// Normal starts reuse saved values unless explicitly overridden.
    pub fn load_or_init(paths: &AppPaths, options: &ConfigOptions) -> Result<Self> {
        let mut config = Self::read(paths)?;
        let mut changed = false;
        if let Some(id) = &options.relay_id {
            config.relay_id = Some(id.clone());
            changed = true;
        }
        if let Some(url) = &options.relay_url {
            config.relay_url = Some(url.clone());
            changed = true;
        }
        if let Some(features) = &options.features {
            config.features = features.clone();
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

    /// Reset starts from defaults, keeping only the offered features, which describe the host rather than its pairing;
    /// a corrupt config loses them too.
    pub fn reset(paths: &AppPaths, options: &ConfigOptions) -> Result<Self> {
        let features = match &options.features {
            Some(features) => features.clone(),
            None => Self::read(paths).ok().and_then(|config| config.features),
        };
        let config = Self {
            awake: crate::awake::Mode::Never,
            relay_id: Some(
                options
                    .relay_id
                    .clone()
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or_else(generate_pairing_id),
            ),
            relay_url: options.relay_url.clone(),
            features,
        };
        config.save(paths)?;
        Ok(config)
    }

    fn save(&self, paths: &AppPaths) -> Result<()> {
        app_data::ensure_dir(paths.root())?;
        let path = paths.config_file();
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, serde_json::to_string_pretty(self)?)
            .with_context(|| format!("failed to write daemon config to {}", temporary.display()))?;
        fs::rename(&temporary, &path)
            .with_context(|| format!("failed to replace daemon config at {}", path.display()))
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
            &ConfigOptions {
                relay_id,
                relay_url,
                features: None,
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
            &ConfigOptions {
                relay_id,
                relay_url,
                features: None,
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
        assert!(DaemonConfig::load_or_init(&paths, &ConfigOptions::default()).is_err());
        let reset = DaemonConfig::reset(&paths, &ConfigOptions::default()).unwrap();
        assert!(reset.relay_id().starts_with("adk1_"));
        assert_eq!(reset.relay_url(), DEFAULT_RELAY_URL);
        assert_eq!(
            DaemonConfig::load_or_init(&paths, &ConfigOptions::default())
                .unwrap()
                .relay_id(),
            reset.relay_id()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn awake_persists_without_changing_relay_and_reset_restores_never() {
        use crate::awake::Mode;
        let root =
            std::env::temp_dir().join(format!("agentdeck-awake-config-{}", std::process::id()));
        let paths = AppPaths::new(root.clone());
        assert_eq!(DaemonConfig::read(&paths).unwrap().awake, Mode::Never);
        assert!(!root.exists());
        let original = load_config(&paths, None, Some("wss://example.com".into())).unwrap();
        for mode in [Mode::Always, Mode::Plugged, Mode::Active, Mode::Never] {
            DaemonConfig::set_awake(&paths, mode).unwrap();
            let saved = load_config(&paths, None, None).unwrap();
            assert_eq!(saved.awake, mode);
            assert_eq!(saved.relay_id, original.relay_id);
            assert_eq!(saved.relay_url, original.relay_url);
        }
        DaemonConfig::set_awake(&paths, Mode::Always).unwrap();
        assert_eq!(reset_config(&paths, None, None).unwrap().awake, Mode::Never);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_config_uses_default_relay() {
        let config: DaemonConfig = serde_json::from_str(r#"{"relay_id":"existing-id"}"#).unwrap();
        assert_eq!(config.awake, crate::awake::Mode::Never);
        assert_eq!(config.relay_url(), DEFAULT_RELAY_URL);
        assert_eq!(config.relay_id.as_deref(), Some("existing-id"));
    }

    #[test]
    fn legacy_default_relay_follows_current_default() {
        let config: DaemonConfig = serde_json::from_str(&format!(
            r#"{{"relay_id":"existing-id","relay_url":"{LEGACY_DEFAULT_RELAY_URL}"}}"#
        ))
        .unwrap();
        assert_eq!(config.relay_url(), DEFAULT_RELAY_URL);
    }

    #[test]
    fn features_persist_and_survive_reset() {
        let root = std::env::temp_dir().join(format!("agentdeck-features-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = AppPaths::new(root.clone());
        let options = |features| ConfigOptions {
            features,
            ..Default::default()
        };
        let basic = Some(vec!["basic".to_string()]);
        DaemonConfig::load_or_init(&paths, &options(Some(basic.clone()))).unwrap();
        assert_eq!(load_config(&paths, None, None).unwrap().features, basic);
        assert_eq!(reset_config(&paths, None, None).unwrap().features, basic);
        DaemonConfig::load_or_init(&paths, &options(Some(None))).unwrap();
        assert_eq!(load_config(&paths, None, None).unwrap().features, None);
        fs::remove_dir_all(root).unwrap();
    }
}
