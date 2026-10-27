//! Where a small window goes by a robot (the word card, the notebook, quick actions): by its
//! box, or by the mouse when there's no robot to go by; kept on that box's screen. All in
//! physical px; sizes and gaps in CSS px, scaled by the screen.

use crate::platform::window;
use crate::platform::window::{Monitor, Rect};

/// The box to go by (a robot's; none: the mouse's point) and the screen it's on.
pub fn around(near: Option<Rect>) -> (Rect, Monitor) {
    let near = near.unwrap_or_else(|| {
        let (x, y) = window::cursor();
        Rect { x, y, w: 0, h: 0 }
    });
    (near, window::monitor_near(near.x + near.w / 2, near.y + near.h / 2))
}

/// Its size in physical px (CSS px at `scale`), no taller than the work area leaves room for.
fn sized(wa: Rect, scale: f64, size: (f64, f64), gap: i32) -> (i32, i32) {
    ((size.0 * scale).round() as i32, ((size.1 * scale).round() as i32).min(wa.h - 2 * gap))
}

/// Beside `near`, on the side with room (left first), bottoms lined up; inside `wa`.
pub fn beside(near: Rect, wa: Rect, scale: f64, size: (f64, f64), gap: f64) -> Rect {
    let gap = (gap * scale).round() as i32;
    let (w, h) = sized(wa, scale, size, gap);
    let x = if near.x - w - gap >= wa.x { near.x - w - gap } else { near.right() + gap };
    let x = x.max(wa.x + gap).min(wa.right() - w - gap);
    let y = (near.bottom() - h).max(wa.y + gap).min(wa.bottom() - h - gap);
    Rect { x, y, w, h }
}

/// Above `near`, centred on it, if there's room; else beside it (left first), bottoms lined up.
pub fn above_or_beside(near: Rect, wa: Rect, scale: f64, size: (f64, f64), gap: f64) -> Rect {
    let gap = (gap * scale).round() as i32;
    let (w, h) = sized(wa, scale, size, gap);
    let clamp_x = |x: i32| x.max(wa.x + gap).min(wa.right() - w - gap);
    let clamp_y = |y: i32| y.max(wa.y + gap).min(wa.bottom() - h - gap);
    let (x, y) = if near.y - h - gap >= wa.y {
        (clamp_x(near.x + near.w / 2 - w / 2), near.y - h - gap)
    } else {
        let x = if near.x - w - gap >= wa.x { near.x - w - gap } else { near.x + near.w + gap };
        (clamp_x(x), clamp_y(near.y + near.h - h))
    };
    Rect { x, y, w, h }
}
