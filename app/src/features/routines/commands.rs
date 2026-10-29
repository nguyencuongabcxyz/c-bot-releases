//! What the Routines window asks (add, change, delete, switch on or off, run now, the
//! result's buttons), and a robot's run coming back.

use super::*;

/// A routine as the window (or a robot's add_routine) sends it: a new one has no id.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Draft {
    #[serde(default)]
    pub(super) id: Option<String>,
    pub(super) name: String,
    #[serde(default)]
    pub(super) emoji: String,
    pub(super) robot: String,
    pub(super) prompt: String,
    pub(super) when: When,
    #[serde(default)]
    pub(super) show: Show,
    #[serde(default = "yes")]
    pub(super) catch_up: bool,
    #[serde(default = "limit")]
    pub(super) limit_min: u32,
}

/// Add a routine or change one; its id.
pub(super) fn save(app: &AppHandle, d: Draft) -> Result<String, Error> {
    let name: String = d
        .name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect();
    if name.is_empty() {
        return Err("Give it a name.".into());
    }
    if d.prompt.trim().is_empty() {
        return Err("Say what it should do (the prompt).".into());
    }
    if let Some(p) = d.when.problem() {
        return Err(p.into());
    }
    if !robot_list(app).iter().any(|r| r.0 == d.robot) {
        return Err("Pick a robot to run it.".into());
    }
    let emoji: String = d.emoji.trim().chars().take(4).collect();
    let limit_min = d.limit_min.clamp(1, 60);
    let now = now_ms();
    let saved = routines(app, |s| {
        if let Some(id) = d.id.as_deref().filter(|i| !i.is_empty()) {
            let r = s.get_mut(id).ok_or("That routine is gone.")?;
            if r.when != d.when {
                r.created_at = now; // (a new time: what was due before it doesn't run now)
            }
            (r.name, r.emoji, r.robot, r.prompt, r.when) = (name, emoji, d.robot, d.prompt, d.when);
            (r.show, r.catch_up, r.limit_min) = (d.show, d.catch_up, limit_min);
            let id = r.id.clone();
            s.save();
            return Ok(id);
        }
        if s.list.len() >= ROUTINES_MAX {
            return Err(format!(
                "That's {ROUTINES_MAX} routines already: delete one first."
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        s.list.push(Routine {
            id: id.clone(),
            name,
            emoji,
            robot: d.robot,
            prompt: d.prompt,
            when: d.when,
            show: d.show,
            on: true,
            catch_up: d.catch_up,
            limit_min,
            created_at: now,
            slot: String::new(),
            last: None,
        });
        s.save();
        Ok(id)
    })
    .ok_or("Routines aren't loaded yet.")?;
    let id = saved?;
    changed(app);
    Ok(id)
}

/// Delete one; its name, if it was there.
pub(super) fn delete(app: &AppHandle, id: &str) -> Option<String> {
    let name = routines(app, |s| {
        let at = s.list.iter().position(|r| r.id == id)?;
        let r = s.list.remove(at);
        s.save();
        Some(r.name)
    })
    .flatten();
    changed(app);
    name
}

fn set_on(app: &AppHandle, id: &str, on: bool) {
    routines(app, |s| {
        if let Some(r) = s.get_mut(id) {
            if on && !r.on {
                r.created_at = now_ms(); // (back on: from the next time, not what it missed)
            }
            r.on = on;
            s.save();
        }
    });
    changed(app);
}

// ---------------------------------------------------------------- the window's

#[tauri::command(async)]
pub fn routines_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, Error> {
    only(&window, panel::LABEL)?;
    let (focus, robot) = panel::focus(&app);
    let mut v = view(&app);
    if let Some(o) = v.as_object_mut() {
        o.insert("focus".into(), focus);
        o.insert("robot".into(), json!(robot));
    }
    Ok(v)
}

#[tauri::command(async)]
pub fn routines_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    p: Option<Value>,
) -> Result<Value, Error> {
    only(&window, panel::LABEL)?;
    let p = p.unwrap_or_default();
    let id = crate::runtime::util::text(&p["id"]);
    match action.as_str() {
        "save" => Ok(json!(save(&app, serde_json::from_value(p)?)?)),
        "delete" => Ok(json!(delete(&app, &id))),
        "toggle" => {
            set_on(&app, &id, p["on"].as_bool().unwrap_or(false));
            Ok(Value::Null)
        }
        "run" => start(&app, &id, None).map(|_| Value::Null),
        "chat" => {
            let robot = routines(&app, |s| s.get(&id).map(|r| r.robot.clone())).flatten();
            if let Some(robot) = robot {
                hub::send_to_robot(
                    &app,
                    &robot,
                    "robot:routine",
                    json!({ "phase": "open", "routineId": id }),
                );
                panel::close(&app);
            }
            Ok(Value::Null)
        }
        "note" => {
            let text = routines(&app, |s| {
                s.get(&id).map(|r| (runs::title(r), r.last.clone()))
            })
            .flatten()
            .and_then(|(title, last)| Some(format!("{title}: {}", last?.text)))
            .ok_or("There's no result to note down.")?;
            Ok(crate::features::notes::add(&app, &text, "routine"))
        }
        "close" => {
            panel::close(&app);
            Ok(Value::Null)
        }
        _ => Err(format!("No action {action}.").into()),
    }
}

// ---------------------------------------------------------------- the robot's

/// A run's answer, from the robot's page: its text, or why there's none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnswer {
    run_id: String,
    text: Option<String>,
    error: Option<String>,
}

#[tauri::command(async)]
pub fn routines_done(
    app: AppHandle,
    window: tauri::WebviewWindow,
    answer: RunAnswer,
) -> Result<(), Error> {
    let robot = robots::sender(&window)?;
    finish(
        &app,
        &robot,
        &answer.run_id,
        answer.text.as_deref().unwrap_or(""),
        answer.error.as_deref().unwrap_or(""),
    );
    Ok(())
}

/// A robot's: open the Routines window beside it (/routines).
#[tauri::command(async)]
pub fn routines_open(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), Error> {
    let robot = robots::sender(&window)?;
    open_window(&app, Some(robot));
    Ok(())
}
