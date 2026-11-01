//! Docked (docs/mockups/dock-*.svg): a robot's chat flush against the left or right edge of
//! its screen, the whole height of it, the robot itself hidden and its face in the title bar
//! (the stage's look). Push the robot against the edge with its chat open (the edge glows),
//! or press Dock, and it docks; Back to desk, or its title bar dragged off the edge, and it's
//! at its desk by that edge again. Robots docked on the same edge of a screen share it,
//! stacked in the order they came: drag the gap between two to share it out again, and the
//! inner edge for the width (the same for every chat on that edge: setting dockWidth).
//!
//! Docked goes with the chat open: tucked away or asleep the robot is at its desk as ever,
//! and it docks again as its chat opens. Sent to the island or onto the stage it leaves the
//! stack (the others close up) till it's back. The island stays in front of a docked chat.
//!
//! With setting dockReserve on, an edge's docked chats keep their room for themselves (an
//! app bar, as the taskbar is): maximised windows stop beside them. The top one's window
//! holds it for the stack.
//!
//! Nothing of its own to lock: where each robot is docked is in its Robot (and its record,
//! dock), so it's all worked out under the State lock, with no call into a window inside it.

mod column;
mod commands;

pub use commands::*;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};

use super::{
    CHAT_MIN, CHAT_W, Layout, Robot, apply_layout, clamp_anchor, label_of, lay_out, object, place,
    to_dip,
};
use crate::platform::window::Rect;
use crate::platform::{appbar, window};
use crate::robots::{island, stage};
use crate::runtime::util::patch;
use crate::runtime::{State, with};

use column::*;

// a docked chat's shortest in a stack (CSS px)
const MIN_H: f64 = 200.0;
// the least of the screen left beside a docked chat (CSS px)
const MARGIN: f64 = 200.0;
// how far a dragged robot's window goes past the screen's edge to dock there (CSS px)
const OVERHANG: f64 = 40.0;

/// The edge of its screen a chat is docked on.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
}

impl Edge {
    fn key(self) -> &'static str {
        match self {
            Edge::Left => "left",
            Edge::Right => "right",
        }
    }
    /// The chat's side away from the screen's edge (dragged to make it wider).
    fn inner(self) -> Edge {
        match self {
            Edge::Left => Edge::Right,
            Edge::Right => Edge::Left,
        }
    }
}

/// Where a robot is docked: its edge, its place along it (0 the top, 1 the bottom: the order
/// of the stack) and its share of the height (relative to the others').
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Docked {
    pub edge: Edge,
    pub at: f64,
    #[serde(default = "one")]
    pub weight: f64,
}

fn one() -> f64 {
    1.0
}

/// A gap between two docked chats (gN: after the Nth), or the stack's inner edge (w).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Gap {
    Width,
    Between(usize),
}

impl Gap {
    fn name(self) -> String {
        match self {
            Gap::Width => "w".into(),
            Gap::Between(k) => format!("g{k}"),
        }
    }
    fn parse(s: &str) -> Option<Gap> {
        if s == "w" {
            return Some(Gap::Width);
        }
        s.strip_prefix('g')?.parse().ok().map(Gap::Between)
    }
}

/// A gap being dragged, as things were when it began.
pub struct GapDrag {
    gap: Gap,
    ids: Vec<String>, // the stack, top to bottom
    sizes: Vec<i32>,  // their heights (physical px)
    width: f64,       // the edge's width (CSS px)
}

/// The strip of its screen a stack's top window keeps for the stack (setting dockReserve).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Kept {
    edge: Edge,
    screen: Rect,
    w: i32,
}

// ---------------------------------------------------------------- the stacks

/// Docked and showing so: its chat open, not away on the island nor on the stage.
pub(super) fn active(r: &Robot) -> Option<Docked> {
    r.dock
        .filter(|_| r.expanded && !r.peek && r.stage.is_none())
}

/// The screen it's docked on: its desk's.
fn screen(r: &Robot) -> window::Monitor {
    place(r.anchor, r.dims).0
}

/// The stack on that edge of that screen (bounds: the screen's), top to bottom.
fn stack(st: &State, bounds: Rect, edge: Edge) -> Vec<(String, Docked)> {
    let mut v: Vec<(String, Docked)> = st
        .robots
        .iter()
        .filter_map(|(id, r)| {
            let d = active(r)?;
            (d.edge == edge && screen(r).bounds == bounds).then(|| (id.clone(), d))
        })
        .collect();
    v.sort_by(|a, b| a.1.at.total_cmp(&b.1.at).then_with(|| a.0.cmp(&b.0)));
    v
}

/// The screen's room for the stack: its work area, with what the stack keeps for itself
/// given back (else it would make room for itself again).
fn room(st: &State, m: &window::Monitor, edge: Edge) -> Rect {
    let kept = st
        .robots
        .values()
        .filter_map(|r| r.kept.filter(|k| k.edge == edge && k.screen == m.bounds))
        .map(|k| k.w)
        .max()
        .unwrap_or(0);
    give_back(m.work, edge, kept)
}

/// How wide an edge's chats are (CSS px).
fn width(st: &State, edge: Edge) -> f64 {
    st.store.settings()["dockWidth"][edge.key()]
        .as_f64()
        .unwrap_or(CHAT_W)
}

fn set_width(st: &mut State, edge: Edge, w: f64) {
    let mut all = st.store.settings()["dockWidth"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    all.insert(edge.key().into(), json!(w));
    st.store
        .update_settings(patch(vec![("dockWidth", Value::Object(all))]));
}

/// Its window's layout, docked (None: it isn't, now).
pub(super) fn layout_in(st: &State, id: &str) -> Option<Layout> {
    let r = st.robots.get(id)?;
    let d = active(r)?;
    let m = screen(r);
    let stack = stack(st, m.bounds, d.edge);
    let i = stack.iter().position(|(s, _)| s == id)?;
    let weights: Vec<f64> = stack.iter().map(|(_, d)| share_of(d)).collect();
    let room = room(st, &m, d.edge);
    let rects = rects(room, m.scale, d.edge, width(st, d.edge), &weights);
    Some(docked_layout(rects[i], m.scale, d.edge, i, stack.len()))
}

/// Flush against the screen's edge, a few px in from the others (the gaps to drag); the chat
/// fills it, as on the stage.
fn docked_layout(b: Rect, s: f64, edge: Edge, i: usize, n: usize) -> Layout {
    let css = |v: i32| (v as f64 / s).round();
    let (w, inset) = (css(b.w), stage::INSET);
    let x = match edge {
        Edge::Left => 0.0,
        Edge::Right => inset,
    };
    let panel_w = w - inset;
    let mut edges = Map::new();
    edges.insert(edge.inner().key().into(), json!(Gap::Width.name()));
    if i > 0 {
        edges.insert("top".into(), json!(Gap::Between(i - 1).name()));
    }
    if i + 1 < n {
        edges.insert("bottom".into(), json!(Gap::Between(i).name()));
    }
    let msg = json!({
        "bounds": { "x": css(b.x), "y": css(b.y), "width": w, "height": css(b.h) },
        "robotX": 0, "robotY": 0, "placement": "dock",
        "panel": { "x": x, "w": panel_w }, "maxChatW": w,
        "stage": { "edges": edges, "dock": edge }, "inset": inset,
    });
    Layout {
        bounds: b,
        placement: "dock",
        panel_w,
        max_chat_w: w,
        msg: object(msg),
    }
}

/// It holds a strip of the screen for a stack it's no longer docked in (its chat put away,
/// sent off, undocked).
pub(in crate::robots) fn leaving(app: &AppHandle, id: &str) -> bool {
    with(app, |st| {
        st.robots
            .get(id)
            .is_some_and(|r| r.kept.is_some() && active(r).is_none())
    })
}

/// Is its chat docked now?
pub fn is_docked(app: &AppHandle, id: &str) -> bool {
    with(app, |st| {
        st.robots.get(id).is_some_and(|r| active(r).is_some())
    })
}

// ---------------------------------------------------------------- docking

/// Dock it on this edge of its screen, `y` (screen px) along it saying where in the stack.
pub fn dock(app: &AppHandle, id: &str, edge: Edge, y: i32) {
    let done = with(app, |st| {
        let r = st.robots.get(id).filter(|r| r.stage.is_none())?;
        let m = screen(r);
        // a share of the height as big as the others' (dragged to any sizes, maybe)
        let others: Vec<f64> = stack(st, m.bounds, edge)
            .into_iter()
            .filter(|(s, _)| s != id)
            .map(|(_, d)| share_of(&d))
            .collect();
        let weight = if others.is_empty() {
            1.0
        } else {
            others.iter().sum::<f64>() / others.len() as f64
        };
        let at = ((y - m.work.y) as f64 / m.work.h.max(1) as f64).clamp(0.0, 1.0);
        let r = st.robots.get_mut(id)?;
        // its desk by that edge, as high as it was (where it's back to as it leaves)
        let (_, w, _) = place(r.anchor, r.dims);
        let x = match edge {
            Edge::Left => m.work.x,
            Edge::Right => m.work.right() - w,
        };
        r.anchor = clamp_anchor((x, r.anchor.1), r.dims);
        let d = Docked { edge, at, weight };
        r.dock = Some(d);
        let anchor = r.anchor;
        st.store.update(
            id,
            patch(vec![("dock", json!(d)), ("position", to_dip(anchor))]),
        )
    });
    if done.is_some() {
        apply_layout(app, id);
    }
}

/// The Dock button: onto the nearer edge of its screen, where it is up and down.
pub fn dock_nearer(app: &AppHandle, id: &str) {
    let pick = with(app, |st| {
        let r = st.robots.get(id)?;
        let (m, w, h) = place(r.anchor, r.dims);
        let (cx, cy) = (r.anchor.0 + w / 2, r.anchor.1 + h / 2);
        let edge = if cx - m.work.x < m.work.right() - cx {
            Edge::Left
        } else {
            Edge::Right
        };
        Some((edge, cy))
    });
    if let Some((edge, y)) = pick {
        dock(app, id, edge, y);
    }
}

/// Back at its desk by the edge it was docked on (its chat beside it, if it's open).
pub fn undock(app: &AppHandle, id: &str) {
    let done = with(app, |st| {
        st.robots.get_mut(id)?.dock.take()?;
        st.store.update(id, patch(vec![("dock", Value::Null)]))
    });
    if done.is_some() {
        apply_layout(app, id);
    }
}

/// The robot dragged round with its chat open (its window now at `at`): the edge it'd dock on
/// if let go now (the window pushed past an outer edge of the screen, robot or chat first, or
/// the mouse against it), told to its page as that changes (it glows).
pub(super) fn drag_hint(app: &AppHandle, id: &str, at: (i32, i32)) {
    let Some((w, h, robot, heading)) = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        let (_, rw, rh) = place(r.anchor, r.dims);
        let robot = (r.anchor.0 + rw / 2, r.anchor.1 + rh / 2);
        let l = r.layout.as_ref()?;
        let (w, h) = (l.bounds.w, l.bounds.h);
        let d = r.drag.as_mut()?;
        // (which way it's going, over a few px: a twitch back doesn't turn it round)
        if (at.0 - d.last_x).abs() >= 3 {
            d.heading = (at.0 - d.last_x).signum();
            d.last_x = at.0;
        }
        Some((w, h, robot, d.heading))
    }) else {
        return;
    };
    // the screen the robot itself is on (the mouse may be on its chat's title bar)
    let m = window::monitor_near(robot.0, robot.1);
    let open = |x: i32| window::monitor_near(x, robot.1).bounds == m.bounds;
    let edge = pushed(
        Push {
            cursor: window::cursor(),
            window: Rect {
                x: at.0,
                y: at.1,
                w,
                h,
            },
            past: (OVERHANG * m.scale).round() as i32,
            heading,
        },
        m.bounds,
        (open(m.bounds.x - 20), open(m.bounds.right() + 20)),
    );
    let changed = with(app, |st| {
        let r = st.robots.get_mut(id)?;
        let edge = edge.filter(|_| r.expanded && r.stage.is_none());
        let d = r.drag.as_mut()?;
        (d.hint != edge).then(|| {
            d.hint = edge;
            edge
        })
    });
    if let Some(edge) = changed {
        let _ = app.emit_to(label_of(id), "robot:dock", json!({ "hint": edge }));
    }
}

// ---------------------------------------------------------------- after a change

/// Every docked chat laid out again (but `skip`: it just was), as one came, went or was
/// made another size.
pub(super) fn reflow(app: &AppHandle, skip: &str) {
    let ids: Vec<String> = with(app, |st| {
        st.robots
            .iter()
            .filter(|(id, r)| *id != skip && active(r).is_some())
            .map(|(id, _)| id.clone())
            .collect()
    });
    for id in ids {
        lay_out(app, &id);
    }
    settled(app);
}

/// The docked chats are where they go: the island back in front of them, and (setting
/// dockReserve) each stack's room kept for it.
pub(super) fn settled(app: &AppHandle) {
    island::raise(app);
    let on = with(app, |st| {
        st.store.settings()["dockReserve"].as_bool() == Some(true)
    });
    let jobs = with(app, |st| {
        // (a stack being made wider or narrower: its strip follows as it's let go, not at every
        // step, which would shove every maximised window round the screen each time)
        if st
            .robots
            .values()
            .any(|r| r.dock_drag.as_ref().is_some_and(|g| g.gap == Gap::Width))
        {
            return vec![];
        }
        let want: HashMap<String, Kept> = if on { wanted(st) } else { HashMap::new() };
        let mut jobs = vec![];
        for (id, r) in st.robots.iter_mut() {
            let now = want.get(id).copied();
            if r.kept != now {
                r.kept = now;
                jobs.push((r.hwnd, now));
            }
        }
        jobs
    });
    for (hwnd, kept) in jobs {
        match kept {
            Some(k) => appbar::reserve(hwnd, k.edge == Edge::Left, k.screen, k.w),
            None => appbar::release(hwnd),
        }
    }
}

/// Setting dockReserve turned on or off: each stack keeps its room, or gives it back.
pub fn reserve_changed(app: &AppHandle) {
    settled(app);
}

/// The strip each stack keeps, by the robot at its top.
fn wanted(st: &State) -> HashMap<String, Kept> {
    let mut want = HashMap::new();
    for (id, r) in &st.robots {
        let (Some(d), Some(l)) = (active(r), r.layout.as_ref()) else {
            continue;
        };
        let m = screen(r);
        let top = stack(st, m.bounds, d.edge).into_iter().next();
        if l.placement == "dock" && top.is_some_and(|(t, _)| t == *id) {
            let k = Kept {
                edge: d.edge,
                screen: m.bounds,
                w: l.bounds.w,
            };
            want.insert(id.clone(), k);
        }
    }
    want
}

/// Its window went: the strip it kept goes back to the screen, and the others close up.
pub(super) fn closed(app: &AppHandle, id: &str, r: &Robot) {
    if r.kept.is_some() {
        appbar::release(r.hwnd);
    }
    if r.dock.is_some() {
        reflow(app, id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docked_is_kept_as_the_page_reads_it() {
        let d = Docked {
            edge: Edge::Right,
            at: 0.25,
            weight: 2.0,
        };
        assert_eq!(
            json!(d),
            json!({ "edge": "right", "at": 0.25, "weight": 2.0 })
        );
        let back: Docked =
            serde_json::from_value(json!({ "edge": "left", "at": 0.5 })).expect("a docked record");
        assert_eq!(
            back,
            Docked {
                edge: Edge::Left,
                at: 0.5,
                weight: 1.0
            }
        );
    }

    #[test]
    fn gaps_round_trip() {
        for g in [Gap::Width, Gap::Between(0), Gap::Between(3)] {
            assert_eq!(Gap::parse(&g.name()), Some(g));
        }
        assert_eq!(Gap::parse("x1"), None);
    }

    #[test]
    fn a_docked_chat_is_flush_with_its_edge_and_drags_from_the_others() {
        let b = Rect {
            x: 1400,
            y: 0,
            w: 520,
            h: 500,
        };
        let l = docked_layout(b, 1.0, Edge::Right, 1, 3);
        assert_eq!(l.placement, "dock");
        assert_eq!(
            l.msg["panel"],
            json!({ "x": stage::INSET, "w": 520.0 - stage::INSET })
        );
        assert_eq!(
            l.msg["stage"],
            json!({ "edges": { "left": "w", "top": "g0", "bottom": "g1" }, "dock": "right" })
        );
        let l = docked_layout(b, 1.0, Edge::Left, 0, 1);
        assert_eq!(l.msg["panel"]["x"], json!(0.0));
        assert_eq!(l.msg["stage"]["edges"], json!({ "right": "w" }));
    }
}
