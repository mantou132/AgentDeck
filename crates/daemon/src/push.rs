use std::time::Duration;

use serde_json::json;

pub const PUSH_URL: &str = "https://agent-deck.xianqiao.wang/push";

/// The body is localized by the app (`notification_response_complete` in the
/// Android strings and the iOS `Localizable.strings`).
const BODY_LOC_KEY: &str = "notification_response_complete";

pub async fn send(client: &reqwest::Client, token: &str, agent: &str, session_id: &str) {
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
            "data": { "type": "response_complete", "agent": agent, "sessionId": session_id }
        }]
    });
    let _ = client
        .post(PUSH_URL)
        .timeout(Duration::from_secs(10))
        .json(&payload)
        .send()
        .await;
}
