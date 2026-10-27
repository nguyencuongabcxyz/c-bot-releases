//! The word card (main wordCard.js): a window ("card") beside the robot that caught a word,
//! showing the word while it's looked up and then its meanings and phrases. One card at a
//! time; a new word takes over the open card. As big as the robot's chat where its chat
//! would go, or, for a dream, a small card by the robot. The page (renderer/card) asks for
//! its word with card:init, says how tall it wants to be with card:size, and sends its
//! buttons with card:act (features/vocab/mod.rs on_action).
//!
//! Positions are physical px; the page's sizes are its CSS px (times the screen's scale).

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::platform::window;
use crate::platform::window::Rect;
use crate::ui::{place, views};

pub const LABEL: &str = "card";
const W: f64 = 360.0;
const GAP: f64 = 6.0;
const PAINT: &str = "#5ac8fa";
const CHAT_W: f64 = crate::robots::CHAT_W;
const CHAT_MIN: f64 = 360.0; // (robots/mod.rs's narrowest chat)

/// Where the card goes: as big as a chat (these bounds), or a small one by this box (a
/// robot; none: the mouse).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Spot {
    Bounds(Rect),
    Near(Option<Rect>),
}

/// The word on the card, which robot caught it and its colour.
#[derive(Clone)]
pub struct Shown {
    pub word: Value, // with known / quiz / dream when it's one of those
    pub robot_id: Option<String>,
    pub paint: String,
    spot: Spot,
}

struct Card {
    shown: Option<Shown>,
    hwnd: Option<isize>,
    height: f64, // what the page asked for (CSS px)
}

fn card<R>(app: &AppHandle, f: impl FnOnce(&mut Card) -> R) -> Option<R> {
    let state = app.try_state::<Mutex<Card>>()?;
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    Some(f(&mut guard))
}

/// A small card by `near` (a robot's box, or the mouse's point) on its screen `wa` (its work
/// area, physical px) at `scale`: above it if there's room, else beside it (wordCard.js place).
pub fn near_bounds(near: Rect, wa: Rect, scale: f64, height: f64) -> Rect {
    place::above_or_beside(near, wa, scale, (W, height), GAP)
}

/// As big as a chat (the standard width, however wide you've dragged this robot's) where its
/// chat would go (robots/mod.rs layout_for), from the top of the screen to the bottom; with the
/// chat already open there, the robot's other side if that has room (main.js cardBounds).
/// desk: the robot's box; wa: its screen's work area; all physical px.
pub fn chat_bounds(desk: Rect, wa: Rect, scale: f64, chat_open: bool) -> Rect {
    let (want, min) = (CHAT_W * scale, CHAT_MIN * scale);
    let room_left = (desk.x - wa.x) as f64;
    let room_right = (wa.right() - desk.right()) as f64;
    let mut left = room_left >= want || room_left >= room_right;
    if chat_open && (if left { room_right } else { room_left }) >= min {
        left = !left;
    }
    let room = if left { room_left } else { room_right };
    let width = want.min(room.max(min)).min(wa.w as f64).round() as i32;
    let x = if left { desk.x - width } else { desk.right() };
    Rect { x: x.max(wa.x).min(wa.right() - width), y: wa.y, w: width, h: wa.h }
}

fn bounds_for(spot: Spot, height: f64) -> Rect {
    match spot {
        Spot::Bounds(b) => b,
        Spot::Near(near) => {
            let (near, m) = place::around(near);
            near_bounds(near, m.work, m.scale, height)
        }
    }
}

/// Put it where it goes, on top, without taking the focus from the app you're in.
fn place(app: &AppHandle) {
    let Some(Some((hwnd, spot, height))) = card(app, |c| Some((c.hwnd?, c.shown.as_ref()?.spot, c.height))) else { return };
    window::set_bounds(hwnd, bounds_for(spot, height));
    window::show_no_activate(hwnd);
    window::set_topmost(hwnd);
}

/// Show this word on the card (a new one takes over the open card).
pub fn open(app: &AppHandle, word: Value, robot_id: Option<String>, paint: Option<String>, spot: Spot) {
    let paint = paint.filter(|p| !p.is_empty()).unwrap_or_else(|| PAINT.into());
    let shown = Shown { word: word.clone(), robot_id, paint: paint.clone(), spot };
    let open = card(app, |c| {
        c.shown = Some(shown);
        c.hwnd.is_some()
    });
    match open {
        None => {}
        Some(true) => {
            let _ = app.emit_to(LABEL, "card:word", json!({ "word": word, "paint": paint, "fresh": true }));
            place(app);
        }
        Some(false) => build(app),
    }
}

fn build(app: &AppHandle) {
    let height = card(app, |c| c.height).unwrap_or(220.0);
    let built = views::builder(app, LABEL, "card", &[])
        .title("Word card")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .inner_size(W, height)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            if app.get_webview_window(LABEL).is_some() {
                // (opened a moment ago from elsewhere: it takes this word instead)
                if let Some(s) = shown(app) {
                    let _ = app.emit_to(LABEL, "card:word", json!({ "word": s.word, "paint": s.paint, "fresh": true }));
                }
                place(app);
            } else {
                eprintln!("[card] couldn't open: {err}");
                card(app, |c| c.shown = None);
            }
            return;
        }
    };
    let Ok(hwnd) = window.hwnd().map(|h| h.0 as isize) else { return };
    card(app, |c| c.hwnd = Some(hwnd));
    let app2 = app.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            card(&app2, |c| {
                c.hwnd = None;
                c.shown = None;
            });
            // (a quiz left on it ends; off the main thread, it tells robots and the tray)
            let app = app2.clone();
            std::thread::spawn(move || super::card_closed(&app));
        }
    });
    place(app);
}

/// The word changed (looked up, edited): the card follows if it's showing it, still a word
/// you had (no Undo), still a quiz or a dream.
pub fn update(app: &AppHandle, word: &Value) {
    let send = card(app, |c| {
        let s = c.shown.as_mut()?;
        if s.word["id"] != word["id"] {
            return None;
        }
        let mut next = word.clone();
        for k in ["known", "quiz", "dream"] {
            if let (Some(v), Some(o)) = (s.word.get(k).cloned(), next.as_object_mut()) {
                o.insert(k.into(), v);
            }
        }
        s.word = next;
        Some(json!({ "word": s.word, "paint": s.paint }))
    });
    if let Some(Some(payload)) = send {
        let _ = app.emit_to(LABEL, "card:word", payload);
    }
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// Close it in a moment (after the page has shown what happened).
pub fn close_after(app: &AppHandle, ms: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        close(&app);
    });
}

/// The word it's showing, and for whom.
pub fn shown(app: &AppHandle) -> Option<Shown> {
    card(app, |c| c.shown.clone()).flatten()
}

/// What the page opens with (card:init).
pub fn init(app: &AppHandle) -> Value {
    shown(app).map_or(Value::Null, |s| json!({ "word": s.word, "paint": s.paint }))
}

/// How tall the page wants to be (card:size, CSS px).
pub fn size(app: &AppHandle, h: f64) {
    if !h.is_finite() {
        return;
    }
    card(app, |c| c.height = h.ceil().clamp(120.0, 640.0));
    place(app);
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Card { shown: None, hwnd: None, height: 220.0 }));
}

#[cfg(test)]
mod tests {
    use super::*;

    const WA: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };

    #[test]
    fn above_the_robot_when_theres_room() {
        let robot = Rect { x: 1500, y: 700, w: 300, h: 290 };
        assert_eq!(near_bounds(robot, WA, 1.0, 220.0), Rect { x: 1470, y: 474, w: 360, h: 220 });
        // at 150%: everything half as big again
        let r = near_bounds(Rect { x: 2250, y: 1050, w: 450, h: 435 }, Rect { x: 0, y: 0, w: 2880, h: 1560 }, 1.5, 220.0);
        assert_eq!((r.w, r.h, r.y), (540, 330, 1050 - 330 - 9));
    }

    #[test]
    fn beside_it_at_the_top_of_the_screen() {
        // no room above: on its left, bottoms lined up
        let robot = Rect { x: 1500, y: 20, w: 300, h: 290 };
        assert_eq!(near_bounds(robot, WA, 1.0, 220.0), Rect { x: 1134, y: 90, w: 360, h: 220 });
        // no room on the left either: on its right
        let robot = Rect { x: 100, y: 20, w: 300, h: 290 };
        assert_eq!(near_bounds(robot, WA, 1.0, 220.0), Rect { x: 406, y: 90, w: 360, h: 220 });
    }

    #[test]
    fn as_big_as_the_chat_where_it_would_go() {
        // in the bottom-right corner: on the left, the chat's width, the screen's height
        let desk = Rect { x: 1590, y: 740, w: 300, h: 290 };
        assert_eq!(chat_bounds(desk, WA, 1.0, false), Rect { x: 1070, y: 0, w: 520, h: 1040 });
        // the chat's open there: the other side if it has room for a chat (here it hasn't)…
        assert_eq!(chat_bounds(desk, WA, 1.0, true), Rect { x: 1070, y: 0, w: 520, h: 1040 });
        // …and as much as there is there
        let desk = Rect { x: 1200, y: 740, w: 300, h: 290 };
        assert_eq!(chat_bounds(desk, WA, 1.0, true), Rect { x: 1500, y: 0, w: 420, h: 1040 });
        // at the left edge: on the right
        let desk = Rect { x: 10, y: 740, w: 300, h: 290 };
        assert_eq!(chat_bounds(desk, WA, 1.0, false), Rect { x: 310, y: 0, w: 520, h: 1040 });
        // at 150%
        let desk = Rect { x: 2400, y: 1100, w: 450, h: 435 };
        assert_eq!(chat_bounds(desk, Rect { x: 0, y: 0, w: 2880, h: 1560 }, 1.5, false), Rect { x: 1620, y: 0, w: 780, h: 1560 });
    }

    #[test]
    fn kept_on_the_screen() {
        // by the mouse at the right edge
        let r = near_bounds(Rect { x: 1915, y: 600, w: 0, h: 0 }, WA, 1.0, 220.0);
        assert_eq!((r.x, r.y), (1920 - 360 - 6, 374));
        // taller than the screen: as tall as fits
        assert_eq!(near_bounds(Rect { x: 900, y: 500, w: 0, h: 0 }, WA, 1.0, 5000.0).h, 1040 - 12);
    }
}
