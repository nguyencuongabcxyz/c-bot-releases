//! What the pages ask of the stage: the robots' pages (picking, swapping, the gaps) and its bar.

use super::*;

// ---------------------------------------------------------------- what the pages ask

/// A robot Ctrl+clicked: picked for the stage, or not.
#[tauri::command(async)]
pub fn stage_pick(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    toggle_pick(&app, &robots::sender(&window)?);
    Ok(())
}

/// A tile's title bar: spotlight it (again: back to the grid), or step off the stage.
#[tauri::command(async)]
pub fn stage_tile(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    let id = robots::sender(&window)?;
    match action.as_str() {
        "spot" => {
            if stg(&app, |s| {
                if !s.on || !s.has(&id) {
                    return false;
                }
                s.spot = if s.spot.as_deref() == Some(&id) {
                    None
                } else {
                    Some(id.clone())
                };
                true
            }) {
                apply(&app);
            }
        }
        "leave" => leave(&app, &id),
        _ => {}
    }
    Ok(())
}

/// A gap between tiles dragged (d: CSS px along it since the press), or double-clicked
/// ("even": every tile on that line the same size).
#[tauri::command(async)]
pub fn stage_split(
    app: AppHandle,
    window: tauri::WebviewWindow,
    step: Value,
) -> Result<(), String> {
    robots::sender(&window)?;
    let Some(split) = step["split"].as_str().and_then(Split::parse) else {
        return Ok(());
    };
    let k = match split {
        Split::Outer(k) | Split::Inner(_, k) => k,
    };
    let moved = stg(&app, |s| {
        if !s.on || s.spot.is_some() {
            return false;
        }
        match step["phase"].as_str() {
            Some("start") => {
                let Some((sizes, across)) = s.sizes_of(split) else {
                    return false;
                };
                let min = s.px(if across { MIN_W } else { MIN_H });
                s.drag = Some(Drag { split, sizes, min });
                false
            }
            Some("move") => {
                let Some(d) = s.drag.as_ref().filter(|d| d.split == split) else {
                    return false;
                };
                let px = s.px(step["d"].as_f64().unwrap_or(0.0));
                let sizes = give(&d.sizes, k, px, d.min);
                s.set_weights(split, &sizes);
                true
            }
            Some("end") => {
                s.drag = None;
                false
            }
            Some("even") => {
                let Some((sizes, _)) = s.sizes_of(split) else {
                    return false;
                };
                s.set_weights(split, &vec![1; sizes.len()]);
                true
            }
            _ => false,
        }
    });
    if moved {
        apply(&app);
    }
    Ok(())
}

/// A tile's title bar dragged onto another tile: they change places.
#[tauri::command(async)]
pub fn stage_swap(
    app: AppHandle,
    window: tauri::WebviewWindow,
    phase: String,
) -> Result<(), String> {
    let id = robots::sender(&window)?;
    match phase.as_str() {
        "start" => stg(&app, |s| {
            s.swap = s.on.then(|| Swap {
                from: id.clone(),
                over: None,
            })
        }),
        "move" => {
            let (cx, cy) = window::cursor();
            let hover = stg(&app, |s| {
                let sw = s.swap.as_mut()?;
                let over = s
                    .placed
                    .iter()
                    .find(|(pid, (r, _))| **pid != sw.from && r.contains(cx, cy))
                    .map(|(pid, _)| pid.clone());
                (over != sw.over).then(|| (std::mem::replace(&mut sw.over, over.clone()), over))
            });
            if let Some((was, now)) = hover {
                if let Some(was) = was {
                    tell_robot(&app, &was, json!({ "kind": "target", "on": false }));
                }
                if let Some(now) = now {
                    tell_robot(&app, &now, json!({ "kind": "target", "on": true }));
                }
            }
        }
        "end" => {
            let target = stg(&app, |s| {
                let sw = s.swap.take()?;
                let to = sw.over?;
                let at = |s: &Stage, id: &str| {
                    s.groups.iter().enumerate().find_map(|(g, gr)| {
                        gr.tiles.iter().position(|t| t.id == id).map(|t| (g, t))
                    })
                };
                let (a, b) = (at(s, &sw.from)?, at(s, &to)?);
                let ida = s.groups[a.0].tiles[a.1].id.clone();
                s.groups[a.0].tiles[a.1].id = s.groups[b.0].tiles[b.1].id.clone();
                s.groups[b.0].tiles[b.1].id = ida;
                Some(to)
            });
            if let Some(t) = target {
                tell_robot(&app, &t, json!({ "kind": "target", "on": false }));
                apply(&app);
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command(async)]
pub fn stage_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, LABEL)?;
    let now = bar_state(&app);
    stg(&app, |s| s.sent = Some(now.clone()));
    Ok(now)
}

/// The bar's buttons: take the stage, forget the picks, end it, even the tiles out, bring
/// another robot on, leave one out of "send to all" (or back in).
#[tauri::command(async)]
pub fn stage_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    id: Option<String>,
) -> Result<(), String> {
    only(&window, LABEL)?;
    let id = id.unwrap_or_default();
    match action.as_str() {
        "start" => start(&app, None),
        "clear" => clear_picks(&app),
        "unpick" => toggle_pick(&app, &id),
        "exit" => exit(&app),
        "add" => add(&app, &id),
        "even" => {
            let cast = stg(&app, |s| {
                s.spot = None;
                s.cast()
            });
            stg(&app, |s| s.arrange(&cast));
            apply(&app);
        }
        "chip" => {
            stg(&app, |s| {
                if !s.off.remove(&id) {
                    s.off.insert(id.clone());
                }
            });
            changed(&app);
        }
        _ => {}
    }
    Ok(())
}

/// The bar's ＋: a menu of the robots on the desk that aren't on stage (ui/tray.rs picks it).
#[tauri::command(async)]
pub fn stage_add_menu(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    only(&window, LABEL)?;
    let cast = cast(&app);
    let others: Vec<(String, String)> = with(&app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c["visible"].as_bool().unwrap_or(false))
            .filter_map(|c| {
                Some((
                    c["id"].as_str()?.to_string(),
                    c["name"].as_str().unwrap_or("Robo").to_string(),
                ))
            })
            .filter(|(id, _)| !cast.contains(id))
            .collect()
    });
    let mut items: Vec<tauri::Result<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> = others
        .iter()
        .filter(|(id, _)| can_go(&app, id))
        .map(|(id, name)| tray::item(&app, format!("stage|add|{id}"), name, true))
        .collect();
    if items.is_empty() {
        items.push(tray::item(
            &app,
            "none".into(),
            "Every robot on the desk is on stage",
            false,
        ));
    }
    if let Ok(menu) = tray::build_menu(&app, items) {
        let _ = window.popup_menu(&menu);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn stage_send(
    app: AppHandle,
    window: tauri::WebviewWindow,
    prompt: String,
    paths: Vec<String>,
) -> Result<Value, String> {
    only(&window, LABEL)?;
    let prompt = prompt.trim();
    if prompt.is_empty() && paths.is_empty() {
        return Ok(json!({ "ok": false, "error": "Nothing to send." }));
    }
    Ok(send(&app, prompt, &paths))
}

/// The bar's 📎: files (or pictures) to send along.
#[tauri::command(async)]
pub fn stage_pick_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<Value>, String> {
    only(&window, LABEL)?;
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Files to show every robot")
        .blocking_pick_files()
        .unwrap_or_default();
    Ok(picked
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .take(20)
        .filter_map(|p| crate::workbench::paste::inspect(&p.to_string_lossy()))
        .collect())
}

pub fn setup(app: &AppHandle) {
    let p = window::primary_monitor();
    app.manage(Mutex::new(Stage {
        picked: vec![],
        on: false,
        screen: p.work,
        scale: p.scale,
        rows: false,
        groups: vec![],
        spot: None,
        off: HashSet::new(),
        drag: None,
        swap: None,
        placed: HashMap::new(),
        bar: None,
        making: false,
        sent: None,
    }));
}
