use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agent_client_protocol::{
    AcpAgent, ActiveSession, Agent, Client, ConnectionTo, JsonRpcNotification, SessionMessage,
    schema::{
        ProtocolVersion,
        v1::{
            AgentCapabilities, CancelNotification, ClientCapabilities as AcpClientCapabilities,
            CloseSessionRequest, ContentBlock, ContentChunk, CreateElicitationRequest,
            CreateElicitationResponse, DeleteSessionRequest, ElicitationAction,
            ElicitationCapabilities, ElicitationFormCapabilities, ElicitationScope, ImageContent,
            Implementation, InitializeRequest, ListSessionsRequest, LoadSessionRequest,
            NewSessionRequest, PermissionOptionId, PromptRequest, PromptResponse,
            RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
            ResourceLink, SelectedPermissionOutcome, SessionConfigId, SessionConfigValueId,
            SessionId, SessionModeId, SessionNotification, SessionUpdate,
            SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent,
        },
    },
    util::MatchDispatch,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::render_skills::{self, ClientCapabilities};

mod catalog;
mod provision;

#[cfg(test)]
mod lifecycle_tests;

pub use catalog::available_agents;
use provision::prepare_agent_command;

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

/// Raw Claude Agent SDK message forwarded by claude-agent-acp when the session
/// opts in through `_meta.claudeCode.emitRawSDKMessages`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_claude/sdkMessage")]
struct ClaudeSdkMessage {
    #[serde(rename = "sessionId")]
    session_id: String,
    message: serde_json::Value,
}

/// Client-specific setup sent with `session/new` / `session/load`.
#[derive(Clone, Default)]
pub struct SessionContext {
    pub system_prompt: Option<String>,
    pub client_capabilities: ClientCapabilities,
    /// The device creating or loading the session; see `SessionActor::notifier`.
    pub notifier: Option<Notifier>,
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

/// An initialized ACP connection and the capabilities the agent advertised.
#[derive(Clone)]
struct AgentConnection {
    connection: ConnectionTo<Agent>,
    capabilities: Arc<AgentCapabilities>,
}

/// Lazily starts one ACP subprocess and shares its connection across sessions.
/// A failed connection is discarded and started again on the next API call.
struct RuntimeState {
    connection: Option<AgentConnection>,
    connecting: bool,
    generation: u64,
    waiters: Vec<oneshot::Sender<Result<AgentConnection, String>>>,
}

struct StartedSession {
    session: ActiveSession<'static, Agent>,
    ready: SessionReady,
    disconnects: watch::Receiver<u64>,
    generation: u64,
    close_supported: bool,
}

#[derive(Clone)]
struct AcpRuntime {
    agent: String,
    state: Arc<Mutex<RuntimeState>>,
    /// The manager's live sessions, to route agent requests to their actor.
    sessions: SessionMap,
    disconnects: watch::Sender<u64>,
}

impl AcpRuntime {
    fn new(agent: String, sessions: SessionMap) -> Self {
        let (disconnects, _) = watch::channel(0);
        Self {
            agent,
            state: Arc::new(Mutex::new(RuntimeState {
                connection: None,
                connecting: false,
                generation: 0,
                waiters: Vec::new(),
            })),
            sessions,
            disconnects,
        }
    }

    async fn connection(&self) -> Result<AgentConnection> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let generation = {
            let mut state = self.state.lock().await;
            if let Some(connection) = &state.connection {
                return Ok(connection.clone());
            }
            state.waiters.push(reply_tx);
            if state.connecting {
                None
            } else {
                state.connecting = true;
                state.generation += 1;
                Some(state.generation)
            }
        };
        if let Some(generation) = generation {
            self.spawn_connection(generation);
        }
        match reply_rx.await {
            Ok(Ok(connection)) => Ok(connection),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP runtime stopped while connecting"),
        }
    }

    fn spawn_connection(&self, generation: u64) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let result = runtime.serve_connection(generation).await;
            let error = result
                .err()
                .map(|err| err.to_string())
                .unwrap_or_else(|| "ACP agent connection stopped".to_string());
            tracing::warn!("{error}");
            runtime.connection_stopped(generation, error).await;
        });
    }

    async fn serve_connection(&self, generation: u64) -> Result<()> {
        catalog::refresh_registry();
        let agent = self.agent.clone();
        let command = tokio::task::spawn_blocking(move || {
            prepare_agent_command(catalog::agent_candidate(&agent)?)
        })
        .await
        .context("ACP runtime preparation task failed")??;
        tracing::info!("Starting {} ACP agent: {}", self.agent, command.join(" "));
        // `from_args` treats leading `NAME=value` args as env overrides for the
        // spawned subprocess.
        let acp_agent =
            AcpAgent::from_args(command).context("failed to configure ACP agent command")?;
        self.connect_agent(generation, acp_agent).await
    }

    async fn connect_agent(
        &self,
        generation: u64,
        agent: impl agent_client_protocol::ConnectTo<Client>,
    ) -> Result<()> {
        let permission_runtime = self.clone();
        let elicitation_runtime = self.clone();
        let suggestion_runtime = self.clone();
        let runtime = self.clone();

        Client
            .builder()
            .name("agentdeck")
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, connection| {
                    let runtime = permission_runtime.clone();
                    connection.spawn(async move {
                        let session_id = request.session_id.to_string();
                        let payload = serde_json::json!({
                            "agent": runtime.agent,
                            "sessionId": session_id,
                            "toolCall": to_json(request.tool_call),
                            "options": to_json(request.options),
                        });
                        let option_id = runtime
                            .wait_user_input(&session_id, UserInput::Permission(payload))
                            .await
                            .and_then(|response| {
                                response.get("optionId")?.as_str().map(str::to_string)
                            });
                        let outcome = match option_id {
                            Some(option_id) => RequestPermissionOutcome::Selected(
                                SelectedPermissionOutcome::new(PermissionOptionId::from(option_id)),
                            ),
                            None => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: CreateElicitationRequest, responder, connection| {
                    let runtime = elicitation_runtime.clone();
                    connection.spawn(async move {
                        // Only form mode is advertised, and its requests are session-scoped.
                        let ElicitationScope::Session(scope) = request.scope() else {
                            return responder.respond(CreateElicitationResponse::new(
                                ElicitationAction::Cancel,
                            ));
                        };
                        let session_id = scope.session_id.to_string();
                        let mut payload = to_json(&request);
                        payload["agent"] = runtime.agent.clone().into();
                        let response = runtime
                            .wait_user_input(&session_id, UserInput::Elicitation(payload))
                            .await
                            .and_then(|response| serde_json::from_value(response).ok())
                            .unwrap_or_else(|| {
                                CreateElicitationResponse::new(ElicitationAction::Cancel)
                            });
                        responder.respond(response)
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            // Registered before session routing, so it also sees the suggestion
            // that arrives after the turn while no prompt reads session updates.
            .on_receive_notification(
                async move |notification: ClaudeSdkMessage, _connection| {
                    if let Some(suggestion) = prompt_suggestion(&notification.message) {
                        // Never wait for the actor here: this handler runs on the
                        // connection's dispatch loop, which the actor may be
                        // waiting on.
                        if let Some(tx) = suggestion_runtime
                            .session_tx(&notification.session_id)
                            .await
                        {
                            let _ = tx.try_send(SessionCommand::Suggestion(suggestion));
                        }
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
                // Form elicitation lets Claude ask the user (`AskUserQuestion`).
                let capabilities = AcpClientCapabilities::new().elicitation(
                    ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                );
                let request = InitializeRequest::new(ProtocolVersion::V1)
                    .client_capabilities(capabilities)
                    .client_info(
                        Implementation::new("agentdeck", env!("CARGO_PKG_VERSION"))
                            .title("AgentDeck"),
                    );
                let response = connection.send_request(request).block_task().await?;
                if response.protocol_version != ProtocolVersion::V1 {
                    return Err(agent_client_protocol::Error::internal_error().data(format!(
                        "Unsupported ACP protocol version: {:?}",
                        response.protocol_version
                    )));
                }
                tracing::info!("ACP agent capabilities: {:?}", response.agent_capabilities);
                let agent_connection = AgentConnection {
                    connection: connection.clone(),
                    capabilities: Arc::new(response.agent_capabilities),
                };
                runtime.connection_ready(generation, agent_connection).await;
                // The SDK can keep a connect_with foreground task alive after EOF.
                // End ours explicitly so the runtime discards the dead connection.
                connection.incoming_closed().await;
                Err(agent_client_protocol::Error::internal_error()
                    .data("ACP agent connection closed"))
            })
            .await
            .context("ACP agent connection failed")
    }

    async fn connection_ready(&self, generation: u64, connection: AgentConnection) {
        let waiters = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.connection = Some(connection.clone());
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Ok(connection.clone()));
        }
    }

    async fn connection_stopped(&self, generation: u64, error: String) {
        let waiters = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.connection = None;
            state.connecting = false;
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Err(error.clone()));
        }
        let _ = self.disconnects.send(generation);
    }

    async fn start_session(
        &self,
        cwd: PathBuf,
        load: Option<SessionId>,
        context: SessionContext,
    ) -> Result<StartedSession> {
        let AgentConnection {
            connection,
            capabilities,
        } = self.connection().await?;
        let generation = self.state.lock().await.generation;
        // Agents ignore `_meta` keys they don't know, so no per-agent check.
        let mut meta = context
            .system_prompt
            .as_deref()
            .map(system_prompt_meta)
            .unwrap_or_default();
        meta.insert("claudeCode".to_string(), claude_code_meta());
        let directories = if capabilities
            .session_capabilities
            .additional_directories
            .is_some()
        {
            render_skills::skill_directories(&context.client_capabilities)
        } else {
            Vec::new()
        };
        let (session, ready): (ActiveSession<'static, Agent>, SessionReady) = match load {
            Some(session_id) => {
                if !capabilities.load_session {
                    anyhow::bail!("{} does not support loading sessions", self.agent);
                }
                let request = LoadSessionRequest::new(session_id.clone(), cwd)
                    .additional_directories(directories)
                    .meta(meta);
                let (session, response) = connection
                    .load_session_from(request)
                    .block_task()
                    .start_session()
                    .await?
                    .into_parts();
                let (title, updated_at) = session_metadata_from_meta(response.meta.as_ref());
                let ready = SessionReady {
                    session_id: session_id.to_string(),
                    title,
                    updated_at,
                    modes: response.modes.as_ref().map(to_json),
                    config_options: response.config_options.as_ref().map(to_json),
                };
                (session, ready)
            }
            None => {
                let request = NewSessionRequest::new(cwd)
                    .additional_directories(directories)
                    .meta(meta);
                let session = connection
                    .build_session_from(request)
                    .block_task()
                    .start_session()
                    .await?;
                let (title, updated_at) = session_metadata_from_meta(session.meta());
                let ready = SessionReady {
                    session_id: session.session_id().to_string(),
                    title,
                    updated_at,
                    modes: session.modes().map(to_json),
                    config_options: session.config_options().map(to_json),
                };
                (session, ready)
            }
        };
        Ok(StartedSession {
            session,
            ready,
            disconnects: self.disconnects.subscribe(),
            generation,
            close_supported: capabilities.session_capabilities.close.is_some(),
        })
    }

    async fn session_tx(&self, session_id: &str) -> Option<mpsc::Sender<SessionCommand>> {
        let key = AgentSessionKey::new(&self.agent, session_id);
        Some(self.sessions.lock().await.get(&key)?.tx.clone())
    }

    /// Show a request on the session's device and wait until a device answers
    /// it through `answer_user_input`; delivery is not the answer, so a device
    /// that reloaded can still answer. `None` when it is cancelled: no turn
    /// runs, the turn is cancelled or ends, or the session closes.
    async fn wait_user_input(
        &self,
        session_id: &str,
        input: UserInput,
    ) -> Option<serde_json::Value> {
        let tx = self.session_tx(session_id).await?;
        let (answer, answer_rx) = oneshot::channel();
        tx.send(SessionCommand::UserInput { input, answer })
            .await
            .ok()?;
        answer_rx.await.ok()
    }
}

fn session_metadata_from_meta(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> (Option<String>, Option<String>) {
    let string = |key| {
        meta.and_then(|meta| meta.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    (string("title"), string("updatedAt"))
}

fn system_prompt_meta(prompt: &str) -> serde_json::Map<String, serde_json::Value> {
    serde_json::Map::from_iter([(
        "systemPrompt".to_string(),
        serde_json::json!({ "append": prompt }),
    )])
}

/// Enable Claude's next-prompt suggestions and forward only those raw SDK
/// messages; claude-agent-acp drops them otherwise.
fn claude_code_meta() -> serde_json::Value {
    serde_json::json!({
        "options": { "promptSuggestions": true },
        "emitRawSDKMessages": [{ "type": "prompt_suggestion" }],
    })
}

fn prompt_suggestion(message: &serde_json::Value) -> Option<String> {
    if message.get("type")?.as_str()? != "prompt_suggestion" {
        return None;
    }
    message
        .get("suggestion")?
        .as_str()
        .map(str::trim)
        .filter(|suggestion| !suggestion.is_empty())
        .map(str::to_string)
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
/// update payload (text chunks included); `stop` terminates the prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum AgentEvent {
    SessionUpdate { update: serde_json::Value },
    Stop { stop_reason: serde_json::Value },
}

pub type SessionEndCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

type SessionMap = Arc<Mutex<HashMap<AgentSessionKey, AgentSession>>>;

#[derive(Clone)]
pub struct AgentSessionManager {
    sessions: SessionMap,
    /// Created on first use so agents added by the fetched registry can launch.
    runtimes: Arc<std::sync::Mutex<HashMap<String, AcpRuntime>>>,
    on_end: Option<SessionEndCallback>,
}

/// Handle to a session actor.
#[derive(Clone)]
struct AgentSession {
    tx: mpsc::Sender<SessionCommand>,
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
    /// The unanswered request, kept so a reloaded or reconnected device can
    /// show it again.
    pending_input: Option<UserInput>,
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
    /// The prompting device, which gets the session's notifications from now on.
    notifier: Option<Notifier>,
    idle_timeout: std::time::Duration,
    reply: oneshot::Sender<Result<String, String>>,
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
    Suggestion(String),
}

impl AgentSessionManager {
    pub fn new(on_end: Option<SessionEndCallback>) -> Self {
        Self {
            sessions: Arc::default(),
            runtimes: Arc::default(),
            on_end,
        }
    }

    fn runtime(&self, agent: &str) -> AcpRuntime {
        self.runtimes
            .lock()
            .expect("runtimes lock poisoned")
            .entry(agent.to_string())
            .or_insert_with(|| AcpRuntime::new(agent.to_string(), self.sessions.clone()))
            .clone()
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
        let cwd = resolve_cwd(cwd)?;
        let (tx, rx) = mpsc::channel(8);
        let (status_tx, status) = watch::channel(SessionStatus::default());
        let (stopped_tx, stopped) = watch::channel(false);
        let handle = AgentSession {
            tx,
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
        let actor = run_session_actor(
            cwd,
            load,
            context,
            self.runtime(agent),
            rx,
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
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(err)) => anyhow::bail!(err),
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
            .filter_map(|session| session.status.borrow().pending_input.clone())
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
        // permission state. Concurrent close/load calls wait for the same cleanup.
        session.closing.cancel();
        session.wait_closed().await;
        true
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
}

/// Start a session with the agent, report ready, then serve its commands and
/// updates until it is closed or the connection stops. Returns whether it
/// became ready.
#[allow(clippy::too_many_arguments)]
async fn run_session_actor(
    cwd: PathBuf,
    load: Option<SessionLoad>,
    context: SessionContext,
    runtime: AcpRuntime,
    mut rx: mpsc::Receiver<SessionCommand>,
    status: watch::Sender<SessionStatus>,
    ready_tx: oneshot::Sender<Result<SessionReady, String>>,
    closing: CancellationToken,
) -> bool {
    let (load, replay_tx) = load.unzip();
    let notifier = context.notifier.clone();
    let started = tokio::select! {
        result = runtime.start_session(cwd, load, context) => result,
        _ = closing.cancelled() => return false,
    };
    let StartedSession {
        mut session,
        mut ready,
        mut disconnects,
        generation: connection_generation,
        close_supported,
    } = match started {
        Ok(started) => started,
        Err(err) => {
            tracing::info!("ACP session failed to start: {err}");
            let _ = ready_tx.send(Err(err.to_string()));
            return false;
        }
    };
    let mut actor = SessionActor {
        agent: runtime.agent.clone(),
        session_id: ready.session_id.clone(),
        notifier,
        status,
        turn: None,
        pending_input: None,
    };
    let mut was_ready = false;
    let run = async {
        // The load-time history replay is routed to the session before the load
        // response; forward it before reporting ready so the client sees the
        // events before the load call resolves.
        if let Some(replay_tx) = &replay_tx {
            let metadata = drain_replay(&mut session, replay_tx).await?;
            ready.title = metadata.title.or(ready.title);
            ready.updated_at = metadata.updated_at.or(ready.updated_at);
        }
        was_ready = ready_tx.send(Ok(ready)).is_ok();
        actor.serve(&mut session, &mut rx).await
    };
    let result: Result<(), agent_client_protocol::Error> = tokio::select! {
        result = run => result,
        _ = closing.cancelled() => Ok(()),
        _ = async {
            loop {
                if disconnects.changed().await.is_err()
                    || *disconnects.borrow() >= connection_generation
                {
                    break;
                }
            }
        } => Err(agent_client_protocol::Error::internal_error().data("ACP connection stopped")),
    };
    // Settle the turn's caller and the pending request (cancelled) right away,
    // without waiting for the agent to close the session.
    drop(actor);
    if closing.is_cancelled() {
        // This also interrupts a stuck mode/config request or a user input wait;
        // close must not queue behind the operation the user is resetting.
        send_cancel(&session);
        if close_supported {
            close_session_gracefully(&session).await;
        }
    }
    if let Err(err) = result {
        tracing::info!("ACP session actor stopped: ACP agent session failed: {err}");
    }
    was_ready
}

/// Owns everything about a live session; only its actor touches it.
struct SessionActor {
    agent: String,
    session_id: String,
    /// The device that created, loaded or last prompted the session. It gets
    /// the session's notifications: requests waiting for the user, next-prompt
    /// suggestions and updates sent between turns.
    notifier: Option<Notifier>,
    status: watch::Sender<SessionStatus>,
    turn: Option<Turn>,
    /// The agent waits for one request at a time.
    pending_input: Option<PendingUserInput>,
}

struct Turn {
    stop: std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<PromptResponse, agent_client_protocol::Error>>
                + Send,
        >,
    >,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    answer: String,
    idle_timeout: std::time::Duration,
    deadline: tokio::time::Instant,
    /// Taken when the turn times out: the caller gets the timeout right away
    /// while the turn runs until the agent confirms the cancellation.
    reply: Option<oneshot::Sender<Result<String, String>>>,
    cancelled: bool,
}

struct PendingUserInput {
    input: UserInput,
    answer: oneshot::Sender<serde_json::Value>,
}

impl SessionActor {
    /// Serve commands and session updates. Config/mode changes go out at once,
    /// also mid-turn (see `send_set_mode`); a second prompt during a turn is
    /// rejected.
    async fn serve(
        &mut self,
        session: &mut ActiveSession<'_, Agent>,
        rx: &mut mpsc::Receiver<SessionCommand>,
    ) -> Result<(), agent_client_protocol::Error> {
        enum Input {
            Update(SessionMessage),
            Stop(Result<PromptResponse, agent_client_protocol::Error>),
            Command(SessionCommand),
            Idle,
        }
        loop {
            let deadline = self
                .turn
                .as_ref()
                .filter(|turn| turn.reply.is_some())
                .map(|turn| turn.deadline);
            let turn = &mut self.turn;
            // `biased` drains updates the agent sent before its prompt response;
            // a random pick could take Stop first and leave the final chunks
            // queued until the next turn.
            let input = tokio::select! {
                biased;
                update = session.read_update() => Input::Update(update?),
                response = async {
                    match turn {
                        Some(turn) => turn.stop.as_mut().await,
                        None => std::future::pending().await,
                    }
                } => Input::Stop(response),
                command = rx.recv() => match command {
                    Some(command) => Input::Command(command),
                    None => return Ok(()),
                },
                _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if deadline.is_some() => Input::Idle,
            };
            match input {
                Input::Update(SessionMessage::SessionMessage(dispatch)) => {
                    MatchDispatch::new(dispatch)
                        .if_notification(async |notif: SessionNotification| {
                            self.on_update(notif.update);
                            Ok(())
                        })
                        .await
                        .otherwise_ignore()?;
                }
                Input::Update(_) => {}
                Input::Stop(response) => self.end_turn(response),
                Input::Idle => {
                    // Callers keep at most one prompt in flight per session, so a
                    // timeout means the caller abandoned its turn: cancel it so the
                    // session becomes usable again instead of finishing unobserved.
                    self.cancel_turn(session);
                    let turn = self.turn.as_mut().expect("deadline of a running turn");
                    if let Some(reply) = turn.reply.take() {
                        let _ = reply.send(Err(format!(
                            "Timeout waiting for ACP agent: no activity for {}s",
                            turn.idle_timeout.as_secs()
                        )));
                    }
                }
                Input::Command(command) => self.on_command(session, command).await,
            }
        }
    }

    async fn on_command(&mut self, session: &ActiveSession<'_, Agent>, command: SessionCommand) {
        match command {
            SessionCommand::Prompt(turn) => self.begin_turn(session, turn),
            SessionCommand::Cancel => self.cancel_turn(session),
            SessionCommand::SetMode { mode_id, reply } => {
                send_set_mode(session, mode_id, reply).await;
            }
            SessionCommand::SetConfig {
                config_id,
                value,
                reply,
            } => {
                send_set_config_option(session, config_id, value, reply).await;
            }
            SessionCommand::UserInput { mut input, answer } => {
                // Only shown while a turn runs; dropping `answer` cancels it.
                if !self.turn.as_ref().is_some_and(|turn| !turn.cancelled) {
                    return;
                }
                let Some(notifier) = self.notifier.clone() else {
                    return;
                };
                let request_id = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
                    .to_string();
                input.params_mut()["requestId"] = request_id.into();
                notifier(input.method(), input.params().clone());
                self.pending_input = Some(PendingUserInput { input, answer });
                self.publish();
            }
            SessionCommand::AnswerUserInput {
                request_id,
                response,
                reply,
            } => {
                let pending = self
                    .pending_input
                    .take_if(|pending| pending.input.params()["requestId"] == request_id);
                let answered = pending.is_some_and(|pending| pending.answer.send(response).is_ok());
                self.publish();
                let _ = reply.send(answered);
            }
            SessionCommand::Suggestion(suggestion) => {
                let params = serde_json::json!({
                    "agent": self.agent,
                    "sessionId": self.session_id,
                    "suggestion": suggestion,
                });
                self.notify("agent_prompt_suggestion", params);
            }
        }
    }

    fn begin_turn(&mut self, session: &ActiveSession<'_, Agent>, turn: PromptTurn) {
        if self.turn.is_some() {
            let _ = turn.reply.send(Err(
                "ACP agent session already has a prompt in progress".to_string()
            ));
            return;
        }
        if turn.notifier.is_some() {
            self.notifier = turn.notifier;
        }
        // `send_prompt` only takes text, so build the request manually to support
        // image/resource blocks. The final stop reason then arrives as the
        // request response instead of through the update stream. An empty prompt
        // is fine as long as attachments carry the content (callers validate).
        let mut content: Vec<ContentBlock> = Vec::new();
        if !turn.prompt.is_empty() {
            content.push(ContentBlock::Text(TextContent::new(turn.prompt)));
        }
        content.extend(
            turn.attachments
                .into_iter()
                .map(Attachment::into_content_block),
        );
        let stop = session
            .connection()
            .send_request_to(
                Agent,
                PromptRequest::new(session.session_id().clone(), content),
            )
            .block_task();
        self.turn = Some(Turn {
            stop: Box::pin(stop),
            event_tx: turn.event_tx,
            answer: String::new(),
            idle_timeout: turn.idle_timeout,
            deadline: tokio::time::Instant::now() + turn.idle_timeout,
            reply: Some(turn.reply),
            cancelled: false,
        });
        self.publish();
    }

    fn on_update(&mut self, update: SessionUpdate) {
        let Some(turn) = &mut self.turn else {
            // Between turns, forward what the agent sends right away (e.g. the
            // available commands after `session/new`) instead of leaving it
            // queued until the next prompt.
            let params = serde_json::json!({
                "agent": self.agent,
                "sessionId": self.session_id,
                "update": update_to_json(update),
            });
            self.notify("agent_session_update", params);
            return;
        };
        turn.deadline = tokio::time::Instant::now() + turn.idle_timeout;
        if let SessionUpdate::AgentMessageChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) = &update
        {
            turn.answer.push_str(&text.text);
        }
        let _ = turn.event_tx.send(AgentEvent::SessionUpdate {
            update: update_to_json(update),
        });
    }

    fn end_turn(&mut self, response: Result<PromptResponse, agent_client_protocol::Error>) {
        let turn = self.turn.take().expect("stop of a running turn");
        let result = response
            .map(|response| {
                let _ = turn.event_tx.send(AgentEvent::Stop {
                    stop_reason: to_json(response.stop_reason),
                });
                turn.answer
            })
            .map_err(|err| err.to_string());
        if let Some(reply) = turn.reply {
            let _ = reply.send(result);
        }
        self.pending_input = None;
        self.publish();
    }

    /// Cancel the running turn; its pending request settles cancelled.
    fn cancel_turn(&mut self, session: &ActiveSession<'_, Agent>) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        turn.cancelled = true;
        send_cancel(session);
        self.pending_input = None;
        self.publish();
    }

    fn notify(&self, method: &str, params: serde_json::Value) {
        if let Some(notifier) = &self.notifier {
            notifier(method, params);
        }
    }

    fn publish(&self) {
        self.status.send_replace(SessionStatus {
            busy: self.turn.is_some(),
            pending_input: self
                .pending_input
                .as_ref()
                .map(|pending| pending.input.clone()),
        });
    }
}

fn send_cancel(session: &ActiveSession<'_, Agent>) {
    let notification = CancelNotification::new(session.session_id().clone());
    if let Err(err) = session.connection().send_notification(notification) {
        tracing::warn!("Failed to cancel ACP session: {err}");
    }
}

const SESSION_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Give the agent a bounded chance to persist and release this session.
async fn close_session_gracefully(session: &ActiveSession<'_, Agent>) {
    let request = CloseSessionRequest::new(session.session_id().clone());
    match tokio::time::timeout(
        SESSION_CLOSE_TIMEOUT,
        session
            .connection()
            .send_request_to(Agent, request)
            .block_task(),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => tracing::warn!("Failed to close ACP session gracefully: {err}"),
        Err(_) => tracing::warn!("Timed out closing ACP session; releasing local session state"),
    }
}

/// Forward the session updates routed before the load response (the
/// `session/load` history replay) to `event_tx`. The replay is complete by the
/// time the load response arrives, so once the queue is quiet for a moment the
/// drain is done; dropping the pending `read_update` on timeout loses nothing.
#[derive(Default)]
struct SessionReplayMetadata {
    title: Option<String>,
    updated_at: Option<String>,
}

impl SessionReplayMetadata {
    fn apply(&mut self, update: &serde_json::Value) {
        if update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)
            != Some("session_info_update")
        {
            return;
        }
        if let Some(title) = update
            .get("title")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.title = Some(title.to_string());
        }
        if let Some(updated_at) = update
            .get("updatedAt")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.updated_at = Some(updated_at.to_string());
        }
    }
}

async fn drain_replay(
    session: &mut ActiveSession<'_, Agent>,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<SessionReplayMetadata, agent_client_protocol::Error> {
    const REPLAY_IDLE: std::time::Duration = std::time::Duration::from_millis(200);
    let mut metadata = SessionReplayMetadata::default();
    loop {
        match tokio::time::timeout(REPLAY_IDLE, session.read_update()).await {
            Ok(Ok(SessionMessage::SessionMessage(dispatch))) => {
                MatchDispatch::new(dispatch)
                    .if_notification(async |notif: SessionNotification| {
                        let update = update_to_json(notif.update);
                        metadata.apply(&update);
                        let _ = event_tx.send(AgentEvent::SessionUpdate { update });
                        Ok(())
                    })
                    .await
                    .otherwise_ignore()?;
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => break,
        }
    }
    Ok(metadata)
}

/// Send `session/set_mode` to the live session and settle the caller's reply.
/// Safe mid-turn: claude-agent-acp applies it to the running query
/// (`setPermissionMode`), so the in-flight turn switches immediately.
async fn send_set_mode(
    session: &ActiveSession<'_, Agent>,
    mode_id: String,
    reply: oneshot::Sender<Result<(), String>>,
) {
    let request =
        SetSessionModeRequest::new(session.session_id().clone(), SessionModeId::from(mode_id));
    let result = session
        .connection()
        .send_request_to(Agent, request)
        .block_task()
        .await
        .map(|_| ())
        .map_err(|err| err.to_string());
    let _ = reply.send(result);
}

/// Send `session/set_config_option` to the live session; see `send_set_mode`
/// for why this is safe mid-turn.
async fn send_set_config_option(
    session: &ActiveSession<'_, Agent>,
    config_id: String,
    value: String,
    reply: oneshot::Sender<Result<serde_json::Value, String>>,
) {
    let request = SetSessionConfigOptionRequest::new(
        session.session_id().clone(),
        SessionConfigId::from(config_id),
        SessionConfigValueId::from(value),
    );
    let result = session
        .connection()
        .send_request_to(Agent, request)
        .block_task()
        .await
        .map(to_json)
        .map_err(|err| err.to_string());
    let _ = reply.send(result);
}

/// Serialize a session update for the client, dropping image bytes from tool
/// output. Tool images (e.g. screenshots the agent read) arrive twice, in
/// `content` and `rawOutput`, at up to ~1MB each; the client does not render
/// them, and on load they clog the ordered Relay queue so later replies time out.
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
    use super::{SessionReplayMetadata, session_metadata_from_meta, update_to_json};

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

    #[test]
    fn reads_session_metadata_from_load_meta_and_replay() {
        let meta = serde_json::Map::from_iter([
            ("title".to_string(), serde_json::json!("Loaded title")),
            (
                "updatedAt".to_string(),
                serde_json::json!("2026-08-27T00:00:00Z"),
            ),
        ]);
        assert_eq!(
            session_metadata_from_meta(Some(&meta)),
            (
                Some("Loaded title".to_string()),
                Some("2026-08-27T00:00:00Z".to_string())
            )
        );

        let mut replay = SessionReplayMetadata::default();
        replay.apply(&serde_json::json!({
            "sessionUpdate": "session_info_update",
            "title": "Replay title",
            "updatedAt": "2026-08-27T01:00:00Z"
        }));
        assert_eq!(replay.title.as_deref(), Some("Replay title"));
        assert_eq!(replay.updated_at.as_deref(), Some("2026-08-27T01:00:00Z"));
    }
}
