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

mod book;
mod notebook;

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use chrono::Local;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::platform::{clipboard, input, presence};
use crate::robots;
use crate::robots::walkers;
use crate::runtime::{hub, with};
use crate::runtime::hub::Hotkey;
use crate::runtime::util::{only, text};
use crate::store::saved::Saved;
use crate::ui::tray;
use crate::workbench::capture;

use book::{Due, NoteClock, Notes};
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
    let st = app.try_state::<Mutex<State>>()?;
    let mut guard = st.lock().unwrap_or_else(|e| e.into_inner());
    let out = f(&mut guard);
    if guard.notes.dirty {
        guard.notes.dirty = false;
        guard.saved.save();
    }
    Some(out)
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
    notes(app, |n| json!({ "notes": n.list(), "board": n.board(BOARD_MAX, t) })).unwrap_or_else(|| json!({ "notes": [], "board": { "items": [], "total": 0 } }))
}

/// A note changed: the notebook shows it, and every corkboard.
fn after_change(app: &AppHandle) {
    if notebook::is_open(app) {
        let _ = app.emit_to(notebook::LABEL, "notebook:notes", view(app));
    }
    changed(app);
}

// ---------------------------------------------------------------- the notebook

/// Open the notebook beside this robot (None: by the mouse) and the robot looks up.
fn open_book(app: &AppHandle, robot: Option<String>, focus: Value, reminder: Value, activate: bool, text: String, source: String) {
    let near = robot.as_deref().and_then(|r| hub::robot_rect(app, r));
    let r = robot.clone();
    notebook::open(app, Ctx { robot_id: robot, near, focus, reminder, text, source }, activate);
    tell(app, r.as_deref(), json!({ "phase": "opened" }));
}

/// The notebook opened from a reminder the robot island held (robots/island.rs).
pub fn open_reminder(app: &AppHandle, robot: Option<String>, reminder: Value) {
    open_book(app, robot, Value::Null, reminder, true, String::new(), String::new());
}

fn default_robot(app: &AppHandle) -> Option<String> {
    hub::nearest_robot(app).or_else(|| hub::notes_robot(app))
}

/// The notebook closed: after the end-of-day reminder (you've had your look), the robot
/// clocks out.
fn notebook_closed(app: &AppHandle, ctx: &Ctx) {
    if ctx.reminder["kind"] == "evening" {
        tell(app, ctx.robot_id.as_deref(), json!({ "phase": "clockout" }));
    }
}

/// The note hotkey: the notebook with the add box ready (and whatever's selected, already in it).
fn capture_note(app: &AppHandle) {
    let sel = capture::read_selection(app, &hotkey(app), false);
    let text: String = sel.text.chars().take(2000).collect();
    let source = if text.is_empty() { String::new() } else { sel.source };
    open_book(app, default_robot(app), json!("add"), Value::Null, true, text, source);
}

/// "Ask Claude" on a note: the robot takes it on in a new chat tab (robot.ts); the note
/// shows 🔧 on the board while it's being worked on.
fn ask_about(app: &AppHandle, note_id: &str, robot: Option<&str>) -> bool {
    let note = notes(app, |n| n.get(note_id)).flatten();
    let id = hub::chatty_robot(app, robot);
    let (Some(note), Some(id)) = (note, id) else { return false };
    notes(app, |n| n.update(note_id, &json!({ "working": true })));
    after_change(app);
    notebook::close(app);
    let prompt = format!("Here's a note from my notebook. Help me get it done (look into it in this folder if that's useful):\n\n{}", text(&note["text"]));
    tell_soon(app, &id, json!({ "phase": "ask", "note": note, "prompt": prompt }));
    true
}

/// A robot that was called back to its desk hears it once it's there.
fn tell_soon(app: &AppHandle, id: &str, payload: Value) {
    let wait = if walkers::has(app, id) { WALK_BACK_MS } else { 0 };
    let (app, id) = (app.clone(), id.to_string());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(wait));
        tell(&app, Some(&id), payload);
    });
}

/// The prompt that sums up the day: today's notes, and the ones still open from before.
fn day_summary(list: &[Value], open: &[Value], start: i64) -> Option<String> {
    let done_at = |n: &Value| n["doneAt"].as_i64().filter(|&d| d != 0);
    let created = |n: &Value| n["createdAt"].as_i64().unwrap_or(0);
    let today: Vec<&Value> = list.iter().filter(|n| created(n) >= start || done_at(n).is_some_and(|d| d >= start)).collect();
    let before: Vec<&Value> = open.iter().filter(|n| !today.iter().any(|t| t["id"] == n["id"])).collect();
    if today.is_empty() && before.is_empty() {
        return None;
    }
    let line = |n: &&Value| {
        // (on one line: each run of line breaks a space)
        static BREAKS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let breaks = BREAKS.get_or_init(|| regex::Regex::new(r"\n+").unwrap());
        let flat = breaks.replace_all(&text(&n["text"]), " ").into_owned();
        format!(
            "- {}{}{}",
            if done_at(n).is_some() { "[done] " } else { "" },
            if n["important"].as_bool().unwrap_or(false) { "(important) " } else { "" },
            flat
        )
    };
    let mut lines = vec![
        "Summarise my day from my notebook, as a short update I can paste into a stand-up or a report:".to_string(),
        "a few bullet points (done, in progress, next), plain and friendly, no preamble. Just the notes, no need to look at files.".to_string(),
        String::new(),
        "Today's notes:".to_string(),
    ];
    lines.extend(today.iter().map(line));
    if !before.is_empty() {
        lines.push(String::new());
        lines.push("Still open from before:".into());
        lines.extend(before.iter().map(line));
    }
    Some(lines.join("\n"))
}

/// "Summarise my day": the robot asks Claude for a short recap of today's notes, to paste
/// into a stand-up.
fn summarise_day(app: &AppHandle, robot: Option<&str>) -> bool {
    let Some(id) = hub::chatty_robot(app, robot) else { return false };
    let start = book::start_of_day(Local::now());
    let Some(Some(prompt)) = notes(app, |n| day_summary(&n.list(), &n.open(), start)) else { return false };
    notebook::close(app);
    tell_soon(app, &id, json!({ "phase": "ask", "prompt": prompt, "summary": true }));
    true
}

/// What the notebook passes on (notebook.js onAction): the robot acts it out, Claude, the
/// reminder clock.
fn on_action(app: &AppHandle, action: &str, ctx: &Ctx, p: &Value) -> Value {
    let robot = ctx.robot_id.as_deref();
    match action {
        "typing" => {
            // you're writing a note: the robot writes it down too (robot.ts notewrite)
            tell(app, robot, json!({ "phase": "writing", "on": p["on"].as_bool().unwrap_or(false) }));
            Value::Null
        }
        "ask" => json!(ask_about(app, &text(&p["id"]), robot)),
        "summary" => json!(summarise_day(app, robot)),
        "snooze" => {
            let kind = ctx.reminder["kind"].as_str().filter(|k| !k.is_empty()).unwrap_or("evening").to_string();
            let minutes = p["minutes"].as_f64().filter(|m| *m != 0.0 && m.is_finite()).unwrap_or(15.0);
            state(app, |s| s.clock.snooze(&kind, minutes as i64, now()));
            notebook::clear_reminder(app);
            notebook::close(app);
            Value::Null
        }
        "done-for-today" => {
            let evening = ctx.reminder["kind"] == "evening";
            state(app, |s| s.clock.done_for_today(&mut s.notes, Local::now()));
            notebook::clear_reminder(app);
            notebook::close(app);
            if evening {
                tell(app, robot, json!({ "phase": "clockout" }));
            }
            json!(true)
        }
        _ => Value::Null,
    }
}

/// What you do in the notebook (notebook:act).
fn act(app: &AppHandle, action: &str, p: &Value) -> Value {
    let ctx = notebook::ctx(app);
    let id = text(&p["id"]);
    match action {
        "add" => {
            let source = text(&p["source"]);
            let Some(Some(note)) = notes(app, |n| n.add(&text(&p["text"]), p["important"].as_bool().unwrap_or(false), &source, now())) else { return Value::Null };
            after_change(app);
            tell(app, ctx.robot_id.as_deref(), json!({ "phase": "added", "note": note }));
            note
        }
        "edit" => {
            let note = notes(app, |n| n.update(&id, &json!({ "text": p["text"], "important": p["important"] }))).flatten();
            after_change(app);
            note.unwrap_or(Value::Null)
        }
        "done" => {
            let done = p["done"].as_bool().unwrap_or(false);
            let Some((Some(note), changed, left)) = notes(app, |n| {
                let (note, changed) = n.set_done(&id, done, now());
                (note, changed, n.open().len())
            }) else {
                return Value::Null;
            };
            if changed {
                after_change(app);
            }
            if done {
                tell(app, ctx.robot_id.as_deref(), json!({ "phase": "done", "note": note, "left": left }));
            }
            note
        }
        "delete" => {
            let gone = notes(app, |n| n.remove(&id)).flatten();
            notebook::set_undo(app, gone.clone());
            let Some(gone) = gone else { return Value::Null };
            after_change(app);
            json!({ "id": gone["id"] })
        }
        "undo-delete" => {
            let Some(note) = notebook::take_undo(app) else { return Value::Null };
            let back = notes(app, |n| n.restore(note)).flatten();
            if back.is_some() {
                after_change(app);
            }
            back.unwrap_or(Value::Null)
        }
        "clear-done" => {
            if notes(app, |n| n.clear_done()) == Some(true) {
                after_change(app);
            }
            Value::Null
        }
        "copy" => {
            let note = notes(app, |n| n.get(&id)).flatten();
            if let Some(n) = &note {
                clipboard::set_text(&text(&n["text"]));
            }
            json!(note.is_some())
        }
        "copy-all" => {
            let (open, done) = notes(app, |n| (n.open(), n.list().into_iter().filter(|x| x["doneAt"].as_i64().is_some_and(|d| d != 0)).collect::<Vec<_>>())).unwrap_or_default();
            let line = |n: &Value| {
                let done = n["doneAt"].as_i64().is_some_and(|d| d != 0);
                let important = if n["important"].as_bool().unwrap_or(false) { "(!) " } else { "" };
                format!("{} {important}{}", if done { "[x]" } else { "[ ]" }, text(&n["text"]).replace('\n', " "))
            };
            let all: Vec<String> = open.iter().chain(done.iter()).map(line).collect();
            clipboard::set_text(&all.join("\n"));
            json!(all.len())
        }
        "close" => {
            notebook::close(app);
            Value::Null
        }
        // the rest is up to the robot, Claude and the reminder clock
        _ => on_action(app, action, &ctx, p),
    }
}

// ---------------------------------------------------------------- the daily reminders

/// A daily reminder is due: a robot holds up its corkboard and the notebook opens (robot.ts
/// asks for it with notes:remind-open). It waits while that robot's busy; with no robot out,
/// a Windows notification. False: it couldn't be shown now (tried again on the next check).
fn remind(app: &AppHandle, kind: &str, info: &Value) -> bool {
    let summary = json!({ "today": info["today"], "open": info["open"], "taken": info["taken"] });
    let Some(id) = hub::notes_robot(app) else {
        use tauri_plugin_notification::NotificationExt;
        let title = if kind == "morning" { "🌅 Your notes from yesterday" } else { "🌇 Before you go: your notes" };
        let body: Vec<String> = info["notes"]
            .as_array()
            .into_iter()
            .flatten()
            .take(4)
            .map(|n| {
                let done = n["doneAt"].as_i64().is_some_and(|d| d != 0);
                format!("{} {}", if done { "✓" } else { "•" }, text(&n["text"]).split('\n').next().unwrap_or(""))
            })
            .collect();
        // (a click on it can't open the notebook here: the plugin doesn't say when it's clicked)
        if let Err(err) = app.notification().builder().title(title).body(body.join("\n")).show() {
            eprintln!("[notes] couldn't show the reminder: {err}");
            return false;
        }
        return true;
    };
    // away on the island: the island holds it up for you, the robot stays put (busy or not)
    if robots::is_away(app, &id) {
        let title = if kind == "morning" { "Your notes from yesterday" } else { "Before you go: your notes" };
        let open = info["open"].as_i64().unwrap_or(0);
        let text = if open > 0 { format!("{title} ({open} open)") } else { title.to_string() };
        let reminder = json!({ "kind": kind, "info": { "today": summary["today"], "open": summary["open"], "taken": summary["taken"], "line": text } });
        return crate::robots::island::say(app, &id, "notes", &text, Some(reminder));
    }
    if hub::robot_busy(app, &id) {
        return false;
    }
    tell(app, Some(&id), json!({ "phase": "remind", "kind": kind, "info": summary }));
    true
}

/// Is a reminder due? Then show it (once it has been, not again today).
fn check(app: &AppHandle) {
    let present = !presence::locked() && input::idle_secs() < AWAY_AFTER;
    let c = book::cfg(&settings(app));
    let d = Local::now();
    let Some(Some((due, info))) = state(app, |s| {
        let due: Due = s.clock.due(&s.notes, &c, d, present)?;
        let info = book::gather(&s.notes, &due.kind, d, &c);
        Some((due, info))
    }) else {
        return;
    };
    // nothing to say: counts as done for today
    let shown = info["notes"].as_array().is_none_or(Vec::is_empty) || remind(app, &due.kind, &info);
    if shown {
        state(app, |s| NoteClock::shown(&mut s.notes, &due, d));
    }
}

/// Checks once a minute, a little after C-Bot starts, and whenever you're back at the PC (an
/// unlock, waking from sleep).
fn watch(app: AppHandle) {
    thread::spawn(move || {
        let mut next = Instant::now() + FIRST_CHECK;
        let mut was_locked = presence::locked();
        let mut last = SystemTime::now();
        loop {
            thread::sleep(Duration::from_secs(2));
            let t = SystemTime::now();
            let slept = t.duration_since(last).is_ok_and(|d| d > Duration::from_secs(30));
            last = t;
            let is_locked = presence::locked();
            if slept || (was_locked && !is_locked) {
                next = next.min(Instant::now() + BACK_CHECK);
            }
            was_locked = is_locked;
            if Instant::now() >= next {
                next = Instant::now() + CHECK_EVERY;
                check(&app);
            }
        }
    });
}

// ---------------------------------------------------------------- for the others

/// What this robot's corkboard shows (main.js boardFor): every desk has one, or just the
/// reminding robot's when you've picked one in the Workshop.
pub fn board_for(app: &AppHandle, robot_id: &str) -> Value {
    let s = settings(app);
    let pick = s["notesRobot"].as_str().unwrap_or("");
    if s["notesBoard"] == "one" && pick != robot_id && robots::open_ids(app).iter().any(|i| i == pick) {
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
    open_book(app, robot, focus.map_or(Value::Null, |f| json!(f)), Value::Null, true, String::new(), String::new());
}

/// The notebook beside this robot with the add box ready and this text in it (the palette's
/// "Note it down", the note hotkey with something selected); source: where it came from.
pub fn take_note(app: &AppHandle, robot_id: Option<String>, text: &str, source: &str) {
    let robot = robot_id.or_else(|| default_robot(app));
    let text: String = text.chars().take(2000).collect();
    let source = if text.is_empty() { String::new() } else { source.to_string() };
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
        let ticked: Vec<Value> = if done { n.list().into_iter().filter(|x| x["doneAt"].as_i64().is_some_and(|d| d != 0)).take(20).collect() } else { vec![] };
        (n.open(), ticked)
    }) else {
        return "Your notebook isn't loaded yet.".into();
    };
    let when = |n: &Value| match book::age(n, t) {
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        d => format!("{d} days ago"),
    };
    let line = |n: &Value, mark: &str| format!("- {mark}{} _(noted {})_", text(&n["text"]).replace('\n', " / "), when(n));
    let mut out = if open.is_empty() {
        "Nothing left to do in your notebook.".to_string()
    } else {
        let lines: Vec<String> = open.iter().map(|n| line(n, if n["important"] == true { "⭐ " } else { "" })).collect();
        format!("{} open note{}:\n{}", open.len(), if open.len() == 1 { "" } else { "s" }, lines.join("\n"))
    };
    if done {
        out.push_str(&if ticked.is_empty() { "\n\nNo notes ticked off lately.".to_string() } else { format!("\n\nDone lately:\n{}", ticked.iter().map(|n| line(n, "✓ ")).collect::<Vec<_>>().join("\n")) });
    }
    out
}

/// A note, asked for in a robot's chat (its add_note tool): it pins it up on its board.
pub fn add_for_chat(app: &AppHandle, robot_id: &str, text: &str, important: bool) -> Result<String, String> {
    let Some(note) = notes(app, |n| n.add(text, important, "chat", now())).flatten() else {
        return Err("The note is empty.".into());
    };
    after_change(app);
    tell(app, Some(robot_id), json!({ "phase": "added", "note": note, "quiet": true }));
    Ok(format!("Noted{}: {}", if note["important"] == true { " (⭐ important)" } else { "" }, crate::runtime::util::text(&note["text"])))
}

// ---------------------------------------------------------------- commands

/// A robot's: the corkboard was clicked (or /notes). focus: 'add', or a note's id.
#[tauri::command(async)]
pub fn notes_open(app: AppHandle, window: tauri::WebviewWindow, opts: Option<Value>) {
    let focus = opts.unwrap_or_default()["focus"].clone();
    open_book(&app, robots::id_of(window.label()).map(str::to_string), focus, Value::Null, true, String::new(), String::new());
}

/// /note …
#[tauri::command(async)]
pub fn notes_add(app: AppHandle, window: tauri::WebviewWindow, text: String) -> Value {
    let note = add(&app, &text, "chat");
    if !note.is_null() {
        tell(&app, robots::id_of(window.label()), json!({ "phase": "added", "note": note, "quiet": true }));
    }
    note
}

/// The chat's side of "Ask Claude": Claude's on it, or it's done.
#[tauri::command(async)]
pub fn notes_act(app: AppHandle, window: tauri::WebviewWindow, action: String, p: Option<Value>) -> Value {
    let p = p.unwrap_or_default();
    match action.as_str() {
        "working" => {
            let note = notes(&app, |n| n.update(&text(&p["id"]), &json!({ "working": p["working"].as_bool().unwrap_or(false) }))).flatten();
            after_change(&app);
            note.unwrap_or(Value::Null)
        }
        "done" => {
            let Some((Some(note), changed, left)) = notes(&app, |n| {
                let (note, changed) = n.set_done(&text(&p["id"]), true, now());
                (note, changed, n.open().len())
            }) else {
                return Value::Null;
            };
            if changed {
                after_change(&app);
            }
            tell(&app, robots::id_of(window.label()), json!({ "phase": "done", "note": note, "left": left }));
            note
        }
        "remind-shown" => json!(true),
        _ => Value::Null,
    }
}

/// The reminder's moment is over (the robot held up its board): the notebook with the banner.
#[tauri::command(async)]
pub fn notes_remind_open(app: AppHandle, window: tauri::WebviewWindow, p: Value) {
    let reminder = json!({ "kind": p["kind"], "info": p["info"] });
    open_book(&app, robots::id_of(window.label()).map(str::to_string), Value::Null, reminder, false, String::new(), String::new());
}

// (the notebook's own: only it may ask)

#[tauri::command(async)]
pub fn notebook_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, notebook::LABEL)?;
    let ctx = notebook::ctx(&app);
    let mut v = view(&app);
    if let Some(o) = v.as_object_mut() {
        o.insert("focus".into(), ctx.focus);
        o.insert("reminder".into(), ctx.reminder);
        o.insert("text".into(), json!(ctx.text));
        o.insert("source".into(), json!(ctx.source));
    }
    Ok(v)
}

#[tauri::command(async)]
pub fn notebook_act(app: AppHandle, window: tauri::WebviewWindow, action: String, p: Option<Value>) -> Result<Value, String> {
    only(&window, notebook::LABEL)?;
    Ok(act(&app, &action, &p.unwrap_or_default()))
}

/// Write notes.json now if a change is waiting (C-Bot is quitting).
fn flush(app: &AppHandle) {
    if let Some(st) = app.try_state::<Mutex<State>>() {
        let mut s = st.lock().unwrap_or_else(|e| e.into_inner());
        let State { notes, saved, .. } = &mut *s;
        if notes.dirty {
            notes.dirty = false;
            saved.save();
        }
        saved.flush_pending(&notes.data);
    }
}

pub fn setup(app: &AppHandle) {
    let dir = with(app, |st| st.data_dir.clone());
    let saved = Saved::new(&dir, "notes", "notes", true);
    saved.import(crate::runtime::paths::electron_data_dir());
    let notes = Notes::from(saved.load(), now());
    app.manage(Mutex::new(State { notes, saved, clock: NoteClock::default() }));
    notebook::setup(app);
    // (what's waiting is written as C-Bot quits)
    let quitting = tauri::plugin::Builder::<tauri::Wry>::new("cbot-notes")
        .on_event(|app, e| {
            if let RunEvent::Exit = e {
                flush(app);
            }
        })
        .build();
    if let Err(err) = app.plugin(quitting) {
        eprintln!("[notes] couldn't watch for quitting: {err}");
    }
    hub::add_hotkey(app, Hotkey {
        setting: "noteHotkey",
        label: "Take a note",
        what: "The notebook, with what you selected in it",
        default: "Ctrl+Alt+N",
        run: capture_note,
    });
    // changes are saved a moment after they happen
    let a = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        if let Some(st) = a.try_state::<Mutex<State>>() {
            let mut s = st.lock().unwrap_or_else(|e| e.into_inner());
            let State { notes, saved, .. } = &mut *s;
            saved.tick(&notes.data);
        }
    });
    watch(app.clone());
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
