//! Signing in to Claude again: the button on an answer that says Claude Code's sign-in ran out.

use super::*;
use crate::robots::sender;
use crate::runtime::Error;

/// Sign in to Claude Code (the browser opens). Once you have, the conversations resting close,
/// so each starts again signed in on its next question.
#[tauri::command(async)]
pub fn robot_sign_in(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), Error> {
    sender(&window)?;
    let chosen = with(&app, |st| {
        st.store.settings()["claudePath"]
            .as_str()
            .unwrap_or("")
            .to_string()
    });
    let Some(path) = locate::find(&chosen) else {
        return Err("I can't find Claude Code anywhere on this computer.".into());
    };
    claude::login(&path)?;
    close_resting(&app, Duration::ZERO);
    Ok(())
}
