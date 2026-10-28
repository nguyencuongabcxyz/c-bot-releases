//! Robots out for a walk round the screen (main walker.js, and main.js robot:wander*,
//! robot:walker): while a robot's desk stands empty, it walks in a small see-through window
//! of its own (label "walker-<id>"); you can pick it up and carry it back. [wave 1: desktop]
//!
//! The walk happens here (the window is moved along its route, every TICK); the page
//! (renderer/walker, office3d's solo mode) only animates the character. Besides wandering
//! at random a walker can run an errand (social.rs's visits, maid.rs's round): walk_to /
//! go_home walk it to a spot and call on_arrive; it stands there (pose / say) till it's sent
//! on. A visitor with no desk (the evening housemaid) comes in with arrive().
//!
//! Positions are physical px, as in robots/mod.rs; what the page gets is in its CSS px. Like
//! robots/mod.rs, nothing here calls into a window while holding a lock: the work is worked out
//! under the lock as a list of effects (Fx), which are carried out after.
//!
//! Also here, as the desktop-life modules share them: random numbers, timers, and how long
//! you've been away from the mouse and keyboard.

mod clock;
mod commands;
mod errands;
mod setting_off;
mod walk;

use clock::*;
pub use commands::*;
pub use errands::*;
pub use setting_off::*;
use walk::*;

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::window::Rect;
use crate::platform::{input, window};
use crate::robots;
use crate::robots::{maid, social};
use crate::runtime::{Locked, part_or_default, with};
use crate::ui::{tray, views};

// The walker box at size 1 (CSS px): the page draws the character as big as at its desk,
// feet FEET of the way down (office3d walker3d SOLO.feet). Room for every pose: up to ~215 px
// above its feet (a raised hand, sleepwalking z's), ~90 px either side (swinging as it's
// carried). The empty part of the box lets clicks through.
const BOX: (f64, f64) = (190.0, 250.0);
const FEET: f64 = 0.9;
// the part of the box that's the character (around its feet and up its body), at size 1:
// the mouse there is caught (to pick it up), anywhere else in the box it goes through
const HIT_HALF_W: f64 = 50.0;
const HIT_UP: f64 = 190.0;
const HIT_DOWN: f64 = 22.0;
const TICK: Duration = Duration::from_millis(33);
const SPEED_WALK: f64 = 70.0; // px/s at size 1
const SPEED_SLEEPWALK: f64 = 32.0;
// what it does when it gets somewhere: (gait, min s, max s)
const PAUSES_AWAKE: [(&str, f64, f64); 4] = [
    ("stand", 1.5, 3.5),
    ("look", 2.5, 4.0),
    ("wave", 1.6, 2.2),
    ("sit", 5.0, 9.0),
];
const PAUSES_ASLEEP: [(&str, f64, f64); 2] = [("stand", 2.5, 5.0), ("sit", 6.0, 11.0)];
// a stroll lasts this long (s), then it walks back to its desk by itself (put down
// somewhere else, it gets a fresh stroll from there)
const ROAM: (f64, f64) = (120.0, 240.0);
const BACK_LINES: [&str; 4] = [
    "Back to work! 💼",
    "Break over!",
    "Better get back to my desk…",
    "OK, back to it! 💻",
];
// the page never said it's drawn: take over anyway; the desk never said go: give up
const HANDOFF_WAIT: Duration = Duration::from_secs(3);
const CANCEL_WAIT: Duration = Duration::from_secs(6);
const DOCK_WAIT: Duration = Duration::from_millis(800);

/// Something to do once a walker gets somewhere (or a timer goes off).
pub type Done = Box<dyn FnOnce(&AppHandle) + Send>;

/// A walk to somewhere (walk_to): how it walks there, which way it faces once there, and
/// what then.
pub struct Errand {
    pub gait: Option<String>,
    pub speed_k: f64,
    pub face: Option<String>,
    pub on_arrive: Option<Done>,
}

impl Default for Errand {
    fn default() -> Self {
        Errand {
            gait: None,
            speed_k: 1.0,
            face: None,
            on_arrive: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Pause {
    No,
    Until(Instant),
    Forever, // standing (on an errand, or a visitor) till it's sent somewhere
}

struct Walker {
    hwnd: isize,
    label: String,
    k: f64,  // its size (1: normal)
    s: f64,  // its screen's scale
    bw: i32, // the box (physical px)
    bh: i32,
    x: f64, // the box's top left (physical px)
    y: f64,
    asleep: bool,
    gait: String,
    heading: String,
    target: (f64, f64),
    pause: Pause,
    held: Option<(f64, f64)>, // carried: where it was picked up
    errand: Option<Errand>,
    roam_until: Option<Instant>,
    home: Option<(f64, f64)>, // where its feet were at the desk (desk-window CSS px)
    going: bool,              // the desk said go
    ready: bool,              // its page has drawn it
    shown: bool,              // it has taken over from the desk
    docking: Option<Instant>, // back at the desk: closes by then if the desk never says so
    npc: bool,                // a visitor (no desk, can't be carried)
    look: Option<Value>,
    through: Option<bool>, // clicks pass through
    over: bool,            // carried over its desk
    cancel_at: Option<Instant>,
    handoff_at: Option<Instant>,
    forwarded: Option<(i32, i32)>,
    eyes: Option<(i32, i32)>,
}

/// The robot's desk window: where it is, and its scale.
#[derive(Clone, Copy)]
struct Desk {
    rect: Rect,
    s: f64,
}

/// What a change works out to, done once the lock is let go.
enum Fx {
    Place(isize, Rect),
    Emit(String, &'static str, Value),
    Robot(String, String), // robot:action to a robot's desk
    Through(String, bool),
    Show(isize),
    TopMost(isize),
    Run(Done),
    Close(String),
}

#[derive(Default)]
struct Walkers {
    map: HashMap<String, Walker>,
}

fn ws<R>(app: &AppHandle, f: impl FnOnce(&mut HashMap<String, Walker>) -> R) -> R {
    part_or_default(app, |w: &mut Walkers| f(&mut w.map))
}

pub fn label_of(id: &str) -> String {
    format!("walker-{id}")
}

fn size_k(size: &str) -> f64 {
    match size {
        "small" => 0.7,
        "large" => 1.35,
        "huge" => 1.7,
        _ => 1.0,
    }
}

/// A robot's size factor (the Workshop's "Size").
pub fn size_of(app: &AppHandle, id: &str) -> f64 {
    size_k(
        &with(app, |st| {
            st.store
                .get(id)
                .and_then(|c| c["size"].as_str().map(str::to_string))
        })
        .unwrap_or_default(),
    )
}

/// What a walker needs to look like its robot (main.js walkerLook).
fn look_of(c: &Value) -> Value {
    json!({ "name": c["name"], "color": c["color"], "body": c["body"], "kit": c["kit"], "accessory": c["accessory"], "theme": c["theme"], "size": c["size"] })
}

fn desk_of(app: &AppHandle, id: &str) -> Option<Desk> {
    let hwnd = robots::hwnd_of(app, id)?;
    Some(Desk {
        rect: window::window_rect(hwnd),
        s: window::scale_of(hwnd),
    })
}

// ---------------------------------------------------------------- the pure parts

/// Which way it faces, walking that way.
fn heading_to(dx: f64, dy: f64) -> &'static str {
    if dx.abs() >= dy.abs() * 0.6 {
        if dx < 0.0 { "left" } else { "right" }
    } else if dy < 0.0 {
        "away"
    } else {
        "toward"
    }
}

/// Is the point over the character (not the empty part of its box)? ks: size × scale.
fn over_character(x: f64, y: f64, bw: f64, bh: f64, ks: f64, p: (f64, f64)) -> bool {
    let (fx, fy) = (x + bw / 2.0, y + bh * FEET);
    (p.0 - fx).abs() < HIT_HALF_W * ks && p.1 > fy - HIT_UP * ks && p.1 < fy + HIT_DOWN * ks
}

/// Dropped on its desk (its middle over the desk window, give or take `pad`)?
fn over_desk(x: f64, y: f64, bw: f64, bh: f64, desk: Rect, pad: f64) -> bool {
    let (cx, cy) = (x + bw / 2.0, y + bh * 0.6);
    cx > desk.x as f64 - pad
        && cx < desk.right() as f64 + pad
        && cy > desk.y as f64 - pad
        && cy < desk.bottom() as f64 + pad
}

fn clamp_into(x: f64, y: f64, bw: i32, bh: i32, wa: Rect) -> (f64, f64) {
    (
        x.max(wa.x as f64).min((wa.right() - bw) as f64),
        y.max(wa.y as f64).min((wa.bottom() - bh) as f64),
    )
}

// ---------------------------------------------------------------- the window, veiled

/// Hidden, or shown, without hiding the window itself: an empty window region draws nothing
/// and takes no clicks. (Showing a hidden window would take the focus from the app you're
/// in, and tao hides it again on its next style change; the page keeps drawing either way,
/// so it's ready the moment the desk lets go.)
/// (Done on the window's own thread, after whatever tao still has queued for it: set from
/// another thread while the window was still being set up, a region could come back.)
pub fn veil(app: &AppHandle, hwnd: isize, hidden: bool) {
    let _ = app.run_on_main_thread(move || window::set_veiled(hwnd, hidden));
}

// ---------------------------------------------------------------- small shared helpers

/// A random number in [0, 1) (xorshift; good enough for odds and wanderings).
pub fn random() -> f64 {
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut x = STATE.load(Ordering::Relaxed);
    if x == 0 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        x = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
            ^ nanos
            | 1;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    STATE.store(x, Ordering::Relaxed);
    (x >> 11) as f64 / (1u64 << 53) as f64
}

pub fn rand_in(a: f64, b: f64) -> f64 {
    a + random() * (b - a)
}

/// One of them, at random.
pub fn pick<T>(items: &[T]) -> Option<&T> {
    if items.is_empty() {
        return None;
    }
    items.get(((random() * items.len() as f64) as usize).min(items.len() - 1))
}

/// Do this in `ms` (on a thread of its own: setTimeout).
pub fn after(app: &AppHandle, ms: u64, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(ms));
        f(&app);
    });
}

// ---------------------------------------------------------------- the pages

fn errand_from(id: &str, v: &Value) -> (Option<(f64, f64)>, Errand) {
    let to = v["to"]["x"].as_f64().zip(v["to"]["y"].as_f64());
    let who = id.to_string();
    let errand = Errand {
        gait: v["gait"].as_str().map(str::to_string),
        speed_k: v["speedK"].as_f64().unwrap_or(1.0),
        face: v["face"].as_str().map(str::to_string),
        on_arrive: Some(Box::new(move |app: &AppHandle| {
            social::errand_arrived(app, &who)
        })),
    };
    (to, errand)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_follows_the_bigger_move() {
        assert_eq!(heading_to(10.0, 0.0), "right");
        assert_eq!(heading_to(-10.0, 5.0), "left");
        assert_eq!(heading_to(1.0, -10.0), "away");
        assert_eq!(heading_to(1.0, 10.0), "toward");
        // sideways wins down to 0.6 of the up-down
        assert_eq!(heading_to(6.0, 10.0), "right");
    }

    #[test]
    fn only_the_character_catches_the_mouse() {
        let (bw, bh) = (190.0, 250.0);
        let feet = (bw / 2.0, bh * FEET); // (225)
        assert!(over_character(
            0.0,
            0.0,
            bw,
            bh,
            1.0,
            (feet.0, feet.1 - 100.0)
        ));
        assert!(!over_character(
            0.0,
            0.0,
            bw,
            bh,
            1.0,
            (feet.0 + 60.0, feet.1 - 100.0)
        ));
        assert!(!over_character(0.0, 0.0, bw, bh, 1.0, (feet.0, 20.0)));
        // twice as big: twice as wide a catch
        assert!(over_character(
            0.0,
            0.0,
            bw * 2.0,
            bh * 2.0,
            2.0,
            (bw + 90.0, bh * 2.0 * FEET - 10.0)
        ));
    }

    #[test]
    fn dropped_near_its_desk_docks() {
        let desk = Rect {
            x: 1000,
            y: 600,
            w: 300,
            h: 290,
        };
        // its middle over the desk
        assert!(over_desk(1050.0, 600.0, 190.0, 250.0, desk, 24.0));
        // just off the edge, inside the pad
        assert!(over_desk(
            1300.0 - 95.0 + 20.0,
            600.0,
            190.0,
            250.0,
            desk,
            24.0
        ));
        assert!(!over_desk(500.0, 600.0, 190.0, 250.0, desk, 24.0));
    }

    #[test]
    fn kept_on_the_screen() {
        let wa = Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1040,
        };
        assert_eq!(clamp_into(-50.0, 2000.0, 190, 250, wa), (0.0, 790.0));
        assert_eq!(clamp_into(100.0, 100.0, 190, 250, wa), (100.0, 100.0));
    }

    #[test]
    fn random_numbers_stay_in_range() {
        for _ in 0..10_000 {
            let r = random();
            assert!((0.0..1.0).contains(&r));
            let v = rand_in(5.0, 9.0);
            assert!((5.0..9.0).contains(&v));
        }
        let items = [1, 2, 3];
        let mut seen = [false; 3];
        for _ in 0..200 {
            seen[*pick(&items).unwrap() - 1] = true;
        }
        assert_eq!(seen, [true; 3]);
        assert!(pick::<i32>(&[]).is_none());
    }
}
