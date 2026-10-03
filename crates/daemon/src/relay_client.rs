//! Relay transport for the remote RPC peers, built on the shared
//! `relay-client` crate. This module manages multiple remote peers (e.g. Phone A,
//! Phone B) communicating over endpoint 1 and demultiplexes by an auto-incrementing `peerId`.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::Result;
use relay_client::{Client, ClientHandler, memory::MemoryStore, relay_frame::Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    agent_rpc::{AgentService, PeerCapabilities},
    app_data::{self, AppPaths},
    peer::Peer,
    push,
    relay_codec::{Frame, RelayCodec},
};

const HOST_DEVICE_ID: &str = "host";

fn endpoint_url(relay_url: &str, relay_id: &str) -> String {
    relay_client::transport::endpoint_url(relay_url, relay_id, Endpoint::One, HOST_DEVICE_ID)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDevice {
    pub(crate) peer_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fcm_token: Option<String>,
}

fn load_persisted_peers() -> HashMap<String, RemoteDevice> {
    let Ok(path) = AppPaths::discover().map(|paths| paths.peers_file()) else {
        return HashMap::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_persisted_peers(map: &HashMap<String, RemoteDevice>) {
    let Ok(paths) = AppPaths::discover() else {
        return;
    };
    if app_data::ensure_dir(paths.root()).is_err() {
        return;
    }
    let path = paths.peers_file();
    if let Ok(content) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(&path, content);
    }
}

/// One message for the relay client.
#[derive(Debug)]
pub(crate) struct Outbound {
    message: Value,
    /// Raw bytes attached to a reply, carried as a binary frame.
    bytes: Option<Vec<u8>>,
    target_device_id: Option<String>,
    /// Replies to an ephemeral request skip Relay storage, like the request did.
    ephemeral: bool,
}

type OutboundSender = tokio::sync::mpsc::UnboundedSender<Outbound>;

/// Ephemeral requests by `(peerId, JSON-encoded id)`, until their final reply.
type EphemeralCalls = Arc<Mutex<HashSet<(u64, String)>>>;

/// Events and the final reply to an ephemeral request are ephemeral too; the
/// final reply forgets the request.
fn take_ephemeral_reply(calls: &EphemeralCalls, peer_id: u64, message: &Value) -> bool {
    if message.get("method").is_some() {
        return false;
    }
    let Some(id) = message.get("id") else {
        return false;
    };
    let key = (peer_id, id.to_string());
    let mut calls = calls.lock().expect("lock poisoned");
    if message.get("event").is_some() {
        calls.contains(&key)
    } else {
        calls.remove(&key)
    }
}

/// Manages multiple remote peers multiplexed over a single relay connection.
/// Allocates auto-increment `peerId` to connected devices and tags/filters messages.
pub struct RemotePeerManager {
    service: AgentService,
    outbound_tx: OutboundSender,
    devices: Arc<Mutex<HashMap<String, RemoteDevice>>>,
    peers: Arc<Mutex<HashMap<u64, (Peer, PeerCapabilities)>>>,
    ephemeral_calls: EphemeralCalls,
    next_peer_id: Arc<AtomicU64>,
    push_client: reqwest::Client,
}

impl RemotePeerManager {
    pub fn new(service: AgentService, outbound_tx: OutboundSender) -> Self {
        Self::with_devices(service, outbound_tx, load_persisted_peers())
    }

    pub fn with_devices(
        service: AgentService,
        outbound_tx: OutboundSender,
        initial_dev_map: HashMap<String, RemoteDevice>,
    ) -> Self {
        let max_id = initial_dev_map
            .values()
            .map(|device| device.peer_id)
            .max()
            .unwrap_or(0);
        Self {
            service,
            outbound_tx,
            devices: Arc::new(Mutex::new(initial_dev_map)),
            peers: Arc::default(),
            ephemeral_calls: Arc::default(),
            next_peer_id: Arc::new(AtomicU64::new(max_id + 1)),
            push_client: reqwest::Client::new(),
        }
    }

    pub fn get_or_create_peer(&self, peer_id: u64) -> Peer {
        self.peer_entry(peer_id).0
    }

    fn peer_entry(&self, peer_id: u64) -> (Peer, PeerCapabilities) {
        let mut peers = self.peers.lock().expect("lock poisoned");
        if let Some(entry) = peers.get(&peer_id) {
            return entry.clone();
        }

        let outbound_tx = self.outbound_tx.clone();
        let devices = self.devices.clone();
        let ephemeral_calls = self.ephemeral_calls.clone();
        let peer = Peer::new(move |mut message, bytes| {
            let ephemeral = take_ephemeral_reply(&ephemeral_calls, peer_id, &message);
            if let Value::Object(ref mut map) = message {
                map.insert("peerId".to_string(), json!(peer_id));
            }
            let target_device_id = devices.lock().ok().and_then(|devs| {
                devs.iter()
                    .find(|(_, d)| d.peer_id == peer_id)
                    .map(|(k, _)| k.clone())
            });
            let outbound = Outbound {
                message,
                bytes,
                target_device_id,
                ephemeral,
            };
            if outbound_tx.send(outbound).is_err() {
                tracing::info!("Relay client stopped; peer {peer_id} message dropped");
            }
        });
        let capabilities = PeerCapabilities::default();
        self.service.attach_with_completion(
            &peer,
            Some(self.completion_handler(peer_id)),
            capabilities.clone(),
        );
        peers.insert(peer_id, (peer.clone(), capabilities.clone()));
        (peer, capabilities)
    }

    fn completion_handler(&self, peer_id: u64) -> crate::agent_rpc::PromptCompletion {
        let devices = self.devices.clone();
        let client = self.push_client.clone();
        Arc::new(move |agent, session_id| {
            let token = devices.lock().ok().and_then(|devs| {
                devs.values()
                    .find(|d| d.peer_id == peer_id)
                    .and_then(|d| d.fcm_token.clone())
            });
            let Some(token) = token else { return };
            let client = client.clone();
            let agent = agent.to_owned();
            let session_id = session_id.to_owned();
            tokio::spawn(async move {
                push::send(&client, &token, &agent, &session_id).await;
            });
        })
    }

    fn resolve_peer_id(
        &self,
        device_id: &str,
        requested_peer_id: Option<u64>,
        token: Option<&Value>,
    ) -> u64 {
        let mut dev_map = self.devices.lock().expect("lock poisoned");
        if !device_id.is_empty() {
            if let Some(existing) = dev_map.get_mut(device_id) {
                let peer_id = existing.peer_id;
                let new_token = match token {
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    Some(Value::Null) => None,
                    _ => existing.fcm_token.clone(),
                };
                if existing.fcm_token != new_token {
                    existing.fcm_token = new_token;
                    save_persisted_peers(&dev_map);
                }
                return peer_id;
            }
        }
        let assigned = match requested_peer_id {
            Some(id) if id > 0 && !dev_map.values().any(|v| v.peer_id == id) => {
                let next = self.next_peer_id.load(Ordering::SeqCst);
                if id >= next {
                    self.next_peer_id.store(id + 1, Ordering::SeqCst);
                }
                id
            }
            _ => self.next_peer_id.fetch_add(1, Ordering::SeqCst),
        };
        if !device_id.is_empty() {
            let fcm_token = match token {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
            dev_map.insert(
                device_id.to_string(),
                RemoteDevice {
                    peer_id: assigned,
                    fcm_token,
                },
            );
            save_persisted_peers(&dev_map);
        }
        assigned
    }

    pub async fn dispatch(&self, mut payload: Value) {
        if payload.get("method").and_then(Value::as_str) == Some("peer_attach") {
            self.handle_attach(payload);
            return;
        }

        let peer_id = payload.get("peerId").and_then(Value::as_u64).unwrap_or(1);
        let peer = self.get_or_create_peer(peer_id);
        if let Value::Object(ref mut map) = payload {
            map.remove("peerId");
            if map.remove("ephemeral") == Some(Value::Bool(true))
                && let Some(id) = map.get("id")
            {
                self.ephemeral_calls
                    .lock()
                    .expect("lock poisoned")
                    .insert((peer_id, id.to_string()));
            }
        }
        peer.dispatch(payload).await;
    }

    fn handle_attach(&self, payload: Value) {
        let id = payload.get("id").cloned();
        let params = payload.get("params").cloned().unwrap_or(Value::Null);
        let device_id = params
            .get("deviceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let requested_peer_id = params.get("peerId").and_then(Value::as_u64);

        let peer_id = self.resolve_peer_id(&device_id, requested_peer_id, params.get("fcmToken"));
        let (_peer, capabilities) = self.peer_entry(peer_id);
        // Every attach re-declares the client's capabilities; later sessions use them.
        *capabilities.lock().expect("lock poisoned") = params
            .get("capabilities")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();

        // Clients compare it against their minimum supported host version.
        let version = env!("CARGO_PKG_VERSION");
        let response = match id {
            Some(req_id) => json!({
                "peerId": peer_id,
                "id": req_id,
                "result": { "peerId": peer_id, "deviceId": device_id, "version": version }
            }),
            None => json!({
                "peerId": peer_id,
                "method": "peer_attached",
                "params": { "peerId": peer_id, "deviceId": device_id, "version": version }
            }),
        };
        let target = if device_id.is_empty() {
            None
        } else {
            Some(device_id)
        };
        let _ = self.outbound_tx.send(Outbound {
            message: response,
            bytes: None,
            target_device_id: target,
            ephemeral: false,
        });
    }
}

struct Handler {
    manager: Arc<RemotePeerManager>,
    codec: Arc<RelayCodec>,
}

impl ClientHandler for Handler {
    fn on_payload(&self, payload: Value) {
        let (sender, message) = match self.codec.decode(payload) {
            Ok(decoded) => decoded,
            Err(error) => {
                tracing::warn!("Rejected encrypted relay message: {error:#}");
                return;
            }
        };
        // Bind the RPC peer to the authenticated sender, never the outer Relay route.
        if let Some(sender) = sender {
            let attached = if message.get("method").and_then(Value::as_str) == Some("peer_attach") {
                message.pointer("/params/deviceId").and_then(Value::as_str) == Some(sender.as_str())
            } else {
                let peers = self.manager.devices.lock().expect("lock poisoned");
                peers.get(&sender).is_some_and(|id| {
                    message.get("peerId").and_then(Value::as_u64) == Some(id.peer_id)
                })
            };
            if !attached {
                tracing::warn!("Rejected encrypted RPC with mismatched device identity");
                return;
            }
        }
        let manager = self.manager.clone();
        tokio::spawn(async move {
            manager.dispatch(message).await;
        });
    }

    fn on_connected(&self) {
        tracing::info!("Connected to relay WebSocket");
        let _ = self.manager.outbound_tx.send(Outbound {
            message: json!({
                "method": "host_reconnected",
                "params": {}
            }),
            bytes: None,
            target_device_id: None,
            ephemeral: false,
        });
    }

    fn on_disconnected(&self, _error: Option<String>) {
        // Relay client reconnects indefinitely in the background; do not log
        // disconnects or connection errors to avoid flooding logs or disk.
    }

    fn on_preempted(&self) {
        tracing::info!("Relay connection preempted: another host connection opened");
    }
}

/// Start the remote RPC transport with the configured relay URL and pairing ID.
pub fn start(
    relay_url: &str,
    relay_id: &str,
    service: &AgentService,
) -> Result<Arc<RemotePeerManager>> {
    let codec = Arc::new(RelayCodec::new(relay_id)?);
    let store = Arc::new(MemoryStore::new());

    // `Peer`'s writer is a sync callback on arbitrary threads; bridge it to
    // the async client through an unbounded channel drained by a dedicated task.
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();

    let manager = Arc::new(RemotePeerManager::new(service.clone(), outbound_tx));

    let client = Client::new_with_ack_head(
        endpoint_url(relay_url, &codec.route_id),
        true,
        store,
        Arc::new(Handler {
            manager: manager.clone(),
            codec: codec.clone(),
        }),
    );

    let send_client = client.clone();
    tokio::spawn(async move {
        while let Some(Outbound {
            message,
            bytes,
            target_device_id,
            ephemeral,
        }) = outbound_rx.recv().await
        {
            let sent = match codec.encode(message, bytes, target_device_id.as_deref(), ephemeral) {
                Ok(Frame::Binary(body)) => {
                    send_client.send_binary(&body, target_device_id, None).await
                }
                Ok(Frame::Json(payload)) if ephemeral => {
                    send_client
                        .send_ephemeral(payload, target_device_id, None)
                        .await
                }
                Ok(Frame::Json(payload)) => {
                    send_client.send_targeted(payload, target_device_id).await
                }
                Err(error) => Err(error),
            };
            if let Err(error) = sent {
                tracing::warn!("Failed to send relay message: {error:#}");
            }
        }
    });

    tokio::spawn(client.into_task());
    Ok(manager)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::DEFAULT_RELAY_URL, relay_encryption::is_plain_id};

    #[tokio::test]
    async fn repeated_attach_updates_fcm_token() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let manager = RemotePeerManager::with_devices(AgentService::new(), tx, HashMap::new());
        manager
            .dispatch(json!({
                "id": "1",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": "token-1" }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert_eq!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .as_deref(),
            Some("token-1")
        );

        manager
            .dispatch(json!({
                "id": "2",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": "token-2" }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert_eq!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .as_deref(),
            Some("token-2")
        );

        manager
            .dispatch(json!({
                "id": "3",
                "method": "peer_attach",
                "params": { "deviceId": "phone-a", "fcmToken": null }
            }))
            .await;
        let _ = rx.recv().await.unwrap();
        assert!(
            manager.devices.lock().unwrap()["phone-a"]
                .fcm_token
                .is_none()
        );
    }

    #[tokio::test]
    async fn encrypted_handler_routes_authenticated_devices() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../packages/agentdeck/test/fixtures/e2ee-v1.json"
        ))
        .unwrap();
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel();
        // A known device keeps this test independent from user pairing files.
        let manager = Arc::new(RemotePeerManager {
            service: AgentService::new(),
            outbound_tx,
            devices: Arc::new(Mutex::new(HashMap::from([(
                "test-phone".into(),
                RemoteDevice {
                    peer_id: 1,
                    fcm_token: None,
                },
            )]))),
            peers: Arc::default(),
            ephemeral_calls: Arc::default(),
            next_peer_id: Arc::new(AtomicU64::new(2)),
            push_client: reqwest::Client::new(),
        });
        let handler = Handler {
            manager,
            codec: Arc::new(RelayCodec::new(vector["id"].as_str().unwrap()).unwrap()),
        };
        handler.on_payload(vector["attachFrame"].clone());
        let Outbound {
            message: attached,
            target_device_id: target,
            ..
        } = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attached["result"]["peerId"], 1);
        assert_eq!(target.as_deref(), Some("test-phone"));
        handler.on_payload(vector["listFrame"].clone());
        let Outbound {
            message: result,
            target_device_id: target,
            ..
        } = tokio::time::timeout(std::time::Duration::from_secs(1), outbound_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["id"], "list-1");
        assert!(result["result"]["agents"].is_array());
        assert_eq!(target.as_deref(), Some("test-phone"));
        handler.on_payload(vector["wrongPeerFrame"].clone());
        handler.on_payload(vector["wrongDeviceFrame"].clone());
        handler.on_payload(json!({"id":"plain", "method":"agent_list", "peerId":1}));
        tokio::task::yield_now().await;
        assert!(outbound_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn replies_follow_the_request_delivery_mode() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let manager = RemotePeerManager::with_devices(AgentService::new(), tx, HashMap::new());

        let request = json!({ "peerId": 1, "id": "e", "method": "agent_list", "params": {}, "ephemeral": true });
        manager.dispatch(request).await;
        let reply = rx.recv().await.unwrap();
        assert!(reply.ephemeral);
        assert_eq!(reply.message["id"], "e");
        assert!(manager.ephemeral_calls.lock().unwrap().is_empty());

        manager
            .dispatch(json!({ "peerId": 1, "id": "d", "method": "agent_list", "params": {} }))
            .await;
        assert!(!rx.recv().await.unwrap().ephemeral);

        // Streamed events keep the request ephemeral until its final reply.
        let calls = EphemeralCalls::default();
        calls.lock().unwrap().insert((1, json!("s").to_string()));
        assert!(take_ephemeral_reply(
            &calls,
            1,
            &json!({ "id": "s", "event": {} })
        ));
        assert!(!take_ephemeral_reply(
            &calls,
            2,
            &json!({ "id": "s", "result": {} })
        ));
        assert!(take_ephemeral_reply(
            &calls,
            1,
            &json!({ "id": "s", "result": {} })
        ));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn endpoint_url_adds_identity_to_built_in_url() {
        let relay_id = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            endpoint_url(DEFAULT_RELAY_URL, relay_id),
            format!("{DEFAULT_RELAY_URL}?id={relay_id}&endpoint=1&device_id=host")
        );
        assert_eq!(
            endpoint_url("ws://localhost:8080/custom", relay_id),
            format!("ws://localhost:8080/custom?id={relay_id}&endpoint=1&device_id=host")
        );
        assert!(is_plain_id(relay_id));
        assert!(!is_plain_id("not-a-uuid&endpoint=2"));
    }

    #[tokio::test]
    async fn remote_peer_manager_demultiplexes_multiple_devices() {
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();
        let service = AgentService::new();
        let manager = Arc::new(RemotePeerManager::with_devices(
            service,
            outbound_tx,
            HashMap::new(),
        ));

        // Phone A attaches
        manager
            .dispatch(json!({
                "id": "req-a1",
                "method": "peer_attach",
                "params": { "deviceId": "device-phone-a" }
            }))
            .await;

        let Outbound {
            message: res_a,
            target_device_id: target_a,
            ..
        } = outbound_rx.recv().await.expect("Phone A response");
        assert_eq!(target_a, Some("device-phone-a".to_string()));
        assert_eq!(res_a.get("peerId").and_then(Value::as_u64), Some(1));
        assert_eq!(
            res_a
                .get("result")
                .and_then(|r| r.get("peerId"))
                .and_then(Value::as_u64),
            Some(1)
        );

        // Phone B attaches
        manager
            .dispatch(json!({
                "id": "req-b1",
                "method": "peer_attach",
                "params": { "deviceId": "device-phone-b" }
            }))
            .await;

        let Outbound {
            message: res_b,
            target_device_id: target_b,
            ..
        } = outbound_rx.recv().await.expect("Phone B response");
        assert_eq!(target_b, Some("device-phone-b".to_string()));
        assert_eq!(res_b.get("peerId").and_then(Value::as_u64), Some(2));
        assert_eq!(
            res_b
                .get("result")
                .and_then(|r| r.get("peerId"))
                .and_then(Value::as_u64),
            Some(2)
        );

        // Phone A calls agent_list with peerId 1
        manager
            .dispatch(json!({
                "peerId": 1,
                "id": "req-a2",
                "method": "agent_list",
                "params": {}
            }))
            .await;

        let Outbound {
            message: res_agents,
            target_device_id: target_agents,
            ..
        } = outbound_rx.recv().await.expect("Phone A agent_list");
        assert_eq!(target_agents, Some("device-phone-a".to_string()));
        assert_eq!(res_agents.get("peerId").and_then(Value::as_u64), Some(1));
        assert_eq!(res_agents.get("id").and_then(Value::as_str), Some("req-a2"));
        assert!(res_agents.get("result").is_some());
    }
}
