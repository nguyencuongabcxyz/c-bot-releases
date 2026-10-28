//! Paper planes between the desks: a bored robot throws one at another (planes.rs flies it),
//! caught and read out if the other's free, else it lands on its desk to read later.

use super::*;

pub(super) fn try_plane(app: &AppHandle, now: Instant) -> bool {
    let gap = plane_gap(&level(app));
    if soc(app, |s| {
        s.in_flight || s.last_plane.is_some_and(|t| now.duration_since(t) < gap)
    }) {
        return false;
    }
    let ids = live(app);
    let throwers: Vec<&String> = ids
        .iter()
        .filter(|id| {
            free_awake(app, id)
                && rep(app, id).idle_ms() >= 45_000.0
                && !in_visit(app, id)
                && !soc(app, |s| {
                    s.last_plane_of
                        .get(*id)
                        .is_some_and(|t| now.duration_since(*t) <= PLANE_ROBOT_GAP)
                })
        })
        .collect();
    for a in throwers {
        if random() > 0.05 * kk(app) {
            continue;
        }
        let targets: Vec<&String> = ids
            .iter()
            .filter(|x| {
                *x != a
                    && at_desk(app, x)
                    && !rep(app, x).b("chat")
                    && !in_visit(app, x)
                    && !soc(app, |s| s.desk_planes.contains_key(*x))
                    && same_screen(app, a, x)
            })
            .collect();
        let Some(b) = pick(&targets) else { continue };
        return throw_plane(app, a, b, random() < 0.1);
    }
    false
}

/// Where the plane leaves the thrower's hand, and where the catcher's hand meets it.
pub(super) fn hand_point(app: &AppHandle, id: &str, side: &str, up: bool) -> Option<(f64, f64)> {
    let r = hub::robot_rect(app, id)?;
    let fx = if side == "L" { 0.36 } else { 0.64 };
    Some((
        r.x as f64 + r.w as f64 * fx,
        r.y as f64 + r.h as f64 * if up { 0.3 } else { 0.42 },
    ))
}

/// a throws a paper plane at b (miss: it overshoots and lands on your desktop).
pub fn throw_plane(app: &AppHandle, a: &str, b: &str, miss: bool) -> bool {
    if a == b || !is_open(app, a) || !is_open(app, b) {
        return false;
    }
    let now = Instant::now();
    if !soc(app, |s| !std::mem::replace(&mut s.in_flight, true)) {
        return false;
    }
    soc(app, |s| {
        s.last_plane = Some(now);
        s.last_plane_of.insert(a.into(), now);
    });
    let side = side_of(app, a, b);
    let text = line(app, a, "planes", b);
    tell(app, a, json!({ "phase": "throw", "side": side }));
    let (a, b) = (a.to_string(), b.to_string());
    after(app, THROW_AT, move |app| {
        let from = hand_point(app, &a, side, false);
        let to = hand_point(app, &b, side_of(app, &b, &a), true);
        let (Some(from), Some(to)) = (from, to) else {
            soc(app, |s| s.in_flight = false);
            return;
        };
        let on_land = move |app: &AppHandle| {
            soc(app, |s| s.in_flight = false);
            if miss {
                return tell(app, &a, json!({ "phase": "oops" }));
            }
            // caught and read out if it's free; otherwise it lands on its desk, for later
            if free_awake(app, &b) && !rep(app, &b).b("busy") {
                tell(
                    app,
                    &b,
                    json!({ "phase": "catch", "side": side_of(app, &b, &a), "from": name_of(app, &a), "text": text }),
                );
                after(app, 3000, move |app| wave_over(app, &b, &a));
            } else {
                soc(app, |s| s.desk_planes.insert(b.clone(), a.clone()));
                tell(
                    app,
                    &b,
                    json!({ "phase": "plane-land", "from": name_of(app, &a), "text": text }),
                );
            }
        };
        planes::fly_with(app, from, to, miss, Some(Box::new(on_land)));
    });
    true
}

/// Read it: a wave over to whoever threw it, and a wave back.
pub(super) fn wave_over(app: &AppHandle, b: &str, a: &str) {
    if !free_awake(app, b) {
        return;
    }
    tell(
        app,
        b,
        json!({ "phase": "wave", "side": side_of(app, b, a) }),
    );
    let (a, b) = (a.to_string(), b.to_string());
    after(app, 900, move |app| {
        if free_awake(app, &a) {
            tell(
                app,
                &a,
                json!({ "phase": "wave-back", "side": side_of(app, &a, &b) }),
            );
        }
    });
}

pub(super) fn plane_read(app: &AppHandle, id: &str) {
    if let Some(a) = soc(app, |s| s.desk_planes.remove(id)) {
        let id = id.to_string();
        after(app, 400, move |app| wave_over(app, &id, &a));
    }
}
