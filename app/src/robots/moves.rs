//! What the robot's page asks of its window: the chat open or closed, peeking, dragging, resizing, letting clicks through.

use super::*;

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
