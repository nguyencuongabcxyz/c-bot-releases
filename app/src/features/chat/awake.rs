//! While a conversation has Remote Control on, the PC stays awake. On a laptop like this
//! (Modern Standby), the screen going off by itself counts as going to sleep, and Windows then
//! freezes C-Bot and its Claude Code: claude.ai and the Claude app would lose the robot a few
//! minutes after you lock the PC and walk away. So C-Bot asks the system to keep the display
//! (and the system) on (platform::power); locking still locks.

use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::platform::power::KeepAwake;
use crate::runtime::with;

const EVERY: Duration = Duration::from_secs(5);

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some(mut awake) = KeepAwake::new("C-Bot: Remote Control is on") else {
            eprintln!("[awake] couldn't make a power request");
            return;
        };
        loop {
            awake.hold(with(&app, |st| {
                st.chats.values().any(|c| c.session.remote())
            }));
            thread::sleep(EVERY);
        }
    });
}
