use super::*;
use agent_client_protocol::{Channel, TransportFrame};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::task::JoinHandle;

fn frame(message: Value) -> TransportFrame {
    TransportFrame::parse_json(&message.to_string())
}

fn frame_json(frame: TransportFrame) -> Value {
    serde_json::from_str(&frame.to_json().unwrap()).unwrap()
}

/// An event channel whose receiver is dropped: the events are not under test.
fn replay_sink() -> mpsc::UnboundedSender<AgentEvent> {
    mpsc::unbounded_channel().0
}

fn full_capabilities() -> Value {
    json!({"loadSession": true, "sessionCapabilities": {"close": {}}})
}

// The real manager, actors and ACP SDK run against an in-memory ACP transport.
// No user agent, browser or Relay process is started or stopped.
struct MockAcp {
    manager: AgentSessionManager,
    peer: Channel,
    connection: JoinHandle<()>,
}

impl MockAcp {
    async fn new() -> Self {
        Self::with_capabilities(full_capabilities()).await
    }

    async fn with_capabilities(capabilities: Value) -> Self {
        let manager = AgentSessionManager::new(None);
        let (peer, connection) = Self::connect(&manager, capabilities).await;
        Self {
            manager,
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
                // Dropping an in-flight SDK request emits this transport-level cancellation.
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

    async fn create(&mut self, id: &str) {
        let manager = self.manager.clone();
        let call = tokio::spawn(async move {
            manager
                .create_session("codex-acp", None, Default::default())
                .await
        });
        let request = self.next("session/new").await;
        self.respond(&request, json!({"sessionId": id}));
        assert_eq!(call.await.unwrap().unwrap().session_id, id);
    }

    async fn load(&mut self, id: &str) {
        let manager = self.manager.clone();
        let id = id.to_string();
        let call = tokio::spawn(async move {
            manager
                .load_session("codex-acp", &id, None, Default::default(), replay_sink())
                .await
        });
        let request = self.next("session/load").await;
        self.respond(&request, json!({}));
        call.await.unwrap().unwrap();
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
        let manager = self.manager.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            manager
                .prompt(
                    "codex-acp",
                    &id,
                    "test".into(),
                    vec![],
                    30,
                    replay_sink(),
                    None,
                )
                .await
        })
    }
}

impl Drop for MockAcp {
    fn drop(&mut self) {
        self.connection.abort();
    }
}

#[tokio::test]
async fn close_waits_for_acp_release_before_load_and_prompt() {
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
    mock.load("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn running_prompts_lists_only_sessions_with_an_unfinished_prompt() {
    let mut mock = MockAcp::new().await;
    mock.create("busy").await;
    mock.create("idle").await;
    assert!(mock.manager.running_prompts().await.is_empty());

    let prompt = mock.prompt("busy");
    let request = mock.next("session/prompt").await;
    assert_eq!(
        mock.manager.running_prompts().await,
        vec![("codex-acp".to_string(), "busy".to_string())]
    );

    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    assert!(mock.manager.running_prompts().await.is_empty());
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
    mock.load("session").await;
    mock.respond(&old_prompt, json!({"stopReason": "cancelled"}));
    mock.respond(&old_close, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}

#[tokio::test]
async fn concurrent_close_and_load_wait_for_one_cleanup() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let first = mock.close("session");
    mock.next("session/cancel").await;
    let close = mock.next("session/close").await;
    let second = mock.close("session");
    let manager = mock.manager.clone();
    let load = tokio::spawn(async move {
        manager
            .load_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                replay_sink(),
            )
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "load must not reach ACP before close finishes"
    );
    assert!(!first.is_finished() && !second.is_finished());
    mock.respond(&close, json!({}));
    assert!(first.await.unwrap());
    assert!(second.await.unwrap());
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    load.await.unwrap().unwrap();
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
    mock.load("session").await;
    mock.respond(&old_mode, json!({}));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn loading_an_active_session_is_rejected_before_contacting_acp() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let result = mock
        .manager
        .load_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            replay_sink(),
        )
        .await;
    assert!(result.err().unwrap().to_string().contains("already active"));
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn abandoned_load_replay_does_not_leave_an_unregistered_actor() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let (replay_tx, mut replay_rx) = mpsc::unbounded_channel();
    let load = tokio::spawn(async move {
        manager
            .load_session("codex-acp", "session", None, Default::default(), replay_tx)
            .await
    });
    let request = mock.next("session/load").await;
    mock.respond(&request, json!({}));
    // Supply a replay event to establish that the actor is draining history.
    mock.peer.tx.unbounded_send(frame(json!({
        "jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "session", "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "history"}
            }
        }
    }))).unwrap();
    tokio::time::timeout(Duration::from_secs(1), replay_rx.recv())
        .await
        .unwrap()
        .unwrap();
    load.abort();
    assert!(load.await.err().unwrap().is_cancelled());
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
    mock.load("session").await;
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}

#[tokio::test]
async fn acp_disconnect_cleans_old_actor_before_reconnecting_and_loading() {
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
    assert!(!mock.manager.close_session("codex-acp", "session").await);
    let (peer, connection) = MockAcp::connect(&mock.manager, full_capabilities()).await;
    mock.peer = peer;
    mock.connection = connection;
    mock.load("session").await;
    let prompt = mock.prompt("session");
    let request = mock.next("session/prompt").await;
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(prompt.await.unwrap().is_ok());
}

#[tokio::test]
async fn close_cancels_a_real_acp_permission_request_without_waiting_for_the_user() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (permission_tx, mut permission_rx) = mpsc::unbounded_channel();
    let notifier: Notifier = Arc::new(move |_, params| permission_tx.send(params).unwrap());
    let manager = mock.manager.clone();
    let prompt = tokio::spawn(async move {
        manager
            .prompt(
                "codex-acp",
                "session",
                "test".into(),
                vec![],
                30,
                replay_sink(),
                Some(notifier),
            )
            .await
    });
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
    let permission = tokio::time::timeout(Duration::from_secs(1), permission_rx.recv())
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
    mock.load("session").await;
}

#[tokio::test]
async fn user_input_is_answered_after_delivery_and_close_cancels_it() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (request_tx, mut request_rx) = mpsc::unbounded_channel();
    let notifier: Notifier =
        Arc::new(move |method, params| request_tx.send((method.to_string(), params)).unwrap());
    let manager = mock.manager.clone();
    let prompt = tokio::spawn(async move {
        manager
            .prompt(
                "codex-acp",
                "session",
                "test".into(),
                vec![],
                30,
                replay_sink(),
                Some(notifier),
            )
            .await
    });
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
    let (method, request) = request_rx.recv().await.unwrap();
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
    let request_id = request["requestId"].as_str().unwrap();
    let response = json!({"action": "accept", "content": {"question_0": "A"}});
    assert!(
        !mock
            .manager
            .answer_user_input("codex-acp", "session", "stale", response.clone())
            .await
    );
    assert!(
        mock.manager
            .answer_user_input("codex-acp", "session", request_id, response.clone())
            .await
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
    let (method, request) = request_rx.recv().await.unwrap();
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
    request_rx.recv().await.unwrap();
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
    let load = manager
        .load_session("codex-acp", "old", None, Default::default(), replay_sink())
        .await;
    assert!(
        load.err()
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
    let delete = manager.delete_session("codex-acp", "old").await;
    assert!(
        delete
            .unwrap_err()
            .to_string()
            .contains("does not support deleting")
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
async fn prompt_suggestion_after_turn_reaches_the_prompting_device() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let (suggestion_tx, mut suggestion_rx) = mpsc::unbounded_channel();
    let notifier: Notifier = Arc::new(move |method, params| {
        let _ = suggestion_tx.send((method.to_string(), params));
    });
    let manager = mock.manager.clone();
    let prompt = tokio::spawn(async move {
        manager
            .prompt(
                "codex-acp",
                "session",
                "test".into(),
                vec![],
                30,
                replay_sink(),
                Some(notifier),
            )
            .await
    });
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
    let (method, params) = tokio::time::timeout(Duration::from_secs(1), suggestion_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_prompt_suggestion");
    assert_eq!(
        params,
        json!({"agent": "codex-acp", "sessionId": "session", "suggestion": "Run the tests"})
    );
}

#[tokio::test]
async fn updates_between_turns_reach_the_creating_device() {
    let mut mock = MockAcp::new().await;
    let (update_tx, mut update_rx) = mpsc::unbounded_channel();
    let notifier: Notifier = Arc::new(move |method, params| {
        let _ = update_tx.send((method.to_string(), params));
    });
    let manager = mock.manager.clone();
    let call = tokio::spawn(async move {
        let context = SessionContext {
            notifier: Some(notifier),
            ..Default::default()
        };
        manager.create_session("codex-acp", None, context).await
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
    let (method, params) = tokio::time::timeout(Duration::from_secs(1), update_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(method, "agent_session_update");
    assert_eq!(params["agent"], "codex-acp");
    assert_eq!(params["sessionId"], "session");
    assert_eq!(
        params["update"]["sessionUpdate"],
        "available_commands_update"
    );
    assert_eq!(params["update"]["availableCommands"][0]["name"], "review");
}

#[tokio::test]
async fn a_silent_turn_times_out_and_is_cancelled_while_updates_keep_it_alive() {
    let mut mock = MockAcp::new().await;
    mock.create("session").await;
    let manager = mock.manager.clone();
    let prompt = tokio::spawn(async move {
        manager
            .prompt(
                "codex-acp",
                "session",
                "test".into(),
                vec![],
                1,
                replay_sink(),
                None,
            )
            .await
    });
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
    assert_eq!(
        mock.manager.running_prompts().await,
        vec![("codex-acp".to_string(), "session".to_string())]
    );
    mock.respond(&request, json!({"stopReason": "end_turn"}));
    assert!(first.await.unwrap().is_ok());
    assert!(mock.manager.running_prompts().await.is_empty());
}

#[tokio::test]
async fn a_session_being_loaded_cannot_be_loaded_again() {
    let mut mock = MockAcp::new().await;
    let manager = mock.manager.clone();
    let first = tokio::spawn(async move {
        manager
            .load_session(
                "codex-acp",
                "session",
                None,
                Default::default(),
                replay_sink(),
            )
            .await
    });
    let request = mock.next("session/load").await;
    let second = mock
        .manager
        .load_session(
            "codex-acp",
            "session",
            None,
            Default::default(),
            replay_sink(),
        )
        .await;
    assert!(second.err().unwrap().to_string().contains("already active"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), mock.peer.rx.next())
            .await
            .is_err(),
        "the rejected load must not reach ACP"
    );
    mock.respond(&request, json!({}));
    first.await.unwrap().unwrap();
    assert!(mock.manager.session("codex-acp", "session").await.is_ok());
}
