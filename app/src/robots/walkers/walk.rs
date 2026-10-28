//! One walker's walk (impl Walker): each step, a pause, a line said, taking over a new errand; run() keeps it going.

use super::*;

impl Walker {
    pub(super) fn rect(&self) -> Rect {
        Rect {
            x: self.x.round() as i32,
            y: self.y.round() as i32,
            w: self.bw,
            h: self.bh,
        }
    }

    pub(super) fn feet(&self) -> (f64, f64) {
        (
            self.x + self.bw as f64 / 2.0,
            self.y + self.bh as f64 * FEET,
        )
    }

    pub(super) fn place(&self, fx: &mut Vec<Fx>) {
        fx.push(Fx::Place(self.hwnd, self.rect()));
    }

    pub(super) fn send(&self, fx: &mut Vec<Fx>, channel: &'static str, payload: Value) {
        fx.push(Fx::Emit(self.label.clone(), channel, payload));
    }

    pub(super) fn set_gait(&mut self, gait: &str, heading: Option<&str>, fx: &mut Vec<Fx>) {
        let heading = heading
            .map(str::to_string)
            .unwrap_or_else(|| self.heading.clone());
        if gait == self.gait && heading == self.heading {
            return;
        }
        self.gait = gait.to_string();
        self.heading = heading;
        let speed = if self.asleep { 0.6 } else { 1.0 };
        let msg = json!({ "gait": self.gait, "heading": self.heading, "asleep": self.asleep, "speed": speed });
        self.send(fx, "walker:state", msg);
    }

    pub(super) fn set_through(&mut self, through: bool, fx: &mut Vec<Fx>) {
        if self.through == Some(through) {
            return;
        }
        self.through = Some(through);
        self.forwarded = None;
        fx.push(Fx::Through(self.label.clone(), through));
    }

    /// Where it may roam: the screen its desk is on (a visitor: the one it's on).
    pub(super) fn area(&self, desk: Option<&Desk>) -> Rect {
        let at = match desk {
            Some(d) => (d.rect.x + d.rect.w / 2, d.rect.y + d.rect.h / 2),
            None => (self.x as i32, self.y as i32),
        };
        window::monitor_near(at.0, at.1).work
    }

    /// Somewhere else on the screen, not too close.
    pub(super) fn new_target(&mut self, desk: Option<&Desk>) {
        let wa = self.area(desk);
        for i in 0..8 {
            let tx = rand_in(wa.x as f64, (wa.right() - self.bw) as f64);
            let ty = rand_in(wa.y as f64, (wa.bottom() - self.bh) as f64);
            if (tx - self.x).hypot(ty - self.y) > 220.0 * self.s || i == 7 {
                self.target = (tx, ty);
                return;
            }
        }
    }

    /// An errand: walk to where its feet should be (screen px), then on_arrive.
    pub(super) fn errand_to(&mut self, feet: (f64, f64), errand: Errand) {
        self.target = (
            feet.0 - self.bw as f64 / 2.0,
            feet.1 - self.bh as f64 * FEET,
        );
        self.errand = Some(errand);
        self.pause = Pause::No;
    }

    /// Where its feet go back to at its desk (where it stood up).
    pub(super) fn home_feet(&self, desk: Option<&Desk>) -> Option<(f64, f64)> {
        let d = desk?;
        let (fx, fy) = match self.home {
            Some((x, y)) => (x * d.s, y * d.s),
            None => (d.rect.w as f64 * 0.55, d.rect.h as f64 * 0.85),
        };
        Some((d.rect.x as f64 + fx, d.rect.y as f64 + fy))
    }

    pub(super) fn stop_here(&mut self) {
        self.target = (self.x, self.y);
    }
}

pub(super) fn say_fx(w: &Walker, fx: &mut Vec<Fx>, text: &str, ms: u64) {
    w.send(fx, "walker:say", json!({ "text": text, "ms": ms }));
}

pub(super) fn dock_errand(id: &str) -> Errand {
    let id = id.to_string();
    Errand {
        on_arrive: Some(Box::new(move |app: &AppHandle| dock(app, &id))),
        ..Errand::default()
    }
}

/// One step along its route (main walker.js step).
pub(super) fn step(id: &str, w: &mut Walker, now: Instant, desk: Option<&Desk>, fx: &mut Vec<Fx>) {
    if w.held.is_some() {
        return;
    }
    // the stroll's over: it heads back to its desk (not while on an errand or standing for one)
    if w.roam_until.is_some_and(|t| now > t) && w.errand.is_none() && w.pause != Pause::Forever {
        w.roam_until = None;
        if let Some(feet) = w.home_feet(desk) {
            if !w.asleep {
                say_fx(w, fx, pick(&BACK_LINES).copied().unwrap_or(""), 2200);
            }
            w.errand_to(feet, dock_errand(id));
        }
    }
    match w.pause {
        Pause::Forever => return,
        Pause::Until(t) if now < t => return,
        Pause::Until(_) => {
            w.pause = Pause::No;
            w.new_target(desk);
        }
        Pause::No => {}
    }
    let (dx, dy) = (w.target.0 - w.x, w.target.1 - w.y);
    let dist = dx.hypot(dy);
    let speed = if w.asleep {
        SPEED_SLEEPWALK
    } else {
        SPEED_WALK
    } * w.k
        * w.s
        * w.errand.as_ref().map_or(1.0, |e| e.speed_k);
    let move_by = speed * TICK.as_secs_f64();
    if dist <= move_by {
        w.x = w.target.0;
        w.y = w.target.1;
        w.place(fx);
        if let Some(e) = w.errand.take() {
            // there on an errand: it stands (facing where it was told) till it's sent on
            w.pause = Pause::Forever;
            w.set_gait("stand", Some(e.face.as_deref().unwrap_or("toward")), fx);
            if let Some(f) = e.on_arrive {
                fx.push(Fx::Run(f));
            }
            return;
        }
        // there: stop for a bit, doing something
        let pauses: &[(&str, f64, f64)] = if w.asleep {
            &PAUSES_ASLEEP
        } else {
            &PAUSES_AWAKE
        };
        let (gait, a, b) = pick(pauses).copied().unwrap_or(("stand", 2.0, 3.0));
        let heading = if gait == "stand" || gait == "sit" {
            Some("toward")
        } else {
            None
        };
        w.set_gait(gait, heading, fx);
        w.pause = Pause::Until(now + Duration::from_secs_f64(rand_in(a, b)));
        return;
    }
    w.x += dx / dist * move_by;
    w.y += dy / dist * move_by;
    let gait = w
        .errand
        .as_ref()
        .and_then(|e| e.gait.clone())
        .unwrap_or_else(|| if w.asleep { "sleepwalk" } else { "walk" }.into());
    w.set_gait(&gait, Some(heading_to(dx, dy)), fx);
    w.place(fx);
}

/// Shown, and the desk lets go of its own, in the same moment.
pub(super) fn take_over(id: &str, w: &mut Walker, fx: &mut Vec<Fx>) {
    if w.shown {
        return;
    }
    w.shown = true;
    w.handoff_at = None;
    w.cancel_at = None;
    w.place(fx);
    fx.push(Fx::Show(w.hwnd));
    fx.push(Fx::TopMost(w.hwnd));
    fx.push(Fx::Robot(id.to_string(), "handoff".into()));
}

pub(super) fn run(app: &AppHandle, fx: Vec<Fx>) {
    for f in fx {
        match f {
            Fx::Place(hwnd, r) => window::set_bounds(hwnd, r),
            Fx::Emit(label, channel, payload) => {
                let _ = app.emit_to(label, channel, payload);
            }
            Fx::Robot(id, action) => {
                let _ = app.emit_to(robots::label_of(&id), "robot:action", action);
            }
            Fx::Through(label, through) => {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_ignore_cursor_events(through);
                }
            }
            Fx::Show(hwnd) => veil(app, hwnd, false),
            Fx::TopMost(hwnd) => window::set_topmost(hwnd),
            Fx::Run(f) => f(app),
            Fx::Close(id) => close(app, &id),
        }
    }
}

/// Do something to one walker (if it's out), then carry out what it came to.
pub(super) fn with_walker(
    app: &AppHandle,
    id: &str,
    f: impl FnOnce(&mut Walker, &mut Vec<Fx>),
) -> bool {
    let mut fx = vec![];
    let found = ws(app, |m| m.get_mut(id).map(|w| f(w, &mut fx)).is_some());
    run(app, fx);
    found
}
