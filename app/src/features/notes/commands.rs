//! What the notes' pages ask (the notebook, a robot's corkboard), and setting the notes up.

use super::*;

/// A robot's: the corkboard was clicked (or /notes). focus: 'add', or a note's id.
#[tauri::command(async)]
pub fn notes_open(app: AppHandle, window: tauri::WebviewWindow, opts: Option<Value>) {
    let focus = opts.unwrap_or_default()["focus"].clone();
    open_book(
        &app,
        robots::id_of(window.label()).map(str::to_string),
        focus,
        Value::Null,
        true,
        String::new(),
        String::new(),
    );
}

/// /note …
#[tauri::command(async)]
pub fn notes_add(app: AppHandle, window: tauri::WebviewWindow, text: String) -> Value {
    let note = add(&app, &text, "chat");
    if !note.is_null() {
        tell(
            &app,
            robots::id_of(window.label()),
            json!({ "phase": "added", "note": note, "quiet": true }),
        );
    }
    note
}

/// The chat's side of "Ask Claude": Claude's on it, or it's done.
#[tauri::command(async)]
pub fn notes_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    p: Option<Value>,
) -> Value {
    let p = p.unwrap_or_default();
    match action.as_str() {
        "working" => {
            let note = notes(&app, |n| {
                n.update(
                    &text(&p["id"]),
                    &json!({ "working": p["working"].as_bool().unwrap_or(false) }),
                )
            })
            .flatten();
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
            tell(
                &app,
                robots::id_of(window.label()),
                json!({ "phase": "done", "note": note, "left": left }),
            );
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
    open_book(
        &app,
        robots::id_of(window.label()).map(str::to_string),
        Value::Null,
        reminder,
        false,
        String::new(),
        String::new(),
    );
}

// (the notebook's own: only it may ask)

#[tauri::command(async)]
pub fn notebook_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, Error> {
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
pub fn notebook_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    p: Option<Value>,
) -> Result<Value, Error> {
    only(&window, notebook::LABEL)?;
    Ok(act(&app, &action, &p.unwrap_or_default()))
}

/// Write notes.json now if a change is waiting (C-Bot is quitting).
pub(super) fn flush(app: &AppHandle) {
    if let Some(st) = app.try_state::<Mutex<State>>() {
        let mut s = st.locked();
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
    app.manage(Mutex::new(State {
        notes,
        saved,
        clock: NoteClock::default(),
    }));
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
        log::warn!("couldn't watch for quitting: {err}");
    }
    hub::add_hotkey(
        app,
        Hotkey {
            setting: "noteHotkey",
            label: "Take a note",
            what: "The notebook, with what you selected in it",
            default: "Ctrl+Alt+N",
            run: capture_note,
        },
    );
    // changes are saved a moment after they happen
    let a = app.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(100));
            if let Some(st) = a.try_state::<Mutex<State>>() {
                let mut s = st.locked();
                let State { notes, saved, .. } = &mut *s;
                saved.tick(&notes.data);
            }
        }
    });
    watch(app.clone());
}
