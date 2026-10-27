//! The notebook (main notebook.js): a small window ("notebook") beside a robot with all your
//! notes. The desk's corkboard opens it, and so do the hotkey, /notes, the menus and the
//! daily reminders. One notebook at a time; opening it again just brings it round (to a
//! note, the add box, or a reminder). It closes on Esc, ✕, or when you click away from it,
//! but not while a reminder is up that you haven't looked at yet. You can make it bigger or
//! smaller (remembered: settings.notebookSize, CSS px).
//!
//! Positions are physical px; sizes the page's CSS px times its screen's scale.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::platform::window;
use crate::platform::window::Rect;
use crate::runtime::with;
use crate::ui::{place, views};

pub const LABEL: &str = "notebook";
const SIZE: (f64, f64) = (340.0, 460.0);
const MIN_SIZE: (f64, f64) = (280.0, 300.0);
const GAP: f64 = 8.0;
// clicked away: it goes this long after (unless you came straight back)
const BLUR_CLOSE: Duration = Duration::from_millis(120);

/// What it was opened for.
#[derive(Clone, Default)]
pub struct Ctx {
    pub robot_id: Option<String>, // whose side it goes on, who acts things out
    pub near: Option<Rect>,       // that robot's box on screen
    pub focus: Value,             // "add" | a note's id | null
    pub reminder: Value,          // { kind, info } for a reminder's banner, or null
    pub text: String,             // put in the add box (the hotkey, with something selected)…
    pub source: String,           // …and where it's from
}

#[derive(Default)]
struct Book {
    ctx: Ctx,
    undo: Option<Value>, // the note just deleted
    hwnd: Option<isize>,
    focused_once: bool,
    focused: bool,
    placed: Option<(u32, u32)>, // the size it was last given (physical px), not a resize by you
}

fn book<R>(app: &AppHandle, f: impl FnOnce(&mut Book) -> R) -> Option<R> {
    let state = app.try_state::<Mutex<Book>>()?;
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    Some(f(&mut guard))
}

/// Beside the robot's box (`near`), on the side with room, bottoms lined up; else by the
/// mouse. wa: the screen's work area; size: how big you made it (CSS px).
pub fn bounds_beside(near: Rect, wa: Rect, scale: f64, size: (f64, f64)) -> Rect {
    place::beside(near, wa, scale, size, GAP)
}

/// How big you made it (settings.notebookSize, CSS px), not smaller than it can be.
fn size_of(settings: &Value) -> (f64, f64) {
    let saved = &settings["notebookSize"];
    let pick = |k: &str, def: f64, min: f64| saved[k].as_f64().filter(|v| *v != 0.0).unwrap_or(def).max(min);
    (pick("w", SIZE.0, MIN_SIZE.0), pick("h", SIZE.1, MIN_SIZE.1))
}

fn place(app: &AppHandle) {
    let Some(Some((hwnd, near))) = book(app, |b| Some((b.hwnd?, b.ctx.near))) else { return };
    let (near, m) = place::around(near);
    let size = size_of(&with(app, |st| st.store.settings().clone()));
    let r = bounds_beside(near, m.work, m.scale, size);
    book(app, |b| b.placed = Some((r.w as u32, r.h as u32)));
    window::set_bounds(hwnd, r);
}

/// Show it: taking the focus (a click, the hotkey), or not (a reminder).
fn show(app: &AppHandle, activate: bool) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    if activate {
        let _ = w.show();
        let _ = w.set_focus();
    } else if let Some(Some(hwnd)) = book(app, |b| b.hwnd) {
        window::show_no_activate(hwnd);
        window::set_topmost(hwnd);
    }
}

/// Open it (or bring it round) for this.
pub fn open(app: &AppHandle, ctx: Ctx, activate: bool) {
    let msg = json!({ "focus": ctx.focus, "reminder": ctx.reminder, "text": ctx.text, "source": ctx.source });
    let open = book(app, |b| {
        b.ctx = ctx;
        b.focused_once = false;
        b.hwnd.is_some()
    });
    match open {
        None => {}
        Some(true) => {
            let _ = app.emit_to(LABEL, "notebook:open", msg);
            place(app);
            show(app, activate);
        }
        Some(false) => build(app, activate),
    }
}

fn build(app: &AppHandle, activate: bool) {
    let built = views::builder(app, LABEL, "notebook", &[])
        .title("Notes")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(activate)
        .visible(false)
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            if app.get_webview_window(LABEL).is_none() {
                eprintln!("[notebook] couldn't open: {err}");
            }
            return;
        }
    };
    let Ok(hwnd) = window.hwnd().map(|h| h.0 as isize) else { return };
    book(app, |b| {
        b.hwnd = Some(hwnd);
        b.focused = false;
    });
    let app2 = app.clone();
    window.on_window_event(move |e| match e {
        WindowEvent::Focused(true) => {
            book(&app2, |b| {
                b.focused_once = true;
                b.focused = true;
            });
        }
        // clicked away: it goes (a reminder you haven't looked at yet stays)
        WindowEvent::Focused(false) => {
            let looked = book(&app2, |b| {
                b.focused = false;
                b.focused_once
            });
            if looked == Some(true) {
                let app = app2.clone();
                thread::spawn(move || {
                    thread::sleep(BLUR_CLOSE);
                    if book(&app, |b| !b.focused) == Some(true) {
                        close(&app);
                    }
                });
            }
        }
        // made bigger or smaller by you (not by place()): remembered
        WindowEvent::Resized(size) => {
            let ours = book(&app2, |b| b.placed == Some((size.width, size.height)));
            if ours == Some(false) && size.width > 0 && size.height > 0 {
                let s = window::scale_of(hwnd);
                let saved = json!({ "w": (size.width as f64 / s).round(), "h": (size.height as f64 / s).round() });
                with(&app2, |st| st.store.update_settings(crate::runtime::util::patch(vec![("notebookSize", saved)])));
            }
        }
        WindowEvent::Destroyed => {
            let ctx = book(&app2, |b| {
                b.hwnd = None;
                b.placed = None;
                b.focused = false;
                b.ctx.clone()
            });
            // (off the main thread: it tells the robot)
            if let Some(ctx) = ctx {
                let app = app2.clone();
                thread::spawn(move || super::notebook_closed(&app, &ctx));
            }
        }
        _ => {}
    });
    place(app);
    show(app, activate);
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// It's up.
pub fn is_open(app: &AppHandle) -> bool {
    book(app, |b| b.hwnd.is_some()).unwrap_or(false)
}

/// What it was opened for.
pub fn ctx(app: &AppHandle) -> Ctx {
    book(app, |b| b.ctx.clone()).unwrap_or_default()
}

/// The reminder banner was dealt with (snoozed, done for today): dropped from the page.
pub fn clear_reminder(app: &AppHandle) {
    book(app, |b| b.ctx.reminder = Value::Null);
    let _ = app.emit_to(LABEL, "notebook:open", json!({ "focus": null, "reminder": null }));
}

/// Keep the note just deleted (for Undo), or take it back.
pub fn set_undo(app: &AppHandle, note: Option<Value>) {
    book(app, |b| b.undo = note);
}

pub fn take_undo(app: &AppHandle) -> Option<Value> {
    book(app, |b| b.undo.take()).flatten()
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Book::default()));
}

#[cfg(test)]
mod tests {
    use super::*;

    const WA: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };

    #[test]
    fn beside_the_robot() {
        // a robot in the bottom-right corner: on its left, bottoms lined up
        let robot = Rect { x: 1590, y: 740, w: 300, h: 290 };
        assert_eq!(bounds_beside(robot, WA, 1.0, SIZE), Rect { x: 1242, y: 570, w: 340, h: 460 });
        // at the left edge: on its right
        let robot = Rect { x: 20, y: 740, w: 300, h: 290 };
        assert_eq!(bounds_beside(robot, WA, 1.0, SIZE), Rect { x: 328, y: 570, w: 340, h: 460 });
        // high up: kept on the screen
        let robot = Rect { x: 1000, y: 10, w: 300, h: 100 };
        assert_eq!(bounds_beside(robot, WA, 1.0, SIZE).y, 8);
        // at 150%, made bigger, taller than the screen
        let r = bounds_beside(Rect { x: 2400, y: 1100, w: 450, h: 435 }, Rect { x: 0, y: 0, w: 2880, h: 1560 }, 1.5, (400.0, 2000.0));
        assert_eq!((r.w, r.h, r.y), (600, 1560 - 24, 12));
    }

    #[test]
    fn its_size() {
        assert_eq!(size_of(&json!({})), SIZE);
        assert_eq!(size_of(&json!({ "notebookSize": { "w": 500, "h": 0 } })), (500.0, SIZE.1));
        assert_eq!(size_of(&json!({ "notebookSize": { "w": 100, "h": 100 } })), MIN_SIZE);
    }
}
