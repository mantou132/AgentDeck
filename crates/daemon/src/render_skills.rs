//! Output-format skills for the rendering capabilities a client declares in
//! `peer_attach`. Each capability ships as a directory mounted through ACP
//! `additionalDirectories`; its skill teaches the agent a fenced block the
//! client renders from Markdown.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::Result;
use serde::Deserialize;

use crate::{app_data::AppPaths, logger};

/// Rendering capabilities a client declares in `peer_attach`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ClientCapabilities {
    #[serde(default)]
    pub render: Vec<String>,
}

struct RenderSkill {
    /// `ClientCapabilities::render` entry that enables this skill; also the
    /// skill and directory name.
    capability: &'static str,
    skill_md: &'static str,
}

const SKILLS: &[RenderSkill] = &[
    RenderSkill {
        capability: "chart",
        skill_md: include_str!("render_skills/chart/SKILL.md"),
    },
    RenderSkill {
        capability: "preview",
        skill_md: include_str!("render_skills/preview/SKILL.md"),
    },
    RenderSkill {
        capability: "screen",
        skill_md: include_str!("render_skills/screen/SKILL.md"),
    },
];

/// Skill locations agents scan in additional directories: Codex reads
/// `.agents/skills`, Claude Code reads `.claude/skills`.
const SKILL_ROOTS: &[&str] = &[".agents/skills", ".claude/skills"];

fn write_skills(root: &Path) -> Result<()> {
    for skill in SKILLS {
        for skill_root in SKILL_ROOTS {
            let dir = root
                .join(skill.capability)
                .join(skill_root)
                .join(skill.capability);
            fs::create_dir_all(&dir)?;
            fs::write(dir.join("SKILL.md"), skill.skill_md)?;
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
                logger::info(&format!("Failed to write render skills: {err:#}"));
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
        .filter(|skill| {
            capabilities
                .render
                .iter()
                .any(|render| render == skill.capability)
        })
        .peekable();
    if skills.peek().is_none() {
        return Vec::new();
    }
    let Some(root) = skills_root() else {
        return Vec::new();
    };
    skills.map(|skill| root.join(skill.capability)).collect()
}

/// Skill folders for every capability, for agents configured once per
/// process instead of per session.
pub fn all_skill_paths() -> Vec<PathBuf> {
    let Some(root) = skills_root() else {
        return Vec::new();
    };
    SKILLS
        .iter()
        .map(|skill| root.join(skill.capability).join(SKILL_ROOTS[0]))
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
        }
        fs::remove_dir_all(root).unwrap();

        assert!(skill_directories(&ClientCapabilities::default()).is_empty());
    }
}
