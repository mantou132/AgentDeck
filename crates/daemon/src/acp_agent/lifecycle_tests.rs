use std::time::Duration;

use agent_client_protocol::{Channel, TransportFrame};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::{session::SESSION_CLOSE_TIMEOUT, *};

fn frame(message: Value) -> TransportFrame {
    TransportFrame::parse_json(&message.to_string())
}

fn frame_json(frame: TransportFrame) -> Value {
    serde_json::from_str(&frame.to_json().unwrap()).unwrap()
}

fn full_capabilities() -> Value {
    json!({"loadSession": true, "sessionCapabilities": {"close": {}}})
}

/// Captures `SessionObserver` callbacks for test assertions.
struct TestObserver {
    states: mpsc::UnboundedSender<SessionStateUpdate>,
    inputs: mpsc::UnboundedSender<(String, Value)>,
    resolved: mpsc::UnboundedSender<(String, String, String)>,
    ended: mpsc::UnboundedSender<(String, String)>,
    deleted: mpsc::UnboundedSender<(String, String)>,
    unread: mpsc::UnboundedSender<(String, String, bool)>,
}

struct ObserverRx {
    states: mpsc::UnboundedReceiver<SessionStateUpdate>,
    inputs: mpsc::UnboundedReceiver<(String, Value)>,
    resolved: mpsc::UnboundedReceiver<(String, String, String)>,
    ended: mpsc::UnboundedReceiver<(String, String)>,
    deleted: mpsc::UnboundedReceiver<(String, String)>,
    unread: mpsc::UnboundedReceiver<(String, String, bool)>,
}

impl TestObserver {
    fn new() -> (Arc<Self>, ObserverRx) {
        let (states, states_rx) = mpsc::unbounded_channel();
        let (inputs, inputs_rx) = mpsc::unbounded_channel();
        let (resolved, resolved_rx) = mpsc::unbounded_channel();
        let (ended, ended_rx) = mpsc::unbounded_channel();
        let (deleted, deleted_rx) = mpsc::unbounded_channel();
        let (unread, unread_rx) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                states,
                inputs,
                resolved,
                ended,
                deleted,
                unread,
            }),
            ObserverRx {
                states: states_rx,
                inputs: inputs_rx,
                resolved: resolved_rx,
                ended: ended_rx,
                deleted: deleted_rx,
                unread: unread_rx,
            },
        )
    }
}

impl SessionObserver for TestObserver {
    fn on_state(&self, update: SessionStateUpdate) {
        let _ = self.states.send(update);
    }

    fn on_user_input(
        &self,
        input: &UserInput,
        _originator_peer_id: Option<u64>,
        _task_push: Option<&TaskInputPush>,
    ) {
        let _ = self
            .inputs
            .send((input.method().to_string(), input.params().clone()));
    }

    fn on_user_input_resolved(&self, agent: &str, session_id: &str, request_id: &str) {
        let _ = self.resolved.send((
            agent.to_string(),
            session_id.to_string(),
            request_id.to_string(),
        ));
    }

    fn on_session_ended(&self, agent: &str, session_id: &str) {
        let _ = self.ended.send((agent.to_string(), session_id.to_string()));
    }

    fn on_session_deleted(&self, agent: &str, session_id: &str) {
        let _ = self
            .deleted
            .send((agent.to_string(), session_id.to_string()));
    }

    fn on_session_unread(&self, agent: &str, session_id: &str, unread: bool) {
        let _ = self
            .unread
            .send((agent.to_string(), session_id.to_string(), unread));
    }
}

fn make_subscriber(peer_id: u64) -> (SessionSubscriber, mpsc::UnboundedReceiver<(String, Value)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let notifier: Notifier = Arc::new(move |method, params| {
        let _ = tx.send((method.to_string(), params));
    });
    (SessionSubscriber { peer_id, notifier }, rx)
}

// The real manager, actors and ACP SDK run against an in-memory ACP transport.
// No user agent, browser or Relay process is started or stopped.
struct MockAcp {
    manager: AgentSessionManager,
    observer: ObserverRx,
    peer: Channel,
    connection: JoinHandle<()>,
}

impl MockAcp {
    async fn new() -> Self {
        Self::with_capabilities(full_capabilities()).await
    }

    async fn with_capabilities(capabilities: Value) -> Self {
        let (observer, observer_rx) = TestObserver::new();
        let manager = AgentSessionManager::new(Some(observer));
        let (peer, connection) = Self::connect(&manager, capabilities).await;
        Self {
            manager,
            observer: observer_rx,
            peer,
            connection,
        }
    }

    async fn with_idle_timeout(idle_timeout: Duration) -> Self {
        let (observer, observer_rx) = TestObserver::new();
        let manager = AgentSessionManager::new(Some(observer)).with_idle_timeout(idle_timeout);
        let (peer, connection) = Self::connect(&manager, full_capabilities()).await;
        Self {
            manager,
            observer: observer_rx,
            peer,
            connection,
        }
    }

    async fn connect(
        manager: &AgentSessionManager,
        capabilities: Value,
    ) -> (Channel, JoinHandle<()>) {
        let runtime = manager.runtime("codex-acp");
        let generation = {
            let mut state = runtime.state.lock().await;
            state.generation += 1;
            state.generation
        };
        let (transport, mut peer) = Channel::duplex();
        let connected_runtime = runtime.clone();
        let connection = tokio::spawn(async move {
            let _ = connected_runtime.connect_agent(generation, transport).await;
            connected_runtime
                .connection_stopped(generation, "mock ACP disconnected".into())
                .await;
        });
        let request = frame_json(peer.rx.next().await.unwrap());
        assert_eq!(request["method"], "initialize");
        assert_eq!(
            request["params"]["clientCapabilities"]["elicitation"],
            json!({"form": {}})
        );
        assert_eq!(
            request["params"]["clientCapabilities"]["subagents"],
            json!({})
        );
        peer.tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0", "id": request["id"], "result": {
                    "protocolVersion": 1, "agentCapabilities": capabilities
                }
            })))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.state.lock().await.connection.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        (peer, connection)
    }

    async fn next(&mut self, method: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let message = frame_json(self.peer.rx.next().await.unwrap());
                // Dropping an in-flight SDK request emits this transport-level
                // cancellation.
                if message["method"] == "$/cancel_request" {
                    continue;
                }
                assert_eq!(message["method"], method, "{message}");
                return message;
            }
        })
        .await
        .expect("ACP request did not arrive")
    }

    fn respond(&self, request: &Value, result: Value) {
        self.peer
            .tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0", "id": request["id"], "result": result,
            })))
            .unwrap();
    }

    fn respond_error(&self, request: &Value, error: Value) {
        self.peer
            .tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0", "id": request["id"], "error": error,
            })))
            .unwrap();
    }

    async fn create(&mut self, id: &str) -> SessionReady {
        let manager = self.manager.clone();
        let call = tokio::spawn(async move {
            manager
                .create_session("codex-acp", None, Default::default(), None)
                .await
        });
        let request = self.next("session/new").await;
        self.respond(&request, json!({"sessionId": id}));
        let ready = call.await.unwrap().unwrap();
        assert_eq!(ready.session_id, id);
        ready
    }

    async fn open_fresh(&mut self, id: &str) -> SessionOpenResult {
        let manager = self.manager.clone();
        let id = id.to_string();
        let call = tokio::spawn(async move {
            manager
                .open_session("codex-acp", &id, None, Default::default(), None, None, 0)
                .await
        });
        let request = self.next("session/load").await;
        self.respond(&request, json!({}));
        call.await.unwrap().unwrap()
    }

    async fn registered(&self, id: &str) -> bool {
        let key = AgentSessionKey::new("codex-acp", id);
        self.manager.sessions.lock().await.contains_key(&key)
    }

    fn close(&self, id: &str) -> JoinHandle<bool> {
        let manager = self.manager.clone();
        let id = id.to_string();
        tokio::spawn(async move { manager.close_session("codex-acp", &id).await })
    }

    fn prompt(&self, id: &str) -> JoinHandle<Result<String>> {
        self.prompt_with(id, 30, None)
    }

    fn prompt_with(
        &self,
        id: &str,
        timeout_secs: u64,
        subscriber: Option<SessionSubscriber>,
    ) -> JoinHandle<Result<String>> {
        let manager = self.manager.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let handle = manager
                .start_prompt(
                    "codex-acp",
                    &id,
                    PromptOptions {
                        prompt: "test".into(),
                        attachments: vec![],
                        voice_chat: false,
                        client_message_id: None,
                        timeout_secs,
                        originator_peer_id: subscriber.as_ref().map(|s| s.peer_id),
                        subscriber,
                    },
                )
                .await?;
            match handle.completion.await {
                Ok(done) => done.result,
                Err(_) => anyhow::bail!("ACP agent session closed before responding"),
            }
        })
    }
}

impl Drop for MockAcp {
    fn drop(&mut self) {
        self.connection.abort();
    }
}

#[tokio::test]
async fn close_waits_for_acp_release_before_open_and_prompt() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    assert!(
        !close.is_finished(),
        "close returned before ACP released the session"
    );
    mock.respond(&request, json!({}));
    assert!(close.await.unwrap());
    let opened = mock.open_fresh("session").await;
    assert!(opened.fresh_load);
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn active_sessions_lists_only_sessions_with_an_unfinished_prompt() {
    let mut mock = MockAcp::new().await;
    mock.create("busy").await;
    mock.create("idle").await;
    assert!(mock.manager.active_sessions().await.is_empty());

    let prompt = mock.prompt("busy");
    let request = mock.next("session/prompt").await;
    let active = mock.manager.active_sessions().await;
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].agent, "codex-acp");
    assert_eq!(active[0].session_id, "busy");

    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    assert!(mock.manager.active_sessions().await.is_empty());
}

/// Claude reports an expired login as `AuthRequired` on the prompt.
#[tokio::test]
async fn auth_required_keeps_its_code_for_the_app() {
    let auth_required = || json!({"code": -32000, "message": "Authentication required"});
    let is_auth_required =
        |err: anyhow::Error| crate::agent_rpc::agent_error(err).code == Some("auth_required");
    let mut mock = MockAcp::new().await;

    mock.create("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond_error(&request, auth_required());
    assert!(is_auth_required(prompt.await.unwrap().unwrap_err()));

    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond_error(
        &request,
        json!({"code": -32603, "message": "Internal error"}),
    );
    assert!(!is_auth_required(prompt.await.unwrap().unwrap_err()));
}

#[tokio::test]
async fn close_timeout_releases_pending_turn_and_permissions_but_preserves_other_sessions() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    mock.create("other").await;
    let prompt = mock.prompt("session");
    let old_prompt = mock.next("session/prompt").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let old_close = mock.next("session/close").await;
    assert!(
        tokio::time::timeout(Duration::from_secs(1), prompt)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        tokio::time::timeout(SESSION_CLOSE_TIMEOUT + Duration::from_secs(1), close)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(!mock.registered("session").await);
    assert!(mock.manager.session("codex-acp", "other").await.is_ok());
    // Replies from the abandoned turn/close must not invalidate the new actor.
    mock.open_fresh("session").await;
    mock.respond(&old_prompt, json!({"stopReason": "cancelled"}));
    mock.respond(&old_close, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}

#[tokio::test]
async fn concurrent_close_and_open_wait_for_one_cleanup() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let first = mock.close("session");
    mock.next("session/cancel").await;
    let close = mock.next("session/close").await;
    let second = mock.close("session");
    let manager = mock.manager.clone();
    let open = tokio::spawn(async move {
        manager
            .open_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                None,
                None,
                0,
            )
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "open must not reach ACP before close finishes"
    );
    assert!(!first.is_finished() && !second.is_finished());
    mock.respond(&close, json!({}));
    assert!(first.await.unwrap());
    assert!(second.await.unwrap());
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    let opened = open.await.unwrap().unwrap();
    assert!(opened.fresh_load);
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}

#[tokio::test]
async fn close_interrupts_a_stuck_mode_request_and_unsupported_close_is_recoverable() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let manager = mock.manager.clone();
    let mode = tokio::spawn(async move { manager.set_mode("codex-acp", "session", "plan").await });
    let old_mode = mock.next("session/set_mode").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": request["id"],
            "error": {"code": -32601, "message": "Method not found"},
        })))
        .unwrap();
    assert!(close.await.unwrap());
    assert!(mode.await.unwrap().is_err());
    mock.open_fresh("session").await;
    mock.respond(&old_mode, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn open_session_is_idempotent_while_turn_runs_and_supports_incremental_sync() {
    let mut mock = MockAcp::new().await;
    let created = mock.create("session").await;

    let (sub1, mut rx1) = make_subscriber(1);
    let prompt = mock.prompt_with("session", 30, Some(sub1));
    let prompt_req = mock.next("session/prompt").await;

    // Emit two agent chunks while turn is running.
    for text in ["Hel", "lo"] {
        mock.peer
            .tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0", "method": "session/update",
                "params": {
                    "sessionId": "session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text}
                    }
                }
            })))
            .unwrap();
    }
    // Wait until sub1 sees both chunks (plus TurnStarted + user_message_chunk =
    // 4 events).
    let mut last_seq = 0;
    for _ in 0..4 {
        let (method, params) = tokio::time::timeout(Duration::from_secs(1), rx1.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(method, "agent_session_event");
        last_seq = params["event"]["seq"].as_u64().unwrap();
    }
    assert_eq!(last_seq, 4);

    // Second device opens the running session with no cursor -> reuses live
    // actor (no session/load!), gets full replay with coalesced chunks and
    // `running: true`.
    let (sub2, mut rx2) = make_subscriber(2);
    let opened = mock
        .manager
        .open_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            Some(sub2),
            None,
            0,
        )
        .await
        .unwrap();
    assert!(!opened.fresh_load);
    assert!(opened.full_replay);
    assert!(opened.running);
    assert_eq!(opened.epoch, created.epoch);
    assert_eq!(opened.seq, 4);
    // Coalesced: TurnStarted (1), user_message_chunk (2), merged
    // agent_message_chunk "Hello" (seq 4).
    assert_eq!(opened.events.len(), 3);
    assert_eq!(opened.events[2].seq, 4);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "idempotent open must not send session/load to ACP"
    );

    // Another chunk arrives -> reaches both sub1 and sub2.
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": " world"}
                }
            }
        })))
        .unwrap();
    let (_, p1) = rx1.recv().await.unwrap();
    let (_, p2) = rx2.recv().await.unwrap();
    assert_eq!(p1["event"]["seq"], 5);
    assert_eq!(p2["event"]["seq"], 5);

    // Incremental re-open with matching epoch & since_seq=4 returns only seq 5.
    let inc = mock
        .manager
        .open_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            None,
            Some(created.epoch.clone()),
            4,
        )
        .await
        .unwrap();
    assert!(!inc.full_replay);
    assert!(!inc.fresh_load);
    assert_eq!(inc.seq, 5);
    assert_eq!(inc.events.len(), 1);
    assert_eq!(inc.events[0].seq, 5);

    // Re-open with stale/wrong epoch falls back to full replay.
    let wrong_epoch = mock
        .manager
        .open_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            None,
            Some("stale-epoch".into()),
            4,
        )
        .await
        .unwrap();
    assert!(wrong_epoch.full_replay);
    assert_eq!(wrong_epoch.events.len(), 3);

    mock.respond(&prompt_req, json!({"stopReason": "end_turn"}));
    assert_eq!(prompt.await.unwrap().unwrap(), "Hello world");
}

#[tokio::test]
async fn concurrent_open_while_loading_queues_behind_single_acp_load() {
    let mut mock = MockAcp::new().await;
    let manager1 = mock.manager.clone();
    let first = tokio::spawn(async move {
        manager1
            .open_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                None,
                None,
                0,
            )
            .await
    });
    let request = mock.next("session/load").await;

    let manager2 = mock.manager.clone();
    let second = tokio::spawn(async move {
        manager2
            .open_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                None,
                None,
                0,
            )
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "concurrent open must not send a second session/load to ACP"
    );

    mock.respond(&request, json!({}));
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "history"}
                }
            }
        })))
        .unwrap();

    let r1 = first.await.unwrap().unwrap();
    let r2 = second.await.unwrap().unwrap();
    assert!(r1.fresh_load);
    assert!(!r2.fresh_load);
    assert_eq!(r1.epoch, r2.epoch);
    assert_eq!(r1.events.len(), 1);
    assert_eq!(r2.events.len(), 1);
}

#[tokio::test]
async fn abandoned_open_replay_does_not_leave_an_unregistered_actor() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let open = tokio::spawn(async move {
        manager
            .open_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                None,
                None,
                0,
            )
            .await
    });
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    // Supply a replay event so the actor is inside drain_replay.
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "session", "update": {
                    "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "history"}
                }
            }
        })))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    open.abort();
    assert!(open.await.err().unwrap().is_cancelled());
    mock.next("session/cancel").await;
    let request = mock.next("session/close").await;
    mock.respond(&request, json!({}));
    tokio::time::timeout(Duration::from_secs(1), async {
        while mock.registered("session").await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    mock.open_fresh("session").await;
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}

#[tokio::test]
async fn acp_disconnect_cleans_old_actor_and_notifies_observer() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let old = mock.manager.session("codex-acp", "session").await.unwrap();
    let prompt = mock.prompt("session");
    mock.next("session/prompt").await;
    mock.peer.tx.close_channel();
    tokio::time::timeout(Duration::from_secs(1), old.wait_closed())
        .await
        .unwrap();
    assert!(prompt.await.unwrap().is_err());
    let ended = tokio::time::timeout(Duration::from_secs(1), mock.observer.ended.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ended, ("codex-acp".to_string(), "session".to_string()));
    assert!(!mock.manager.close_session("codex-acp", "session").await);
    let (peer, connection) = MockAcp::connect(&mock.manager, full_capabilities()).await;
    mock.peer = peer;
    mock.connection = connection;
    mock.open_fresh("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn idle_session_reclaims_silently_without_ending_notification_and_running_never_reclaims() {
    let mut mock = MockAcp::with_idle_timeout(Duration::from_millis(120)).await;
    mock.create("session").await;

    // While a turn runs, idle timeout must NOT reclaim the session.
    let prompt = mock.prompt("session");
    let prompt_req = mock.next("session/prompt").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(mock.registered("session").await);

    // Once the turn ends and there are no subscribers, the session reclaims
    // gracefully without emitting `on_session_ended`.
    mock.respond(&prompt_req, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    let close_req = mock.next("session/close").await;
    mock.respond(&close_req, json!({}));
    tokio::time::timeout(Duration::from_secs(1), async {
        while mock.registered("session").await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        mock.observer.ended.try_recv().is_err(),
        "idle reclamation must exit silently without on_session_ended"
    );

    // Re-opening loads cleanly from ACP.
    let reopened = mock.open_fresh("session").await;
    assert!(reopened.fresh_load);
}

#[tokio::test]
async fn close_cancels_a_real_acp_permission_request_without_waiting_for_the_user() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let prompt = mock.prompt("session");
    mock.next("session/prompt").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Test permission", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}]
            }
        })))
        .unwrap();
    let (_, permission) = tokio::time::timeout(Duration::from_secs(1), mock.observer.inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(permission["agent"], "codex-acp");
    assert_eq!(permission["sessionId"], "session");
    let close = mock.close("session");
    tokio::time::timeout(Duration::from_secs(1), async {
        let (mut cancelled, mut closed, mut permission_cancelled) = (false, false, false);
        while !(cancelled && closed && permission_cancelled) {
            let message = frame_json(mock.peer.rx.next().await.unwrap());
            match message["method"].as_str() {
                Some("$/cancel_request") => {}
                Some("session/cancel") => cancelled = true,
                Some("session/close") => {
                    mock.respond(&message, json!({}));
                    closed = true;
                }
                None if message["id"] == "permission" => {
                    assert_eq!(message["result"]["outcome"]["outcome"], "cancelled");
                    permission_cancelled = true;
                }
                _ => panic!("Unexpected ACP message: {message}"),
            }
        }
    })
    .await
    .unwrap();
    assert!(close.await.unwrap());
    assert!(prompt.await.unwrap().is_err());
    mock.open_fresh("session").await;
}

#[tokio::test]
async fn user_input_is_answered_broadcasts_resolved_and_close_cancels_it() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let prompt = mock.prompt("session");
    mock.next("session/prompt").await;
    let elicitation = |id: &str| {
        frame(json!({
            "jsonrpc": "2.0", "id": id, "method": "elicitation/create",
            "params": {
                "mode": "form", "sessionId": "session", "toolCallId": "tool",
                "message": "Which?",
                "requestedSchema": {"type": "object", "properties": {
                    "question_0": {"type": "string", "oneOf": [{"const": "A", "title": "A"}]}
                }}
            }
        }))
    };
    mock.peer.tx.unbounded_send(elicitation("ask")).unwrap();
    let (method, request) = mock.observer.inputs.recv().await.unwrap();
    assert_eq!(method, "agent_elicitation_request");
    assert_eq!(request["agent"], "codex-acp");
    assert_eq!(request["sessionId"], "session");
    assert_eq!(request["toolCallId"], "tool");
    assert_eq!(
        request["requestedSchema"]["properties"]["question_0"]["oneOf"][0]["const"],
        "A"
    );
    // A reloaded device finds the question again and answers it.
    assert_eq!(
        serde_json::to_value(mock.manager.pending_user_inputs().await).unwrap(),
        json!([{"method": "agent_elicitation_request", "params": request}])
    );
    let request_id = request["requestId"].as_str().unwrap().to_string();
    let response = json!({"action": "accept", "content": {"question_0": "A"}});
    assert!(
        !mock
            .manager
            .answer_user_input("codex-acp", "session", "stale", response.clone())
            .await
    );
    assert!(
        mock.manager
            .answer_user_input("codex-acp", "session", &request_id, response.clone())
            .await
    );
    let resolved = mock.observer.resolved.recv().await.unwrap();
    assert_eq!(
        resolved,
        ("codex-acp".to_string(), "session".to_string(), request_id)
    );
    let answer = frame_json(mock.peer.rx.next().await.unwrap());
    assert_eq!(answer["id"], "ask");
    assert_eq!(answer["result"], response);
    assert!(mock.manager.pending_user_inputs().await.is_empty());

    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Test permission", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}]
            }
        })))
        .unwrap();
    let (method, request) = mock.observer.inputs.recv().await.unwrap();
    assert_eq!(method, "agent_permission_request");
    let request_id = request["requestId"].as_str().unwrap();
    assert!(
        mock.manager
            .answer_user_input(
                "codex-acp",
                "session",
                request_id,
                json!({"optionId": "allow"})
            )
            .await
    );
    let answer = frame_json(mock.peer.rx.next().await.unwrap());
    assert_eq!(answer["id"], "permission");
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow");

    mock.peer.tx.unbounded_send(elicitation("pending")).unwrap();
    mock.observer.inputs.recv().await.unwrap();
    let close = mock.close("session");
    tokio::time::timeout(Duration::from_secs(1), async {
        let (mut closed, mut elicitation_cancelled) = (false, false);
        while !(closed && elicitation_cancelled) {
            let message = frame_json(mock.peer.rx.next().await.unwrap());
            match message["method"].as_str() {
                Some("$/cancel_request" | "session/cancel") => {}
                Some("session/close") => {
                    mock.respond(&message, json!({}));
                    closed = true;
                }
                None if message["id"] == "pending" => {
                    assert_eq!(message["result"]["action"], "cancel");
                    elicitation_cancelled = true;
                }
                _ => panic!("Unexpected ACP message: {message}"),
            }
        }
    })
    .await
    .unwrap();
    assert!(close.await.unwrap());
    assert!(prompt.await.unwrap().is_err());
}

#[tokio::test]
async fn unadvertised_session_methods_are_not_sent_to_acp() {
    let mut mock = MockAcp::with_capabilities(json!({})).await;
    let manager = mock.manager.clone();
    let open = manager
        .open_session("codex-acp", "old", None, Default::default(), None, None, 0)
        .await;
    assert!(
        open.err()
            .unwrap()
            .to_string()
            .contains("does not support loading")
    );
    let list = manager.list_sessions("codex-acp", None, None).await;
    assert!(
        list.unwrap_err()
            .to_string()
            .contains("does not support listing")
    );
    // Deleting when ACP does not advertise `delete` soft-deletes in daemon
    // without sending `session/delete` to the agent.
    manager.delete_session("codex-acp", "old").await.unwrap();
    assert_eq!(
        mock.observer.deleted.try_recv().unwrap(),
        ("codex-acp".to_string(), "old".to_string())
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "unadvertised session/delete must not reach the agent"
    );

    mock.create("session").await;
    let close = mock.close("session");
    mock.next("session/cancel").await;
    assert!(close.await.unwrap());
    // Nothing else, in particular no session/close, reached the agent.
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn prompt_suggestion_after_turn_reaches_subscribers_and_open_snapshot() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (sub, mut sub_rx) = make_subscriber(1);
    let prompt = mock.prompt_with("session", 30, Some(sub));
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());

    // The SDK emits the suggestion after the result, while the session is idle.
    for message in [
        json!({"type": "rate_limit_event"}),
        json!({"type": "prompt_suggestion", "suggestion": "  Run the tests  "}),
    ] {
        mock.peer
            .tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0",
                "method": "_claude/sdkMessage",
                "params": {"sessionId": "session", "message": message},
            })))
            .unwrap();
    }
    let (method, params) = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let item = sub_rx.recv().await.unwrap();
            if item.0 == "agent_prompt_suggestion" {
                return item;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(method, "agent_prompt_suggestion");
    assert_eq!(
        params,
        json!({"agent": "codex-acp", "sessionId": "session", "suggestion": "Run the tests"})
    );

    // Re-opening sees the saved suggestion too.
    let opened = mock
        .manager
        .open_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            None,
            None,
            0,
        )
        .await
        .unwrap();
    assert_eq!(opened.suggestion.as_deref(), Some("Run the tests"));
}

#[tokio::test]
async fn updates_between_turns_are_sequenced_events_for_subscribers() {
    let mut mock = MockAcp::new().await;
    let (sub, mut sub_rx) = make_subscriber(1);
    let manager = mock.manager.clone();
    let call = tokio::spawn(async move {
        manager
            .create_session("codex-acp", None, Default::default(), Some(sub))
            .await
    });
    let request = mock.next("session/new").await;
    mock.respond(&request, json!({"sessionId": "session"}));
    call.await.unwrap().unwrap();

    // Agents announce their commands after the `session/new` response.
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "session", "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [{"name": "review", "description": "Review changes"}],
            }},
        })))
        .unwrap();
    let (method, params) = tokio::time::timeout(Duration::from_secs(1), sub_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_session_event");
    assert_eq!(params["agent"], "codex-acp");
    assert_eq!(params["sessionId"], "session");
    assert_eq!(params["event"]["seq"], 1);
    assert_eq!(
        params["event"]["update"]["sessionUpdate"],
        "available_commands_update"
    );
    assert_eq!(
        params["event"]["update"]["availableCommands"][0]["name"],
        "review"
    );
}

#[tokio::test]
async fn a_silent_turn_times_out_and_is_cancelled_while_updates_keep_it_alive() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let prompt = mock.prompt_with("session", 1, None);
    let request = mock.next("session/prompt").await;
    // Updates renew the idle deadline: activity spanning longer than the
    // timeout does not fail the turn.
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        mock.peer
            .tx
            .unbounded_send(frame(json!({
                "jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "session", "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "working"}
                    }
                }
            })))
            .unwrap();
    }
    assert!(!prompt.is_finished());
    mock.next("session/cancel").await;
    let err = prompt.await.unwrap().unwrap_err().to_string();
    assert!(err.contains("no activity for 1s"), "{err}");
    // The cancelled turn settles, then the session takes the next prompt.
    mock.respond(&request, json!({"stopReason": "cancelled"}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn a_second_prompt_during_a_turn_is_rejected() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let first = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    let second = mock.prompt("session").await.unwrap().unwrap_err();
    assert!(
        second
            .to_string()
            .contains("already has a prompt in progress")
    );
    assert_eq!(mock.manager.active_sessions().await.len(), 1);
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(first.await.unwrap().is_ok());
    assert!(mock.manager.active_sessions().await.is_empty());
}

#[tokio::test]
async fn subagent_traffic_reaches_the_parent_turn_and_child_requests_settle() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (sub, mut sub_rx) = make_subscriber(1);
    let prompt = mock.prompt_with("session", 30, Some(sub));
    let prompt_request = mock.next("session/prompt").await;
    // Drain TurnStarted + user_message_chunk emitted on begin_turn.
    for _ in 0..2 {
        sub_rx.recv().await.unwrap();
    }
    let update = |session_id: &str, update: Value| {
        frame(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": session_id, "update": update}
        }))
    };
    let chunk = |text: &str| json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}});
    let send = |frame| mock.peer.tx.unbounded_send(frame).unwrap();
    send(update(
        "session",
        json!({
            "sessionUpdate": "subagent_update", "sessionId": "child", "title": "scout",
            "capabilities": {"cancel": {}}, "state": {"state": "running"}
        }),
    ));
    send(update("child", chunk("child says")));
    send(update("session", chunk("parent says")));
    let mut events = Vec::new();
    for _ in 0..3 {
        let (_, params) = sub_rx.recv().await.unwrap();
        let ev = &params["event"];
        assert_eq!(ev["event"], "session_update");
        events.push((
            ev["update"]["sessionUpdate"].clone(),
            ev["childSessionId"].as_str().map(str::to_string),
        ));
    }
    // The announcement precedes the child's traffic; other parent updates may
    // come before or after it.
    assert_eq!(events[0], (json!("subagent_update"), None));
    assert!(events.contains(&(json!("agent_message_chunk"), Some("child".to_string()))));
    assert!(events.contains(&(json!("agent_message_chunk"), None)));

    let permission = |id: &str, session_id: &str| {
        frame(json!({
            "jsonrpc": "2.0", "id": id, "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {"toolCallId": id, "title": "Test permission", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}]
            }
        }))
    };
    send(permission("child-permission", "child"));
    let (_, child_request) = mock.observer.inputs.recv().await.unwrap();
    assert_eq!(child_request["sessionId"], "session");
    assert_eq!(child_request["childSessionId"], "child");
    send(permission("parent-permission", "session"));
    let (_, parent_request) = mock.observer.inputs.recv().await.unwrap();
    assert!(parent_request.get("childSessionId").is_none());
    assert_eq!(mock.manager.pending_user_inputs().await.len(), 2);

    assert!(
        !mock
            .manager
            .cancel_child("codex-acp", "session", "unknown")
            .await
    );
    assert!(
        mock.manager
            .cancel_child("codex-acp", "session", "child")
            .await
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        let (mut cancelled, mut settled) = (false, false);
        while !(cancelled && settled) {
            let message = frame_json(mock.peer.rx.next().await.unwrap());
            match message["method"].as_str() {
                Some("session/cancel") => {
                    assert_eq!(message["params"]["sessionId"], "child");
                    cancelled = true;
                }
                None if message["id"] == "child-permission" => {
                    assert_eq!(message["result"]["outcome"]["outcome"], "cancelled");
                    settled = true;
                }
                _ => panic!("Unexpected ACP message: {message}"),
            }
        }
    })
    .await
    .unwrap();
    // Only the parent's request is still waiting, and it is answered as usual.
    let pending = serde_json::to_value(mock.manager.pending_user_inputs().await).unwrap();
    assert_eq!(
        pending[0]["params"]["requestId"],
        parent_request["requestId"]
    );
    assert_eq!(pending.as_array().unwrap().len(), 1);
    let request_id = parent_request["requestId"].as_str().unwrap();
    assert!(
        mock.manager
            .answer_user_input(
                "codex-acp",
                "session",
                request_id,
                json!({"optionId": "allow"})
            )
            .await
    );
    let answer = frame_json(mock.peer.rx.next().await.unwrap());
    assert_eq!(answer["id"], "parent-permission");

    mock.respond(&prompt_request, json!({"stopReason": "end_turn"}));
    // A subagent's text is not part of the parent's answer.
    assert_eq!(prompt.await.unwrap().unwrap(), "parent says");
}

#[tokio::test]
async fn an_unanswered_request_is_refused_and_does_not_count_as_idle() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let call = tokio::spawn(async move {
        let context = SessionContext {
            input_timeout: Some(Duration::from_secs(2)),
            ..Default::default()
        };
        manager
            .create_session("codex-acp", None, context, None)
            .await
    });
    let request = mock.next("session/new").await;
    mock.respond(&request, json!({"sessionId": "session"}));
    call.await.unwrap().unwrap();

    let prompt = mock.prompt_with("session", 1, None);
    let request = mock.next("session/prompt").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Test permission", "status": "pending"},
                "options": [
                    {"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"}
                ]
            }
        })))
        .unwrap();
    assert_eq!(
        mock.observer.inputs.recv().await.unwrap().0,
        "agent_permission_request"
    );
    // Waiting for the user is not the agent being silent: past the 1s idle
    // timeout, the turn is still running.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!prompt.is_finished());
    // At its 2s deadline the request is refused with its reject option.
    let answer = tokio::time::timeout(Duration::from_secs(2), mock.peer.rx.next())
        .await
        .unwrap()
        .map(frame_json)
        .unwrap();
    assert_eq!(answer["id"], "permission");
    assert_eq!(answer["result"]["outcome"]["optionId"], "reject");
    assert!(mock.manager.pending_user_inputs().await.is_empty());
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn auto_approve_answers_permission_requests_without_notifying_or_waiting() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let call = tokio::spawn(async move {
        let context = SessionContext {
            auto_approve: true,
            ..Default::default()
        };
        manager
            .create_session("codex-acp", None, context, None)
            .await
    });
    let request = mock.next("session/new").await;
    mock.respond(&request, json!({"sessionId": "session"}));
    call.await.unwrap().unwrap();

    let prompt = mock.prompt_with("session", 1, None);
    let prompt_request = mock.next("session/prompt").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Test permission", "status": "pending"},
                "options": [
                    {"optionId": "allow_id", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "reject_id", "name": "Reject", "kind": "reject_once"}
                ]
            }
        })))
        .unwrap();

    let answer = tokio::time::timeout(Duration::from_secs(1), mock.peer.rx.next())
        .await
        .unwrap()
        .map(frame_json)
        .unwrap();
    assert_eq!(answer["id"], "permission");
    assert_eq!(answer["result"]["outcome"]["optionId"], "allow_id");
    assert!(mock.observer.inputs.try_recv().is_err());
    assert!(mock.manager.pending_user_inputs().await.is_empty());

    mock.respond(&prompt_request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn shutdown_closes_active_sessions_and_stops_runtime() {
    let mut mock = MockAcp::new().await;
    mock.create("s1").await;
    mock.create("s2").await;
    let prompt = mock.prompt("s1");
    let _prompt_request = mock.next("session/prompt").await;

    let manager = mock.manager.clone();
    let shutdown = tokio::spawn(async move { manager.shutdown().await });

    // Both active sessions receive cancel + close; respond to close requests in
    // any order.
    let mut closed = std::collections::HashSet::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        while closed.len() < 2 {
            let msg = frame_json(mock.peer.rx.next().await.unwrap());
            if msg["method"] == "session/close" {
                closed.insert(msg["params"]["sessionId"].as_str().unwrap().to_string());
                mock.respond(&msg, json!({}));
            }
        }
    })
    .await
    .expect("expected session/close for all active sessions");
    assert_eq!(
        closed,
        std::collections::HashSet::from(["s1".to_string(), "s2".to_string()])
    );

    tokio::time::timeout(Duration::from_secs(2), shutdown)
        .await
        .expect("shutdown should finish after sessions close")
        .unwrap();
    assert!(prompt.await.unwrap().is_err());
    assert!(!mock.registered("s1").await);
    assert!(!mock.registered("s2").await);

    // Mock connection exits cleanly on shutdown without waiting for EOF.
    tokio::time::timeout(Duration::from_secs(2), &mut mock.connection)
        .await
        .expect("ACP connection task should exit on shutdown")
        .unwrap();

    // New sessions and runtime connections are rejected after shutdown.
    assert!(
        mock.manager
            .create_session("codex-acp", None, Default::default(), None)
            .await
            .is_err()
    );
    assert!(
        mock.manager
            .open_session("codex-acp", "s1", None, Default::default(), None, None, 0)
            .await
            .is_err()
    );
    assert!(mock.manager.prepare("codex-acp").await.is_err());
}

#[tokio::test]
async fn pending_mode_and_config_changes_do_not_block_turn_updates_or_permission_response() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (sub, mut sub_rx) = make_subscriber(1);
    let prompt = mock.prompt_with("session", 30, Some(sub));
    let prompt_request = mock.next("session/prompt").await;
    // Drain TurnStarted + user_message_chunk.
    for _ in 0..2 {
        sub_rx.recv().await.unwrap();
    }

    // Issue both set_mode and set_config_option mid-turn and leave them
    // unanswered.
    let manager_mode = mock.manager.clone();
    let mode =
        tokio::spawn(async move { manager_mode.set_mode("codex-acp", "session", "plan").await });
    let mode_request = mock.next("session/set_mode").await;

    let manager_cfg = mock.manager.clone();
    let config = tokio::spawn(async move {
        manager_cfg
            .set_config_option("codex-acp", "session", "model", "sonnet")
            .await
    });
    let config_request = mock.next("session/set_config_option").await;

    // Agent asks for permission while set_mode/set_config are still pending:
    // must not deadlock.
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "perm-1", "method": "session/request_permission",
            "params": {
                "sessionId": "session",
                "toolCall": {"toolCallId": "tool", "title": "Run command", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}]
            }
        })))
        .unwrap();
    let (_, permission) = tokio::time::timeout(Duration::from_secs(1), mock.observer.inputs.recv())
        .await
        .expect("permission request must not be blocked by pending mode/config")
        .unwrap();
    let request_id = permission["requestId"].as_str().unwrap().to_string();
    assert!(
        mock.manager
            .answer_user_input(
                "codex-acp",
                "session",
                &request_id,
                json!({"optionId": "allow"})
            )
            .await
    );
    let perm_reply = tokio::time::timeout(Duration::from_secs(1), mock.peer.rx.next())
        .await
        .expect("permission response must be delivered while mode/config is pending")
        .map(frame_json)
        .unwrap();
    assert_eq!(perm_reply["id"], "perm-1");
    assert_eq!(perm_reply["result"]["outcome"]["optionId"], "allow");

    // Streamed session updates and prompt completion must flow normally too.
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "hello"}
                }
            }
        })))
        .unwrap();
    let (_, event_params) = tokio::time::timeout(Duration::from_secs(1), sub_rx.recv())
        .await
        .expect("streamed update must not be blocked")
        .unwrap();
    assert_eq!(event_params["event"]["event"], "session_update");

    mock.respond(&prompt_request, json!({"stopReason": "end_turn"}));
    let answer = tokio::time::timeout(Duration::from_secs(1), prompt)
        .await
        .expect("turn must finish while mode/config is still pending")
        .unwrap()
        .unwrap();
    assert_eq!(answer, "hello");

    // Finally resolve the pending mode and config requests.
    mock.respond(&mode_request, json!({}));
    mock.respond(&config_request, json!({"configOptions": []}));
    assert!(mode.await.unwrap().is_ok());
    assert!(config.await.unwrap().is_ok());
}

#[tokio::test]
async fn stuck_mode_change_times_out_without_blocking_session() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;

    let manager = mock.manager.clone();
    let mode = tokio::spawn(async move { manager.set_mode("codex-acp", "session", "plan").await });
    let _mode_request = mock.next("session/set_mode").await;

    let err = tokio::time::timeout(
        session::CONTROL_REQUEST_TIMEOUT + Duration::from_secs(1),
        mode,
    )
    .await
    .expect("set_mode should time out")
    .unwrap()
    .unwrap_err();
    assert!(
        err.to_string()
            .contains("Timeout waiting for session/set_mode"),
        "unexpected error: {err}"
    );

    // The session stays usable after the timed-out control request.
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn session_exits_when_disconnect_already_recorded_before_subscribe() {
    let mut mock = MockAcp::new().await;
    let runtime = mock.manager.runtime("codex-acp");
    let generation = runtime.state.lock().await.generation;

    let manager = mock.manager.clone();
    let create = tokio::spawn(async move {
        manager
            .create_session("codex-acp", None, Default::default(), None)
            .await
    });
    let request = mock.next("session/new").await;

    // Stop the connection before `start_session` subscribes to `disconnects`.
    runtime
        .connection_stopped(generation, "disconnected".into())
        .await;
    mock.respond(&request, json!({"sessionId": "s-race"}));

    // Whether create_session succeeds right before exit or fails during
    // startup, the actor must notice the already-recorded disconnect and clean
    // up.
    let _ = tokio::time::timeout(Duration::from_secs(1), create)
        .await
        .expect("create_session should settle");
    tokio::time::timeout(Duration::from_secs(1), async {
        while mock.registered("s-race").await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session actor must exit instead of staying as a zombie");
}

#[tokio::test]
async fn cancelling_child_permission_resumes_parent_idle_timeout() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let prompt = mock.prompt_with("session", 1, None);
    let prompt_request = mock.next("session/prompt").await;

    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "subagent_update", "sessionId": "child", "title": "scout",
                    "capabilities": {"cancel": {}}, "state": {"state": "running"}
                }
            }
        })))
        .unwrap();
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0", "id": "child-perm", "method": "session/request_permission",
            "params": {
                "sessionId": "child",
                "toolCall": {"toolCallId": "tool", "title": "Check", "status": "pending"},
                "options": [{"optionId": "allow", "name": "Allow once", "kind": "allow_once"}]
            }
        })))
        .unwrap();
    let (method, _) = tokio::time::timeout(Duration::from_secs(1), mock.observer.inputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_permission_request");

    // Wait longer than the 1s parent idle timeout while the child input is
    // pending.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        mock.manager
            .cancel_child("codex-acp", "session", "child")
            .await
    );

    // Drain the child cancel + permission cancellation; the parent must NOT be
    // cancelled.
    tokio::time::timeout(Duration::from_secs(1), async {
        let (mut child_cancelled, mut perm_cancelled) = (false, false);
        while !(child_cancelled && perm_cancelled) {
            let msg = frame_json(mock.peer.rx.next().await.unwrap());
            match msg["method"].as_str() {
                Some("session/cancel") => {
                    assert_eq!(msg["params"]["sessionId"], "child");
                    child_cancelled = true;
                }
                None if msg["id"] == "child-perm" => {
                    assert_eq!(msg["result"]["outcome"]["outcome"], "cancelled");
                    perm_cancelled = true;
                }
                _ => panic!("Unexpected ACP message: {msg}"),
            }
        }
    })
    .await
    .unwrap();

    // Parent turn must stay alive after child cancellation (idle timer resumed
    // from now).
    assert!(
        tokio::time::timeout(Duration::from_millis(300), mock.peer.rx.next())
            .await
            .is_err(),
        "parent turn must not immediately time out after child input is dropped"
    );
    mock.respond(&prompt_request, json!({"stopReason": "end_turn"}));
    assert!(
        tokio::time::timeout(Duration::from_secs(1), prompt)
            .await
            .unwrap()
            .unwrap()
            .is_ok()
    );
}

#[tokio::test]
async fn delete_session_closes_live_actor_and_removes_it_from_active_sessions() {
    let mut mock = MockAcp::with_capabilities(json!({
        "loadSession": true,
        "sessionCapabilities": {"close": {}, "delete": {}}
    }))
    .await;
    mock.create("session").await;
    let prompt = mock.prompt("session");
    let prompt_request = mock.next("session/prompt").await;
    assert_eq!(mock.manager.active_sessions().await.len(), 1);

    let manager = mock.manager.clone();
    let deleting =
        tokio::spawn(async move { manager.delete_session("codex-acp", "session").await });

    // Deleting a running session first cancels + closes the live actor, then
    // deletes storage.
    let mut closed = false;
    let mut deleted = false;
    while !deleted {
        let msg = frame_json(mock.peer.rx.next().await.unwrap());
        match msg["method"].as_str() {
            Some("$/cancel_request") => {}
            Some("session/cancel") => {
                mock.respond(&prompt_request, json!({"stopReason": "cancelled"}));
            }
            Some("session/close") => {
                closed = true;
                mock.respond(&msg, json!({}));
            }
            Some("session/delete") => {
                assert!(closed, "live actor should close before session/delete");
                deleted = true;
                mock.respond(&msg, json!({}));
            }
            _ => panic!("Unexpected ACP message: {msg}"),
        }
    }

    deleting.await.unwrap().unwrap();
    let _ = prompt.await;
    assert!(!mock.registered("session").await);
    assert!(mock.manager.active_sessions().await.is_empty());
}

#[tokio::test]
async fn mode_and_config_changes_sync_to_other_subscribers_without_duplicating_agent_updates() {
    let mut mock = MockAcp::new().await;
    let (sub1, _rx1) = make_subscriber(1);
    let (sub2, mut rx2) = make_subscriber(2);

    let manager = mock.manager.clone();
    let creating = tokio::spawn(async move {
        manager
            .create_session("codex-acp", None, Default::default(), Some(sub1))
            .await
    });
    let new_req = mock.next("session/new").await;
    mock.respond(
        &new_req,
        json!({
            "sessionId": "session",
            "modes": {
                "currentModeId": "default",
                "availableModes": [
                    { "id": "default", "name": "Default" },
                    { "id": "plan", "name": "Plan" }
                ]
            },
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": "model-a",
                "options": [
                    { "value": "model-a", "name": "Model A" },
                    { "value": "model-b", "name": "Model B" }
                ]
            }]
        }),
    );
    creating.await.unwrap().unwrap();

    // Second device subscribes to the live session.
    mock.manager
        .open_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            Some(sub2),
            None,
            0,
        )
        .await
        .unwrap();

    // 1. Device 1 calls set_mode and ACP responds without emitting a
    //    session/update: daemon synthesizes current_mode_update for
    //    subscribers.
    let m1 = mock.manager.clone();
    let setting_mode =
        tokio::spawn(async move { m1.set_mode("codex-acp", "session", "plan").await });
    let mode_req = mock.next("session/set_mode").await;
    mock.respond(&mode_req, json!({}));
    setting_mode.await.unwrap().unwrap();

    let (method, params) = tokio::time::timeout(Duration::from_secs(1), rx2.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_session_event");
    assert_eq!(
        params["event"]["update"]["sessionUpdate"],
        "current_mode_update"
    );
    assert_eq!(params["event"]["update"]["currentModeId"], "plan");

    // 2. Device 1 calls set_config_option and ACP responds without emitting a
    //    session/update: daemon synthesizes config_option_update for
    //    subscribers.
    let updated_options = json!([{
        "id": "model",
        "name": "Model",
        "type": "select",
        "currentValue": "model-b",
        "options": [
            { "value": "model-a", "name": "Model A" },
            { "value": "model-b", "name": "Model B" }
        ]
    }]);
    let m2 = mock.manager.clone();
    let setting_cfg = tokio::spawn(async move {
        m2.set_config_option("codex-acp", "session", "model", "model-b")
            .await
    });
    let cfg_req = mock.next("session/set_config_option").await;
    mock.respond(&cfg_req, json!({ "configOptions": updated_options }));
    setting_cfg.await.unwrap().unwrap();

    let (method, params) = tokio::time::timeout(Duration::from_secs(1), rx2.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_session_event");
    assert_eq!(
        params["event"]["update"]["sessionUpdate"],
        "config_option_update"
    );
    assert_eq!(
        params["event"]["update"]["configOptions"][0]["currentValue"],
        "model-b"
    );

    // 3. When ACP DOES emit current_mode_update itself before replying, daemon
    //    must NOT duplicate it.
    let m3 = mock.manager.clone();
    let setting_mode_again =
        tokio::spawn(async move { m3.set_mode("codex-acp", "session", "default").await });
    let mode_req_2 = mock.next("session/set_mode").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "current_mode_update",
                    "currentModeId": "default"
                }
            }
        })))
        .unwrap();
    let (_, params) = tokio::time::timeout(Duration::from_secs(1), rx2.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(params["event"]["update"]["currentModeId"], "default");
    mock.respond(&mode_req_2, json!({}));
    setting_mode_again.await.unwrap().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(80), rx2.recv())
            .await
            .is_err(),
        "must not emit duplicate current_mode_update when ACP already pushed one"
    );
}

#[tokio::test]
async fn daemon_tracks_title_updated_at_and_soft_delete_when_acp_omits_them() {
    let mut mock = MockAcp::with_capabilities(json!({
        "loadSession": true,
        "sessionCapabilities": { "list": {} }
    }))
    .await;

    // 1. Creating a session whose ACP response has no metadata gets an initial
    //    updated_at from the daemon and no placeholder title.
    let creating = {
        let manager = mock.manager.clone();
        tokio::spawn(async move {
            manager
                .create_session("codex-acp", None, Default::default(), None)
                .await
        })
    };
    let new_req = mock.next("session/new").await;
    mock.respond(
        &new_req,
        json!({
            "sessionId": "s1",
            "_meta": { "title": "Session a1bcdef0" }
        }),
    );
    let created = creating.await.unwrap().unwrap();
    assert_eq!(created.title, None);
    let created_at = created.updated_at.expect("initial updated_at on create");

    // 2. Starting and finishing a turn derives the title from the first prompt,
    //    advances updated_at, and broadcasts both in agent_session_state.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let prompt_handle = mock
        .manager
        .start_prompt(
            "codex-acp",
            "s1",
            PromptOptions {
                prompt: "支持 DeepSeek harness 吗".into(),
                attachments: vec![],
                voice_chat: false,
                client_message_id: None,
                originator_peer_id: None,
                subscriber: None,
                timeout_secs: 30,
            },
        )
        .await
        .unwrap();
    let prompt_req = mock.next("session/prompt").await;
    let started_state = mock.observer.states.recv().await.unwrap();
    assert!(started_state.running);
    assert_eq!(
        started_state.title.as_deref(),
        Some("支持 DeepSeek harness 吗")
    );
    let started_at = started_state.updated_at.expect("updated_at on turn start");
    assert!(started_at > created_at);

    tokio::time::sleep(Duration::from_millis(5)).await;
    mock.respond(&prompt_req, json!({ "stopReason": "end_turn" }));
    let _ = prompt_handle.completion.await;
    let ended_state = mock.observer.states.recv().await.unwrap();
    assert!(!ended_state.running);
    let ended_at = ended_state.updated_at.expect("updated_at on turn end");
    assert!(ended_at >= started_at);

    // 3. Loading a pre-existing session without stored metadata derives its
    //    title from the first replayed user_message_chunk without inventing a
    //    new updated_at.
    let opening = {
        let manager = mock.manager.clone();
        tokio::spawn(async move {
            manager
                .open_session("codex-acp", "s2", None, Default::default(), None, None, 0)
                .await
        })
    };
    let load_req = mock.next("session/load").await;
    mock.peer
        .tx
        .unbounded_send(frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s2",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "旧会话的首条消息" }
                }
            }
        })))
        .unwrap();
    mock.respond(&load_req, json!({}));
    let opened = opening.await.unwrap().unwrap();
    assert_eq!(opened.title.as_deref(), Some("旧会话的首条消息"));
    assert_eq!(opened.updated_at, None);

    // 4. Soft-deleting s2 hides it from list_sessions even when ACP still
    //    returns it, while s1 gets its daemon-tracked title and updatedAt.
    mock.manager
        .delete_session("codex-acp", "s2")
        .await
        .unwrap();
    mock.next("session/cancel").await;
    assert_eq!(
        mock.observer.deleted.try_recv().unwrap(),
        ("codex-acp".to_string(), "s2".to_string())
    );

    let listing = {
        let manager = mock.manager.clone();
        tokio::spawn(async move { manager.list_sessions("codex-acp", None, None).await })
    };
    let list_req = mock.next("session/list").await;
    mock.respond(
        &list_req,
        json!({
            "sessions": [
                { "sessionId": "s1", "cwd": "/repo", "title": "Session a1bcdef0" },
                { "sessionId": "s2", "cwd": "/repo", "title": "Session b2cdef01" }
            ]
        }),
    );
    let list = listing.await.unwrap().unwrap();
    let sessions = list["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["sessionId"], "s1");
    assert_eq!(sessions[0]["title"], "支持 DeepSeek harness 吗");
    assert_eq!(sessions[0]["updatedAt"], ended_at);
    assert_eq!(sessions[0]["unread"], true);

    // 5. Explicit mark-read persists and broadcasts to other devices.
    mock.manager.set_session_unread("codex-acp", "s1", false);
    assert_eq!(
        mock.observer.unread.try_recv().unwrap(),
        ("codex-acp".to_string(), "s1".to_string(), false)
    );
    let listing2 = {
        let manager = mock.manager.clone();
        tokio::spawn(async move { manager.list_sessions("codex-acp", None, None).await })
    };
    let list_req2 = mock.next("session/list").await;
    mock.respond(
        &list_req2,
        json!({ "sessions": [{ "sessionId": "s1", "cwd": "/repo" }] }),
    );
    let list2 = listing2.await.unwrap().unwrap();
    assert!(list2["sessions"][0].get("unread").is_none());
}
