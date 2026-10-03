//! `agentdeck-preview` protocol: a virtual static server for host files. The
//! Relay connection lives in the webview, so each request is emitted to the
//! webview, which reads the file from the daemon and answers through
//! `preview_respond`. Bytes cross IPC as the daemon's base64 string, since
//! Android IPC would serialize raw bytes as a JSON number array.
//!
//! Media elements fetch by `Range` (WebKit won't play video otherwise), so a
//! ranged request reads just that slice, capped at `RANGE_CHUNK_BYTES`; the
//! player asks for the rest as it goes.

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
    Emitter, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder,
    http::{
        Request, Response, StatusCode,
        header::{ACCEPT_RANGES, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    },
};

pub const SCHEME: &str = "agentdeck-preview";
const REQUEST_EVENT: &str = "preview-request";
const RANGE_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct PreviewRequests {
    next_id: AtomicU64,
    /// Responder and the requested range's start offset.
    pending: Mutex<HashMap<u64, (UriSchemeResponder, Option<u64>)>>,
}

impl PreviewRequests {
    fn take(&self, id: u64) -> Option<(UriSchemeResponder, Option<u64>)> {
        self.pending.lock().expect("lock poisoned").remove(&id)
    }
}

#[derive(Clone, Serialize)]
struct PreviewRequest {
    id: u64,
    url: String,
    /// `[offset, length]` of the slice to read; absent reads the whole file.
    range: Option<[u64; 2]>,
}

fn status(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

/// `bytes=start-[end]` as `[offset, length]`; suffix and multi ranges, which
/// media elements don't send, read the whole file.
fn parse_range(header: &str) -> Option<[u64; 2]> {
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let length = match end {
        "" => RANGE_CHUNK_BYTES,
        end => (end.parse::<u64>().ok()?.checked_sub(start)? + 1).min(RANGE_CHUNK_BYTES),
    };
    Some([start, length])
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle();
    let requests = app.state::<PreviewRequests>();
    let id = requests.next_id.fetch_add(1, Ordering::Relaxed);
    let range = request
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_range);
    requests
        .pending
        .lock()
        .expect("lock poisoned")
        .insert(id, (responder, range.map(|[offset, _]| offset)));
    let event = PreviewRequest {
        id,
        url: request.uri().to_string(),
        range,
    };
    if app
        .emit_to(ctx.webview_label(), REQUEST_EVENT, event)
        .is_err()
        && let Some((responder, _)) = requests.take(id)
    {
        responder.respond(status(StatusCode::INTERNAL_SERVER_ERROR));
    }
}

/// Answers a pending request; `data` is the body as base64: the file, or the
/// webview's error page when it could not be read. `path` picks the content type;
/// `size` is the whole file's length, answering a ranged request with 206.
#[tauri::command]
pub fn preview_respond(
    requests: State<'_, PreviewRequests>,
    id: u64,
    path: String,
    data: String,
    status: u16,
    size: Option<u64>,
) {
    let Some((responder, offset)) = requests.take(id) else {
        return;
    };
    let Ok(body) = STANDARD.decode(data) else {
        return responder.respond(self::status(StatusCode::INTERNAL_SERVER_ERROR));
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    // Generated pages often omit `<meta charset>`; text defaults to UTF-8.
    let content_type = if mime.type_() == mime_guess::mime::TEXT {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };
    let mut response = Response::builder()
        .header(CONTENT_TYPE, content_type)
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
        (Some(offset), Some(size)) if status == 200 => {
            response.status(StatusCode::PARTIAL_CONTENT).header(
                CONTENT_RANGE,
                format!("bytes {offset}-{}/{size}", offset + body.len() as u64 - 1),
            )
        }
        _ => response.status(status),
    };
    responder.respond(response.body(body).unwrap());
}
