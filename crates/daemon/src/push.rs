use std::time::Duration;

use serde_json::json;

pub const PUSH_URL: &str = "https://agent-deck.xianqiao.wang/push";

pub async fn send(client: &reqwest::Client, token: &str, agent: &str, session_id: &str) {
    let payload = json!({
        "notifications": [{
            "tokens": [token],
            "platform": 2,
            "title": "Agent Deck",
            "priority": "high",
            "android": {
                "notification": {
                    "channel_id": "agent_responses",
                    "body_loc_key": "notification_response_complete",
                    "tag": format!("{agent}:{session_id}")
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
