//! Your notes (main notes.js, notebook.js, and main.js's notes handlers, reminders,
//! askAboutNote, summariseDay and the note hotkey): one notebook for all your robots, kept
//! in notes.json; each desk's corkboard shows the open ones; the notebook window
//! ("notebook") opens beside a robot. [wave 2: words & notes]
//!
//! The robot pins new notes up and tosses done ones in its wastebasket. At the end of your
//! workday, and the first time you're at the PC on a workday, a robot holds up its board
//! and the notebook opens with a reminder (with no robot out, a Windows notification).
//!
//! Locks: this module's state (Notes) is never held while calling out of it: not into a
//! window, the robots' state (with()), the tray or another module.

mod actions;
mod book;
mod commands;
mod notebook;
mod reminders;

pub use actions::*;
pub use commands::*;
use reminders::*;

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use chrono::Local;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::platform::{clipboard, input, presence};
use crate::robots;
use crate::robots::walkers;
use crate::runtime::hub::Hotkey;
use crate::runtime::util::{only, text};
use crate::runtime::{Error, Locked, hub, part_if, with};
use crate::store::saved::Saved;
use crate::ui::tray;
use crate::workbench::capture;

use book::{Due, NoteClock, Notes, Reminder};
use notebook::Ctx;

const BOARD_MAX: usize = 5;
const CHECK_EVERY: Duration = Duration::from_secs(60);
const FIRST_CHECK: Duration = Duration::from_secs(15); // a little after C-Bot starts
const BACK_CHECK: Duration = Duration::from_secs(4); // back at the PC: maybe the start of your day
const AWAY_AFTER: u64 = 120; // s without touching mouse or keyboard: you're not there
const WALK_BACK_MS: u64 = 1800; // a robot out walking needs this long to get back to its desk

struct State {
    notes: Notes,
    saved: Saved,
    clock: NoteClock,
}

fn state<R>(app: &AppHandle, f: impl FnOnce(&mut State) -> R) -> Option<R> {
    // (None before setup: the tray asks for the count while it's being built)
    part_if(app, |st: &mut State| {
        let out = f(st);
        if st.notes.dirty {
            st.notes.dirty = false;
            st.saved.save();
        }
        out
    })
}

fn notes<R>(app: &AppHandle, f: impl FnOnce(&mut Notes) -> R) -> Option<R> {
    state(app, |s| f(&mut s.notes))
}

fn now() -> i64 {
    crate::store::now_ms()
}

fn settings(app: &AppHandle) -> Value {
    with(app, |st| st.store.settings().clone())
}

/// Tell a robot what happens with your notes (it acts it out: robot.ts robot:notes).
fn tell(app: &AppHandle, id: Option<&str>, payload: Value) {
    if let Some(id) = id {
        hub::send_to_robot(app, id, "robot:notes", payload);
    }
}

/// Every note and the board, as the notebook shows them.
fn view(app: &AppHandle) -> Value {
    let t = now();
    notes(
        app,
        |n| json!({ "notes": n.list(), "board": n.board(BOARD_MAX, t) }),
    )
    .unwrap_or_else(|| json!({ "notes": [], "board": { "items": [], "total": 0 } }))
}

/// A note changed: the notebook shows it, and every corkboard.
fn after_change(app: &AppHandle) {
    if notebook::is_open(app) {
        let _ = app.emit_to(notebook::LABEL, "notebook:notes", view(app));
    }
    changed(app);
}

// ---------------------------------------------------------------- for the others

/// What this robot's corkboard shows (main.js boardFor): every desk has one, or just the
/// reminding robot's when you've picked one in the Workshop.
pub fn board_for(app: &AppHandle, robot_id: &str) -> Value {
    let s = settings(app);
    let pick = s["notesRobot"].as_str().unwrap_or("");
    if s["notesBoard"] == "one"
        && pick != robot_id
        && robots::open_ids(app).iter().any(|i| i == pick)
    {
        return json!({ "items": [], "total": 0, "hidden": true });
    }
    let t = now();
    notes(app, |n| n.board(BOARD_MAX, t)).unwrap_or_else(|| json!({ "items": [], "total": 0 }))
}

/// The note hotkey's keys.
pub fn hotkey(app: &AppHandle) -> String {
    crate::runtime::hub::hotkey_keys(app, "noteHotkey", "Ctrl+Alt+N")
}

/// How many notes are still open.
pub fn open_count(app: &AppHandle) -> usize {
    notes(app, |n| n.open().len()).unwrap_or(0)
}

/// Open the notebook beside this robot (the nearest if none); focus: "add" for the add
/// box, a note's id, or none.
pub fn open_notebook(app: &AppHandle, robot_id: Option<String>, focus: Option<&str>) {
    let robot = robot_id.or_else(|| default_robot(app));
    open_book(
        app,
        robot,
        focus.map_or(Value::Null, |f| json!(f)),
        Value::Null,
        true,
        String::new(),
        String::new(),
    );
}

/// The notebook beside this robot with the add box ready and this text in it (the palette's
/// "Note it down", the note hotkey with something selected); source: where it came from.
pub fn take_note(app: &AppHandle, robot_id: Option<String>, text: &str, source: &str) {
    let robot = robot_id.or_else(|| default_robot(app));
    let text: String = text.chars().take(2000).collect();
    let source = if text.is_empty() {
        String::new()
    } else {
        source.to_string()
    };
    open_book(app, robot, json!("add"), Value::Null, true, text, source);
}

/// The notes or their settings changed (which robot's board shows them): every desk's
/// corkboard again (main.js notesChanged).
pub fn changed(app: &AppHandle) {
    for id in robots::open_ids(app) {
        let board = board_for(app, &id);
        tell(app, Some(&id), json!({ "phase": "board", "board": board }));
    }
    tray::refresh(app);
}

/// The notebook is open.
pub fn notebook_open(app: &AppHandle) -> bool {
    notebook::is_open(app)
}

/// Add a note (the group chat's "note it"); its source says where it came from.
pub fn add(app: &AppHandle, text: &str, source: &str) -> Value {
    let note = notes(app, |n| n.add(text, false, source, now())).flatten();
    if note.is_some() {
        after_change(app);
    }
    note.unwrap_or(Value::Null)
}

/// Your notes, for a robot's chat (its list_notes tool): the open ones, important first,
/// and with done, the ones ticked off lately too.
pub fn list_for_chat(app: &AppHandle, done: bool) -> String {
    let t = now();
    let Some((open, ticked)) = notes(app, |n| {
        let ticked: Vec<Value> = if done {
            n.list()
                .into_iter()
                .filter(|x| x["doneAt"].as_i64().is_some_and(|d| d != 0))
                .take(20)
                .collect()
        } else {
            vec![]
        };
        (n.open(), ticked)
    }) else {
        return "Your notebook isn't loaded yet.".into();
    };
    let when = |n: &Value| match book::age(n, t) {
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        d => format!("{d} days ago"),
    };
    let line = |n: &Value, mark: &str| {
        format!(
            "- {mark}{} _(noted {})_",
            text(&n["text"]).replace('\n', " / "),
            when(n)
        )
    };
    let mut out = if open.is_empty() {
        "Nothing left to do in your notebook.".to_string()
    } else {
        let lines: Vec<String> = open
            .iter()
            .map(|n| line(n, if n["important"] == true { "⭐ " } else { "" }))
            .collect();
        format!(
            "{} open note{}:\n{}",
            open.len(),
            if open.len() == 1 { "" } else { "s" },
            lines.join("\n")
        )
    };
    if done {
        out.push_str(&if ticked.is_empty() {
            "\n\nNo notes ticked off lately.".to_string()
        } else {
            format!(
                "\n\nDone lately:\n{}",
                ticked
                    .iter()
                    .map(|n| line(n, "✓ "))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        });
    }
    out
}

/// A note, asked for in a robot's chat (its add_note tool): it pins it up on its board.
pub fn add_for_chat(
    app: &AppHandle,
    robot_id: &str,
    text: &str,
    important: bool,
) -> Result<String, Error> {
    let Some(note) = notes(app, |n| n.add(text, important, "chat", now())).flatten() else {
        return Err("The note is empty.".into());
    };
    after_change(app);
    tell(
        app,
        Some(robot_id),
        json!({ "phase": "added", "note": note, "quiet": true }),
    );
    Ok(format!(
        "Noted{}: {}",
        if note["important"] == true {
            " (⭐ important)"
        } else {
            ""
        },
        crate::runtime::util::text(&note["text"])
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_summed_up() {
        let start = 1000;
        let list = vec![
            json!({ "id": "a", "text": "ship it\n\nnow", "important": true, "createdAt": 1500, "doneAt": null }),
            json!({ "id": "b", "text": "old, done today", "createdAt": 10, "doneAt": 1200 }),
            json!({ "id": "c", "text": "old, open", "createdAt": 20, "doneAt": null }),
        ];
        let open = vec![list[0].clone(), list[2].clone()];
        let p = day_summary(&list, &open, start).unwrap();
        assert!(p.starts_with("Summarise my day from my notebook"));
        assert!(p.contains("Today's notes:\n- (important) ship it now\n- [done] old, done today\n\nStill open from before:\n- old, open"));
        assert_eq!(day_summary(&[], &[], start), None);
        // nothing from before: no "still open" part
        let p = day_summary(&list[..1], &open[..1], start).unwrap();
        assert!(!p.contains("Still open"));
    }
}
