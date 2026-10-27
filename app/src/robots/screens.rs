//! The screens changing, a sleep and an unlock (main.js, the end of whenReady): a screen
//! added or taken away, a new resolution or scale, the taskbar moved: the robots are
//! refitted onto what's there now and anyone out for a walk comes back where you can reach
//! them; after a sleep or an unlock, the walkers too. Electron told of these as events;
//! here they're noticed by looking every couple of seconds (the screens as Tauri sees them,
//! whether the desktop takes input, and the clock jumping ahead).

use std::thread;
use std::time::{Duration, SystemTime};

use tauri::AppHandle;

use crate::platform::presence;
use crate::robots;
use crate::robots::{revive, walkers};

const EVERY: Duration = Duration::from_secs(2);
// a look that comes this late means the PC was asleep
const SLEPT: Duration = Duration::from_secs(30);
// after waking, give the screens a moment to come back (main.js's 1.5 s)
const SETTLE: Duration = Duration::from_millis(1500);

/// A screen as compared: where it is, where windows may go on it ([x, y, w, h] each), and its
/// scale (in hundredths).
type Screen = ([i32; 4], [i32; 4], u32);

/// The screens, in a set order: two look the same when nothing about the screens changed.
/// (Tauri asks the main thread: fine here, on this thread of its own, holding nothing.)
fn layout(app: &AppHandle) -> Vec<Screen> {
    let mut screens: Vec<Screen> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (p, s, w) = (m.position(), m.size(), m.work_area());
            (
                [p.x, p.y, s.width as i32, s.height as i32],
                [w.position.x, w.position.y, w.size.width as i32, w.size.height as i32],
                (m.scale_factor() * 100.0).round() as u32,
            )
        })
        .collect();
    screens.sort();
    screens
}

fn after_wake(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(SETTLE);
        walkers::recover(&app);
        revive::nudge_all(&app); // (WebView2 can leave a window blank after a sleep)
    });
}

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let mut screens = layout(&app);
        let mut was_locked = presence::locked();
        let mut last = SystemTime::now();
        loop {
            thread::sleep(EVERY);
            let now = SystemTime::now();
            let slept = now.duration_since(last).is_ok_and(|d| d > SLEPT);
            last = now;
            let is_locked = presence::locked();
            let unlocked = was_locked && !is_locked;
            was_locked = is_locked;
            if slept || unlocked {
                after_wake(&app);
            }
            let fresh = layout(&app);
            if fresh != screens && !fresh.is_empty() {
                screens = fresh;
                walkers::recover(&app);
                robots::refit(&app);
            }
        }
    });
}
