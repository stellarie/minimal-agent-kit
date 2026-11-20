#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod health;
mod job;
mod paths;
mod supervisor;
#[cfg(test)]
mod test_support;
mod token;
mod tray;

use std::sync::Arc;

use tauri::RunEvent;

fn main() {
    let shared = supervisor::Shared::new();
    let managed = Arc::clone(&shared);
    let running = Arc::clone(&shared);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(managed)
        .setup(move |app| {
            tray::build(app.handle())?;
            supervisor::start(app.handle().clone(), Arc::clone(&shared));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("the lounge shell failed to start");

    app.run(move |_app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => running.shutdown(),
        _ => {}
    });
}
