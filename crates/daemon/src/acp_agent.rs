use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

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
mod meta;
mod provision;
mod runtime;
mod session;

#[cfg(test)]
mod lifecycle_tests;

pub use catalog::custom_agent_list;
pub(crate) use meta::SessionMetaStore;
use provision::prepare_agent_command;
use runtime::{AcpRuntime, AgentConnection, StartedSession};
use session::{SessionExit, run_session_actor};

fn resolve_cwd(cwd: Option<PathBuf>) -> Result<PathBuf> {
    match cwd {
        Some(cwd) => Ok(cwd),
        None => std::env::current_dir().context("failed to resolve current directory"),
    }
}

/// Unique epoch string per live `SessionActor` instance, incorporating process
/// boot time so daemon restarts never collide with previous epochs.
fn next_epoch() -> String {
    static BOOT_ID: OnceLock<u128> = OnceLock::new();
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let boot = *BOOT_ID.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    });
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{boot}-{id}")
}

/// Sends a `(method, params)` notification to one client device.
pub type Notifier = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Push callback used by unattended scheduled task runs when a permission
/// request or question is raised.
pub type TaskInputPush = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// A subscribed client peer receiving live events and prompt suggestions for a
/// session.
#[derive(Clone)]
pub struct SessionSubscriber {
    pub peer_id: u64,
    pub notifier: Notifier,
}

/// Session-level state change broadcast to all connected peers (running status,
/// completion, error, updated metadata).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateUpdate {
    pub agent: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub running: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Global observer wired by `AgentService` to broadcast session lifecycle and
/// user-input events to all connected peers and trigger pushes.
pub trait SessionObserver: Send + Sync {
    fn on_state(&self, update: SessionStateUpdate);
    fn on_user_input(
        &self,
        input: &UserInput,
        originator_peer_id: Option<u64>,
        task_push: Option<&TaskInputPush>,
    );
    fn on_user_input_resolved(&self, agent: &str, session_id: &str, request_id: &str);
    fn on_session_ended(&self, agent: &str, session_id: &str);
    fn on_session_deleted(&self, agent: &str, session_id: &str);
    fn on_session_unread(&self, agent: &str, session_id: &str, unread: bool);
}

/// A request waiting for the user, sent to devices as the `method`
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

/// Client-specific setup sent with `session/new` / `session/load`.
#[derive(Clone, Default)]
pub struct SessionContext {
    pub system_prompt: Option<String>,
    pub skills: SkillSelection,
    /// Permission requests and questions unanswered for this long are refused
    /// (unattended runs); without it they wait until the turn ends.
    pub input_timeout: Option<Duration>,
    /// Automatically approve permission requests with their allow option
    /// (unattended runs).
    pub auto_approve: bool,
    /// Push callback for unattended scheduled task runs when a permission
    /// request or question is raised.
    pub task_push: Option<TaskInputPush>,
}

/// Snapshot returned after creating a fresh ACP session actor.
pub struct SessionReady {
    pub session_id: String,
    pub epoch: String,
    pub seq: u64,
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

/// Snapshot + coalesced event replay returned by idempotent `open_session`.
pub struct SessionOpenResult {
    pub session_id: String,
    pub epoch: String,
    pub seq: u64,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub modes: Option<serde_json::Value>,
    pub config_options: Option<serde_json::Value>,
    pub running: bool,
    pub user_inputs: Vec<UserInput>,
    pub suggestion: Option<String>,
    pub events: Vec<SequencedEvent>,
    pub full_replay: bool,
    pub fresh_load: bool,
}

/// Summary of an active running session returned by `active_sessions`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionInfo {
    pub agent: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Metadata for a newly forked session returned by `fork_session`.
#[derive(Debug, Clone)]
pub struct ForkedSession {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: String,
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
#[derive(Clone)]
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

fn is_false(value: &bool) -> bool {
    !*value
}

/// A sequenced event stored in `SessionActor`'s authoritative event buffer and
/// delivered to subscribed clients.
#[derive(Debug, Clone, Serialize)]
pub struct SequencedEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: AgentEvent,
}

/// Session events stored in the actor's log and forwarded to subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionUpdate {
        update: serde_json::Value,
        #[serde(rename = "childSessionId", skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
    },
    TurnStarted,
    TurnEnded {
        #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
        stop_reason: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

/// Parameters for starting a prompt turn on an active session.
pub struct PromptOptions {
    pub prompt: String,
    pub attachments: Vec<Attachment>,
    pub voice_chat: bool,
    pub client_message_id: Option<String>,
    pub timeout_secs: u64,
    pub originator_peer_id: Option<u64>,
    pub subscriber: Option<SessionSubscriber>,
}

/// Outcome of a prompt turn once it settles.
pub struct PromptCompletion {
    pub result: Result<String>,
    pub cancelled: bool,
}

/// Handle returned immediately by `start_prompt`; `completion` resolves when
/// the turn finishes (used by `Tasks` and push notification delivery).
pub struct PromptHandle {
    pub completion: oneshot::Receiver<PromptCompletion>,
}

/// A session update of a subagent session, routed to its root session.
struct ChildUpdate {
    session_id: String,
    update: SessionUpdate,
}

/// Error code for ACP errors that the client handles specially.
pub(crate) fn acp_error_code(err: &agent_client_protocol::Error) -> Option<&'static str> {
    (err.code == agent_client_protocol::ErrorCode::AuthRequired).then_some("auth_required")
}

/// Error code extracted from an `anyhow::Error` chain.
pub(crate) fn anyhow_error_code(err: &anyhow::Error) -> Option<&'static str> {
    err.chain()
        .filter_map(|cause| cause.downcast_ref::<agent_client_protocol::Error>())
        .find_map(acp_error_code)
}

type SessionMap = Arc<Mutex<HashMap<AgentSessionKey, AgentSession>>>;

const SHUTDOWN_SESSIONS_TIMEOUT: Duration = Duration::from_secs(2);
const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
pub struct AgentSessionManager {
    sessions: SessionMap,
    /// Created on first use so agents added by the fetched registry can launch.
    runtimes: Arc<std::sync::Mutex<HashMap<String, AcpRuntime>>>,
    observer: Option<Arc<dyn SessionObserver>>,
    meta: Arc<SessionMetaStore>,
    idle_timeout: Duration,
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

/// Published by the actor for lock-free queries (`active_sessions`,
/// `pending_user_inputs`, concurrent open checks).
#[derive(Clone, Default)]
struct SessionStatus {
    ready: bool,
    /// A prompt turn runs, until the agent ends it.
    busy: bool,
    cwd: Option<String>,
    title: Option<String>,
    updated_at: Option<String>,
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

struct PromptTurn {
    prompt: String,
    attachments: Vec<Attachment>,
    voice_chat: bool,
    client_message_id: Option<String>,
    originator_peer_id: Option<u64>,
    subscriber: Option<SessionSubscriber>,
    idle_timeout: Duration,
    accepted: oneshot::Sender<Result<()>>,
    completion: oneshot::Sender<PromptCompletion>,
}

enum SessionCommand {
    Prompt(PromptTurn),
    Cancel,
    Subscribe {
        subscriber: Option<SessionSubscriber>,
        since_epoch: Option<String>,
        since_seq: u64,
        reply: oneshot::Sender<SessionOpenResult>,
    },
    Unsubscribe {
        peer_id: u64,
    },
    UnsubscribeAll,
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

enum StartOutcome {
    Created(SessionReady),
    Opened(SessionOpenResult),
}

impl AgentSessionManager {
    #[cfg(test)]
    pub fn new(observer: Option<Arc<dyn SessionObserver>>) -> Self {
        Self::with_meta(observer, SessionMetaStore::in_memory())
    }

    pub(crate) fn with_meta(
        observer: Option<Arc<dyn SessionObserver>>,
        meta: Arc<SessionMetaStore>,
    ) -> Self {
        Self {
            sessions: Arc::default(),
            runtimes: Arc::default(),
            observer,
            meta,
            idle_timeout: DEFAULT_SESSION_IDLE_TIMEOUT,
            shutting_down: CancellationToken::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
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
        subscriber: Option<SessionSubscriber>,
    ) -> Result<SessionReady> {
        match self
            .start_session(agent, cwd, None, context, subscriber)
            .await?
        {
            StartOutcome::Created(ready) => Ok(ready),
            StartOutcome::Opened(_) => unreachable!("create_session never returns Opened"),
        }
    }

    /// Idempotently open and subscribe to a session. If a live actor already
    /// exists, attaches the subscriber and replays coalesced events (either
    /// incrementally when `since_epoch` matches and `since_seq <= seq`, or
    /// full replay otherwise). Otherwise loads the session from ACP.
    #[allow(clippy::too_many_arguments)]
    pub async fn open_session(
        &self,
        agent: &str,
        session_id: &str,
        cwd: Option<PathBuf>,
        context: SessionContext,
        subscriber: Option<SessionSubscriber>,
        since_epoch: Option<String>,
        since_seq: u64,
    ) -> Result<SessionOpenResult> {
        let key = AgentSessionKey::new(agent, session_id);
        loop {
            let existing = {
                let sessions = self.sessions.lock().await;
                if self.shutting_down.is_cancelled() {
                    anyhow::bail!("Daemon is shutting down");
                }
                sessions.get(&key).cloned()
            };
            if let Some(session) = existing {
                if session.closing.is_cancelled() {
                    session.wait_closed().await;
                    continue;
                }
                let (reply, reply_rx) = oneshot::channel();
                let sent = session
                    .tx
                    .send(SessionCommand::Subscribe {
                        subscriber: subscriber.clone(),
                        since_epoch: since_epoch.clone(),
                        since_seq,
                        reply,
                    })
                    .await;
                if sent.is_ok()
                    && let Ok(opened) = reply_rx.await
                {
                    return Ok(opened);
                }
                // The actor closed while we tried to subscribe. Only loop to
                // reload if it had already been ready (e.g. reclaimed idle);
                // if an in-flight load failed, propagate an error instead of
                // triggering a second failing load.
                let was_ready = session.status.borrow().ready;
                session.wait_closed().await;
                if was_ready {
                    continue;
                }
                anyhow::bail!("ACP agent session stopped before it was ready");
            }

            // Try to claim and load from ACP.
            match self
                .start_session(
                    agent,
                    cwd.clone(),
                    Some(SessionId::from(session_id.to_string())),
                    context.clone(),
                    subscriber.clone(),
                )
                .await
            {
                Ok(StartOutcome::Opened(opened)) => return Ok(opened),
                Ok(StartOutcome::Created(_)) => {
                    unreachable!("open_session load never returns Created")
                }
                Err(err) if err.downcast_ref::<AlreadyActive>().is_some() => {
                    // Another caller claimed the slot right before us; loop to
                    // subscribe to it.
                    continue;
                }
                Err(err) => return Err(err),
            }
        }
    }

    async fn start_session(
        &self,
        agent: &str,
        cwd: Option<PathBuf>,
        load: Option<SessionId>,
        context: SessionContext,
        subscriber: Option<SessionSubscriber>,
    ) -> Result<StartOutcome> {
        if self.shutting_down.is_cancelled() {
            anyhow::bail!("Daemon is shutting down");
        }
        let cwd = resolve_cwd(cwd)?;
        let (tx, rx) = mpsc::channel(32);
        let (child_tx, child_rx) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(SessionStatus {
            cwd: Some(cwd.to_string_lossy().into_owned()),
            ..SessionStatus::default()
        });
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
        if let Some(session_id) = &load {
            let key = AgentSessionKey::new(agent, &session_id.to_string());
            let mut sessions = self.sessions.lock().await;
            if self.shutting_down.is_cancelled() {
                anyhow::bail!("Daemon is shutting down");
            }
            if sessions.contains_key(&key) {
                return Err(anyhow::Error::new(AlreadyActive));
            }
            sessions.insert(key, handle.clone());
        }

        let (ready_tx, ready_rx) = oneshot::channel();
        let runtime = self.runtime(agent);
        let epoch = next_epoch();
        let actor = run_session_actor(
            cwd,
            load,
            context,
            subscriber,
            epoch,
            self.idle_timeout,
            self.observer.clone(),
            self.meta.clone(),
            runtime.clone(),
            rx,
            child_rx,
            status_tx,
            ready_tx,
            handle.closing.clone(),
        );
        let sessions = self.sessions.clone();
        let observer = self.observer.clone();
        let actor_handle = handle.clone();
        tokio::spawn(async move {
            let exit = actor.await;
            let mut sessions = sessions.lock().await;
            let key = sessions
                .iter()
                .find(|(_, session)| session.tx.same_channel(&actor_handle.tx))
                .map(|(key, _)| key.clone());
            if let Some(key) = key {
                sessions.remove(&key);
                runtime.forget_children(&key.session_id);
                // Only unexpected runtime/connection failures broadcast
                // `agent_session_ended`. Explicit close and idle reclamation
                // exit quietly.
                if exit == SessionExit::Failed
                    && let Some(observer) = observer
                {
                    observer.on_session_ended(&key.agent, &key.session_id);
                }
            }
            // Under the lock, so registering a created session sees it.
            stopped_tx.send_replace(true);
        });

        // Readiness is bounded by the caller's timeout, not here.
        let outcome = match ready_rx.await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP agent session stopped before it was ready"),
        };
        if creating {
            let session_id = match &outcome {
                StartOutcome::Created(ready) => ready.session_id.clone(),
                StartOutcome::Opened(opened) => opened.session_id.clone(),
            };
            // The agent assigned the session id.
            let mut sessions = self.sessions.lock().await;
            if self.shutting_down.is_cancelled() {
                anyhow::bail!("Daemon is shutting down");
            }
            if *handle.stopped.borrow() {
                anyhow::bail!("ACP agent session stopped before it was ready");
            }
            sessions.insert(AgentSessionKey::new(agent, &session_id), handle);
        }
        close_on_drop.disarm();
        Ok(outcome)
    }

    /// Start a prompt turn on an active session and return immediately once
    /// accepted by the actor. Events stream to all subscribed peers; the
    /// returned `PromptHandle::completion` resolves when the turn finishes.
    pub async fn start_prompt(
        &self,
        agent: &str,
        session_id: &str,
        options: PromptOptions,
    ) -> Result<PromptHandle> {
        let (accepted, accepted_rx) = oneshot::channel();
        let (completion, completion_rx) = oneshot::channel();
        self.send_command(
            agent,
            session_id,
            SessionCommand::Prompt(PromptTurn {
                prompt: options.prompt,
                attachments: options.attachments,
                voice_chat: options.voice_chat,
                client_message_id: options.client_message_id,
                originator_peer_id: options.originator_peer_id,
                subscriber: options.subscriber,
                idle_timeout: Duration::from_secs(options.timeout_secs),
                accepted,
                completion,
            }),
        )
        .await?;
        match accepted_rx.await {
            Ok(Ok(())) => Ok(PromptHandle {
                completion: completion_rx,
            }),
            Ok(Err(err)) => Err(err),
            Err(_) => anyhow::bail!("ACP agent session closed before accepting prompt"),
        }
    }

    /// Remove `peer_id` from a session's subscribers without closing or
    /// cancelling the session.
    pub async fn unsubscribe_session(&self, agent: &str, session_id: &str, peer_id: u64) {
        let key = AgentSessionKey::new(agent, session_id);
        let session = self.sessions.lock().await.get(&key).cloned();
        if let Some(session) = session {
            let _ = session
                .tx
                .send(SessionCommand::Unsubscribe { peer_id })
                .await;
        }
    }

    /// Remove `peer_id` from every active session (called when a peer
    /// disconnects or reconnects on a fresh socket).
    pub async fn unsubscribe_peer(&self, peer_id: u64) {
        let sessions: Vec<AgentSession> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            let _ = session
                .tx
                .send(SessionCommand::Unsubscribe { peer_id })
                .await;
        }
    }

    /// Clear all subscribers across every active session (called when the host
    /// loses its relay connection).
    pub async fn unsubscribe_all_peers(&self) {
        let sessions: Vec<AgentSession> = self.sessions.lock().await.values().cloned().collect();
        for session in sessions {
            let _ = session.tx.send(SessionCommand::UnsubscribeAll).await;
        }
    }

    /// Sessions with a prompt currently running, for populating client session
    /// lists and reconnecting clients.
    pub async fn active_sessions(&self) -> Vec<ActiveSessionInfo> {
        self.sessions
            .lock()
            .await
            .iter()
            .filter_map(|(key, session)| {
                let status = session.status.borrow();
                status.busy.then(|| ActiveSessionInfo {
                    agent: key.agent.clone(),
                    session_id: key.session_id.clone(),
                    cwd: status.cwd.clone(),
                    title: status.title.clone(),
                    updated_at: status.updated_at.clone(),
                })
            })
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

    /// Cancel the in-flight prompt of a session. The turn settles with the
    /// partial answer and a `turn_ended` event carrying the cancel reason.
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
        // permission state. Concurrent close/open calls wait for the same
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
        Ok(self.meta.annotate_list(agent, to_json(response)))
    }

    pub async fn delete_session(&self, agent: &str, session_id: &str) -> Result<()> {
        // Release any live actor (and running turn) before asking the agent to
        // delete storage.
        self.close_session(agent, session_id).await;
        self.meta.mark_deleted(agent, session_id);
        match self.runtime(agent).connection().await {
            Ok(AgentConnection {
                connection,
                capabilities,
                ..
            }) if capabilities.session_capabilities.delete.is_some() => {
                if let Err(err) = connection
                    .send_request_to(
                        Agent,
                        DeleteSessionRequest::new(SessionId::from(session_id.to_string())),
                    )
                    .block_task()
                    .await
                {
                    tracing::warn!("ACP session/delete failed for {agent}/{session_id}: {err}");
                }
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    "Skipping ACP session/delete for {agent}/{session_id} (agent unavailable): \
                     {err}"
                );
            }
        }
        if let Some(observer) = &self.observer {
            observer.on_session_deleted(agent, session_id);
        }
        Ok(())
    }

    /// Persist `unread` state for a session and broadcast the change to all
    /// connected devices. Works without loading an ACP actor.
    pub fn set_session_unread(&self, agent: &str, session_id: &str, unread: bool) {
        self.meta.set_unread(agent, session_id, unread);
        if let Some(observer) = &self.observer {
            observer.on_session_unread(agent, session_id, unread);
        }
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
    ) -> Result<ForkedSession> {
        let AgentConnection {
            connection,
            capabilities,
            ..
        } = self.runtime(agent).connection().await?;
        if capabilities.session_capabilities.fork.is_none() {
            anyhow::bail!("{agent} does not support forking sessions");
        }
        let parent_title = {
            let key = AgentSessionKey::new(agent, session_id);
            let live_title = self
                .sessions
                .lock()
                .await
                .get(&key)
                .and_then(|session| session.status.borrow().title.clone());
            live_title.or_else(|| self.meta.get(agent, session_id).title)
        };
        let request =
            ForkSessionRequest::new(SessionId::from(session_id.to_string()), resolve_cwd(cwd)?)
                .meta(fork_point_meta(message_id));
        let response = connection
            .send_request_to(Agent, request)
            .block_task()
            .await?;
        let forked_id = response.session_id.to_string();
        let title = parent_title.map(|t| format!("{t} (fork)"));
        let updated_at = meta::now_iso();
        let recorded = self
            .meta
            .record_created(agent, &forked_id, title.as_deref(), &updated_at);
        Ok(ForkedSession {
            session_id: forked_id,
            title: recorded.title,
            updated_at: recorded.updated_at.unwrap_or(updated_at),
        })
    }
}

#[derive(Debug)]
struct AlreadyActive;

impl std::fmt::Display for AlreadyActive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ACP session is already active")
    }
}

impl std::error::Error for AlreadyActive {}

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
    use super::{runtime::system_prompt_meta, update_to_json};

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
