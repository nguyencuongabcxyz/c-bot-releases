//! Routines from a robot's chat (its list_routines, add_routine, remove_routine and
//! run_routine tools): "every weekday at 8, bring me the news on AI chips".

use super::*;
use crate::runtime::util::text;

const DAY_NAMES: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/// The days a robot named: "mon".."sun", "weekdays", "weekends", "every day" (none: every day).
fn days_of(v: &Value) -> Result<Vec<u8>, Error> {
    let mut out = vec![];
    for d in v.as_array().into_iter().flatten() {
        let d = text(d).trim().to_lowercase();
        match d.as_str() {
            "weekdays" => out.extend(1..=5),
            "weekends" => out.extend([6, 7]),
            "every day" | "daily" | "all" => out.extend(1..=7),
            _ => {
                let at = DAY_NAMES
                    .iter()
                    .position(|n| d.starts_with(n))
                    .ok_or_else(|| format!("“{d}” isn't a day (mon … sun, weekdays, weekends)."))?;
                out.push(at as u8 + 1);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(if out.len() == 7 { vec![] } else { out })
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|s| text(s).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// When, from a robot's add_routine: once_at, or every_hours (between), or times (on days).
pub(super) fn when_of(args: &Value) -> Result<When, Error> {
    let days = days_of(&args["days"])?;
    let once = text(&args["once_at"]).trim().replace(' ', "T");
    if !once.is_empty() {
        return Ok(When::Once { at: once });
    }
    if let Some(hours) = args["every_hours"].as_u64() {
        let between = strings(&args["between"]);
        let (from, to) = match between.as_slice() {
            [a, b] => (a.clone(), b.clone()),
            _ => ("09:00".to_string(), "18:00".to_string()),
        };
        return Ok(When::Every {
            hours: hours as u32,
            from,
            to,
            days,
        });
    }
    let times = strings(&args["times"]);
    if times.is_empty() {
        return Err("Say when it runs: times (like [\"08:00\"]), every_hours, or once_at.".into());
    }
    Ok(When::Daily { days, times })
}

/// The robot called this (by name), or the one asking.
fn robot_of(app: &AppHandle, from: &str, name: &str) -> Result<String, Error> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Ok(from.to_string());
    }
    robot_list(app)
        .into_iter()
        .find(|r| r.1.to_lowercase() == name)
        .map(|r| r.0)
        .ok_or_else(|| format!("There's no robot called “{name}”.").into())
}

/// The routine called this: by its exact name, else the one whose name has it.
fn find(app: &AppHandle, name: &str) -> Result<Routine, Error> {
    let q = name.trim().to_lowercase();
    let list = routines(app, |s| s.list.clone()).unwrap_or_default();
    if let Some(r) = list.iter().find(|r| r.name.to_lowercase() == q) {
        return Ok(r.clone());
    }
    let near: Vec<&Routine> = list
        .iter()
        .filter(|r| r.name.to_lowercase().contains(&q))
        .collect();
    match near.as_slice() {
        [r] if !q.is_empty() => Ok((*r).clone()),
        _ => Err(format!(
            "There's no routine called “{name}”. There are: {}.",
            if list.is_empty() {
                "none yet".to_string()
            } else {
                list.iter()
                    .map(|r| r.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )
        .into()),
    }
}

/// Your routines, for a robot's chat (its list_routines tool).
pub fn list_for_chat(app: &AppHandle) -> String {
    let names = robot_list(app);
    let list = routines(app, |s| s.list.clone()).unwrap_or_default();
    if list.is_empty() {
        return "No routines yet.".into();
    }
    let now = local_now();
    let lines: Vec<String> = list
        .iter()
        .map(|r| {
            let robot = names
                .iter()
                .find(|n| n.0 == r.robot)
                .map_or("?", |n| n.1.as_str());
            let next = r
                .when
                .next(now, 1)
                .first()
                .map(|t| schedule::slot_label(*t));
            let state = match (r.on, next) {
                (false, _) => "off".to_string(),
                (true, Some(n)) => format!("next {n}"),
                (true, None) => "nothing coming".to_string(),
            };
            let last = r.last.as_ref().map_or(String::new(), |l| {
                format!(
                    "; last run {}{}",
                    local_of(l.at).format("%a %-d %b %H:%M"),
                    if l.outcome == Outcome::Failed {
                        " (failed)"
                    } else {
                        ""
                    }
                )
            });
            format!(
                "- {} — {} — run by {robot} ({state}{last})\n  Prompt: {}",
                runs::title(r),
                r.when.label(),
                r.prompt.replace('\n', " ")
            )
        })
        .collect();
    format!(
        "{} routine{}:\n{}",
        list.len(),
        if list.len() == 1 { "" } else { "s" },
        lines.join("\n")
    )
}

/// A routine, asked for in a robot's chat (its add_routine tool).
pub fn add_for_chat(app: &AppHandle, from: &str, args: &Value) -> Result<String, Error> {
    let show = match text(&args["show"]).as_str() {
        "" | "card" => Show::Card,
        "pop" => Show::Pop,
        "toast" => Show::Toast,
        other => return Err(format!("show is card, pop or toast, not “{other}”.").into()),
    };
    let draft = Draft {
        id: None,
        name: text(&args["name"]),
        emoji: text(&args["emoji"]),
        robot: robot_of(app, from, &text(&args["robot"]))?,
        prompt: text(&args["prompt"]),
        when: when_of(args)?,
        show,
        catch_up: args["catch_up"].as_bool().unwrap_or(true),
        limit_min: args["time_limit_minutes"]
            .as_u64()
            .map_or(LIMIT_MIN, |m| m as u32),
    };
    let id = save(app, draft)?;
    let r = routines(app, |s| s.get(&id).cloned())
        .flatten()
        .ok_or("It's gone already.")?;
    let next = r
        .when
        .next(local_now(), 1)
        .first()
        .map_or("nothing coming".to_string(), |t| schedule::slot_label(*t));
    Ok(format!(
        "Saved the routine {} ({}; next run {next}). The user can change it in the Routines window (tray menu → ⏰ Routines).",
        runs::title(&r),
        r.when.label()
    ))
}

/// Delete one (its remove_routine tool).
pub fn remove_for_chat(app: &AppHandle, name: &str) -> Result<String, Error> {
    let r = find(app, name)?;
    delete(app, &r.id);
    Ok(format!("Deleted the routine {}.", runs::title(&r)))
}

/// Run one now (its run_routine tool): the result comes as it always does.
pub fn run_for_chat(app: &AppHandle, name: &str) -> Result<String, Error> {
    let r = find(app, name)?;
    start(app, &r.id, None)?;
    Ok(format!(
        "Started {} now. It runs in a tab of its own; the result is shown to the user when it's done, so don't wait for it.",
        runs::title(&r)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_a_robot_says() {
        assert_eq!(
            when_of(&json!({ "times": ["08:00"], "days": ["weekdays"] })).unwrap(),
            When::Daily {
                days: vec![1, 2, 3, 4, 5],
                times: vec!["08:00".into()]
            }
        );
        assert_eq!(
            when_of(&json!({ "times": ["08:00"], "days": ["Monday", "fri", "weekends"] })).unwrap(),
            When::Daily {
                days: vec![1, 5, 6, 7],
                times: vec!["08:00".into()]
            }
        );
        // every day is no days at all
        assert_eq!(
            when_of(&json!({ "times": ["17:30"], "days": ["weekdays", "weekends"] })).unwrap(),
            When::Daily {
                days: vec![],
                times: vec!["17:30".into()]
            }
        );
        assert_eq!(
            when_of(&json!({ "every_hours": 2, "between": ["10:00", "16:00"] })).unwrap(),
            When::Every {
                hours: 2,
                from: "10:00".into(),
                to: "16:00".into(),
                days: vec![]
            }
        );
        assert_eq!(
            when_of(&json!({ "once_at": "2026-10-30 14:00" })).unwrap(),
            When::Once {
                at: "2026-10-30T14:00".into()
            }
        );
        assert!(when_of(&json!({})).is_err());
        assert!(when_of(&json!({ "times": ["08:00"], "days": ["someday"] })).is_err());
    }
}
