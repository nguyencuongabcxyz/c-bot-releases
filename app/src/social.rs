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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use chrono::{Datelike, Local, Timelike};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};


use crate::walkers::{self, Errand, after, pick, random};
use crate::{capture, groupchat, hub, maid, notes, personalities, planes, quick, robots, vocab, win, with};

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
    walkers::idle_secs() < AWAY_AFTER && capture::accepts_notifications()
}

/// You're working with C-Bot: a card, the notebook, Quick actions, the group chat or the
/// housemaid's round.
fn app_busy(app: &AppHandle) -> bool {
    notes::notebook_open(app) || quick::is_open(app) || vocab::card_showing(app) || groupchat::is_open(app) || maid::active(app)
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
    robots::hwnd_of(app, id).is_some_and(win::is_visible)
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
        (Some(ca), Some(cb)) => win::monitor_near(ca.0 as i32, ca.1 as i32).work == win::monitor_near(cb.0 as i32, cb.1 as i32).work,
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
    NEAR * win::primary_monitor().scale
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

/// A word milestone (vocab.rs): the others dance too.
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

// ---------------------------------------------------------------- visits

fn try_visit(app: &AppHandle, now: Instant) -> bool {
    let gap = visit_gap(&level(app));
    if soc(app, |s| s.visit.is_some() || s.last_visit.is_some_and(|t| now.duration_since(t) < gap)) {
        return false;
    }
    let ids = live(app);
    let visitors: Vec<&String> = ids
        .iter()
        .filter(|id| {
            let r = rep(app, id);
            free_awake(app, id) && r.wanders() && r.idle_ms() >= 60_000.0 && !soc(app, |s| s.last_visit_of.get(*id).is_some_and(|t| now.duration_since(*t) <= VISIT_ROBOT_GAP))
        })
        .collect();
    for a in visitors {
        if random() > 0.3 * kk(app) {
            continue;
        }
        let hosts: Vec<&String> = ids.iter().filter(|b| *b != a && at_desk(app, b) && !rep(app, b).b("chat") && same_screen(app, a, b)).collect();
        let Some(b) = pick(&hosts) else { continue };
        let rb = rep(app, b);
        let mode = if rb.b("busy") { "watch" } else if rb.b("awake") { "chat" } else { "tiptoe" };
        start(app, a, b, mode, vec![], None);
        return true;
    }
    false
}

/// Send a over to b's desk (mode: chat | watch | tiptoe; "" from how b is), or an office
/// scene: order (lunch), goout (lunch together), tea (b, then the stops, desk to desk).
/// delivery: ms till the food / tea comes.
pub fn start(app: &AppHandle, a: &str, b: &str, mode: &str, stops: Vec<String>, delivery: Option<u64>) -> bool {
    if visit(app).is_some() || a == b || !is_open(app, a) || !is_open(app, b) || !at_desk(app, b) {
        return false;
    }
    let mode = if !mode.is_empty() {
        mode.to_string()
    } else {
        let rb = rep(app, b);
        (if rb.b("busy") { "watch" } else if rb.b("awake") { "chat" } else { "tiptoe" }).to_string()
    };
    let side = side_of(app, b, a); // the side of b's desk it comes from, and stands on
    let now = Instant::now();
    let v = Visit {
        a: a.into(), b: b.into(), mode: mode.clone(), side, face: face_for(side), face_b: None, phase: "out".into(), epoch: next_gen(),
        delivery, stops, ordered: vec![a.into()], arrived_at: now, spot_b: None, out: None, there: HashSet::new(),
    };
    let started = soc(app, |s| {
        if s.visit.is_some() {
            return false;
        }
        s.visit = Some(v);
        s.last_visit = Some(now);
        s.last_visit_of.insert(a.into(), now);
        true
    });
    if !started {
        return false;
    }
    tell(app, a, json!({ "phase": "visit", "host": name_of(app, b), "mode": mode }));
    tell(app, b, json!({ "phase": "hosting", "on": true })); // (it stays at its desk till the visitor's gone)
    // (it never set off: it's sitting tight)
    let who = a.to_string();
    later(app, 9000, move |app| {
        if visit(app).is_some_and(|v| v.phase == "out") && !walkers::is_out(app, &who) {
            end_visit(app, "never left");
        }
    });
    true
}

/// Where the visitor's feet go: beside the host's desk, on the side it came from.
fn spot(app: &AppHandle) -> Option<(f64, f64)> {
    let v = visit(app)?;
    let r = hub::robot_rect(app, &v.b)?;
    let fx = if v.side == "L" { 0.1 } else { 0.9 };
    Some((r.x as f64 + r.w as f64 * fx, r.y as f64 + r.h as f64 * 0.93))
}

/// The errand it's going out on, if it's off to visit someone (walkers.rs takes it along):
/// { to, gait, speedK, face }; when it's there, walkers.rs calls errand_arrived.
pub fn errand_for(app: &AppHandle, id: &str) -> Option<Value> {
    let v = visit(app)?;
    // asked out to lunch: its walk to the spot beside the visitor
    if v.mode == "goout" && v.phase == "outing" && v.b == id {
        let to = v.spot_b?;
        vset(app, |v| {
            if let Some(out) = v.out.as_mut() {
                out.insert(id.to_string());
            }
        });
        return Some(json!({ "to": { "x": to.0, "y": to.1 }, "face": v.face_b }));
    }
    if v.a != id || v.phase != "out" {
        return None;
    }
    let to = spot(app)?;
    vset(app, |v| v.phase = "walking".into());
    let tiptoe = v.mode == "tiptoe";
    Some(json!({ "to": { "x": to.0, "y": to.1 }, "gait": if tiptoe { "tiptoe" } else { "walk" }, "speedK": if tiptoe { 0.6 } else { 1.0 }, "face": v.face }))
}

/// It got where errand_for sent it.
pub fn errand_arrived(app: &AppHandle, id: &str) {
    match visit(app) {
        Some(v) if v.mode == "goout" && v.b == id => sit_down(app, id),
        Some(_) => arrived(app),
        None => {}
    }
}

fn arrived_errand(face: &str) -> Errand {
    Errand { face: Some(face.to_string()), on_arrive: Some(Box::new(|app: &AppHandle| arrived(app))), ..Errand::default() }
}

fn arrived(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    let (a, b) = (v.a.clone(), v.b.clone());
    let rb = rep(app, &b);
    // things may have changed on the way
    let mut mode = v.mode.clone();
    if mode == "chat" && rb.b("busy") {
        mode = "watch".into();
    }
    if mode == "chat" && !rb.b("awake") {
        mode = "tiptoe".into();
    }
    if mode == "tiptoe" && rb.b("awake") {
        mode = "chat".into();
    }
    let m = mode.clone();
    vset(app, move |v| {
        v.phase = "there".into();
        v.arrived_at = Instant::now();
        v.mode = m;
    });
    let mine = v.side; // b turns to the side the visitor stands on
    let face = v.face.clone();
    match mode.as_str() {
        "chat" => {
            tell(app, &b, json!({ "phase": "listen", "side": mine }));
            let lines = [(a.clone(), line(app, &a, "hi", &b)), (b.clone(), line(app, &b, "reply", &a)), (a.clone(), line(app, &a, "bye", &b))];
            let n = lines.len() as u64;
            for (i, (who, text)) in lines.into_iter().enumerate() {
                let (a, b, face) = (a.clone(), b.clone(), face.clone());
                later(app, 400 + i as u64 * LINE_GAP, move |app| {
                    if who == a {
                        walkers::pose(app, &a, "talk", Some(&face));
                        walkers::say(app, &a, &text, LINE_GAP - 200);
                        later(app, LINE_GAP - 300, move |app| walkers::pose(app, &a, "stand", Some(&face)));
                    } else {
                        tell(app, &b, json!({ "phase": "say", "text": text }));
                    }
                });
            }
            let (a2, b2, face2) = (a.clone(), b.clone(), face.clone());
            later(app, 400 + n * LINE_GAP, move |app| {
                walkers::pose(app, &a2, "wave", Some(&face2));
                tell(app, &b2, json!({ "phase": "listen-end", "wave": true }));
            });
            later(app, 400 + n * LINE_GAP + 1300, |app| homeward(app, None, 1.0));
        }
        "order" | "goout" if !free_awake(app, &b) => {
            // it got busy (or dozed off) while the visitor walked over: maybe next time
            talk(app, &a, &line(app, &a, "goOutBusy", &b));
            later(app, 1800, |app| homeward(app, None, 1.0));
        }
        "order" | "goout" => {
            // lunch: "order?" / "yes, …" / "ordered!", or "go out?" / "yes!" and off they go
            tell(app, &b, json!({ "phase": "listen", "side": mine }));
            let lines: Vec<(String, String)> = if mode == "order" {
                vec![(a.clone(), line(app, &a, "lunchAsk", &b)), (b.clone(), line(app, &b, "lunchDish", &a)), (a.clone(), line(app, &a, "lunchOrdered", &b))]
            } else {
                vec![(a.clone(), line(app, &a, "goOut", &b)), (b.clone(), line(app, &b, "goOutYes", &a))]
            };
            let after_lines = 400 + lines.len() as u64 * LINE_GAP;
            for (i, (who, text)) in lines.into_iter().enumerate() {
                later(app, 400 + i as u64 * LINE_GAP, move |app| talk(app, &who, &text));
            }
            if mode == "order" {
                let (a2, b2) = (a.clone(), b.clone());
                later(app, after_lines, move |app| {
                    let face = visit(app).map(|v| v.face).unwrap_or_default();
                    walkers::pose(app, &a2, "wave", Some(&face));
                    tell(app, &b2, json!({ "phase": "listen-end", "wave": true }));
                    deliver(app, vec![a2.clone(), b2.clone()], "food");
                    soc(app, |s| s.lunch_day = today());
                });
                later(app, after_lines + 1300, |app| homeward(app, None, 1.0));
            } else {
                later(app, after_lines - 600, go_out);
            }
        }
        "tea" => {
            // milk tea: takes this desk's order (the usual for a busy one), then on to the next
            let wants_tea = free_awake(app, &b);
            if wants_tea {
                tell(app, &b, json!({ "phase": "listen", "side": mine }));
                let (a2, b2) = (a.clone(), b.clone());
                later(app, 400, move |app| talk(app, &a2, &line(app, &a2, "teaAsk", &b2)));
                let (a3, b3) = (a.clone(), b.clone());
                later(app, 400 + LINE_GAP, move |app| talk(app, &b3, &line(app, &b3, "teaOrder", &a3)));
                vset(app, |v| v.ordered.push(b.clone()));
            } else if rb.b("busy") {
                let (a2, b2) = (a.clone(), b.clone());
                later(app, 400, move |app| talk(app, &a2, &line(app, &a2, "teaUsual", &b2)));
                vset(app, |v| v.ordered.push(b.clone()));
            }
            later(app, if wants_tea { 400 + 2 * LINE_GAP } else { 400 + LINE_GAP }, next_tea_stop);
        }
        "watch" => {
            walkers::pose(app, &a, "stand", Some(&face));
            cheer(app, a.clone(), b.clone(), 0);
            later(app, WATCH_MAX, |app| homeward(app, None, 1.0));
        }
        _ => {
            // tiptoe: a sticky on its monitor, and back without waking it
            walkers::pose(app, &a, "stand", Some(&face));
            walkers::say(app, &a, &line(app, &a, "tiptoe", &b), 2200);
            tell(app, &b, json!({ "phase": "visit-note", "from": name_of(app, &a), "found": line(app, &b, "found", &a) }));
            later(app, 2600, |app| homeward(app, Some("tiptoe"), 0.6));
        }
    }
}

/// Watching over its shoulder: a cheer now and then.
fn cheer(app: &AppHandle, a: String, b: String, n: u32) {
    later(app, if n > 0 { 6500 } else { 1200 }, move |app| {
        let face = visit(app).map(|v| v.face).unwrap_or_default();
        walkers::say(app, &a, &line(app, &a, "watch", &b), 2400);
        walkers::pose(app, &a, "clap", Some(&face));
        let a2 = a.clone();
        later(app, 2200, move |app| walkers::pose(app, &a2, "stand", Some(&face)));
        if n < 5 {
            cheer(app, a, b, n + 1);
        }
    });
}

/// One line of a scene: the walker's bubble (and hands), or the robot at its desk.
fn talk(app: &AppHandle, who: &str, text: &str) {
    let Some(v) = visit(app) else { return };
    if text.is_empty() {
        return;
    }
    if walkers::has(app, who) {
        let sitting = v.phase == "sitting";
        let face = if who == v.a { Some(v.face.clone()) } else { v.face_b.clone() };
        walkers::pose(app, who, if sitting { "sit" } else { "talk" }, face.as_deref());
        walkers::say(app, who, text, LINE_GAP - 200);
        if !sitting {
            let who = who.to_string();
            later(app, LINE_GAP - 300, move |app| {
                if walkers::has(app, &who) {
                    let face = visit(app).and_then(|v| if who == v.a { Some(v.face) } else { v.face_b });
                    walkers::pose(app, &who, "stand", face.as_deref());
                }
            });
        }
    } else {
        tell(app, who, json!({ "phase": "say", "text": text }));
    }
}

/// Lunch out: b gets up too, and both walk to a spot between their desks.
fn go_out(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    let (a, b) = (v.a.clone(), v.b.clone());
    tell(app, &b, json!({ "phase": "listen-end" }));
    // (between their desks: the visitor's out walking already, its desk is where it came from)
    let (Some(ra), Some(rb)) = (robots::desk_rect(app, &a), robots::desk_rect(app, &b)) else { return homeward(app, None, 1.0) };
    let m = win::monitor_near(ra.x, ra.y);
    let (wa, s) = (m.work, m.scale);
    let mid = (ra.x as f64 + ra.w as f64 / 2.0 + rb.x as f64 + rb.w as f64 / 2.0) / 2.0;
    let y = (ra.bottom().max(rb.bottom()) as f64 - 10.0 * s).min(wa.bottom() as f64 - 12.0 * s);
    let a_left = ra.x < rb.x;
    let off = 58.0 * s;
    let spot_a = (mid + if a_left { -off } else { off }, y);
    let spot_b = (mid + if a_left { off } else { -off }, y);
    let face = if a_left { "right" } else { "left" };
    let face_b = if a_left { "left" } else { "right" };
    let a2 = a.clone();
    vset(app, move |v| {
        v.spot_b = Some(spot_b);
        v.face = face.into();
        v.face_b = Some(face_b.into());
        v.phase = "outing".into();
        v.out = Some(HashSet::from([a2]));
        v.there = HashSet::new();
    });
    let who = a.clone();
    let errand = Errand { face: Some(face.into()), on_arrive: Some(Box::new(move |app: &AppHandle| sit_down(app, &who))), ..Errand::default() };
    walkers::walk_to(app, &a, spot_a, errand);
    tell(app, &b, json!({ "phase": "go-out", "with": name_of(app, &a) })); // (it gets up: robot:wander asks errand_for for its walk)
    later(app, 12000, move |app| {
        if visit(app).is_some_and(|v| v.phase == "outing") && !walkers::is_out(app, &b) {
            homeward(app, None, 1.0); // (it never came)
        }
    });
}

fn sit_down(app: &AppHandle, id: &str) {
    let Some(mut v) = visit(app) else { return };
    v.there.insert(id.to_string());
    let both = v.there.len() >= 2;
    let there = v.there.clone();
    vset(app, |x| {
        x.there = there;
        if both {
            x.phase = "sitting".into();
        }
    });
    let face = if id == v.a { Some(v.face.clone()) } else { v.face_b.clone() };
    walkers::pose(app, id, "sit", face.as_deref());
    if !both {
        return;
    }
    // both there: lunch, side by side, chatting
    let (a, b) = (v.a.clone(), v.b.clone());
    let (a1, a2) = two_lines(app, &a, "lunchChat", &b); // (never the same line twice)
    let (b1, b2) = two_lines(app, &b, "lunchChat", &a);
    let said = [a1, b1, a2, b2];
    let n = said.len() as u64;
    for (i, text) in said.into_iter().enumerate() {
        let who = if i % 2 == 1 { b.clone() } else { a.clone() };
        later(app, 1500 + i as u64 * (LINE_GAP + 600), move |app| talk(app, &who, &text));
    }
    later(app, 1500 + n * (LINE_GAP + 600) + 800, |app| homeward(app, None, 1.0));
}

/// The milk-tea round: the next desk, or home with everyone's order in.
fn next_tea_stop(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    tell(app, &v.b, json!({ "phase": "listen-end" }));
    tell(app, &v.b, json!({ "phase": "hosting", "on": false }));
    let next = v.stops.iter().find(|x| is_open(app, x) && at_desk(app, x) && !rep(app, x).b("chat")).cloned();
    let n2 = next.clone();
    vset(app, move |v| v.stops.retain(|x| Some(x) != n2.as_ref()));
    let Some(next) = next else {
        talk(app, &v.a, &line(app, &v.a, "teaOrdered", &v.b));
        deliver(app, v.ordered.clone(), "tea");
        soc(app, |s| s.tea_day = today());
        return later(app, LINE_GAP, |app| homeward(app, None, 1.0));
    };
    let side = side_of(app, &next, &v.a);
    let n3 = next.clone();
    vset(app, move |v| {
        v.b = n3;
        v.side = side;
        v.face = face_for(side);
        v.phase = "walking".into();
    });
    tell(app, &next, json!({ "phase": "hosting", "on": true }));
    let ok = match spot(app) {
        Some(to) => walkers::walk_to(app, &v.a, to, arrived_errand(&face_for(side))),
        None => false,
    };
    if !ok {
        homeward(app, None, 1.0);
    }
}

/// The food / the milk tea comes, a few minutes later, to every robot in on it.
fn deliver(app: &AppHandle, ids: Vec<String>, kind: &'static str) {
    let ms = visit(app).and_then(|v| v.delivery).unwrap_or(if kind == "food" { DELIVERY_FOOD } else { DELIVERY_TEA });
    after(app, ms, move |app| {
        let mut seen = HashSet::new();
        for id in ids.into_iter().filter(|id| seen.insert(id.clone())) {
            if is_open(app, &id) {
                let text = line(app, &id, if kind == "food" { "lunchArrived" } else { "teaArrived" }, "");
                tell(app, &id, json!({ "phase": "treat", "kind": kind, "text": text }));
            }
        }
    });
}

fn homeward(app: &AppHandle, gait: Option<&str>, speed_k: f64) {
    let Some(v) = visit(app) else { return };
    if v.phase == "home" {
        return;
    }
    let out = v.mode == "goout" && v.out.is_some();
    vset(app, |v| v.phase = "home".into());
    if v.mode == "chat" {
        tell(app, &v.b, json!({ "phase": "listen-end" }));
    }
    walkers::go_home(app, &v.a, gait, speed_k);
    if out && walkers::has(app, &v.b) {
        walkers::go_home(app, &v.b, gait, speed_k);
    }
}

/// The visit's over (home and docked, picked up, called back, or it never left).
fn end_visit(app: &AppHandle, why: &str) {
    let Some(v) = soc(app, |s| s.visit.take()) else { return };
    if v.mode == "chat" {
        tell(app, &v.b, json!({ "phase": "listen-end" }));
    }
    tell(app, &v.a, json!({ "phase": "visit-over", "why": why }));
    if v.mode == "goout" {
        tell(app, &v.b, json!({ "phase": "visit-over", "why": why }));
    }
    tell(app, &v.b, json!({ "phase": "hosting", "on": false }));
}

/// A visit that should end early: you're using the host or the visitor, or the host got busy.
fn check(app: &AppHandle) {
    let Some(v) = visit(app).filter(|v| v.phase == "there") else { return };
    if !at_desk(app, &v.b) {
        return homeward(app, None, 1.0); // (the host's gone off: nobody to visit)
    }
    let rb = rep(app, &v.b);
    if rb.b("chat") || (v.mode == "chat" && rb.b("busy")) {
        walkers::say(app, &v.a, &line(app, &v.a, if rb.b("chat") { "gotta" } else { "busy" }, &v.b), 1800);
        later(app, 1200, |app| homeward(app, None, 1.4));
    } else if v.mode == "watch" && !rb.b("busy") && v.arrived_at.elapsed() > Duration::from_secs(3) {
        // its task ended without a "done" (stopped, an error): back home
        later(app, 800, |app| homeward(app, None, 1.0));
    }
}

// ---------------------------------------------------------------- paper planes

fn try_plane(app: &AppHandle, now: Instant) -> bool {
    let gap = plane_gap(&level(app));
    if soc(app, |s| s.in_flight || s.last_plane.is_some_and(|t| now.duration_since(t) < gap)) {
        return false;
    }
    let ids = live(app);
    let throwers: Vec<&String> = ids
        .iter()
        .filter(|id| {
            free_awake(app, id) && rep(app, id).idle_ms() >= 45_000.0 && !in_visit(app, id) && !soc(app, |s| s.last_plane_of.get(*id).is_some_and(|t| now.duration_since(*t) <= PLANE_ROBOT_GAP))
        })
        .collect();
    for a in throwers {
        if random() > 0.05 * kk(app) {
            continue;
        }
        let targets: Vec<&String> = ids
            .iter()
            .filter(|x| *x != a && at_desk(app, x) && !rep(app, x).b("chat") && !in_visit(app, x) && !soc(app, |s| s.desk_planes.contains_key(*x)) && same_screen(app, a, x))
            .collect();
        let Some(b) = pick(&targets) else { continue };
        return throw_plane(app, a, b, random() < 0.1);
    }
    false
}

/// Where the plane leaves the thrower's hand, and where the catcher's hand meets it.
fn hand_point(app: &AppHandle, id: &str, side: &str, up: bool) -> Option<(f64, f64)> {
    let r = hub::robot_rect(app, id)?;
    let fx = if side == "L" { 0.36 } else { 0.64 };
    Some((r.x as f64 + r.w as f64 * fx, r.y as f64 + r.h as f64 * if up { 0.3 } else { 0.42 }))
}

/// a throws a paper plane at b (miss: it overshoots and lands on your desktop).
pub fn throw_plane(app: &AppHandle, a: &str, b: &str, miss: bool) -> bool {
    if a == b || !is_open(app, a) || !is_open(app, b) {
        return false;
    }
    let now = Instant::now();
    if !soc(app, |s| !std::mem::replace(&mut s.in_flight, true)) {
        return false;
    }
    soc(app, |s| {
        s.last_plane = Some(now);
        s.last_plane_of.insert(a.into(), now);
    });
    let side = side_of(app, a, b);
    let text = line(app, a, "planes", b);
    tell(app, a, json!({ "phase": "throw", "side": side }));
    let (a, b) = (a.to_string(), b.to_string());
    after(app, THROW_AT, move |app| {
        let from = hand_point(app, &a, side, false);
        let to = hand_point(app, &b, side_of(app, &b, &a), true);
        let (Some(from), Some(to)) = (from, to) else {
            soc(app, |s| s.in_flight = false);
            return;
        };
        let on_land = move |app: &AppHandle| {
            soc(app, |s| s.in_flight = false);
            if miss {
                return tell(app, &a, json!({ "phase": "oops" }));
            }
            // caught and read out if it's free; otherwise it lands on its desk, for later
            if free_awake(app, &b) && !rep(app, &b).b("busy") {
                tell(app, &b, json!({ "phase": "catch", "side": side_of(app, &b, &a), "from": name_of(app, &a), "text": text }));
                after(app, 3000, move |app| wave_over(app, &b, &a));
            } else {
                soc(app, |s| s.desk_planes.insert(b.clone(), a.clone()));
                tell(app, &b, json!({ "phase": "plane-land", "from": name_of(app, &a), "text": text }));
            }
        };
        planes::fly_with(app, from, to, miss, Some(Box::new(on_land)));
    });
    true
}

/// Read it: a wave over to whoever threw it, and a wave back.
fn wave_over(app: &AppHandle, b: &str, a: &str) {
    if !free_awake(app, b) {
        return;
    }
    tell(app, b, json!({ "phase": "wave", "side": side_of(app, b, a) }));
    let (a, b) = (a.to_string(), b.to_string());
    after(app, 900, move |app| {
        if free_awake(app, &a) {
            tell(app, &a, json!({ "phase": "wave-back", "side": side_of(app, &a, &b) }));
        }
    });
}

fn plane_read(app: &AppHandle, id: &str) {
    if let Some(a) = soc(app, |s| s.desk_planes.remove(id)) {
        let id = id.to_string();
        after(app, 400, move |app| wave_over(app, &id, &a));
    }
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
