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
            Ok(())
        })
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_webproxy::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
