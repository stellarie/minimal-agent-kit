use std::sync::Arc;

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::paths;
use crate::supervisor::{self, Shared};

const WINDOW: &str = "main";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItemBuilder::with_id("open", "Open").build(app)?;
    let logon_item = CheckMenuItemBuilder::with_id("autostart", "Start at logon")
        .checked(logon_enabled(app))
        .build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&logon_item)
        .item(&quit_item)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("lounge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show(app),
            "autostart" => toggle_logon(app, &logon_item),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn open_window(app: &AppHandle, url: String) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Ok(target) = url.parse::<tauri::Url>() else {
        eprintln!("cannot parse the lounge url");
        return;
    };
    match WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(target))
        .title("Agent Lounge")
        .inner_size(1100.0, 760.0)
        .disable_drag_drop_handler()
        .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("cannot open the lounge window: {err}"),
    }
}

fn show(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>();
    if let Some(url) = shared.url() {
        open_window(app, url);
        return;
    }
    let log = supervisor::core_log(&paths::lounge_home());
    let text = supervisor::status_text(shared.last_error().as_deref(), &log);
    let shown = app
        .notification()
        .builder()
        .title("Agent Lounge")
        .body(text)
        .show();
    if let Err(err) = shown {
        eprintln!("cannot show the core status: {err}");
    }
}

fn logon_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn toggle_logon(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let autolaunch = app.autolaunch();
    let enabled = autolaunch.is_enabled().unwrap_or(false);
    let changed = if enabled {
        autolaunch.disable()
    } else {
        autolaunch.enable()
    };
    match changed {
        Ok(()) => {
            let _ = item.set_checked(!enabled);
        }
        Err(err) => {
            eprintln!("cannot change start at logon: {err}");
            let _ = item.set_checked(enabled);
        }
    }
}

fn quit_app(app: &AppHandle) {
    app.state::<Arc<Shared>>().shutdown();
    app.exit(0);
}
