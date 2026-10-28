//! Where things go: the robot's spot on its screen (an anchor that survives screen changes), and its window's layout as it shows its chat, peeks or stands on the stage.

use super::*;

/// The screen a robot's box is on and its size there in physical px.
pub(super) fn place(anchor: (i32, i32), dims: (f64, f64)) -> (window::Monitor, i32, i32) {
    let first = window::monitor_near(anchor.0, anchor.1);
    let (w, h) = ((dims.0 * first.scale) as i32, (dims.1 * first.scale) as i32);
    let m = window::monitor_near(anchor.0 + w / 2, anchor.1 + h / 2);
    (
        m,
        (dims.0 * m.scale).round() as i32,
        (dims.1 * m.scale).round() as i32,
    )
}

pub(super) fn default_anchor(index: usize) -> (i32, i32) {
    let p = window::primary_monitor();
    let (wa, s) = (p.work, p.scale);
    let x = wa.right() as f64 - (ROBOT.0 + 30.0) * s - index as f64 * (ROBOT.0 + 10.0) * s;
    let y = wa.bottom() as f64 - (ROBOT.1 + 10.0) * s;
    (x.round() as i32, y.round() as i32)
}

pub(super) fn clamp_anchor(anchor: (i32, i32), dims: (f64, f64)) -> (i32, i32) {
    let (m, w, h) = place(anchor, dims);
    let wa = m.work;
    (
        anchor.0.max(wa.x).min(wa.right() - w),
        anchor.1.max(wa.y).min(wa.bottom() - h),
    )
}

/// A stored position (the Electron app's DIPs) in physical px, and back.
pub(super) fn from_dip(p: &Value) -> Option<(i32, i32)> {
    let s = window::primary_monitor().scale;
    Some((
        (p.get("x")?.as_f64()? * s).round() as i32,
        (p.get("y")?.as_f64()? * s).round() as i32,
    ))
}

pub(super) fn to_dip(p: (i32, i32)) -> Value {
    let s = window::primary_monitor().scale;
    json!({ "x": (p.0 as f64 / s).round() as i64, "y": (p.1 as f64 / s).round() as i64 })
}

/// The chat goes on whichever side of the robot has room for it (left first: robots
/// start in the bottom-right corner), from the top of the screen to the bottom.
pub(super) fn layout_for(
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
    let own_box = Rect {
        x: anchor.0,
        y: anchor.1,
        w: dw,
        h: dh,
    };
    if peek && !expanded && !tucked {
        // Sent away to the island: asleep-sized at its desk, its window veiled (apply_layout)
        return robot_only(own_box, "hidden", bounds_msg);
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
        return robot_only(own_box, "none", bounds_msg);
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
    let (panel_x, panel_w) = if placement == "left" {
        (json!(8), (robot_x - 14.0).max(200.0))
    } else {
        (
            json!(robot_x + rw + 6.0),
            (width - robot_x - rw - 14.0).max(200.0),
        )
    };
    let max_chat_w = CHAT_MIN.max((room / s).round());
    let msg = json!({ "bounds": bounds_msg(bounds), "robotX": robot_x, "robotY": robot_y, "placement": placement, "panel": { "x": panel_x, "w": panel_w }, "maxChatW": max_chat_w });
    Layout {
        bounds,
        placement,
        panel_w,
        max_chat_w,
        msg: object(msg),
    }
}

/// On the stage: the window is its tile, the chat fills it (stage::INSET in from its edges),
/// the robot itself hides (its face goes in the chat's title bar).
pub(super) fn stage_layout(t: &StageTile) -> Layout {
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
        msg: object(msg),
    }
}

/// Just the robot, no chat: the window is its box.
fn robot_only(bounds: Rect, placement: &'static str, bounds_msg: impl Fn(Rect) -> Value) -> Layout {
    let msg =
        json!({ "bounds": bounds_msg(bounds), "robotX": 0, "robotY": 0, "placement": placement });
    Layout {
        bounds,
        placement,
        panel_w: 0.0,
        max_chat_w: CHAT_W,
        msg: object(msg),
    }
}

fn object(msg: Value) -> Map<String, Value> {
    match msg {
        Value::Object(o) => o,
        _ => unreachable!("built with json!({{…}})"),
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
