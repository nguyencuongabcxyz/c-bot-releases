//! The keyboard and mouse: whether a key or the main mouse button is down, pressing keys into
//! whatever window has the keyboard (each system's own: os::input), and what's built on
//! those the same everywhere: waiting for the modifier keys to come up, and how long since
//! you last touched either.

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

pub use super::types::Key;
pub use crate::platform::os::input::is_down;
pub use crate::platform::os::input::main_button_down;
pub use crate::platform::os::input::press;
use crate::runtime::Locked;

/// Wait (a second at most) for Shift, Ctrl, Alt, Meta (and `extra`) to come up, so a key
/// pressed now isn't mixed up with a hotkey still held: our Ctrl+C isn't Ctrl+Alt+C.
pub fn wait_released(extra: Option<Key>) {
    let mut keys = vec![Key::Shift, Key::Ctrl, Key::Alt, Key::Meta];
    keys.extend(extra);
    for _ in 0..70 {
        if !keys.iter().any(|&k| is_down(k)) {
            return;
        }
        thread::sleep(Duration::from_millis(15));
    }
}

/// How long (s) since you last touched the mouse or keyboard (Electron's
/// powerMonitor.getSystemIdleTime): worked out from when the system's last-input stamp last
/// changed, as often as anyone asks (the walkers' clock asks every second).
pub fn idle_secs() -> u64 {
    static LAST: Mutex<Option<(u64, Instant)>> = Mutex::new(None);
    let stamp = crate::platform::os::input::last_input_stamp();
    let mut last = LAST.locked();
    let now = Instant::now();
    match *last {
        Some((seen, at)) if seen == stamp => now.duration_since(at).as_secs(),
        _ => {
            *last = Some((stamp, now));
            0
        }
    }
}
