//! Hot update of the bundled frontend from GitHub Releases.
//!
//! CI builds release apps with `AGENTDECK_NATIVE_ID`, a fingerprint of the
//! native layer, and uploads `dist` as `agentdeck-frontend-<id>.tar.gz` to each
//! release. An app only takes a bundle with its own native ID from a release
//! newer than itself, so native changes never get a mismatched frontend.
//!
//! Bundles live in `<app data>/frontend/<version>/`, are checked against the
//! sha256 GitHub records for the asset, and take effect on the next launch.
//! The frontend confirms each new bundle once it boots
//! (`frontend_update_ready`); a bundle that launched without confirming is
//! dropped on the following launch and never downloaded again.

use std::{
    borrow::Cow,
    fs,
    io::Read as _,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{
    App, Assets, Manager, Runtime, State,
    utils::assets::{AssetKey, AssetsIter, CspHash},
};

const NATIVE_ID: Option<&str> = option_env!("AGENTDECK_NATIVE_ID");
const RELEASES_URL: &str = "https://api.github.com/repos/mantou132/AgentDeck/releases?per_page=10";
const STATE_FILE: &str = "state.json";

type Version = (u64, u64, u64);

fn parse_version(value: &str) -> Option<Version> {
    let mut parts = value
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

#[derive(Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    /// Downloaded, not launched yet.
    #[default]
    Pending,
    /// Launched, waiting for the frontend to confirm.
    Launched,
    /// Booted and confirmed by the frontend.
    Confirmed,
}

#[derive(Default, Serialize, Deserialize)]
struct UpdateState {
    /// Version of the bundle in use.
    active: Option<String>,
    status: Status,
    /// Bundles that failed to boot.
    bad: Vec<String>,
}

pub struct FrontendUpdate {
    root: PathBuf,
    embedded: Version,
    /// Bundle serving this launch.
    current: Option<String>,
    /// Serializes state file updates between the check and the frontend.
    lock: Mutex<()>,
}

impl FrontendUpdate {
    fn read_state(&self) -> UpdateState {
        fs::read(self.root.join(STATE_FILE))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }

    fn write_state(&self, state: &UpdateState) {
        let _ = fs::create_dir_all(&self.root);
        let _ = fs::write(
            self.root.join(STATE_FILE),
            serde_json::to_vec(state).unwrap(),
        );
    }

    /// Picks the bundle for this launch.
    fn resolve(&self) -> Option<String> {
        let state = self.read_state();
        let usable = state.active.filter(|version| {
            parse_version(version).is_some_and(|v| v > self.embedded)
                && self.root.join(version).is_dir()
        });
        let mut next = UpdateState {
            bad: state.bad,
            ..Default::default()
        };
        match (usable, state.status) {
            (Some(version), Status::Launched) => next.bad.push(version),
            (Some(version), status) => {
                next.active = Some(version);
                next.status = match status {
                    Status::Confirmed => Status::Confirmed,
                    _ => Status::Launched,
                };
            }
            (None, _) => {}
        }
        self.write_state(&next);
        next.active
    }

    /// Removes bundles other than the one serving this launch, including
    /// unfinished downloads.
    fn clean(&self) {
        for entry in fs::read_dir(&self.root).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && self.current.as_deref() != entry.file_name().to_str()
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    fn check(&self, native_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        #[derive(Deserialize)]
        struct Release {
            tag_name: String,
            draft: bool,
            prerelease: bool,
            assets: Vec<Asset>,
        }
        #[derive(Deserialize)]
        struct Asset {
            name: String,
            browser_download_url: String,
            digest: Option<String>,
        }

        let state = self.read_state();
        let current = state
            .active
            .as_deref()
            .and_then(parse_version)
            .unwrap_or(self.embedded);
        let client = reqwest::blocking::Client::builder()
            .user_agent("AgentDeck")
            .timeout(Duration::from_secs(120))
            .build()?;
        let releases: Vec<Release> = client
            .get(RELEASES_URL)
            .send()?
            .error_for_status()?
            .json()?;
        let asset_name = format!("agentdeck-frontend-{native_id}.tar.gz");
        let Some((version, asset)) = releases
            .into_iter()
            .filter(|release| {
                !release.draft && !release.prerelease && !state.bad.contains(&release.tag_name)
            })
            .filter_map(|release| {
                let version = parse_version(&release.tag_name).filter(|v| *v > current)?;
                let asset = release
                    .assets
                    .into_iter()
                    .find(|asset| asset.name == asset_name)?;
                Some((version, asset))
            })
            .max_by_key(|(version, _)| *version)
        else {
            return Ok(());
        };
        let sha256 = asset
            .digest
            .as_deref()
            .and_then(|d| d.strip_prefix("sha256:"))
            .ok_or("missing digest")?;
        let mut data = Vec::new();
        client
            .get(&asset.browser_download_url)
            .send()?
            .error_for_status()?
            .read_to_end(&mut data)?;
        if format!("{:x}", Sha256::digest(&data)) != sha256 {
            return Err("digest mismatch".into());
        }

        let name = format!("v{}.{}.{}", version.0, version.1, version.2);
        let staging = self.root.join(format!("{name}.tmp"));
        let _ = fs::remove_dir_all(&staging);
        tar::Archive::new(GzDecoder::new(data.as_slice())).unpack(&staging)?;
        if !staging.join("index.html").is_file() {
            return Err("bundle has no index.html".into());
        }
        let target = self.root.join(&name);
        let _ = fs::remove_dir_all(&target);
        fs::rename(&staging, &target)?;
        // The previous bundle keeps serving this launch; `clean` removes it next time.
        let _guard = self.lock.lock().expect("lock poisoned");
        let state = self.read_state();
        self.write_state(&UpdateState {
            active: Some(name),
            bad: state.bad,
            ..Default::default()
        });
        Ok(())
    }
}

/// Serves the active bundle once `setup` sets its directory, the embedded
/// assets otherwise.
pub struct OverlayAssets<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
    dir: Arc<OnceLock<PathBuf>>,
}

impl<R: Runtime> Assets<R> for OverlayAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let Some(dir) = self.dir.get() else {
            return self.embedded.get(key);
        };
        let path = Path::new(key.as_ref());
        if !path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return None;
        }
        fs::read(dir.join(path.strip_prefix("/").unwrap_or(path)))
            .ok()
            .map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Wraps the context assets; returns the handle `setup` fills in.
pub fn wrap_assets<R: Runtime>(context: &mut tauri::Context<R>) -> Arc<OnceLock<PathBuf>> {
    let dir = Arc::new(OnceLock::new());
    let embedded = context.set_assets(Box::new(NoAssets));
    context.set_assets(Box::new(OverlayAssets {
        embedded,
        dir: dir.clone(),
    }));
    dir
}

/// Runs before the main window is created: picks this launch's bundle, then
/// cleans up and checks for a newer one in the background.
pub fn setup<R: Runtime>(app: &App<R>, dir: &OnceLock<PathBuf>) {
    let (Some(native_id), Some(embedded), Ok(data_dir)) = (
        NATIVE_ID,
        parse_version(&app.package_info().version.to_string()),
        app.path().app_data_dir(),
    ) else {
        app.manage(None::<Arc<FrontendUpdate>>);
        return;
    };
    let mut update = FrontendUpdate {
        root: data_dir.join("frontend"),
        embedded,
        current: None,
        lock: Mutex::new(()),
    };
    update.current = update.resolve();
    if let Some(version) = &update.current {
        let _ = dir.set(update.root.join(version));
    }
    let update = Arc::new(update);
    app.manage(Some(update.clone()));
    std::thread::spawn(move || {
        update.clean();
        if let Err(error) = update.check(native_id) {
            eprintln!("frontend update failed: {error}");
        }
    });
}

/// Called by the frontend once it has booted; confirms the bundle serving
/// this launch.
#[tauri::command]
pub fn frontend_update_ready(update: State<'_, Option<Arc<FrontendUpdate>>>) {
    let Some(update) = update.inner() else { return };
    let _guard = update.lock.lock().expect("lock poisoned");
    let mut state = update.read_state();
    if update.current.is_some()
        && state.active == update.current
        && state.status == Status::Launched
    {
        state.status = Status::Confirmed;
        update.write_state(&state);
    }
}
