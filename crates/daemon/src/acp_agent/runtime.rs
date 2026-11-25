//! Per-agent ACP subprocess runtime and shared connection lifecycle.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agent_client_protocol::{
    AcpAgent, ActiveSession, Agent, Client, ConnectionTo, Handled, JsonRpcNotification,
    schema::{
        ProtocolVersion,
        v1::{
            AgentCapabilities, ClientCapabilities as AcpClientCapabilities,
            CreateElicitationRequest, CreateElicitationResponse, ElicitationAction,
            ElicitationCapabilities, ElicitationFormCapabilities, ElicitationScope, Implementation,
            InitializeRequest, LoadSessionRequest, Meta, NewSessionRequest, PermissionOptionId,
            RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
            SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate,
            SubagentCapabilities,
        },
    },
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{
    AgentSession, AgentSessionKey, AgentStatus, ChildUpdate, RUNTIME_SHUTDOWN_TIMEOUT,
    SessionCommand, SessionContext, SessionMap, SessionReady, UserInput, catalog,
    prepare_agent_command, to_json,
};
use crate::render_skills;

/// Raw Claude Agent SDK message forwarded by claude-agent-acp when the session
/// opts in through `_meta.claudeCode.emitRawSDKMessages`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcNotification)]
#[notification(method = "_claude/sdkMessage")]
struct ClaudeSdkMessage {
    #[serde(rename = "sessionId")]
    session_id: String,
    message: serde_json::Value,
}

/// An initialized ACP connection and the capabilities the agent advertised.
#[derive(Clone)]
pub(super) struct AgentConnection {
    pub(super) connection: ConnectionTo<Agent>,
    pub(super) capabilities: Arc<AgentCapabilities>,
    pub(super) generation: u64,
}

/// Lazily starts one ACP subprocess and shares its connection across sessions.
/// A failed connection is discarded and started again on the next API call.
pub(super) struct RuntimeState {
    pub(super) connection: Option<AgentConnection>,
    connecting: bool,
    pub(super) generation: u64,
    waiters: Vec<oneshot::Sender<Result<AgentConnection, String>>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

pub(super) struct StartedSession {
    pub(super) session: ActiveSession<'static, Agent>,
    pub(super) ready: SessionReady,
    pub(super) disconnects: watch::Receiver<u64>,
    pub(super) generation: u64,
    pub(super) close_supported: bool,
}

#[derive(Clone)]
pub(super) struct AcpRuntime {
    pub(super) agent: String,
    pub(super) state: Arc<Mutex<RuntimeState>>,
    /// The manager's live sessions, to route agent requests to their actor.
    sessions: SessionMap,
    /// Subagent session → the root session whose actor owns it, nested
    /// subagents included. Filled on the connection's dispatch loop before
    /// any child traffic is routed.
    children: Arc<std::sync::Mutex<HashMap<String, String>>>,
    disconnects: watch::Sender<u64>,
    /// `None` once connected or stopped.
    pub(super) status: watch::Sender<Option<AgentStatus>>,
    manager_shutting_down: CancellationToken,
    shutdown: CancellationToken,
}

impl AcpRuntime {
    pub(super) fn new(
        agent: String,
        sessions: SessionMap,
        manager_shutting_down: CancellationToken,
    ) -> Self {
        let (disconnects, _) = watch::channel(0);
        let (status, _) = watch::channel(None);
        Self {
            agent,
            state: Arc::new(Mutex::new(RuntimeState {
                connection: None,
                connecting: false,
                generation: 0,
                waiters: Vec::new(),
                task: None,
            })),
            sessions,
            children: Arc::default(),
            disconnects,
            status,
            manager_shutting_down,
            shutdown: CancellationToken::new(),
        }
    }

    pub(super) async fn connection(&self) -> Result<AgentConnection> {
        let (reply_tx, reply_rx) = oneshot::channel();
        {
            let mut state = self.state.lock().await;
            if self.manager_shutting_down.is_cancelled() || self.shutdown.is_cancelled() {
                anyhow::bail!("ACP runtime is shutting down");
            }
            if let Some(connection) = &state.connection {
                return Ok(connection.clone());
            }
            state.waiters.push(reply_tx);
            if !state.connecting {
                state.connecting = true;
                state.generation += 1;
                let generation = state.generation;
                state.task = Some(self.spawn_connection(generation));
            }
        }
        match reply_rx.await {
            Ok(Ok(connection)) => Ok(connection),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("ACP runtime stopped while connecting"),
        }
    }

    fn spawn_connection(&self, generation: u64) -> tokio::task::JoinHandle<()> {
        let runtime = self.clone();
        tokio::spawn(async move {
            let result = runtime.serve_connection(generation).await;
            let error = result
                .err()
                .map(|err| err.to_string())
                .unwrap_or_else(|| "ACP agent connection stopped".to_string());
            if !runtime.shutdown.is_cancelled() && !runtime.manager_shutting_down.is_cancelled() {
                tracing::warn!("{error}");
            }
            runtime.connection_stopped(generation, error).await;
        })
    }

    async fn serve_connection(&self, generation: u64) -> Result<()> {
        self.status.send_replace(Some(AgentStatus::Starting));
        catalog::refresh_registry();
        let agent = self.agent.clone();
        let status = self.status.clone();
        let command = tokio::task::spawn_blocking(move || {
            prepare_agent_command(catalog::agent_candidate(&agent)?, &|| {
                status.send_replace(Some(AgentStatus::Installing));
            })
        })
        .await
        .context("ACP runtime preparation task failed")??;
        if self.manager_shutting_down.is_cancelled() || self.shutdown.is_cancelled() {
            return Ok(());
        }
        self.status.send_replace(Some(AgentStatus::Starting));
        tracing::info!("Starting {} ACP agent: {}", self.agent, command.join(" "));
        // `from_args` treats leading `NAME=value` args as env overrides for the
        // spawned subprocess.
        let acp_agent =
            AcpAgent::from_args(command).context("failed to configure ACP agent command")?;
        self.connect_agent(generation, acp_agent).await
    }

    pub(super) async fn connect_agent(
        &self,
        generation: u64,
        agent: impl agent_client_protocol::ConnectTo<Client>,
    ) -> Result<()> {
        let permission_runtime = self.clone();
        let elicitation_runtime = self.clone();
        let suggestion_runtime = self.clone();
        let child_runtime = self.clone();
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
                        // Only form mode is advertised, and its requests are
                        // session-scoped.
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
                        // Never wait for the actor here: this handler runs on
                        // the connection's dispatch loop, which the actor may
                        // be waiting on.
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
            // Registered before session routing: subagent sessions have no
            // `ActiveSession`, so their updates go to the root session's actor.
            .on_receive_notification(
                async move |notification: SessionNotification, connection| {
                    Ok(match child_runtime.route_child(notification).await {
                        None => Handled::Yes,
                        Some(notification) => Handled::No {
                            message: (notification, connection),
                            retry: false,
                        },
                    })
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
                // Form elicitation lets Claude ask the user
                // (`AskUserQuestion`); `subagents` asks for child sessions in
                // the ACP Subagent Sessions RFD form. OpenCode ignores the
                // standard field and only reports child sessions when its own
                // `_meta` key is set.
                let capabilities = AcpClientCapabilities::new()
                    .elicitation(
                        ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                    )
                    .subagents(SubagentCapabilities::new())
                    .meta(
                        [(
                            "opencode/child-session-updates".to_string(),
                            serde_json::Value::Bool(true),
                        )]
                        .into_iter()
                        .collect::<Meta>(),
                    );
                let request = InitializeRequest::new(ProtocolVersion::V1)
                    .client_capabilities(capabilities)
                    .client_info(
                        Implementation::new("agentdeck", env!("CARGO_PKG_VERSION"))
                            .title("AgentDeck"),
                    );
                let response = tokio::select! {
                    response = connection.send_request(request).block_task() => response?,
                    _ = runtime.shutdown.cancelled() => return Ok(()),
                };
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
                    generation,
                };
                runtime.connection_ready(generation, agent_connection).await;
                // The SDK can keep a connect_with foreground task alive after
                // EOF. End ours explicitly so the runtime discards the dead
                // connection.
                tokio::select! {
                    _ = connection.incoming_closed() => Err(
                        agent_client_protocol::Error::internal_error()
                            .data("ACP agent connection closed"),
                    ),
                    _ = runtime.shutdown.cancelled() => Ok(()),
                }
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
            self.status.send_replace(None);
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Ok(connection.clone()));
        }
    }

    pub(super) async fn connection_stopped(&self, generation: u64, error: String) {
        let waiters = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.connection = None;
            state.connecting = false;
            state.task = None;
            self.status.send_replace(None);
            std::mem::take(&mut state.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Err(error.clone()));
        }
        self.disconnects.send_replace(generation);
    }

    pub(super) async fn shutdown(&self) {
        self.shutdown.cancel();
        let (waiters, task) = {
            let mut state = self.state.lock().await;
            state.connection = None;
            state.connecting = false;
            self.status.send_replace(None);
            (std::mem::take(&mut state.waiters), state.task.take())
        };
        for waiter in waiters {
            let _ = waiter.send(Err("ACP runtime is shutting down".to_string()));
        }
        if let Some(mut task) = task {
            if tokio::time::timeout(RUNTIME_SHUTDOWN_TIMEOUT, &mut task)
                .await
                .is_err()
            {
                tracing::warn!(
                    "Timed out shutting down {} ACP runtime; aborting",
                    self.agent
                );
                task.abort();
                let _ = task.await;
            }
        }
    }

    pub(super) async fn start_session(
        &self,
        cwd: PathBuf,
        load: Option<SessionId>,
        context: SessionContext,
    ) -> Result<StartedSession> {
        let AgentConnection {
            connection,
            capabilities,
            generation,
        } = self.connection().await?;
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
            render_skills::skill_directories(&context.skills)
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

    async fn session(&self, session_id: &str) -> Option<AgentSession> {
        let key = AgentSessionKey::new(&self.agent, session_id);
        self.sessions.lock().await.get(&key).cloned()
    }

    async fn session_tx(&self, session_id: &str) -> Option<mpsc::Sender<SessionCommand>> {
        Some(self.session(session_id).await?.tx)
    }

    /// The root session owning a subagent session; `None` for other sessions.
    fn root_of(&self, session_id: &str) -> Option<String> {
        let children = self.children.lock().expect("children lock poisoned");
        children.get(session_id).cloned()
    }

    /// Record the child a `subagent_update` announces, then hand a subagent
    /// session's notification to its root actor. Returns the notification when
    /// it belongs to a root session, for its `ActiveSession`.
    async fn route_child(&self, notification: SessionNotification) -> Option<SessionNotification> {
        let session_id = notification.session_id.to_string();
        let root = {
            let mut children = self.children.lock().expect("children lock poisoned");
            let root = children.get(&session_id).cloned();
            if let SessionUpdate::SubagentUpdate(update) = &notification.update {
                let owner = root.clone().unwrap_or_else(|| session_id.clone());
                children
                    .entry(update.session_id.to_string())
                    .or_insert(owner);
            }
            root
        };
        let Some(root) = root else {
            return Some(notification);
        };
        // Unbounded and never awaited: this runs on the dispatch loop, which
        // the actor may be waiting on.
        if let Some(session) = self.session(&root).await {
            let _ = session.child_tx.send(ChildUpdate {
                session_id,
                update: notification.update,
            });
        }
        None
    }

    /// Drop the subagents of a session whose actor stopped.
    pub(super) fn forget_children(&self, root: &str) {
        let mut children = self.children.lock().expect("children lock poisoned");
        children.retain(|_, owner| owner != root);
    }

    /// Show a request on the session's device and wait until a device answers
    /// it through `answer_user_input`; delivery is not the answer, so a device
    /// that reloaded can still answer. A subagent's request is shown with its
    /// root session and `childSessionId`. `None` when it is cancelled: no turn
    /// runs, the turn is cancelled or ends, the subagent is cancelled, or the
    /// session closes.
    async fn wait_user_input(
        &self,
        session_id: &str,
        mut input: UserInput,
    ) -> Option<serde_json::Value> {
        let root = self.root_of(session_id);
        let params = input.params_mut();
        if let Some(root) = &root {
            params["sessionId"] = root.clone().into();
            params["childSessionId"] = session_id.into();
        } else {
            params["sessionId"] = session_id.into();
        }
        let tx = self
            .session_tx(root.as_deref().unwrap_or(session_id))
            .await?;
        let (answer, answer_rx) = oneshot::channel();
        tx.send(SessionCommand::UserInput { input, answer })
            .await
            .ok()?;
        answer_rx.await.ok()
    }
}

pub(super) fn session_metadata_from_meta(
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

pub(super) fn system_prompt_meta(prompt: &str) -> serde_json::Map<String, serde_json::Value> {
    let append = serde_json::json!({ "append": prompt });
    serde_json::Map::from_iter([
        ("systemPrompt".to_string(), append.clone()),
        (
            "antigravity".to_string(),
            serde_json::json!({ "systemPrompt": append }),
        ),
    ])
}

/// Enable Claude's next-prompt suggestions and forward only those raw SDK
/// messages; claude-agent-acp drops them otherwise. Turn off the bundled
/// `dataviz` skill, which answers chart requests in place of AgentDeck's.
fn claude_code_meta() -> serde_json::Value {
    serde_json::json!({
        "options": {
            "promptSuggestions": true,
            "settings": { "skillOverrides": { "dataviz": "off" } },
        },
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
