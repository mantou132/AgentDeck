mod files;
mod git;
mod prompt;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use self::{
    files::{browse_files, complete_directories, read_raw_file, read_remote_file},
    git::{GIT_LOG_LIMIT, annotate_worktrees, git_diff, git_log, git_show, git_status},
    prompt::{
        VOICE_CHAT_MARKER, message_attachments, message_panel_system_prompt, message_timeout_secs,
        message_voice_chat,
    },
};
use crate::{
    acp_agent::{self, AgentEvent, AgentSessionManager, SessionContext, SessionEndCallback},
    peer::{CallCtx, Peer, RpcError},
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
    (tx, done): (
        mpsc::UnboundedSender<AgentEvent>,
        tokio::task::JoinHandle<()>,
    ),
    ok: bool,
) {
    drop(tx);
    if ok {
        let _ = done.await;
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
        // The device each session's notifications go to; see `SessionActor::notifier`.
        let notifier: acp_agent::Notifier = {
            let peer = peer.clone();
            Arc::new(move |method, params| peer.notify(method, params))
        };
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
        let create_notifier = notifier.clone();
        peer.handle("agent_session_create", move |params, _ctx| {
            let sessions = create_sessions.clone();
            let capabilities = create_capabilities.clone();
            let notifier = create_notifier.clone();
            async move {
                let agent = required_agent(&params, "agent_session_create")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &capabilities, notifier).await?;
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
        let load_notifier = notifier.clone();
        peer.handle("agent_session_load", move |params, ctx| {
            let sessions = load_sessions.clone();
            let capabilities = capabilities.clone();
            let notifier = load_notifier.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_load")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &capabilities, notifier).await?;
                let timeout_secs = message_timeout_secs(&params);

                // The actor drains the load-time history replay into this channel
                // while the load runs; afterwards the buffered frames are emitted
                // (receiver closed, so the actor's live sender can't keep it open)
                // before the final result, so history precedes the response.
                let (replay_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();

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

                event_rx.close();
                while let Some(event) = event_rx.recv().await {
                    let event = serde_json::to_value(&event).unwrap_or(Value::Null);
                    ctx.emit(event);
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
                    Ok(Ok(list)) => tokio::task::spawn_blocking(move || annotate_worktrees(list))
                        .await
                        .map_err(|err| err.to_string()),
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

        let fork_sessions = sessions.clone();
        peer.handle("agent_session_fork", move |params, _ctx| {
            let sessions = fork_sessions.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_fork")?;
                let message_id = required_str(&params, "messageId", "agent_session_fork")?;
                let cwd = message_cwd(&params);
                let timeout_secs = message_timeout_secs(&params);
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.fork_session(agent, session_id, cwd, message_id),
                )
                .await
                {
                    Ok(Ok(forked)) => Ok(json!({ "agent": agent, "sessionId": forked })),
                    Ok(Err(err)) => Err(err.to_string()),
                    Err(_) => Err("Timeout forking ACP agent session".to_string()),
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
                // With `childSessionId`, only that subagent's current work.
                let cancelled = match params.get("childSessionId").and_then(Value::as_str) {
                    Some(child) => sessions.cancel_child(agent, session_id, child).await,
                    None => sessions.cancel(agent, session_id).await,
                };
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
                let user_inputs = sessions.pending_user_inputs().await;
                Ok(json!({ "sessions": running, "userInputs": user_inputs }))
            }
        });

        let user_input_sessions = sessions.clone();
        peer.handle("agent_user_input_respond", move |params, _ctx| {
            let sessions = user_input_sessions.clone();
            async move {
                let method = "agent_user_input_respond";
                let (agent, session_id) = required_agent_session(&params, method)?;
                let request_id = required_str(&params, "requestId", method)?;
                let response = params
                    .get("response")
                    .cloned()
                    .ok_or_else(|| format!("{method} requires response"))?;
                if sessions
                    .answer_user_input(agent, session_id, request_id, response)
                    .await
                {
                    Ok(json!({}))
                } else {
                    Err("The request is no longer pending".to_string())
                }
            }
        });

        let prompt_sessions = sessions.clone();
        peer.handle_rpc("agent_prompt", move |params, ctx| {
            let on_complete = on_complete.clone();
            let sessions = prompt_sessions.clone();
            let notifier = notifier.clone();
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
                    return Err("agent_prompt requires a non-empty prompt or attachments"
                        .to_string()
                        .into());
                }
                let session_id = required_session_id(&params, "agent_prompt")?;
                if message_voice_chat(&params) {
                    attachments.push(acp_agent::Attachment::Text {
                        text: VOICE_CHAT_MARKER.to_string(),
                    });
                }

                // Stream agent events as `{ id, event }` frames while the prompt
                // runs; the forwarder is drained before the final result so no
                // event overtakes the response. Permission requests, questions and
                // the next-prompt suggestion go to this device as notifications;
                // any device answers with `agent_user_input_respond`.
                let forwarder = event_forwarder(&ctx);
                let event_tx = forwarder.0.clone();

                let result = sessions
                    .prompt(
                        agent,
                        session_id,
                        prompt,
                        attachments,
                        timeout_secs,
                        event_tx,
                        Some(notifier),
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
                .map_err(agent_error)
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

fn non_empty_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn required_str<'a>(params: &'a Value, field: &str, method: &str) -> Result<&'a str, String> {
    non_empty_str(params, field).ok_or_else(|| format!("{method} requires a string {field}"))
}

/// An agent failure for the app. ACP `AuthRequired` gets the `auth_required`
/// code, so the app can tell the user to sign in to the agent on this computer.
pub(crate) fn agent_error(err: anyhow::Error) -> RpcError {
    let auth_required = err
        .chain()
        .filter_map(|cause| cause.downcast_ref::<agent_client_protocol::Error>())
        .any(|cause| cause.code == agent_client_protocol::ErrorCode::AuthRequired);
    RpcError {
        message: err.to_string(),
        code: auth_required.then_some("auth_required"),
    }
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

async fn session_context(
    params: &Value,
    capabilities: &PeerCapabilities,
    notifier: acp_agent::Notifier,
) -> Result<SessionContext, String> {
    Ok(SessionContext {
        system_prompt: message_panel_system_prompt(params).await?,
        client_capabilities: capabilities.lock().expect("lock poisoned").clone(),
        notifier: Some(notifier),
    })
}
