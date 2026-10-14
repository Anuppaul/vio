#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::{PermissionKind, PermissionResponse};

#[cfg(target_os = "linux")]
use tauri::Manager;
#[cfg(target_os = "linux")]
use webkit2gtk::{SettingsExt, WebViewExt};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // WebKitGTK defaults media-stream to disabled. The permission handler
            // cannot make microphone capture work until this is enabled.
            #[cfg(target_os = "linux")]
            {
                let window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "VIO main window missing")
                })?;
                window.with_webview(|view| {
                    if let Some(settings) = view.inner().settings() {
                        // VIO uses oscillator/buffer playback and HTML audio in
                        // addition to the WebRTC microphone capture path.
                        settings.set_enable_media(true);
                        settings.set_enable_webaudio(true);
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                    }
                })?;
            }
            Ok(())
        })
        // WebKitGTK denies microphone permission requests by default.
        // Only the application's own main webview may request audio capture.
        // The user explicitly initiates capture with Start tuning / Start microphone.
        .on_permission_request(|webview, permission| match permission {
            PermissionKind::Microphone => {
                let trusted_app = webview.label() == "main"
                    && webview
                        .url()
                        .map(|url| {
                            let scheme = url.scheme();
                            let host = url.host_str();
                            (scheme == "tauri" && host == Some("localhost"))
                                || ((scheme == "http" || scheme == "https")
                                    && host == Some("tauri.localhost"))
                                || (cfg!(debug_assertions)
                                    && scheme == "http"
                                    && host == Some("localhost")
                                    && url.port() == Some(3000))
                        })
                        .unwrap_or(false);
                if trusted_app {
                    PermissionResponse::Allow
                } else {
                    PermissionResponse::Deny
                }
            }
            // VIO needs microphone audio, not camera or display capture.
            PermissionKind::Camera | PermissionKind::DisplayCapture => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        })
        .run(tauri::generate_context!())
        .expect("error while running VIO desktop");
}
