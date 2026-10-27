//! Speaking instead of typing in the chat: the mic by the chat box (robot.ts) asks for it, and
//! the words go into the box, which has the keyboard. Each system has its own engine behind
//! the same commands:
//!
//! - Windows: its own voice typing (Win+H), which listens and types into the box itself,
//!   with its own bar to stop it.
//! - Others: none yet (macOS has its dictation, Linux nothing: Whisper, run here, would do
//!   for both, and then the page shows the listening itself).

use serde_json::{json, Value};
use tauri::WebviewWindow;

#[cfg(windows)]
mod engine {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_H, VK_LWIN};

    /// (system: the system shows that it's listening and stops by itself)
    pub const NAME: Option<&str> = Some("windows-voice-typing");
    pub const SYSTEM_UI: bool = true;

    fn key(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// Win+H, into the robot's window (in front, its chat box focused): voice typing opens there.
    pub fn start() -> Result<(), String> {
        let inputs = [key(VK_LWIN, false), key(VK_H, false), key(VK_H, true), key(VK_LWIN, true)];
        // SAFETY: a valid array of keyboard INPUTs, its length and the struct's size.
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() { Ok(()) } else { Err("Windows wouldn't start voice typing.".into()) }
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
