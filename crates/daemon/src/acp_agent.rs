use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agent_client_protocol::{
    Agent,
    schema::{
        MaybeUndefined,
        v1::{
            ContentBlock, ContentChunk, DeleteSessionRequest, ForkSessionRequest, IdleStopReason,
            ImageContent, ListSessionsRequest, PromptRequest, ResourceLink, SessionId,
            SessionUpdate, StateUpdate, TextContent,
        },
    },
};
use anyhow::{Context, Result};
use serde::Serialize;
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::render_skills::SkillSelection;

mod catalog;
mod provision;
mod runtime;
mod session;

#[cfg(test)]
mod lifecycle_tests;

pub use catalog::custom_agent_list;
use provision::prepare_agent_command;
use runtime::{AcpRuntime, AgentConnection, StartedSession};
use session::run_session_actor;

fn resolve_cwd(cwd: Option<PathBuf>) -> Result<PathBuf> {
    match cwd {
        Some(cwd) => Ok(cwd),
        None => std::env::current_dir().context("failed to resolve current directory"),
    }
}

/// Sends a `(method, params)` notification to one client device.
pub type Notifier = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// A request waiting for the user, sent to the device as the `method`
/// notification. `params` carry `agent`, `sessionId` and `requestId`.
#[derive(Debug, Clone)]
pub enum UserInput {
    Permission(serde_json::Value),
    Elicitation(serde_json::Value),
}

/// Listed as `{ method, params }`, the shape of the notification.
impl Serialize for UserInput {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde_json::json!({ "method": self.method(), "params": self.params() })
            .serialize(serializer)
    }
}

impl UserInput {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Permission(_) => "agent_permission_request",
            Self::Elicitation(_) => "agent_elicitation_request",
        }
    }

    pub fn params(&self) -> &serde_json::Value {
        match self {
            Self::Permission(params) | Self::Elicitation(params) => params,
        }
    }

    fn params_mut(&mut self) -> &mut serde_json::Value {
        match self {
            Self::Permission(params) | Self::Elicitation(params) => params,
        }
    }
}

/// The `(agent, sessionId)` a notification asks the user about, if it is a
/// permission request or a question.
pub(crate) fn input_request_session<'a>(
    method: &str,
    params: &'a serde_json::Value,
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

/// Client-specific setup sent with `session/new` / `session/load`.
#[derive(Clone, Default)]
pub struct SessionContext {
    pub system_prompt: Option<String>,
    pub skills: SkillSelection,
    /// The device creating or loading the session; see
    /// `SessionActor::notifier`.
    pub notifier: Option<Notifier>,
    /// Permission requests and questions unanswered for this long are refused
    /// (unattended runs); without it they wait until the turn ends.
    pub input_timeout: Option<std::time::Duration>,
    /// Automatically approve permission requests with their allow option
    /// (unattended runs).
    pub auto_approve: bool,
}

/// Snapshot returned after an ACP session actor is ready.
pub struct SessionReady {
    pub session_id: String,
    /// Human-readable title reported while creating/loading the session.
    pub title: Option<String>,
    /// ISO timestamp reported while creating/loading the session.
    pub updated_at: Option<String>,
    /// Modes the agent supports for this session (for `set_mode`).
    pub modes: Option<serde_json::Value>,
    /// Config options the agent supports for this session (for
    /// `set_config_option`).
    pub config_options: Option<serde_json::Value>,
}

/// What a starting agent is doing, reported to clients waiting on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// Downloading the managed binary.
    Installing,
    /// Launching the process and initializing ACP; `npx` / `uvx` download in
    /// this step.
    Starting,
}

/// Extra content sent along with a prompt.
pub enum Attachment {
    /// Plain text, e.g. the contents of an attached text file.
    Text { text: String },
    /// Base64-encoded image (`data` without the data URL prefix).
    Image { data: String, mime_type: String },
    /// Resource the agent reads itself, e.g. a `file://` path on the host.
    Resource {
        uri: String,
        name: String,
        mime_type: Option<String>,
    },
}

impl Attachment {
    fn into_content_block(self) -> ContentBlock {
        match self {
            Attachment::Text { text } => ContentBlock::Text(TextContent::new(text)),
            Attachment::Image { data, mime_type } => {
                ContentBlock::Image(ImageContent::new(data, mime_type))
            }
            Attachment::Resource {
                uri,
                name,
                mime_type,
            } => {
                let mut link = ResourceLink::new(name, uri);
                if let Some(mime_type) = mime_type {
                    link = link.mime_type(mime_type);
                }
                ContentBlock::ResourceLink(link)
            }
        }
    }
}

/// Stream events forwarded to the extension. `update` is the raw ACP session
/// update payload (text chunks included), with `childSessionId` when it is a
/// subagent's; `stop` terminates the prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionUpdate {
        update: serde_json::Value,
        #[serde(rename = "childSessionId", skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
    },
    Stop {
        stop_reason: serde_json::Value,
    },
}

impl AgentEvent {
    fn update(update: SessionUpdate, child_session_id: Option<String>) -> Self {
        Self::SessionUpdate {
            update: update_to_json(update),
            child_session_id,
        }
    }
}

/// A session update of a subagent session, routed to its root session.
struct ChildUpdate {
    session_id: String,
    update: SessionUpdate,
}

pub type SessionEndCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

type SessionMap = Arc<Mutex<HashMap<AgentSessionKey, AgentSession>>>;

const SHUTDOWN_SESSIONS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const RUNTIME_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone)]
pub struct AgentSessionManager {
    sessions: SessionMap,
    /// Created on first use so agents added by the fetched registry can launch.
    runtimes: Arc<std::sync::Mutex<HashMap<String, AcpRuntime>>>,
    on_end: Option<SessionEndCallback>,
    shutting_down: CancellationToken,
}

/// Handle to a session actor.
#[derive(Clone)]
struct AgentSession {
    tx: mpsc::Sender<SessionCommand>,
    child_tx: mpsc::UnboundedSender<ChildUpdate>,
    status: watch::Receiver<SessionStatus>,
    closing: CancellationToken,
    stopped: watch::Receiver<bool>,
}

impl AgentSession {
    async fn wait_closed(&self) {
        let mut stopped = self.stopped.clone();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }
}

/// Published by the actor for queries that must not wait for it.
#[derive(Default)]
struct SessionStatus {
    /// A prompt turn runs, until the agent ends it.
    busy: bool,
    /// Unanswered requests, kept so a reloaded or reconnected device can show
    /// them again.
    pending_inputs: Vec<UserInput>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct AgentSessionKey {
    agent: String,
    session_id: String,
}

impl AgentSessionKey {
    fn new(agent: &str, session_id: &str) -> Self {
        Self {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
        }
    }
}

/// A session to load and where its history replay goes.
type SessionLoad = (SessionId, mpsc::UnboundedSender<AgentEvent>);

struct PromptTurn {
    prompt: String,
    attachments: Vec<Attachment>,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    /// The prompting device, which gets the session's notifications from now
    /// on.
    notifier: Option<Notifier>,
    idle_timeout: std::time::Duration,
    reply: oneshot::Sender<Result<String>>,
}

enum SessionCommand {
    Prompt(PromptTurn),
    Cancel,
    SetMode {
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// A permission request or question from the agent; dropping `answer`
    /// cancels it.
    UserInput {
        input: UserInput,
        answer: oneshot::Sender<serde_json::Value>,
    },
    AnswerUserInput {
        request_id: String,
        response: serde_json::Value,
        reply: oneshot::Sender<bool>,
    },
    /// Cancel a subagent's current work; `false` when it doesn't allow it.
    CancelChild {
        session_id: String,
        reply: oneshot::Sender<bool>,
    },
    Suggestion(String),
}

impl AgentSessionManager {
    pub fn new(on_end: Option<SessionEndCallback>) -> Self {
        Self {
            sessions: Arc::default(),
            runtimes: Arc::default(),
            on_end,
            shutting_down: CancellationToken::new(),
        }
    }

    fn runtime(&self, agent: &str) -> AcpRuntime {
        self.runtimes
            .lock()
            .expect("runtimes lock poisoned")
            .entry(agent.to_string())
            .or_insert_with(|| {
                AcpRuntime::new(
                    agent.to_string(),
                    self.sessions.clone(),
                    self.shutting_down.child_token(),
                )
            })
            .clone()
    }

    /// Start `agent` if it isn't running; `status` reports the progress
    /// meanwhile.
    pub async fn prepare(&self, agent: &str) -> Result<()> {
        self.runtime(agent).connection().await.map(drop)
    }

    pub fn agent_status(&self, agent: &str) -> watch::Receiver<Option<AgentStatus>> {
        self.runtime(agent).status.subscribe()
    }

    pub async fn create_session(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        context: SessionContext,
    ) -> Result<SessionReady> {
        self.start_session(agent, cwd, None, context).await
    }

    /// Resume a persisted session by its ACP session id (requires the agent to
    /// support `session/load`). Returns a fresh live handle to it. The history
    /// updates the agent replays on load are streamed to `replay_tx` before the
    /// session reports ready.
    pub async fn load_session(
        &self,
        agent: &str,
        session_id: &str,
        cwd: Option<PathBuf>,
        context: SessionContext,
        replay_tx: mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<SessionReady> {
        let load = (SessionId::from(session_id.to_string()), replay_tx);
        self.start_session(agent, cwd, Some(load), context).await
    }

    async fn start_session(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        load: Option<SessionLoad>,
        context: SessionContext,
    ) -> Result<SessionReady> {
        if self.shutting_down.is_cancelled() {
            anyhow::bail!("Daemon is shutting down");
        }
        let cwd = resolve_cwd(cwd)?;
        let (tx, rx) = mpsc::channel(8);
        let (child_tx, child_rx) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(SessionStatus::default());
        let (stopped_tx, stopped) = watch::channel(false);
        let handle = AgentSession {
            tx,
            child_tx,
            status,
            closing: CancellationToken::new(),
            stopped,
        };
        // A timed-out create/load must not leave a detached actor behind.
        let close_on_drop = handle.closing.clone().drop_guard();
        let creating = load.is_none();
        if let Some((session_id, _)) = &load {
            // Claim the session before the agent loads it: a second actor would
            // close the agent's session on its way out.
            self.claim(
                AgentSessionKey::new(agent, &session_id.to_string()),
                &handle,
            )
            .await?;
        }

        let (ready_tx, ready_rx) = oneshot::channel();
        let runtime = self.runtime(agent);
        let actor = run_session_actor(
            cwd,
            load,
            context,
            runtime.clone(),
            rx,
            child_rx,
            status_tx,
            ready_tx,
            handle.closing.clone(),
        );
        let sessions = self.sessions.clone();
        let on_end = self.on_end.clone();
        let actor_handle = handle.clone();
        tokio::spawn(async move {
            let was_ready = actor.await;
            let mut sessions = sessions.lock().await;
            let key = sessions
                .iter()
                .find(|(_, session)| session.tx.same_channel(&actor_handle.tx))
                .map(|(key, _)| key.clone());
            if let Some(key) = key {
                sessions.remove(&key);
                runtime.forget_children(&key.session_id);
                // Explicit close already has a reply. Do not emit a late ended
                // notification that could invalidate a reloaded session.
                if was_ready && !actor_handle.closing.is_cancelled() {
                    if let Some(on_end) = on_end {
                        on_end(&key.agent, &key.session_id);
                    }
                }
            }
            // Under the lock, so registering a created session sees it.
            stopped_tx.send_replace(true);
        });

        // Readiness is bounded by the caller's timeout, not here.
        let ready = match ready_rx.await {
            Ok(Ok(ready)) => ready,
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session stopped before it was ready"),
        };
        if creating {
            // The agent assigned the session id.
            let mut sessions = self.sessions.lock().await;
            if self.shutting_down.is_cancelled() {
                anyhow::bail!("Daemon is shutting down");
            }
            if *handle.stopped.borrow() {
                anyhow::bail!("ACP agent session stopped before it was ready");
            }
            sessions.insert(AgentSessionKey::new(agent, &ready.session_id), handle);
        }
        close_on_drop.disarm();
        Ok(ready)
    }

    /// Register a session about to be loaded, after a closing actor of it has
    /// released it.
    async fn claim(&self, key: AgentSessionKey, handle: &AgentSession) -> Result<()> {
        loop {
            let previous = {
                let mut sessions = self.sessions.lock().await;
                if self.shutting_down.is_cancelled() {
                    anyhow::bail!("Daemon is shutting down");
                }
                match sessions.get(&key) {
                    None => {
                        sessions.insert(key, handle.clone());
                        return Ok(());
                    }
                    Some(previous) if !previous.closing.is_cancelled() => anyhow::bail!(
                        "{} ACP session is already active: {}",
                        key.agent,
                        key.session_id
                    ),
                    Some(previous) => previous.clone(),
                }
            };
            previous.wait_closed().await;
        }
    }

    /// Run a prompt turn, streaming its events to `event_tx`. A turn without
    /// any update for `timeout_secs` is cancelled and fails with a timeout, so
    /// only a silent agent times out; a long but productive turn never does.
    #[allow(clippy::too_many_arguments)]
    pub async fn prompt(
        &self,
        agent: &str,
        session_id: &str,
        prompt: String,
        attachments: Vec<Attachment>,
        timeout_secs: u64,
        event_tx: mpsc::UnboundedSender<AgentEvent>,
        notifier: Option<Notifier>,
    ) -> Result<String> {
        let (reply, reply_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::Prompt(PromptTurn {
                prompt,
                attachments,
                event_tx,
                notifier,
                idle_timeout: std::time::Duration::from_secs(timeout_secs),
                reply,
            }),
        )
        .await?;
        match reply_rx.await {
            Ok(result) => result,
            Err(_) => anyhow::bail!("ACP agent session closed before responding"),
        }
    }

    /// Sessions with a prompt still running, as `(agent, session_id)`. Remote
    /// clients use it to settle turns whose final reply never reached them.
    pub async fn running_prompts(&self) -> Vec<(String, String)> {
        self.sessions
            .lock()
            .await
            .iter()
            .filter(|(_, session)| session.status.borrow().busy)
            .map(|(key, _)| (key.agent.clone(), key.session_id.clone()))
            .collect()
    }

    /// Unanswered user input requests of all sessions.
    pub async fn pending_user_inputs(&self) -> Vec<UserInput> {
        self.sessions
            .lock()
            .await
            .values()
            .flat_map(|session| session.status.borrow().pending_inputs.clone())
            .collect()
    }

    /// Answer a pending user input request: `{ optionId }` for a permission
    /// (without it the tool call is cancelled), an ACP
    /// `CreateElicitationResponse` for a form elicitation. `false` when it is
    /// no longer pending.
    pub async fn answer_user_input(
        &self,
        agent: &str,
        session_id: &str,
        request_id: &str,
        response: serde_json::Value,
    ) -> bool {
        let (reply, reply_rx) = oneshot::channel();
        let command = SessionCommand::AnswerUserInput {
            request_id: request_id.to_string(),
            response,
            reply,
        };
        self.send_command(agent, session_id, command).await.is_ok()
            && reply_rx.await.unwrap_or(false)
    }

    /// Cancel the in-flight prompt of a session. The prompt settles with the
    /// partial answer and a `stop` event carrying the cancel reason.
    pub async fn cancel(&self, agent: &str, session_id: &str) -> bool {
        let key = AgentSessionKey::new(agent, session_id);
        let Some(session) = self.sessions.lock().await.get(&key).cloned() else {
            return false;
        };
        session.tx.send(SessionCommand::Cancel).await.is_ok()
    }

    /// Cancel a subagent's current work (`session/cancel` on the child), when
    /// it advertises `cancel`; its pending requests settle cancelled.
    pub async fn cancel_child(
        &self,
        agent: &str,
        session_id: &str,
        child_session_id: &str,
    ) -> bool {
        let (reply, reply_rx) = oneshot::channel();
        let command = SessionCommand::CancelChild {
            session_id: child_session_id.to_string(),
            reply,
        };
        self.send_command(agent, session_id, command).await.is_ok()
            && reply_rx.await.unwrap_or(false)
    }

    /// Switch the session mode (`session/set_mode`), e.g. plan mode.
    pub async fn set_mode(&self, agent: &str, session_id: &str, mode_id: &str) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::SetMode {
                mode_id: mode_id.to_string(),
                reply: reply_tx,
            },
        )
        .await?;
        match reply_rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session closed before responding"),
        }
    }

    /// Set a session config option (`session/set_config_option`). Returns the
    /// refreshed config options reported by the agent.
    pub async fn set_config_option(
        &self,
        agent: &str,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<serde_json::Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::SetConfig {
                config_id: config_id.to_string(),
                value: value.to_string(),
                reply: reply_tx,
            },
        )
        .await?;
        match reply_rx.await {
            Ok(Ok(config_options)) => Ok(config_options),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session closed before responding"),
        }
    }

    async fn session(&self, agent: &str, session_id: &str) -> Result<AgentSession> {
        let key = AgentSessionKey::new(agent, session_id);
        self.sessions
            .lock()
            .await
            .get(&key)
            .filter(|session| !session.closing.is_cancelled())
            .cloned()
            .with_context(|| format!("Unknown {agent} ACP session: {session_id}"))
    }

    async fn send_command(
        &self,
        agent: &str,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<()> {
        let session = self.session(agent, session_id).await?;
        session
            .tx
            .send(command)
            .await
            .context("ACP agent session is closed")
    }

    pub async fn close_session(&self, agent: &str, session_id: &str) -> bool {
        let key = AgentSessionKey::new(agent, session_id);
        let Some(session) = self.sessions.lock().await.get(&key).cloned() else {
            return false;
        };
        // Keep it registered until the actor has released its ACP handle and
        // permission state. Concurrent close/load calls wait for the same
        // cleanup.
        session.closing.cancel();
        session.wait_closed().await;
        true
    }

    /// Gracefully close all active ACP sessions and shut down agent runtimes.
    pub async fn shutdown(&self) {
        self.shutting_down.cancel();

        let sessions: Vec<AgentSession> = {
            let sessions = self.sessions.lock().await;
            sessions.values().cloned().collect()
        };
        if !sessions.is_empty() {
            tracing::info!("Closing {} active ACP session(s)...", sessions.len());
            let mut closing = tokio::task::JoinSet::new();
            for session in sessions {
                session.closing.cancel();
                closing.spawn(async move {
                    session.wait_closed().await;
                });
            }
            if tokio::time::timeout(SHUTDOWN_SESSIONS_TIMEOUT, async {
                while closing.join_next().await.is_some() {}
            })
            .await
            .is_err()
            {
                tracing::warn!("Timed out closing active ACP sessions during shutdown");
            }
        }

        let runtimes: Vec<AcpRuntime> = {
            self.runtimes
                .lock()
                .expect("runtimes lock poisoned")
                .values()
                .cloned()
                .collect()
        };
        if !runtimes.is_empty() {
            let mut stopping = tokio::task::JoinSet::new();
            for runtime in runtimes {
                stopping.spawn(async move {
                    runtime.shutdown().await;
                });
            }
            while stopping.join_next().await.is_some() {}
        }
    }

    /// List sessions persisted by an ACP agent (`session/list`). This does not
    /// create live actors, so remote clients can discover a session first and
    /// explicitly load it afterwards.
    pub async fn list_sessions(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        cursor: Option<String>,
    ) -> Result<serde_json::Value> {
        let AgentConnection {
            connection,
            capabilities,
            ..
        } = self.runtime(agent).connection().await?;
        if capabilities.session_capabilities.list.is_none() {
            anyhow::bail!("{agent} does not support listing sessions");
        }
        let mut request = ListSessionsRequest::new();
        if let Some(cwd) = cwd {
            request = request.cwd(cwd);
        }
        if let Some(cursor) = cursor {
            request = request.cursor(cursor);
        }
        let response = connection
            .send_request_to(Agent, request)
            .block_task()
            .await?;
        Ok(to_json(response))
    }

    pub async fn delete_session(&self, agent: &str, session_id: &str) -> Result<()> {
        let AgentConnection {
            connection,
            capabilities,
            ..
        } = self.runtime(agent).connection().await?;
        if capabilities.session_capabilities.delete.is_none() {
            anyhow::bail!("{agent} does not support deleting sessions");
        }
        connection
            .send_request_to(
                Agent,
                DeleteSessionRequest::new(SessionId::from(session_id.to_string())),
            )
            .block_task()
            .await?;
        Ok(())
    }

    /// Fork a persisted session (`session/fork`) up to and including the agent
    /// message `message_id`. Like list and delete this creates no live actor;
    /// the client loads the new session afterwards.
    pub async fn fork_session(
        &self,
        agent: &str,
        session_id: &str,
        cwd: Option<PathBuf>,
        message_id: &str,
    ) -> Result<String> {
        let AgentConnection {
            connection,
            capabilities,
            ..
        } = self.runtime(agent).connection().await?;
        if capabilities.session_capabilities.fork.is_none() {
            anyhow::bail!("{agent} does not support forking sessions");
        }
        let request =
            ForkSessionRequest::new(SessionId::from(session_id.to_string()), resolve_cwd(cwd)?)
                .meta(fork_point_meta(message_id));
        let response = connection
            .send_request_to(Agent, request)
            .block_task()
            .await?;
        Ok(response.session_id.to_string())
    }
}

/// ACP has no fork point yet; claude-agent-acp reads the one JetBrains AIR
/// sends.
fn fork_point_meta(message_id: &str) -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::from_iter([(
        "jetbrains".to_string(),
        serde_json::json!({ "air": { "fork": { "version": 1, "messageId": message_id } } }),
    )])
}

/// Serialize a session update for the client, dropping image bytes from tool
/// output. Tool images (e.g. screenshots the agent read) arrive twice, in
/// `content` and `rawOutput`, at up to ~1MB each; the client does not render
/// them, and on load they clog the ordered Relay queue so later replies time
/// out.
fn update_to_json(update: SessionUpdate) -> serde_json::Value {
    let mut update = to_json(update);
    if matches!(
        update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str),
        Some("tool_call" | "tool_call_update")
    ) {
        for key in ["content", "rawOutput"] {
            if let Some(value) = update.get_mut(key) {
                omit_image_data(value);
            }
        }
    }
    update
}

/// Remove base64 payloads from both the ACP (`{type, data, mimeType}`) and the
/// Claude (`{type, source: {data, media_type}}`) image shapes.
fn omit_image_data(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("type").and_then(serde_json::Value::as_str) == Some("image") {
                map.remove("data");
                if let Some(serde_json::Value::Object(source)) = map.get_mut("source") {
                    source.remove("data");
                }
                return;
            }
            map.values_mut().for_each(omit_image_data);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(omit_image_data),
        _ => {}
    }
}

fn to_json(value: impl Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or_else(|err| {
        serde_json::json!({
            "serializationError": err.to_string()
        })
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{input_request_session, runtime::system_prompt_meta, update_to_json};

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

    #[test]
    fn system_prompt_meta_targets_standard_and_antigravity_keys() {
        let meta = system_prompt_meta("mobile context");
        assert_eq!(
            meta["systemPrompt"],
            serde_json::json!({ "append": "mobile context" })
        );
        assert_eq!(
            meta["antigravity"],
            serde_json::json!({ "systemPrompt": { "append": "mobile context" } })
        );
    }

    #[test]
    fn tool_updates_omit_image_data() {
        let update = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "t1",
            "content": [{ "type": "content", "content": { "type": "image", "data": "AAAA", "mimeType": "image/png" } }],
            "rawOutput": [{ "type": "image", "source": { "type": "base64", "data": "AAAA", "media_type": "image/png" } }],
        }))
        .unwrap();
        let json = update_to_json(update);
        assert_eq!(
            json["content"][0]["content"],
            serde_json::json!({ "type": "image", "mimeType": "image/png" })
        );
        assert_eq!(
            json["rawOutput"][0],
            serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png" } })
        );
    }
}
