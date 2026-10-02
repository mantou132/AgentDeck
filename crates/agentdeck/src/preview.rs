//! `agentdeck-preview` protocol: a virtual static server for host files. The
//! Relay connection lives in the webview, so each request is emitted to the
//! webview, which reads the file from the daemon and answers through
//! `preview_respond`. Bytes cross IPC as the daemon's base64 string, since
//! Android IPC would serialize raw bytes as a JSON number array.

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
    http::{Request, Response, StatusCode, header::CONTENT_TYPE},
};

pub const SCHEME: &str = "agentdeck-preview";
const REQUEST_EVENT: &str = "preview-request";

#[derive(Default)]
pub struct PreviewRequests {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, UriSchemeResponder>>,
}

impl PreviewRequests {
    fn take(&self, id: u64) -> Option<UriSchemeResponder> {
        self.pending.lock().expect("lock poisoned").remove(&id)
    }
}

#[derive(Clone, Serialize)]
struct PreviewRequest {
    id: u64,
    url: String,
}

fn status(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle();
    let requests = app.state::<PreviewRequests>();
    let id = requests.next_id.fetch_add(1, Ordering::Relaxed);
    requests
        .pending
        .lock()
        .expect("lock poisoned")
        .insert(id, responder);
    let event = PreviewRequest {
        id,
        url: request.uri().to_string(),
    };
    if app
        .emit_to(ctx.webview_label(), REQUEST_EVENT, event)
        .is_err()
        && let Some(responder) = requests.take(id)
    {
        responder.respond(status(StatusCode::INTERNAL_SERVER_ERROR));
    }
}

/// Answers a pending request; `data` is the body as base64: the file, or the
/// webview's error page when it could not be read. `path` picks the content type.
#[tauri::command]
pub fn preview_respond(
    requests: State<'_, PreviewRequests>,
    id: u64,
    path: String,
    data: String,
    status: u16,
) {
    let Some(responder) = requests.take(id) else {
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
    responder.respond(
        Response::builder()
            .status(status)
            .header(CONTENT_TYPE, content_type)
            .body(body)
            .unwrap(),
    );
}
