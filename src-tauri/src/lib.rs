use std::process::Command;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

const HOLD_TO_RECORD_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyEventPayload {
    state: &'static str,
    shortcut: &'static str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteResult {
    pasted: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessibilityStatus {
    granted: bool,
    detail: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum SettingsPanel {
    Camera,
    Accessibility,
}

#[tauri::command]
fn paste_text(text: String) -> Result<PasteResult, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| format!("Clipboard init failed: {err}"))?;
    clipboard
        .set_text(text)
        .map_err(|err| format!("Clipboard write failed: {err}"))?;

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to keystroke \"v\" using command down",
            ])
            .status()
            .map_err(|err| format!("Unable to trigger paste keystroke: {err}"))?;
        if !status.success() {
            return Err(
                "Paste keystroke was blocked. Enable Accessibility access for Telepathy."
                    .to_string(),
            );
        }
        return Ok(PasteResult { pasted: true });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(PasteResult { pasted: false })
    }
}

#[tauri::command]
fn check_accessibility_permission() -> AccessibilityStatus {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to get UI elements enabled",
            ])
            .output();

        match output {
            Ok(result) if result.status.success() => {
                let stdout = String::from_utf8_lossy(&result.stdout)
                    .trim()
                    .to_lowercase();
                AccessibilityStatus {
                    granted: stdout == "true",
                    detail: None,
                }
            }
            Ok(result) => {
                let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
                AccessibilityStatus {
                    granted: false,
                    detail: if stderr.is_empty() {
                        None
                    } else {
                        Some(stderr)
                    },
                }
            }
            Err(err) => AccessibilityStatus {
                granted: false,
                detail: Some(err.to_string()),
            },
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        AccessibilityStatus {
            granted: true,
            detail: None,
        }
    }
}

#[tauri::command]
fn open_system_settings(panel: SettingsPanel) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let urls: &[&str] = match panel {
            SettingsPanel::Camera => &[
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Camera",
                "x-apple.systempreferences:com.apple.preference.security",
            ],
            SettingsPanel::Accessibility => &[
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
                "x-apple.systempreferences:com.apple.preference.security",
            ],
        };

        let mut last_error: Option<String> = None;

        for url in urls {
            let output = Command::new("open")
                .arg(url)
                .output()
                .map_err(|err| format!("Unable to execute 'open' for {url}: {err}"))?;
            if output.status.success() {
                return Ok(());
            }

            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let status = output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string());
            let detail = if stderr.is_empty() {
                format!("open exited with status {status} for {url}")
            } else {
                format!("open exited with status {status} for {url}: {stderr}")
            };
            last_error = Some(detail);
        }

        return Err(
            last_error.unwrap_or_else(|| "Unable to open System Settings.".to_string()),
        );
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = panel;
        Err("System Settings deep link is only implemented on macOS.".to_string())
    }
}

#[tauri::command]
fn set_overlay_passthrough(
    app: tauri::AppHandle,
    ignore_cursor_events: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found.".to_string())?;
    window
        .set_ignore_cursor_events(ignore_cursor_events)
        .map_err(|err| format!("Unable to update overlay passthrough mode: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|_app| Ok(()))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([HOLD_TO_RECORD_SHORTCUT])
                .expect("failed to register global shortcut")
                .with_handler(|app, _shortcut, event| {
                    let state = match event.state {
                        ShortcutState::Pressed => "pressed",
                        ShortcutState::Released => "released",
                    };
                    let _ = app.emit(
                        "telepathy://hotkey",
                        HotkeyEventPayload {
                            state,
                            shortcut: HOLD_TO_RECORD_SHORTCUT,
                        },
                    );
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            paste_text,
            check_accessibility_permission,
            open_system_settings,
            set_overlay_passthrough
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
