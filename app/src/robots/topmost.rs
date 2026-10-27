//! Windows can silently drop a window's "always on top" flag (taking a snip with the
//! Snipping Tool does it), and the robot falls behind the other windows and seems to
//! vanish. So every couple of seconds the real flag is read off each window that should
//! float, and put back when it's gone (main topmost.js). It only ever restores a lost
//! flag, so it never fights the Snipping Tool's own overlay or other always-on-top apps.

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::platform::window;

const EVERY: Duration = Duration::from_secs(2);

/// The windows that float over everything: the robots, the ones out walking, the word
/// card, the notebook, Quick actions and the robot island.
fn floats(label: &str) -> bool {
    label.starts_with("robot-")
        || label.starts_with("walker-")
        || matches!(label, "card" | "notebook" | "quick" | "island")
}

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(EVERY);
            let handles: Vec<isize> = app
                .webview_windows()
                .into_iter()
                .filter(|(label, _)| floats(label))
                .filter_map(|(_, w)| w.hwnd().ok().map(|h| h.0 as isize))
                .collect();
            // (a window closing meanwhile: setting it on top just fails; next time it's gone)
            for hwnd in handles {
                window::restore_topmost(hwnd);
            }
        }
    });
}
