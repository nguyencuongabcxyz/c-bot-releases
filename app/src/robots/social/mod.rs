//! The robots noticing each other (main social.js): waves, claps, visits to each other's
//! desks, lunch and milk-tea runs, paper planes. Every robot reports how it is
//! (social:report); this decides who does what and tells them (robot:social).
//! [wave 1: desktop]
//!
//!   wave        two idle robots on the same screen: one turns and waves, the other waves back
//!   clap        a robot finishes a task: the idle ones turn to it and clap
//!   yawn        a robot dozes off: idle neighbours yawn (and one idle a while dozes off sooner)
//!   dance       a vocab milestone: every free robot dances, not just the one that caught it
//!   visit       a bored robot walks over to another desk (walkers.rs errands) and chats (the
//!                 host awake and free), watches over its shoulder (the host at work), or
//!                 tiptoes over (the host asleep: leaves a "came by" sticky on its monitor)
//!   office life, at the right time of day, once a day each (workdays): a lunch order,
//!                 lunch out together, a milk-tea round desk to desk
//!   paper plane a bored robot throws one at another (planes.rs flies it): caught and read
//!                 out if the other's free, else it lands on its desk and is read later;
//!                 now and then one misses and lands on your desktop for a moment
//! None of it while you're using C-Bot (a card, the notebook, Quick actions, the group chat,
//! the housemaid's round), while you're away or Windows says you're busy. Your click, or
//! picking it up, sends a visitor home. Setting: socialising 'often' | 'sometimes' (the
//! default) | 'never'.
//!
//! Its timers (later) belong to the visit: a visit's over, or its timers cleared, and the
//! ones still to come do nothing (epoch). No lock is held while calling another module.

mod visits;

pub use visits::*;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use chrono::{Datelike, Local, Timelike};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::agents::personalities;
use crate::features::{notes, vocab};
use crate::features::chat::group;
use crate::platform::{input, presence, window};
use crate::robots;
use crate::robots::{maid, planes, walkers};
use crate::robots::walkers::{after, Errand, pick, random};
use crate::runtime::{hub, with};
use crate::workbench::quick;

const TICK: Duration = Duration::from_secs(6);
const FRESH: Duration = Duration::from_secs(20); // a robot's report is this old at most
const AWAY_AFTER: u64 = 120; // s without touching mouse or keyboard: you're not there
const WAVE_PAIR_GAP: Duration = Duration::from_secs(3 * 60);
const VISIT_ROBOT_GAP: Duration = Duration::from_secs(10 * 60);
const CLAP_GAP: Duration = Duration::from_secs(60);
const NEAR: f64 = 1500.0; // px between desks (at 100%), for a wave across the screen
const LINE_GAP: u64 = 2800; // ms between lines of a chat
const PLANE_ROBOT_GAP: Duration = Duration::from_secs(10 * 60);
const THROW_AT: u64 = 1000; // ms into its throw that the plane leaves its hand (antics/social)
// office life: when (minutes into the day)
const SCENE_ORDER: (u32, u32) = (630, 700);
const SCENE_GOOUT: (u32, u32) = (700, 750);
const SCENE_TEA: (u32, u32) = (840, 960);
const DELIVERY_FOOD: u64 = 8 * 60_000;
const DELIVERY_TEA: u64 = 6 * 60_000;
const WATCH_MAX: u64 = 45_000;

/// Between any two visits / planes, by how sociable they are.
fn visit_gap(level: &str) -> Duration {
    Duration::from_secs(if level == "often" { 2 * 60 } else { 4 * 60 })
}
fn plane_gap(level: &str) -> Duration {
    Duration::from_secs(if level == "often" { 90 } else { 3 * 60 })
}

/// How a robot last said it was.
#[derive(Clone, Default)]
struct Rep {
    v: Map<String, Value>,
    at: Option<Instant>,
}

impl Rep {
    fn b(&self, key: &str) -> bool {
        self.v.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
    fn idle_ms(&self) -> f64 {
        self.v.get("idleMs").and_then(Value::as_f64).unwrap_or(0.0)
    }
    /// (the Workshop's "Wanders off": only a plain no counts)
    fn wanders(&self) -> bool {
        self.v.get("wanders") != Some(&Value::Bool(false))
    }
}

/// A visit (or an office scene) going on: a, the visitor, at b's desk.
#[derive(Clone)]
struct Visit {
    a: String,
    b: String,
    mode: String, // chat | watch | tiptoe | order | goout | tea
    side: &'static str,
    face: String,
    face_b: Option<String>,
    phase: String, // out | walking | there | outing | sitting | home
    epoch: u64,
    delivery: Option<u64>,
    stops: Vec<String>,
    ordered: Vec<String>,
    arrived_at: Instant,
    spot_b: Option<(f64, f64)>,
    out: Option<HashSet<String>>,
    there: HashSet<String>,
}

#[derive(Default)]
struct Social {
    reports: HashMap<String, Rep>,
    last_wave: HashMap<String, Instant>,
    last_visit_of: HashMap<String, Instant>,
    last_clap: HashMap<String, Instant>,
    last_visit: Option<Instant>,
    last_plane_of: HashMap<String, Instant>,
    last_plane: Option<Instant>,
    in_flight: bool,
    desk_planes: HashMap<String, String>, // id -> who threw the plane on its desk (read later)
    lunch_day: String,                    // the day lunch / the milk-tea round last happened
    tea_day: String,
    visit: Option<Visit>,
}

fn soc<R>(app: &AppHandle, f: impl FnOnce(&mut Social) -> R) -> R {
    match app.try_state::<Mutex<Social>>() {
        Some(state) => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard)
        }
        None => f(&mut Social::default()),
    }
}

fn next_gen() -> u64 {
    static GEN: AtomicU64 = AtomicU64::new(1);
    GEN.fetch_add(1, Ordering::Relaxed)
}

fn visit(app: &AppHandle) -> Option<Visit> {
    soc(app, |s| s.visit.clone())
}

fn vset(app: &AppHandle, f: impl FnOnce(&mut Visit)) {
    soc(app, |s| s.visit.as_mut().map(f));
}

/// Do this in ms, if the visit's still on (and its timers weren't cleared).
fn later(app: &AppHandle, ms: u64, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let Some(epoch) = soc(app, |s| s.visit.as_ref().map(|v| v.epoch)) else { return };
    after(app, ms, move |app| {
        if soc(app, |s| s.visit.as_ref().is_some_and(|v| v.epoch == epoch)) {
            f(app);
        }
    });
}

/// The visit's timers still to come do nothing.
fn clear_timers(app: &AppHandle) {
    vset(app, |v| v.epoch = next_gen());
}

pub fn today() -> String {
    Local::now().format("%a %b %d %Y").to_string() // (as JS's toDateString: the Electron app's maidDay)
}

/// The days you work (the notes' workdays: 0 Sunday … 6 Saturday).
pub fn workdays(settings: &Value) -> Vec<u32> {
    settings["notesWorkdays"].as_array().map(|d| d.iter().filter_map(|x| x.as_u64().map(|x| x as u32)).collect()).unwrap_or_else(|| vec![1, 2, 3, 4, 5])
}

fn within(mins: u32, w: (u32, u32)) -> bool {
    mins >= w.0 && mins < w.1
}

// ---------------------------------------------------------------- what they know

fn level(app: &AppHandle) -> String {
    with(app, |st| st.store.settings()["socialising"].as_str().unwrap_or("sometimes").to_string())
}

fn kk(app: &AppHandle) -> f64 {
    if level(app) == "often" { 2.0 } else { 1.0 }
}

fn present() -> bool {
    input::idle_secs() < AWAY_AFTER && presence::accepts_notifications()
}

/// You're working with C-Bot: a card, the notebook, Quick actions, the group chat or the
/// housemaid's round.
fn app_busy(app: &AppHandle) -> bool {
    notes::notebook_open(app) || quick::is_open(app) || vocab::card_showing(app) || group::is_open(app) || maid::active(app)
}

fn tell(app: &AppHandle, id: &str, payload: Value) {
    hub::send_to_robot(app, id, "robot:social", payload);
}

fn name_of(app: &AppHandle, id: &str) -> String {
    with(app, |st| st.store.get(id).and_then(|c| c["name"].as_str().map(str::to_string))).unwrap_or_default()
}

/// One of the robot's lines of this kind, in its personality ({other}: the other's name).
pub fn line(app: &AppHandle, id: &str, key: &str, other: &str) -> String {
    let personality = with(app, |st| st.store.get(id).and_then(|c| c["personality"].as_str().map(str::to_string))).unwrap_or_default();
    let all = personalities::all();
    let Some(p) = all.get(&personality).or_else(|| all.values().next()) else { return String::new() };
    let said = match &p["social"][key] {
        Value::Array(lines) => pick(lines).and_then(Value::as_str).unwrap_or("").to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    };
    let name = name_of(app, other);
    said.replace("{other}", if name.is_empty() { "friend" } else { &name })
}

/// Two different lines of a kind (or the one twice, if that's all there is).
fn two_lines(app: &AppHandle, id: &str, key: &str, other: &str) -> (String, String) {
    let first = line(app, id, key, other);
    let mut second = line(app, id, key, other);
    for _ in 0..8 {
        if second != first {
            break;
        }
        second = line(app, id, key, other);
    }
    (first, second)
}

fn rep(app: &AppHandle, id: &str) -> Rep {
    soc(app, |s| s.reports.get(id).cloned()).unwrap_or_default()
}

fn showing(app: &AppHandle, id: &str) -> bool {
    robots::is_showing(app, id)
}

/// Robots out on the desktop that have told us lately how they are.
fn live(app: &AppHandle) -> Vec<String> {
    let now = Instant::now();
    robots::open_ids(app)
        .into_iter()
        .filter(|id| showing(app, id))
        .filter(|id| soc(app, |s| s.reports.get(id).and_then(|r| r.at).is_some_and(|at| now.duration_since(at) < FRESH)))
        .collect()
}

fn is_open(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some()
}

fn at_desk(app: &AppHandle, id: &str) -> bool {
    !rep(app, id).b("away") && !walkers::has(app, id)
}

/// Free for a little reaction at its desk (awake, idle, not in your hands).
fn free_awake(app: &AppHandle, id: &str) -> bool {
    let r = rep(app, id);
    at_desk(app, id) && r.b("awake") && r.b("free") && !r.b("chat")
}

fn centre(app: &AppHandle, id: &str) -> Option<(f64, f64)> {
    let r = hub::robot_rect(app, id)?;
    Some((r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 / 2.0))
}

fn same_screen(app: &AppHandle, a: &str, b: &str) -> bool {
    match (centre(app, a), centre(app, b)) {
        (Some(ca), Some(cb)) => window::monitor_near(ca.0 as i32, ca.1 as i32).work == window::monitor_near(cb.0 as i32, cb.1 as i32).work,
        _ => false,
    }
}

fn dist(app: &AppHandle, a: &str, b: &str) -> f64 {
    match (centre(app, a), centre(app, b)) {
        (Some(ca), Some(cb)) => (ca.0 - cb.0).hypot(ca.1 - cb.1),
        _ => f64::INFINITY,
    }
}

fn near() -> f64 {
    NEAR * window::primary_monitor().scale
}

/// Which side of `from`'s screen `to` is on.
fn side_of(app: &AppHandle, from: &str, to: &str) -> &'static str {
    let x = |id| centre(app, id).map_or(0.0, |c| c.0);
    if x(to) < x(from) { "L" } else { "R" }
}

fn face_for(side: &str) -> String {
    if side == "L" { "right".into() } else { "left".into() }
}

fn in_visit(app: &AppHandle, id: &str) -> bool {
    soc(app, |s| s.visit.as_ref().is_some_and(|v| v.a == id || v.b == id))
}

// ---------------------------------------------------------------- the reports

fn report(app: &AppHandle, id: &str, r: &Value) {
    match r["kind"].as_str() {
        Some("done") => on_done(app, id),
        Some("slept") => on_slept(app, id),
        Some("decline") => {
            let Some(v) = visit(app) else { return };
            if v.a == id {
                end_visit(app, "declined");
            } else if v.b == id && v.mode == "goout" {
                // asked out to lunch, but it can't come (busy, or it stays at its desk)
                walkers::say(app, &v.a, &line(app, &v.a, "goOutBusy", id), 2200);
                vset(app, |v| v.phase = "there".into());
                later(app, 1600, |app| homeward(app, None, 1.0));
            }
        }
        Some("plane-read") => plane_read(app, id),
        _ => {
            let Some(fields) = r.as_object() else { return };
            soc(app, |s| {
                let rep = s.reports.entry(id.to_string()).or_default();
                for (k, v) in fields {
                    rep.v.insert(k.clone(), v.clone());
                }
                rep.at = Some(Instant::now());
            });
        }
    }
}

// ---------------------------------------------------------------- reactions

fn on_done(app: &AppHandle, id: &str) {
    // the visitor watching it work cheers, and goes home
    if let Some(v) = visit(app).filter(|v| v.b == id && v.mode == "watch" && v.phase == "there") {
        walkers::say(app, &v.a, &line(app, &v.a, "clap", id), 2400);
        walkers::pose(app, &v.a, "clap", Some(&v.face));
        later(app, 2600, |app| homeward(app, None, 1.0));
    }
    if level(app) == "never" || app_busy(app) {
        return;
    }
    let now = Instant::now();
    for o in live(app) {
        if o == id || in_visit(app, &o) || !free_awake(app, &o) || !same_screen(app, &o, id) {
            continue;
        }
        let clapped = soc(app, |s| {
            if s.last_clap.get(&o).is_some_and(|t| now.duration_since(*t) < CLAP_GAP) {
                return false;
            }
            s.last_clap.insert(o.clone(), now);
            true
        });
        if clapped {
            let text = if random() < 0.45 { line(app, &o, "clap", id) } else { String::new() };
            tell(app, &o, json!({ "phase": "clap", "side": side_of(app, &o, id), "text": text }));
        }
    }
}

fn on_slept(app: &AppHandle, id: &str) {
    if level(app) == "never" || app_busy(app) {
        return;
    }
    for o in live(app) {
        if o == id || in_visit(app, &o) || !free_awake(app, &o) || dist(app, &o, id) > near() {
            continue;
        }
        if random() < 0.5 {
            let sleep_soon = rep(app, &o).idle_ms() > 90_000.0 && random() < 0.5;
            tell(app, &o, json!({ "phase": "yawn", "side": side_of(app, &o, id), "sleepSoon": sleep_soon }));
        }
    }
}

/// A word milestone (features/vocab/mod.rs): the others dance too.
pub fn milestone(app: &AppHandle, id: &str) {
    if level(app) == "never" {
        return;
    }
    for o in live(app) {
        if o != id && !in_visit(app, &o) && free_awake(app, &o) {
            tell(app, &o, json!({ "phase": "dance" }));
        }
    }
}

fn try_wave(app: &AppHandle, now: Instant) -> bool {
    let free: Vec<String> = live(app).into_iter().filter(|id| free_awake(app, id) && rep(app, id).idle_ms() > 15_000.0 && !in_visit(app, id)).collect();
    for a in &free {
        for b in &free {
            if a >= b || !same_screen(app, a, b) || dist(app, a, b) > near() {
                continue;
            }
            let key = format!("{a}|{b}");
            if soc(app, |s| s.last_wave.get(&key).is_some_and(|t| now.duration_since(*t) < WAVE_PAIR_GAP)) {
                continue;
            }
            if random() > 0.05 * kk(app) {
                continue;
            }
            soc(app, |s| s.last_wave.insert(key, now));
            let (x, y) = if random() < 0.5 { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
            tell(app, &x, json!({ "phase": "wave", "side": side_of(app, &x, &y) }));
            after(app, 900, move |app| {
                let back = if rep(app, &y).b("awake") { json!({ "phase": "wave-back", "side": side_of(app, &y, &x) }) } else { json!({ "phase": "stir" }) };
                tell(app, &y, back);
            });
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------- walker hooks

/// Its walker was clicked: a visitor says "gotta go!" and hurries home. True if social.rs
/// had a use for that (else it waves).
pub fn clicked(app: &AppHandle, id: &str) -> bool {
    let Some(v) = visit(app) else { return false };
    // out at lunch: both head back
    if v.mode == "goout" && v.out.as_ref().is_some_and(|o| o.contains(id)) {
        let other = if id == v.a { &v.b } else { &v.a };
        walkers::say(app, id, &line(app, id, "gotta", other), 1600);
        clear_timers(app);
        later(app, 700, |app| homeward(app, None, 1.4));
        return true;
    }
    if v.a != id {
        return false;
    }
    walkers::say(app, id, &line(app, id, "gotta", &v.b), 1600);
    clear_timers(app);
    if v.phase == "there" || v.phase == "walking" {
        vset(app, |v| v.phase = "there".into());
        later(app, 700, |app| homeward(app, None, 1.6));
    }
    true
}

/// Its walker was picked up mid-visit: the visit's off (it's an ordinary walker now, till
/// you put it back).
pub fn held(app: &AppHandle, id: &str) {
    if visit(app).is_some_and(|v| v.a == id || (v.mode == "goout" && v.out.as_ref().is_some_and(|o| o.contains(id)))) {
        end_visit(app, "picked up");
    }
}

/// Its walker went away (docked at home, or called back).
pub fn gone(app: &AppHandle, id: &str) {
    let Some(v) = visit(app) else { return };
    // out at lunch: over once both are back
    if v.mode == "goout" && v.out.as_ref().is_some_and(|o| o.contains(id)) {
        let mut left = 0;
        vset(app, |v| {
            if let Some(out) = v.out.as_mut() {
                out.remove(id);
                left = out.len();
            }
        });
        if left == 0 {
            end_visit(app, "home");
        } else if v.phase != "home" {
            homeward(app, None, 1.0);
        }
        return;
    }
    if v.a == id {
        end_visit(app, "home");
    }
}

// ---------------------------------------------------------------- office life

fn try_scene(app: &AppHandle) -> bool {
    if visit(app).is_some() {
        return false;
    }
    let now = Local::now();
    let settings = with(app, |st| st.store.settings().clone());
    if !workdays(&settings).contains(&now.weekday().num_days_from_sunday()) {
        return false;
    }
    let mins = now.hour() * 60 + now.minute();
    let day = today();
    let (lunch_day, tea_day) = soc(app, |s| (s.lunch_day.clone(), s.tea_day.clone()));
    let ids = live(app);
    let organisers: Vec<&String> = ids.iter().filter(|id| free_awake(app, id) && rep(app, id).idle_ms() >= 45_000.0 && rep(app, id).wanders() && !in_visit(app, id)).collect();
    for a in organisers {
        if random() > 0.06 * kk(app) {
            continue;
        }
        if lunch_day != day && (within(mins, SCENE_ORDER) || within(mins, SCENE_GOOUT)) {
            let out = within(mins, SCENE_GOOUT);
            let hosts: Vec<&String> = ids.iter().filter(|b| *b != a && free_awake(app, b) && !in_visit(app, b) && same_screen(app, a, b) && (!out || rep(app, b).wanders())).collect();
            if let Some(b) = pick(&hosts) {
                return scene(app, if out { "goout" } else { "order" }, a, b, vec![]);
            }
        }
        if tea_day != day && within(mins, SCENE_TEA) {
            // everyone at a desk on this screen, nearest first (the busy ones get the usual)
            let mut stops: Vec<String> = ids.iter().filter(|b| *b != a && at_desk(app, b) && !rep(app, b).b("chat") && rep(app, b).b("awake") && same_screen(app, a, b)).cloned().collect();
            stops.sort_by(|x, y| dist(app, a, x).total_cmp(&dist(app, a, y)));
            if !stops.is_empty() {
                let first = stops.remove(0);
                return scene(app, "tea", a, &first, stops);
            }
        }
    }
    false
}

/// An office scene: order | goout | tea (a goes to b; tea: then the stops).
pub fn scene(app: &AppHandle, kind: &str, a: &str, b: &str, stops: Vec<String>) -> bool {
    soc(app, |s| if kind == "tea" { s.tea_day = today() } else { s.lunch_day = today() });
    start(app, a, b, kind, stops, None)
}

// ---------------------------------------------------------------- the clock

fn tick(app: &AppHandle) {
    check(app);
    if level(app) == "never" || !present() || app_busy(app) {
        return;
    }
    let now = Instant::now();
    let _ = try_scene(app) || try_visit(app, now) || try_plane(app, now) || try_wave(app, now);
}

// ---------------------------------------------------------------- for the others

/// How a robot last said it was (awake, busy, chat, away…, and freeAwake), if it has.
pub fn peek(app: &AppHandle, id: &str) -> Option<Value> {
    let r = soc(app, |s| s.reports.get(id).cloned())?;
    let mut v = r.v;
    v.insert("freeAwake".into(), json!(free_awake(app, id)));
    Some(Value::Object(v))
}

/// A visit or an outing is going on.
pub fn active(app: &AppHandle) -> bool {
    soc(app, |s| s.visit.is_some())
}

/// How a robot is (and what just happened to it).
#[tauri::command(async)]
pub fn social_report(app: AppHandle, window: tauri::WebviewWindow, report: Value) -> Result<(), String> {
    let id = robots::sender(&window)?;
    if report.is_object() {
        self::report(&app, &id, &report);
    }
    Ok(())
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Social::default()));
    let app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(TICK);
        tick(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_life_happens_at_its_time() {
        assert!(!within(629, SCENE_ORDER));
        assert!(within(630, SCENE_ORDER));
        assert!(!within(700, SCENE_ORDER));
        assert!(within(700, SCENE_GOOUT));
        assert!(within(14 * 60, SCENE_TEA));
        assert!(!within(16 * 60, SCENE_TEA));
    }

    #[test]
    fn workdays_default_to_monday_to_friday() {
        assert_eq!(workdays(&json!({})), vec![1, 2, 3, 4, 5]);
        assert_eq!(workdays(&json!({ "notesWorkdays": [0, 6] })), vec![0, 6]);
    }

    #[test]
    fn gaps_are_shorter_when_often() {
        assert!(visit_gap("often") < visit_gap("sometimes"));
        assert_eq!(visit_gap("whatever"), visit_gap("sometimes"));
        assert!(plane_gap("often") < plane_gap("sometimes"));
    }

    #[test]
    fn a_report_reads_as_it_was_sent() {
        let r = Rep { v: json!({ "awake": true, "idleMs": 61000, "wanders": false }).as_object().cloned().unwrap_or_default(), at: None };
        assert!(r.b("awake"));
        assert!(!r.b("busy"));
        assert_eq!(r.idle_ms(), 61000.0);
        assert!(!r.wanders());
        assert!(Rep::default().wanders());
    }

    #[test]
    fn the_date_reads_as_javascripts() {
        let d = today();
        assert_eq!(d.len(), 15, "{d}"); // e.g. "Mon Oct 26 2026"
    }
}
