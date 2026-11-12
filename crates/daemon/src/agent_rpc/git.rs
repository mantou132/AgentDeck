use std::path::{Path, PathBuf};

use serde_json::{Value, json};

pub(super) const GIT_LOG_LIMIT: usize = 200;

/// Tag listed sessions whose cwd lies in a linked worktree with `worktree: { mainCwd, name }`,
/// so the App lists them with the main checkout.
pub(super) fn annotate_worktrees(mut list: Value) -> Value {
    let mut resolved = std::collections::HashMap::<String, Option<Value>>::new();
    let Some(sessions) = list.get_mut("sessions").and_then(Value::as_array_mut) else {
        return list;
    };
    for session in sessions {
        let Some(cwd) = session
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let worktree = resolved
            .entry(cwd)
            .or_insert_with_key(|cwd| {
                session_worktree(Path::new(cwd)).map(|(main_cwd, name)| {
                    json!({ "mainCwd": main_cwd.to_string_lossy(), "name": name })
                })
            })
            .clone();
        if let (Some(worktree), Some(session)) = (worktree, session.as_object_mut()) {
            session.insert("worktree".to_string(), worktree);
        }
    }
    list
}

/// Main checkout path (keeping the cwd's subpath) and name of the linked worktree holding `cwd`.
/// Removed worktrees fall back to Claude Code's `<repo>/.claude/worktrees/<name>` layout.
fn session_worktree(cwd: &Path) -> Option<(PathBuf, String)> {
    git_worktree(cwd).or_else(|| claude_worktree(cwd))
}

fn git_worktree(cwd: &Path) -> Option<(PathBuf, String)> {
    let repo = git2::Repository::discover(cwd).ok()?;
    if !repo.is_worktree() {
        return None;
    }
    let root = repo.workdir()?;
    let main = git2::Repository::open(repo.commondir()).ok()?;
    let sub = cwd.strip_prefix(root).ok()?;
    let main_cwd = main
        .workdir()?
        .components()
        .chain(sub.components())
        .collect();
    Some((main_cwd, root.file_name()?.to_string_lossy().into_owned()))
}

fn claude_worktree(cwd: &Path) -> Option<(PathBuf, String)> {
    let parts: Vec<_> = cwd.components().collect();
    let index = parts
        .windows(2)
        .position(|pair| pair[0].as_os_str() == ".claude" && pair[1].as_os_str() == "worktrees")?;
    let name = parts
        .get(index + 2)?
        .as_os_str()
        .to_string_lossy()
        .into_owned();
    let main_cwd = parts[..index].iter().chain(&parts[index + 3..]).collect();
    Some((main_cwd, name))
}

fn open_repo(cwd: Option<&Path>) -> Result<git2::Repository, String> {
    let base_dir = match cwd.map(Path::to_path_buf).or_else(dirs::home_dir) {
        Some(dir) => dir,
        None => std::env::current_dir()
            .map_err(|err| format!("Failed to resolve current directory: {err}"))?,
    };
    git2::Repository::discover(&base_dir)
        .map_err(|err| format!("Failed to find git repository: {err}"))
}

fn find_commit<'r>(repo: &'r git2::Repository, rev: &str) -> Result<git2::Commit<'r>, String> {
    repo.revparse_single(rev)
        .and_then(|object| object.peel_to_commit())
        .map_err(|err| format!("Failed to find commit {rev}: {err}"))
}

/// Diff of HEAD against the working tree (index included), untracked files as additions.
fn worktree_diff(repo: &git2::Repository) -> Result<git2::Diff<'_>, String> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|err| format!("Failed to compute git diff: {err}"))?;
    find_renames(diff)
}

/// Diff introduced by a commit relative to its first parent.
fn commit_diff<'r>(
    repo: &'r git2::Repository,
    commit: &git2::Commit,
) -> Result<git2::Diff<'r>, String> {
    let tree = commit
        .tree()
        .map_err(|err| format!("Failed to read commit tree: {err}"))?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|err| format!("Failed to compute git diff: {err}"))?;
    find_renames(diff)
}

/// Pair deleted and added (including untracked) files into renames, like `git diff -M`.
/// Runs on the whole diff; filtering by path first would hide one side of the pair.
fn find_renames(mut diff: git2::Diff<'_>) -> Result<git2::Diff<'_>, String> {
    let mut opts = git2::DiffFindOptions::new();
    opts.renames(true);
    opts.for_untracked(true);
    diff.find_similar(Some(&mut opts))
        .map_err(|err| format!("Failed to detect renames: {err}"))?;
    Ok(diff)
}

fn diff_stats(diff: &git2::Diff) -> Option<Value> {
    diff.stats().ok().map(|s| {
        json!({
            "insertions": s.insertions(),
            "deletions": s.deletions(),
            "filesChanged": s.files_changed(),
        })
    })
}

/// Per-file status and line counts, using the new path of each delta.
fn diff_file_stats(diff: &git2::Diff) -> Vec<(git2::Delta, String, usize, usize)> {
    (0..diff.deltas().len())
        .filter_map(|idx| {
            let patch = git2::Patch::from_diff(diff, idx).ok()??;
            let (_, insertions, deletions) = patch.line_stats().ok()?;
            let delta = patch.delta();
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())?;
            Some((
                delta.status(),
                path.to_string_lossy().into_owned(),
                insertions,
                deletions,
            ))
        })
        .collect()
}

fn commit_json(commit: &git2::Commit) -> Value {
    let id = commit.id().to_string();
    let author = commit.author();
    json!({
        "id": id,
        "shortId": &id[..7],
        "summary": commit.summary().unwrap_or_default(),
        "author": author.name().unwrap_or_default(),
        "time": commit.time().seconds() * 1000,
    })
}

fn repo_path(repo: &git2::Repository) -> String {
    repo.workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .into_owned()
}

fn repo_branch(repo: &git2::Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string).ok())
}

pub(super) fn git_status(cwd: Option<&Path>) -> Result<Value, String> {
    let repo = open_repo(cwd)?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.renames_head_to_index(true);
    opts.renames_index_to_workdir(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|err| format!("Failed to get repository status: {err}"))?;

    let diff = worktree_diff(&repo).ok();
    let line_stats: std::collections::HashMap<String, (usize, usize)> = diff
        .as_ref()
        .map(|diff| {
            diff_file_stats(diff)
                .into_iter()
                .map(|(_, path, insertions, deletions)| (path, (insertions, deletions)))
                .collect()
        })
        .unwrap_or_default();

    let mut files = Vec::new();
    for entry in statuses.iter() {
        // Renamed entries report the old path; use the final path to match the diff.
        let path = entry
            .index_to_workdir()
            .or_else(|| entry.head_to_index())
            .and_then(|delta| {
                delta
                    .new_file()
                    .path()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| entry.path().unwrap_or_default().to_string());
        let s = entry.status();

        // Unused by the current app; kept for older clients that show a staged tag.
        let staged = s.is_index_new()
            || s.is_index_modified()
            || s.is_index_deleted()
            || s.is_index_renamed()
            || s.is_index_typechange();
        let unstaged = s.is_wt_new()
            || s.is_wt_modified()
            || s.is_wt_deleted()
            || s.is_wt_renamed()
            || s.is_wt_typechange();

        let status = if s.is_conflicted() {
            "conflicted"
        } else if s.is_wt_new() {
            "untracked"
        } else if s.is_index_new() {
            "added"
        } else if s.is_wt_deleted() || s.is_index_deleted() {
            "deleted"
        } else if s.is_wt_renamed() || s.is_index_renamed() {
            "renamed"
        } else if s.is_wt_typechange() || s.is_index_typechange() {
            "typechange"
        } else {
            "modified"
        };

        let (insertions, deletions) = line_stats.get(&path).copied().unwrap_or_default();
        files.push(json!({
            "path": path,
            "status": status,
            "staged": staged,
            "unstaged": unstaged,
            "insertions": insertions,
            "deletions": deletions,
        }));
    }

    Ok(json!({
        "repo": repo_path(&repo),
        "branch": repo_branch(&repo),
        "files": files,
        "stats": diff.as_ref().and_then(diff_stats),
    }))
}

pub(super) fn git_log(cwd: Option<&Path>, limit: usize) -> Result<Value, String> {
    let repo = open_repo(cwd)?;
    let mut revwalk = repo
        .revwalk()
        .map_err(|err| format!("Failed to walk history: {err}"))?;
    revwalk
        .push_head()
        .map_err(|err| format!("Failed to read HEAD: {err}"))?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|err| format!("Failed to sort history: {err}"))?;

    let commits = revwalk
        .take(limit)
        .map(|oid| {
            let oid = oid.map_err(|err| format!("Failed to walk history: {err}"))?;
            let commit = repo
                .find_commit(oid)
                .map_err(|err| format!("Failed to read commit {oid}: {err}"))?;
            Ok(commit_json(&commit))
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(json!({
        "repo": repo_path(&repo),
        "branch": repo_branch(&repo),
        "commits": commits,
    }))
}

pub(super) fn git_show(cwd: Option<&Path>, rev: &str) -> Result<Value, String> {
    let repo = open_repo(cwd)?;
    let commit = find_commit(&repo, rev)?;
    let diff = commit_diff(&repo, &commit)?;

    let files: Vec<Value> = diff_file_stats(&diff)
        .into_iter()
        .map(|(delta, path, insertions, deletions)| {
            let status = match delta {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Typechange => "typechange",
                _ => "modified",
            };
            json!({
                "path": path,
                "status": status,
                "insertions": insertions,
                "deletions": deletions,
            })
        })
        .collect();

    Ok(json!({
        "repo": repo_path(&repo),
        "commit": commit_json(&commit),
        "files": files,
        "stats": diff_stats(&diff),
    }))
}

pub(super) fn git_diff(
    cwd: Option<&Path>,
    path: Option<&str>,
    commit: Option<&str>,
) -> Result<Value, String> {
    let repo = open_repo(cwd)?;

    let normalized_path = path.and_then(|p| {
        let p = p.trim();
        if p.is_empty() {
            return None;
        }
        let target = Path::new(p);
        if target.is_absolute() {
            if let Some(workdir) = repo.workdir() {
                if let Ok(rel) = target.strip_prefix(workdir) {
                    return Some(rel.to_string_lossy().into_owned());
                }
            }
        }
        Some(p.to_string())
    });

    let diff = match commit {
        Some(rev) => commit_diff(&repo, &find_commit(&repo, rev)?)?,
        None => worktree_diff(&repo)?,
    };

    let mut patch_text = String::new();
    let (mut insertions, mut deletions, mut files_changed) = (0, 0, 0);
    for (idx, delta) in diff.deltas().enumerate() {
        if let Some(target) = normalized_path.as_deref().map(Path::new) {
            if delta.new_file().path() != Some(target) && delta.old_file().path() != Some(target) {
                continue;
            }
        }
        let Some(mut patch) = git2::Patch::from_diff(&diff, idx)
            .map_err(|err| format!("Failed to compute git diff: {err}"))?
        else {
            continue;
        };
        let (_, file_insertions, file_deletions) = patch
            .line_stats()
            .map_err(|err| format!("Failed to compute git diff: {err}"))?;
        insertions += file_insertions;
        deletions += file_deletions;
        files_changed += 1;
        patch
            .print(&mut |_delta, _hunk, line| {
                if matches!(line.origin(), '+' | '-' | ' ') {
                    patch_text.push(line.origin());
                }
                patch_text.push_str(&String::from_utf8_lossy(line.content()));
                true
            })
            .map_err(|err| format!("Failed to format git diff: {err}"))?;
    }

    Ok(json!({
        "diff": patch_text,
        "path": normalized_path,
        "stats": {
            "insertions": insertions,
            "deletions": deletions,
            "filesChanged": files_changed,
        },
    }))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn worktree_sessions_resolve_to_the_main_checkout() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "agentdeck-worktree-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let main = root.join("repo");
        let repo = git2::Repository::init(&main).unwrap();
        let tree = repo
            .find_tree(repo.index().unwrap().write_tree().unwrap())
            .unwrap();
        let sig = git2::Signature::now("test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        let worktree = root.join("feature");
        repo.worktree("feature", &worktree, None).unwrap();
        std::fs::create_dir(worktree.join("pkg")).unwrap();

        assert_eq!(
            session_worktree(&worktree.join("pkg")),
            Some((main.join("pkg"), "feature".to_string()))
        );
        assert_eq!(session_worktree(&main), None);
        // Removed worktrees are recognized by Claude Code's layout.
        assert_eq!(
            session_worktree(&main.join(".claude/worktrees/gone/pkg")),
            Some((main.join("pkg"), "gone".to_string()))
        );

        let list = annotate_worktrees(serde_json::json!({
            "sessions": [
                { "sessionId": "a", "cwd": worktree.to_string_lossy() },
                { "sessionId": "b", "cwd": main.to_string_lossy() },
            ]
        }));
        assert_eq!(
            list["sessions"][0]["worktree"],
            serde_json::json!({ "mainCwd": main.to_string_lossy(), "name": "feature" })
        );
        assert!(list["sessions"][1].get("worktree").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_renames_are_detected() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-git-rename-{unique}"));
        std::fs::create_dir_all(&root).expect("create root directory");
        let repo = git2::Repository::init(&root).expect("git init");
        let sig = git2::Signature::now("tester", "tester@example.com").expect("create signature");
        let content = "one\ntwo\nthree\nfour\nfive\n";

        let commit_all = |message: &str| {
            let mut index = repo.index().expect("get index");
            index
                .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
                .expect("add all");
            index.update_all(["*"], None).expect("update all");
            index.write().expect("write index");
            let tree = repo
                .find_tree(index.write_tree().expect("write tree"))
                .expect("find tree");
            let parents: Vec<_> = repo
                .head()
                .ok()
                .and_then(|head| head.peel_to_commit().ok())
                .into_iter()
                .collect();
            let parents: Vec<_> = parents.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
                .expect("commit")
                .to_string()
        };

        std::fs::write(root.join("a.txt"), content).expect("write a");
        commit_all("add a");
        std::fs::rename(root.join("a.txt"), root.join("b.txt")).expect("rename a to b");
        let rename_commit = commit_all("rename a to b");

        // Committed rename
        let show = super::git_show(Some(&root), &rename_commit).expect("git_show succeeds");
        let files = show["files"].as_array().expect("files array");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "b.txt");
        assert_eq!(files[0]["status"], "renamed");
        let diff = super::git_diff(Some(&root), Some("b.txt"), Some(&rename_commit))
            .expect("git_diff commit succeeds");
        assert!(diff["diff"].as_str().unwrap().contains("rename from a.txt"));

        // Unstaged rename on disk
        std::fs::rename(root.join("b.txt"), root.join("c.txt")).expect("rename b to c");
        let status = super::git_status(Some(&root)).expect("git_status succeeds");
        let files = status["files"].as_array().expect("files array");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "c.txt");
        assert_eq!(files[0]["status"], "renamed");
        assert_eq!(files[0]["deletions"], 0);
        let diff = super::git_diff(Some(&root), Some("c.txt"), None).expect("git_diff succeeds");
        let diff_text = diff["diff"].as_str().unwrap();
        assert!(diff_text.contains("rename from b.txt"));
        assert!(!diff_text.contains("-one"));

        std::fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn git_status_and_diff_operations() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-git-{unique}"));
        std::fs::create_dir_all(&root).expect("create root directory");

        let repo = git2::Repository::init(&root).expect("git init");
        let file_path = root.join("hello.txt");
        std::fs::write(
            &file_path,
            b"line1
line2
",
        )
        .expect("write hello");

        let mut index = repo.index().expect("get index");
        index
            .add_path(std::path::Path::new("hello.txt"))
            .expect("add hello");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let sig = git2::Signature::now("tester", "tester@example.com").expect("create signature");
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .expect("commit");

        // Modify hello.txt and add untracked new.txt
        std::fs::write(
            &file_path,
            b"line1
line2 modified
line3
",
        )
        .expect("modify hello");
        let untracked_path = root.join("new.txt");
        std::fs::write(
            &untracked_path,
            b"new file content
",
        )
        .expect("write new.txt");

        let status_val = super::git_status(Some(&root)).expect("git_status succeeds");
        assert!(status_val["branch"].is_string());
        let files = status_val["files"].as_array().expect("files array");
        assert_eq!(files.len(), 2);

        let hello_entry = files
            .iter()
            .find(|f| f["path"] == "hello.txt")
            .expect("hello.txt found");
        assert_eq!(hello_entry["status"], "modified");
        assert_eq!(hello_entry["unstaged"], true);
        assert_eq!(hello_entry["insertions"], 2);
        assert_eq!(hello_entry["deletions"], 1);

        let new_entry = files
            .iter()
            .find(|f| f["path"] == "new.txt")
            .expect("new.txt found");
        assert_eq!(new_entry["status"], "untracked");

        // Full diff
        let diff_all = super::git_diff(Some(&root), None, None).expect("git_diff full succeeds");
        let diff_text = diff_all["diff"].as_str().expect("diff string");
        assert!(diff_text.contains("diff --git a/hello.txt b/hello.txt"));
        assert!(diff_text.contains("line2 modified"));
        assert!(diff_text.contains("diff --git a/new.txt b/new.txt"));
        assert!(diff_text.contains("new file content"));

        // Single file diff
        let diff_single = super::git_diff(Some(&root), Some("hello.txt"), None)
            .expect("git_diff single succeeds");
        let diff_single_text = diff_single["diff"].as_str().expect("diff string");
        assert!(diff_single_text.contains("hello.txt"));
        assert!(!diff_single_text.contains("new.txt"));

        // History and commit changes
        let log = super::git_log(Some(&root), 10).expect("git_log succeeds");
        let commits = log["commits"].as_array().expect("commits array");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0]["summary"], "initial commit");
        let commit_id = commits[0]["id"].as_str().expect("commit id");

        let show = super::git_show(Some(&root), commit_id).expect("git_show succeeds");
        let show_files = show["files"].as_array().expect("files array");
        assert_eq!(show_files.len(), 1);
        assert_eq!(show_files[0]["path"], "hello.txt");
        assert_eq!(show_files[0]["status"], "added");
        assert_eq!(show_files[0]["insertions"], 2);

        let commit_diff = super::git_diff(Some(&root), Some("hello.txt"), Some(commit_id))
            .expect("git_diff commit succeeds");
        let commit_diff_text = commit_diff["diff"].as_str().expect("diff string");
        assert!(commit_diff_text.contains("+line2"));
        assert!(!commit_diff_text.contains("line2 modified"));

        std::fs::remove_dir_all(&root).expect("cleanup");
    }
}
