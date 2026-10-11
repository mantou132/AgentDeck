//! Custom URI schemes answered by the webview: each request goes over the
//! `Channel` the webview registered for its scheme, and the handler replies
//! through `js_protocol_respond`. Kept free of AgentDeck specifics so it can
//! move into a plugin. Bodies cross IPC as base64, since Android IPC would
//! serialize raw bytes as a JSON number array.
//!
//! Media elements fetch by `Range` (WebKit won't play video otherwise), so a
//! ranged request asks the handler for just that slice, capped at
//! `RANGE_CHUNK_BYTES`; the player asks for the rest as it goes.

use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::{
    Manager, Runtime, State, UriSchemeContext, UriSchemeResponder,
    http::{
        Request, Response, StatusCode,
        header::{ACCEPT_RANGES, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    },
    ipc::Channel,
};

const RANGE_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct JsProtocol {
    next_id: AtomicU64,
    handlers: Mutex<HashMap<String, Channel<ProtocolRequest>>>,
    pending: Mutex<HashMap<u64, Pending>>,
}

struct Pending {
    responder: UriSchemeResponder,
    /// URL path, picking the default content type.
    path: String,
    /// Start offset of the requested range.
    offset: Option<u64>,
}

impl JsProtocol {
    fn take(&self, id: u64) -> Option<Pending> {
        self.pending.lock().expect("lock poisoned").remove(&id)
    }
}

#[derive(Clone, Serialize)]
pub struct ProtocolRequest {
    id: u64,
    url: String,
    /// Slice to read; absent reads the whole resource.
    range: Option<ByteRange>,
}

#[derive(Clone, Copy, Serialize)]
struct ByteRange {
    offset: u64,
    length: u64,
}

fn status(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

/// `bytes=start-[end]`; suffix and multi ranges, which media elements don't
/// send, read the whole resource.
fn parse_range(header: &str) -> Option<ByteRange> {
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    let offset = start.parse::<u64>().ok()?;
    let length = match end {
        "" => RANGE_CHUNK_BYTES,
        end => (end.parse::<u64>().ok()?.checked_sub(offset)? + 1).min(RANGE_CHUNK_BYTES),
    };
    Some(ByteRange { offset, length })
}

/// Guessed from the URL path; a directory URL serves its index page, and
/// text defaults to UTF-8 since generated pages often omit `<meta charset>`.
fn guess_content_type(path: &str) -> String {
    if path.ends_with('/') {
        return "text/html; charset=utf-8".into();
    }
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if mime.type_() == mime_guess::mime::TEXT {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}

/// Handler for `register_asynchronous_uri_scheme_protocol(scheme, handler(scheme))`.
pub fn handler<R: Runtime>(
    scheme: &'static str,
) -> impl Fn(UriSchemeContext<'_, R>, Request<Vec<u8>>, UriSchemeResponder) + Send + Sync + 'static {
    move |ctx, request, responder| {
        let state = ctx.app_handle().state::<JsProtocol>();
        let Some(channel) = state.handlers.lock().expect("lock poisoned").get(scheme).cloned() else {
            return responder.respond(status(StatusCode::SERVICE_UNAVAILABLE));
        };
        let id = state.next_id.fetch_add(1, Ordering::Relaxed);
        let range = request
            .headers()
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_range);
        state.pending.lock().expect("lock poisoned").insert(
            id,
            Pending {
                responder,
                path: request.uri().path().to_owned(),
                offset: range.map(|range| range.offset),
            },
        );
        let event = ProtocolRequest {
            id,
            url: request.uri().to_string(),
            range,
        };
        if channel.send(event).is_err()
            && let Some(pending) = state.take(id)
        {
            pending.responder.respond(status(StatusCode::INTERNAL_SERVER_ERROR));
        }
    }
}

/// Routes the scheme's requests to `channel`, replacing an earlier handler.
#[tauri::command]
pub fn js_protocol_register(state: State<'_, JsProtocol>, scheme: String, channel: Channel<ProtocolRequest>) {
    state.handlers.lock().expect("lock poisoned").insert(scheme, channel);
}

/// Answers a pending request with `body` as base64. `size` is the whole
/// resource's length, answering a ranged request with 206.
#[tauri::command]
pub fn js_protocol_respond(
    state: State<'_, JsProtocol>,
    id: u64,
    body: String,
    status: u16,
    size: Option<u64>,
    content_type: Option<String>,
) {
    let Some(Pending { responder, path, offset }) = state.take(id) else {
        return;
    };
    let Ok(body) = STANDARD.decode(body) else {
        return responder.respond(self::status(StatusCode::INTERNAL_SERVER_ERROR));
    };
    let mut response = Response::builder()
        .header(CONTENT_TYPE, content_type.unwrap_or_else(|| guess_content_type(&path)))
        .header(ACCEPT_RANGES, "bytes");
    response = match (offset, size) {
        (Some(offset), Some(size)) if status == 200 && offset >= size => {
            return responder.respond(
                Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(CONTENT_RANGE, format!("bytes */{size}"))
                    .body(Vec::new())
                    .unwrap(),
            );
        }
        (Some(offset), Some(size)) if status == 200 => response.status(StatusCode::PARTIAL_CONTENT).header(
            CONTENT_RANGE,
            format!("bytes {offset}-{}/{size}", offset + body.len() as u64 - 1),
        ),
        _ => response.status(status),
    };
    responder.respond(response.body(body).unwrap());
}
