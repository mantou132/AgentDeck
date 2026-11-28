use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::Attachment;
use crate::{agent_rpc::VOICE_CHAT_MARKER, app_data};

const MAX_DERIVED_TITLE_CHARS: usize = 30;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub unread: bool,
}

impl SessionMeta {
    fn is_empty(&self) -> bool {
        self.title.is_none() && self.updated_at.is_none() && !self.deleted && !self.unread
    }
}

type AgentMetaMap = BTreeMap<String, BTreeMap<String, SessionMeta>>;

/// Host-side persistent metadata for ACP sessions (`title`, `updatedAt`, soft
/// `deleted`, `unread`), bridging agents that omit these fields or ignore
/// `session/delete` and keeping read state in sync across devices.
pub(crate) struct SessionMetaStore {
    path: Option<PathBuf>,
    data: Mutex<AgentMetaMap>,
}

impl SessionMetaStore {
    pub fn in_memory() -> Arc<Self> {
        Arc::new(Self {
            path: None,
            data: Mutex::default(),
        })
    }

    pub fn load(path: PathBuf) -> Arc<Self> {
        let data = match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<AgentMetaMap>(&content) {
                Ok(parsed) => parsed,
                Err(err) => {
                    tracing::warn!("Failed to parse {}: {err}", path.display());
                    AgentMetaMap::new()
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => AgentMetaMap::new(),
            Err(err) => {
                tracing::warn!("Failed to read {}: {err}", path.display());
                AgentMetaMap::new()
            }
        };
        Arc::new(Self {
            path: Some(path),
            data: Mutex::new(data),
        })
    }

    pub fn get(&self, agent: &str, session_id: &str) -> SessionMeta {
        self.data
            .lock()
            .expect("session meta lock poisoned")
            .get(agent)
            .and_then(|sessions| sessions.get(session_id))
            .cloned()
            .unwrap_or_default()
    }

    /// Record a newly created or forked session.
    pub fn record_created(
        &self,
        agent: &str,
        session_id: &str,
        title: Option<&str>,
        updated_at: &str,
    ) -> SessionMeta {
        self.update(agent, session_id, |entry| {
            let mut changed = false;
            if entry.deleted {
                entry.deleted = false;
                changed = true;
            }
            if let Some(clean) = title.and_then(|t| clean_title(Some(t)))
                && entry.title.as_deref() != Some(clean.as_str())
            {
                entry.title = Some(clean);
                changed = true;
            }
            let next_updated = pick_newer(entry.updated_at.as_deref(), Some(updated_at));
            if next_updated != entry.updated_at {
                entry.updated_at = next_updated;
                changed = true;
            }
            changed
        })
    }

    /// Record an explicit non-placeholder title, a newer `updatedAt`, and/or an
    /// unread transition in a single atomic persistence step.
    pub fn merge_metadata(
        &self,
        agent: &str,
        session_id: &str,
        explicit_title: Option<&str>,
        fallback_title: Option<&str>,
        updated_at: Option<&str>,
        unread: Option<bool>,
    ) -> SessionMeta {
        self.update(agent, session_id, |entry| {
            let mut changed = false;
            if let Some(clean) = clean_title(explicit_title) {
                if entry.title.as_deref() != Some(clean.as_str()) {
                    entry.title = Some(clean);
                    changed = true;
                }
            } else if entry.title.is_none()
                && let Some(clean) = clean_title(fallback_title)
            {
                entry.title = Some(clean);
                changed = true;
            }
            if let Some(incoming) = updated_at {
                let next_updated = pick_newer(entry.updated_at.as_deref(), Some(incoming));
                if next_updated != entry.updated_at {
                    entry.updated_at = next_updated;
                    changed = true;
                }
            }
            if let Some(unread) = unread
                && !entry.deleted
                && entry.unread != unread
            {
                entry.unread = unread;
                changed = true;
            }
            changed
        })
    }

    /// Explicitly mark a session read or unread across devices.
    pub fn set_unread(&self, agent: &str, session_id: &str, unread: bool) {
        self.update(agent, session_id, |entry| {
            if entry.deleted || entry.unread == unread {
                return false;
            }
            entry.unread = unread;
            true
        });
    }

    /// Mark a session deleted so it stays hidden across devices even when the
    /// underlying ACP agent does not support or honor `session/delete`.
    pub fn mark_deleted(&self, agent: &str, session_id: &str) {
        self.update(agent, session_id, |entry| {
            if entry.deleted && entry.title.is_none() && entry.updated_at.is_none() && !entry.unread
            {
                return false;
            }
            entry.deleted = true;
            entry.title = None;
            entry.updated_at = None;
            entry.unread = false;
            true
        });
    }

    /// Filter soft-deleted sessions and backfill missing/placeholder titles,
    /// timestamps, and unread state on a `session/list` JSON response.
    pub fn annotate_list(&self, agent: &str, mut list: serde_json::Value) -> serde_json::Value {
        let Some(sessions) = list
            .get_mut("sessions")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return list;
        };
        let guard = self.data.lock().expect("session meta lock poisoned");
        let Some(stored) = guard.get(agent) else {
            return list;
        };

        sessions.retain_mut(|item| {
            let Some(obj) = item.as_object_mut() else {
                return true;
            };
            let Some(session_id) = obj.get("sessionId").and_then(serde_json::Value::as_str) else {
                return true;
            };
            let Some(meta) = stored.get(session_id) else {
                return true;
            };
            if meta.deleted {
                return false;
            }
            let acp_title = obj.get("title").and_then(serde_json::Value::as_str);
            if clean_title(acp_title).is_none()
                && let Some(title) = &meta.title
            {
                obj.insert(
                    "title".to_string(),
                    serde_json::Value::String(title.clone()),
                );
            }
            let acp_updated = obj.get("updatedAt").and_then(serde_json::Value::as_str);
            if let Some(updated_at) = pick_newer(meta.updated_at.as_deref(), acp_updated) {
                obj.insert(
                    "updatedAt".to_string(),
                    serde_json::Value::String(updated_at),
                );
            }
            if meta.unread {
                obj.insert("unread".to_string(), serde_json::Value::Bool(true));
            }
            true
        });
        list
    }

    fn update(
        &self,
        agent: &str,
        session_id: &str,
        mutate: impl FnOnce(&mut SessionMeta) -> bool,
    ) -> SessionMeta {
        let mut guard = self.data.lock().expect("session meta lock poisoned");
        let mut entry = guard
            .get(agent)
            .and_then(|sessions| sessions.get(session_id))
            .cloned()
            .unwrap_or_default();
        let changed = mutate(&mut entry);
        let snapshot = entry.clone();
        if changed {
            if entry.is_empty() {
                if let Some(sessions) = guard.get_mut(agent) {
                    sessions.remove(session_id);
                    if sessions.is_empty() {
                        guard.remove(agent);
                    }
                }
            } else {
                guard
                    .entry(agent.to_string())
                    .or_default()
                    .insert(session_id.to_string(), entry);
            }
            if let Some(path) = &self.path {
                match serde_json::to_string(&*guard) {
                    Ok(json) => {
                        if let Err(err) = app_data::write_file_atomic(path, json) {
                            tracing::warn!("Failed to persist {}: {err}", path.display());
                        }
                    }
                    Err(err) => {
                        tracing::warn!("Failed to serialize {}: {err}", path.display());
                    }
                }
            }
        }
        snapshot
    }
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn is_placeholder_title(title: &str) -> bool {
    let lower = title.trim().to_lowercase();
    if lower.is_empty() {
        return true;
    }
    if matches!(
        lower.as_str(),
        "untitled" | "untitled session" | "default session" | "未命名" | "未命名会话" | "新建会话"
    ) {
        return true;
    }
    if lower == "session" {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("session") {
        let trimmed = rest
            .trim_start_matches(|c: char| matches!(c, ':' | '_' | '#' | '-') || c.is_whitespace());
        if trimmed.len() == rest.len() || trimmed.is_empty() {
            return false;
        }
        if trimmed.bytes().all(|b| b.is_ascii_digit()) {
            return true;
        }
        // Hex / UUID identifier: >= 4 hex chars in first segment, remaining
        // `-`-separated hex segments.
        let mut segments = trimmed.split('-');
        if let Some(first) = segments.next()
            && first.len() >= 4
            && first.bytes().all(|b| b.is_ascii_hexdigit())
            && segments.all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return true;
        }
    }
    false
}

pub(crate) fn clean_title(title: Option<&str>) -> Option<String> {
    let trimmed = title?.trim();
    if is_placeholder_title(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn truncate_title(text: &str) -> Option<String> {
    let cleaned = text.replace(VOICE_CHAT_MARKER, "");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let truncated: String = trimmed.chars().take(MAX_DERIVED_TITLE_CHARS).collect();
    clean_title(Some(&truncated))
}

pub(crate) fn title_from_prompt(prompt: &str, attachments: &[Attachment]) -> Option<String> {
    if let Some(title) = truncate_title(prompt) {
        return Some(title);
    }
    for attachment in attachments {
        match attachment {
            Attachment::Resource { name, .. } => {
                if let Some(title) = truncate_title(name) {
                    return Some(title);
                }
            }
            Attachment::Text { text } => {
                if let Some(title) = truncate_title(text) {
                    return Some(title);
                }
            }
            Attachment::Image { .. } => {}
        }
    }
    None
}

pub(crate) fn title_from_user_chunk(update: &serde_json::Value) -> Option<String> {
    if update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
        != Some("user_message_chunk")
    {
        return None;
    }
    let content = update.get("content")?;
    match content.get("type").and_then(serde_json::Value::as_str) {
        Some("text") => truncate_title(content.get("text")?.as_str()?),
        Some("resource_link") => truncate_title(content.get("name")?.as_str()?),
        _ => None,
    }
}

fn parse_ts(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Returns the newer of two optional timestamp strings, never regressing a
/// valid RFC3339 timestamp backwards.
pub(crate) fn pick_newer(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let existing = existing.filter(|s| !s.is_empty());
    let incoming = incoming.filter(|s| !s.is_empty());
    match (existing, incoming) {
        (None, None) => None,
        (Some(e), None) => Some(e.to_string()),
        (None, Some(i)) => Some(i.to_string()),
        (Some(e), Some(i)) => match (parse_ts(e), parse_ts(i)) {
            (Some(et), Some(it)) => Some(if it >= et { i } else { e }.to_string()),
            (Some(_), None) => Some(e.to_string()),
            (None, Some(_)) => Some(i.to_string()),
            (None, None) => Some(i.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn placeholder_title_detection() {
        for placeholder in [
            "",
            "   ",
            "Untitled",
            "untitled session",
            "Default Session",
            "未命名",
            "未命名会话",
            "新建会话",
            "Session",
            "Session 123",
            "Session #42",
            "Session f677b9d8",
            "Session: dabac556-adea-4a44-a28b-7b9559daa483",
        ] {
            assert!(
                is_placeholder_title(placeholder),
                "expected placeholder: {placeholder:?}"
            );
        }
        for real in [
            "支持 DeepSeek harness 吗",
            "Session sync refactor",
            "Fix session bug",
            "Session notes",
        ] {
            assert!(!is_placeholder_title(real), "expected real title: {real:?}");
        }
    }

    #[test]
    fn pick_newer_never_regresses() {
        let older = "2026-11-26T02:41:53.000Z";
        let newer = "2026-11-27T21:08:10.000Z";
        assert_eq!(pick_newer(Some(older), Some(newer)).as_deref(), Some(newer));
        assert_eq!(pick_newer(Some(newer), Some(older)).as_deref(), Some(newer));
        assert_eq!(pick_newer(Some(newer), None).as_deref(), Some(newer));
        assert_eq!(pick_newer(None, Some(older)).as_deref(), Some(older));
    }

    #[test]
    fn annotate_list_backfills_title_picks_newer_time_and_filters_deleted() {
        let store = SessionMetaStore::in_memory();
        store.record_created(
            "antigravity-acp",
            "s1",
            Some("支持 DeepSeek harness 吗"),
            "2026-11-27T21:08:10.000Z",
        );
        store.record_created(
            "antigravity-acp",
            "s2",
            Some("Old title"),
            "2026-11-26T00:00:00.000Z",
        );
        store.set_unread("antigravity-acp", "s1", true);
        store.mark_deleted("antigravity-acp", "s3");

        let list = json!({
            "sessions": [
                { "sessionId": "s1", "cwd": "/repo", "title": "Session a1bcdef0" },
                {
                    "sessionId": "s2",
                    "cwd": "/repo",
                    "title": "ACP Real Title",
                    "updatedAt": "2026-11-28T00:00:00.000Z"
                },
                { "sessionId": "s3", "cwd": "/repo", "title": "Deleted one" }
            ]
        });

        let annotated = store.annotate_list("antigravity-acp", list);
        let sessions = annotated["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["sessionId"], "s1");
        assert_eq!(sessions[0]["title"], "支持 DeepSeek harness 吗");
        assert_eq!(sessions[0]["updatedAt"], "2026-11-27T21:08:10.000Z");
        assert_eq!(sessions[0]["unread"], true);
        assert_eq!(sessions[1]["sessionId"], "s2");
        assert_eq!(sessions[1]["title"], "ACP Real Title");
        assert_eq!(sessions[1]["updatedAt"], "2026-11-28T00:00:00.000Z");
        assert!(sessions[1].get("unread").is_none());
    }

    #[test]
    fn persists_to_disk_and_reloads() {
        let dir = std::env::temp_dir().join(format!(
            "agentdeck-session-meta-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let path = dir.join("session_meta.json");
        let store = SessionMetaStore::load(path.clone());
        store.record_created(
            "antigravity-acp",
            "s1",
            Some("Hello"),
            "2026-11-27T10:00:00Z",
        );
        store.set_unread("antigravity-acp", "s1", true);
        store.set_unread("antigravity-acp", "s3", true);
        store.set_unread("antigravity-acp", "s3", false);
        store.mark_deleted("antigravity-acp", "s2");

        let reloaded = SessionMetaStore::load(path.clone());
        assert_eq!(
            reloaded.get("antigravity-acp", "s1"),
            SessionMeta {
                title: Some("Hello".to_string()),
                updated_at: Some("2026-11-27T10:00:00Z".to_string()),
                deleted: false,
                unread: true,
            }
        );
        assert!(reloaded.get("antigravity-acp", "s2").deleted);
        // Clearing unread on an otherwise empty entry prunes it from disk.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"s3\""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn derives_title_from_user_chunk_and_strips_voice_marker() {
        let update = json!({
            "sessionUpdate": "user_message_chunk",
            "content": { "type": "text", "text": "  帮我查一下日志 <agentdeck-voice-chat/> " }
        });
        assert_eq!(
            title_from_user_chunk(&update).as_deref(),
            Some("帮我查一下日志")
        );
    }
}
