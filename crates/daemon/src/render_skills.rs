//! Skills a client ships and enables in `peer_attach`. The client declares
//! their content hash, and the daemon asks for the files through
//! `skills_install` when that version is missing. Each enabled skill is
//! mounted through ACP `additionalDirectories`; most teach the agent a fenced
//! block the client renders from Markdown; the
//! `app` skill also ships a project template the agent copies. `job` and
//! `travel` are workflow skills rather than output formats, toggled the same
//! way; they keep notes agents write while using them in `learned/<skill>/`,
//! outside the versions, named in their skill through `{{LEARNED_PATH}}`.

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::app_data::AppPaths;

/// Skills a client declares in `peer_attach`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SkillSelection {
    /// Content hash of the skills the client ships.
    #[serde(default)]
    pub hash: Option<String>,
    /// Skills of that version to mount into sessions.
    #[serde(default)]
    pub enabled: Vec<String>,
}

/// Skill files a client sends through `skills_install`, keyed by
/// `<skill>/<path>` relative paths.
#[derive(Debug, Deserialize)]
pub struct SkillBundle {
    pub hash: String,
    pub files: HashMap<String, String>,
}

/// Skill locations agents scan in additional directories: Codex reads
/// `.agents/skills`, Claude Code reads `.claude/skills`.
const SKILL_ROOTS: &[&str] = &[".agents/skills", ".claude/skills"];

const LEARNED_PLACEHOLDER: &str = "{{LEARNED_PATH}}";

/// Versions kept on disk, so clients on different builds don't reinstall in turn.
const KEPT_VERSIONS: usize = 3;

/// Version the latest attaching client uses, for agents configured once per process.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

fn skills_dir() -> Result<PathBuf> {
    Ok(AppPaths::discover()?.skills_dir())
}

fn version_dir(root: &Path, hash: &str) -> Result<PathBuf> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("invalid skills hash {hash}");
    }
    Ok(root.join("versions").join(hash))
}

fn learned_dir(root: &Path, skill: &str) -> PathBuf {
    root.join("learned").join(skill)
}

/// Whether the version is installed; an installed one becomes the current version.
pub fn select(hash: &str) -> bool {
    let installed = skills_dir()
        .and_then(|root| version_dir(&root, hash))
        .is_ok_and(|dir| dir.is_dir());
    if installed {
        *CURRENT.lock().expect("lock poisoned") = Some(hash.to_string());
    }
    installed
}

fn write_bundle(root: &Path, bundle: &SkillBundle) -> Result<()> {
    let target = version_dir(root, &bundle.hash)?;
    if target.is_dir() {
        return Ok(());
    }
    let staging = root.join("versions").join(format!(".{}", bundle.hash));
    match fs::remove_dir_all(&staging) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
        _ => {}
    }
    for (path, contents) in &bundle.files {
        let path = Path::new(path);
        if !path.components().all(|c| matches!(c, Component::Normal(_))) {
            bail!("invalid skill file path {}", path.display());
        }
        let mut components = path.components();
        let skill = components
            .next()
            .and_then(|c| c.as_os_str().to_str())
            .context("empty skill file path")?;
        let rest = components.as_path();
        let contents = if contents.contains(LEARNED_PLACEHOLDER) {
            let learned = learned_dir(root, skill);
            fs::create_dir_all(&learned)?;
            contents.replace(
                LEARNED_PLACEHOLDER,
                &learned.join("learned.md").to_string_lossy(),
            )
        } else {
            contents.clone()
        };
        for skill_root in SKILL_ROOTS {
            let file = staging.join(skill).join(skill_root).join(skill).join(rest);
            fs::create_dir_all(file.parent().context("skill file without parent")?)?;
            fs::write(file, &contents)?;
        }
    }
    fs::rename(&staging, &target)?;
    prune(&root.join("versions"))
}

/// Drops all but the newest `KEPT_VERSIONS` versions.
fn prune(versions: &Path) -> Result<()> {
    let mut dirs = fs::read_dir(versions)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .filter(|(_, path)| path.is_dir())
        .collect::<Vec<_>>();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, dir) in dirs.into_iter().skip(KEPT_VERSIONS) {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// Writes a client's skills as a new version and makes it current.
pub fn install(bundle: &SkillBundle) -> Result<()> {
    write_bundle(&skills_dir()?, bundle)?;
    *CURRENT.lock().expect("lock poisoned") = Some(bundle.hash.clone());
    Ok(())
}

fn directories(root: &Path, selection: &SkillSelection) -> Vec<PathBuf> {
    let Some(Ok(version)) = selection
        .hash
        .as_deref()
        .map(|hash| version_dir(root, hash))
    else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for skill in &selection.enabled {
        let dir = version.join(skill);
        if !dir.is_dir() {
            continue;
        }
        dirs.push(dir);
        // Agents write their notes there, so it is mounted too.
        let learned = learned_dir(root, skill);
        if learned.is_dir() {
            dirs.push(learned);
        }
    }
    dirs
}

/// Additional directories carrying the enabled skills.
pub fn skill_directories(selection: &SkillSelection) -> Vec<PathBuf> {
    skills_dir()
        .map(|root| directories(&root, selection))
        .unwrap_or_default()
}

/// Skill folders of every skill in the current version, for agents
/// configured once per process instead of per session.
pub fn all_skill_paths() -> Vec<PathBuf> {
    let Some(hash) = CURRENT.lock().expect("lock poisoned").clone() else {
        return Vec::new();
    };
    let Ok(version) = skills_dir().and_then(|root| version_dir(&root, &hash)) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(version) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| Some(entry.ok()?.path().join(SKILL_ROOTS[0])))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_versions_for_codex_and_claude() {
        let root = std::env::temp_dir().join(format!("agentdeck-skills-{}", std::process::id()));
        let bundle = SkillBundle {
            hash: "abc".to_string(),
            files: HashMap::from([
                ("chart/SKILL.md".to_string(), "chart".to_string()),
                (
                    "job/SKILL.md".to_string(),
                    format!("notes: {LEARNED_PLACEHOLDER}"),
                ),
                ("app/template/.gitignore".to_string(), "dist".to_string()),
            ]),
        };
        write_bundle(&root, &bundle).unwrap();
        let version = root.join("versions/abc");
        for skill_root in SKILL_ROOTS {
            let chart = version
                .join("chart")
                .join(skill_root)
                .join("chart/SKILL.md");
            assert_eq!(fs::read_to_string(chart).unwrap(), "chart");
            let app = version.join("app").join(skill_root).join("app");
            assert!(app.join("template/.gitignore").is_file());
        }
        let job = fs::read_to_string(version.join("job/.claude/skills/job/SKILL.md")).unwrap();
        let learned = learned_dir(&root, "job");
        assert_eq!(
            job,
            format!("notes: {}", learned.join("learned.md").display())
        );

        let selection = SkillSelection {
            hash: Some("abc".to_string()),
            enabled: vec!["job".to_string(), "map".to_string()],
        };
        assert_eq!(
            directories(&root, &selection),
            vec![version.join("job"), learned]
        );
        assert!(directories(&root, &SkillSelection::default()).is_empty());

        let escape = SkillBundle {
            hash: "def".to_string(),
            files: HashMap::from([("../x".to_string(), String::new())]),
        };
        assert!(write_bundle(&root, &escape).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
