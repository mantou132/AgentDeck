//! Hands content shared to the app to the frontend. Android's `MainActivity.kt` copies it into the cache
//! directory, the iOS share extension (`gen/apple/ShareExtension`) into the App Group container.
use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    name: String,
    mime_type: String,
    path: Option<String>,
    #[serde(default)]
    too_large: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    name: String,
    mime_type: String,
    /// Base64; missing when the file could not be copied.
    data: Option<String>,
    too_large: bool,
}

/// Returns and removes the pending share; empty when there is none.
#[tauri::command]
pub fn share_take(app: tauri::AppHandle) -> Result<Vec<SharedFile>, String> {
    let dir = shared_dir(&app)?;
    let Ok(manifest) = std::fs::read(dir.join("manifest.json")) else {
        return Ok(Vec::new());
    };
    let entries: Vec<ManifestEntry> = serde_json::from_slice(&manifest).map_err(|e| e.to_string())?;
    let files = entries
        .into_iter()
        .map(|entry| SharedFile {
            data: entry
                .path
                .and_then(|path| std::fs::read(dir.join(path)).ok())
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
            name: entry.name,
            mime_type: entry.mime_type,
            too_large: entry.too_large,
        })
        .collect();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(files)
}

#[cfg(not(target_os = "ios"))]
fn shared_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("shared"))
}

#[cfg(target_os = "ios")]
fn shared_dir(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use objc2_foundation::{NSFileManager, NSString};
    let group = NSString::from_str("group.com.mantou.agentdeck");
    let path = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&group)
        .and_then(|url| url.path())
        .ok_or("App Group container unavailable")?;
    Ok(std::path::PathBuf::from(path.to_string()).join("shared"))
}
