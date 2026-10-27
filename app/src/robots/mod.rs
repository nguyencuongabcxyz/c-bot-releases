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

pub mod ipc;
pub mod island;
pub mod maid;
pub mod planes;
pub mod revive;
pub mod screens;
pub mod social;
pub mod stage;
pub mod topmost;
pub mod walkers;

use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::features::chat;
use crate::platform::window;
use crate::platform::window::Rect;
use crate::runtime::{State, with};
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
pub fn sender(window: &tauri::WebviewWindow) -> Result<String, String> {
    id_of(window.label())
        .map(str::to_string)
        .ok_or_else(|| format!("{} isn't a robot's window", window.label()))
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

// ---------------------------------------------------------------- where things go

/// The screen a robot's box is on and its size there in physical px.
fn place(anchor: (i32, i32), dims: (f64, f64)) -> (window::Monitor, i32, i32) {
    let first = window::monitor_near(anchor.0, anchor.1);
    let (w, h) = ((dims.0 * first.scale) as i32, (dims.1 * first.scale) as i32);
    let m = window::monitor_near(anchor.0 + w / 2, anchor.1 + h / 2);
    (
        m,
        (dims.0 * m.scale).round() as i32,
        (dims.1 * m.scale).round() as i32,
    )
}

fn default_anchor(index: usize) -> (i32, i32) {
    let p = window::primary_monitor();
    let (wa, s) = (p.work, p.scale);
    let x = wa.right() as f64 - (ROBOT.0 + 30.0) * s - index as f64 * (ROBOT.0 + 10.0) * s;
    let y = wa.bottom() as f64 - (ROBOT.1 + 10.0) * s;
    (x.round() as i32, y.round() as i32)
}

fn clamp_anchor(anchor: (i32, i32), dims: (f64, f64)) -> (i32, i32) {
    let (m, w, h) = place(anchor, dims);
    let wa = m.work;
    (
        anchor.0.max(wa.x).min(wa.right() - w),
        anchor.1.max(wa.y).min(wa.bottom() - h),
    )
}

/// A stored position (the Electron app's DIPs) in physical px, and back.
fn from_dip(p: &Value) -> Option<(i32, i32)> {
    let s = window::primary_monitor().scale;
    Some((
        (p.get("x")?.as_f64()? * s).round() as i32,
        (p.get("y")?.as_f64()? * s).round() as i32,
    ))
}

fn to_dip(p: (i32, i32)) -> Value {
    let s = window::primary_monitor().scale;
    json!({ "x": (p.0 as f64 / s).round() as i64, "y": (p.1 as f64 / s).round() as i64 })
}

/// The chat goes on whichever side of the robot has room for it (left first: robots
/// start in the bottom-right corner), from the top of the screen to the bottom.
fn layout_for(
    anchor: (i32, i32),
    expanded: bool,
    tucked: bool,
    peek: bool,
    chat_w: f64,
    dims: (f64, f64),
) -> Layout {
    let (m, dw, dh) = place(anchor, dims);
    let s = m.scale;
    let css = |v: i32| (v as f64 / s).round();
    let bounds_msg =
        |b: Rect| json!({ "x": css(b.x), "y": css(b.y), "width": css(b.w), "height": css(b.h) });
    if peek && !expanded && !tucked {
        // Sent away to the island: asleep-sized at its desk, its window veiled (apply_layout)
        let bounds = Rect {
            x: anchor.0,
            y: anchor.1,
            w: dw,
            h: dh,
        };
        let msg = json!({ "bounds": bounds_msg(bounds), "robotX": 0, "robotY": 0, "placement": "hidden" });
        return Layout {
            bounds,
            placement: "hidden",
            panel_w: 0.0,
            max_chat_w: CHAT_W,
            msg: msg.as_object().unwrap().clone(),
        };
    }
    if !expanded && tucked {
        // The chat put away keeps the window the size and place it has with the chat open
        // (the rest is see-through and lets clicks through), so tucking it away and opening
        // it again is just the page: no window move, which would flicker.
        let mut open = layout_for(anchor, true, false, false, chat_w, dims);
        let robot_y = open.msg["robotY"].as_f64().unwrap_or(0.0);
        open.msg.insert("side".into(), json!(open.placement));
        open.placement = if robot_y >= TUCK_STRIP {
            "tuck-above"
        } else {
            "tuck-below"
        };
        open.msg.insert("placement".into(), json!(open.placement));
        return open;
    }
    if !expanded {
        let bounds = Rect {
            x: anchor.0,
            y: anchor.1,
            w: dw,
            h: dh,
        };
        let msg =
            json!({ "bounds": bounds_msg(bounds), "robotX": 0, "robotY": 0, "placement": "none" });
        return Layout {
            bounds,
            placement: "none",
            panel_w: 0.0,
            max_chat_w: CHAT_W,
            msg: msg.as_object().unwrap().clone(),
        };
    }
    let wa = m.work;
    let room_left = (anchor.0 - wa.x) as f64;
    let room_right = (wa.right() - (anchor.0 + dw)) as f64;
    let want = CHAT_MIN.max(chat_w) * s;
    let placement = if room_left >= want || room_left >= room_right {
        "left"
    } else {
        "right"
    };
    let room = if placement == "left" {
        room_left
    } else {
        room_right
    };
    let panel_w = want
        .min(room)
        .max((CHAT_MIN * s).min((wa.w - dw) as f64))
        .round() as i32;
    let x = if placement == "left" {
        anchor.0 - panel_w
    } else {
        anchor.0
    };
    let x = x.max(wa.x).min(wa.right() - panel_w - dw);
    let bounds = Rect {
        x,
        y: wa.y,
        w: panel_w + dw,
        h: wa.h,
    };
    let (robot_x, robot_y) = (css(anchor.0 - x), css(anchor.1 - wa.y));
    let (width, rw) = (css(bounds.w), dims.0);
    // where the panel goes inside the window (its shadow and tail need a few px)
    let panel = if placement == "left" {
        json!({ "x": 8, "w": (robot_x - 14.0).max(200.0) })
    } else {
        json!({ "x": robot_x + rw + 6.0, "w": (width - robot_x - rw - 14.0).max(200.0) })
    };
    let max_chat_w = CHAT_MIN.max((room / s).round());
    let msg = json!({ "bounds": bounds_msg(bounds), "robotX": robot_x, "robotY": robot_y, "placement": placement, "panel": panel, "maxChatW": max_chat_w });
    Layout {
        bounds,
        placement,
        panel_w: panel["w"].as_f64().unwrap(),
        max_chat_w,
        msg: msg.as_object().unwrap().clone(),
    }
}

/// On the stage: the window is its tile, the chat fills it (stage::INSET in from its edges),
/// the robot itself hides (its face goes in the chat's title bar).
fn stage_layout(t: &StageTile) -> Layout {
    let b = t.rect;
    let s = window::monitor_near(b.x + b.w / 2, b.y + b.h / 2).scale;
    let css = |v: i32| (v as f64 / s).round();
    let (w, inset) = (css(b.w), stage::INSET);
    let panel_w = w - 2.0 * inset;
    let msg = json!({
        "bounds": { "x": css(b.x), "y": css(b.y), "width": w, "height": css(b.h) },
        "robotX": 0, "robotY": 0, "placement": "stage",
        "panel": { "x": inset, "w": panel_w }, "maxChatW": w,
        "stage": t.info, "inset": inset,
    });
    Layout {
        bounds: b,
        placement: "stage",
        panel_w,
        max_chat_w: w,
        msg: msg.as_object().unwrap().clone(),
    }
}

/// Lay the window out for how the robot is now (asleep, awake, chat open, sent away, on the
/// stage), and tell the page.
pub fn apply_layout(app: &AppHandle, id: &str) {
    let job = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        let layout = match &r.stage {
            Some(t) => stage_layout(t),
            None => layout_for(
                r.anchor,
                r.expanded,
                r.tucked,
                r.peek,
                r.chat_w + r.side_w,
                r.dims,
            ), // (the panel makes room for both)
        };
        r.seq += 1;
        let mut msg = layout.msg.clone();
        msg.insert("expanded".into(), json!(r.expanded));
        msg.insert("seq".into(), json!(r.seq));
        msg.insert("masked".into(), json!(false));
        msg.insert(
            "sideW".into(),
            json!(if r.stage.is_some() { 0.0 } else { r.side_w }),
        );
        let bounds = layout.bounds;
        let hide = layout.placement == "hidden";
        let veil = (hide != r.veiled).then_some(hide);
        r.veiled = hide;
        r.layout = Some(layout);
        Some((r.hwnd, msg, bounds, veil, hide))
    });
    let Some((hwnd, msg, bounds, veil, hide)) = job else {
        return;
    };
    let _ = app.emit_to(label_of(id), "robot:layout", msg);
    // (sent away, it's veiled where it is: moved back to its desk first, it would show there
    // for a moment; it goes back there as it comes out)
    if !hide {
        window::set_bounds(hwnd, bounds);
    }
    if let Some(hide) = veil {
        walkers::veil(app, hwnd, hide);
    }
}

// ---------------------------------------------------------------- the window

/// What the page knows about its robot (main.js robotView).
pub fn view(st: &State, c: &Value) -> Value {
    let id = c["id"].as_str().unwrap_or("");
    let mut v = c.clone();
    let mut any_busy = false;
    let tabs: Vec<Value> = c["tabs"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| {
                    let mut t = t.clone();
                    let busy = chat::is_busy(st, id, t["id"].as_str().unwrap_or(""));
                    any_busy |= busy;
                    t["custom"] = json!(!t["title"].as_str().unwrap_or("").is_empty());
                    t["title"] = json!(title_for(&t));
                    t["busy"] = json!(busy);
                    t
                })
                .collect()
        })
        .unwrap_or_default();
    let closed: Vec<Value> = c["closedTabs"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| json!({ "id": t["id"], "title": title_for(t), "closedAt": t["closedAt"] }))
                .collect()
        })
        .unwrap_or_default();
    v["tabs"] = json!(tabs);
    v["closedTabs"] = json!(closed);
    v["busy"] = json!(any_busy);
    let term = terminal::tab_of(st, id);
    v["terminalOpen"] = json!(term.is_some());
    v["terminalTab"] = json!(term);
    v
}

pub fn send_character(app: &AppHandle, id: &str) {
    if let Some(c) = with(app, |st| st.store.get(id).map(|c| view(st, c))) {
        let _ = app.emit_to(label_of(id), "robot:character", c);
    }
    island::changed(app); // (a new name or paint)
}

pub fn open(app: &AppHandle, id: &str, index: usize) -> tauri::Result<()> {
    let label = label_of(id);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return Ok(());
    };
    let dims = dims_of(c["size"].as_str().unwrap_or("normal"));
    let anchor = clamp_anchor(
        from_dip(&c["position"]).unwrap_or_else(|| default_anchor(index)),
        dims,
    );
    let win = views::builder(app, &label, "robot", &[("id", id)])
        .title(c["name"].as_str().unwrap_or("Robo"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(dims.0, dims.1)
        .build()?;
    let hwnd = win.hwnd()?.0 as isize;
    let (_, w, h) = place(anchor, dims);
    window::set_bounds(
        hwnd,
        Rect {
            x: anchor.0,
            y: anchor.1,
            w,
            h,
        },
    );
    let chat_w = c["chatWidth"].as_f64().unwrap_or(CHAT_W);
    // (away on the island: veiled from the start; with the island turned off, out on its desk)
    let peek = c["peek"].as_bool().unwrap_or(false) && island::on(app);
    if !peek && c["peek"].as_bool() == Some(true) {
        with(app, |st| {
            st.store.update(
                id,
                crate::runtime::util::patch(vec![("peek", json!(false))]),
            )
        });
    }
    if peek {
        walkers::veil(app, hwnd, true);
    }
    with(app, |st| {
        st.robots.insert(
            id.to_string(),
            Robot {
                hwnd,
                anchor,
                dims,
                expanded: false,
                tucked: false,
                peek,
                veiled: peek,
                chat_w,
                side_w: 0.0,
                drag: None,
                resize_from: None,
                layout: None,
                seq: 0,
                through: false,
                forwarded: None,
                eyes: None,
                stage: None,
            },
        )
    });
    revive::watch(app, &win, id);
    let (app2, id2) = (app.clone(), id.to_string());
    win.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            // (only if it's still this window: built again, a new one may be there already)
            let mine = with(&app2, |st| {
                let mine = st.robots.get(&id2).is_some_and(|r| r.hwnd == hwnd);
                if mine {
                    st.robots.remove(&id2);
                }
                mine
            });
            if mine {
                revive::forget(&app2, &id2);
                walkers::close(&app2, &id2); // (put away while out for a walk: the walker goes too)
                shell::close(&app2, &id2); // (and the shell in its chat)
                stage::gone(&app2, &id2);
                island::gone(&app2, &id2);
            }
        }
    });
    island::changed(app);
    Ok(())
}

// ---------------------------------------------------------------- what the page asks for

/// Awake or asleep, the chat open or tucked away.
pub fn expand(app: &AppHandle, id: &str, expanded: bool, opts: &Value) {
    let focus = opts["focus"].as_bool().unwrap_or(true);
    let tucked = opts["tucked"].as_bool().unwrap_or(false);
    let found = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        r.expanded = expanded;
        r.tucked = !expanded && tucked;
        Some(r.stage.is_some())
    });
    let Some(staged) = found else { return };
    if staged && !expanded {
        return stage::leave(app, id); // (gone to sleep on the stage: off it, back to its desk)
    }
    apply_layout(app, id);
    if expanded
        && focus
        && let Some(w) = app.get_webview_window(&label_of(id))
    {
        let _ = w.set_focus();
    }
}

/// Sent away to the island (or back at its desk). Remembered, so it stays away after a
/// restart.
pub fn set_peek(app: &AppHandle, id: &str, peek: bool) {
    let found = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        r.peek = peek;
        st.store
            .update(id, crate::runtime::util::patch(vec![("peek", json!(peek))]))
    });
    if found.is_some() {
        if peek {
            stage::leave(app, id); // (sent away from the stage: off it first)
        }
        apply_layout(app, id);
        island::changed(app);
    }
}

/// The robot dragged round the screen (dx, dy: CSS px since the press).
pub fn drag(app: &AppHandle, id: &str, p: &Value) {
    let dx = p["dx"].as_f64().unwrap_or(0.0);
    let dy = p["dy"].as_f64().unwrap_or(0.0);
    match p["phase"].as_str() {
        Some("start") => {
            with(app, |st| {
                if let Some(r) = st.robots.get_mut(id).filter(|r| r.stage.is_none()) {
                    let at = window::window_rect(r.hwnd);
                    r.drag = Some(Drag {
                        anchor: r.anchor,
                        at: (at.x, at.y),
                    });
                }
            });
            island::robot_drag(app, "start");
        }
        Some("move") => {
            let moved = with(app, |st| {
                let r = st.robots.get_mut(id)?;
                let d = r.drag.as_ref()?;
                let s = window::scale_of(r.hwnd);
                let (mx, my) = ((dx * s).round() as i32, (dy * s).round() as i32);
                r.anchor = (d.anchor.0 + mx, d.anchor.1 + my);
                Some((r.hwnd, d.at.0 + mx, d.at.1 + my))
            });
            if let Some((hwnd, x, y)) = moved {
                window::set_position(hwnd, x, y);
                island::robot_drag(app, "move"); // (the island lights up: drop it there to send it away)
            }
        }
        Some("end") if island::robot_drag(app, "end") => {
            // dropped on the island: away it goes, its desk where it was before the drag
            let done = with(app, |st| {
                let r = st.robots.get_mut(id)?;
                let d = r.drag.take()?;
                r.anchor = d.anchor;
                r.peek = true;
                st.store
                    .update(id, crate::runtime::util::patch(vec![("peek", json!(true))]))
            });
            if done.is_some() {
                apply_layout(app, id);
                let _ = app.emit_to(label_of(id), "robot:action", "peek"); // (the page catches up: asleep, its desk not drawn)
                island::changed(app);
            }
        }
        Some("end") => {
            let done = with(app, |st| {
                let r = st.robots.get_mut(id)?;
                r.drag.take()?;
                r.anchor = clamp_anchor(r.anchor, r.dims);
                let mut patch = Map::new();
                patch.insert("position".into(), to_dip(r.anchor));
                st.store.update(id, patch)
            });
            if done.is_some() {
                apply_layout(app, id); // re-flow the chat if it was dragged near an edge
            }
        }
        _ => {}
    }
}

/// Dragging the chat panel's outer edge: wider or narrower (the robot stays put).
pub fn resize(app: &AppHandle, id: &str, p: &Value) {
    let dx = p["dx"].as_f64().unwrap_or(0.0);
    let relayout = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        if !r.expanded || r.stage.is_some() {
            return None;
        }
        match p["phase"].as_str()? {
            "start" => {
                r.resize_from = Some(
                    r.layout
                        .as_ref()
                        .map_or(r.chat_w, |l| l.panel_w + 14.0 - r.side_w),
                );
                None
            }
            "move" => {
                let from = r.resize_from?;
                let l = r.layout.as_ref();
                let grow = if l.map(|l| l.placement) == Some("right") {
                    dx
                } else {
                    -dx
                };
                r.chat_w = (from + grow)
                    .max(CHAT_MIN)
                    .min(l.map_or(CHAT_W, |l| l.max_chat_w - r.side_w))
                    .round();
                Some(())
            }
            "end" => {
                r.resize_from.take()?;
                let w = r.chat_w;
                let mut patch = Map::new();
                patch.insert("chatWidth".into(), json!(w));
                st.store.update(id, patch);
                None
            }
            "reset" => {
                r.chat_w = CHAT_W;
                let mut patch = Map::new();
                patch.insert("chatWidth".into(), json!(CHAT_W));
                st.store.update(id, patch);
                Some(())
            }
            _ => None,
        }
    });
    if relayout.is_some() {
        apply_layout(app, id);
    }
}

/// The side panel opened beside the chat (its width, CSS px) or shut (0): the chat's room grows
/// or shrinks by that much, away from the robot.
pub fn set_side_width(app: &AppHandle, id: &str, width: f64) {
    let changed = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        let w = width.clamp(0.0, 900.0).round();
        (r.side_w != w).then(|| r.side_w = w)
    });
    if changed.is_some() {
        apply_layout(app, id);
    }
}

/// The awake window is mostly see-through: clicks there go to whatever is behind it.
pub fn click_through(app: &AppHandle, id: &str, through: bool) {
    let changed = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        if r.through == through {
            return None;
        }
        r.through = through;
        r.forwarded = None;
        Some(())
    });
    if changed.is_some()
        && let Some(w) = app.get_webview_window(&label_of(id))
    {
        let _ = w.set_ignore_cursor_events(through);
    }
}

// ---------------------------------------------------------------- the cursor

/// Watch the cursor: eyes follow it (robot:cursor, relative to the robot's box), and
/// while a window lets clicks through it still hears where the mouse is (cbot:forward,
/// what Electron's setIgnoreMouseEvents forward did), so it can take clicks again once
/// the mouse is back over something solid.
pub fn watch_cursor(app: AppHandle) {
    thread::spawn(move || {
        let mut tick: u64 = 0;
        loop {
            thread::sleep(CURSOR_POLL);
            tick += 1;
            let (cx, cy) = window::cursor();
            let sends = with(&app, |st| {
                let mut out = vec![];
                for (id, r) in st.robots.iter_mut() {
                    if !window::is_visible(r.hwnd) {
                        continue;
                    }
                    let s = window::scale_of(r.hwnd);
                    if tick.is_multiple_of(2) && r.eyes != Some((cx, cy)) {
                        r.eyes = Some((cx, cy));
                        let at = json!({ "x": (cx - r.anchor.0) as f64 / s, "y": (cy - r.anchor.1) as f64 / s });
                        out.push((id.clone(), "robot:cursor", at));
                    }
                    if r.through && r.forwarded != Some((cx, cy)) {
                        let b = window::window_rect(r.hwnd);
                        if b.contains(cx, cy) {
                            r.forwarded = Some((cx, cy));
                            let at = json!({ "x": (cx - b.x) as f64 / s, "y": (cy - b.y) as f64 / s, "sx": cx as f64 / s, "sy": cy as f64 / s });
                            out.push((id.clone(), "cbot:forward", at));
                        }
                    }
                }
                out
            });
            for (id, event, payload) in sends {
                let _ = app.emit_to(label_of(&id), event, payload);
            }
            // robots out for a walk follow the mouse too (and a walker can walk under a still one)
            walkers::cursor(&app, (cx, cy));
            island::cursor(&app, (cx, cy)); // (hovered, or dragged round the edges)
        }
    });
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
