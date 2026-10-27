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

mod commands;
mod errands;

pub use commands::*;
pub use errands::*;

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::{input, window};
use crate::platform::window::Rect;
use crate::robots;
use crate::robots::{maid, social};
use crate::runtime::with;
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
const PAUSES_AWAKE: [(&str, f64, f64); 4] = [("stand", 1.5, 3.5), ("look", 2.5, 4.0), ("wave", 1.6, 2.2), ("sit", 5.0, 9.0)];
const PAUSES_ASLEEP: [(&str, f64, f64); 2] = [("stand", 2.5, 5.0), ("sit", 6.0, 11.0)];
// a stroll lasts this long (s), then it walks back to its desk by itself (put down
// somewhere else, it gets a fresh stroll from there)
const ROAM: (f64, f64) = (120.0, 240.0);
const BACK_LINES: [&str; 4] = ["Back to work! 💼", "Break over!", "Better get back to my desk…", "OK, back to it! 💻"];
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
        Errand { gait: None, speed_k: 1.0, face: None, on_arrive: None }
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
    k: f64,         // its size (1: normal)
    s: f64,         // its screen's scale
    bw: i32,        // the box (physical px)
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
    match app.try_state::<Mutex<Walkers>>() {
        Some(state) => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard.map)
        }
        None => f(&mut HashMap::new()),
    }
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
    size_k(&with(app, |st| st.store.get(id).and_then(|c| c["size"].as_str().map(str::to_string))).unwrap_or_default())
}

/// What a walker needs to look like its robot (main.js walkerLook).
fn look_of(c: &Value) -> Value {
    json!({ "name": c["name"], "color": c["color"], "body": c["body"], "kit": c["kit"], "accessory": c["accessory"], "theme": c["theme"], "size": c["size"] })
}

fn desk_of(app: &AppHandle, id: &str) -> Option<Desk> {
    let hwnd = robots::hwnd_of(app, id)?;
    Some(Desk { rect: window::window_rect(hwnd), s: window::scale_of(hwnd) })
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
    cx > desk.x as f64 - pad && cx < desk.right() as f64 + pad && cy > desk.y as f64 - pad && cy < desk.bottom() as f64 + pad
}

fn clamp_into(x: f64, y: f64, bw: i32, bh: i32, wa: Rect) -> (f64, f64) {
    (x.max(wa.x as f64).min((wa.right() - bw) as f64), y.max(wa.y as f64).min((wa.bottom() - bh) as f64))
}

// ---------------------------------------------------------------- one walker

impl Walker {
    fn rect(&self) -> Rect {
        Rect { x: self.x.round() as i32, y: self.y.round() as i32, w: self.bw, h: self.bh }
    }

    fn feet(&self) -> (f64, f64) {
        (self.x + self.bw as f64 / 2.0, self.y + self.bh as f64 * FEET)
    }

    fn place(&self, fx: &mut Vec<Fx>) {
        fx.push(Fx::Place(self.hwnd, self.rect()));
    }

    fn send(&self, fx: &mut Vec<Fx>, channel: &'static str, payload: Value) {
        fx.push(Fx::Emit(self.label.clone(), channel, payload));
    }

    fn set_gait(&mut self, gait: &str, heading: Option<&str>, fx: &mut Vec<Fx>) {
        let heading = heading.map(str::to_string).unwrap_or_else(|| self.heading.clone());
        if gait == self.gait && heading == self.heading {
            return;
        }
        self.gait = gait.to_string();
        self.heading = heading;
        let speed = if self.asleep { 0.6 } else { 1.0 };
        let msg = json!({ "gait": self.gait, "heading": self.heading, "asleep": self.asleep, "speed": speed });
        self.send(fx, "walker:state", msg);
    }

    fn set_through(&mut self, through: bool, fx: &mut Vec<Fx>) {
        if self.through == Some(through) {
            return;
        }
        self.through = Some(through);
        self.forwarded = None;
        fx.push(Fx::Through(self.label.clone(), through));
    }

    /// Where it may roam: the screen its desk is on (a visitor: the one it's on).
    fn area(&self, desk: Option<&Desk>) -> Rect {
        let at = match desk {
            Some(d) => (d.rect.x + d.rect.w / 2, d.rect.y + d.rect.h / 2),
            None => (self.x as i32, self.y as i32),
        };
        window::monitor_near(at.0, at.1).work
    }

    /// Somewhere else on the screen, not too close.
    fn new_target(&mut self, desk: Option<&Desk>) {
        let wa = self.area(desk);
        for i in 0..8 {
            let tx = rand_in(wa.x as f64, (wa.right() - self.bw) as f64);
            let ty = rand_in(wa.y as f64, (wa.bottom() - self.bh) as f64);
            if (tx - self.x).hypot(ty - self.y) > 220.0 * self.s || i == 7 {
                self.target = (tx, ty);
                return;
            }
        }
    }

    /// An errand: walk to where its feet should be (screen px), then on_arrive.
    fn errand_to(&mut self, feet: (f64, f64), errand: Errand) {
        self.target = (feet.0 - self.bw as f64 / 2.0, feet.1 - self.bh as f64 * FEET);
        self.errand = Some(errand);
        self.pause = Pause::No;
    }

    /// Where its feet go back to at its desk (where it stood up).
    fn home_feet(&self, desk: Option<&Desk>) -> Option<(f64, f64)> {
        let d = desk?;
        let (fx, fy) = match self.home {
            Some((x, y)) => (x * d.s, y * d.s),
            None => (d.rect.w as f64 * 0.55, d.rect.h as f64 * 0.85),
        };
        Some((d.rect.x as f64 + fx, d.rect.y as f64 + fy))
    }

    fn stop_here(&mut self) {
        self.target = (self.x, self.y);
    }
}

fn say_fx(w: &Walker, fx: &mut Vec<Fx>, text: &str, ms: u64) {
    w.send(fx, "walker:say", json!({ "text": text, "ms": ms }));
}

fn dock_errand(id: &str) -> Errand {
    let id = id.to_string();
    Errand { on_arrive: Some(Box::new(move |app: &AppHandle| dock(app, &id))), ..Errand::default() }
}

/// One step along its route (main walker.js step).
fn step(id: &str, w: &mut Walker, now: Instant, desk: Option<&Desk>, fx: &mut Vec<Fx>) {
    if w.held.is_some() {
        return;
    }
    // the stroll's over: it heads back to its desk (not while on an errand or standing for one)
    if w.roam_until.is_some_and(|t| now > t) && w.errand.is_none() && w.pause != Pause::Forever {
        w.roam_until = None;
        if let Some(feet) = w.home_feet(desk) {
            if !w.asleep {
                say_fx(w, fx, pick(&BACK_LINES).copied().unwrap_or(""), 2200);
            }
            w.errand_to(feet, dock_errand(id));
        }
    }
    match w.pause {
        Pause::Forever => return,
        Pause::Until(t) if now < t => return,
        Pause::Until(_) => {
            w.pause = Pause::No;
            w.new_target(desk);
        }
        Pause::No => {}
    }
    let (dx, dy) = (w.target.0 - w.x, w.target.1 - w.y);
    let dist = dx.hypot(dy);
    let speed = if w.asleep { SPEED_SLEEPWALK } else { SPEED_WALK } * w.k * w.s * w.errand.as_ref().map_or(1.0, |e| e.speed_k);
    let move_by = speed * TICK.as_secs_f64();
    if dist <= move_by {
        w.x = w.target.0;
        w.y = w.target.1;
        w.place(fx);
        if let Some(e) = w.errand.take() {
            // there on an errand: it stands (facing where it was told) till it's sent on
            w.pause = Pause::Forever;
            w.set_gait("stand", Some(e.face.as_deref().unwrap_or("toward")), fx);
            if let Some(f) = e.on_arrive {
                fx.push(Fx::Run(f));
            }
            return;
        }
        // there: stop for a bit, doing something
        let pauses: &[(&str, f64, f64)] = if w.asleep { &PAUSES_ASLEEP } else { &PAUSES_AWAKE };
        let (gait, a, b) = pick(pauses).copied().unwrap_or(("stand", 2.0, 3.0));
        let heading = if gait == "stand" || gait == "sit" { Some("toward") } else { None };
        w.set_gait(gait, heading, fx);
        w.pause = Pause::Until(now + Duration::from_secs_f64(rand_in(a, b)));
        return;
    }
    w.x += dx / dist * move_by;
    w.y += dy / dist * move_by;
    let gait = w.errand.as_ref().and_then(|e| e.gait.clone()).unwrap_or_else(|| if w.asleep { "sleepwalk" } else { "walk" }.into());
    w.set_gait(&gait, Some(heading_to(dx, dy)), fx);
    w.place(fx);
}

/// Shown, and the desk lets go of its own, in the same moment.
fn take_over(id: &str, w: &mut Walker, fx: &mut Vec<Fx>) {
    if w.shown {
        return;
    }
    w.shown = true;
    w.handoff_at = None;
    w.cancel_at = None;
    w.place(fx);
    fx.push(Fx::Show(w.hwnd));
    fx.push(Fx::TopMost(w.hwnd));
    fx.push(Fx::Robot(id.to_string(), "handoff".into()));
}

fn run(app: &AppHandle, fx: Vec<Fx>) {
    for f in fx {
        match f {
            Fx::Place(hwnd, r) => window::set_bounds(hwnd, r),
            Fx::Emit(label, channel, payload) => {
                let _ = app.emit_to(label, channel, payload);
            }
            Fx::Robot(id, action) => {
                let _ = app.emit_to(robots::label_of(&id), "robot:action", action);
            }
            Fx::Through(label, through) => {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_ignore_cursor_events(through);
                }
            }
            Fx::Show(hwnd) => veil(app, hwnd, false),
            Fx::TopMost(hwnd) => window::set_topmost(hwnd),
            Fx::Run(f) => f(app),
            Fx::Close(id) => close(app, &id),
        }
    }
}

/// Do something to one walker (if it's out), then carry out what it came to.
fn with_walker(app: &AppHandle, id: &str, f: impl FnOnce(&mut Walker, &mut Vec<Fx>)) -> bool {
    let mut fx = vec![];
    let found = ws(app, |m| m.get_mut(id).map(|w| f(w, &mut fx)).is_some());
    run(app, fx);
    found
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
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        x = std::collections::hash_map::RandomState::new().build_hasher().finish() ^ nanos | 1;
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

// ---------------------------------------------------------------- setting off

/// It's getting up to leave: the walker window is made now, hidden, so it's loaded and drawn
/// by the time the character has stood up and turned (go()). A visitor with no desk:
/// `at` is where its feet start, `k` its size.
fn prepare(app: &AppHandle, id: &str, asleep: bool, at: Option<(f64, f64)>, k: Option<f64>) -> bool {
    // (one at a time: wander-prep and wander can come close together)
    static BUILD: Mutex<()> = Mutex::new(());
    let _one = BUILD.lock().unwrap_or_else(|e| e.into_inner());
    if has(app, id) {
        return true;
    }
    let desk = desk_of(app, id);
    let feet = match (at, desk) {
        (Some(p), _) => p,
        (None, Some(d)) => (d.rect.x as f64 + d.rect.w as f64 * 0.55, d.rect.y as f64 + d.rect.h as f64 * 0.85), // (roughly; go() puts it exactly)
        (None, None) => return false,
    };
    let k = k.unwrap_or_else(|| size_of(app, id));
    let s = window::monitor_near(feet.0 as i32, feet.1 as i32).scale;
    let css = ((BOX.0 * k).round(), (BOX.1 * k).round());
    let (bw, bh) = ((css.0 * s).round() as i32, (css.1 * s).round() as i32);
    let (x, y) = (feet.0 - bw as f64 / 2.0, feet.1 - bh as f64 * FEET);
    let label = label_of(id);
    if app.get_webview_window(&label).is_some() {
        return false; // (the last one's still closing)
    }
    let name = with(app, |st| st.store.get(id).and_then(|c| c["name"].as_str().map(str::to_string))).unwrap_or_else(|| "C-Bot".into());
    let built = views::builder(app, &label, "walker", &[("id", id)])
        .title(format!("{name} (out for a walk)"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .focusable(false) // (a click on it never takes the focus from the app you're in)
        .inner_size(css.0, css.1)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[walkers] couldn't open {label}: {err}");
            return false;
        }
    };
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => {
            let _ = window.close();
            return false;
        }
    };
    veil(app, hwnd, true);
    window::set_bounds(hwnd, Rect { x: x.round() as i32, y: y.round() as i32, w: bw, h: bh });
    let (app2, id2) = (app.clone(), id.to_string());
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            ws(&app2, |m| {
                if m.get(&id2).is_some_and(|w| w.hwnd == hwnd) {
                    m.remove(&id2);
                }
            });
        }
    });
    let gait = if asleep { "sleepwalk" } else { "walk" };
    let w = Walker {
        hwnd, label, k, s, bw, bh, x, y, asleep,
        gait: gait.into(), heading: "right".into(), // (it sets off walking right, as it turned at the desk)
        target: (x, y), pause: Pause::No, held: None, errand: None, roam_until: None, home: None,
        going: false, ready: false, shown: false, docking: None, npc: false, look: None,
        through: None, over: false, cancel_at: Some(Instant::now() + CANCEL_WAIT), handoff_at: None, forwarded: None, eyes: None,
    };
    ws(app, |m| m.insert(id.to_string(), w));
    tray::refresh(app);
    true
}

/// Stood up and turned at the desk, feet on `feet` (desk-window CSS px): put the walker's
/// feet on that very spot and take over as soon as it's drawn (at once, if it already is).
/// An errand: where to (screen px) and how.
fn go(app: &AppHandle, id: &str, asleep: bool, feet: Option<(f64, f64)>, errand: Option<(Option<(f64, f64)>, Errand)>) -> bool {
    if !has(app, id) && !prepare(app, id, asleep, None, None) {
        return false;
    }
    let desk = desk_of(app, id);
    let now = Instant::now();
    with_walker(app, id, |w, fx| {
        if let (Some(f), Some(d)) = (feet, desk) {
            w.x = d.rect.x as f64 + f.0 * d.s - w.bw as f64 / 2.0;
            w.y = d.rect.y as f64 + f.1 * d.s - w.bh as f64 * FEET;
            w.home = Some(f);
            w.place(fx);
        }
        w.going = true;
        let wa = w.area(desk.as_ref());
        w.target = (
            (w.x + rand_in(260.0, 520.0) * w.k * w.s).min((wa.right() - w.bw) as f64),
            (w.y + rand_in(-60.0, 60.0) * w.s).max(wa.y as f64).min((wa.bottom() - w.bh) as f64),
        );
        let on_errand = errand.is_some();
        if let Some((Some(to), e)) = errand {
            w.errand_to(to, e);
        }
        // (an errand's own code sends it home)
        w.roam_until = if on_errand { None } else { Some(now + Duration::from_secs_f64(rand_in(ROAM.0, ROAM.1))) };
        if w.ready {
            take_over(id, w, fx);
        } else {
            w.handoff_at = Some(now + HANDOFF_WAIT);
        }
    })
}

/// A visitor that isn't one of your robots (the evening housemaid, maid.rs): it has no desk,
/// comes in with its feet at `from` (screen px), looks like `look` (a character's look),
/// can't be picked up (a click goes to maid.rs), and only goes where it's sent (walk_to).
pub fn arrive(app: &AppHandle, id: &str, from: (f64, f64), look: Value, k: f64) -> bool {
    if has(app, id) {
        return true;
    }
    if !prepare(app, id, false, Some(from), Some(k)) {
        return false;
    }
    let now = Instant::now();
    with_walker(app, id, |w, fx| {
        w.cancel_at = None;
        w.npc = true;
        w.look = Some(look);
        w.going = true;
        w.pause = Pause::Forever; // (standing, till it's sent somewhere)
        w.stop_here();
        if w.ready {
            take_over(id, w, fx);
        } else {
            w.handoff_at = Some(now + HANDOFF_WAIT);
        }
    })
}

// ---------------------------------------------------------------- the clock

/// Every TICK: walkers move along; ones that never set off, never took over or never heard
/// back from their desk are dealt with.
fn tick(app: &AppHandle, now: Instant) {
    let ids: Vec<String> = ws(app, |m| m.keys().cloned().collect());
    let desks: HashMap<String, Option<Desk>> = ids.iter().map(|id| (id.clone(), desk_of(app, id))).collect();
    let mut fx = vec![];
    ws(app, |m| {
        for (id, w) in m.iter_mut() {
            if let Some(t) = w.docking {
                if now >= t {
                    fx.push(Fx::Close(id.clone())); // (the desk never said it has it back)
                }
                continue;
            }
            if !w.going {
                if w.cancel_at.is_some_and(|t| now >= t) {
                    fx.push(Fx::Close(id.clone())); // (the desk never said go)
                }
                continue;
            }
            if !w.shown {
                if w.handoff_at.is_some_and(|t| now >= t) {
                    take_over(id, w, &mut fx); // (the page never said it's ready)
                }
                continue;
            }
            step(id, w, now, desks.get(id).copied().flatten().as_ref(), &mut fx);
        }
    });
    run(app, fx);
}

/// (The screens changing, a sleep and an unlock are noticed by robots/screens.rs, which calls
/// recover.)
fn clock(app: AppHandle) {
    let mut checked = Instant::now();
    loop {
        let out = ws(&app, |m| !m.is_empty());
        thread::sleep(if out { TICK } else { Duration::from_millis(250) });
        let now = Instant::now();
        if now.duration_since(checked) >= Duration::from_secs(1) {
            checked = now;
            input::idle_secs(); // (keeps the away-from-the-PC clock accurate)
            // Above the robots' windows (main.js keepOnTop): a robot that wakes up comes to the
            // front, and its window, see-through as it is, would hide a walker behind it.
            for hwnd in ws(&app, |m| m.values().filter(|w| w.shown).map(|w| w.hwnd).collect::<Vec<_>>()) {
                window::set_topmost(hwnd);
                if window::is_veiled(hwnd) {
                    veil(&app, hwnd, false); // (out: it's seen, whatever became of the first unveiling)
                }
            }
        }
        if out {
            tick(&app, now);
        }
    }
}

// ---------------------------------------------------------------- the pages

fn errand_from(id: &str, v: &Value) -> (Option<(f64, f64)>, Errand) {
    let to = v["to"]["x"].as_f64().zip(v["to"]["y"].as_f64());
    let who = id.to_string();
    let errand = Errand {
        gait: v["gait"].as_str().map(str::to_string),
        speed_k: v["speedK"].as_f64().unwrap_or(1.0),
        face: v["face"].as_str().map(str::to_string),
        on_arrive: Some(Box::new(move |app: &AppHandle| social::errand_arrived(app, &who))),
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
        assert!(over_character(0.0, 0.0, bw, bh, 1.0, (feet.0, feet.1 - 100.0)));
        assert!(!over_character(0.0, 0.0, bw, bh, 1.0, (feet.0 + 60.0, feet.1 - 100.0)));
        assert!(!over_character(0.0, 0.0, bw, bh, 1.0, (feet.0, 20.0)));
        // twice as big: twice as wide a catch
        assert!(over_character(0.0, 0.0, bw * 2.0, bh * 2.0, 2.0, (bw + 90.0, bh * 2.0 * FEET - 10.0)));
    }

    #[test]
    fn dropped_near_its_desk_docks() {
        let desk = Rect { x: 1000, y: 600, w: 300, h: 290 };
        // its middle over the desk
        assert!(over_desk(1050.0, 600.0, 190.0, 250.0, desk, 24.0));
        // just off the edge, inside the pad
        assert!(over_desk(1300.0 - 95.0 + 20.0, 600.0, 190.0, 250.0, desk, 24.0));
        assert!(!over_desk(500.0, 600.0, 190.0, 250.0, desk, 24.0));
    }

    #[test]
    fn kept_on_the_screen() {
        let wa = Rect { x: 0, y: 0, w: 1920, h: 1040 };
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
