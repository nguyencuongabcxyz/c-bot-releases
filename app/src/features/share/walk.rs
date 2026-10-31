//! The visiting robot coming and going: it strolls the last few steps to where its desk is (the
//! desk shows once it's there, and it waves), and when the chat ends it gets up, waves goodbye
//! and strolls off. Brisk and short: it's a greeting, not a show. On the way it's a walker of
//! its own (as the evening housemaid is: robots/maid.rs), with a name tag saying whose it is.

use super::*;
use crate::platform::window;
use crate::robots::{self, walkers, walkers::Errand};

/// How long the walker takes to be ready before it's sent off.
const SETTLE_MS: u64 = 700;
/// How long it waves goodbye before it walks off.
const WAVE_MS: u64 = 900;
/// How far it walks in and off (CSS px), and how much faster than a stroll.
const STEPS: f64 = 240.0;
const BRISK: f64 = 2.0;

fn walker_id(id: &str) -> String {
    format!("{id}-walking")
}

/// What it looks like walking: its robot's look, and a tag at its feet.
fn look(app: &AppHandle, id: &str, host: &str) -> Option<Value> {
    let c = with(app, |st| st.store.get(id).cloned())?;
    let mut look = json!({});
    for k in ["name", "color", "body", "kit", "accessory", "theme", "size"] {
        look[k] = c[k].clone();
    }
    look["tag"] = json!(format!("🔗 Visiting from {host}"));
    Some(look)
}

/// Where its feet are at its desk, and a few steps from there toward the nearer edge of the
/// screen (screen px).
fn spots(app: &AppHandle, id: &str) -> Option<((f64, f64), (f64, f64))> {
    let d = robots::desk_rect(app, id)?;
    let feet = (
        d.x as f64 + d.w as f64 / 2.0,
        d.y as f64 + d.h as f64 * 0.93,
    );
    let m = window::monitor_near(feet.0 as i32, feet.1 as i32);
    let (wa, s) = (m.work, m.scale);
    let right = wa.right() as f64 - feet.0 < feet.0 - wa.x as f64;
    let (lo, hi) = (wa.x as f64 + 20.0 * s, wa.right() as f64 - 20.0 * s);
    let aside = if right {
        feet.0 + STEPS * s
    } else {
        feet.0 - STEPS * s
    };
    Some((feet, (aside.clamp(lo, hi.max(lo)), feet.1)))
}

fn show_desk(app: &AppHandle, id: &str, shown: bool) {
    if let Some(hwnd) = robots::hwnd_of(app, id) {
        walkers::veil(app, hwnd, !shown);
    }
}

/// There: its desk shows and it waves (the page hears ShareArrived).
fn arrived(app: &AppHandle, id: &str, tab: &str) {
    show_desk(app, id, true);
    tell(app, id, tab, PageEvent::ShareArrived);
}

/// In: its desk (just opened) hidden, it walks the last few steps to it.
pub(super) fn walk_in(app: &AppHandle, id: &str, tab: &str, host: &str) {
    let (Some((feet, aside)), Some(look)) = (spots(app, id), look(app, id, host)) else {
        return arrived(app, id, tab);
    };
    show_desk(app, id, false);
    let walker = walker_id(id);
    if !walkers::arrive(app, &walker, aside, look, walkers::size_of(app, id)) {
        return arrived(app, id, tab);
    }
    let (id, tab) = (id.to_string(), tab.to_string());
    walkers::after(app, SETTLE_MS, move |app| {
        let (w, i, t) = (walker.clone(), id.clone(), tab.clone());
        let errand = Errand {
            speed_k: BRISK,
            on_arrive: Some(Box::new(move |app: &AppHandle| {
                walkers::close(app, &w);
                arrived(app, &i, &t);
            })),
            ..Errand::default()
        };
        if !walkers::walk_to(app, &walker, feet, errand) {
            walkers::close(app, &walker);
            arrived(app, &id, &tab);
        }
    });
}

/// Off: it gets up from its desk, waves goodbye and walks a few steps off; then `gone` (with
/// its id), however that went.
pub(super) fn walk_off(app: &AppHandle, id: &str, host: &str, gone: fn(&AppHandle, &str)) {
    let (Some((feet, aside)), Some(look)) = (spots(app, id), look(app, id, host)) else {
        return gone(app, id);
    };
    let walker = walker_id(id);
    if !walkers::arrive(app, &walker, feet, look, walkers::size_of(app, id)) {
        return gone(app, id);
    }
    let id = id.to_string();
    walkers::after(app, SETTLE_MS, move |app| {
        show_desk(app, &id, false);
        walkers::wave(app, &walker);
        walkers::after(app, WAVE_MS, move |app| {
            let (w, i) = (walker.clone(), id.clone());
            let errand = Errand {
                speed_k: BRISK,
                on_arrive: Some(Box::new(move |app: &AppHandle| {
                    walkers::close(app, &w);
                    gone(app, &i);
                })),
                ..Errand::default()
            };
            if !walkers::walk_to(app, &walker, aside, errand) {
                walkers::close(app, &walker);
                gone(app, &id);
            }
        });
    });
}
