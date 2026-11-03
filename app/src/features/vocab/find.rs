//! Find the English (the find hotkey): a small window by the robot nearest the mouse
//! ("find") where you type something in Vietnamese (a word, a phrase, an idiom, a sentence)
//! and get the English for it: a few choices, each with its tone, its meaning and an example,
//! and ☆ to save it to My words. Only the English you save is kept: it goes in as a word of
//! its own and is looked up as the word hotkey's are. With some text selected, it opens on
//! that and looks it up straight away.
//!
//! Quick: the words come first (find_search answers with them), then each one's details as
//! they're written (find:detail, then find:done). The quick model is started for both steps
//! as soon as the window opens, so it's ready by the time you've typed; a search you made
//! before comes back at once.
//!
//! The page asks for what it opens with (find_init), says how tall it is (find_size), looks
//! things up (find_search) and sends its buttons (find_act).

use super::*;

use serde::Deserialize;
use tauri::WindowEvent;
use tauri::webview::PageLoadEvent;

use crate::agents::claude::Killer;
use crate::platform::clipboard;
use crate::runtime::{Error, part};
use crate::ui::place;

use super::english::{self, Choice, English, MAX_ASKED};
use super::lookup::Warm;
use super::words::norm;

pub(super) const LABEL: &str = "find";
const W: f64 = 380.0; // (CSS px)
const GAP: f64 = 8.0;
const PAINT: &str = "#5ac8fa";
const SOURCE: &str = "Find the English";
// a quick model started this long ago is started afresh (it may have gone stale)
const WARM_FOR: Duration = Duration::from_secs(15 * 60);
const REMEMBERED: usize = 40; // searches whose answers are kept, for asking again

/// What it's open on: the robot it's by (its box and paint), the text it opened with, and
/// the words saved from it this time (the only ones ☆ may take back). The quick model waiting
/// for each step, which search is the latest (and its details being written), and the
/// searches made before (the newest last).
#[derive(Default)]
pub(super) struct Find {
    robot_id: Option<String>,
    near: Option<Rect>,
    paint: String,
    text: String,
    height: f64, // what the page asked for (CSS px)
    saved_here: Vec<String>,
    warm_words: Option<Warm>,
    warm_details: Option<Warm>,
    seq: u64,
    writing: Option<Killer>,
    before: Vec<(String, English)>,
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
    let a = app.clone();
    thread::spawn(move || warm_up(&a)); // (while you type)
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
            // (the quick models it kept are ended out of the lock)
            let (words, details, writing) = finding(&app2, |f| {
                f.saved_here.clear();
                (f.warm_words.take(), f.warm_details.take(), f.writing.take())
            });
            if let Some(writing) = writing {
                writing.kill();
            }
            drop((words, details));
        }
    });
}

fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- looking up and saving

fn claude_path(app: &AppHandle) -> String {
    text(&settings(app)["claudePath"])
}

/// Where the quick model for one step waits: the words', or the details'.
fn waiting(f: &mut Find, details: bool) -> &mut Option<Warm> {
    if details {
        &mut f.warm_details
    } else {
        &mut f.warm_words
    }
}

fn start_warm(app: &AppHandle, details: bool) -> Result<Warm, String> {
    let system = if details {
        english::DETAILS_SYSTEM
    } else {
        english::WORDS_SYSTEM
    };
    Warm::start(&claude_path(app), system, details)
}

/// Start the quick model for each step that has none waiting (while the window's open).
fn warm_up(app: &AppHandle) {
    for details in [false, true] {
        let ready = finding(app, |f| {
            waiting(f, details)
                .as_ref()
                .is_some_and(|w| w.age() < WARM_FOR)
        });
        if ready || app.get_webview_window(LABEL).is_none() {
            continue;
        }
        let Ok(fresh) = start_warm(app, details) else {
            continue; // (the search says why)
        };
        let old = finding(app, |f| waiting(f, details).replace(fresh));
        drop(old); // (ended out of the lock)
    }
}

/// The quick model for this step: the one waiting, or a new one (and another's started for
/// next time). True if it was waiting.
fn take_warm(app: &AppHandle, details: bool) -> Result<(Warm, bool), String> {
    let kept = finding(app, |f| waiting(f, details).take());
    let a = app.clone();
    thread::spawn(move || warm_up(&a));
    match kept {
        Some(w) if w.age() < WARM_FOR => Ok((w, true)),
        _ => Ok((start_warm(app, details)?, false)),
    }
}

/// The words, on the quick model waiting for them (if that one had gone, on a new one).
fn ask_words(app: &AppHandle, asked: &str) -> Result<Vec<Choice>, String> {
    let (warm, kept) = take_warm(app, false)?;
    match english::ask_words(warm, asked) {
        Err(e) if kept && e.starts_with("Claude Code stopped") => {
            english::ask_words(start_warm(app, false)?, asked)
        }
        r => r,
    }
}

/// Each choice marked with its id in My words, if it's there.
fn mark_saved(app: &AppHandle, choices: &mut [Choice]) {
    words(app, |w| {
        for c in choices.iter_mut() {
            c.saved = w.vocab.find(&c.word).map(|k| text(&k["id"]));
        }
    });
}

/// How a search is known again (case, spaces and punctuation aside).
fn key_of(asked: &str) -> String {
    norm(asked)
}

/// Keep a search's whole answer, for asking it again (the oldest go past REMEMBERED).
fn remember(before: &mut Vec<(String, English)>, key: String, found: English) {
    before.retain(|(k, _)| *k != key);
    before.push((key, found));
    let over = before.len().saturating_sub(REMEMBERED);
    before.drain(..over);
}

/// The English for it: the words now (each marked with its id in My words if it's there),
/// their details to follow (find:detail, find:done); the whole of it at once if you've asked
/// before.
fn search(app: &AppHandle, asked: &str) -> Result<English, Error> {
    let asked = asked.trim();
    if asked.is_empty() {
        return Err("Type something in Vietnamese first.".into());
    }
    let key = key_of(asked);
    let (id, writing, before) = finding(app, |f| {
        f.seq += 1;
        let before = f
            .before
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, e)| e.clone());
        (f.seq, f.writing.take(), before)
    });
    if let Some(writing) = writing {
        writing.kill(); // (the details of a search before: not wanted now)
    }
    if let Some(mut found) = before {
        found.id = id;
        mark_saved(app, &mut found.choices);
        return Ok(found);
    }
    let mut choices = ask_words(app, asked)?;
    mark_saved(app, &mut choices);
    let found = English {
        id,
        choices: choices.clone(),
        tip: String::new(),
        complete: false,
    };
    let (app, asked) = (app.clone(), asked.to_string());
    thread::spawn(move || write_details(&app, id, &asked, key, choices));
    Ok(found)
}

/// Tell the page search id's details are all in (with the tip, or why they aren't).
fn details_done(app: &AppHandle, id: u64, tip: &str, error: Option<String>) {
    let _ = app.emit_to(
        LABEL,
        "find:done",
        json!({ "id": id, "tip": tip, "error": error }),
    );
}

/// The details of search id's words, each to the page as it's written (find:detail), then the
/// tip; the whole answer kept if they all came. Stopped by a newer search.
fn write_details(app: &AppHandle, id: u64, asked: &str, key: String, mut choices: Vec<Choice>) {
    let warm = match take_warm(app, true) {
        Ok((w, _)) => w,
        Err(e) => return details_done(app, id, "", Some(e)),
    };
    let killer = warm.killer();
    if !finding(app, |f| f.seq == id && f.writing.replace(killer).is_none()) {
        return; // (a newer search came meanwhile)
    }
    let written = english::ask_details(warm, asked, &mut choices, |at, c| {
        let _ = app.emit_to(
            LABEL,
            "find:detail",
            json!({ "id": id, "index": at, "choice": c }),
        );
    });
    let latest = finding(app, |f| {
        let latest = f.seq == id;
        if latest {
            f.writing = None;
        }
        latest
    });
    if !latest {
        return; // (stopped for a newer one)
    }
    match written {
        Ok(tip) => {
            if choices.iter().all(|c| c.ready) {
                for c in &mut choices {
                    c.saved = None; // (marked afresh when it's asked again)
                }
                let whole = English {
                    id: 0,
                    choices,
                    tip: tip.clone(),
                    complete: true,
                };
                finding(app, |f| remember(&mut f.before, key, whole));
            }
            details_done(app, id, &tip, None);
        }
        Err(e) => details_done(app, id, "", Some(e)),
    }
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

    #[test]
    fn a_search_is_known_again() {
        assert_eq!(key_of("  Tỉ mỉ! "), key_of("tỉ   mỉ"));
        assert_ne!(key_of("tỉ mỉ"), key_of("ti mi"));
    }

    #[test]
    fn searches_are_remembered_newest_last() {
        let mut before = vec![];
        for i in 0..REMEMBERED + 3 {
            remember(&mut before, format!("k{i}"), English::default());
        }
        assert_eq!(before.len(), REMEMBERED);
        assert_eq!(before[0].0, "k3"); // (the oldest gone)
        remember(&mut before, "k3".into(), English::default());
        assert_eq!(before.len(), REMEMBERED);
        assert_eq!(before[REMEMBERED - 1].0, "k3"); // (asked again: the newest)
    }
}
