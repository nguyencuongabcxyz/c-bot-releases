//! Find the English (the find hotkey): a small window by the robot nearest the mouse
//! ("find") where you type something in Vietnamese (a word, a phrase, an idiom, a sentence)
//! and get the English for it: a few choices, each with its tone, its meaning and an example,
//! and ☆ to save it to My words. Only the English you save is kept: it goes in as a word of
//! its own and is looked up as the word hotkey's are. With some text selected, it opens on
//! that and looks it up straight away.
//!
//! The page asks for what it opens with (find_init), says how tall it is (find_size), looks
//! things up (find_search) and sends its buttons (find_act).

use super::*;

use serde::Deserialize;
use tauri::WindowEvent;
use tauri::webview::PageLoadEvent;

use crate::platform::clipboard;
use crate::runtime::{Error, part};
use crate::ui::place;

use lookup::{English, MAX_ASKED};

pub(super) const LABEL: &str = "find";
const W: f64 = 380.0; // (CSS px)
const GAP: f64 = 8.0;
const PAINT: &str = "#5ac8fa";
const SOURCE: &str = "Find the English";

/// What it's open on: the robot it's by (its box and paint), the text it opened with, and
/// the words saved from it this time (the only ones ☆ may take back).
#[derive(Default)]
pub(super) struct Find {
    robot_id: Option<String>,
    near: Option<Rect>,
    paint: String,
    text: String,
    height: f64, // what the page asked for (CSS px)
    saved_here: Vec<String>,
}

fn finding<R>(app: &AppHandle, f: impl FnOnce(&mut Find) -> R) -> R {
    part(app, f)
}

/// The window's buttons (find_act).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindAct {
    Save,
    Unsave,
    Copy,
    Close,
}

// ---------------------------------------------------------------- where it goes

fn hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

/// Beside the robot, on the side with room (as Quick actions go); by the mouse with none.
fn place(app: &AppHandle) {
    let (near, height) = finding(app, |f| (f.near, f.height));
    let Some(hwnd) = hwnd(app) else { return };
    let (near, m) = place::around(near);
    let r = place::beside(near, m.work, m.scale, (W, height), GAP);
    window::set_bounds(hwnd, r);
    // (moving it onto a screen of another scale rescales it once: placed again after)
    if window::window_rect(hwnd) != r {
        window::set_bounds(hwnd, r);
    }
}

fn show(app: &AppHandle) {
    place(app);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- opening and closing

/// The find hotkey's keys.
pub(super) fn find_hotkey(app: &AppHandle) -> String {
    hub::hotkey_keys(app, "findHotkey", "Ctrl+Alt+E")
}

/// What the page opens with: the text to look up (empty: just the box), its paint, the hotkey.
fn view(app: &AppHandle) -> Value {
    let (asked, paint) = finding(app, |f| (f.text.clone(), f.paint.clone()));
    json!({ "text": asked, "paint": paint, "hotkey": find_hotkey(app) })
}

/// The hotkey: by the robot nearest the mouse, on what's selected in the app in front (if
/// anything is: not when it's this window you're in).
pub(super) fn capture_find(app: &AppHandle) {
    let here = hwnd(app).is_some_and(|h| h == window::foreground());
    let selected = if here {
        String::new()
    } else {
        capture::read_selection(app, &find_hotkey(app), false).text
    };
    open_find(app, hub::nearest_robot(app), &selected);
}

/// Open it by this robot (else the notes robot; with neither, by the mouse) on this text
/// (looked up at once; empty: just the box).
pub(super) fn open_find(app: &AppHandle, robot_id: Option<String>, text: &str) {
    let selected: String = trim_edges(text).trim().chars().take(MAX_ASKED).collect();
    let robot_id = robot_id.or_else(|| hub::notes_robot(app));
    let near = robot_id.as_deref().and_then(|id| hub::robot_rect(app, id));
    let paint = color_of(app, robot_id.as_deref())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| PAINT.into());
    finding(app, |f| {
        f.robot_id = robot_id;
        f.near = near;
        f.paint = paint;
        f.text = selected;
    });
    // (off the caller's thread: it may be a menu's, and building a window may wait on it)
    let app = app.clone();
    thread::spawn(move || open_now(&app));
}

fn open_now(app: &AppHandle) {
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.locked();
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "find:open", view(app));
        show(app);
        return;
    }
    let height = finding(app, |f| f.height);
    let app2 = app.clone();
    let built = views::builder(app, LABEL, "find", &[])
        .title("Find the English")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .inner_size(W, height)
        // shown once its page is there
        .on_page_load(move |_, p| {
            if let PageLoadEvent::Finished = p.event() {
                let app = app2.clone();
                thread::spawn(move || show(&app));
            }
        })
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            log::warn!("couldn't open: {err}");
            return;
        }
    };
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            finding(&app2, |f| f.saved_here.clear());
        }
    });
}

fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- looking up and saving

/// The English for it, each choice marked with its id in My words if it's there already.
fn search(app: &AppHandle, asked: &str) -> Result<English, Error> {
    let asked = asked.trim();
    if asked.is_empty() {
        return Err("Type something in Vietnamese first.".into());
    }
    let claude_path = text(&settings(app)["claudePath"]);
    let mut found = lookup::english_for(asked, &claude_path)?;
    words(app, |w| {
        for c in &mut found.choices {
            c.saved = w.vocab.find(&c.word).map(|k| text(&k["id"]));
        }
    });
    Ok(found)
}

/// ☆: the word into My words (its example as the sentence it was found in, so the lookup
/// gives that meaning first), looked up in the background. Its id; the one you had if it
/// was there already.
fn save(app: &AppHandle, p: &Value) -> Value {
    let word: String = trim_edges(&text(&p["word"]))
        .trim()
        .chars()
        .take(60)
        .collect();
    if word.is_empty() {
        return Value::Null;
    }
    let example = text(&p["example"]);
    let Some((id, new)) = words(app, |w| match w.vocab.find(&word) {
        Some(had) => (text(&had["id"]), false),
        None => (
            text(&w.vocab.add(&word, &example, SOURCE, now())["id"]),
            true,
        ),
    }) else {
        return Value::Null;
    };
    if new {
        let robot = finding(app, |f| {
            f.saved_here.push(id.clone());
            f.robot_id.clone()
        });
        count_changed(app);
        find_meaning(app, id.clone(), robot, true);
    }
    json!(id)
}

/// ★ again: a word saved from here this time goes again (none you had before).
fn unsave(app: &AppHandle, p: &Value) -> Value {
    let id = text(&p["id"]);
    let mine = finding(app, |f| {
        let at = f.saved_here.iter().position(|s| *s == id);
        at.map(|i| f.saved_here.remove(i)).is_some()
    });
    if !mine {
        return json!(false);
    }
    delete_word(app, &id)
}

fn act(app: &AppHandle, action: FindAct, p: &Value) -> Value {
    match action {
        FindAct::Save => save(app, p),
        FindAct::Unsave => unsave(app, p),
        FindAct::Copy => json!(clipboard::set_text(&text(&p["text"]))),
        FindAct::Close => {
            close(app);
            Value::Null
        }
    }
}

// ---------------------------------------------------------------- commands (only the window's)

#[tauri::command(async)]
pub fn find_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(view(&app))
}

/// How tall the window's content came out (CSS px).
#[tauri::command(async)]
pub fn find_size(app: AppHandle, window: tauri::WebviewWindow, height: f64) -> Result<(), Error> {
    only(&window, LABEL)?;
    if height.is_finite() {
        finding(&app, |f| f.height = height.ceil().clamp(80.0, 640.0));
        place(&app);
    }
    Ok(())
}

/// The English for what you typed (Claude's quick model: a few seconds).
#[tauri::command(async)]
pub fn find_search(
    app: AppHandle,
    window: tauri::WebviewWindow,
    text: String,
) -> Result<English, Error> {
    only(&window, LABEL)?;
    search(&app, &text)
}

/// A button in the window: save, unsave, copy, close.
#[tauri::command(async)]
pub fn find_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: FindAct,
    p: Option<Value>,
) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(act(&app, action, &p.unwrap_or_default()))
}

pub(super) fn setup_find(app: &AppHandle) {
    app.manage(Mutex::new(Find {
        height: 120.0,
        ..Find::default()
    }));
    hub::add_hotkey(
        app,
        Hotkey {
            setting: "findHotkey",
            label: "Find the English",
            what: "Type it in Vietnamese and get the English words for it",
            default: "Ctrl+Alt+E",
            run: capture_find,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_buttons_as_the_page_sends_them() {
        let read = |s: &str| serde_json::from_value::<FindAct>(json!(s)).ok();
        assert_eq!(read("save"), Some(FindAct::Save));
        assert_eq!(read("unsave"), Some(FindAct::Unsave));
        assert_eq!(read("copy"), Some(FindAct::Copy));
        assert_eq!(read("close"), Some(FindAct::Close));
        assert_eq!(read("search"), None);
    }
}
