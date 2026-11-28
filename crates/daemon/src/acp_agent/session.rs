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
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

use super::*;

#[cfg(not(test))]
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
pub(super) const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SessionExit {
    NotReady,
    Closed,
    Idle,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServeExit {
    Closed,
    Idle,
}

enum ControlResult {
    Mode(Option<String>),
    Config(Option<serde_json::Value>),
}

/// Start a session with the agent, report ready, then serve its commands and
/// updates until it is closed, reclaimed idle, or the connection stops.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_session_actor(
    cwd: PathBuf,
    load: Option<SessionId>,
    context: SessionContext,
    subscriber: Option<SessionSubscriber>,
    epoch: String,
    idle_timeout: Duration,
    observer: Option<Arc<dyn SessionObserver>>,
    meta: Arc<SessionMetaStore>,
    runtime: AcpRuntime,
    mut rx: mpsc::Receiver<SessionCommand>,
    mut child_rx: mpsc::UnboundedReceiver<ChildUpdate>,
    status: watch::Sender<SessionStatus>,
    ready_tx: oneshot::Sender<Result<StartOutcome, String>>,
    closing: CancellationToken,
) -> SessionExit {
    let loading = load.is_some();
    let input_timeout = context.input_timeout;
    let auto_approve = context.auto_approve;
    let task_push = context.task_push.clone();
    let cwd_str = cwd.to_string_lossy().into_owned();
    let started = tokio::select! {
        result = runtime.start_session(cwd, load, context) => result,
        _ = closing.cancelled() => return SessionExit::NotReady,
    };
    let StartedSession {
        mut session,
        ready,
        mut disconnects,
        generation: connection_generation,
        close_supported,
    } = match started {
        Ok(started) => started,
        Err(err) => {
            tracing::info!("ACP session failed to start: {err}");
            let _ = ready_tx.send(Err(err.to_string()));
            return SessionExit::NotReady;
        }
    };
    let initial_meta = if loading {
        meta.merge_metadata(
            &runtime.agent,
            &ready.session_id,
            ready.title.as_deref(),
            None,
            ready.updated_at.as_deref(),
            None,
        )
    } else {
        let updated_at = ready.updated_at.unwrap_or_else(meta::now_iso);
        meta.record_created(
            &runtime.agent,
            &ready.session_id,
            ready.title.as_deref(),
            &updated_at,
        )
    };
    let mut actor = SessionActor {
        agent: runtime.agent.clone(),
        session_id: ready.session_id.clone(),
        epoch,
        cwd: cwd_str,
        title: initial_meta.title,
        updated_at: initial_meta.updated_at,
        modes: ready.modes,
        config_options: ready.config_options,
        suggestion: None,
        events: EventLog::default(),
        subscribers: HashMap::new(),
        observer,
        meta,
        input_timeout,
        auto_approve,
        task_push,
        idle_timeout,
        idle_since: None,
        ready: false,
        status,
        turn: None,
        pending_inputs: Vec::new(),
        children: HashMap::new(),
        control_tasks: JoinSet::new(),
    };
    let mut was_ready = false;
    let run = async {
        // The load-time history replay is routed to the session before the load
        // response; buffer it before reporting ready so the initial open
        // returns all replayed history cleanly.
        if loading {
            drain_replay(&mut session, &mut child_rx, &mut actor).await?;
            actor.persist_metadata();
        }
        if let Some(sub) = subscriber {
            actor.subscribers.insert(sub.peer_id, sub);
        }
        actor.ready = true;
        actor.refresh_idle();
        actor.publish();
        let outcome = if loading {
            StartOutcome::Opened(actor.build_open_result(true, true, 0))
        } else {
            StartOutcome::Created(SessionReady {
                session_id: actor.session_id.clone(),
                epoch: actor.epoch.clone(),
                seq: actor.events.next_seq(),
                title: actor.title.clone(),
                updated_at: actor.updated_at.clone(),
                modes: actor.modes.clone(),
                config_options: actor.config_options.clone(),
            })
        };
        was_ready = ready_tx.send(Ok(outcome)).is_ok();
        if !was_ready {
            return Ok(ServeExit::Closed);
        }
        actor.serve(&mut session, &mut rx, &mut child_rx).await
    };
    let result: Result<ServeExit, agent_client_protocol::Error> = tokio::select! {
        result = run => result,
        _ = closing.cancelled() => Ok(ServeExit::Closed),
        _ = disconnects.wait_for(|&g| g >= connection_generation) => Err(
            agent_client_protocol::Error::internal_error().data("ACP connection stopped")
        ),
    };
    match result {
        Ok(ServeExit::Idle) => {
            // Mark closing before releasing ACP so concurrent `open_session`
            // waits for cleanup and reloads cleanly from disk.
            closing.cancel();
            drop(actor);
            if close_supported {
                close_session_gracefully(&session).await;
            }
            SessionExit::Idle
        }
        Ok(ServeExit::Closed) => {
            // Notify other observers if a running turn was explicitly closed.
            let was_running = actor.turn.is_some();
            actor.clear_pending_inputs();
            if was_running {
                actor.touch_updated_at();
                actor.push_event(AgentEvent::TurnEnded {
                    stop_reason: Some(serde_json::json!("cancelled")),
                    error: None,
                    code: None,
                });
                actor.emit_state(false, false, None, None);
            }
            // Settle the turn's caller and pending requests right away, without
            // waiting for the agent to close the session.
            drop(actor);
            if closing.is_cancelled() {
                // This also interrupts a stuck mode/config request or a user
                // input wait; close must not queue behind the operation the
                // user is resetting.
                send_cancel(&session);
                if close_supported {
                    close_session_gracefully(&session).await;
                }
            }
            if was_ready {
                SessionExit::Closed
            } else {
                SessionExit::NotReady
            }
        }
        Err(err) => {
            tracing::info!("ACP session actor stopped: ACP agent session failed: {err}");
            actor.clear_pending_inputs();
            drop(actor);
            if was_ready {
                SessionExit::Failed
            } else {
                SessionExit::NotReady
            }
        }
    }
}

/// Owns everything about a live session; only its actor touches it.
struct SessionActor {
    agent: String,
    session_id: String,
    epoch: String,
    cwd: String,
    title: Option<String>,
    updated_at: Option<String>,
    modes: Option<serde_json::Value>,
    config_options: Option<serde_json::Value>,
    suggestion: Option<String>,
    /// Sequenced events coalesced in place with byte offsets for exact
    /// `since_seq` slicing.
    events: EventLog,
    subscribers: HashMap<u64, SessionSubscriber>,
    observer: Option<Arc<dyn SessionObserver>>,
    meta: Arc<SessionMetaStore>,
    /// See `SessionContext::input_timeout`.
    input_timeout: Option<Duration>,
    /// See `SessionContext::auto_approve`.
    auto_approve: bool,
    /// See `SessionContext::task_push`.
    task_push: Option<TaskInputPush>,
    idle_timeout: Duration,
    idle_since: Option<tokio::time::Instant>,
    ready: bool,
    status: watch::Sender<SessionStatus>,
    turn: Option<Turn>,
    /// One at a time per session, but subagents ask alongside their parent.
    pending_inputs: Vec<PendingUserInput>,
    /// Subagent sessions announced since the session started, and whether
    /// each currently allows `session/cancel`. Replayed grants don't count.
    children: HashMap<String, bool>,
    /// In-flight `session/set_mode` and `session/set_config_option` requests;
    /// dropped (and aborted) when the actor closes.
    control_tasks: JoinSet<ControlResult>,
}

struct Turn {
    stop: std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<PromptResponse, agent_client_protocol::Error>>
                + Send,
        >,
    >,
    answer: String,
    idle_timeout: Duration,
    /// Idle deadline; paused while a request waits for the user, who may take
    /// longer than the agent is allowed to stay silent.
    deadline: tokio::time::Instant,
    originator_peer_id: Option<u64>,
    /// Taken on completion or turn idle timeout.
    completion: Option<oneshot::Sender<PromptCompletion>>,
    cancelled: bool,
    timed_out: bool,
}

struct PendingUserInput {
    input: UserInput,
    answer: oneshot::Sender<serde_json::Value>,
    /// When it is refused unanswered (`SessionContext::input_timeout`).
    expires: Option<tokio::time::Instant>,
}

impl SessionActor {
    /// Serve commands and session updates. Config/mode changes go out at once,
    /// also mid-turn (see `spawn_set_mode`); a second prompt during a turn is
    /// rejected.
    async fn serve(
        &mut self,
        session: &mut ActiveSession<'_, Agent>,
        rx: &mut mpsc::Receiver<SessionCommand>,
        child_rx: &mut mpsc::UnboundedReceiver<ChildUpdate>,
    ) -> Result<ServeExit, agent_client_protocol::Error> {
        enum Input {
            Update(SessionMessage),
            Child(ChildUpdate),
            Stop(Result<PromptResponse, agent_client_protocol::Error>),
            Command(SessionCommand),
            ControlDone(Option<Result<ControlResult, tokio::task::JoinError>>),
            TurnIdle,
            SessionIdle,
            RequestExpired,
        }
        loop {
            let turn_deadline = self
                .turn
                .as_ref()
                .filter(|turn| !turn.timed_out && self.pending_inputs.is_empty())
                .map(|turn| turn.deadline);
            let session_idle_deadline = self.idle_since.map(|since| since + self.idle_timeout);
            let expires = self
                .pending_inputs
                .iter()
                .filter_map(|pending| pending.expires)
                .min();
            let turn = &mut self.turn;
            let control_tasks = &mut self.control_tasks;
            // `biased` drains updates the agent sent before its prompt
            // response; a random pick could take Stop first and leave the final
            // chunks queued until the next turn. The parent's queue goes first,
            // so a subagent's announcement precedes its own updates.
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
                    None => return Ok(ServeExit::Closed),
                },
                res = control_tasks.join_next(), if !control_tasks.is_empty() => Input::ControlDone(res),
                _ = tokio::time::sleep_until(turn_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if turn_deadline.is_some() => Input::TurnIdle,
                _ = tokio::time::sleep_until(expires.unwrap_or_else(tokio::time::Instant::now)),
                    if expires.is_some() => Input::RequestExpired,
                _ = tokio::time::sleep_until(session_idle_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if session_idle_deadline.is_some() => Input::SessionIdle,
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
                Input::ControlDone(res) => {
                    if let Some(Ok(control)) = res {
                        match control {
                            ControlResult::Mode(Some(mode_id)) => {
                                if self.apply_mode(&mode_id) {
                                    self.push_event(AgentEvent::SessionUpdate {
                                        update: serde_json::json!({
                                            "sessionUpdate": "current_mode_update",
                                            "currentModeId": mode_id,
                                        }),
                                        child_session_id: None,
                                    });
                                }
                            }
                            ControlResult::Config(Some(response)) => {
                                if let Some(options) = response.get("configOptions")
                                    && options.is_array()
                                    && self.config_options.as_ref() != Some(options)
                                {
                                    self.config_options = Some(options.clone());
                                    self.push_event(AgentEvent::SessionUpdate {
                                        update: serde_json::json!({
                                            "sessionUpdate": "config_option_update",
                                            "configOptions": options,
                                        }),
                                        child_session_id: None,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    self.refresh_idle();
                }
                Input::TurnIdle => {
                    let timeout_secs = self
                        .turn
                        .as_ref()
                        .expect("deadline of a running turn")
                        .idle_timeout
                        .as_secs();
                    let message =
                        format!("Timeout waiting for ACP agent: no activity for {timeout_secs}s");
                    self.cancel_turn(session);
                    if let Some(turn) = self.turn.as_mut() {
                        turn.timed_out = true;
                        if let Some(completion) = turn.completion.take() {
                            let _ = completion.send(PromptCompletion {
                                result: Err(anyhow::anyhow!(message.clone())),
                                cancelled: true,
                            });
                        }
                    }
                    self.touch_updated_at();
                    self.push_event(AgentEvent::TurnEnded {
                        stop_reason: None,
                        error: Some(message.clone()),
                        code: None,
                    });
                    self.emit_state(false, false, Some(message), None);
                }
                Input::SessionIdle => return Ok(ServeExit::Idle),
                Input::RequestExpired => self.refuse_expired_inputs(),
                Input::Command(command) => self.on_command(session, command),
            }
        }
    }

    fn on_command(&mut self, session: &ActiveSession<'_, Agent>, command: SessionCommand) {
        match command {
            SessionCommand::Prompt(turn) => self.begin_turn(session, turn),
            SessionCommand::Cancel => self.cancel_turn(session),
            SessionCommand::Subscribe {
                subscriber,
                since_epoch,
                since_seq,
                reply,
            } => {
                if let Some(sub) = subscriber {
                    self.subscribers.insert(sub.peer_id, sub);
                }
                self.refresh_idle();
                let incremental = since_epoch.as_deref() == Some(self.epoch.as_str())
                    && since_seq <= self.events.next_seq();
                let result = self.build_open_result(!incremental, false, since_seq);
                let _ = reply.send(result);
            }
            SessionCommand::Unsubscribe { peer_id } => {
                self.subscribers.remove(&peer_id);
                self.refresh_idle();
            }
            SessionCommand::UnsubscribeAll => {
                self.subscribers.clear();
                self.refresh_idle();
            }
            SessionCommand::SetMode { mode_id, reply } => {
                self.spawn_set_mode(session, mode_id, reply);
                self.refresh_idle();
            }
            SessionCommand::SetConfig {
                config_id,
                value,
                reply,
            } => {
                self.spawn_set_config_option(session, config_id, value, reply);
                self.refresh_idle();
            }
            SessionCommand::UserInput { mut input, answer } => {
                // Only shown while a turn runs; dropping `answer` cancels it.
                if self.turn.as_ref().is_none_or(|turn| turn.cancelled) {
                    return;
                }
                if self.auto_approve
                    && let Some(option_id) = auto_allow(input.params())
                {
                    let _ = answer.send(serde_json::json!({ "optionId": option_id }));
                    return;
                }
                let request_id = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
                    .to_string();
                input.params_mut()["requestId"] = request_id.into();
                let originator = self.turn.as_ref().and_then(|turn| turn.originator_peer_id);
                if let Some(observer) = &self.observer {
                    observer.on_user_input(&input, originator, self.task_push.as_ref());
                }
                let expires = self
                    .input_timeout
                    .map(|timeout| tokio::time::Instant::now() + timeout);
                self.pending_inputs.push(PendingUserInput {
                    input,
                    answer,
                    expires,
                });
                self.refresh_idle();
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
                if answered {
                    self.resume_idle();
                    self.notify_user_input_resolved(&request_id);
                }
                self.refresh_idle();
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
                self.suggestion = Some(suggestion.clone());
                let params = serde_json::json!({
                    "agent": self.agent,
                    "sessionId": self.session_id,
                    "suggestion": suggestion,
                });
                self.notify_subscribers("agent_prompt_suggestion", params);
            }
        }
    }

    fn begin_turn(&mut self, session: &ActiveSession<'_, Agent>, turn: PromptTurn) {
        if self.turn.is_some() {
            let _ = turn.accepted.send(Err(anyhow::anyhow!(
                "ACP agent session already has a prompt in progress"
            )));
            return;
        }
        if let Some(sub) = turn.subscriber {
            self.subscribers.insert(sub.peer_id, sub);
        }
        self.suggestion = None;
        if self.title.is_none() {
            self.title = meta::title_from_prompt(&turn.prompt, &turn.attachments);
        }
        self.touch_turn_metadata(Some(false));

        // Record the turn start and clean user message blocks into the event
        // log (without `VOICE_CHAT_MARKER`) so other subscribers and
        // reconnecting clients see the exact prompt.
        let cmid = turn.client_message_id.clone();
        self.push_event(AgentEvent::TurnStarted);
        let mut emitted_text = false;
        if !turn.prompt.is_empty() {
            self.push_event(user_message_chunk(
                serde_json::json!({ "type": "text", "text": turn.prompt }),
                cmid.as_deref(),
            ));
            emitted_text = true;
        }
        for attachment in &turn.attachments {
            match attachment {
                Attachment::Text { text } => {
                    let chunk = if emitted_text {
                        format!("\n\n{text}")
                    } else {
                        text.clone()
                    };
                    self.push_event(user_message_chunk(
                        serde_json::json!({ "type": "text", "text": chunk }),
                        cmid.as_deref(),
                    ));
                    emitted_text = true;
                }
                Attachment::Image { data, mime_type } => {
                    self.push_event(user_message_chunk(
                        serde_json::json!({
                            "type": "image",
                            "data": data,
                            "mimeType": mime_type,
                        }),
                        cmid.as_deref(),
                    ));
                }
                Attachment::Resource {
                    uri,
                    name,
                    mime_type,
                } => {
                    let mut content = serde_json::json!({
                        "type": "resource_link",
                        "uri": uri,
                        "name": name,
                    });
                    if let Some(mime_type) = mime_type {
                        content["mimeType"] = mime_type.clone().into();
                    }
                    self.push_event(user_message_chunk(content, cmid.as_deref()));
                }
            }
        }

        // `send_prompt` only takes text, so build the request manually to
        // support image/resource blocks. The final stop reason then arrives as
        // the request response instead of through the update stream. An empty
        // prompt is fine as long as attachments carry the content (callers
        // validate).
        let mut content: Vec<ContentBlock> = Vec::new();
        if !turn.prompt.is_empty() {
            content.push(ContentBlock::Text(TextContent::new(turn.prompt)));
        }
        content.extend(
            turn.attachments
                .into_iter()
                .map(Attachment::into_content_block),
        );
        if turn.voice_chat {
            content.push(ContentBlock::Text(TextContent::new(
                crate::agent_rpc::VOICE_CHAT_MARKER,
            )));
        }
        let stop = session
            .connection()
            .send_request_to(
                Agent,
                PromptRequest::new(session.session_id().clone(), content),
            )
            .block_task();
        self.turn = Some(Turn {
            stop: Box::pin(stop),
            answer: String::new(),
            idle_timeout: turn.idle_timeout,
            deadline: tokio::time::Instant::now() + turn.idle_timeout,
            originator_peer_id: turn.originator_peer_id,
            completion: Some(turn.completion),
            cancelled: false,
            timed_out: false,
        });
        self.refresh_idle();
        self.publish();
        self.emit_state(true, false, None, None);
        let _ = turn.accepted.send(Ok(()));
    }

    /// Buffer a load-time replay update without notifying subscribers (the
    /// initial `open_session` response streams the coalesced buffer).
    fn record_replay_update(&mut self, update: SessionUpdate, child: Option<String>) {
        if let SessionUpdate::SubagentUpdate(subagent) = &update {
            self.on_subagent_update(subagent);
        }
        let update_json = update_to_json(update);
        self.apply_update_state(&update_json, child.is_none());
        if child.is_none()
            && self.title.is_none()
            && let Some(title) = meta::title_from_user_chunk(&update_json)
        {
            self.title = Some(title);
        }
        self.events.push(AgentEvent::SessionUpdate {
            update: update_json,
            child_session_id: child,
        });
    }

    /// `child` is the subagent session the update addresses, if any.
    fn on_update(&mut self, update: SessionUpdate, child: Option<String>) {
        if let SessionUpdate::SubagentUpdate(subagent) = &update {
            self.on_subagent_update(subagent);
        }
        if let Some(turn) = &mut self.turn {
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
        }
        let update_json = update_to_json(update);
        let metadata_changed = self.apply_update_state(&update_json, child.is_none());
        self.push_event(AgentEvent::SessionUpdate {
            update: update_json,
            child_session_id: child,
        });
        if metadata_changed {
            self.persist_metadata();
            self.publish();
            self.emit_state(self.turn.is_some(), false, None, None);
        }
    }

    /// Keep actor-owned metadata and mode/config snapshots synchronized with
    /// incoming updates. Returns whether session list metadata (`title` /
    /// `updated_at`) changed.
    fn apply_update_state(&mut self, update: &serde_json::Value, is_root: bool) -> bool {
        if !is_root {
            return false;
        }
        let Some(kind) = update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)
        else {
            return false;
        };
        match kind {
            "session_info_update" => {
                let mut changed = false;
                if let Some(title) =
                    meta::clean_title(update.get("title").and_then(serde_json::Value::as_str))
                    && self.title.as_deref() != Some(title.as_str())
                {
                    self.title = Some(title);
                    changed = true;
                }
                if let Some(updated_at) = update
                    .get("updatedAt")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    let next = meta::pick_newer(self.updated_at.as_deref(), Some(updated_at));
                    if next != self.updated_at {
                        self.updated_at = next;
                        changed = true;
                    }
                }
                changed
            }
            "current_mode_update" => {
                if let Some(mode_id) = update
                    .get("currentModeId")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    self.apply_mode(mode_id);
                }
                false
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions")
                    && options.is_array()
                {
                    self.config_options = Some(options.clone());
                }
                false
            }
            _ => false,
        }
    }

    fn apply_mode(&mut self, mode_id: &str) -> bool {
        let mut changed = false;
        if let Some(serde_json::Value::Object(modes)) = self.modes.as_mut()
            && modes
                .get("currentModeId")
                .and_then(serde_json::Value::as_str)
                != Some(mode_id)
        {
            modes.insert("currentModeId".to_string(), mode_id.into());
            changed = true;
        }
        if let Some(serde_json::Value::Array(options)) = self.config_options.as_mut() {
            for option in options {
                if let Some(map) = option.as_object_mut()
                    && map.get("id").and_then(serde_json::Value::as_str) == Some("mode")
                    && map.get("currentValue").and_then(serde_json::Value::as_str) != Some(mode_id)
                {
                    map.insert("currentValue".to_string(), mode_id.into());
                    changed = true;
                }
            }
        }
        changed
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

    /// Refuse the requests whose `expires` passed, so the agent reads a refusal
    /// and carries on.
    fn refuse_expired_inputs(&mut self) {
        let now = tokio::time::Instant::now();
        let (expired, waiting) = std::mem::take(&mut self.pending_inputs)
            .into_iter()
            .partition(|pending| pending.expires.is_some_and(|at| at <= now));
        self.pending_inputs = waiting;
        for pending in expired {
            tracing::info!(
                "Refusing unanswered {} of {}",
                pending.input.method(),
                self.session_id
            );
            let request_id = pending.input.params()["requestId"]
                .as_str()
                .map(str::to_string);
            let _ = pending.answer.send(refusal(pending.input.params()));
            if let Some(request_id) = request_id {
                self.notify_user_input_resolved(&request_id);
            }
        }
        self.resume_idle();
        self.refresh_idle();
        self.publish();
    }

    /// The agent works again after an answer: its idle time counts from now.
    fn resume_idle(&mut self) {
        if let Some(turn) = &mut self.turn {
            turn.deadline = tokio::time::Instant::now() + turn.idle_timeout;
        }
    }

    /// Settle a subagent's pending requests as cancelled.
    fn drop_child_inputs(&mut self, session_id: &str) {
        let mut dropped_ids = Vec::new();
        self.pending_inputs.retain(|pending| {
            let drop_it = pending.input.params()["childSessionId"] == session_id;
            if drop_it && let Some(id) = pending.input.params()["requestId"].as_str() {
                dropped_ids.push(id.to_string());
            }
            !drop_it
        });
        if !dropped_ids.is_empty() {
            for id in dropped_ids {
                self.notify_user_input_resolved(&id);
            }
            if self.pending_inputs.is_empty() {
                self.resume_idle();
            }
            self.refresh_idle();
            self.publish();
        }
    }

    fn clear_pending_inputs(&mut self) {
        let cleared: Vec<PendingUserInput> = std::mem::take(&mut self.pending_inputs);
        for pending in cleared {
            if let Some(id) = pending.input.params()["requestId"].as_str() {
                self.notify_user_input_resolved(id);
            }
        }
    }

    fn end_turn(&mut self, response: Result<PromptResponse, agent_client_protocol::Error>) {
        let mut turn = self.turn.take().expect("stop of a running turn");
        self.clear_pending_inputs();
        if turn.timed_out {
            self.refresh_idle();
            self.publish();
            return;
        }
        match response {
            Ok(response) => {
                let stop_reason = to_json(response.stop_reason);
                let cancelled = turn.cancelled || stop_reason == "cancelled";
                let mark_unread = !cancelled && self.task_push.is_none();
                self.touch_turn_metadata(mark_unread.then_some(true));
                self.push_event(AgentEvent::TurnEnded {
                    stop_reason: Some(stop_reason),
                    error: None,
                    code: None,
                });
                self.refresh_idle();
                self.publish();
                self.emit_state(false, !cancelled, None, None);
                if let Some(completion) = turn.completion.take() {
                    let _ = completion.send(PromptCompletion {
                        result: Ok(turn.answer),
                        cancelled,
                    });
                }
            }
            Err(err) => {
                let code = acp_error_code(&err).map(str::to_string);
                let message = err.to_string();
                self.touch_updated_at();
                self.push_event(AgentEvent::TurnEnded {
                    stop_reason: None,
                    error: Some(message.clone()),
                    code: code.clone(),
                });
                self.refresh_idle();
                self.publish();
                self.emit_state(false, false, Some(message), code);
                if let Some(completion) = turn.completion.take() {
                    let _ = completion.send(PromptCompletion {
                        result: Err(anyhow::Error::from(err)),
                        cancelled: turn.cancelled,
                    });
                }
            }
        }
    }

    fn touch_updated_at(&mut self) {
        self.touch_turn_metadata(None);
    }

    fn touch_turn_metadata(&mut self, unread: Option<bool>) {
        let now = meta::now_iso();
        self.updated_at = meta::pick_newer(self.updated_at.as_deref(), Some(&now));
        self.meta.merge_metadata(
            &self.agent,
            &self.session_id,
            self.title.as_deref(),
            None,
            self.updated_at.as_deref(),
            unread,
        );
    }

    fn persist_metadata(&self) {
        self.meta.merge_metadata(
            &self.agent,
            &self.session_id,
            self.title.as_deref(),
            None,
            self.updated_at.as_deref(),
            None,
        );
    }

    /// Cancel the running turn; its pending requests settle cancelled.
    fn cancel_turn(&mut self, session: &ActiveSession<'_, Agent>) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        turn.cancelled = true;
        send_cancel(session);
        self.clear_pending_inputs();
        self.refresh_idle();
        self.publish();
    }

    fn push_event(&mut self, event: AgentEvent) {
        if self.subscribers.is_empty() {
            self.events.push(event);
            return;
        }
        let agent = &self.agent;
        let session_id = &self.session_id;
        let epoch = &self.epoch;
        let subscribers = &self.subscribers;
        self.events.push_with(event, |sequenced| {
            let params = serde_json::json!({
                "agent": agent,
                "sessionId": session_id,
                "epoch": epoch,
                "event": sequenced,
            });
            for sub in subscribers.values() {
                (sub.notifier)("agent_session_event", params.clone());
            }
        });
    }

    fn notify_subscribers(&self, method: &str, params: serde_json::Value) {
        for sub in self.subscribers.values() {
            (sub.notifier)(method, params.clone());
        }
    }

    fn emit_state(
        &self,
        running: bool,
        completed: bool,
        error: Option<String>,
        code: Option<String>,
    ) {
        if let Some(observer) = &self.observer {
            observer.on_state(SessionStateUpdate {
                agent: self.agent.clone(),
                session_id: self.session_id.clone(),
                cwd: Some(self.cwd.clone()),
                title: self.title.clone(),
                updated_at: self.updated_at.clone(),
                running,
                completed,
                error,
                code,
            });
        }
    }

    fn notify_user_input_resolved(&self, request_id: &str) {
        if let Some(observer) = &self.observer {
            observer.on_user_input_resolved(&self.agent, &self.session_id, request_id);
        }
    }

    fn build_open_result(
        &self,
        full_replay: bool,
        fresh_load: bool,
        since_seq: u64,
    ) -> SessionOpenResult {
        let events = if full_replay {
            self.events.all()
        } else {
            self.events.since(since_seq)
        };
        SessionOpenResult {
            session_id: self.session_id.clone(),
            epoch: self.epoch.clone(),
            seq: self.events.next_seq(),
            title: self.title.clone(),
            updated_at: self.updated_at.clone(),
            modes: self.modes.clone(),
            config_options: self.config_options.clone(),
            running: self.turn.is_some(),
            user_inputs: self
                .pending_inputs
                .iter()
                .map(|pending| pending.input.clone())
                .collect(),
            suggestion: self.suggestion.clone(),
            events,
            full_replay,
            fresh_load,
        }
    }

    fn refresh_idle(&mut self) {
        let active = self.turn.is_some()
            || !self.pending_inputs.is_empty()
            || !self.control_tasks.is_empty()
            || !self.subscribers.is_empty();
        if active {
            self.idle_since = None;
        } else if self.idle_since.is_none() {
            self.idle_since = Some(tokio::time::Instant::now());
        }
    }

    /// Send `session/set_mode` to the live session without blocking the actor
    /// loop. Safe mid-turn: claude-agent-acp applies it to the running query
    /// (`setPermissionMode`), so the in-flight turn switches immediately.
    fn spawn_set_mode(
        &mut self,
        session: &ActiveSession<'_, Agent>,
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        let connection = session.connection().clone();
        let applied_mode = mode_id.clone();
        let request =
            SetSessionModeRequest::new(session.session_id().clone(), SessionModeId::from(mode_id));
        self.control_tasks.spawn(async move {
            let result = match tokio::time::timeout(
                CONTROL_REQUEST_TIMEOUT,
                connection.send_request_to(Agent, request).block_task(),
            )
            .await
            {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err(format!(
                    "Timeout waiting for session/set_mode after {}s",
                    CONTROL_REQUEST_TIMEOUT.as_secs()
                )),
            };
            let succeeded = result.is_ok();
            let _ = reply.send(result);
            ControlResult::Mode(succeeded.then_some(applied_mode))
        });
    }

    /// Send `session/set_config_option` to the live session without blocking
    /// the actor loop; see `spawn_set_mode` for why this is safe mid-turn.
    fn spawn_set_config_option(
        &mut self,
        session: &ActiveSession<'_, Agent>,
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    ) {
        let connection = session.connection().clone();
        let request = SetSessionConfigOptionRequest::new(
            session.session_id().clone(),
            SessionConfigId::from(config_id),
            SessionConfigValueId::from(value),
        );
        self.control_tasks.spawn(async move {
            let result = match tokio::time::timeout(
                CONTROL_REQUEST_TIMEOUT,
                connection.send_request_to(Agent, request).block_task(),
            )
            .await
            {
                Ok(Ok(response)) => Ok(to_json(response)),
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err(format!(
                    "Timeout waiting for session/set_config_option after {}s",
                    CONTROL_REQUEST_TIMEOUT.as_secs()
                )),
            };
            let snapshot = result.as_ref().ok().cloned();
            let _ = reply.send(result);
            ControlResult::Config(snapshot)
        });
    }

    fn publish(&self) {
        self.status.send_replace(SessionStatus {
            ready: self.ready,
            busy: self.turn.is_some(),
            cwd: Some(self.cwd.clone()),
            title: self.title.clone(),
            updated_at: self.updated_at.clone(),
            pending_inputs: self
                .pending_inputs
                .iter()
                .map(|pending| pending.input.clone())
                .collect(),
        });
    }
}

fn user_message_chunk(content: serde_json::Value, client_message_id: Option<&str>) -> AgentEvent {
    let mut update = serde_json::json!({
        "sessionUpdate": "user_message_chunk",
        "content": content,
    });
    if let Some(id) = client_message_id {
        update["clientMessageId"] = id.into();
    }
    AgentEvent::SessionUpdate {
        update,
        child_session_id: None,
    }
}

/// Coalesced in-memory log of sequenced session events.
///
/// Adjacent text `agent_message_chunk` / `agent_thought_chunk` updates with
/// matching `child_session_id` and `messageId` are merged in place so long
/// streaming sessions keep one JSON value per message run instead of one per
/// token, while recording UTF-8 byte end offsets so `since_seq` slicing stays
/// exact even mid-stream.
#[derive(Default)]
struct EventLog {
    entries: Vec<StoredEvent>,
    next_seq: u64,
}

impl EventLog {
    fn next_seq(&self) -> u64 {
        self.next_seq
    }

    fn push(&mut self, event: AgentEvent) {
        self.next_seq += 1;
        self.append(SequencedEvent {
            seq: self.next_seq,
            event,
        });
    }

    fn push_with(&mut self, event: AgentEvent, on_event: impl FnOnce(&SequencedEvent)) {
        self.next_seq += 1;
        let sequenced = SequencedEvent {
            seq: self.next_seq,
            event,
        };
        on_event(&sequenced);
        self.append(sequenced);
    }

    fn append(&mut self, sequenced: SequencedEvent) {
        if let Some(last) = self.entries.last_mut()
            && last.try_merge(&sequenced)
        {
            return;
        }
        self.entries.push(StoredEvent::new(sequenced));
    }

    fn all(&self) -> Vec<SequencedEvent> {
        self.entries
            .iter()
            .map(|entry| entry.event.clone())
            .collect()
    }

    fn since(&self, since_seq: u64) -> Vec<SequencedEvent> {
        let start = self.entries.partition_point(|e| e.event.seq <= since_seq);
        self.entries[start..]
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                if i == 0 {
                    entry.slice_after(since_seq)
                } else {
                    entry.event.clone()
                }
            })
            .collect()
    }
}

struct StoredEvent {
    first_seq: u64,
    event: SequencedEvent,
    /// Populated once merged (`event.seq > first_seq`): `byte_ends[i]` is the
    /// UTF-8 byte end in `content.text` immediately after `seq = first_seq +
    /// i`.
    byte_ends: Vec<usize>,
}

impl StoredEvent {
    fn new(event: SequencedEvent) -> Self {
        Self {
            first_seq: event.seq,
            event,
            byte_ends: Vec::new(),
        }
    }

    fn try_merge(&mut self, next: &SequencedEvent) -> bool {
        if next.seq != self.event.seq + 1 {
            return false;
        }
        let Some((prev_len, new_len)) = try_merge_text_chunk(&mut self.event, next) else {
            return false;
        };
        if self.byte_ends.is_empty() {
            self.byte_ends.push(prev_len);
        }
        self.byte_ends.push(new_len);
        true
    }

    fn slice_after(&self, since_seq: u64) -> SequencedEvent {
        if since_seq < self.first_seq {
            return self.event.clone();
        }
        let mut sliced = self.event.clone();
        let index = (since_seq - self.first_seq) as usize;
        if let Some(&byte_start) = self.byte_ends.get(index)
            && let AgentEvent::SessionUpdate { update, .. } = &mut sliced.event
            && let Some(serde_json::Value::String(text)) = update
                .get_mut("content")
                .and_then(serde_json::Value::as_object_mut)
                .and_then(|content| content.get_mut("text"))
        {
            text.drain(..byte_start);
        }
        sliced
    }
}

fn try_merge_text_chunk(
    prev: &mut SequencedEvent,
    next: &SequencedEvent,
) -> Option<(usize, usize)> {
    let (
        AgentEvent::SessionUpdate {
            update: prev_update,
            child_session_id: prev_child,
        },
        AgentEvent::SessionUpdate {
            update: next_update,
            child_session_id: next_child,
        },
    ) = (&mut prev.event, &next.event)
    else {
        return None;
    };
    if prev_child != next_child {
        return None;
    }
    let kind = prev_update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str);
    if !matches!(kind, Some("agent_message_chunk" | "agent_thought_chunk"))
        || next_update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)
            != kind
    {
        return None;
    }
    if prev_update.get("messageId") != next_update.get("messageId") {
        return None;
    }
    let next_text = match next_update
        .get("content")
        .and_then(serde_json::Value::as_object)
    {
        Some(content)
            if content.get("type").and_then(serde_json::Value::as_str) == Some("text") =>
        {
            content.get("text").and_then(serde_json::Value::as_str)?
        }
        _ => return None,
    };
    let prev_content = prev_update
        .get_mut("content")
        .and_then(serde_json::Value::as_object_mut)?;
    if prev_content.get("type").and_then(serde_json::Value::as_str) != Some("text") {
        return None;
    }
    let serde_json::Value::String(prev_text) = prev_content.get_mut("text")? else {
        return None;
    };
    let prev_len = prev_text.len();
    prev_text.push_str(next_text);
    let new_len = prev_text.len();
    prev.seq = next.seq;
    Some((prev_len, new_len))
}

/// Finds the option approving a permission request (unattended runs).
fn auto_allow(params: &serde_json::Value) -> Option<String> {
    params
        .get("options")
        .and_then(serde_json::Value::as_array)
        .and_then(|options| {
            ["allow_once", "allow_always"]
                .iter()
                .find_map(|kind| {
                    options.iter().find(|option| {
                        option.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                    })
                })
                .or_else(|| {
                    options.iter().find(|option| {
                        option
                            .get("kind")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|k| k.starts_with("allow"))
                    })
                })
        })
        .and_then(|option| option.get("optionId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// Answer refusing a request: the permission request's reject option, so the
/// agent reads a refusal and carries on (a bare cancel reads as a failed
/// request in claude-agent-acp). Questions have no options; an empty response
/// cancels them.
fn refusal(params: &serde_json::Value) -> serde_json::Value {
    params
        .get("options")
        .and_then(serde_json::Value::as_array)
        .and_then(|options| {
            ["reject_once", "reject_always"].iter().find_map(|kind| {
                options.iter().find(|option| {
                    option.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                })
            })
        })
        .and_then(|option| option.get("optionId"))
        .map_or_else(
            || serde_json::json!({}),
            |id| serde_json::json!({ "optionId": id }),
        )
}

fn send_cancel(session: &ActiveSession<'_, Agent>) {
    let notification = CancelNotification::new(session.session_id().clone());
    if let Err(err) = session.connection().send_notification(notification) {
        tracing::warn!("Failed to cancel ACP session: {err}");
    }
}

pub(super) const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

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

/// Buffer the session updates routed before the load response (the
/// `session/load` history replay) into `actor`. The replay is complete by the
/// time the load response arrives, so once the queue is quiet for a moment the
/// drain is done; dropping the pending `read_update` on timeout loses nothing.
///
/// Subagents replay their history to their own sessions, routed to
/// `child_rx`; their announcements on the parent come first (see `serve`).
/// Their current state follows the load response, within the drain, so
/// `on_subagent_update` sees it; replayed announcements carry no `cancel`
/// grant.
async fn drain_replay(
    session: &mut ActiveSession<'_, Agent>,
    child_rx: &mut mpsc::UnboundedReceiver<ChildUpdate>,
    actor: &mut SessionActor,
) -> Result<(), agent_client_protocol::Error> {
    const REPLAY_IDLE: Duration = Duration::from_millis(200);
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
                        actor.record_replay_update(notif.update, None);
                        Ok(())
                    })
                    .await
                    .otherwise_ignore()?;
            }
            Ok(Ok(Ok(_))) => {}
            Ok(Ok(Err(err))) => return Err(err),
            Ok(Err(ChildUpdate { session_id, update })) => {
                actor.record_replay_update(update, Some(session_id));
            }
            Err(_) => break,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_session_metadata_from_load_meta() {
        let meta = serde_json::Map::from_iter([
            ("title".to_string(), json!("Loaded title")),
            ("updatedAt".to_string(), json!("2026-08-27T00:00:00Z")),
        ]);
        assert_eq!(
            super::runtime::session_metadata_from_meta(Some(&meta)),
            (
                Some("Loaded title".to_string()),
                Some("2026-08-27T00:00:00Z".to_string())
            )
        );
    }

    #[test]
    fn coalesces_adjacent_agent_chunks_in_place_with_exact_since_slicing() {
        let chunk = |kind, text, msg_id: Option<&str>, child: Option<&str>| {
            let mut update = json!({
                "sessionUpdate": kind,
                "content": { "type": "text", "text": text },
            });
            if let Some(id) = msg_id {
                update["messageId"] = id.into();
            }
            AgentEvent::SessionUpdate {
                update,
                child_session_id: child.map(str::to_string),
            }
        };
        let mut log = EventLog::default();
        log.push(chunk("agent_message_chunk", "你好", Some("m1"), None)); // seq 1
        log.push(chunk("agent_message_chunk", "，", Some("m1"), None)); // seq 2
        log.push(chunk("agent_message_chunk", "世界", Some("m1"), None)); // seq 3
        log.push(chunk("agent_message_chunk", "!", Some("m2"), None)); // seq 4
        log.push(chunk("agent_thought_chunk", "hmm", None, None)); // seq 5
        log.push(chunk("agent_thought_chunk", "...", None, None)); // seq 6
        log.push(chunk("agent_message_chunk", "sub1", None, Some("c1"))); // seq 7
        log.push(chunk("agent_message_chunk", "sub2", None, Some("c1"))); // seq 8

        assert_eq!(log.next_seq(), 8);
        assert_eq!(log.entries.len(), 4);

        let text_of = |event: &SequencedEvent| match &event.event {
            AgentEvent::SessionUpdate { update, .. } => {
                update["content"]["text"].as_str().unwrap().to_string()
            }
            _ => panic!("expected SessionUpdate"),
        };

        let merged = log.all();
        assert_eq!(merged.len(), 4);
        assert_eq!(merged[0].seq, 3);
        assert_eq!(merged[1].seq, 4);
        assert_eq!(merged[2].seq, 6);
        assert_eq!(merged[3].seq, 8);
        assert_eq!(text_of(&merged[0]), "你好，世界");
        assert_eq!(text_of(&merged[1]), "!");
        assert_eq!(text_of(&merged[2]), "hmm...");
        assert_eq!(text_of(&merged[3]), "sub1sub2");

        // Incremental slice starting mid-run (after seq 1) trims UTF-8 prefix
        // cleanly.
        let after_1 = log.since(1);
        assert_eq!(after_1.len(), 4);
        assert_eq!(after_1[0].seq, 3);
        assert_eq!(text_of(&after_1[0]), "，世界");
        assert_eq!(text_of(&after_1[1]), "!");

        // Incremental slice after seq 2 keeps only seq 3's text from the first
        // run.
        let after_2 = log.since(2);
        assert_eq!(after_2.len(), 4);
        assert_eq!(after_2[0].seq, 3);
        assert_eq!(text_of(&after_2[0]), "世界");

        // Incremental slice at exact run boundary skips the completed run.
        let after_3 = log.since(3);
        assert_eq!(after_3.len(), 3);
        assert_eq!(after_3[0].seq, 4);
        assert_eq!(text_of(&after_3[0]), "!");

        // Up-to-date cursor returns empty.
        assert!(log.since(8).is_empty());
    }
}
