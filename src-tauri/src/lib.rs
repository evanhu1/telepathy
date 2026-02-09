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
            set_overlay_passthrough
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
