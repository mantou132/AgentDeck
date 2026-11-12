use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

use super::non_empty_str;
use crate::{acp_agent, screen_capture};

const REMOTE_APP_SYSTEM_PROMPT: &str = "You are running inside AgentDeck's mobile app. The user is interacting remotely \
     from a mobile device; the host environment is running on their remote machine. \
     Reference files on this machine with Markdown, not HTML: the client reads them \
     directly. A link like `[app.ts](src/app.ts:42)` opens the file (at a line via `:42` \
     or `#L42`) or directory; an image like `![Screenshot](/abs/path/shot.png)` shows it \
     inline, so never inline images as base64. Paths are absolute or relative to the \
     session's working directory.\n\nWhen a user message ends with \
     `<agentdeck-voice-chat/>`, the user is talking by voice through earphones and \
     cannot look at the screen. Do the task as usual, then end your final reply with an \
     HTML comment holding a short spoken summary in the user's language: \
     `<!-- agentdeck-speech` on its own line, one to three plain sentences on what you \
     did, the result and anything the user must decide, then `-->`. It is read aloud and \
     hidden from the transcript, so write it for listening: no Markdown, code, paths, URLs \
     or lists, and never `-->` inside it.";

pub(super) async fn message_panel_system_prompt(params: &Value) -> Result<Option<String>, String> {
    let Some(context) = params.get("panelContext") else {
        return Ok(None);
    };
    let surface = context
        .get("surface")
        .and_then(Value::as_str)
        .ok_or_else(|| "panelContext.surface must be a string".to_string())?;
    match surface {
        "remote_app" => return Ok(Some(REMOTE_APP_SYSTEM_PROMPT.to_string())),
        "devtools" | "side_panel" => {}
        _ => return Err(format!("unknown panelContext.surface: {surface}")),
    }
    // Browser panels may run on another machine; their tab instructions only
    // hold when this machine's browser4agent drives the panel's browser.
    let tab_id = context.get("tabId").and_then(Value::as_i64);
    let url = context.get("url").and_then(Value::as_str);
    let prompt = match (tab_id, url) {
        (Some(tab_id), Some(url)) if screen_capture::browser_has_tab(tab_id, url).await => {
            let browser = browser_panel_system_prompt(surface, tab_id);
            format!("{browser}\n\n{EXTENSION_SYSTEM_PROMPT}")
        }
        _ => EXTENSION_SYSTEM_PROMPT.to_string(),
    };
    Ok(Some(prompt))
}

const EXTENSION_SYSTEM_PROMPT: &str = "You are running inside AgentDeck's browser extension \
     panel. The user may be on a different computer from this machine, so they cannot open \
     files, local paths or `localhost` URLs from your reply; links open as web pages in their \
     browser, and local images are not shown. When the user needs to see code, output or file \
     contents, quote the relevant part in the reply instead of only pointing to a path. Replies \
     render as Markdown, including code blocks, tables, Mermaid diagrams and LaTeX math.";

fn browser_panel_system_prompt(surface: &str, tab_id: i64) -> String {
    if surface == "devtools" {
        return format!(
            "You are running inside AgentDeck's Agent panel in browser DevTools. This \
             DevTools instance is attached to browser tab ID {tab_id}. Treat that inspected \
             tab as the primary target for browser-related requests. For browser tools that \
             accept a tabId, use {tab_id}; do not substitute the globally active tab unless \
             the user explicitly asks you to. Read the inspected tab before acting when page \
             context is needed, and prefer a suitable page-provided tool returned by read_tab."
        );
    }
    "You are running inside AgentDeck's browser sidebar Agent panel. Treat the currently \
     active browser tab as the primary target for browser-related requests. The active tab may \
     change during this session, so resolve it with read_active_tab at the start of each \
     browser task and use the returned tabId for related actions. Prefer a suitable \
     page-provided tool returned by read_active_tab."
        .to_string()
}

pub(super) fn message_timeout_secs(params: &Value) -> u64 {
    params
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(600)
        .clamp(1, 3600)
}

/// Marks prompts sent from the client's voice chat; the `remote_app` system
/// prompt asks for a spoken summary after it. The client strips it from
/// replayed user messages.
pub(super) const VOICE_CHAT_MARKER: &str = "<agentdeck-voice-chat/>";

pub(super) fn message_voice_chat(params: &Value) -> bool {
    params
        .get("voiceChat")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub(super) fn message_attachments(params: &Value) -> Result<Vec<acp_agent::Attachment>, String> {
    let Some(items) = params.get("attachments").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .map(|item| match item.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                let text = non_empty_str(item, "text")
                    .ok_or_else(|| "text attachment requires non-empty text".to_string())?;
                Ok(acp_agent::Attachment::Text {
                    text: text.to_string(),
                })
            }
            Some("image") => {
                let data = non_empty_str(item, "data")
                    .ok_or_else(|| "image attachment requires base64 data".to_string())?;
                let mime_type = non_empty_str(item, "mimeType").unwrap_or("image/png");
                Ok(acp_agent::Attachment::Image {
                    data: data.to_string(),
                    mime_type: mime_type.to_string(),
                })
            }
            Some("file") => {
                let name = non_empty_str(item, "name")
                    .ok_or_else(|| "file attachment requires a name".to_string())?;
                let data = non_empty_str(item, "data")
                    .ok_or_else(|| "file attachment requires base64 data".to_string())?;
                let path = save_file_attachment(&attachments_root(), name, data)?;
                Ok(acp_agent::Attachment::Resource {
                    uri: format!("file://{}", path.display()),
                    name: name.to_string(),
                    mime_type: non_empty_str(item, "mimeType").map(str::to_string),
                })
            }
            Some("resource") => {
                let uri = non_empty_str(item, "uri")
                    .ok_or_else(|| "resource attachment requires a uri".to_string())?;
                let name = non_empty_str(item, "name")
                    .ok_or_else(|| "resource attachment requires a name".to_string())?;
                let mime_type = non_empty_str(item, "mimeType").map(str::to_string);
                Ok(acp_agent::Attachment::Resource {
                    uri: uri.to_string(),
                    name: name.to_string(),
                    mime_type,
                })
            }
            other => Err(format!("unknown attachment type: {other:?}")),
        })
        .collect()
}

/// Uploaded files live in the temp dir, which the system cleans up; its path also
/// has no spaces (unlike macOS Application Support), which keeps the agent's
/// `[@name](file://…)` links intact.
fn attachments_root() -> PathBuf {
    std::env::temp_dir().join("agentdeck-attachments")
}

/// Writes each upload to its own directory under its original file name, so the
/// agent sees the real name.
fn save_file_attachment(root: &Path, name: &str, data: &str) -> Result<PathBuf, String> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let bytes = STANDARD
        .decode(data)
        .map_err(|err| format!("file attachment is not valid base64: {err}"))?;
    // Markdown link delimiters and whitespace would break the agent's file link.
    let file_name: String = Path::new(name)
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_whitespace() || "()[]<>".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let dir = root.join(format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S%f"),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let path = dir.join(if file_name.is_empty() {
        "attachment".to_string()
    } else {
        file_name
    });
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, bytes))
        .map_err(|err| format!("failed to save file attachment: {err}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn file_attachments_are_saved_under_a_link_safe_name() {
        let root = std::env::temp_dir().join(format!(
            "agentdeck-attachments-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // base64 of "%PDF"
        let path = save_file_attachment(&root, "../Q3 report (final).pdf", "JVBERg==").unwrap();
        assert_eq!(path.file_name().unwrap(), "Q3_report__final_.pdf");
        assert_eq!(path.parent().unwrap().parent().unwrap(), root);
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF");
        assert!(save_file_attachment(&root, "a.pdf", "not base64!").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn voice_chat_prompts_carry_the_marker_the_app_system_prompt_explains() {
        assert!(message_voice_chat(
            &serde_json::json!({ "voiceChat": true })
        ));
        assert!(!message_voice_chat(&serde_json::json!({})));
        let prompt = message_panel_system_prompt(
            &serde_json::json!({ "panelContext": { "surface": "remote_app" } }),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(prompt.contains("mobile app"));
        assert!(prompt.contains(VOICE_CHAT_MARKER));
        assert!(prompt.contains("<!-- agentdeck-speech"));
    }

    #[test]
    fn builds_browser_panel_system_prompts() {
        assert!(browser_panel_system_prompt("devtools", 42).contains("tab ID 42"));
        assert!(browser_panel_system_prompt("side_panel", 42).contains("browser sidebar"));
    }

    #[tokio::test]
    async fn browser_panels_without_a_verified_tab_get_only_the_extension_prompt() {
        for surface in ["devtools", "side_panel"] {
            let params = serde_json::json!({ "panelContext": { "surface": surface } });
            let prompt = message_panel_system_prompt(&params).await.unwrap().unwrap();
            assert!(prompt.contains("browser extension panel"));
            assert!(!prompt.contains("browser4agent") && !prompt.contains("tabId"));
        }
    }
}
