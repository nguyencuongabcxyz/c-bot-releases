//! Setting off: where from and where to (prepare), the walker's window made and the robot hidden behind it (go), and back at the desk (arrive).

use super::*;

/// It's getting up to leave: the walker window is made now, hidden, so it's loaded and drawn
/// by the time the character has stood up and turned (go()). A visitor with no desk:
/// `at` is where its feet start, `k` its size.
pub(super) fn prepare(
    app: &AppHandle,
    id: &str,
    asleep: bool,
    at: Option<(f64, f64)>,
    k: Option<f64>,
) -> bool {
    // (one at a time: wander-prep and wander can come close together)
    static BUILD: Mutex<()> = Mutex::new(());
    let _one = BUILD.locked();
    if has(app, id) {
        return true;
    }
    let desk = desk_of(app, id);
    let feet = match (at, desk) {
        (Some(p), _) => p,
        (None, Some(d)) => (
            d.rect.x as f64 + d.rect.w as f64 * 0.55,
            d.rect.y as f64 + d.rect.h as f64 * 0.85,
        ), // (roughly; go() puts it exactly)
        (None, None) => return false,
    };
    let k = k.unwrap_or_else(|| size_of(app, id));
    let s = window::monitor_near(feet.0 as i32, feet.1 as i32).scale;
    let css = ((BOX.0 * k).round(), (BOX.1 * k).round());
    let (bw, bh) = ((css.0 * s).round() as i32, (css.1 * s).round() as i32);
    let (x, y) = (feet.0 - bw as f64 / 2.0, feet.1 - bh as f64 * FEET);
    let label = label_of(id);
    if app.get_webview_window(&label).is_some() {
        return false; // (the last one's still closing)
    }
    let name = with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["name"].as_str().map(str::to_string))
    })
    .unwrap_or_else(|| "C-Bot".into());
    let built = views::builder(app, &label, "walker", &[("id", id)])
        .title(format!("{name} (out for a walk)"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .focusable(false) // (a click on it never takes the focus from the app you're in)
        .inner_size(css.0, css.1)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            log::warn!("couldn't open {label}: {err}");
            return false;
        }
    };
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => {
            let _ = window.close();
            return false;
        }
    };
    veil(app, hwnd, true);
    window::set_bounds(
        hwnd,
        Rect {
            x: x.round() as i32,
            y: y.round() as i32,
            w: bw,
            h: bh,
        },
    );
    let (app2, id2) = (app.clone(), id.to_string());
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            ws(&app2, |m| {
                if m.get(&id2).is_some_and(|w| w.hwnd == hwnd) {
                    m.remove(&id2);
                }
            });
        }
    });
    let gait = if asleep { "sleepwalk" } else { "walk" };
    let w = Walker {
        hwnd,
        label,
        k,
        s,
        bw,
        bh,
        x,
        y,
        asleep,
        gait: gait.into(),
        heading: "right".into(), // (it sets off walking right, as it turned at the desk)
        target: (x, y),
        pause: Pause::No,
        held: None,
        errand: None,
        roam_until: None,
        home: None,
        going: false,
        ready: false,
        shown: false,
        docking: None,
        npc: false,
        look: None,
        through: None,
        over: false,
        cancel_at: Some(Instant::now() + CANCEL_WAIT),
        handoff_at: None,
        forwarded: None,
        eyes: None,
    };
    ws(app, |m| m.insert(id.to_string(), w));
    tray::refresh(app);
    true
}

/// Stood up and turned at the desk, feet on `feet` (desk-window CSS px): put the walker's
/// feet on that very spot and take over as soon as it's drawn (at once, if it already is).
/// An errand: where to (screen px) and how.
pub(super) fn go(
    app: &AppHandle,
    id: &str,
    asleep: bool,
    feet: Option<(f64, f64)>,
    errand: Option<(Option<(f64, f64)>, Errand)>,
) -> bool {
    if !has(app, id) && !prepare(app, id, asleep, None, None) {
        return false;
    }
    let desk = desk_of(app, id);
    let now = Instant::now();
    with_walker(app, id, |w, fx| {
        if let (Some(f), Some(d)) = (feet, desk) {
            w.x = d.rect.x as f64 + f.0 * d.s - w.bw as f64 / 2.0;
            w.y = d.rect.y as f64 + f.1 * d.s - w.bh as f64 * FEET;
            w.home = Some(f);
            w.place(fx);
        }
        w.going = true;
        let wa = w.area(desk.as_ref());
        w.target = (
            (w.x + rand_in(260.0, 520.0) * w.k * w.s).min((wa.right() - w.bw) as f64),
            (w.y + rand_in(-60.0, 60.0) * w.s)
                .max(wa.y as f64)
                .min((wa.bottom() - w.bh) as f64),
        );
        let on_errand = errand.is_some();
        if let Some((Some(to), e)) = errand {
            w.errand_to(to, e);
        }
        // (an errand's own code sends it home)
        w.roam_until = if on_errand {
            None
        } else {
            Some(now + Duration::from_secs_f64(rand_in(ROAM.0, ROAM.1)))
        };
        if w.ready {
            take_over(id, w, fx);
        } else {
            w.handoff_at = Some(now + HANDOFF_WAIT);
        }
    })
}

/// A visitor that isn't one of your robots (the evening housemaid, maid.rs): it has no desk,
/// comes in with its feet at `from` (screen px), looks like `look` (a character's look),
/// can't be picked up (a click goes to maid.rs), and only goes where it's sent (walk_to).
pub fn arrive(app: &AppHandle, id: &str, from: (f64, f64), look: Value, k: f64) -> bool {
    if has(app, id) {
        return true;
    }
    if !prepare(app, id, false, Some(from), Some(k)) {
        return false;
    }
    let now = Instant::now();
    with_walker(app, id, |w, fx| {
        w.cancel_at = None;
        w.npc = true;
        w.look = Some(look);
        w.going = true;
        w.pause = Pause::Forever; // (standing, till it's sent somewhere)
        w.stop_here();
        if w.ready {
            take_over(id, w, fx);
        } else {
            w.handoff_at = Some(now + HANDOFF_WAIT);
        }
    })
}
