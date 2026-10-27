//! Robots visiting each other's desks, lunch and milk-tea runs, and paper planes between them.

use super::*;

// ---------------------------------------------------------------- visits

pub(super) fn try_visit(app: &AppHandle, now: Instant) -> bool {
    let gap = visit_gap(&level(app));
    if soc(app, |s| {
        s.visit.is_some() || s.last_visit.is_some_and(|t| now.duration_since(t) < gap)
    }) {
        return false;
    }
    let ids = live(app);
    let visitors: Vec<&String> = ids
        .iter()
        .filter(|id| {
            let r = rep(app, id);
            free_awake(app, id)
                && r.wanders()
                && r.idle_ms() >= 60_000.0
                && !soc(app, |s| {
                    s.last_visit_of
                        .get(*id)
                        .is_some_and(|t| now.duration_since(*t) <= VISIT_ROBOT_GAP)
                })
        })
        .collect();
    for a in visitors {
        if random() > 0.3 * kk(app) {
            continue;
        }
        let hosts: Vec<&String> = ids
            .iter()
            .filter(|b| {
                *b != a && at_desk(app, b) && !rep(app, b).b("chat") && same_screen(app, a, b)
            })
            .collect();
        let Some(b) = pick(&hosts) else { continue };
        let rb = rep(app, b);
        let mode = if rb.b("busy") {
            "watch"
        } else if rb.b("awake") {
            "chat"
        } else {
            "tiptoe"
        };
        start(app, a, b, mode, vec![], None);
        return true;
    }
    false
}

/// Send a over to b's desk (mode: chat | watch | tiptoe; "" from how b is), or an office
/// scene: order (lunch), goout (lunch together), tea (b, then the stops, desk to desk).
/// delivery: ms till the food / tea comes.
pub fn start(
    app: &AppHandle,
    a: &str,
    b: &str,
    mode: &str,
    stops: Vec<String>,
    delivery: Option<u64>,
) -> bool {
    if visit(app).is_some() || a == b || !is_open(app, a) || !is_open(app, b) || !at_desk(app, b) {
        return false;
    }
    let mode = if !mode.is_empty() {
        mode.to_string()
    } else {
        let rb = rep(app, b);
        (if rb.b("busy") {
            "watch"
        } else if rb.b("awake") {
            "chat"
        } else {
            "tiptoe"
        })
        .to_string()
    };
    let side = side_of(app, b, a); // the side of b's desk it comes from, and stands on
    let now = Instant::now();
    let v = Visit {
        a: a.into(),
        b: b.into(),
        mode: mode.clone(),
        side,
        face: face_for(side),
        face_b: None,
        phase: "out".into(),
        epoch: next_gen(),
        delivery,
        stops,
        ordered: vec![a.into()],
        arrived_at: now,
        spot_b: None,
        out: None,
        there: HashSet::new(),
    };
    let started = soc(app, |s| {
        if s.visit.is_some() {
            return false;
        }
        s.visit = Some(v);
        s.last_visit = Some(now);
        s.last_visit_of.insert(a.into(), now);
        true
    });
    if !started {
        return false;
    }
    tell(
        app,
        a,
        json!({ "phase": "visit", "host": name_of(app, b), "mode": mode }),
    );
    tell(app, b, json!({ "phase": "hosting", "on": true })); // (it stays at its desk till the visitor's gone)
    // (it never set off: it's sitting tight)
    let who = a.to_string();
    later(app, 9000, move |app| {
        if visit(app).is_some_and(|v| v.phase == "out") && !walkers::is_out(app, &who) {
            end_visit(app, "never left");
        }
    });
    true
}

/// Where the visitor's feet go: beside the host's desk, on the side it came from.
pub(super) fn spot(app: &AppHandle) -> Option<(f64, f64)> {
    let v = visit(app)?;
    let r = hub::robot_rect(app, &v.b)?;
    let fx = if v.side == "L" { 0.1 } else { 0.9 };
    Some((r.x as f64 + r.w as f64 * fx, r.y as f64 + r.h as f64 * 0.93))
}

/// The errand it's going out on, if it's off to visit someone (walkers.rs takes it along):
/// { to, gait, speedK, face }; when it's there, walkers.rs calls errand_arrived.
pub fn errand_for(app: &AppHandle, id: &str) -> Option<Value> {
    let v = visit(app)?;
    // asked out to lunch: its walk to the spot beside the visitor
    if v.mode == "goout" && v.phase == "outing" && v.b == id {
        let to = v.spot_b?;
        vset(app, |v| {
            if let Some(out) = v.out.as_mut() {
                out.insert(id.to_string());
            }
        });
        return Some(json!({ "to": { "x": to.0, "y": to.1 }, "face": v.face_b }));
    }
    if v.a != id || v.phase != "out" {
        return None;
    }
    let to = spot(app)?;
    vset(app, |v| v.phase = "walking".into());
    let tiptoe = v.mode == "tiptoe";
    Some(
        json!({ "to": { "x": to.0, "y": to.1 }, "gait": if tiptoe { "tiptoe" } else { "walk" }, "speedK": if tiptoe { 0.6 } else { 1.0 }, "face": v.face }),
    )
}

/// It got where errand_for sent it.
pub fn errand_arrived(app: &AppHandle, id: &str) {
    match visit(app) {
        Some(v) if v.mode == "goout" && v.b == id => sit_down(app, id),
        Some(_) => arrived(app),
        None => {}
    }
}

pub(super) fn arrived_errand(face: &str) -> Errand {
    Errand {
        face: Some(face.to_string()),
        on_arrive: Some(Box::new(|app: &AppHandle| arrived(app))),
        ..Errand::default()
    }
}

pub(super) fn arrived(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    let (a, b) = (v.a.clone(), v.b.clone());
    let rb = rep(app, &b);
    // things may have changed on the way
    let mut mode = v.mode.clone();
    if mode == "chat" && rb.b("busy") {
        mode = "watch".into();
    }
    if mode == "chat" && !rb.b("awake") {
        mode = "tiptoe".into();
    }
    if mode == "tiptoe" && rb.b("awake") {
        mode = "chat".into();
    }
    let m = mode.clone();
    vset(app, move |v| {
        v.phase = "there".into();
        v.arrived_at = Instant::now();
        v.mode = m;
    });
    let mine = v.side; // b turns to the side the visitor stands on
    let face = v.face.clone();
    match mode.as_str() {
        "chat" => {
            tell(app, &b, json!({ "phase": "listen", "side": mine }));
            let lines = [
                (a.clone(), line(app, &a, "hi", &b)),
                (b.clone(), line(app, &b, "reply", &a)),
                (a.clone(), line(app, &a, "bye", &b)),
            ];
            let n = lines.len() as u64;
            for (i, (who, text)) in lines.into_iter().enumerate() {
                let (a, b, face) = (a.clone(), b.clone(), face.clone());
                later(app, 400 + i as u64 * LINE_GAP, move |app| {
                    if who == a {
                        walkers::pose(app, &a, "talk", Some(&face));
                        walkers::say(app, &a, &text, LINE_GAP - 200);
                        later(app, LINE_GAP - 300, move |app| {
                            walkers::pose(app, &a, "stand", Some(&face))
                        });
                    } else {
                        tell(app, &b, json!({ "phase": "say", "text": text }));
                    }
                });
            }
            let (a2, b2, face2) = (a.clone(), b.clone(), face.clone());
            later(app, 400 + n * LINE_GAP, move |app| {
                walkers::pose(app, &a2, "wave", Some(&face2));
                tell(app, &b2, json!({ "phase": "listen-end", "wave": true }));
            });
            later(app, 400 + n * LINE_GAP + 1300, |app| {
                homeward(app, None, 1.0)
            });
        }
        "order" | "goout" if !free_awake(app, &b) => {
            // it got busy (or dozed off) while the visitor walked over: maybe next time
            talk(app, &a, &line(app, &a, "goOutBusy", &b));
            later(app, 1800, |app| homeward(app, None, 1.0));
        }
        "order" | "goout" => {
            // lunch: "order?" / "yes, …" / "ordered!", or "go out?" / "yes!" and off they go
            tell(app, &b, json!({ "phase": "listen", "side": mine }));
            let lines: Vec<(String, String)> = if mode == "order" {
                vec![
                    (a.clone(), line(app, &a, "lunchAsk", &b)),
                    (b.clone(), line(app, &b, "lunchDish", &a)),
                    (a.clone(), line(app, &a, "lunchOrdered", &b)),
                ]
            } else {
                vec![
                    (a.clone(), line(app, &a, "goOut", &b)),
                    (b.clone(), line(app, &b, "goOutYes", &a)),
                ]
            };
            let after_lines = 400 + lines.len() as u64 * LINE_GAP;
            for (i, (who, text)) in lines.into_iter().enumerate() {
                later(app, 400 + i as u64 * LINE_GAP, move |app| {
                    talk(app, &who, &text)
                });
            }
            if mode == "order" {
                let (a2, b2) = (a.clone(), b.clone());
                later(app, after_lines, move |app| {
                    let face = visit(app).map(|v| v.face).unwrap_or_default();
                    walkers::pose(app, &a2, "wave", Some(&face));
                    tell(app, &b2, json!({ "phase": "listen-end", "wave": true }));
                    deliver(app, vec![a2.clone(), b2.clone()], "food");
                    soc(app, |s| s.lunch_day = today());
                });
                later(app, after_lines + 1300, |app| homeward(app, None, 1.0));
            } else {
                later(app, after_lines - 600, go_out);
            }
        }
        "tea" => {
            // milk tea: takes this desk's order (the usual for a busy one), then on to the next
            let wants_tea = free_awake(app, &b);
            if wants_tea {
                tell(app, &b, json!({ "phase": "listen", "side": mine }));
                let (a2, b2) = (a.clone(), b.clone());
                later(app, 400, move |app| {
                    talk(app, &a2, &line(app, &a2, "teaAsk", &b2))
                });
                let (a3, b3) = (a.clone(), b.clone());
                later(app, 400 + LINE_GAP, move |app| {
                    talk(app, &b3, &line(app, &b3, "teaOrder", &a3))
                });
                vset(app, |v| v.ordered.push(b.clone()));
            } else if rb.b("busy") {
                let (a2, b2) = (a.clone(), b.clone());
                later(app, 400, move |app| {
                    talk(app, &a2, &line(app, &a2, "teaUsual", &b2))
                });
                vset(app, |v| v.ordered.push(b.clone()));
            }
            later(
                app,
                if wants_tea {
                    400 + 2 * LINE_GAP
                } else {
                    400 + LINE_GAP
                },
                next_tea_stop,
            );
        }
        "watch" => {
            walkers::pose(app, &a, "stand", Some(&face));
            cheer(app, a.clone(), b.clone(), 0);
            later(app, WATCH_MAX, |app| homeward(app, None, 1.0));
        }
        _ => {
            // tiptoe: a sticky on its monitor, and back without waking it
            walkers::pose(app, &a, "stand", Some(&face));
            walkers::say(app, &a, &line(app, &a, "tiptoe", &b), 2200);
            tell(
                app,
                &b,
                json!({ "phase": "visit-note", "from": name_of(app, &a), "found": line(app, &b, "found", &a) }),
            );
            later(app, 2600, |app| homeward(app, Some("tiptoe"), 0.6));
        }
    }
}

/// Watching over its shoulder: a cheer now and then.
pub(super) fn cheer(app: &AppHandle, a: String, b: String, n: u32) {
    later(app, if n > 0 { 6500 } else { 1200 }, move |app| {
        let face = visit(app).map(|v| v.face).unwrap_or_default();
        walkers::say(app, &a, &line(app, &a, "watch", &b), 2400);
        walkers::pose(app, &a, "clap", Some(&face));
        let a2 = a.clone();
        later(app, 2200, move |app| {
            walkers::pose(app, &a2, "stand", Some(&face))
        });
        if n < 5 {
            cheer(app, a, b, n + 1);
        }
    });
}

/// One line of a scene: the walker's bubble (and hands), or the robot at its desk.
pub(super) fn talk(app: &AppHandle, who: &str, text: &str) {
    let Some(v) = visit(app) else { return };
    if text.is_empty() {
        return;
    }
    if walkers::has(app, who) {
        let sitting = v.phase == "sitting";
        let face = if who == v.a {
            Some(v.face.clone())
        } else {
            v.face_b.clone()
        };
        walkers::pose(
            app,
            who,
            if sitting { "sit" } else { "talk" },
            face.as_deref(),
        );
        walkers::say(app, who, text, LINE_GAP - 200);
        if !sitting {
            let who = who.to_string();
            later(app, LINE_GAP - 300, move |app| {
                if walkers::has(app, &who) {
                    let face =
                        visit(app).and_then(|v| if who == v.a { Some(v.face) } else { v.face_b });
                    walkers::pose(app, &who, "stand", face.as_deref());
                }
            });
        }
    } else {
        tell(app, who, json!({ "phase": "say", "text": text }));
    }
}

/// Lunch out: b gets up too, and both walk to a spot between their desks.
pub(super) fn go_out(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    let (a, b) = (v.a.clone(), v.b.clone());
    tell(app, &b, json!({ "phase": "listen-end" }));
    // (between their desks: the visitor's out walking already, its desk is where it came from)
    let (Some(ra), Some(rb)) = (robots::desk_rect(app, &a), robots::desk_rect(app, &b)) else {
        return homeward(app, None, 1.0);
    };
    let m = window::monitor_near(ra.x, ra.y);
    let (wa, s) = (m.work, m.scale);
    let mid = (ra.x as f64 + ra.w as f64 / 2.0 + rb.x as f64 + rb.w as f64 / 2.0) / 2.0;
    let y = (ra.bottom().max(rb.bottom()) as f64 - 10.0 * s).min(wa.bottom() as f64 - 12.0 * s);
    let a_left = ra.x < rb.x;
    let off = 58.0 * s;
    let spot_a = (mid + if a_left { -off } else { off }, y);
    let spot_b = (mid + if a_left { off } else { -off }, y);
    let face = if a_left { "right" } else { "left" };
    let face_b = if a_left { "left" } else { "right" };
    let a2 = a.clone();
    vset(app, move |v| {
        v.spot_b = Some(spot_b);
        v.face = face.into();
        v.face_b = Some(face_b.into());
        v.phase = "outing".into();
        v.out = Some(HashSet::from([a2]));
        v.there = HashSet::new();
    });
    let who = a.clone();
    let errand = Errand {
        face: Some(face.into()),
        on_arrive: Some(Box::new(move |app: &AppHandle| sit_down(app, &who))),
        ..Errand::default()
    };
    walkers::walk_to(app, &a, spot_a, errand);
    tell(
        app,
        &b,
        json!({ "phase": "go-out", "with": name_of(app, &a) }),
    ); // (it gets up: robot:wander asks errand_for for its walk)
    later(app, 12000, move |app| {
        if visit(app).is_some_and(|v| v.phase == "outing") && !walkers::is_out(app, &b) {
            homeward(app, None, 1.0); // (it never came)
        }
    });
}

pub(super) fn sit_down(app: &AppHandle, id: &str) {
    let Some(mut v) = visit(app) else { return };
    v.there.insert(id.to_string());
    let both = v.there.len() >= 2;
    let there = v.there.clone();
    vset(app, |x| {
        x.there = there;
        if both {
            x.phase = "sitting".into();
        }
    });
    let face = if id == v.a {
        Some(v.face.clone())
    } else {
        v.face_b.clone()
    };
    walkers::pose(app, id, "sit", face.as_deref());
    if !both {
        return;
    }
    // both there: lunch, side by side, chatting
    let (a, b) = (v.a.clone(), v.b.clone());
    let (a1, a2) = two_lines(app, &a, "lunchChat", &b); // (never the same line twice)
    let (b1, b2) = two_lines(app, &b, "lunchChat", &a);
    let said = [a1, b1, a2, b2];
    let n = said.len() as u64;
    for (i, text) in said.into_iter().enumerate() {
        let who = if i % 2 == 1 { b.clone() } else { a.clone() };
        later(app, 1500 + i as u64 * (LINE_GAP + 600), move |app| {
            talk(app, &who, &text)
        });
    }
    later(app, 1500 + n * (LINE_GAP + 600) + 800, |app| {
        homeward(app, None, 1.0)
    });
}

/// The milk-tea round: the next desk, or home with everyone's order in.
pub(super) fn next_tea_stop(app: &AppHandle) {
    let Some(v) = visit(app) else { return };
    tell(app, &v.b, json!({ "phase": "listen-end" }));
    tell(app, &v.b, json!({ "phase": "hosting", "on": false }));
    let next = v
        .stops
        .iter()
        .find(|x| is_open(app, x) && at_desk(app, x) && !rep(app, x).b("chat"))
        .cloned();
    let n2 = next.clone();
    vset(app, move |v| v.stops.retain(|x| Some(x) != n2.as_ref()));
    let Some(next) = next else {
        talk(app, &v.a, &line(app, &v.a, "teaOrdered", &v.b));
        deliver(app, v.ordered.clone(), "tea");
        soc(app, |s| s.tea_day = today());
        return later(app, LINE_GAP, |app| homeward(app, None, 1.0));
    };
    let side = side_of(app, &next, &v.a);
    let n3 = next.clone();
    vset(app, move |v| {
        v.b = n3;
        v.side = side;
        v.face = face_for(side);
        v.phase = "walking".into();
    });
    tell(app, &next, json!({ "phase": "hosting", "on": true }));
    let ok = match spot(app) {
        Some(to) => walkers::walk_to(app, &v.a, to, arrived_errand(&face_for(side))),
        None => false,
    };
    if !ok {
        homeward(app, None, 1.0);
    }
}

/// The food / the milk tea comes, a few minutes later, to every robot in on it.
pub(super) fn deliver(app: &AppHandle, ids: Vec<String>, kind: &'static str) {
    let ms = visit(app)
        .and_then(|v| v.delivery)
        .unwrap_or(if kind == "food" {
            DELIVERY_FOOD
        } else {
            DELIVERY_TEA
        });
    after(app, ms, move |app| {
        let mut seen = HashSet::new();
        for id in ids.into_iter().filter(|id| seen.insert(id.clone())) {
            if is_open(app, &id) {
                let text = line(
                    app,
                    &id,
                    if kind == "food" {
                        "lunchArrived"
                    } else {
                        "teaArrived"
                    },
                    "",
                );
                tell(
                    app,
                    &id,
                    json!({ "phase": "treat", "kind": kind, "text": text }),
                );
            }
        }
    });
}

pub(super) fn homeward(app: &AppHandle, gait: Option<&str>, speed_k: f64) {
    let Some(v) = visit(app) else { return };
    if v.phase == "home" {
        return;
    }
    let out = v.mode == "goout" && v.out.is_some();
    vset(app, |v| v.phase = "home".into());
    if v.mode == "chat" {
        tell(app, &v.b, json!({ "phase": "listen-end" }));
    }
    walkers::go_home(app, &v.a, gait, speed_k);
    if out && walkers::has(app, &v.b) {
        walkers::go_home(app, &v.b, gait, speed_k);
    }
}

/// The visit's over (home and docked, picked up, called back, or it never left).
pub(super) fn end_visit(app: &AppHandle, why: &str) {
    let Some(v) = soc(app, |s| s.visit.take()) else {
        return;
    };
    if v.mode == "chat" {
        tell(app, &v.b, json!({ "phase": "listen-end" }));
    }
    tell(app, &v.a, json!({ "phase": "visit-over", "why": why }));
    if v.mode == "goout" {
        tell(app, &v.b, json!({ "phase": "visit-over", "why": why }));
    }
    tell(app, &v.b, json!({ "phase": "hosting", "on": false }));
}

/// A visit that should end early: you're using the host or the visitor, or the host got busy.
pub(super) fn check(app: &AppHandle) {
    let Some(v) = visit(app).filter(|v| v.phase == "there") else {
        return;
    };
    if !at_desk(app, &v.b) {
        return homeward(app, None, 1.0); // (the host's gone off: nobody to visit)
    }
    let rb = rep(app, &v.b);
    if rb.b("chat") || (v.mode == "chat" && rb.b("busy")) {
        walkers::say(
            app,
            &v.a,
            &line(app, &v.a, if rb.b("chat") { "gotta" } else { "busy" }, &v.b),
            1800,
        );
        later(app, 1200, |app| homeward(app, None, 1.4));
    } else if v.mode == "watch" && !rb.b("busy") && v.arrived_at.elapsed() > Duration::from_secs(3)
    {
        // its task ended without a "done" (stopped, an error): back home
        later(app, 800, |app| homeward(app, None, 1.0));
    }
}

// ---------------------------------------------------------------- paper planes

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
