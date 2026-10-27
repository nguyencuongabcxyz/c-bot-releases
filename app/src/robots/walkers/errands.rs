//! What other parts ask of the walkers: errands (a visit, a lunch run, the maid's round), coming
//! back, and where everyone is.

use super::*;

// ---------------------------------------------------------------- what others ask

/// Is this robot out (or about to set off)?
pub fn has(app: &AppHandle, id: &str) -> bool {
    ws(app, |m| m.contains_key(id))
}

/// Has it actually left its desk (not just getting up)?
pub fn is_out(app: &AppHandle, id: &str) -> bool {
    ws(app, |m| m.get(id).is_some_and(|w| w.shown))
}

/// Sleepwalking (it went out asleep)?
pub fn is_sleepwalking(app: &AppHandle, id: &str) -> bool {
    ws(app, |m| m.get(id).is_some_and(|w| w.shown && w.asleep && w.held.is_none() && w.docking.is_none()))
}

/// Where it is now (physical px).
pub fn bounds(app: &AppHandle, id: &str) -> Option<Rect> {
    ws(app, |m| m.get(id).filter(|w| w.shown).map(Walker::rect))
}

/// Where its feet are now (screen px).
pub fn feet(app: &AppHandle, id: &str) -> Option<(f64, f64)> {
    ws(app, |m| m.get(id).map(Walker::feet))
}

/// Back at the desk: the desk shows its character first (it says 'docked' once it has),
/// then the walker goes, so it never blinks out in between.
pub fn dock(app: &AppHandle, id: &str) {
    let desk = desk_of(app, id);
    let action = ws(app, |m| {
        let w = m.get_mut(id)?;
        if w.docking.is_some() {
            return None;
        }
        w.held = None;
        let Some(d) = desk else { return Some(None) };
        w.docking = Some(Instant::now() + DOCK_WAIT);
        // where its feet are, in desk-window px, so it stands there at the desk as the walker goes
        let (fx, fy) = w.feet();
        Some(Some(format!("dock:{},{}", ((fx - d.rect.x as f64) / d.s).round(), ((fy - d.rect.y as f64) / d.s).round())))
    });
    match action {
        Some(Some(a)) => {
            let _ = app.emit_to(robots::label_of(id), "robot:action", a);
        }
        Some(None) => close(app, id), // (no desk to go back to)
        None => {}
    }
}

/// Its walker window goes (the desk has its character back).
pub fn close(app: &AppHandle, id: &str) {
    let Some(w) = ws(app, |m| m.remove(id)) else { return };
    if let Some(window) = app.get_webview_window(&w.label) {
        let _ = window.close();
    }
    drop(w);
    tray::refresh(app);
    maid::gone(app, id);
    social::gone(app, id);
}

/// Walk (on an errand) to where its feet should be (screen px), then on_arrive; it stands
/// there after. False if it can't (carried, docking, not out).
pub fn walk_to(app: &AppHandle, id: &str, feet: (f64, f64), errand: Errand) -> bool {
    let mut errand = Some(errand);
    let mut ok = false;
    with_walker(app, id, |w, _| {
        if w.held.is_none()
            && w.docking.is_none()
            && let Some(e) = errand.take()
        {
            w.errand_to(feet, e);
            ok = true;
        }
    });
    ok
}

/// Walk back to its desk and dock there.
pub fn go_home(app: &AppHandle, id: &str, gait: Option<&str>, speed_k: f64) -> bool {
    let desk = desk_of(app, id);
    let mut home = None;
    let ok = ws(app, |m| {
        let w = m.get_mut(id)?;
        if w.held.is_some() || w.docking.is_some() {
            return Some(false);
        }
        home = w.home_feet(desk.as_ref());
        if let Some(feet) = home {
            let e = Errand { gait: gait.map(str::to_string), speed_k, ..dock_errand(id) };
            w.errand_to(feet, e);
        }
        Some(true)
    });
    if ok == Some(true) && home.is_none() {
        dock(app, id);
    }
    ok == Some(true)
}

/// While it stands on an errand: what it does (talk, clap, wave, stand, dust…) and which way
/// it faces.
pub fn pose(app: &AppHandle, id: &str, gait: &str, heading: Option<&str>) {
    with_walker(app, id, |w, fx| {
        if w.held.is_some() || w.docking.is_some() || w.errand.is_some() {
            return;
        }
        w.stop_here();
        w.pause = Pause::Forever;
        w.set_gait(gait, heading, fx);
    });
}

/// A speech bubble over its head for ms.
pub fn say(app: &AppHandle, id: &str, text: &str, ms: u64) {
    with_walker(app, id, |w, fx| say_fx(w, fx, text, ms));
}

/// A click: it waves at you.
pub fn wave(app: &AppHandle, id: &str) {
    with_walker(app, id, |w, fx| {
        if w.held.is_some() {
            return;
        }
        w.stop_here();
        let gait = if w.asleep { "stand" } else { "wave" };
        w.set_gait(gait, Some("toward"), fx);
        w.pause = Pause::Until(Instant::now() + Duration::from_secs(2));
    });
}

/// It dozed off (sleepwalks on) or woke up out there.
pub fn set_asleep(app: &AppHandle, id: &str, asleep: bool) {
    with_walker(app, id, |w, fx| {
        if w.asleep == asleep {
            return;
        }
        w.asleep = asleep;
        w.gait.clear(); // (re-sent with the new mood)
        let gait = if w.pause != Pause::No { "stand" } else if asleep { "sleepwalk" } else { "walk" };
        w.set_gait(gait, None, fx);
    });
}

/// It stops and mumbles a word in its sleep (features/vocab/mod.rs's dream).
pub fn dream(app: &AppHandle, id: &str, word: &str) {
    with_walker(app, id, |w, fx| {
        if w.held.is_some() || w.docking.is_some() || !w.asleep {
            return;
        }
        w.stop_here();
        w.set_gait("stand", Some("toward"), fx);
        w.pause = Pause::Until(Instant::now() + Duration::from_secs(9)); // (a nice long pause while the dream bubble is up)
        w.send(fx, "walker:dream", json!({ "word": word }));
    });
}

/// Its look changed (the Workshop): the walker follows.
pub fn character(app: &AppHandle, id: &str) {
    if !has(app, id) {
        return;
    }
    if let Some(look) = with(app, |st| st.store.get(id).map(look_of)) {
        let _ = app.emit_to(label_of(id), "walker:character", look);
    }
}

/// The cursor (physical px), every few frames (robots/mod.rs watch_cursor): eyes follow it, only
/// the character catches the mouse (worked out here too: Windows can quietly stop telling a
/// see-through window about the mouse, and then it could never be picked up again), and
/// while it lets clicks through, its page still hears where the mouse is (cbot:forward).
pub fn cursor(app: &AppHandle, at: (i32, i32)) {
    static TICKS: AtomicU64 = AtomicU64::new(0);
    let eyes_now = TICKS.fetch_add(1, Ordering::Relaxed).is_multiple_of(2);
    let mut fx = vec![];
    ws(app, |m| {
        for w in m.values_mut() {
            let p = (at.0 as f64, at.1 as f64);
            if eyes_now && w.eyes != Some(at) {
                w.eyes = Some(at);
                w.send(&mut fx, "walker:cursor", json!({ "x": (p.0 - w.x) / w.s, "y": (p.1 - w.y) / w.s }));
            }
            if w.shown && w.held.is_none() && w.docking.is_none() {
                let over = over_character(w.x, w.y, w.bw as f64, w.bh as f64, w.k * w.s, p);
                w.set_through(!over, &mut fx);
            }
            if w.through == Some(true) && w.forwarded != Some(at) && w.rect().contains(at.0, at.1) {
                w.forwarded = Some(at);
                let msg = json!({ "x": (p.0 - w.x) / w.s, "y": (p.1 - w.y) / w.s, "sx": p.0 / w.s, "sy": p.1 / w.s });
                w.send(&mut fx, "cbot:forward", msg);
            }
        }
    });
    run(app, fx);
}

/// After a sleep, an unlock or a change of screens: back on a screen you can see, on top,
/// and the mouse worked out afresh.
pub fn recover(app: &AppHandle) {
    let ids: Vec<String> = ws(app, |m| m.keys().cloned().collect());
    let desks: HashMap<String, Option<Desk>> = ids.iter().map(|id| (id.clone(), desk_of(app, id))).collect();
    let now = Instant::now();
    let mut fx = vec![];
    ws(app, |m| {
        for (id, w) in m.iter_mut() {
            if !w.shown {
                continue;
            }
            let desk = desks.get(id).copied().flatten();
            let wa = w.area(desk.as_ref());
            (w.x, w.y) = clamp_into(w.x, w.y, w.bw, w.bh, wa);
            w.held = None; // (a drag cut short by the sleep)
            w.stop_here();
            w.pause = Pause::Until(now + Duration::from_millis(1500));
            w.place(&mut fx);
            w.through = None; // set it again, whatever we last thought it was
            w.set_through(true, &mut fx);
            fx.push(Fx::TopMost(w.hwnd));
        }
    });
    run(app, fx);
}
