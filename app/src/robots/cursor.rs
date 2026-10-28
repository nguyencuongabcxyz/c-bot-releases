//! The cursor, watched: over a robot's see-through parts, clicks go through to what's behind.

use super::*;

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
