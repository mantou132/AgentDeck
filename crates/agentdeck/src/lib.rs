mod frontend_update;
mod js_protocol;
mod saved_apps;
mod share;

/// Serves host files to the preview browser; answered by `packages/agentdeck/src/agent/preview.ts`.
const PREVIEW_SCHEME: &str = "agentdeck-preview";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let frontend_dir = frontend_update::wrap_assets(&mut context);
    tauri::Builder::default()
        .setup(move |app| {
            // The main window is created here so its first request already
            // sees the frontend bundle picked for this launch.
            frontend_update::setup(app, &frontend_dir);
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .build()?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_deep_link::init())?;
            #[cfg(mobile)]
            saved_apps::handle_links(app.handle());
            #[cfg(target_os = "android")]
            app.handle().plugin(tauri_plugin_pin_shortcut::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_fcm::init())?;
            #[cfg(target_os = "ios")]
            saved_apps::exit_on_push_tap(app.handle());
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_haptics::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_selection_menu::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_stt::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_tts::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_add_to_calendar::init())?;
            Ok(())
        })
        .manage(js_protocol::JsProtocol::default())
        .manage(saved_apps::SavedApps::default())
        .register_asynchronous_uri_scheme_protocol(
            PREVIEW_SCHEME,
            js_protocol::handler(PREVIEW_SCHEME),
        )
        .register_asynchronous_uri_scheme_protocol(saved_apps::SCHEME, saved_apps::handler)
        .invoke_handler(tauri::generate_handler![
            js_protocol::js_protocol_register,
            js_protocol::js_protocol_respond,
            frontend_update::frontend_update_ready,
            share::share_take,
            saved_apps::saved_app_begin,
            saved_apps::saved_app_write,
            saved_apps::saved_app_commit,
            saved_apps::saved_app_list,
            saved_apps::saved_app_remove,
            saved_apps::saved_app_open,
            saved_apps::saved_app_pin
        ])
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_webproxy::init())
        .plugin(tauri_plugin_vnidrop_share::init())
        .plugin(tauri_plugin_opener::init())
        .run(context)
        .expect("error while running tauri application");
}
