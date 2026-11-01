//! What a robot's page asks of docking: docked or back to its desk, and the gaps dragged.

use super::*;
use crate::robots;
use crate::runtime::Error;

/// The chat's Dock and Back to desk buttons (and its title bar dragged off the edge).
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DockAction {
    Dock,
    Undock,
}

#[tauri::command(async)]
pub fn robot_dock(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: DockAction,
) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    match action {
        DockAction::Dock => dock_nearer(&app, &id),
        DockAction::Undock => undock(&app, &id),
    }
    Ok(())
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Start,
    Move,
    End,
    Even,
}

/// A gap dragged: its name (Gap), and how far since the press (CSS px).
#[derive(Deserialize)]
pub struct SplitStep {
    phase: Phase,
    split: String,
    #[serde(default)]
    d: f64,
}

/// A docked chat's inner edge dragged (the width of every chat on that edge), or the gap
/// between two in a stack; double-clicked ("even"): the width it started at, or the stack
/// shared out evenly.
#[tauri::command(async)]
pub fn robot_dock_split(
    app: AppHandle,
    window: tauri::WebviewWindow,
    step: SplitStep,
) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    let Some(gap) = Gap::parse(&step.split) else {
        return Ok(());
    };
    let moved = with(&app, |st| match step.phase {
        Phase::Start => start_split(st, &id, gap),
        Phase::Move => move_split(st, &id, gap, step.d),
        Phase::End => end_split(st, &id),
        Phase::Even => even(st, &id, gap),
    });
    if moved {
        reflow(&app, "");
    }
    Ok(())
}

/// The stack it's in, as it is now: its screen, edge, ids and their heights (physical px).
fn now(st: &State, id: &str) -> Option<(window::Monitor, Edge, Vec<String>, Vec<i32>)> {
    let r = st.robots.get(id)?;
    let d = active(r)?;
    let m = screen(r);
    let stack = stack(st, m.bounds, d.edge);
    let weights: Vec<f64> = stack.iter().map(|(_, d)| share_of(d)).collect();
    let sizes = split_px(room(st, &m, d.edge).h, &weights);
    Some((
        m,
        d.edge,
        stack.into_iter().map(|(s, _)| s).collect(),
        sizes,
    ))
}

fn start_split(st: &mut State, id: &str, gap: Gap) -> bool {
    let Some((_, edge, ids, sizes)) = now(st, id) else {
        return false;
    };
    let width = width(st, edge);
    if let Some(r) = st.robots.get_mut(id) {
        r.dock_drag = Some(GapDrag {
            gap,
            ids,
            sizes,
            width,
        });
    }
    false
}

fn move_split(st: &mut State, id: &str, gap: Gap, d: f64) -> bool {
    let Some((m, edge, _, _)) = now(st, id) else {
        return false;
    };
    let Some(g) = st
        .robots
        .get(id)
        .and_then(|r| r.dock_drag.as_ref())
        .filter(|g| g.gap == gap)
    else {
        return false;
    };
    match gap {
        Gap::Width => {
            // the inner edge: away from the screen's edge is wider
            let grow = match edge {
                Edge::Left => d,
                Edge::Right => -d,
            };
            let w = width_css(room(st, &m, edge), m.scale, g.width + grow);
            set_width(st, edge, w);
        }
        Gap::Between(k) => {
            let px = |v: f64| (v * m.scale).round() as i32;
            let sizes = give(&g.sizes, k, px(d), px(MIN_H));
            let ids = g.ids.clone();
            set_weights(st, &ids, &sizes);
        }
    }
    true
}

fn set_weights(st: &mut State, ids: &[String], sizes: &[i32]) {
    for (id, w) in ids.iter().zip(shares(sizes)) {
        if let Some(d) = st.robots.get_mut(id).and_then(|r| r.dock.as_mut()) {
            d.weight = w;
        }
    }
}

/// Let go: the stack's new shares kept (the width is already).
fn end_split(st: &mut State, id: &str) -> bool {
    let Some(g) = st.robots.get_mut(id).and_then(|r| r.dock_drag.take()) else {
        return false;
    };
    save(st, &g.ids);
    false
}

fn save(st: &mut State, ids: &[String]) {
    for id in ids {
        if let Some(d) = st.robots.get(id).and_then(|r| r.dock) {
            st.store.update(id, patch(vec![("dock", json!(d))]));
        }
    }
}

fn even(st: &mut State, id: &str, gap: Gap) -> bool {
    let Some((_, edge, ids, sizes)) = now(st, id) else {
        return false;
    };
    match gap {
        Gap::Width => set_width(st, edge, CHAT_W),
        Gap::Between(_) => {
            set_weights(st, &ids, &vec![1; sizes.len()]);
            save(st, &ids);
        }
    }
    true
}
