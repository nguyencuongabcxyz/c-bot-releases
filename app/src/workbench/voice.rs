//! Speaking instead of typing in the chat: the mic by the chat box (robot.ts) asks for it, and
//! the words go into the box, which has the keyboard. Each system has its own engine behind
//! the same commands:
//!
//! - Windows: its own voice typing (Win+H), which listens and types into the box itself,
//!   with its own bar to stop it.
//! - Others: none yet (macOS has its dictation, Linux nothing: Whisper, run here, would do
//!   for both, and then the page shows the listening itself).

use serde_json::{Value, json};
use tauri::WebviewWindow;

#[cfg(windows)]
mod engine {
    use crate::platform::input;
    use crate::platform::input::Key;

    /// (system: the system shows that it's listening and stops by itself)
    pub const NAME: Option<&str> = Some("windows-voice-typing");
    pub const SYSTEM_UI: bool = true;

    /// Win+H, into the robot's window (in front, its chat box focused): voice typing opens there.
    pub fn start() -> Result<(), String> {
        if input::press(&[Key::Meta, Key::Char('H')]) {
            Ok(())
        } else {
            Err("Windows wouldn't start voice typing.".into())
        }
    }
}

#[cfg(not(windows))]
mod engine {
    pub const NAME: Option<&str> = None;
    pub const SYSTEM_UI: bool = false;

    pub fn start() -> Result<(), String> {
        Err("Speaking to me isn't here on this system yet.".into())
    }
}

/// Which engine there is (null: none, no mic), and whether the system shows the listening.
#[tauri::command]
pub fn voice_engine() -> Value {
    json!({ "name": engine::NAME, "systemUi": engine::SYSTEM_UI })
}

/// Start listening, into the chat box of the window that asked.
#[tauri::command(async)]
pub fn voice_start(window: WebviewWindow) -> Result<(), String> {
    // (the keys go to the window in front: make sure it's this one, and give it a moment)
    let _ = window.set_focus();
    std::thread::sleep(std::time::Duration::from_millis(60));
    engine::start()
}
