//! A paper plane flying across the screen from one robot's desk to another's (main
//! plane.js): a small see-through window ("plane-<n>") that never takes the mouse, moved
//! along an arc; the page (renderer/plane) draws the plane, tilted along its path
//! (plane:pose). [wave 1: desktop]
//!
//! Points are screen physical px. A miss overshoots, glides down past the desk and lies
//! there a moment before it fades.

use std::f64::consts::PI;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter};

use crate::walkers::{self, Done};
use crate::views;
use crate::win::{self, Rect};

const BOX: (f64, f64) = (96.0, 72.0); // (CSS px)
const TICK: Duration = Duration::from_millis(16);
// caught a moment before it gets there (the hand comes up to meet it)
const CATCH_AT: f64 = 0.92;

/// The path: an arc up and over (a miss carries on past the catch and glides down).
#[derive(Clone, Copy, Debug)]
struct Path {
    from: (f64, f64),
    end: (f64, f64),
    ms: f64,
    lift: f64,
    s: f64, // the screen's scale (the arc's sizes are CSS px)
}

impl Path {
    fn new(from: (f64, f64), to: (f64, f64), miss: bool, s: f64) -> Path {
        let end = if miss { (to.0 + (to.0 - from.0) * 0.35, to.1 + 110.0 * s) } else { to };
        let dist = (end.0 - from.0).hypot(end.1 - from.1) / s;
        let ms = (dist / 420.0 * 1000.0).clamp(1100.0, 3200.0);
        let lift = (60.0 + dist * 0.22).min(200.0) * s;
        Path { from, end, ms, lift, s }
    }

    /// Where it is, u of the way along.
    fn at(&self, u: f64) -> (f64, f64) {
        let (f, e) = (self.from, self.end);
        // (and a little wobble)
        (f.0 + (e.0 - f.0) * u, f.1 + (e.1 - f.1) * u - 4.0 * self.lift * u * (1.0 - u) + (u * PI * 3.0).sin() * 6.0 * self.s)
    }

    /// Which way it's heading there (radians, screen y down).
    fn angle(&self, u: f64) -> f64 {
        let (p, q) = (self.at(u), self.at((u + 0.02).min(1.0)));
        (q.1 - p.1).atan2(q.0 - p.0)
    }

    fn flip(&self) -> bool {
        self.end.0 < self.from.0
    }
}

/// Fly from one point to another (screen, physical px); on_land runs when it's caught.
pub fn fly(app: &AppHandle, from: (f64, f64), to: (f64, f64), on_land: Option<Done>) {
    fly_with(app, from, to, false, on_land);
}

/// The same, and maybe a miss: it overshoots and lands on your desktop (on_land then runs
/// as it lies there).
pub fn fly_with(app: &AppHandle, from: (f64, f64), to: (f64, f64), miss: bool, on_land: Option<Done>) {
    let app = app.clone();
    // (its own thread: making the window waits on the main thread, and the flight's a loop)
    thread::spawn(move || flight(&app, from, to, miss, on_land));
}

fn flight(app: &AppHandle, from: (f64, f64), to: (f64, f64), miss: bool, mut on_land: Option<Done>) {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let label = format!("plane-{}", COUNT.fetch_add(1, Ordering::Relaxed) + 1);
    let s = win::monitor_near(from.0 as i32, from.1 as i32).scale;
    let (bw, bh) = ((BOX.0 * s).round() as i32, (BOX.1 * s).round() as i32);
    let rect_at = |p: (f64, f64)| Rect { x: (p.0 - bw as f64 / 2.0).round() as i32, y: (p.1 - bh as f64 / 2.0).round() as i32, w: bw, h: bh };
    let (loaded, wait) = mpsc::channel();
    let built = views::builder(app, &label, "plane", &[])
        .title("Paper plane")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .focusable(false)
        .inner_size(BOX.0, BOX.1)
        .on_page_load(move |_, p| {
            if let PageLoadEvent::Finished = p.event() {
                let _ = loaded.send(());
            }
        })
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            // no plane, but the message still gets there
            eprintln!("[planes] couldn't open {label}: {err}");
            if let Some(f) = on_land {
                f(app);
            }
            return;
        }
    };
    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let _ = window.set_ignore_cursor_events(true);
    if hwnd != 0 {
        win::set_bounds(hwnd, rect_at(from));
    }
    // it sets off once its page is there (ready-to-show)
    let _ = wait.recv_timeout(Duration::from_secs(3));
    let path = Path::new(from, to, miss, s);
    let t0 = Instant::now();
    let pose = |payload| {
        let _ = app.emit_to(label.as_str(), "plane:pose", payload);
    };
    for frame in 0u64.. {
        let u = (t0.elapsed().as_secs_f64() * 1000.0 / path.ms).min(1.0);
        if hwnd != 0 {
            win::set_bounds(hwnd, rect_at(path.at(u)));
            // (above the robots' windows: one that wakes up mid-flight comes to the front)
            if frame.is_multiple_of(16) {
                walkers::top_most(hwnd);
            }
        }
        pose(json!({ "angle": path.angle(u), "flip": path.flip(), "u": u }));
        if !miss
            && u >= CATCH_AT
            && let Some(f) = on_land.take()
        {
            f(app);
        }
        if u >= 1.0 {
            break;
        }
        thread::sleep(TICK);
    }
    if miss {
        // a miss: it lies there a moment, then fades
        pose(json!({ "angle": 0, "flip": path.flip(), "u": 1, "landed": true }));
        if let Some(f) = on_land.take() {
            f(app);
        }
        thread::sleep(Duration::from_millis(2600));
        pose(json!({ "fade": true }));
        thread::sleep(Duration::from_millis(700));
    } else {
        thread::sleep(Duration::from_millis(120));
    }
    let _ = window.close();
}

pub fn setup(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_flies_from_the_hand_to_the_catch() {
        let p = Path::new((100.0, 500.0), (900.0, 480.0), false, 1.0);
        assert_eq!(p.at(0.0), (100.0, 500.0));
        let end = p.at(1.0);
        assert!((end.0 - 900.0).abs() < 1e-9 && (end.1 - 480.0).abs() < 1e-6);
        // up and over: the middle is well above both ends
        assert!(p.at(0.5).1 < 480.0 - 100.0);
        assert!(!p.flip());
    }

    #[test]
    fn its_time_and_lift_are_kept_in_bounds() {
        let near = Path::new((0.0, 0.0), (50.0, 0.0), false, 1.0);
        assert_eq!(near.ms, 1100.0);
        assert!((near.lift - 71.0).abs() < 1e-9);
        let far = Path::new((0.0, 0.0), (5000.0, 0.0), false, 1.0);
        assert_eq!(far.ms, 3200.0);
        assert_eq!(far.lift, 200.0);
        // on a 150% screen it's the same flight in CSS px
        let scaled = Path::new((0.0, 0.0), (1260.0, 0.0), false, 1.5);
        assert!((scaled.ms - 2000.0).abs() < 1e-9);
    }

    #[test]
    fn a_miss_overshoots_and_lands_lower() {
        let p = Path::new((1000.0, 500.0), (600.0, 500.0), true, 1.0);
        assert_eq!(p.end, (460.0, 610.0));
        assert!(p.flip());
        // heading left, it's mirrored: the angle points left-ish at the start
        assert!(p.angle(0.0).cos() < 0.0);
    }
}
