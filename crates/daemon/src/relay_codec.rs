//! Converts RPC messages to Relay frames and back: optional end-to-end
//! encryption, the Relay frame size limit, and binary framing. Knows nothing
//! about peers or devices.

use anyhow::Result;
use serde_json::{Value, json};

use crate::relay_encryption::{RelayEncryption, is_plain_id};

/// Relay's WebSocket message limit, including the frame envelope.
const MAX_FRAME_BYTES: usize = 10 * 1024 * 1024;

/// One encoded outbound message.
#[derive(Debug)]
pub(crate) enum Frame {
    Json(Value),
    Binary(Vec<u8>),
}

pub(crate) struct RelayCodec {
    /// Relay channel id: the pairing id itself for plain UUIDs, otherwise derived.
    pub(crate) route_id: String,
    encryption: Option<RelayEncryption>,
}

impl RelayCodec {
    pub(crate) fn new(relay_id: &str) -> Result<Self> {
        if is_plain_id(relay_id) {
            return Ok(Self {
                route_id: relay_id.to_owned(),
                encryption: None,
            });
        }
        let encryption = RelayEncryption::new(relay_id)?;
        Ok(Self {
            route_id: encryption.route_id.clone(),
            encryption: Some(encryption),
        })
    }

    /// Encodes a message for the Relay. A message with attached bytes becomes
    /// a binary frame, which the Relay always delivers ephemerally. A JSON
    /// reply too large for one frame is replaced with a small error reply.
    pub(crate) fn encode(
        &self,
        message: Value,
        bytes: Option<Vec<u8>>,
        target_device_id: Option<&str>,
        ephemeral: bool,
    ) -> Result<Frame> {
        if let Some(bytes) = bytes {
            let body = binary_body(&message, bytes)?;
            return Ok(Frame::Binary(match &self.encryption {
                Some(encryption) => encryption.seal_bytes(&body)?,
                None => body,
            }));
        }
        let oversized_reply = if message.get("id").is_some() && message.get("method").is_none() {
            Some(json!({
                "id": message["id"],
                "peerId": message["peerId"],
                "error": "Response is too large for Relay transport. Request a smaller file or result."
            }))
        } else {
            None
        };
        let payload = self.seal(message)?;
        // MemoryStore generates UUID message IDs. Count the actual Relay envelope,
        // including targeting, without copying the potentially large payload.
        let empty_frame = relay_client::relay_frame::ClientFrame::Message {
            message_id: "00000000-0000-0000-0000-000000000000".into(),
            payload: Value::Null,
            target_device_id: target_device_id.map(str::to_owned),
            ephemeral,
        };
        let size =
            serde_json::to_vec(&empty_frame)?.len() - 4 + serde_json::to_vec(&payload)?.len();
        if size > MAX_FRAME_BYTES {
            let reply =
                oversized_reply.ok_or_else(|| anyhow::anyhow!("Relay message is too large"))?;
            return Ok(Frame::Json(self.seal(reply)?));
        }
        Ok(Frame::Json(payload))
    }

    /// Decodes an inbound JSON payload. The sender is the authenticated device
    /// id when encrypted, and unknown for plain pairings.
    pub(crate) fn decode(&self, payload: Value) -> Result<(Option<String>, Value)> {
        match &self.encryption {
            Some(encryption) => {
                let (sender, message) = encryption.open(payload)?;
                Ok((Some(sender), message))
            }
            None => Ok((None, payload)),
        }
    }

    fn seal(&self, message: Value) -> Result<Value> {
        match &self.encryption {
            Some(encryption) => encryption.seal(message),
            None => Ok(message),
        }
    }
}

/// Binary frame body: `[u32 big-endian header length][message JSON][bytes]`;
/// the receiver puts the bytes at `result.data`.
fn binary_body(message: &Value, bytes: Vec<u8>) -> Result<Vec<u8>> {
    let header = serde_json::to_vec(message)?;
    let mut body = Vec::with_capacity(4 + header.len() + bytes.len());
    body.extend_from_slice(&u32::try_from(header.len())?.to_be_bytes());
    body.extend(header);
    body.extend(bytes);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

    fn encrypted_codec() -> RelayCodec {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../packages/agentdeck/test/fixtures/e2ee-v1.json"
        ))
        .unwrap();
        RelayCodec::new(vector["id"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn plain_pairings_route_by_id_and_pass_payloads_through() {
        let codec = RelayCodec::new(PLAIN_ID).unwrap();
        assert_eq!(codec.route_id, PLAIN_ID);
        let message = json!({ "id": "1", "result": {} });
        let Frame::Json(payload) = codec.encode(message.clone(), None, None, false).unwrap() else {
            panic!("expected a JSON frame");
        };
        assert_eq!(payload, message);
        assert_eq!(codec.decode(message.clone()).unwrap(), (None, message));
    }

    #[test]
    fn encrypted_file_response_over_limit_becomes_a_small_authenticated_error() {
        let Frame::Json(frame) = encrypted_codec()
            .encode(
                json!({"id": "file-1", "peerId": 1, "result": {"text": "x".repeat(8 * 1024 * 1024)}}),
                None,
                Some("test-phone"),
                false,
            )
            .unwrap()
        else {
            panic!("expected a JSON frame");
        };
        assert_eq!(frame["e2ee"], 1);
        assert!(serde_json::to_vec(&frame).unwrap().len() < 1024);
        assert!(!serde_json::to_string(&frame).unwrap().contains("file-1"));
        assert!(frame.get("sequence").is_none());
    }

    #[test]
    fn attached_bytes_become_binary_frames() {
        let reply = json!({
            "id": "img-1",
            "peerId": 1,
            "result": { "path": "/tmp/a.png", "type": "image", "mimeType": "image/png" }
        });
        let codec = RelayCodec::new(PLAIN_ID).unwrap();
        // Bytes always travel as a binary frame, whatever the delivery mode.
        for ephemeral in [true, false] {
            let Frame::Binary(body) = codec
                .encode(reply.clone(), Some(vec![0, 1, 2, 255]), None, ephemeral)
                .unwrap()
            else {
                panic!("expected a binary frame");
            };
            let header_len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
            let header: Value = serde_json::from_slice(&body[4..4 + header_len]).unwrap();
            assert_eq!(header, reply);
            assert_eq!(&body[4 + header_len..], [0, 1, 2, 255]);
        }

        let Frame::Binary(sealed) = encrypted_codec()
            .encode(reply, Some(vec![0, 1, 2, 255]), None, true)
            .unwrap()
        else {
            panic!("expected a binary frame");
        };
        assert!(!sealed.windows(5).any(|window| window == b"img-1"));
    }
}
