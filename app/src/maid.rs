//! The evening housemaid (main maid.js): at 5 pm on workdays a housemaid robot (not one of
//! yours) comes in from the edge of the screen and tidies each desk. [wave 1: desktop]
//!
//! She goes round the desks on one screen, left to right. At each one she dusts with her
//! feather duster (sparkles all over the desk), and the robot there reacts (robot.ts 'tidy'):
//! free, it lifts its feet for her and thanks her; busy or with its chat open, it carries
//! on; asleep, she tiptoes round it; out for a walk, she tidies the empty desk. Then she
//! says good night and leaves by the nearest edge. Once a day; if you're away at 5 she
//! comes when you're back, until half past six. Her walk is a walker with no desk
//! (walkers::arrive); settings.maid === false turns her off, maidDay is the day she came.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use chrono::{Datelike, Local, Timelike};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::walkers::{self, Errand, after, pick};
use crate::win::{self, Rect};
use crate::{capture, groupchat, hub, notes, personalities, quick, robots, social, util, vocab, with};

const ID: &str = "maid";
const FROM: u32 = 17 * 60; // 17:00
const UNTIL: u32 = 18 * 60 + 30; // (you were away at five: she still comes till half past six)
const AWAY_AFTER: u64 = 120; // s without touching mouse or keyboard: you're not there to see her
const TICK: Duration = Duration::from_secs(30);
const DUST_MS: u64 = 7000; // at each desk

const FREE: [&str; 3] = ["Evening clean-up! 🧹", "Feet up, please! 🧹", "Time for a little tidy! ✨"];
const CHAT: [&str; 2] = ["Just a quick dust! 🧹", "Don’t mind me! ✨"];
const BUSY: [&str; 2] = ["Don’t mind me, keep going! 🧹", "I’ll work around you! ✨"];
const ASLEEP: [&str; 2] = ["Shh… 🤫", "Sleep tight, I’ll be quick…"];
const AWAY: [&str; 2] = ["Nobody home? I’ll tidy anyway! 🧹", "Out for a walk? A clean desk for when you’re back!"];
const DONE: [&str; 3] = ["All sparkly! ✨", "There, spotless! 🌟", "Much better! ✨"];
const BYE: [&str; 3] = ["Good night, everyone! 🌙", "See you tomorrow! 👋", "All tidy! Have a nice evening! 🌙"];
const CLICK: [&str; 4] = ["Almost done! ✨", "Mind the duster! 🧹", "A tidy desk, a tidy mind!", "Hi there! Just tidying up 🧹"];

/// Her look (a soft pink robot in the classic black-and-white uniform); `size`: as big as
/// the smallest robot, so she doesn't tower over them.
fn look(size: &str) -> Value {
    json!({
        "name": "Housemaid",
        "staff": true, // (on duty: never in a hoodie or a nightcap, walker page)
        "tag": "🧹 Housekeeping", // (her name tag, at her feet)
        "color": "#ffb3cf",
        "body": "kit",
        "theme": "classic",
        "size": size,
        "accessory": "maidcap",
        "kit": {
            "head": "ball", "face": "cute", "top": "none", "body": "egg", "arms": "mitten", "base": "legs", "finish": "glossy",
            "clothes": "maid", "neck": "none", "extra": "duster", "specs": "none",
            "second": "#ffffff", "accent": "#ff6fa5", "eye": "", "cloth": "#1d2235", "hair": "#5a3a22"
        }
    })
}

fn say_line(lines: &[&str]) -> String {
    pick(lines).copied().unwrap_or("").to_string()
}

/// Her round: the desks in order, which one she's at, and its timers (epoch).
struct Round {
    ids: Vec<String>,
    i: usize,
    epoch: u64,
    wa: Rect,
    at: Option<String>,
}

#[derive(Default)]
struct Maid {
    round: Option<Round>,
    gens: u64,
}

fn md<R>(app: &AppHandle, f: impl FnOnce(&mut Maid) -> R) -> R {
    match app.try_state::<Mutex<Maid>>() {
        Some(state) => {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard)
        }
        None => f(&mut Maid::default()),
    }
}

/// Do this in ms, if her round's still on.
fn later(app: &AppHandle, ms: u64, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let Some(epoch) = md(app, |m| m.round.as_ref().map(|r| r.epoch)) else { return };
    after(app, ms, move |app| {
        if md(app, |m| m.round.as_ref().is_some_and(|r| r.epoch == epoch)) {
            f(app);
        }
    });
}

fn tell(app: &AppHandle, id: &str, payload: Value) {
    hub::send_to_robot(app, id, "robot:social", payload);
}

fn showing(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some_and(win::is_visible)
}

fn centre(r: Rect) -> (i32, i32) {
    (r.x + r.w / 2, r.y + r.h / 2)
}

fn size_k(size: &str) -> f64 {
    match size {
        "small" => 0.7,
        "large" => 1.35,
        "huge" => 1.7,
        _ => 1.0,
    }
}

/// The robot's thank-you line (its personality's maidThanks).
fn thanks_of(app: &AppHandle, id: &str) -> String {
    let personality = with(app, |st| st.store.get(id).and_then(|c| c["personality"].as_str().map(str::to_string))).unwrap_or_default();
    let all = personalities::all();
    all.get(&personality)
        .or_else(|| all.values().next())
        .and_then(|p| p["social"]["maidThanks"].as_array())
        .and_then(|lines| pick(lines).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// Her round, now. False when there's no desk to tidy or she's already about.
fn begin(app: &AppHandle) -> bool {
    if active(app) || walkers::has(app, ID) {
        return false;
    }
    // the desks on the screen of the first one, left to right
    let mut all: Vec<(String, Rect)> = robots::open_ids(app).into_iter().filter(|id| showing(app, id)).filter_map(|id| Some((id.clone(), robots::desk_rect(app, &id)?))).collect();
    if all.is_empty() {
        return false;
    }
    all.sort_by_key(|(_, r)| r.x);
    let first = all[0].1;
    let (fx, fy) = centre(first);
    let m = win::monitor_near(fx, fy);
    let (wa, s) = (m.work, m.scale);
    let ids: Vec<String> = all
        .into_iter()
        .filter(|(_, r)| {
            let (x, y) = centre(*r);
            win::monitor_near(x, y).work == wa
        })
        .map(|(id, _)| id)
        .collect();
    // as big as the smallest robot, so she doesn't tower over them
    let size = ids
        .iter()
        .map(|id| with(app, |st| st.store.get(id).and_then(|c| c["size"].as_str().map(str::to_string))).unwrap_or_else(|| "normal".into()))
        .min_by(|a, b| size_k(a).total_cmp(&size_k(b)))
        .unwrap_or_else(|| "normal".into());
    let k = size_k(&size);
    let from = (wa.x as f64 + 30.0 * k * s, (first.y as f64 + first.h as f64 * 0.93).min(wa.bottom() as f64 - 8.0 * s));
    if !walkers::arrive(app, ID, from, look(&size), k) {
        return false;
    }
    md(app, |m| {
        m.gens += 1;
        m.round = Some(Round { ids, i: 0, epoch: m.gens, wa, at: None });
    });
    with(app, |st| st.store.update_settings(util::patch(vec![("maidDay", json!(social::today()))])));
    later(app, 1200, next);
    true
}

/// On to the next desk (from the left, she stands on its left; after the last one, she leaves).
fn next(app: &AppHandle) {
    loop {
        let Some(id) = md(app, |m| m.round.as_ref().map(|r| r.ids.get(r.i).cloned())) else { return };
        let Some(id) = id else { return leave(app) };
        let desk = robots::desk_rect(app, &id).filter(|_| showing(app, &id));
        let Some(r) = desk else {
            md(app, |m| m.round.as_mut().map(|r| r.i += 1));
            continue;
        };
        // (at the desk's left end, a little back, facing it: she reaches up and wipes the clear
        // end of the desk top, left of the robot)
        let spot = (r.x as f64 + r.w as f64 * 0.1, r.y as f64 + r.h as f64 * 0.87);
        let errand = Errand { face: Some("right".into()), on_arrive: Some(Box::new(move |app: &AppHandle| tidy(app, &id))), ..Errand::default() };
        if !walkers::walk_to(app, ID, spot, errand) {
            end(app);
        }
        return;
    }
}

/// The robot's mood as she gets there.
fn mood_of(status: &Value) -> &'static str {
    let b = |k: &str| status[k].as_bool().unwrap_or(false);
    if b("away") {
        "away"
    } else if !b("awake") {
        "asleep"
    } else if b("busy") {
        "busy"
    } else if b("chat") {
        "chat"
    } else {
        "free"
    }
}

fn tidy(app: &AppHandle, id: &str) {
    if !active(app) {
        return;
    }
    md(app, |m| m.round.as_mut().map(|r| r.at = Some(id.to_string())));
    let status = social::peek(app, id).unwrap_or_else(|| json!({}));
    let mood = mood_of(&status);
    let lines: &[&str] = match mood {
        "away" => &AWAY,
        "asleep" => &ASLEEP,
        "busy" => &BUSY,
        "chat" => &CHAT,
        _ => &FREE,
    };
    walkers::say(app, ID, &say_line(lines), 2400);
    tell(app, id, json!({ "phase": "tidy", "side": "L", "mood": mood, "thanks": thanks_of(app, id) }));
    later(app, 500, |app| walkers::pose(app, ID, "dust", Some("right")));
    let who = id.to_string();
    later(app, DUST_MS, move |app| {
        walkers::pose(app, ID, "stand", Some("toward")); // (turns round to say so)
        walkers::say(app, ID, &say_line(&DONE), 1800);
        tell(app, &who, json!({ "phase": "tidy-end" }));
        md(app, |m| m.round.as_mut().map(|r| r.at = None));
    });
    later(app, DUST_MS + 1700, |app| {
        md(app, |m| m.round.as_mut().map(|r| r.i += 1));
        next(app);
    });
}

/// Good night, and off by the nearest edge of the screen.
fn leave(app: &AppHandle) {
    let wa = md(app, |m| m.round.as_ref().map(|r| r.wa));
    let (Some(feet), Some(wa)) = (walkers::feet(app, ID), wa) else { return end(app) };
    let s = win::monitor_near(feet.0 as i32, feet.1 as i32).scale;
    let right = feet.0 - wa.x as f64 > wa.right() as f64 - feet.0;
    walkers::say(app, ID, &say_line(&BYE), 2400);
    later(app, 900, move |app| {
        let to = (if right { wa.right() as f64 - 20.0 * s } else { wa.x as f64 + 20.0 * s }, feet.1);
        let errand = Errand { on_arrive: Some(Box::new(|app: &AppHandle| walkers::close(app, ID))), ..Errand::default() };
        if !walkers::walk_to(app, ID, to, errand) {
            end(app);
        }
    });
}

/// Her round is over (or cut short): the desk she was at stops sparkling.
fn end(app: &AppHandle) {
    let Some(round) = md(app, |m| m.round.take()) else { return };
    if let Some(at) = round.at {
        tell(app, &at, json!({ "phase": "tidy-end" }));
    }
    walkers::close(app, ID);
}

/// Is she due (5 pm on a workday, she hasn't been today, and you're there to see her)?
/// weekday: 0 Sunday; mins: minutes into the day.
fn due_at(settings: &Value, weekday: u32, mins: u32, today: &str, idle_secs: u64, presenting: bool) -> bool {
    if settings["maid"] == json!(false) || settings["maidDay"].as_str() == Some(today) {
        return false;
    }
    if !social::workdays(settings).contains(&weekday) {
        return false;
    }
    if !(FROM..UNTIL).contains(&mins) {
        return false;
    }
    idle_secs < AWAY_AFTER && !presenting
}

fn due(app: &AppHandle) -> bool {
    let settings = with(app, |st| st.store.settings().clone());
    let now = Local::now();
    due_at(&settings, now.weekday().num_days_from_sunday(), now.hour() * 60 + now.minute(), &social::today(), walkers::idle_secs(), capture::presenting())
}

/// A visit going on, or you're working with C-Bot: she waits.
fn busy(app: &AppHandle) -> bool {
    social::active(app) || notes::notebook_open(app) || quick::is_open(app) || vocab::card_showing(app) || groupchat::is_open(app)
}

/// She's on her round.
pub fn active(app: &AppHandle) -> bool {
    md(app, |m| m.round.is_some())
}

/// Send her round now (the tray).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    // (her window is made off the caller's thread: the tray's menu runs on the main one)
    thread::spawn(move || {
        begin(&app);
    });
}

/// Her walker was clicked: true if that was hers (a cheery word).
pub fn clicked(app: &AppHandle, id: &str) -> bool {
    if id != ID {
        return false;
    }
    walkers::say(app, ID, &say_line(&CLICK), 1800);
    true
}

/// A walker went away.
pub fn gone(app: &AppHandle, id: &str) {
    if id == ID && active(app) {
        end(app);
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Maid::default()));
    let app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(TICK);
        if due(&app) && !busy(&app) {
            begin(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn she_comes_at_five_on_workdays() {
        let s = json!({});
        assert!(due_at(&s, 1, 17 * 60, "Mon Oct 26 2026", 0, false));
        assert!(due_at(&s, 5, 18 * 60 + 29, "x", 0, false));
        assert!(!due_at(&s, 1, 16 * 60 + 59, "x", 0, false)); // too early
        assert!(!due_at(&s, 1, 18 * 60 + 30, "x", 0, false)); // too late
        assert!(!due_at(&s, 0, 17 * 60 + 5, "x", 0, false)); // Sunday
        assert!(due_at(&json!({ "notesWorkdays": [0] }), 0, 17 * 60 + 5, "x", 0, false));
    }

    #[test]
    fn once_a_day_and_only_when_youre_there() {
        assert!(!due_at(&json!({ "maidDay": "Mon Oct 26 2026" }), 1, 17 * 60, "Mon Oct 26 2026", 0, false));
        assert!(!due_at(&json!({ "maid": false }), 1, 17 * 60, "x", 0, false));
        assert!(!due_at(&json!({}), 1, 17 * 60, "x", 300, false)); // away
        assert!(!due_at(&json!({}), 1, 17 * 60, "x", 0, true)); // presenting
    }

    #[test]
    fn her_lines_fit_the_robots_mood() {
        assert_eq!(mood_of(&json!({ "away": true, "awake": true })), "away");
        assert_eq!(mood_of(&json!({})), "asleep");
        assert_eq!(mood_of(&json!({ "awake": true, "busy": true, "chat": true })), "busy");
        assert_eq!(mood_of(&json!({ "awake": true, "chat": true })), "chat");
        assert_eq!(mood_of(&json!({ "awake": true })), "free");
    }
}
