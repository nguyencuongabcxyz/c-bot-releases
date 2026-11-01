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

/// The robot's back as it's dragged (x, physical px): the side away from where it's going
/// (its middle, going nowhere yet). It's on the screen its back is on: pushed into the edge
/// between two screens, it's pushing into that edge till it's crossed over whole.
pub(super) fn trailing(left: i32, w: i32, heading: i32) -> i32 {
    match heading.signum() {
        1 => left + 1,
        -1 => left + w - 1,
        _ => left + w / 2,
    }
}

/// A window being dragged (its left as the mouse would have it, its width, which way it's
/// going) and how far past an edge it holds, and for how much more pull (physical px).
pub(super) struct Hold {
    pub x: i32,
    pub w: i32,
    pub heading: i32,
    pub hold: i32,
    pub pull: i32,
}

/// Its left: pushed into an edge with another screen beyond it (open: none), held past it by
/// `hold` till pulled `pull` further; else where the mouse has it.
pub(super) fn held_x(h: Hold, screen: Rect, open: (bool, bool)) -> i32 {
    let band = |over: i32| over > h.hold && over < h.hold + h.pull;
    if h.heading > 0 && !open.1 && band(h.x + h.w - screen.right()) {
        screen.right() + h.hold - h.w
    } else if h.heading < 0 && !open.0 && band(screen.x - h.x) {
        screen.x - h.hold
    } else {
        h.x
    }
}

/// A robot being dragged: the mouse, its window (robot and chat), how far past an edge the
/// window goes to count as pushed into it (physical px), and which way it's going (-1 left,
/// 1 right).
pub(super) struct Push {
    pub cursor: (i32, i32),
    pub window: Rect,
    pub past: i32,
    pub heading: i32,
}

/// Pushed into an edge of the robot's screen: its window past it (whichever comes first, the
/// robot or its chat), or the mouse against it. That edge. With another screen beyond the edge
/// (open: left, right: none), only while going that way: carried over to the other screen, it
/// isn't pushed into the edge it left by.
pub(super) fn pushed(p: Push, screen: Rect, open: (bool, bool)) -> Option<Edge> {
    let (c, w) = (p.cursor, p.window);
    let left =
        (w.x <= screen.x - p.past && (open.0 || p.heading < 0)) || (open.0 && c.0 <= screen.x + 1);
    let right = (w.right() >= screen.right() + p.past && (open.1 || p.heading > 0))
        || (open.1 && c.0 >= screen.right() - 2);
    if left {
        Some(Edge::Left)
    } else if right {
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

    // a robot with its chat (900 px wide), dragged right
    fn drag(cursor_x: i32, window_x: i32) -> Push {
        Push {
            cursor: (cursor_x, 500),
            window: Rect {
                x: window_x,
                y: 0,
                w: 900,
                h: 1040,
            },
            past: 40,
            heading: 1,
        }
    }

    #[test]
    fn pushed_against_an_outer_edge() {
        assert_eq!(pushed(drag(0, 0), SCREEN, (true, true)), Some(Edge::Left));
        assert_eq!(
            pushed(drag(1919, 1800), SCREEN, (true, true)),
            Some(Edge::Right)
        );
        assert_eq!(pushed(drag(900, 500), SCREEN, (true, true)), None);
        // the mouse against an edge with another screen beyond: only crossing over
        assert_eq!(pushed(drag(1919, 1000), SCREEN, (true, false)), None);
        assert_eq!(pushed(drag(0, 0), SCREEN, (false, true)), None);
    }

    #[test]
    fn the_edge_between_two_screens_holds_it_a_while() {
        let going = |x: i32, heading: i32| Hold {
            x,
            w: 600,
            heading,
            hold: 60,
            pull: 220,
        };
        let next_right = (true, false);
        // not past it by the hold yet: where the mouse has it
        assert_eq!(held_x(going(1350, 1), SCREEN, next_right), 1350);
        // past it: held 60 px over
        assert_eq!(held_x(going(1400, 1), SCREEN, next_right), 1380);
        assert_eq!(held_x(going(1580, 1), SCREEN, next_right), 1380);
        // pulled through: on it goes
        assert_eq!(held_x(going(1700, 1), SCREEN, next_right), 1700);
        // an outer edge, or going the other way: nothing holds it
        assert_eq!(held_x(going(1400, 1), SCREEN, (true, true)), 1400);
        assert_eq!(held_x(going(1400, -1), SCREEN, next_right), 1400);
        // the left edge the same
        assert_eq!(held_x(going(-100, -1), SCREEN, (false, true)), -60);
    }

    #[test]
    fn the_robot_is_where_its_back_is() {
        assert_eq!(trailing(1000, 300, 1), 1001);
        assert_eq!(trailing(1000, 300, -1), 1299);
        assert_eq!(trailing(1000, 300, 0), 1150);
    }

    #[test]
    fn between_two_screens_only_going_that_way() {
        // another screen beyond the right edge: pushed into it going right
        assert_eq!(
            pushed(drag(1100, 1060), SCREEN, (true, false)),
            Some(Edge::Right)
        );
        // but coming over from the screen on the left (going right), its chat still back
        // there: it isn't pushed into this screen's left edge
        assert_eq!(pushed(drag(100, -300), SCREEN, (false, true)), None);
        // pushed back left into that edge: it is
        let back = Push {
            heading: -1,
            ..drag(100, -300)
        };
        assert_eq!(pushed(back, SCREEN, (false, true)), Some(Edge::Left));
    }

    #[test]
    fn the_chat_reaching_the_edge_first_pushes_too() {
        // the chat on the robot's right, its far side 40 px past the screen's right edge
        assert_eq!(
            pushed(drag(1100, 1060), SCREEN, (true, true)),
            Some(Edge::Right)
        );
        // only touching it: not yet
        assert_eq!(pushed(drag(1060, 1020), SCREEN, (true, true)), None);
        // the window past the left edge
        assert_eq!(
            pushed(drag(100, -40), SCREEN, (true, true)),
            Some(Edge::Left)
        );
    }
}
