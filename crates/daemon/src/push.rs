use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

pub const PUSH_URL: &str = "https://agentdeck.xianqiao.wang/push";

/// What a push tells the user. The body is localized by the app (the loc key in
/// the Android strings and the iOS `Localizable.strings`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushKind {
    /// A prompt finished.
    ResponseComplete,
    /// A turn waits on a permission request or a question.
    InputRequest,
}

impl PushKind {
    fn data_type(self) -> &'static str {
        match self {
            Self::ResponseComplete => "response_complete",
            Self::InputRequest => "input_request",
        }
    }

    fn body_loc_key(self) -> &'static str {
        match self {
            Self::ResponseComplete => "notification_response_complete",
            Self::InputRequest => "notification_input_request",
        }
    }
}

/// Identifies the host in the push data without revealing the pairing ID: the
/// app computes the same from its own pairing ID and ignores taps on another
/// host's notifications (`pushHostKey` in
/// `packages/agentdeck/src/agent/encryption.ts`).
pub fn host_key(relay_id: &str) -> String {
    Sha256::digest(relay_id.as_bytes())[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn build_payload(
    token: &str,
    host: &str,
    kind: PushKind,
    agent: &str,
    session_id: &str,
    task_id: Option<&str>,
) -> serde_json::Value {
    // A newer notification of the same session replaces the older one.
    let tag = format!("{agent}:{session_id}");
    let loc_key = kind.body_loc_key();
    let mut data = json!({
        "type": kind.data_type(),
        "host": host,
        "agent": agent,
        "sessionId": session_id,
    });
    // FCM/APNs data values are stringified by the push gateway; a null taskId
    // becomes a truthy string and routes normal session taps to the task page.
    if let Some(task_id) = task_id {
        data["taskId"] = json!(task_id);
    }
    json!({
        "notifications": [{
            "tokens": [token],
            "platform": 2,
            "title": "Agent Deck",
            "priority": "high",
            "android": {
                "notification": {
                    "channel_id": "agent_responses",
                    "body_loc_key": loc_key,
                    "tag": tag
                }
            },
            "apns": {
                "headers": { "apns-collapse-id": tag },
                "payload": {
                    "aps": {
                        "alert": { "title": "Agent Deck", "loc-key": loc_key },
                        "sound": "default"
                    }
                }
            },
            "data": data
        }]
    })
}

pub async fn send(
    client: &reqwest::Client,
    token: &str,
    host: &str,
    kind: PushKind,
    agent: &str,
    session_id: &str,
    task_id: Option<&str>,
) {
    let payload = build_payload(token, host, kind, agent, session_id, task_id);
    let _ = client
        .post(PUSH_URL)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_matches_app() {
        // Same vector as `packages/agentdeck/test/encryption.test.mjs`.
        assert_eq!(
            host_key("123e4567-e89b-12d3-a456-426614174000"),
            "986c0dc956dc822b"
        );
    }

    #[test]
    fn payload_omits_task_id_for_normal_sessions() {
        let payload = build_payload(
            "tok",
            "host",
            PushKind::InputRequest,
            "antigravity",
            "sess-1",
            None,
        );
        let data = &payload["notifications"][0]["data"];
        assert_eq!(
            data,
            &json!({
                "type": "input_request",
                "host": "host",
                "agent": "antigravity",
                "sessionId": "sess-1",
            })
        );
        assert!(data.get("taskId").is_none());
    }

    #[test]
    fn payload_includes_task_id_for_task_runs() {
        let payload = build_payload(
            "tok",
            "host",
            PushKind::InputRequest,
            "antigravity",
            "sess-1",
            Some("task-1"),
        );
        assert_eq!(payload["notifications"][0]["data"]["taskId"], "task-1");
    }
}
