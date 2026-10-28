//! What you do in the notebook: open it, take a note (with what you'd selected), ask a robot about one, sum up the day; act() runs what its page asks.

use super::*;

/// Open the notebook beside this robot (None: by the mouse) and the robot looks up.
pub(super) fn open_book(
    app: &AppHandle,
    robot: Option<String>,
    focus: Value,
    reminder: Value,
    activate: bool,
    text: String,
    source: String,
) {
    let near = robot.as_deref().and_then(|r| hub::robot_rect(app, r));
    let r = robot.clone();
    notebook::open(
        app,
        Ctx {
            robot_id: robot,
            near,
            focus,
            reminder,
            text,
            source,
        },
        activate,
    );
    tell(app, r.as_deref(), json!({ "phase": "opened" }));
}

/// The notebook opened from a reminder the robot island held (robots/island.rs).
pub fn open_reminder(app: &AppHandle, robot: Option<String>, reminder: Value) {
    open_book(
        app,
        robot,
        Value::Null,
        reminder,
        true,
        String::new(),
        String::new(),
    );
}

pub(super) fn default_robot(app: &AppHandle) -> Option<String> {
    hub::nearest_robot(app).or_else(|| hub::notes_robot(app))
}

/// The notebook closed: after the end-of-day reminder (you've had your look), the robot
/// clocks out.
pub(super) fn notebook_closed(app: &AppHandle, ctx: &Ctx) {
    if ctx.reminder["kind"] == "evening" {
        tell(app, ctx.robot_id.as_deref(), json!({ "phase": "clockout" }));
    }
}

/// The note hotkey: the notebook with the add box ready (and whatever's selected, already in it).
pub(super) fn capture_note(app: &AppHandle) {
    let sel = capture::read_selection(app, &hotkey(app), false);
    let text: String = sel.text.chars().take(2000).collect();
    let source = if text.is_empty() {
        String::new()
    } else {
        sel.source
    };
    open_book(
        app,
        default_robot(app),
        json!("add"),
        Value::Null,
        true,
        text,
        source,
    );
}

/// "Ask Claude" on a note: the robot takes it on in a new chat tab (robot.ts); the note
/// shows 🔧 on the board while it's being worked on.
pub(super) fn ask_about(app: &AppHandle, note_id: &str, robot: Option<&str>) -> bool {
    let note = notes(app, |n| n.get(note_id)).flatten();
    let id = hub::chatty_robot(app, robot);
    let (Some(note), Some(id)) = (note, id) else {
        return false;
    };
    notes(app, |n| n.update(note_id, &json!({ "working": true })));
    after_change(app);
    notebook::close(app);
    let prompt = format!(
        "Here's a note from my notebook. Help me get it done (look into it in this folder if that's useful):\n\n{}",
        text(&note["text"])
    );
    tell_soon(
        app,
        &id,
        json!({ "phase": "ask", "note": note, "prompt": prompt }),
    );
    true
}

/// A robot that was called back to its desk hears it once it's there.
pub(super) fn tell_soon(app: &AppHandle, id: &str, payload: Value) {
    let wait = if walkers::has(app, id) {
        WALK_BACK_MS
    } else {
        0
    };
    let (app, id) = (app.clone(), id.to_string());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(wait));
        tell(&app, Some(&id), payload);
    });
}

/// The prompt that sums up the day: today's notes, and the ones still open from before.
pub(super) fn day_summary(list: &[Value], open: &[Value], start: i64) -> Option<String> {
    let done_at = |n: &Value| n["doneAt"].as_i64().filter(|&d| d != 0);
    let created = |n: &Value| n["createdAt"].as_i64().unwrap_or(0);
    let today: Vec<&Value> = list
        .iter()
        .filter(|n| created(n) >= start || done_at(n).is_some_and(|d| d >= start))
        .collect();
    let before: Vec<&Value> = open
        .iter()
        .filter(|n| !today.iter().any(|t| t["id"] == n["id"]))
        .collect();
    if today.is_empty() && before.is_empty() {
        return None;
    }
    let line = |n: &&Value| {
        // (on one line: each run of line breaks a space)
        static BREAKS: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"\n+").unwrap());
        let breaks = &*BREAKS;
        let flat = breaks.replace_all(&text(&n["text"]), " ").into_owned();
        format!(
            "- {}{}{}",
            if done_at(n).is_some() { "[done] " } else { "" },
            if n["important"].as_bool().unwrap_or(false) {
                "(important) "
            } else {
                ""
            },
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
pub(super) fn summarise_day(app: &AppHandle, robot: Option<&str>) -> bool {
    let Some(id) = hub::chatty_robot(app, robot) else {
        return false;
    };
    let start = book::start_of_day(Local::now());
    let Some(Some(prompt)) = notes(app, |n| day_summary(&n.list(), &n.open(), start)) else {
        return false;
    };
    notebook::close(app);
    tell_soon(
        app,
        &id,
        json!({ "phase": "ask", "prompt": prompt, "summary": true }),
    );
    true
}

/// What the notebook passes on (notebook.js onAction): the robot acts it out, Claude, the
/// reminder clock.
pub(super) fn on_action(app: &AppHandle, action: &str, ctx: &Ctx, p: &Value) -> Value {
    let robot = ctx.robot_id.as_deref();
    match action {
        "typing" => {
            // you're writing a note: the robot writes it down too (robot.ts notewrite)
            tell(
                app,
                robot,
                json!({ "phase": "writing", "on": p["on"].as_bool().unwrap_or(false) }),
            );
            Value::Null
        }
        "ask" => json!(ask_about(app, &text(&p["id"]), robot)),
        "summary" => json!(summarise_day(app, robot)),
        "snooze" => {
            let kind =
                serde_json::from_value(ctx.reminder["kind"].clone()).unwrap_or(Reminder::Evening);
            let minutes = p["minutes"]
                .as_f64()
                .filter(|m| *m != 0.0 && m.is_finite())
                .unwrap_or(15.0);
            state(app, |s| s.clock.snooze(kind, minutes as i64, now()));
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
pub(super) fn act(app: &AppHandle, action: &str, p: &Value) -> Value {
    let ctx = notebook::ctx(app);
    let id = text(&p["id"]);
    match action {
        "add" => {
            let source = text(&p["source"]);
            let Some(Some(note)) = notes(app, |n| {
                n.add(
                    &text(&p["text"]),
                    p["important"].as_bool().unwrap_or(false),
                    &source,
                    now(),
                )
            }) else {
                return Value::Null;
            };
            after_change(app);
            tell(
                app,
                ctx.robot_id.as_deref(),
                json!({ "phase": "added", "note": note }),
            );
            note
        }
        "edit" => {
            let note = notes(app, |n| {
                n.update(
                    &id,
                    &json!({ "text": p["text"], "important": p["important"] }),
                )
            })
            .flatten();
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
                tell(
                    app,
                    ctx.robot_id.as_deref(),
                    json!({ "phase": "done", "note": note, "left": left }),
                );
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
            let Some(note) = notebook::take_undo(app) else {
                return Value::Null;
            };
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
            let (open, done) = notes(app, |n| {
                (
                    n.open(),
                    n.list()
                        .into_iter()
                        .filter(|x| x["doneAt"].as_i64().is_some_and(|d| d != 0))
                        .collect::<Vec<_>>(),
                )
            })
            .unwrap_or_default();
            let line = |n: &Value| {
                let done = n["doneAt"].as_i64().is_some_and(|d| d != 0);
                let important = if n["important"].as_bool().unwrap_or(false) {
                    "(!) "
                } else {
                    ""
                };
                format!(
                    "{} {important}{}",
                    if done { "[x]" } else { "[ ]" },
                    text(&n["text"]).replace('\n', " ")
                )
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
