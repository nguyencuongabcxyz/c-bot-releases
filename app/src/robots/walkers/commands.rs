//! What the pages ask of the walkers: a robot's page setting off, and the walker windows' own.

use super::*;
use crate::runtime::Error;

// ---------------------------------------------------------------- commands

/// The walker whose window (walker-<id>) sent a command.
pub(super) fn walker_of(window: &tauri::WebviewWindow) -> Result<String, Error> {
    window
        .label()
        .strip_prefix("walker-")
        .map(str::to_string)
        .ok_or_else(|| format!("{} isn't a walker's window", window.label()).into())
}

/// The robot gets ready to go for a walk round the screen (asleep: it sleepwalks).
#[tauri::command(async)]
pub fn robot_wander_prep(
    app: AppHandle,
    window: tauri::WebviewWindow,
    opts: Value,
) -> Result<bool, Error> {
    let id = robots::sender(&window)?;
    Ok(prepare(
        &app,
        &id,
        opts["asleep"].as_bool().unwrap_or(false),
        None,
        None,
    ))
}

/// It sets off (from where its feet are, if the page says).
#[tauri::command(async)]
pub fn robot_wander(
    app: AppHandle,
    window: tauri::WebviewWindow,
    opts: Value,
) -> Result<bool, Error> {
    let id = robots::sender(&window)?;
    let f = &opts["feet"];
    let feet = f["x"]
        .as_f64()
        .zip(f["y"].as_f64())
        .filter(|(x, y)| x.is_finite() && y.is_finite());
    // (off to visit another robot's desk: social.rs has its errand)
    let errand = social::errand_for(&app, &id).map(|v| errand_from(&id, &v));
    Ok(go(
        &app,
        &id,
        opts["asleep"].as_bool().unwrap_or(false),
        feet,
        errand,
    ))
}

/// The desk tells its walker something.
#[tauri::command(async)]
pub fn robot_walker(
    app: AppHandle,
    window: tauri::WebviewWindow,
    what: String,
) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    match what.as_str() {
        "wave" => wave(&app, &id),
        a @ ("asleep" | "awake") => set_asleep(&app, &id, a == "asleep"),
        "dock" => dock(&app, &id),
        "docked" => close(&app, &id), // the desk has its character back: the walker can go
        "cancel" if !is_out(&app, &id) => close(&app, &id), // it sat back down before setting off
        _ => {}
    }
    Ok(())
}

#[tauri::command(async)]
pub fn walker_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, Error> {
    let id = walker_of(&window)?;
    let found = ws(&app, |m| {
        m.get(&id)
            .map(|w| (w.look.clone(), w.gait.clone(), w.heading.clone(), w.asleep))
    });
    let Some((look, gait, heading, asleep)) = found else {
        return Ok(json!({}));
    };
    let character = look.or_else(|| with(&app, |st| st.store.get(&id).map(look_of)));
    Ok(
        json!({ "character": character, "gait": if gait.is_empty() { "stand".into() } else { gait }, "heading": heading, "asleep": asleep }),
    )
}

/// Its first frame is drawn: take over from the desk (now, or once it's told to go).
#[tauri::command(async)]
pub fn walker_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), Error> {
    let id = walker_of(&window)?;
    with_walker(&app, &id, |w, fx| {
        w.ready = true;
        if w.going {
            take_over(&id, w, fx);
        }
    });
    Ok(())
}

/// Only the character catches the mouse; the rest of the box lets clicks through.
#[tauri::command(async)]
pub fn walker_through(
    app: AppHandle,
    window: tauri::WebviewWindow,
    through: bool,
) -> Result<(), Error> {
    let id = walker_of(&window)?;
    with_walker(&app, &id, |w, fx| {
        if w.held.is_none() {
            w.set_through(through, fx);
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn walker_drag(app: AppHandle, window: tauri::WebviewWindow, step: Value) -> Result<(), Error> {
    drag(&app, &walker_of(&window)?, &step);
    Ok(())
}

/// A click (no drag): it waves at you (or the maid / a visitor has something to say).
#[tauri::command(async)]
pub fn walker_click(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), Error> {
    let id = walker_of(&window)?;
    if has(&app, &id) && !maid::clicked(&app, &id) && !social::clicked(&app, &id) {
        wave(&app, &id);
    }
    Ok(())
}

/// Picked up and carried: it dangles; put down on its desk, it docks (dx, dy: CSS px since
/// the press).
pub(super) fn drag(app: &AppHandle, id: &str, p: &Value) {
    let desk = desk_of(app, id);
    let (dx, dy) = (
        p["dx"].as_f64().unwrap_or(0.0),
        p["dy"].as_f64().unwrap_or(0.0),
    );
    let now = Instant::now();
    let mut docks = false;
    with_walker(app, id, |w, fx| {
        if w.docking.is_some() || w.npc {
            return; // (a visitor can't be carried off)
        }
        match p["phase"].as_str() {
            Some("start") => {
                w.held = Some((w.x, w.y));
                if w.errand.is_some() || w.pause == Pause::Forever {
                    let who = id.to_string();
                    fx.push(Fx::Run(Box::new(move |app: &AppHandle| {
                        social::held(app, &who)
                    })));
                }
                w.errand = None;
                w.set_through(false, fx); // carried: it keeps the mouse till it's put down
                w.pause = Pause::No;
                w.set_gait("dangle", Some("toward"), fx);
            }
            Some("move") => {
                let Some((hx, hy)) = w.held else { return };
                w.x = hx + dx * w.s;
                w.y = hy + dy * w.s;
                w.place(fx);
                // the desk lights up while it's over it (the desk page shows a "drop me here" glow)
                let over = desk.is_some_and(|d| {
                    over_desk(w.x, w.y, w.bw as f64, w.bh as f64, d.rect, 24.0 * d.s)
                });
                if over != w.over && desk.is_some() {
                    fx.push(Fx::Robot(
                        id.to_string(),
                        if over { "dock-hover" } else { "dock-leave" }.into(),
                    ));
                }
                w.over = over;
            }
            Some("end") => {
                if w.held.take().is_none() {
                    return;
                }
                let over_now = desk.is_some_and(|d| {
                    over_desk(w.x, w.y, w.bw as f64, w.bh as f64, d.rect, 24.0 * d.s)
                });
                if w.over || over_now {
                    docks = true;
                    return;
                }
                // put down elsewhere: keep it on the screen, then carry on
                let wa = w.area(desk.as_ref());
                (w.x, w.y) = clamp_into(w.x, w.y, w.bw, w.bh, wa);
                w.place(fx);
                w.set_gait("land", Some("toward"), fx);
                w.stop_here();
                w.pause = Pause::Until(now + Duration::from_millis(1500));
                w.roam_until = Some(now + Duration::from_secs_f64(rand_in(ROAM.0, ROAM.1))); // (a fresh stroll from where it was put)
            }
            _ => {}
        }
    });
    if docks {
        dock(app, id);
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Walkers::default()));
    let app = app.clone();
    thread::spawn(move || clock(app));
}
