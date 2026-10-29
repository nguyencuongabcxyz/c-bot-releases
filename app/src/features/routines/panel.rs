//! The Routines window ("routines"): beside a robot, your routines to add, change, switch
//! on or off and run now, and a run's result. One at a time; opening it again brings it
//! round (to the list, a routine, or a result). It closes on Esc, ✕, or when you click away
//! from it, but not while a result you haven't looked at yet is up.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::platform::window;
use crate::platform::window::Rect;
use crate::runtime::{hub, part_if};
use crate::ui::{place, views};

pub const LABEL: &str = "routines";
const SIZE: (f64, f64) = (400.0, 560.0);
const MIN_SIZE: (f64, f64) = (320.0, 360.0);
const GAP: f64 = 8.0;
// clicked away: it goes this long after (unless you came straight back)
const BLUR_CLOSE: Duration = Duration::from_millis(120);

#[derive(Default)]
struct Panel {
    robot_id: Option<String>,
    near: Option<Rect>,
    focus: Value, // { view: "list" | "edit" | "result", id? }
    hwnd: Option<isize>,
    focused_once: bool,
    focused: bool,
}

fn panel<R>(app: &AppHandle, f: impl FnOnce(&mut Panel) -> R) -> Option<R> {
    part_if(app, f)
}

fn place(app: &AppHandle) {
    let Some(Some((hwnd, near))) = panel(app, |p| Some((p.hwnd?, p.near))) else {
        return;
    };
    let (near, m) = place::around(near);
    window::set_bounds(hwnd, place::beside(near, m.work, m.scale, SIZE, GAP));
}

/// Show it: taking the focus (opened by you), or not (a result came in).
fn show(app: &AppHandle, activate: bool) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    if activate {
        let _ = w.show();
        let _ = w.set_focus();
    } else if let Some(Some(hwnd)) = panel(app, |p| p.hwnd) {
        window::show_no_activate(hwnd);
        window::set_topmost(hwnd);
    }
}

/// Open it (or bring it round) beside this robot, on this.
pub fn open(app: &AppHandle, robot_id: Option<String>, focus: Value, activate: bool) {
    let near = robot_id.as_deref().and_then(|r| hub::robot_rect(app, r));
    let open = panel(app, |p| {
        p.robot_id = robot_id;
        p.near = near;
        p.focus = focus.clone();
        p.focused_once = false;
        p.hwnd.is_some()
    });
    match open {
        None => {}
        Some(true) => {
            let _ = app.emit_to(LABEL, "routines:open", focus);
            place(app);
            show(app, activate);
        }
        Some(false) => {
            let app = app.clone();
            thread::spawn(move || build(&app, activate));
        }
    }
}

fn build(app: &AppHandle, activate: bool) {
    let built = views::builder(app, LABEL, "routines", &[])
        .title("Routines")
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
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            if app.get_webview_window(LABEL).is_none() {
                log::warn!("couldn't open: {err}");
            }
            return;
        }
    };
    let Ok(hwnd) = w.hwnd().map(|h| h.0 as isize) else {
        return;
    };
    panel(app, |p| {
        p.hwnd = Some(hwnd);
        p.focused = false;
    });
    let app2 = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::Focused(true) => {
            panel(&app2, |p| {
                p.focused_once = true;
                p.focused = true;
            });
        }
        // clicked away: it goes (a result you haven't looked at yet stays)
        WindowEvent::Focused(false) => {
            let looked = panel(&app2, |p| {
                p.focused = false;
                p.focused_once
            });
            if looked == Some(true) {
                let app = app2.clone();
                thread::spawn(move || {
                    thread::sleep(BLUR_CLOSE);
                    if panel(&app, |p| !p.focused) == Some(true) {
                        close(&app);
                    }
                });
            }
        }
        WindowEvent::Destroyed => {
            panel(&app2, |p| {
                p.hwnd = None;
                p.focused = false;
            });
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
    panel(app, |p| p.hwnd.is_some()).unwrap_or(false)
}

/// What it was opened on, and beside which robot.
pub fn focus(app: &AppHandle) -> (Value, Option<String>) {
    panel(app, |p| (p.focus.clone(), p.robot_id.clone()))
        .unwrap_or((json!({ "view": "list" }), None))
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Panel::default()));
}
