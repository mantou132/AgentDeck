//! Output-format skills for the rendering capabilities a client declares in
//! `peer_attach`. Each capability ships as a directory mounted through ACP
//! `additionalDirectories`; its skill teaches the agent a fenced block the
//! client renders from Markdown; the `app` skill also ships a project template
//! the agent copies. `job` is a workflow skill rather than an output format,
//! toggled the same way. The skill directories are embedded whole.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::{Context, Result};
use include_dir::{Dir, include_dir};
use serde::Deserialize;

use crate::app_data::AppPaths;

/// Rendering capabilities a client declares in `peer_attach`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ClientCapabilities {
    #[serde(default)]
    pub render: Vec<String>,
}

/// `src/render_skills/<capability>/`: `SKILL.md`, plus any files it ships.
static SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/render_skills");

/// `ClientCapabilities::render` entries with a skill; each is also the skill
/// and directory name.
const SKILLS: &[&str] = &[
    "widget", "chart", "map", "preview", "screen", "session", "event", "app", "job",
];

/// Skill locations agents scan in additional directories: Codex reads
/// `.agents/skills`, Claude Code reads `.claude/skills`.
const SKILL_ROOTS: &[&str] = &[".agents/skills", ".claude/skills"];

fn write_dir(dir: &Dir, skill_dir: &Path, target: &Path) -> Result<()> {
    for file in dir.files() {
        let path = target.join(file.path().strip_prefix(skill_dir)?);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, file.contents())?;
    }
    for sub in dir.dirs() {
        write_dir(sub, skill_dir, target)?;
    }
    Ok(())
}

fn write_skills(root: &Path) -> Result<()> {
    for &skill in SKILLS {
        let dir = SKILLS_DIR
            .get_dir(skill)
            .with_context(|| format!("missing render skill {skill}"))?;
        // Drop files an older build wrote, such as renamed template files
        match fs::remove_dir_all(root.join(skill)) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
            _ => {}
        }
        for skill_root in SKILL_ROOTS {
            write_dir(
                dir,
                Path::new(skill),
                &root.join(skill).join(skill_root).join(skill),
            )?;
        }
    }
    Ok(())
}

/// Skills root, rewritten once per daemon process so it matches this build.
fn skills_root() -> Option<&'static PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = AppPaths::discover().map(|paths| paths.skills_dir());
        match root.and_then(|root| write_skills(&root).map(|()| root)) {
            Ok(root) => Some(root),
            Err(err) => {
                tracing::warn!("Failed to write render skills: {err:#}");
                None
            }
        }
    })
    .as_ref()
}

/// Additional directories carrying the skills for the declared capabilities.
pub fn skill_directories(capabilities: &ClientCapabilities) -> Vec<PathBuf> {
    let mut skills = SKILLS
        .iter()
        .filter(|skill| capabilities.render.iter().any(|render| render == *skill))
        .peekable();
    if skills.peek().is_none() {
        return Vec::new();
    }
    let Some(root) = skills_root() else {
        return Vec::new();
    };
    skills.map(|skill| root.join(skill)).collect()
}

/// Skill folders for every capability, for agents configured once per
/// process instead of per session.
pub fn all_skill_paths() -> Vec<PathBuf> {
    let Some(root) = skills_root() else {
        return Vec::new();
    };
    SKILLS
        .iter()
        .map(|skill| root.join(skill).join(SKILL_ROOTS[0]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_skills_for_codex_and_claude() {
        let root = std::env::temp_dir().join(format!("agentdeck-skills-{}", std::process::id()));
        write_skills(&root).unwrap();
        for skill_root in SKILL_ROOTS {
            let skill =
                fs::read_to_string(root.join("chart").join(skill_root).join("chart/SKILL.md"))
                    .unwrap();
            assert!(skill.starts_with("---\nname: chart\n"));
            let app = root.join("app").join(skill_root).join("app");
            assert!(app.join("template/.gitignore").is_file());
            assert!(app.join("template/src/elements/home.ts").is_file());
        }
        fs::remove_dir_all(root).unwrap();

        assert!(skill_directories(&ClientCapabilities::default()).is_empty());
    }
}
