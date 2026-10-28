//! The robot windows (src/main/main.js createRobotWindow and friends): one see-through,
//! frameless, always-on-top window per robot. Asleep the window hugs the robot; awake it
//! grows to make room for the speech-bubble chat beside it, the full height of the screen.
//!
//! Inside, positions are physical pixels. What the page gets is in its CSS pixels. The
//! store keeps a robot's position as the Electron app did (its DIPs: physical pixels over
//! the main screen's scale), so both apps put the robots in the same place.
//!
//! Never call into a window (Tauri's API or SetWindowPos) while holding the state lock:
//! those wait on the main thread, which may itself be waiting for the lock.

mod cursor;
pub mod ipc;
pub mod island;
mod layout;
pub mod maid;
mod moves;
mod opening;
pub mod planes;
pub mod revive;
pub mod screens;
pub mod social;
pub mod stage;
pub mod topmost;
pub mod walkers;

pub use cursor::*;
pub use layout::*;
pub use moves::*;
pub use opening::*;

use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::features::chat;
use crate::platform::window;
use crate::platform::window::Rect;
use crate::runtime::{Error, State, with};
use crate::store::Fields;
use crate::store::title_for;
use crate::ui::views;
use crate::workbench::{shell, terminal};

// Robot window sizes (CSS px). Each robot can be smaller or bigger (the Workshop's "Size").
const ROBOT: (f64, f64) = (300.0, 290.0);
// Awake: the chat panel sits beside the robot. You can drag its outer edge to make it
// wider or narrower (remembered per robot).
pub const CHAT_W: f64 = 520.0;
const CHAT_MIN: f64 = 360.0;
// Awake with the chat tucked away: room above the robot (below it, at the top of the
// screen) for the status bubble and its speech bubble, so neither covers the desk.
const TUCK_STRIP: f64 = 116.0;
// how often the cursor is looked at (eyes follow it every other look)
const CURSOR_POLL: Duration = Duration::from_millis(33);

pub fn label_of(id: &str) -> String {
    format!("robot-{id}")
}

pub fn id_of(label: &str) -> Option<&str> {
    label.strip_prefix("robot-")
}

/// The robot whose window sent a command (an error for any other window).
pub fn sender(window: &tauri::WebviewWindow) -> Result<String, Error> {
    id_of(window.label())
        .map(str::to_string)
        .ok_or_else(|| format!("{} isn't a robot's window", window.label()).into())
}

fn dims_of(size: &str) -> (f64, f64) {
    let k = match size {
        "small" => 0.7,
        "large" => 1.35,
        "huge" => 1.7,
        _ => 1.0,
    };
    ((ROBOT.0 * k).round(), (ROBOT.1 * k).round())
}

struct Drag {
    anchor: (i32, i32),
    at: (i32, i32), // where the window was
}

pub struct Robot {
    hwnd: isize,
    anchor: (i32, i32), // the robot's box, top left (physical px)
    dims: (f64, f64),   // its size (CSS px)
    pub expanded: bool, // the chat is open
    pub tucked: bool,   // awake with the chat put away
    pub peek: bool, // sent away to the island (island.rs): its window veiled, its page still at work
    veiled: bool,   // (its window is, now)
    chat_w: f64,    // how wide you made the chat (CSS px)
    side_w: f64,    // and the side panel beside it, while it's open (side questions; CSS px)
    drag: Option<Drag>,
    resize_from: Option<f64>,
    layout: Option<Layout>,
    seq: u64,
    through: bool,                 // clicks pass through the window
    forwarded: Option<(i32, i32)>, // the cursor, as last passed on to the page
    eyes: Option<(i32, i32)>,      // the cursor, as last told for the eyes
    stage: Option<StageTile>,      // on the stage (stage.rs): its window is this tile
}

/// A robot's tile on the stage: its window (physical px), and what the page needs to know
/// about it (which edges are gaps to drag; in the spotlight, or a strip beside it).
pub struct StageTile {
    pub rect: Rect,
    pub info: Value,
}

#[derive(Clone)]
struct Layout {
    bounds: Rect,
    placement: &'static str,
    panel_w: f64,    // (CSS px)
    max_chat_w: f64, // (CSS px)
    msg: Map<String, Value>,
}

// ---------------------------------------------------------------- for the other modules

/// The robot's box at its desk (physical px), if its window is open.
pub fn desk_rect(app: &AppHandle, id: &str) -> Option<Rect> {
    with(app, |st| {
        let r = st.robots.get(id)?;
        let s = window::scale_of(r.hwnd);
        Some(Rect {
            x: r.anchor.0,
            y: r.anchor.1,
            w: (r.dims.0 * s).round() as i32,
            h: (r.dims.1 * s).round() as i32,
        })
    })
}

/// Its window's handle, if it's open.
pub fn hwnd_of(app: &AppHandle, id: &str) -> Option<isize> {
    with(app, |st| st.robots.get(id).map(|r| r.hwnd))
}

/// The robots whose windows are open.
pub fn open_ids(app: &AppHandle) -> Vec<String> {
    with(app, |st| st.robots.keys().cloned().collect())
}

/// Out on the desktop at its desk: its window showing, not sent away to the island
/// (so visitors, the housemaid and word quizzes leave it be).
pub fn is_showing(app: &AppHandle, id: &str) -> bool {
    with(app, |st| st.robots.get(id).map(|r| (r.hwnd, r.peek)))
        .is_some_and(|(hwnd, peek)| !peek && window::is_visible(hwnd))
}

/// Sent away to the island (its window veiled)?
pub fn is_away(app: &AppHandle, id: &str) -> bool {
    with(app, |st| st.robots.get(id).is_some_and(|r| r.peek))
}

/// Is the chat open (or awake with it tucked away)?
pub fn is_awake(app: &AppHandle, id: &str) -> bool {
    with(app, |st| {
        st.robots.get(id).is_some_and(|r| r.expanded || r.tucked)
    })
}

pub fn set_title(app: &AppHandle, id: &str, name: &str) {
    if let Some(w) = app.get_webview_window(&label_of(id)) {
        let _ = w.set_title(name);
    }
}

/// A new size from the Workshop: it grows (or shrinks) round its feet, the bottom middle
/// staying put.
pub fn resize_robot(app: &AppHandle, id: &str, size: &str) {
    let moved = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        let new = dims_of(size);
        let s = window::scale_of(r.hwnd);
        let (ow, oh) = r.dims;
        let shifted = (
            r.anchor.0 + ((ow - new.0) * s / 2.0).round() as i32,
            r.anchor.1 + ((oh - new.1) * s).round() as i32,
        );
        r.anchor = clamp_anchor(shifted, new);
        r.dims = new;
        let mut patch = Map::new();
        patch.insert("position".into(), to_dip(r.anchor));
        st.store.update(id, patch)
    });
    if moved.is_some() {
        apply_layout(app, id);
    }
}

/// The screens changed (one added or taken away, a new resolution): robots stay reachable.
pub fn refit(app: &AppHandle) {
    let ids = with(app, |st| {
        for r in st.robots.values_mut() {
            r.anchor = clamp_anchor(r.anchor, r.dims);
        }
        st.robots.keys().cloned().collect::<Vec<_>>()
    });
    for id in ids {
        apply_layout(app, &id);
    }
    stage::refit(app);
}

/// Onto the stage as this tile, or (none) back to its desk.
pub fn set_tile(app: &AppHandle, id: &str, tile: Option<StageTile>) {
    if with(app, |st| st.robots.get_mut(id).map(|r| r.stage = tile)).is_some() {
        apply_layout(app, id);
    }
}

/// Off the stage, its window left where it is till it's next laid out (stage::exit).
pub fn clear_tile(app: &AppHandle, id: &str) {
    with(app, |st| st.robots.get_mut(id).map(|r| r.stage = None));
}
