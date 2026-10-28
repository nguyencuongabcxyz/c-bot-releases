//! The robots reacting to each other: a wave across the screen, claps when one finishes a task, yawns when one dozes off, a dance for a vocab milestone.

use super::*;

pub(super) fn on_done(app: &AppHandle, id: &str) {
    // the visitor watching it work cheers, and goes home
    if let Some(v) =
        visit(app).filter(|v| v.b == id && v.mode == Mode::Watch && v.phase == Phase::There)
    {
        walkers::say(app, &v.a, &line(app, &v.a, "clap", id), 2400);
        walkers::pose(app, &v.a, "clap", Some(&v.face));
        later(app, 2600, |app| homeward(app, None, 1.0));
    }
    if level(app) == "never" || app_busy(app) {
        return;
    }
    let now = Instant::now();
    for o in live(app) {
        if o == id || in_visit(app, &o) || !free_awake(app, &o) || !same_screen(app, &o, id) {
            continue;
        }
        let clapped = soc(app, |s| {
            if s.last_clap
                .get(&o)
                .is_some_and(|t| now.duration_since(*t) < CLAP_GAP)
            {
                return false;
            }
            s.last_clap.insert(o.clone(), now);
            true
        });
        if clapped {
            let text = if random() < 0.45 {
                line(app, &o, "clap", id)
            } else {
                String::new()
            };
            tell(
                app,
                &o,
                json!({ "phase": "clap", "side": side_of(app, &o, id), "text": text }),
            );
        }
    }
}

pub(super) fn on_slept(app: &AppHandle, id: &str) {
    if level(app) == "never" || app_busy(app) {
        return;
    }
    for o in live(app) {
        if o == id || in_visit(app, &o) || !free_awake(app, &o) || dist(app, &o, id) > near() {
            continue;
        }
        if random() < 0.5 {
            let sleep_soon = rep(app, &o).idle_ms() > 90_000.0 && random() < 0.5;
            tell(
                app,
                &o,
                json!({ "phase": "yawn", "side": side_of(app, &o, id), "sleepSoon": sleep_soon }),
            );
        }
    }
}

/// A word milestone (features/vocab/mod.rs): the others dance too.
pub fn milestone(app: &AppHandle, id: &str) {
    if level(app) == "never" {
        return;
    }
    for o in live(app) {
        if o != id && !in_visit(app, &o) && free_awake(app, &o) {
            tell(app, &o, json!({ "phase": "dance" }));
        }
    }
}

pub(super) fn try_wave(app: &AppHandle, now: Instant) -> bool {
    let free: Vec<String> = live(app)
        .into_iter()
        .filter(|id| free_awake(app, id) && rep(app, id).idle_ms() > 15_000.0 && !in_visit(app, id))
        .collect();
    for a in &free {
        for b in &free {
            if a >= b || !same_screen(app, a, b) || dist(app, a, b) > near() {
                continue;
            }
            let key = format!("{a}|{b}");
            if soc(app, |s| {
                s.last_wave
                    .get(&key)
                    .is_some_and(|t| now.duration_since(*t) < WAVE_PAIR_GAP)
            }) {
                continue;
            }
            if random() > 0.05 * kk(app) {
                continue;
            }
            soc(app, |s| s.last_wave.insert(key, now));
            let (x, y) = if random() < 0.5 {
                (a.clone(), b.clone())
            } else {
                (b.clone(), a.clone())
            };
            tell(
                app,
                &x,
                json!({ "phase": "wave", "side": side_of(app, &x, &y) }),
            );
            after(app, 900, move |app| {
                let back = if rep(app, &y).b("awake") {
                    json!({ "phase": "wave-back", "side": side_of(app, &y, &x) })
                } else {
                    json!({ "phase": "stir" })
                };
                tell(app, &y, back);
            });
            return true;
        }
    }
    false
}
