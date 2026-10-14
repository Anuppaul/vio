#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::{PermissionKind, PermissionResponse};

fn main() {
    tauri::Builder::default()
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
