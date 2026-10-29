//! Routines: a robot runs a saved prompt on a schedule (every weekday at 08:00, every two
//! hours, once on Friday at 14:00) and shows you what it got. Kept in routines.json.
//!
//! A run is a turn in a tab of the robot's own chat (robot.ts robot:routine, one tab per
//! routine while it's open, so you can ask more about it there); its answer comes back
//! (routines_done) and is shown as the routine says: the Routines window beside the robot,
//! a line from the robot, or a Windows notification. The clock looks once a minute and when
//! you're back at the PC; a run missed while it slept runs when you're back that day.
//!
//! Locks: this module's state (Routines) is never held while calling out of it.

mod chat;
mod commands;
mod panel;
mod runs;
mod schedule;

pub use chat::*;
pub use commands::*;
use runs::*;

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime};

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::robots;
use crate::runtime::util::only;
use crate::runtime::{Error, hub, part_if, with};
use crate::store::Fields;
use crate::store::saved::Saved;

use schedule::When;

const CHECK_EVERY: Duration = Duration::from_secs(60);
const FIRST_CHECK: Duration = Duration::from_secs(20); // (a little after C-Bot starts: the robots are out)
const BACK_CHECK: Duration = Duration::from_secs(5); // back at the PC (waking from sleep)
const LIMIT_MIN: u32 = 10; // a run's time limit, unless the routine says
const RESULT_MAX: usize = 20_000; // (characters kept of a result)
const ROUTINES_MAX: usize = 40;

/// How a run's result is shown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Show {
    /// The Routines window opens beside the robot, on the result.
    #[default]
    Card,
    /// The robot says its first line; the rest waits in the Routines window.
    Pop,
    /// A Windows notification.
    Toast,
}

/// How the last run went.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Done,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Last {
    pub slot: String, // the time it ran for ("" when run by hand)
    pub at: i64,      // when it finished (ms)
    pub outcome: Outcome,
    pub text: String, // the result, or why there's none
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub emoji: String,
    pub robot: String, // the robot that runs it (its id)
    pub prompt: String,
    pub when: When,
    #[serde(default)]
    pub show: Show,
    #[serde(default = "yes")]
    pub on: bool,
    #[serde(default = "yes")]
    pub catch_up: bool,
    #[serde(default = "limit")]
    pub limit_min: u32,
    pub created_at: i64, // (ms)
    #[serde(default)]
    pub slot: String, // the last time it was due and ran for (a slot)
    #[serde(default)]
    pub last: Option<Last>,
}

fn yes() -> bool {
    true
}

fn limit() -> u32 {
    LIMIT_MIN
}

/// A run under way.
#[derive(Clone)]
struct Run {
    id: String,
    routine: String,
    robot: String,
    slot: String,
    started: i64,
}

#[derive(Default)]
struct Routines {
    list: Vec<Routine>,
    saved: Option<Saved>,
    runs: HashMap<String, Run>, // run id -> it
}

impl Routines {
    fn get(&self, id: &str) -> Option<&Routine> {
        self.list.iter().find(|r| r.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Routine> {
        self.list.iter_mut().find(|r| r.id == id)
    }

    fn running(&self, routine: &str) -> bool {
        self.runs.values().any(|r| r.routine == routine)
    }

    /// Written now (they change seldom: an edit, a run's end).
    fn save(&mut self) {
        let data = json!({ "routines": self.list });
        if let Some(s) = &mut self.saved {
            s.flush(&data);
        }
    }

    /// One by one, so a routine that doesn't read (from a newer C-Bot) doesn't lose the rest.
    fn read(data: Option<Value>) -> Vec<Routine> {
        data.and_then(|d| d["routines"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| serde_json::from_value(r).ok())
            .collect()
    }
}

fn routines<R>(app: &AppHandle, f: impl FnOnce(&mut Routines) -> R) -> Option<R> {
    part_if(app, f)
}

fn now_ms() -> i64 {
    crate::store::now_ms()
}

/// Your clock's time now, as routines read it.
fn local_now() -> NaiveDateTime {
    Local::now().naive_local()
}

fn local_of(ms: i64) -> NaiveDateTime {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map_or_else(local_now, |t| t.naive_local())
}

/// The robots, as the window lists them: { id, name }.
fn robot_list(app: &AppHandle) -> Vec<(String, String)> {
    with(app, |st| {
        st.store
            .list()
            .iter()
            .map(|c| (c.id().to_string(), c.name().to_string()))
            .collect()
    })
}

/// A routine as the window shows it: what's saved, when it runs next, whether it's running.
fn view_of(r: &Routine, running: bool, names: &[(String, String)], now: NaiveDateTime) -> Value {
    let mut v = serde_json::to_value(r).unwrap_or_default();
    let next: Vec<String> = if r.on {
        r.when
            .next(now, 3)
            .into_iter()
            .map(schedule::slot_label)
            .collect()
    } else {
        vec![]
    };
    let robot_name = names
        .iter()
        .find(|n| n.0 == r.robot)
        .map_or("", |n| n.1.as_str());
    if let Some(o) = v.as_object_mut() {
        o.insert("whenLabel".into(), json!(r.when.label()));
        o.insert("next".into(), json!(next));
        o.insert("running".into(), json!(running));
        o.insert("robotName".into(), json!(robot_name));
    }
    v
}

/// Every routine and the robots, as the window shows them.
fn view(app: &AppHandle) -> Value {
    let names = robot_list(app);
    let now = local_now();
    let list = routines(app, |s| {
        s.list
            .iter()
            .map(|r| view_of(r, s.running(&r.id), &names, now))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    let robots: Vec<Value> = names
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect();
    json!({ "routines": list, "robots": robots })
}

/// Something changed: the window shows it.
fn changed(app: &AppHandle) {
    if panel::is_open(app) {
        let _ = app.emit_to(panel::LABEL, "routines:list", view(app));
    }
}

/// What a short note shows of a result: its first lines, up to a sentence or two (past a
/// short lead-in, so "Here's today's fact!" comes with the fact).
fn gist(text: &str) -> String {
    const ENOUGH: usize = 100;
    const MAX: usize = 200;
    let mut out = String::new();
    for l in text.lines().map(|l| {
        l.trim()
            .trim_start_matches(['#', '*', '-', '>', ' '])
            .trim_end_matches('*')
    }) {
        if l.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(l);
        if out.chars().count() >= ENOUGH {
            break;
        }
    }
    if out.chars().count() > MAX {
        format!("{}…", out.chars().take(MAX).collect::<String>().trim_end())
    } else {
        out
    }
}

// ---------------------------------------------------------------- for the others

/// Open the Routines window beside this robot (the nearest if none).
pub fn open_window(app: &AppHandle, robot_id: Option<String>) {
    let robot = robot_id.or_else(|| hub::nearest_robot(app).or_else(|| hub::notes_robot(app)));
    panel::open(app, robot, json!({ "view": "list" }), true);
}

/// A robot is deleted: its routines go too.
pub fn robot_deleted(app: &AppHandle, robot_id: &str) {
    let gone = routines(app, |s| {
        let before = s.list.len();
        s.list.retain(|r| r.robot != robot_id);
        let gone = s.list.len() != before;
        if gone {
            s.save();
        }
        gone
    });
    if gone == Some(true) {
        changed(app);
    }
}

pub fn setup(app: &AppHandle) {
    let dir = with(app, |st| st.data_dir.clone());
    let saved = Saved::new(&dir, "routines", "routines", true);
    let list = Routines::read(saved.load());
    app.manage(Mutex::new(Routines {
        list,
        saved: Some(saved),
        runs: HashMap::new(),
    }));
    panel::setup(app);
    watch(app.clone());
}

/// Looks once a minute, a little after C-Bot starts, and soon after the PC wakes up.
fn watch(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        let mut last = SystemTime::now();
        let mut waited = Duration::ZERO;
        loop {
            thread::sleep(Duration::from_secs(1));
            let t = SystemTime::now();
            let slept = t
                .duration_since(last)
                .is_ok_and(|d| d > Duration::from_secs(30));
            last = t;
            waited += Duration::from_secs(1);
            if slept {
                waited = CHECK_EVERY - BACK_CHECK;
            }
            if waited >= CHECK_EVERY {
                waited = Duration::ZERO;
                check(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json() {
        let r = Routine {
            id: "r1".into(),
            name: "Morning news".into(),
            emoji: "📰".into(),
            robot: "c1".into(),
            prompt: "News on AI chips".into(),
            when: When::Daily {
                days: vec![1, 2, 3, 4, 5],
                times: vec!["08:00".into()],
            },
            show: Show::Card,
            on: true,
            catch_up: true,
            limit_min: 10,
            created_at: 5,
            slot: "2026-10-28T08:00".into(),
            last: Some(Last {
                slot: "2026-10-28T08:00".into(),
                at: 9,
                outcome: Outcome::Done,
                text: "Five stories".into(),
            }),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            json!({
                "id": "r1", "name": "Morning news", "emoji": "📰", "robot": "c1", "prompt": "News on AI chips",
                "when": { "kind": "daily", "days": [1, 2, 3, 4, 5], "times": ["08:00"] },
                "show": "card", "on": true, "catchUp": true, "limitMin": 10, "createdAt": 5, "slot": "2026-10-28T08:00",
                "last": { "slot": "2026-10-28T08:00", "at": 9, "outcome": "done", "text": "Five stories" },
            })
        );
        // what's missing reads as the defaults; one that doesn't read is left out
        let list = Routines::read(Some(json!({ "routines": [
            { "id": "r2", "name": "PRs", "robot": "c1", "prompt": "x", "when": { "kind": "once", "at": "2026-10-30T14:00" }, "createdAt": 1 },
            { "id": "bad" },
        ] })));
        assert_eq!(list.len(), 1);
        assert_eq!(
            (
                list[0].show,
                list[0].on,
                list[0].catch_up,
                list[0].limit_min
            ),
            (Show::Card, true, true, LIMIT_MIN)
        );
        assert_eq!(serde_json::to_value(Show::Toast).unwrap(), json!("toast"));
    }

    #[test]
    fn its_gist() {
        assert_eq!(
            gist(
                "\n## **Five AI chip stories today, led by TSMC's record orders and a new Nvidia deal**\n\n- one"
            ),
            "Five AI chip stories today, led by TSMC's record orders and a new Nvidia deal one"
        );
        // past a short lead-in
        assert_eq!(
            gist("Here's your fact!\n\nHelium was found in the Sun before it was found on Earth."),
            "Here's your fact! Helium was found in the Sun before it was found on Earth."
        );
        assert_eq!(gist(""), "");
        assert_eq!(gist(&"a".repeat(300)).chars().count(), 201);
    }
}
