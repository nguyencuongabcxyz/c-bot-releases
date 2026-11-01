//! A stack's geometry: an edge's docked chats one above the other, flush against it, the
//! height shared out by weight; and when a dragged robot is pushed against an edge (pure, no
//! windows).

use super::*;

pub(super) use crate::robots::stage::{give, split_px};

/// Each docked chat's window on the screen (physical px), top to bottom.
pub(super) fn rects(room: Rect, scale: f64, edge: Edge, width: f64, weights: &[f64]) -> Vec<Rect> {
    let w = width_px(room, scale, width);
    let x = match edge {
        Edge::Left => room.x,
        Edge::Right => room.right() - w,
    };
    let mut y = room.y;
    split_px(room.h, weights)
        .into_iter()
        .map(|h| {
            let r = Rect { x, y, w, h };
            y += h;
            r
        })
        .collect()
}

/// Heights as shares of the stack, 1 on average: one that docks later (at the average) fits
/// in with them.
pub(super) fn shares(sizes: &[i32]) -> Vec<f64> {
    let mean = sizes.iter().map(|h| (*h).max(1) as f64).sum::<f64>() / sizes.len().max(1) as f64;
    sizes.iter().map(|h| (*h).max(1) as f64 / mean).collect()
}

/// Its share of the stack, kept sensible (a record edited by hand, or from before shares).
pub(super) fn share_of(d: &Docked) -> f64 {
    if d.weight.is_finite() {
        d.weight.clamp(0.1, 10.0)
    } else {
        1.0
    }
}

/// A width (CSS px) in physical px, from a chat's narrowest to most of the screen.
pub(super) fn width_px(room: Rect, scale: f64, width: f64) -> i32 {
    let min = ((CHAT_MIN * scale).round() as i32).min(room.w);
    let max = (room.w - (MARGIN * scale).round() as i32).max(min);
    ((width * scale).round() as i32).clamp(min, max)
}

/// The width (CSS px) a drag asks for, kept to what width_px allows.
pub(super) fn width_css(room: Rect, scale: f64, width: f64) -> f64 {
    (width_px(room, scale, width) as f64 / scale).round()
}

/// The screen's work area as it was before the stack on this edge kept `kept` px of it.
pub(super) fn give_back(work: Rect, edge: Edge, kept: i32) -> Rect {
    match edge {
        Edge::Left => Rect {
            x: work.x - kept,
            w: work.w + kept,
            ..work
        },
        Edge::Right => Rect {
            w: work.w + kept,
            ..work
        },
    }
}

/// The mouse pushed against an edge of its screen, with no other screen beyond it
/// (open: left, right): that edge.
pub(super) fn pushed(cursor: (i32, i32), screen: Rect, open: (bool, bool)) -> Option<Edge> {
    if open.0 && cursor.0 <= screen.x + 1 {
        Some(Edge::Left)
    } else if open.1 && cursor.0 >= screen.right() - 2 {
        Some(Edge::Right)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1040,
    };

    #[test]
    fn a_stack_shares_its_edge_by_weight() {
        let r = rects(SCREEN, 1.0, Edge::Right, 500.0, &[1.0, 1.0]);
        assert_eq!(
            r,
            vec![
                Rect {
                    x: 1420,
                    y: 0,
                    w: 500,
                    h: 520
                },
                Rect {
                    x: 1420,
                    y: 520,
                    w: 500,
                    h: 520
                },
            ]
        );
        let r = rects(SCREEN, 1.5, Edge::Left, 400.0, &[3.0, 1.0]);
        assert_eq!(
            r.iter().map(|r| (r.x, r.w, r.h)).collect::<Vec<_>>(),
            vec![(0, 600, 780), (0, 600, 260)]
        );
    }

    #[test]
    fn heights_become_shares_of_the_stack() {
        assert_eq!(shares(&[300, 900]), vec![0.5, 1.5]);
        assert_eq!(shares(&[576, 576]), vec![1.0, 1.0]);
        let odd = Docked {
            edge: Edge::Right,
            at: 0.0,
            weight: 726.0,
        };
        assert_eq!(share_of(&odd), 10.0);
        let nan = Docked {
            weight: f64::NAN,
            ..odd
        };
        assert_eq!(share_of(&nan), 1.0);
    }

    #[test]
    fn the_width_stays_between_a_chats_narrowest_and_most_of_the_screen() {
        assert_eq!(width_px(SCREEN, 1.0, 100.0), 360);
        assert_eq!(width_px(SCREEN, 1.0, 5000.0), 1720);
        assert_eq!(width_css(SCREEN, 2.0, 5000.0), 760.0);
        // a screen too small for both: the chat's narrowest wins, but never past the screen
        let tiny = Rect { w: 300, ..SCREEN };
        assert_eq!(width_px(tiny, 1.0, 520.0), 300);
    }

    #[test]
    fn what_a_stack_kept_is_given_back() {
        let work = Rect {
            x: 500,
            y: 0,
            w: 1420,
            h: 1040,
        };
        assert_eq!(give_back(work, Edge::Left, 500), SCREEN);
        let work = Rect { w: 1420, ..SCREEN };
        assert_eq!(give_back(work, Edge::Right, 500), SCREEN);
        assert_eq!(give_back(SCREEN, Edge::Right, 0), SCREEN);
    }

    #[test]
    fn pushed_against_an_outer_edge() {
        assert_eq!(pushed((0, 500), SCREEN, (true, true)), Some(Edge::Left));
        assert_eq!(pushed((1919, 500), SCREEN, (true, true)), Some(Edge::Right));
        assert_eq!(pushed((1900, 500), SCREEN, (true, true)), None);
        // another screen beyond: it's only crossing over
        assert_eq!(pushed((1919, 500), SCREEN, (true, false)), None);
        assert_eq!(pushed((0, 500), SCREEN, (false, true)), None);
    }
}
