//! The robot's little drone, which delivers the action menu (main drone.js): it takes off
//! from the robot's desk, flies to the mouse, hovers there and projects the menu under it
//! with a beam of light; when the menu goes, it flies home. It's drawn in a see-through
//! window over the whole screen ("drone") that the mouse goes straight through and that
//! never takes the focus (so the app you're in keeps it, and its selection can still be
//! copied). The page (renderer/drone) flies it; positions it's told are in its window's
//! CSS px.
//!
//! Shown and hidden straight through Windows (SW_SHOWNOACTIVATE): Tauri's show() would
//! activate it. So nothing else here changes the window through Tauri once it's made.

use std::sync::mpsc::{self, Sender};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::window;
use crate::platform::window::Rect;
use crate::runtime::Locked;
use crate::ui::views;

pub const LABEL: &str = "drone";
// the longest it waits to hear it got there, whatever the page does
const ARRIVAL: Duration = Duration::from_millis(900);

#[derive(Default)]
struct Drone {
    area: Option<(Rect, f64)>, // the screen it covers (physical px) and its scale
    home: Option<(f64, f64)>,  // where it took off from (screen px)
    arrivals: Vec<Sender<()>>, // waiting for it to get where it's going
}

static DRONE: LazyLock<Mutex<Drone>> = LazyLock::new(Mutex::default);

fn drone<R>(f: impl FnOnce(&mut Drone) -> R) -> R {
    f(&mut DRONE.locked())
}

fn hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

/// The whole screen a point is on, or the nearest (its bounds, taskbar too) and its scale.
fn screen_at(x: i32, y: i32) -> (Rect, f64) {
    let m = window::monitor_near(x, y);
    (m.bounds, m.scale)
}

/// A screen point as a point in the window (its CSS px).
fn local(area: (Rect, f64), p: (f64, f64)) -> Value {
    let (r, s) = area;
    json!({ "x": (p.0 - r.x as f64) / s, "y": (p.1 - r.y as f64) / s })
}

/// Where it takes off from: the robot's desk; one on another screen comes in from that side.
fn start_point(area: Rect, s: f64, from: (f64, f64)) -> (f64, f64) {
    let m = 40.0 * s;
    (
        from.0.max(area.x as f64 - m).min(area.right() as f64 + m),
        from.1.max(area.y as f64 - m).min(area.bottom() as f64 + m),
    )
}

/// Make the window now (hidden), so the first flight is quick too. Waits (a few seconds at
/// most) for its page to be there.
pub fn prepare(app: &AppHandle) {
    static MAKING: Mutex<()> = Mutex::new(());
    let _one = MAKING.locked();
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    drone(|d| *d = Drone::default());
    let (loaded, wait) = mpsc::channel();
    let built = views::builder(app, LABEL, "drone", &[])
        .title("C-Bot drone")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .inner_size(400.0, 300.0)
        .on_page_load(move |_, p| {
            if let PageLoadEvent::Finished = p.event() {
                let _ = loaded.send(());
            }
        })
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[drone] couldn't make it: {err}");
            return;
        }
    };
    let _ = w.set_ignore_cursor_events(true);
    w.on_window_event(|e| {
        if let tauri::WindowEvent::Destroyed = e {
            drone(|d| *d = Drone::default());
        }
    });
    if wait.recv_timeout(Duration::from_secs(5)).is_ok() {
        thread::sleep(Duration::from_millis(150)); // (its page is listening by then)
    }
}

fn send(app: &AppHandle, cmd: Value) {
    let _ = app.emit_to(LABEL, "drone:cmd", cmd);
}

/// The next time it gets where it's going (never waited on for long).
fn arrival() -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel();
    drone(|d| d.arrivals.push(tx));
    rx
}

/// Fly from the desk (from) to a spot (to), both screen px, in the robot's paint; returns
/// once it's there (or soon, whatever happens).
pub fn launch(app: &AppHandle, from: (f64, f64), to: (f64, f64), paint: &str) {
    prepare(app);
    let Some(h) = hwnd(app) else { return };
    let (area, s) = screen_at(to.0 as i32, to.1 as i32);
    // (a pixel short of the whole screen, so Windows doesn't take it for a full-screen app)
    let bounds = Rect {
        h: area.h - 1,
        ..area
    };
    window::set_bounds(h, bounds);
    if window::window_rect(h) != bounds {
        window::set_bounds(h, bounds); // (moved onto a screen of another scale: placed again)
    }
    let start = start_point(area, s, from);
    drone(|d| {
        d.area = Some((area, s));
        d.home = Some(start);
    });
    window::show_no_activate(h); // (without taking the focus from the app you're in)
    window::set_topmost(h);
    let done = arrival();
    send(
        app,
        json!({ "kind": "launch", "from": local((area, s), start), "to": local((area, s), to), "paint": paint }),
    );
    let _ = done.recv_timeout(ARRIVAL);
}

/// Settle above the menu's top edge (x, y: its middle; width: how wide), beam down.
pub fn hover(app: &AppHandle, x: f64, y: f64, width: f64) {
    let Some(area) = drone(|d| d.area) else {
        return;
    };
    send(
        app,
        json!({ "kind": "hover", "at": local(area, (x, y)), "width": width / area.1 }),
    );
}

/// Fly back to the desk, then it's gone.
pub fn recall(app: &AppHandle) {
    if !hwnd(app).is_some_and(window::is_visible) {
        return;
    }
    let (area, home) = drone(|d| (d.area, d.home));
    let to = match (area, home) {
        (Some(a), Some(p)) => local(a, p),
        _ => Value::Null,
    };
    send(app, json!({ "kind": "recall", "to": to }));
}

/// Its page says it got there.
#[tauri::command(async)]
pub fn drone_arrived(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::runtime::util::only(&window, LABEL)?;
    for r in drone(|d| std::mem::take(&mut d.arrivals)) {
        let _ = r.send(());
    }
    Ok(())
}

/// Back home (or faded out): nothing left to show.
#[tauri::command(async)]
pub fn drone_gone(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::runtime::util::only(&window, LABEL)?;
    if let Some(h) = hwnd(&app).filter(|&h| window::is_visible(h)) {
        window::hide(h);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_in_its_window() {
        let area = (
            Rect {
                x: 1920,
                y: 0,
                w: 2560,
                h: 1440,
            },
            1.5,
        );
        assert_eq!(
            local(area, (2070.0, 300.0)),
            json!({ "x": 100.0, "y": 200.0 })
        );
        assert_eq!(
            local(
                (
                    Rect {
                        x: 0,
                        y: 0,
                        w: 1920,
                        h: 1080
                    },
                    1.0
                ),
                (10.0, 20.0)
            ),
            json!({ "x": 10.0, "y": 20.0 })
        );
    }

    #[test]
    fn it_comes_in_from_another_screen() {
        let area = Rect {
            x: 1920,
            y: 0,
            w: 1920,
            h: 1080,
        };
        // a desk on the screen to the left: it starts just off this one's left edge
        assert_eq!(start_point(area, 1.0, (800.0, 900.0)), (1880.0, 900.0));
        // on this screen: from the desk itself
        assert_eq!(start_point(area, 1.0, (3000.0, 500.0)), (3000.0, 500.0));
        // below it, on a 200% screen
        assert_eq!(start_point(area, 2.0, (2500.0, 5000.0)), (2500.0, 1160.0));
    }
}
