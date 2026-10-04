use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    acp_agent::{self, AgentEvent, AgentSessionManager, SessionContext, SessionEndCallback},
    peer::{CallCtx, Peer},
    render_skills::ClientCapabilities,
    screen_capture,
};

/// Stream agent events as `{ id, event }` frames while a request runs.
fn event_forwarder(
    ctx: &CallCtx,
) -> (
    mpsc::UnboundedSender<AgentEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let ctx = ctx.clone();
    let done = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let event = serde_json::to_value(&event).unwrap_or(Value::Null);
            ctx.emit(event);
        }
    });
    (event_tx, done)
}

/// Drop the event sender and wait for the forwarder to drain so streamed
/// events never overtake the final result.
async fn settle_forwarder(
    forwarder: Option<(
        mpsc::UnboundedSender<AgentEvent>,
        tokio::task::JoinHandle<()>,
    )>,
    ok: bool,
) {
    if let Some((tx, done)) = forwarder {
        drop(tx);
        if ok {
            let _ = done.await;
        }
    }
}

pub type PromptCompletion = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Capabilities the peer declared in its latest `peer_attach`.
pub type PeerCapabilities = Arc<Mutex<ClientCapabilities>>;

/// Central host service managing ACP agent sessions and exposing RPC routes.
#[derive(Clone)]
pub struct AgentService {
    sessions: Arc<AgentSessionManager>,
    end_listeners: Arc<Mutex<Vec<SessionEndCallback>>>,
}

impl Default for AgentService {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentService {
    pub fn new() -> Self {
        let listeners: Arc<Mutex<Vec<SessionEndCallback>>> = Arc::default();
        let listeners_cb = listeners.clone();
        let on_end: SessionEndCallback = Arc::new(move |agent, session_id| {
            let list = listeners_cb.lock().expect("lock poisoned").clone();
            for cb in list {
                cb(agent, session_id);
            }
        });
        Self {
            sessions: Arc::new(AgentSessionManager::new(Some(on_end))),
            end_listeners: listeners,
        }
    }

    /// Attach this service's RPC handlers to a duplex Peer endpoint.
    #[allow(dead_code)]
    pub fn attach(&self, peer: &Peer) {
        self.attach_with_completion(peer, None, PeerCapabilities::default());
    }

    pub fn attach_with_completion(
        &self,
        peer: &Peer,
        on_complete: Option<PromptCompletion>,
        capabilities: PeerCapabilities,
    ) {
        let notify_peer = peer.clone();
        self.end_listeners
            .lock()
            .expect("lock poisoned")
            .push(Arc::new(move |agent, session_id| {
                notify_peer.notify(
                    "agent_session_ended",
                    json!({ "agent": agent, "sessionId": session_id }),
                );
            }));

        let sessions = self.sessions.clone();
        peer.handle("agent_list", move |_params, _ctx| async move {
            let agents = acp_agent::available_agents();
            Ok(json!({ "agents": agents }))
        });

        peer.handle("agent_cwd_complete", move |params, _ctx| async move {
            let input = params
                .get("input")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let cwd = message_cwd(&params);
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(100)
                .clamp(1, 200) as usize;
            tokio::task::spawn_blocking(move || complete_directories(&input, cwd.as_deref(), limit))
                .await
                .map_err(|err| format!("Directory completion task failed: {err}"))?
        });

        peer.handle("file_browse", move |params, _ctx| async move {
            let path = params
                .get("path")
                .or_else(|| params.get("input"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let cwd = message_cwd(&params);
            let filter_type = params
                .get("type")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(200)
                .clamp(1, 500) as usize;
            tokio::task::spawn_blocking(move || {
                browse_files(&path, cwd.as_deref(), filter_type.as_deref(), limit)
            })
            .await
            .map_err(|err| format!("File browse task failed: {err}"))?
        });

        peer.handle_with_bytes("file_read", move |params, _ctx| async move {
            let path = required_str(&params, "path", "file_read")?.to_string();
            let cwd = message_cwd(&params);
            let raw = params.get("raw").and_then(Value::as_bool).unwrap_or(false);
            let range = params
                .get("offset")
                .and_then(Value::as_u64)
                .zip(params.get("length").and_then(Value::as_u64));
            tokio::task::spawn_blocking(move || {
                if raw {
                    read_raw_file(&path, cwd.as_deref(), range)
                } else {
                    read_remote_file(&path, cwd.as_deref())
                }
            })
            .await
            .map_err(|err| format!("File read task failed: {err}"))?
        });

        peer.handle_with_bytes("screen_capture", move |params, _ctx| async move {
            let target = required_str(&params, "target", "screen_capture")?;
            let max_width = params.get("maxWidth").and_then(Value::as_u64);
            screen_capture::capture(target, max_width).await
        });

        peer.handle("git_status", move |params, _ctx| async move {
            let cwd = message_cwd(&params).or_else(|| {
                params
                    .get("path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            });
            tokio::task::spawn_blocking(move || git_status(cwd.as_deref()))
                .await
                .map_err(|err| format!("Git status task failed: {err}"))?
        });

        peer.handle("git_diff", move |params, _ctx| async move {
            let cwd = message_cwd(&params)
                .or_else(|| params.get("cwd").and_then(Value::as_str).map(PathBuf::from));
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string);
            let commit = non_empty_str(&params, "commit").map(str::to_string);
            tokio::task::spawn_blocking(move || {
                git_diff(cwd.as_deref(), path.as_deref(), commit.as_deref())
            })
            .await
            .map_err(|err| format!("Git diff task failed: {err}"))?
        });

        peer.handle("git_log", move |params, _ctx| async move {
            let cwd = message_cwd(&params);
            tokio::task::spawn_blocking(move || git_log(cwd.as_deref(), GIT_LOG_LIMIT))
                .await
                .map_err(|err| format!("Git log task failed: {err}"))?
        });

        peer.handle("git_show", move |params, _ctx| async move {
            let cwd = message_cwd(&params);
            let commit = required_str(&params, "commit", "git_show")?.to_string();
            tokio::task::spawn_blocking(move || git_show(cwd.as_deref(), &commit))
                .await
                .map_err(|err| format!("Git show task failed: {err}"))?
        });

        let create_sessions = sessions.clone();
        let create_capabilities = capabilities.clone();
        peer.handle("agent_session_create", move |params, _ctx| {
            let sessions = create_sessions.clone();
            let capabilities = create_capabilities.clone();
            async move {
                let agent = required_agent(&params, "agent_session_create")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &capabilities)?;
                let timeout_secs = message_timeout_secs(&params);
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.create_session(agent, cwd, context),
                )
                .await
                {
                    Ok(Ok(created)) => Ok(json!({
                        "agent": agent,
                        "sessionId": created.session_id,
                        "title": created.title,
                        "updatedAt": created.updated_at,
                        "modes": created.modes,
                        "configOptions": created.config_options,
                    })),
                    Ok(Err(err)) => Err(err.to_string()),
                    Err(_) => Err("Timeout creating ACP agent session".to_string()),
                }
            }
        });

        let load_sessions = sessions.clone();
        peer.handle("agent_session_load", move |params, ctx| {
            let sessions = load_sessions.clone();
            let capabilities = capabilities.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_load")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &capabilities)?;
                let timeout_secs = message_timeout_secs(&params);

                // The actor drains the load-time history replay into this channel
                // while the load runs; afterwards the buffered frames are emitted
                // (receiver closed, so the actor's live sender can't keep it open)
                // before the final result, so history precedes the response.
                let (replay_tx, mut event_rx) = if message_stream(&params) {
                    let (tx, rx) = mpsc::unbounded_channel::<AgentEvent>();
                    (Some(tx), Some(rx))
                } else {
                    (None, None)
                };

                let result = match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.load_session(agent, session_id, cwd, context, replay_tx),
                )
                .await
                {
                    Ok(Ok(created)) => Ok(json!({
                        "agent": agent,
                        "sessionId": created.session_id,
                        "title": created.title,
                        "updatedAt": created.updated_at,
                        "modes": created.modes,
                        "configOptions": created.config_options,
                    })),
                    Ok(Err(err)) => Err(err.to_string()),
                    Err(_) => Err("Timeout loading ACP agent session".to_string()),
                };

                if let Some(rx) = event_rx.as_mut() {
                    rx.close();
                    while let Some(event) = rx.recv().await {
                        let event = serde_json::to_value(&event).unwrap_or(Value::Null);
                        ctx.emit(event);
                    }
                }
                result
            }
        });

        let list_sessions = sessions.clone();
        peer.handle("agent_session_list", move |params, _ctx| {
            let sessions = list_sessions.clone();
            async move {
                let agent = required_agent(&params, "agent_session_list")?;
                let cwd = message_cwd(&params);
                let cursor = params
                    .get("cursor")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let timeout_secs = message_timeout_secs(&params);
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.list_sessions(agent, cwd, cursor),
                )
                .await
                {
                    Ok(Ok(list)) => Ok(list),
                    Ok(Err(err)) => Err(err.to_string()),
                    Err(_) => Err("Timeout listing ACP agent sessions".to_string()),
                }
            }
        });

        let delete_sessions = sessions.clone();
        peer.handle("agent_session_delete", move |params, _ctx| {
            let sessions = delete_sessions.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_delete")?;
                let timeout_secs = message_timeout_secs(&params);
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.delete_session(agent, session_id),
                )
                .await
                {
                    Ok(Ok(())) => {
                        Ok(json!({ "agent": agent, "sessionId": session_id, "deleted": true }))
                    }
                    Ok(Err(err)) => Err(err.to_string()),
                    Err(_) => Err("Timeout deleting ACP agent session".to_string()),
                }
            }
        });

        let close_sessions = sessions.clone();
        peer.handle("agent_session_close", move |params, _ctx| {
            let sessions = close_sessions.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_close")?;
                let closed = sessions.close_session(agent, session_id).await;
                Ok(json!({ "agent": agent, "sessionId": session_id, "closed": closed }))
            }
        });

        let cancel_sessions = sessions.clone();
        peer.handle("agent_prompt_cancel", move |params, _ctx| {
            let sessions = cancel_sessions.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_prompt_cancel")?;
                let cancelled = sessions.cancel(agent, session_id).await;
                Ok(json!({ "agent": agent, "sessionId": session_id, "cancelled": cancelled }))
            }
        });

        let running_sessions = sessions.clone();
        peer.handle("agent_prompts_running", move |_params, _ctx| {
            let sessions = running_sessions.clone();
            async move {
                let running: Vec<Value> = sessions
                    .running_prompts()
                    .await
                    .into_iter()
                    .map(|(agent, session_id)| json!({ "agent": agent, "sessionId": session_id }))
                    .collect();
                Ok(json!({ "sessions": running }))
            }
        });

        let prompt_sessions = sessions.clone();
        let prompt_peer = peer.clone();
        peer.handle("agent_prompt", move |params, ctx| {
            let on_complete = on_complete.clone();
            let sessions = prompt_sessions.clone();
            let peer = prompt_peer.clone();
            async move {
                let agent = required_agent(&params, "agent_prompt")?;
                // The prompt may be empty when the content lives in attachments.
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let timeout_secs = message_timeout_secs(&params);
                let mut attachments = message_attachments(&params)?;
                if prompt.is_empty() && attachments.is_empty() {
                    return Err(
                        "agent_prompt requires a non-empty prompt or attachments".to_string()
                    );
                }
                let session_id = required_session_id(&params, "agent_prompt")?;
                if message_voice_chat(&params) {
                    attachments.push(acp_agent::Attachment::Text {
                        text: VOICE_CHAT_MARKER.to_string(),
                    });
                }

                let permission_peer = peer.clone();
                let permission_resolver: acp_agent::PermissionResolver = Arc::new(move |request| {
                    let peer = permission_peer.clone();
                    Box::pin(async move {
                        let result = tokio::time::timeout(
                            Duration::from_secs(300),
                            peer.call("agent_permission_request", request),
                        )
                        .await;
                        match result {
                            Ok(Ok(response)) => response
                                .get("optionId")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            Ok(Err(err)) => {
                                tracing::debug!("Permission request declined: {err}");
                                None
                            }
                            Err(_) => {
                                tracing::debug!("Permission request timed out");
                                None
                            }
                        }
                    })
                });

                // Claude predicts the next prompt after the turn settles; only the
                // device that sent this prompt shows it.
                let suggestion_peer = peer.clone();
                let suggestion_agent = agent.to_string();
                let suggestion_session_id = session_id.to_string();
                let suggestion_sink: acp_agent::SuggestionSink = Arc::new(move |suggestion| {
                    suggestion_peer.notify(
                        "agent_prompt_suggestion",
                        json!({
                            "agent": suggestion_agent,
                            "sessionId": suggestion_session_id,
                            "suggestion": suggestion,
                        }),
                    );
                });

                // Stream agent events as `{ id, event }` frames while the prompt
                // runs; the forwarder is drained before the final result so no
                // event overtakes the response.
                let forwarder = message_stream(&params).then(|| event_forwarder(&ctx));
                let event_tx = forwarder.as_ref().map(|(tx, _)| tx.clone());

                let result = sessions
                    .prompt(
                        agent,
                        session_id,
                        prompt,
                        attachments,
                        timeout_secs,
                        event_tx,
                        Some(permission_resolver),
                        Some(suggestion_sink),
                    )
                    .await;

                settle_forwarder(forwarder, result.is_ok()).await;
                if result.is_ok() {
                    if let Some(on_complete) = on_complete {
                        on_complete(agent, session_id);
                    }
                }

                result
                .map(|answer| json!({ "answer": answer, "agent": agent, "sessionId": session_id }))
                .map_err(|err| err.to_string())
            }
        });

        let mode_sessions = sessions.clone();
        peer.handle("agent_session_set_mode", move |params, _ctx| {
            let sessions = mode_sessions.clone();
            async move {
                let (agent, session_id) =
                    required_agent_session(&params, "agent_session_set_mode")?;
                let mode_id = required_str(&params, "modeId", "agent_session_set_mode")?;
                sessions
                    .set_mode(agent, session_id, mode_id)
                    .await
                    .map(|_| json!({}))
                    .map_err(|err| err.to_string())
            }
        });

        let config_sessions = sessions.clone();
        peer.handle("agent_session_set_config_option", move |params, _ctx| {
            let sessions = config_sessions.clone();
            async move {
                let method = "agent_session_set_config_option";
                let (agent, session_id) = required_agent_session(&params, method)?;
                let config_id = required_str(&params, "configId", method)?;
                let value = required_str(&params, "value", method)?;
                sessions
                    .set_config_option(agent, session_id, config_id, value)
                    .await
                    .map_err(|err| err.to_string())
            }
        });
    }
}

fn resolve_base_dir(path: &str, cwd: Option<&Path>) -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir()
        .map_err(|err| format!("Failed to resolve current directory: {err}"))?;
    if path.trim_start().starts_with('~') {
        Ok(dirs::home_dir().unwrap_or(current_dir))
    } else {
        Ok(cwd
            .map(Path::to_path_buf)
            .or_else(dirs::home_dir)
            .unwrap_or(current_dir))
    }
}

fn complete_directories(input: &str, cwd: Option<&Path>, limit: usize) -> Result<Value, String> {
    let input = input.trim();
    let base_dir = resolve_base_dir(input, cwd)?;
    let path = resolve_directory_path(input, &base_dir);
    let is_directory = path.is_dir();
    let (directory, prefix) = if is_directory {
        (path.clone(), String::new())
    } else {
        let directory = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(&base_dir)
            .to_path_buf();
        let prefix = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        (directory, prefix)
    };

    let prefix = prefix.to_lowercase();
    let mut directories = std::fs::read_dir(&directory)
        .map_err(|err| format!("Failed to read {}: {err}", directory.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| {
            prefix.is_empty()
                || entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix)
        })
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    directories.sort_by_key(|path| path.to_lowercase());
    directories.truncate(limit);

    Ok(json!({
        "value": path.to_string_lossy(),
        "isDirectory": is_directory,
        "directories": directories,
    }))
}

fn browse_files(
    path: &str,
    cwd: Option<&Path>,
    filter_type: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let base_dir = resolve_base_dir(path, cwd)?;
    let target = resolve_directory_path(path.trim(), &base_dir);
    if !target.is_dir() {
        return Err(format!("{} is not a directory", target.display()));
    }

    let filter_dirs = !matches!(filter_type, Some("file" | "files"));
    let filter_files = !matches!(filter_type, Some("directory" | "directories" | "dir"));

    struct Entry {
        name: String,
        path: String,
        is_directory: bool,
    }

    let mut entries = Vec::new();
    let read_entries = std::fs::read_dir(&target)
        .map_err(|err| format!("Failed to read {}: {err}", target.display()))?;

    for entry in read_entries.filter_map(|entry| entry.ok()) {
        let entry_path = entry.path();
        let is_dir = entry_path.is_dir();
        if is_dir && !filter_dirs {
            continue;
        }
        if !is_dir && !filter_files {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_str = entry_path.to_string_lossy().into_owned();
        entries.push(Entry {
            name,
            path: path_str,
            is_directory: is_dir,
        });
    }

    entries.sort_by(|a, b| {
        let dir_order = (!a.is_directory).cmp(&(!b.is_directory));
        if dir_order != std::cmp::Ordering::Equal {
            return dir_order;
        }
        let a_dot = a.name.starts_with('.');
        let b_dot = b.name.starts_with('.');
        if a_dot != b_dot {
            return a_dot.cmp(&b_dot);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    entries.truncate(limit);

    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    let entries_json = entries
        .into_iter()
        .map(|e| {
            json!({
                "name": e.name,
                "path": e.path,
                "isDirectory": e.is_directory,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "path": target.to_string_lossy(),
        "home": home,
        "entries": entries_json,
    }))
}

const FILE_READ_MAX_BYTES: u64 = 8 * 1024 * 1024;
const GIT_LOG_LIMIT: usize = 200;

/// A regular file under the size limit, or an error naming why it can't be read.
fn resolve_file(path: &str, cwd: Option<&Path>, len_limit: bool) -> Result<(PathBuf, u64), String> {
    let base_dir = resolve_base_dir(path, cwd)?;
    let resolved = resolve_directory_path(path.trim(), &base_dir);
    let metadata = std::fs::metadata(&resolved)
        .map_err(|err| format!("Failed to read {}: {err}", resolved.display()))?;
    if metadata.is_dir() {
        return Err(format!("{} is a directory", resolved.display()));
    }
    if len_limit && metadata.len() > FILE_READ_MAX_BYTES {
        return Err(format!(
            "{} is too large ({} bytes, limit is {FILE_READ_MAX_BYTES})",
            resolved.display(),
            metadata.len()
        ));
    }
    Ok((resolved, metadata.len()))
}

/// Any file's bytes for clients serving files verbatim, like the App's preview
/// protocol. `range` (offset, length) reads one slice, so large media can be
/// streamed by HTTP Range requests; the result carries the full `size`.
fn read_raw_file(
    path: &str,
    cwd: Option<&Path>,
    range: Option<(u64, u64)>,
) -> Result<(Value, Option<Vec<u8>>), String> {
    let (resolved, size) = resolve_file(path, cwd, range.is_none())?;
    let read_err = |err: std::io::Error| format!("Failed to read {}: {err}", resolved.display());
    let bytes = match range {
        None => std::fs::read(&resolved).map_err(read_err)?,
        Some((_, length)) if length > FILE_READ_MAX_BYTES => {
            return Err(format!(
                "Range of {length} bytes is too large (limit is {FILE_READ_MAX_BYTES})"
            ));
        }
        Some((offset, length)) => {
            let mut file = std::fs::File::open(&resolved).map_err(read_err)?;
            file.seek(SeekFrom::Start(offset)).map_err(read_err)?;
            let mut bytes = Vec::new();
            file.take(length)
                .read_to_end(&mut bytes)
                .map_err(read_err)?;
            bytes
        }
    };
    let path = resolved.to_string_lossy();
    Ok((
        json!({ "path": path, "type": "binary", "size": size }),
        Some(bytes),
    ))
}

/// Images return their bytes next to the result; other files are text.
fn read_remote_file(path: &str, cwd: Option<&Path>) -> Result<(Value, Option<Vec<u8>>), String> {
    let (resolved, _) = resolve_file(path, cwd, true)?;
    let bytes = std::fs::read(&resolved)
        .map_err(|err| format!("Failed to read {}: {err}", resolved.display()))?;
    let path = resolved.to_string_lossy().into_owned();
    let mime_type = mime_from_extension(&resolved);
    match mime_type {
        Some(mime_type) => Ok((
            json!({ "path": path, "type": "image", "mimeType": mime_type }),
            Some(bytes),
        )),
        // Text files are rejected if they contain a NUL byte within the first
        // 8 KB, a cheap heuristic against serving binary blobs as text.
        None if bytes.contains(&0) => {
            Err(format!("Unsupported binary file: {}", resolved.display()))
        }
        None => Ok((
            json!({
                "path": path,
                "type": "text",
                "text": String::from_utf8_lossy(&bytes),
            }),
            None,
        )),
    }
}

fn mime_from_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
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

fn git_status(cwd: Option<&Path>) -> Result<Value, String> {
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

fn git_log(cwd: Option<&Path>, limit: usize) -> Result<Value, String> {
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

fn git_show(cwd: Option<&Path>, rev: &str) -> Result<Value, String> {
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

fn git_diff(cwd: Option<&Path>, path: Option<&str>, commit: Option<&str>) -> Result<Value, String> {
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

fn resolve_directory_path(input: &str, base_dir: &Path) -> PathBuf {
    if input.is_empty() || input == "~" {
        base_dir.to_path_buf()
    } else if let Some(relative) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        base_dir.join(relative)
    } else {
        let path = PathBuf::from(input);
        if path.is_absolute() {
            path
        } else {
            base_dir.join(path)
        }
    }
}

fn non_empty_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn required_str<'a>(params: &'a Value, field: &str, method: &str) -> Result<&'a str, String> {
    non_empty_str(params, field).ok_or_else(|| format!("{method} requires a string {field}"))
}

fn required_agent<'a>(params: &'a Value, method: &str) -> Result<&'a str, String> {
    required_str(params, "agent", method)
}

fn required_session_id<'a>(params: &'a Value, method: &str) -> Result<&'a str, String> {
    required_str(params, "sessionId", method)
}

fn required_agent_session<'a>(
    params: &'a Value,
    method: &str,
) -> Result<(&'a str, &'a str), String> {
    Ok((
        required_agent(params, method)?,
        required_session_id(params, method)?,
    ))
}

fn message_cwd(params: &Value) -> Option<PathBuf> {
    non_empty_str(params, "cwd").map(PathBuf::from)
}

fn session_context(
    params: &Value,
    capabilities: &PeerCapabilities,
) -> Result<SessionContext, String> {
    Ok(SessionContext {
        system_prompt: message_panel_system_prompt(params)?,
        client_capabilities: capabilities.lock().expect("lock poisoned").clone(),
    })
}

fn message_panel_system_prompt(params: &Value) -> Result<Option<String>, String> {
    let Some(context) = params.get("panelContext") else {
        return Ok(None);
    };
    let surface = context
        .get("surface")
        .and_then(Value::as_str)
        .ok_or_else(|| "panelContext.surface must be a string".to_string())?;
    match surface {
        "devtools" => {
            let tab_id = context
                .get("tabId")
                .and_then(Value::as_u64)
                .ok_or_else(|| "DevTools panelContext requires a numeric tabId".to_string())?;
            Ok(Some(format!(
                "You are running inside AgentDeck's Agent panel in browser DevTools. This \
                 DevTools instance is attached to browser tab ID {tab_id}. Treat that inspected \
                 tab as the primary target for browser-related requests. For browser tools that \
                 accept a tabId, use {tab_id}; do not substitute the globally active tab unless \
                 the user explicitly asks you to. Read the inspected tab before acting when page \
                 context is needed, and prefer a suitable page-provided tool returned by read_tab."
            )))
        }
        "side_panel" => Ok(Some(
            "You are running inside AgentDeck's browser sidebar Agent panel. Treat the \
             currently active browser tab as the primary target for browser-related requests. The \
             active tab may change during this session, so resolve it with read_active_tab at the \
             start of each browser task and use the returned tabId for related actions. Prefer a \
             suitable page-provided tool returned by read_active_tab."
                .to_string(),
        )),
        "remote_app" => Ok(Some(
            "You are running inside AgentDeck's mobile app. The user is interacting remotely \
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
             or lists, and never `-->` inside it."
                .to_string(),
        )),
        _ => Err(format!("unknown panelContext.surface: {surface}")),
    }
}

fn message_timeout_secs(params: &Value) -> u64 {
    params
        .get("timeoutSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(600)
        .clamp(1, 3600)
}

/// Marks prompts sent from the client's voice chat; the `remote_app` system
/// prompt asks for a spoken summary after it. The client strips it from
/// replayed user messages.
const VOICE_CHAT_MARKER: &str = "<agentdeck-voice-chat/>";

fn message_voice_chat(params: &Value) -> bool {
    params
        .get("voiceChat")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn message_stream(params: &Value) -> bool {
    params
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn message_attachments(params: &Value) -> Result<Vec<acp_agent::Attachment>, String> {
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

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        VOICE_CHAT_MARKER, browse_files, complete_directories, message_panel_system_prompt,
        message_voice_chat, read_raw_file, read_remote_file, resolve_directory_path,
    };

    #[test]
    fn voice_chat_prompts_carry_the_marker_the_app_system_prompt_explains() {
        assert!(message_voice_chat(
            &serde_json::json!({ "voiceChat": true })
        ));
        assert!(!message_voice_chat(&serde_json::json!({})));
        let prompt = message_panel_system_prompt(
            &serde_json::json!({ "panelContext": { "surface": "remote_app" } }),
        )
        .unwrap()
        .unwrap();
        assert!(prompt.contains(VOICE_CHAT_MARKER));
        assert!(prompt.contains("<!-- agentdeck-speech"));
    }

    #[test]
    fn builds_panel_system_prompts() {
        for (context, expected) in [
            (
                serde_json::json!({ "surface": "devtools", "tabId": 42 }),
                "tab ID 42",
            ),
            (
                serde_json::json!({ "surface": "side_panel" }),
                "browser sidebar",
            ),
            (serde_json::json!({ "surface": "remote_app" }), "mobile app"),
        ] {
            let prompt =
                message_panel_system_prompt(&serde_json::json!({ "panelContext": context }))
                    .expect("valid panel context")
                    .expect("system prompt");
            assert!(prompt.contains(expected), "{expected}");
        }
    }

    #[test]
    fn completes_and_validates_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-cwd-{unique}"));
        let alpha = root.join("alpha");
        let alpine = root.join("alpine");
        std::fs::create_dir_all(&alpha).expect("create alpha directory");
        std::fs::create_dir_all(&alpine).expect("create alpine directory");
        let note = alpha.join("note.txt");
        std::fs::write(&note, b"hello").expect("write note file");

        let prefix = root.join("al").to_string_lossy().into_owned();
        let completion =
            complete_directories(&prefix, None, 100).expect("complete directory prefix");
        let exact = complete_directories(&alpha.to_string_lossy(), None, 100)
            .expect("validate exact directory");

        let rel_completion =
            complete_directories("al", Some(&root), 100).expect("complete relative prefix");
        assert_eq!(rel_completion["isDirectory"], false);
        assert_eq!(
            rel_completion["directories"].as_array().map(Vec::len),
            Some(2)
        );

        assert_eq!(completion["isDirectory"], false);
        assert_eq!(completion["directories"].as_array().map(Vec::len), Some(2));
        assert!(completion.get("files").is_none());
        assert_eq!(exact["isDirectory"], true);
        assert!(exact.get("files").is_none());

        let browsed =
            browse_files(&alpha.to_string_lossy(), None, None, 100).expect("browse directory");
        assert_eq!(browsed["path"], alpha.to_string_lossy().as_ref());
        assert!(browsed["home"].is_string());
        let entries = browsed["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "note.txt");
        assert_eq!(entries[0]["isDirectory"], false);

        let dirs_only = browse_files(&root.to_string_lossy(), None, Some("directory"), 100)
            .expect("browse directories only");
        let dir_entries = dirs_only["entries"].as_array().expect("dir entries array");
        assert_eq!(dir_entries.len(), 2);
        assert!(dir_entries.iter().all(|e| e["isDirectory"] == true));

        let files_only = browse_files(&root.to_string_lossy(), None, Some("file"), 100)
            .expect("browse files only");
        let file_entries = files_only["entries"]
            .as_array()
            .expect("file entries array");
        assert_eq!(file_entries.len(), 0);

        std::fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn expands_home_directory_shorthand() {
        let home = PathBuf::from("home").join("user");

        assert_eq!(resolve_directory_path("~", &home), home);
        assert_eq!(resolve_directory_path("~/test", &home), home.join("test"));
        assert_eq!(resolve_directory_path("~\\test", &home), home.join("test"));
    }

    #[test]
    fn reads_text_and_image_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-file-{unique}"));
        std::fs::create_dir_all(&root).expect("create test directory");
        let text_path = root.join("note.txt");
        std::fs::write(&text_path, b"hello").expect("write text file");
        let png_path = root.join("pixel.png");
        std::fs::write(&png_path, [0x89, b'P', b'N', b'G', 0, 0, 0, 0]).expect("write png file");
        let binary_path = root.join("blob.bin");
        std::fs::write(&binary_path, [0x00, 0x01, 0x02]).expect("write binary file");

        let (text, text_bytes) =
            read_remote_file(&text_path.to_string_lossy(), None).expect("read text file");
        let (image, image_bytes) =
            read_remote_file(&png_path.to_string_lossy(), None).expect("read image file");
        let err =
            read_remote_file(&binary_path.to_string_lossy(), None).expect_err("reject binary file");
        let (raw, raw_bytes) = read_raw_file(&binary_path.to_string_lossy(), None, None)
            .expect("read raw binary file");
        let (slice, slice_bytes) =
            read_raw_file(&binary_path.to_string_lossy(), None, Some((1, 5)))
                .expect("read raw binary range");
        let missing = read_remote_file(&root.join("missing.txt").to_string_lossy(), None)
            .expect_err("reject missing file");
        std::fs::remove_dir_all(&root).expect("remove test directory");

        assert_eq!(text["type"], "text");
        assert_eq!(text["text"], "hello");
        assert!(text_bytes.is_none());
        assert_eq!(image["type"], "image");
        assert_eq!(image["mimeType"], "image/png");
        assert_eq!(image_bytes.unwrap()[..4], [0x89, b'P', b'N', b'G']);
        assert!(err.contains("Unsupported binary file"));
        assert_eq!(raw["type"], "binary");
        assert!(raw.get("data").is_none());
        assert_eq!(raw_bytes.unwrap(), [0x00, 0x01, 0x02]);
        assert_eq!(slice["size"], 3);
        assert_eq!(slice_bytes.unwrap(), [0x01, 0x02]);
        assert!(missing.contains("Failed to read"));
    }

    #[test]
    fn resolves_relative_path_against_cwd() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-cwd-file-{unique}"));
        std::fs::create_dir_all(&root).expect("create test directory");
        std::fs::write(root.join("note.md"), b"# hi").expect("write file");

        let (file, _) = read_remote_file("note.md", Some(&root)).expect("read relative file");
        std::fs::remove_dir_all(&root).expect("remove test directory");

        assert_eq!(file["type"], "text");
        assert_eq!(file["text"], "# hi");
        assert!(file["path"].as_str().unwrap().ends_with("note.md"));
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
