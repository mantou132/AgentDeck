//! Apps built with the host's `app` skill and saved on the phone, usable
//! without the host. Each one lives in `<root>/<id>/` and is served by the
//! `agentdeck-app` scheme with its id as the URL host, so every app has its
//! own origin. It opens by navigating the main webview to it rather than in a
//! frame: WebKit drops the storage of cross-origin frames when the app
//! restarts. `/__agentdeck/exit` on any app navigates back to the page that
//! opened it. Safe area insets come from the edge-to-edge plugin, whose script
//! runs on every page of the main webview.

use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder, Url, Webview,
    http::{Request, Response, StatusCode, header::CONTENT_TYPE},
    webview::{PageLoadEvent, PageLoadPayload},
};

pub const SCHEME: &str = "agentdeck-app";
const EXIT_PATH: &str = "/__agentdeck/exit";
const MAIN_WINDOW: &str = "main";

#[derive(Default)]
pub struct SavedApps {
    /// Page loading in the main webview, from `on_page_load`: asking the
    /// webview on Android's UI thread, where commands and links run, waits on
    /// that thread and aborts.
    page: Mutex<Option<Url>>,
    /// Page an app returns to, recorded when AgentDeck opens it.
    return_url: Mutex<Option<Url>>,
}

impl SavedApps {
    fn page(&self) -> Option<Url> {
        self.page.lock().expect("lock poisoned").clone()
    }

    #[cfg_attr(not(mobile), allow(dead_code))]
    fn showing_app(&self) -> bool {
        self.page().is_some_and(|url| showing_app(&url))
    }
}

/// Handler for `Builder::on_page_load`.
pub fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() == MAIN_WINDOW && payload.event() == PageLoadEvent::Started {
        *webview
            .state::<SavedApps>()
            .page
            .lock()
            .expect("lock poisoned") = Some(payload.url().clone());
    }
}

#[cfg(not(target_os = "ios"))]
fn root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("apps"))
}

/// In the App Group container, where the home screen widget lists the apps.
#[cfg(target_os = "ios")]
fn root<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(crate::share::app_group_dir()?.join("apps"))
}

/// Ids are URL hosts: lowercase letters and digits, starting with a letter.
fn check_id(id: &str) -> Result<(), String> {
    let valid = id.len() <= 63
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    valid
        .then_some(())
        .ok_or_else(|| format!("Invalid app id: {id}"))
}

/// `path` relative to an app directory, without climbing out of it.
fn check_path(path: &str) -> Result<&Path, String> {
    let path = Path::new(path.trim_start_matches('/'));
    path.components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then_some(path)
        .ok_or_else(|| format!("Invalid app file path: {}", path.display()))
}

fn staging(root: &Path, id: &str) -> PathBuf {
    root.join(format!(".staging-{id}"))
}

/// Starts saving app `id`; its files go to a staging directory until `saved_app_commit`.
#[tauri::command]
pub fn saved_app_begin<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    check_id(&id)?;
    let dir = staging(&root(&app)?, &id);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// Writes one file (base64) of the app being saved.
#[tauri::command]
pub fn saved_app_write<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    path: String,
    data: String,
) -> Result<(), String> {
    check_id(&id)?;
    let file = staging(&root(&app)?, &id).join(check_path(&path)?);
    let data = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file, data).map_err(|e| e.to_string())
}

/// Replaces the saved app with the staged files.
#[tauri::command]
pub fn saved_app_commit<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    check_id(&id)?;
    let root = root(&app)?;
    let dir = root.join(&id);
    let _ = fs::remove_dir_all(&dir);
    fs::rename(staging(&root, &id), dir).map_err(|e| e.to_string())
}

/// Drops the staged files of a save that failed.
#[tauri::command]
pub fn saved_app_discard<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    check_id(&id)?;
    fs::remove_dir_all(staging(&root(&app)?, &id)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct SavedApp {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Manifest {
    name: String,
}

/// Saved apps, most recently saved first; names come from each app's `agentdeck.json`.
#[tauri::command]
pub fn saved_app_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SavedApp>, String> {
    let Ok(entries) = fs::read_dir(root(&app)?) else {
        return Ok(Vec::new());
    };
    let mut apps: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let id = entry.file_name().into_string().ok()?;
            check_id(&id).ok()?;
            let manifest = fs::read(entry.path().join("agentdeck.json")).ok()?;
            let Manifest { name } = serde_json::from_slice(&manifest).ok()?;
            let saved = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((saved, SavedApp { id, name }))
        })
        .collect();
    apps.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(apps.into_iter().map(|(_, app)| app).collect())
}

/// Deletes a saved app's files; the data it stored in the webview stays.
#[tauri::command]
pub fn saved_app_remove<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    check_id(&id)?;
    fs::remove_dir_all(root(&app)?.join(id)).map_err(|e| e.to_string())
}

/// PNG copy of a saved app's `icon.svg`, written by the frontend, which home screen entries show.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const ICON_PATH: &str = "__agentdeck/icon.png";

/// Asks the Android launcher to pin a shortcut opening saved app `id`; iOS uses the widget instead.
#[tauri::command]
pub fn saved_app_pin<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    name: String,
) -> Result<(), String> {
    check_id(&id)?;
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_pin_shortcut::{PinShortcutExt, Shortcut};
        let icon = root(&app)?.join(&id).join(ICON_PATH);
        app.pin_shortcut()
            .pin(Shortcut {
                url: format!("agentdeck://app/{id}"),
                id,
                label: name,
                icon_path: icon.to_string_lossy().into_owned(),
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, name);
        Err("Pinning needs Android".into())
    }
}

/// URL of a saved app; Android exposes custom schemes as `https://<scheme>.<host>`.
fn app_url(id: &str) -> Url {
    let url = if cfg!(any(target_os = "android", windows)) {
        format!("https://{SCHEME}.{id}/")
    } else {
        format!("{SCHEME}://{id}/")
    };
    Url::parse(&url).expect("valid app URL")
}

/// Navigates the main webview from AgentDeck to saved app `id`.
#[tauri::command]
pub fn saved_app_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SavedApps>,
    id: String,
) -> Result<(), String> {
    check_id(&id)?;
    if !root(&app)?.join(&id).is_dir() {
        return Err(format!("App {id} is not saved"));
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or("Main window unavailable")?;
    *state.return_url.lock().expect("lock poisoned") =
        state.page().and_then(|url| url.join("/").ok());
    window.navigate(app_url(&id)).map_err(|e| e.to_string())
}

/// Whether the main webview shows a saved app rather than AgentDeck.
#[cfg_attr(not(mobile), allow(dead_code))]
fn showing_app(url: &Url) -> bool {
    url.scheme() == SCHEME
        || url
            .host_str()
            .is_some_and(|host| host.starts_with(&format!("{SCHEME}.")))
}

/// Id of an `agentdeck://app/<id>` link, which home screen entries open.
#[cfg_attr(not(mobile), allow(dead_code))]
fn linked_app_id(url: &Url) -> Option<&str> {
    let id = url.path().strip_prefix('/')?;
    (url.scheme() == "agentdeck" && url.host_str() == Some("app") && check_id(id).is_ok())
        .then_some(id)
}

/// AgentDeck's frontend handles links while it shows. While an app shows, a
/// link to another saved app opens it here, and any other link (e.g. shared
/// content) goes back to AgentDeck, which takes it as it starts.
#[cfg(mobile)]
pub fn handle_links<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        if !handle.state::<SavedApps>().showing_app() {
            return;
        }
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let urls = event.urls();
        match urls.first().and_then(linked_app_id) {
            Some(id) if root(&handle).is_ok_and(|root| root.join(id).is_dir()) => {
                let _ = window.navigate(app_url(id));
            }
            _ => exit(&handle),
        }
    });
}

/// A push tap while an app shows goes back to AgentDeck, which takes the tap
/// as it starts; tauri-plugin-fcm posts `FcmNotificationOpened` on a tap.
/// Android does this in `MainActivity.kt`, which gets the tap's intent.
#[cfg(target_os = "ios")]
pub fn exit_on_push_tap<R: Runtime>(app: &AppHandle<R>) {
    use objc2_foundation::{NSNotificationCenter, NSString};
    let handle = app.clone();
    let block = block2::RcBlock::new(move |_| {
        if handle.state::<SavedApps>().showing_app() {
            exit(&handle);
        }
    });
    let name = NSString::from_str("FcmNotificationOpened");
    // Posted on the main thread by the notification center delegate.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(&name),
            None,
            None,
            &block,
        )
    };
    // Observes for the life of the App.
    std::mem::forget(observer);
}

/// Back to the page that opened the app.
fn exit<R: Runtime>(app: &AppHandle<R>) {
    let url = app
        .state::<SavedApps>()
        .return_url
        .lock()
        .expect("lock poisoned")
        .clone();
    if let (Some(url), Some(window)) = (url, app.get_webview_window(MAIN_WINDOW)) {
        let _ = window.navigate(url);
    }
}

fn status(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

fn serve<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let host = uri.host().unwrap_or_default();
    let id = host.strip_prefix(&format!("{SCHEME}.")).unwrap_or(host);
    let path = uri.path();
    if path == EXIT_PATH {
        exit(app);
        // A navigation answered with 204 stays on the page until the webview leaves it.
        return status(StatusCode::NO_CONTENT);
    }
    let file = match (check_id(id), check_path(path), root(app)) {
        (Ok(()), Ok(file), Ok(root)) if path.ends_with('/') => {
            root.join(id).join(file).join("index.html")
        }
        (Ok(()), Ok(file), Ok(root)) => root.join(id).join(file),
        _ => return status(StatusCode::NOT_FOUND),
    };
    let Ok(body) = fs::read(&file) else {
        return status(StatusCode::NOT_FOUND);
    };
    let mime = mime_guess::from_path(&file).first_or_octet_stream();
    let content_type = if mime.type_() == mime_guess::mime::TEXT {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };
    Response::builder()
        .header(CONTENT_TYPE, content_type)
        .body(body)
        .unwrap()
}

/// Handler for `register_asynchronous_uri_scheme_protocol(SCHEME, handler)`.
pub fn handler<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(serve(&app, &request)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_url_hosts() {
        assert!(check_id("k3m9q2xv7a1p").is_ok());
        for id in ["", "3abc", "Abc", "a-b", "a.b"] {
            assert!(check_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn paths_stay_in_the_app() {
        assert!(check_path("/static/js/index.js").is_ok());
        assert!(check_path("/a/../../b").is_err());
    }

    #[test]
    fn app_links_name_a_saved_app() {
        let id = |url: &str| linked_app_id(&Url::parse(url).unwrap()).map(str::to_owned);
        assert_eq!(
            id("agentdeck://app/k3m9q2xv7a1p").as_deref(),
            Some("k3m9q2xv7a1p")
        );
        assert_eq!(id("agentdeck://share"), None);
        assert_eq!(id("agentdeck://app/a/b"), None);
    }
}
