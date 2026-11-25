mod files;
mod git;
mod prompt;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub(crate) use prompt::remote_app_system_prompt;
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
    app_data::AppPaths,
    peer::{CallCtx, Peer, RpcError},
    push::PushKind,
    render_skills::{self, SkillSelection},
    screen_capture,
    tasks::Tasks,
};

/// Forwards a request's agent events; resolves to whether the turn stopped
/// because it was cancelled.
type EventForwarder = (
    mpsc::UnboundedSender<AgentEvent>,
    tokio::task::JoinHandle<bool>,
);

/// Stream agent events as `{ id, event }` frames while a request runs.
fn event_forwarder(ctx: &CallCtx) -> EventForwarder {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let ctx = ctx.clone();
    let done = tokio::spawn(async move {
        let mut cancelled = false;
        while let Some(event) = event_rx.recv().await {
            if let AgentEvent::Stop { stop_reason } = &event {
                cancelled = stop_reason == "cancelled";
            }
            let event = serde_json::to_value(&event).unwrap_or(Value::Null);
            ctx.emit(event);
        }
        cancelled
    });
    (event_tx, done)
}

/// Drop the event sender and wait for the forwarder to drain so streamed
/// events never overtake the final result. Returns whether the turn completed:
/// it succeeded and was not cancelled.
async fn settle_forwarder((tx, done): EventForwarder, ok: bool) -> bool {
    drop(tx);
    ok && !done.await.unwrap_or(false)
}

/// Pushes a notification to the peer's device: `(kind, agent, session_id)`.
pub type PeerPush = Arc<dyn Fn(PushKind, &str, &str) + Send + Sync>;

/// The `(agent, sessionId)` a notification asks the user about, if it is a
/// permission request or a question.
pub(crate) fn input_request_session<'a>(
    method: &str,
    params: &'a Value,
) -> Option<(&'a str, &'a str)> {
    if !matches!(
        method,
        "agent_permission_request" | "agent_elicitation_request"
    ) {
        return None;
    }
    Some((
        params.get("agent")?.as_str()?,
        params.get("sessionId")?.as_str()?,
    ))
}

/// Skills the peer declared in its latest `peer_attach`.
pub type PeerSkills = Arc<Mutex<SkillSelection>>;

/// Central host service managing ACP agent sessions and exposing RPC routes.
#[derive(Clone)]
pub struct AgentService {
    sessions: Arc<AgentSessionManager>,
    end_listeners: Arc<Mutex<Vec<SessionEndCallback>>>,
    /// Scheduled tasks, set once by `init_tasks` when the daemon runs.
    tasks: Arc<OnceLock<Arc<Tasks>>>,
    screen_streams: screen_capture::ScreenStreamManager,
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
            tasks: Arc::default(),
            screen_streams: screen_capture::ScreenStreamManager::default(),
        }
    }

    /// Loads the scheduled tasks; they run once `Tasks::start` gets the
    /// devices.
    pub fn init_tasks(&self, paths: AppPaths) -> Arc<Tasks> {
        self.tasks
            .get_or_init(|| Tasks::load(paths, self.sessions.clone()))
            .clone()
    }

    pub fn stop_screen_streams(&self, peer_id: u64) {
        self.screen_streams.stop_peer(peer_id);
    }

    pub fn stop_all_screen_streams(&self) {
        self.screen_streams.stop_all();
    }

    /// Gracefully close active ACP sessions and terminate managed ACP agent
    /// runtimes.
    pub async fn shutdown(&self) {
        self.screen_streams.stop_all();
        if let Some(tasks) = self.tasks.get() {
            tasks.shutdown();
        }
        self.sessions.shutdown().await;
    }

    /// Scheduled task RPCs; they fail until `init_tasks` ran.
    fn attach_tasks(&self, peer: &Peer) {
        fn tasks_of(tasks: &OnceLock<Arc<Tasks>>) -> Result<Arc<Tasks>, String> {
            tasks
                .get()
                .cloned()
                .ok_or_else(|| "Scheduled tasks are not available".to_string())
        }
        fn task_id<'a>(params: &'a Value, method: &str) -> Result<&'a str, String> {
            required_str(params, "id", method)
        }

        let tasks = self.tasks.clone();
        peer.handle("task_list", move |_params, _ctx| {
            let tasks = tasks.clone();
            async move { Ok(tasks_of(&tasks)?.list()) }
        });

        let tasks = self.tasks.clone();
        peer.handle("task_runs", move |params, _ctx| {
            let tasks = tasks.clone();
            async move {
                let id = task_id(&params, "task_runs")?;
                Ok(json!({ "runs": tasks_of(&tasks)?.runs(id) }))
            }
        });

        let tasks = self.tasks.clone();
        peer.handle("task_upsert", move |params, _ctx| {
            let tasks = tasks.clone();
            async move {
                let task = params
                    .get("task")
                    .cloned()
                    .ok_or_else(|| "task_upsert requires task".to_string())?;
                let task = tasks_of(&tasks)?
                    .upsert(task)
                    .map_err(|err| format!("{err:#}"))?;
                Ok(json!({ "task": task }))
            }
        });

        let tasks = self.tasks.clone();
        peer.handle("task_set_enabled", move |params, _ctx| {
            let tasks = tasks.clone();
            async move {
                let id = task_id(&params, "task_set_enabled")?;
                let enabled = params
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "task_set_enabled requires enabled".to_string())?;
                tasks_of(&tasks)?
                    .set_enabled(id, enabled)
                    .map_err(|err| format!("{err:#}"))?;
                Ok(json!({}))
            }
        });

        let tasks = self.tasks.clone();
        peer.handle("task_run_now", move |params, _ctx| {
            let tasks = tasks.clone();
            async move {
                let id = task_id(&params, "task_run_now")?;
                let started = tasks_of(&tasks)?
                    .run_now(id)
                    .map_err(|err| format!("{err:#}"))?;
                Ok(json!({ "started": started }))
            }
        });

        let tasks = self.tasks.clone();
        peer.handle("task_delete", move |params, _ctx| {
            let tasks = tasks.clone();
            async move {
                let id = task_id(&params, "task_delete")?;
                tasks_of(&tasks)?
                    .delete(id)
                    .await
                    .map_err(|err| format!("{err:#}"))?;
                Ok(json!({}))
            }
        });
    }

    /// Attach this service's RPC handlers to a duplex Peer endpoint.
    #[allow(dead_code)]
    pub fn attach(&self, peer: &Peer) {
        self.attach_with_push(peer, 0, None, PeerSkills::default());
    }

    pub fn attach_with_push(
        &self,
        peer: &Peer,
        peer_id: u64,
        push: Option<PeerPush>,
        skills: PeerSkills,
    ) {
        // The device each session's notifications go to; see
        // `SessionActor::notifier`. A permission request or question also
        // reaches it as a push, since the turn waits on it while the App may be
        // in the background.
        let notifier: acp_agent::Notifier = {
            let peer = peer.clone();
            let push = push.clone();
            Arc::new(move |method, params| {
                if let Some(push) = &push
                    && let Some((agent, session_id)) = input_request_session(method, &params)
                {
                    push(PushKind::InputRequest, agent, session_id);
                }
                peer.notify(method, params)
            })
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

        peer.handle("skills_install", move |params, _ctx| async move {
            let bundle: render_skills::SkillBundle = serde_json::from_value(params)
                .map_err(|err| format!("Invalid skills_install params: {err}"))?;
            tokio::task::spawn_blocking(move || render_skills::install(&bundle))
                .await
                .map_err(|err| format!("Skills install task failed: {err}"))?
                .map_err(|err| format!("Failed to install skills: {err:#}"))?;
            Ok(json!({}))
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

        let stream_mgr = self.screen_streams.clone();
        peer.handle("screen_stream", move |params, ctx| {
            let mgr = stream_mgr.clone();
            async move {
                let target = required_str(&params, "target", "screen_stream")?;
                let max_width = params.get("maxWidth").and_then(Value::as_u64);
                mgr.start_stream(peer_id, target, max_width, ctx).await
            }
        });

        let stop_mgr = self.screen_streams.clone();
        peer.handle("screen_stream_stop", move |params, _ctx| {
            let mgr = stop_mgr.clone();
            async move {
                let target = required_str(&params, "target", "screen_stream_stop")?;
                mgr.stop_stream(peer_id, target);
                Ok(json!({ "stopped": true }))
            }
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
        let create_skills = skills.clone();
        let create_notifier = notifier.clone();
        peer.handle("agent_session_create", move |params, ctx| {
            let sessions = create_sessions.clone();
            let skills = create_skills.clone();
            let notifier = create_notifier.clone();
            async move {
                let agent = required_agent(&params, "agent_session_create")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &skills, notifier).await?;
                let timeout_secs = message_timeout_secs(&params);
                prepare_agent(&sessions, agent, &ctx).await?;
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
            let skills = skills.clone();
            let notifier = load_notifier.clone();
            async move {
                let (agent, session_id) = required_agent_session(&params, "agent_session_load")?;
                let cwd = message_cwd(&params);
                let context = session_context(&params, &skills, notifier).await?;
                let timeout_secs = message_timeout_secs(&params);
                prepare_agent(&sessions, agent, &ctx).await?;

                // The actor drains the load-time history replay into this
                // channel while the load runs; afterwards the buffered frames
                // are emitted (receiver closed, so the actor's live sender
                // can't keep it open) before the final result, so history
                // precedes the response.
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
        let list_tasks = self.tasks.clone();
        peer.handle("agent_session_list", move |params, ctx| {
            let sessions = list_sessions.clone();
            let tasks = list_tasks.get().cloned();
            async move {
                let agent = required_agent(&params, "agent_session_list")?;
                let cwd = message_cwd(&params);
                let cursor = params
                    .get("cursor")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let timeout_secs = message_timeout_secs(&params);
                prepare_agent(&sessions, agent, &ctx).await?;
                match tokio::time::timeout(
                    Duration::from_secs(timeout_secs),
                    sessions.list_sessions(agent, cwd, cursor),
                )
                .await
                {
                    Ok(Ok(list)) => tokio::task::spawn_blocking(move || {
                        let list = annotate_worktrees(list);
                        match tasks {
                            Some(tasks) => tasks.annotate_sessions(list),
                            None => list,
                        }
                    })
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
            let push = push.clone();
            let sessions = prompt_sessions.clone();
            let notifier = notifier.clone();
            async move {
                let agent = required_agent(&params, "agent_prompt")?;
                // The prompt may be empty when the content lives in
                // attachments.
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

                // Stream agent events as `{ id, event }` frames while the
                // prompt runs; the forwarder is drained before the final result
                // so no event overtakes the response. Permission requests,
                // questions and the next-prompt suggestion go to this device as
                // notifications; any device answers with
                // `agent_user_input_respond`.
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

                // A turn the user cancelled is not announced as complete.
                if settle_forwarder(forwarder, result.is_ok()).await
                    && let Some(push) = push
                {
                    push(PushKind::ResponseComplete, agent, session_id);
                }

                result
                .map(|answer| json!({ "answer": answer, "agent": agent, "sessionId": session_id }))
                .map_err(agent_error)
            }
        });

        self.attach_tasks(peer);

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

/// First `agent_status` frame, so agents that start quickly show nothing.
const AGENT_STATUS_DELAY: Duration = Duration::from_secs(2);
/// Repeated while the agent starts; each frame restarts the client's timeout.
const AGENT_STATUS_INTERVAL: Duration = Duration::from_secs(5);
/// Upper bound for installing and starting an agent, which `timeoutSeconds`
/// doesn't cover.
const AGENT_PREPARE_TIMEOUT: Duration = Duration::from_secs(600);

/// Starts `agent` before a call that needs it, streaming `agent_status`
/// frames while it installs or starts.
async fn prepare_agent(
    sessions: &AgentSessionManager,
    agent: &str,
    ctx: &CallCtx,
) -> Result<(), String> {
    let status = sessions.agent_status(agent);
    let prepare = tokio::time::timeout(AGENT_PREPARE_TIMEOUT, sessions.prepare(agent));
    tokio::pin!(prepare);
    let mut ticks = tokio::time::interval_at(
        tokio::time::Instant::now() + AGENT_STATUS_DELAY,
        AGENT_STATUS_INTERVAL,
    );
    loop {
        tokio::select! {
            result = &mut prepare => {
                return match result {
                    Ok(result) => result.map_err(|err| err.to_string()),
                    Err(_) => Err("Timeout starting ACP agent".to_string()),
                };
            }
            _ = ticks.tick() => {
                if let Some(status) = *status.borrow() {
                    ctx.emit(json!({ "event": "agent_status", "status": status }));
                }
            }
        }
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
    skills: &PeerSkills,
    notifier: acp_agent::Notifier,
) -> Result<SessionContext, String> {
    Ok(SessionContext {
        system_prompt: message_panel_system_prompt(params).await?,
        skills: skills.lock().expect("lock poisoned").clone(),
        notifier: Some(notifier),
        input_timeout: None,
        auto_approve: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_requests_name_their_session() {
        let params = json!({ "agent": "claude-acp", "sessionId": "s1", "requestId": "1" });
        for method in ["agent_permission_request", "agent_elicitation_request"] {
            assert_eq!(
                input_request_session(method, &params),
                Some(("claude-acp", "s1"))
            );
        }
        assert_eq!(input_request_session("agent_session_update", &params), None);
        assert_eq!(
            input_request_session(
                "agent_permission_request",
                &json!({ "agent": "claude-acp" })
            ),
            None
        );
    }
}
