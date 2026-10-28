//! The clock: every walker's next step, on one timer.

use super::*;

/// Every TICK: walkers move along; ones that never set off, never took over or never heard
/// back from their desk are dealt with.
pub(super) fn tick(app: &AppHandle, now: Instant) {
    let ids: Vec<String> = ws(app, |m| m.keys().cloned().collect());
    let desks: HashMap<String, Option<Desk>> = ids
        .iter()
        .map(|id| (id.clone(), desk_of(app, id)))
        .collect();
    let mut fx = vec![];
    ws(app, |m| {
        for (id, w) in m.iter_mut() {
            if let Some(t) = w.docking {
                if now >= t {
                    fx.push(Fx::Close(id.clone())); // (the desk never said it has it back)
                }
                continue;
            }
            if !w.going {
                if w.cancel_at.is_some_and(|t| now >= t) {
                    fx.push(Fx::Close(id.clone())); // (the desk never said go)
                }
                continue;
            }
            if !w.shown {
                if w.handoff_at.is_some_and(|t| now >= t) {
                    take_over(id, w, &mut fx); // (the page never said it's ready)
                }
                continue;
            }
            step(
                id,
                w,
                now,
                desks.get(id).copied().flatten().as_ref(),
                &mut fx,
            );
        }
    });
    run(app, fx);
}

/// (The screens changing, a sleep and an unlock are noticed by robots/screens.rs, which calls
/// recover.)
pub(super) fn clock(app: AppHandle) {
    let mut checked = Instant::now();
    loop {
        let out = ws(&app, |m| !m.is_empty());
        thread::sleep(if out {
            TICK
        } else {
            Duration::from_millis(250)
        });
        let now = Instant::now();
        if now.duration_since(checked) >= Duration::from_secs(1) {
            checked = now;
            input::idle_secs(); // (keeps the away-from-the-PC clock accurate)
            // Above the robots' windows (main.js keepOnTop): a robot that wakes up comes to the
            // front, and its window, see-through as it is, would hide a walker behind it.
            for hwnd in ws(&app, |m| {
                m.values()
                    .filter(|w| w.shown)
                    .map(|w| w.hwnd)
                    .collect::<Vec<_>>()
            }) {
                window::set_topmost(hwnd);
                if window::is_veiled(hwnd) {
                    veil(&app, hwnd, false); // (out: it's seen, whatever became of the first unveiling)
                }
            }
        }
        if out {
            tick(&app, now);
        }
    }
}
