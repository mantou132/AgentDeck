use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

pub const PUSH_URL: &str = "https://agentdeck.xianqiao.wang/push";

/// The body is localized by the app (`notification_response_complete` in the
/// Android strings and the iOS `Localizable.strings`).
const BODY_LOC_KEY: &str = "notification_response_complete";

/// Identifies the host in the push data without revealing the pairing ID: the app
/// computes the same from its own pairing ID and ignores taps on another host's
/// notifications (`pushHostKey` in `packages/agentdeck/src/agent/encryption.ts`).
pub fn host_key(relay_id: &str) -> String {
    Sha256::digest(relay_id.as_bytes())[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub async fn send(
    client: &reqwest::Client,
    token: &str,
    host: &str,
    agent: &str,
    session_id: &str,
) {
    // A newer notification of the same session replaces the older one.
    let tag = format!("{agent}:{session_id}");
    let payload = json!({
        "notifications": [{
            "tokens": [token],
            "platform": 2,
            "title": "Agent Deck",
            "priority": "high",
            "android": {
                "notification": {
                    "channel_id": "agent_responses",
                    "body_loc_key": BODY_LOC_KEY,
                    "tag": tag
                }
            },
            "apns": {
                "headers": { "apns-collapse-id": tag },
                "payload": {
                    "aps": {
                        "alert": { "title": "Agent Deck", "loc-key": BODY_LOC_KEY },
                        "sound": "default"
                    }
                }
            },
            "data": { "type": "response_complete", "host": host, "agent": agent, "sessionId": session_id }
        }]
    });
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
}
