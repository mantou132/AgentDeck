use std::path::PathBuf;

use agent_client_protocol::{
    ActiveSession, Agent, SessionMessage,
    schema::v1::{
        CancelNotification, CloseSessionRequest, PromptResponse, SessionConfigId,
        SessionConfigValueId, SessionModeId, SessionNotification, SessionUpdate,
        SetSessionConfigOptionRequest, SetSessionModeRequest, SubagentUpdate,
    },
    util::MatchDispatch,
};
use anyhow::Result;
use tokio::sync::{mpsc, oneshot, watch};

use super::*;

/// Start a session with the agent, report ready, then serve its commands and
/// updates until it is closed or the connection stops. Returns whether it
/// became ready.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_session_actor(
    cwd: PathBuf,
    load: Option<SessionLoad>,
    context: SessionContext,
    runtime: AcpRuntime,
    mut rx: mpsc::Receiver<SessionCommand>,
    mut child_rx: mpsc::UnboundedReceiver<ChildUpdate>,
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
        pending_inputs: Vec::new(),
        children: HashMap::new(),
    };
    let mut was_ready = false;
    let run = async {
        // The load-time history replay is routed to the session before the load
        // response; forward it before reporting ready so the client sees the
        // events before the load call resolves.
        if let Some(replay_tx) = &replay_tx {
            let metadata = drain_replay(&mut session, &mut child_rx, replay_tx, |update| {
                actor.on_subagent_update(update)
            })
            .await?;
            ready.title = metadata.title.or(ready.title);
            ready.updated_at = metadata.updated_at.or(ready.updated_at);
        }
        was_ready = ready_tx.send(Ok(ready)).is_ok();
        actor.serve(&mut session, &mut rx, &mut child_rx).await
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
    /// One at a time per session, but subagents ask alongside their parent.
    pending_inputs: Vec<PendingUserInput>,
    /// Subagent sessions announced since the session started, and whether
    /// each currently allows `session/cancel`. Replayed grants don't count.
    children: HashMap<String, bool>,
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
    reply: Option<oneshot::Sender<Result<String>>>,
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
        child_rx: &mut mpsc::UnboundedReceiver<ChildUpdate>,
    ) -> Result<(), agent_client_protocol::Error> {
        enum Input {
            Update(SessionMessage),
            Child(ChildUpdate),
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
            // queued until the next turn. The parent's queue goes first, so a
            // subagent's announcement precedes its own updates.
            let input = tokio::select! {
                biased;
                update = session.read_update() => Input::Update(update?),
                Some(update) = child_rx.recv() => Input::Child(update),
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
                            self.on_update(notif.update, None);
                            Ok(())
                        })
                        .await
                        .otherwise_ignore()?;
                }
                Input::Update(_) => {}
                Input::Child(ChildUpdate { session_id, update }) => {
                    self.on_update(update, Some(session_id));
                }
                Input::Stop(response) => self.end_turn(response),
                Input::Idle => {
                    // Callers keep at most one prompt in flight per session, so a
                    // timeout means the caller abandoned its turn: cancel it so the
                    // session becomes usable again instead of finishing unobserved.
                    self.cancel_turn(session);
                    let turn = self.turn.as_mut().expect("deadline of a running turn");
                    if let Some(reply) = turn.reply.take() {
                        let _ = reply.send(Err(anyhow::anyhow!(
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
                self.pending_inputs.push(PendingUserInput { input, answer });
                self.publish();
            }
            SessionCommand::AnswerUserInput {
                request_id,
                response,
                reply,
            } => {
                let pending = self
                    .pending_inputs
                    .iter()
                    .position(|pending| pending.input.params()["requestId"] == request_id)
                    .map(|index| self.pending_inputs.remove(index));
                let answered = pending.is_some_and(|pending| pending.answer.send(response).is_ok());
                self.publish();
                let _ = reply.send(answered);
            }
            SessionCommand::CancelChild { session_id, reply } => {
                let cancellable = self.children.get(&session_id).copied().unwrap_or(false);
                if cancellable {
                    let notification = CancelNotification::new(SessionId::from(session_id.clone()));
                    if let Err(err) = session.connection().send_notification(notification) {
                        tracing::warn!("Failed to cancel ACP subagent session: {err}");
                    }
                    self.drop_child_inputs(&session_id);
                }
                let _ = reply.send(cancellable);
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
            let _ = turn.reply.send(Err(anyhow::anyhow!(
                "ACP agent session already has a prompt in progress"
            )));
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

    /// `child` is the subagent session the update addresses, if any.
    fn on_update(&mut self, update: SessionUpdate, child: Option<String>) {
        if let SessionUpdate::SubagentUpdate(subagent) = &update {
            self.on_subagent_update(subagent);
        }
        let Some(turn) = &mut self.turn else {
            // Between turns, forward what the agent sends right away (e.g. the
            // available commands after `session/new`) instead of leaving it
            // queued until the next prompt.
            let mut params = serde_json::json!({
                "agent": self.agent,
                "sessionId": self.session_id,
                "update": update_to_json(update),
            });
            if let Some(child) = child {
                params["childSessionId"] = child.into();
            }
            self.notify("agent_session_update", params);
            return;
        };
        // A subagent working while the parent waits keeps the turn alive.
        turn.deadline = tokio::time::Instant::now() + turn.idle_timeout;
        if child.is_none()
            && let SessionUpdate::AgentMessageChunk(ContentChunk {
                content: ContentBlock::Text(text),
                ..
            }) = &update
        {
            turn.answer.push_str(&text.text);
        }
        let _ = turn.event_tx.send(AgentEvent::update(update, child));
    }

    /// Track which subagents allow cancel; a subagent cancelled by the agent
    /// (e.g. with its parent's turn) settles its pending requests.
    fn on_subagent_update(&mut self, update: &SubagentUpdate) {
        let session_id = update.session_id.to_string();
        let cancellable = self.children.entry(session_id.clone()).or_default();
        match &update.capabilities {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => *cancellable = false,
            MaybeUndefined::Value(capabilities) => *cancellable = capabilities.cancel.is_some(),
        }
        if let MaybeUndefined::Value(StateUpdate::Idle(idle)) = &update.state
            && matches!(idle.stop_reason, Some(IdleStopReason::Cancelled))
        {
            self.drop_child_inputs(&session_id);
        }
    }

    /// Settle a subagent's pending requests as cancelled.
    fn drop_child_inputs(&mut self, session_id: &str) {
        let before = self.pending_inputs.len();
        self.pending_inputs
            .retain(|pending| pending.input.params()["childSessionId"] != session_id);
        if self.pending_inputs.len() != before {
            self.publish();
        }
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
            .map_err(anyhow::Error::from);
        if let Some(reply) = turn.reply {
            let _ = reply.send(result);
        }
        self.pending_inputs.clear();
        self.publish();
    }

    /// Cancel the running turn; its pending request settles cancelled.
    fn cancel_turn(&mut self, session: &ActiveSession<'_, Agent>) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        turn.cancelled = true;
        send_cancel(session);
        self.pending_inputs.clear();
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
            pending_inputs: self
                .pending_inputs
                .iter()
                .map(|pending| pending.input.clone())
                .collect(),
        });
    }
}

fn send_cancel(session: &ActiveSession<'_, Agent>) {
    let notification = CancelNotification::new(session.session_id().clone());
    if let Err(err) = session.connection().send_notification(notification) {
        tracing::warn!("Failed to cancel ACP session: {err}");
    }
}

pub(super) const SESSION_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
pub(super) struct SessionReplayMetadata {
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

/// Subagents replay their history to their own sessions, routed to
/// `child_rx`; their announcements on the parent come first (see `serve`).
/// Their current state follows the load response, within the drain, so
/// `on_subagent` sees it; replayed announcements carry no `cancel` grant.
async fn drain_replay(
    session: &mut ActiveSession<'_, Agent>,
    child_rx: &mut mpsc::UnboundedReceiver<ChildUpdate>,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    mut on_subagent: impl FnMut(&SubagentUpdate),
) -> Result<SessionReplayMetadata, agent_client_protocol::Error> {
    const REPLAY_IDLE: std::time::Duration = std::time::Duration::from_millis(200);
    let mut metadata = SessionReplayMetadata::default();
    loop {
        let input = tokio::time::timeout(REPLAY_IDLE, async {
            tokio::select! {
                biased;
                update = session.read_update() => Ok(update),
                Some(update) = child_rx.recv() => Err(update),
            }
        });
        match input.await {
            Ok(Ok(Ok(SessionMessage::SessionMessage(dispatch)))) => {
                MatchDispatch::new(dispatch)
                    .if_notification(async |notif: SessionNotification| {
                        if let SessionUpdate::SubagentUpdate(subagent) = &notif.update {
                            on_subagent(subagent);
                        }
                        let update = update_to_json(notif.update);
                        metadata.apply(&update);
                        let _ = event_tx.send(AgentEvent::SessionUpdate {
                            update,
                            child_session_id: None,
                        });
                        Ok(())
                    })
                    .await
                    .otherwise_ignore()?;
            }
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(err))) => return Err(err),
            Ok(Err(ChildUpdate { session_id, update })) => {
                if let SessionUpdate::SubagentUpdate(subagent) = &update {
                    on_subagent(subagent);
                }
                let _ = event_tx.send(AgentEvent::update(update, Some(session_id)));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
