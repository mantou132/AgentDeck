mod js_protocol;

/// Serves host files to the preview browser; answered by `packages/agentdeck/src/agent/preview.ts`.
const PREVIEW_SCHEME: &str = "agentdeck-preview";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_fcm::init())?;
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_haptics::init())?;
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_selection_menu::init())?;
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_stt::init())?;
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_tts::init())?;
            Ok(())
        })
        .manage(js_protocol::JsProtocol::default())
        .register_asynchronous_uri_scheme_protocol(PREVIEW_SCHEME, js_protocol::handler(PREVIEW_SCHEME))
        .invoke_handler(tauri::generate_handler![
            js_protocol::js_protocol_register,
            js_protocol::js_protocol_respond
        ])
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_webproxy::init())
        .plugin(tauri_plugin_vnidrop_share::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
