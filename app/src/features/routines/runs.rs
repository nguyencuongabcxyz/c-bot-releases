//! A routine's run: started on time (or by hand), done in a tab of the robot's chat, its
//! answer kept and shown; a run that takes too long is stopped.

use super::*;

/// What's due runs; what's taken too long stops.
pub(super) fn check(app: &AppHandle) {
    let now = local_now();
    let t = now_ms();
    let Some((late, due)) = routines(app, |s| {
        let late: Vec<(Run, u32)> = s
            .runs
            .values()
            .filter_map(|run| {
                let limit = s
                    .get(&run.routine)
                    .map_or(LIMIT_MIN, |r| r.limit_min.max(1));
                (t - run.started > limit as i64 * 60_000).then(|| (run.clone(), limit))
            })
            .collect();
        let due: Vec<(String, String)> = s
            .list
            .iter()
            .filter(|r| r.on && !s.running(&r.id))
            .filter_map(|r| {
                let last = schedule::slot(&r.slot);
                let slot = schedule::due(&r.when, local_of(r.created_at), last, now, r.catch_up)?;
                Some((r.id.clone(), schedule::slot_text(slot)))
            })
            .collect();
        (late, due)
    }) else {
        return;
    };
    for (run, limit) in late {
        hub::send_to_robot(
            app,
            &run.robot,
            "robot:routine",
            json!({ "phase": "stop", "runId": run.id }),
        );
        finish(
            app,
            &run.robot,
            &run.id,
            "",
            &format!(
                "It took longer than {limit} minute{}, so it was stopped.",
                if limit == 1 { "" } else { "s" }
            ),
        );
    }
    // (a robot that isn't out yet: tried again on the next look, while the slot's still due)
    for (id, slot) in due {
        let _ = start(app, &id, Some(slot));
    }
}

/// Run a routine now: for this slot (on time), or by hand (None).
pub(super) fn start(app: &AppHandle, id: &str, slot: Option<String>) -> Result<(), Error> {
    let r = routines(app, |s| s.get(id).cloned())
        .flatten()
        .ok_or("That routine is gone.")?;
    let robot_name = robot_list(app)
        .into_iter()
        .find(|n| n.0 == r.robot)
        .map(|n| n.1)
        .ok_or("The robot that runs it is gone: pick another one.")?;
    let out = robots::open_ids(app).contains(&r.robot)
        && (robots::is_showing(app, &r.robot) || robots::is_away(app, &r.robot));
    if !out {
        return Err(format!("{robot_name} isn't on the desktop, so it can't run it now.").into());
    }
    let run = Run {
        id: uuid::Uuid::new_v4().to_string(),
        routine: r.id.clone(),
        robot: r.robot.clone(),
        slot: slot.clone().unwrap_or_default(),
        started: now_ms(),
    };
    let started = routines(app, |s| {
        if s.running(id) {
            return false;
        }
        s.runs.insert(run.id.clone(), run.clone());
        if let (Some(slot), Some(x)) = (&slot, s.get_mut(id)) {
            x.slot = slot.clone(); // (not again, however it goes)
            s.save();
        }
        true
    });
    if started != Some(true) {
        return Err("It's running already.".into());
    }
    if robots::walkers::has(app, &r.robot) {
        robots::walkers::dock(app, &r.robot); // (out walking: back to its desk first)
    }
    let at = slot.as_deref().and_then(schedule::slot);
    hub::send_to_robot(
        app,
        &r.robot,
        "robot:routine",
        json!({
            "phase": "run",
            "runId": run.id,
            "routineId": r.id,
            "title": title(&r),
            "text": run_text(&r, at),
            "last": last_note(&r),
        }),
    );
    changed(app);
    Ok(())
}

/// The robot's answer (or why there's none): kept, then shown.
pub(super) fn finish(app: &AppHandle, robot: &str, run_id: &str, text: &str, error: &str) {
    let done = routines(app, |s| {
        let run = s.runs.get(run_id).filter(|r| r.robot == robot)?.clone();
        s.runs.remove(run_id);
        let r = s.get_mut(&run.routine)?;
        let (outcome, said) = if error.is_empty() {
            (Outcome::Done, text.trim())
        } else {
            (Outcome::Failed, error.trim())
        };
        r.last = Some(Last {
            slot: run.slot.clone(),
            at: now_ms(),
            outcome,
            text: said.chars().take(RESULT_MAX).collect(),
        });
        if matches!(r.when, When::Once { .. }) && !run.slot.is_empty() {
            r.on = false; // (a one-off: done)
        }
        let r = r.clone();
        s.save();
        Some(r)
    })
    .flatten();
    if let Some(r) = done {
        changed(app);
        show(app, &r);
    }
}

/// The result, shown as the routine says: beside the robot out on its desk; from the island
/// when it's away (its page says so there, as for any finished tab); else a notification.
fn show(app: &AppHandle, r: &Routine) {
    let Some(last) = &r.last else {
        return;
    };
    let ok = last.outcome == Outcome::Done;
    let line = if ok {
        gist(&last.text)
    } else {
        last.text.clone()
    };
    if robots::is_away(app, &r.robot) {
        return;
    }
    let out = robots::is_showing(app, &r.robot);
    if r.show == Show::Toast || !out {
        notify(app, &title(r), &line, ok);
        return;
    }
    hub::send_to_robot(
        app,
        &r.robot,
        "robot:routine",
        json!({ "phase": "result", "routineId": r.id, "title": title(r), "line": line, "ok": ok, "show": r.show }),
    );
    if r.show == Show::Card {
        panel::open(
            app,
            Some(r.robot.clone()),
            json!({ "view": "result", "id": r.id }),
            false,
        );
    }
}

fn notify(app: &AppHandle, title: &str, line: &str, ok: bool) {
    use tauri_plugin_notification::NotificationExt;
    let title = if ok {
        title.to_string()
    } else {
        format!("⚠️ {title} didn't run")
    };
    if let Err(err) = app.notification().builder().title(title).body(line).show() {
        log::warn!("couldn't show a routine's result: {err}");
    }
}

/// "📰 Morning news".
pub(super) fn title(r: &Routine) -> String {
    let emoji = if r.emoji.is_empty() { "⏰" } else { &r.emoji };
    format!("{emoji} {}", r.name)
}

/// What the robot is asked: the routine's prompt, with what it needs to know round it.
pub(super) fn run_text(r: &Routine, at: Option<NaiveDateTime>) -> String {
    let when = match at {
        Some(t) => format!(
            "C-Bot runs this for the user on a schedule ({}); this run is for {}.",
            r.when.label(),
            schedule::slot_label(t)
        ),
        None => "The user started this run by hand.".to_string(),
    };
    [
        format!("⏰ Routine “{}”. {when}", r.name),
        String::new(),
        r.prompt.trim().to_string(),
        String::new(),
        "The user isn't watching while you work, so don't ask them anything: do it with what you have, and say what you couldn't do. Begin your answer with one short line that gives the result itself (the main news, the answer, the number; not a greeting or a lead-in): it's shown on its own. Then the rest.".to_string(),
    ]
    .join("\n")
}

/// The last result, for a run in a new tab (one that remembers it doesn't need it): so the
/// robot doesn't tell you the same again.
pub(super) fn last_note(r: &Routine) -> String {
    let Some(last) = r.last.as_ref().filter(|l| l.outcome == Outcome::Done) else {
        return String::new();
    };
    let text: String = last.text.chars().take(2500).collect();
    let when = local_of(last.at).format("%a %-d %b %H:%M");
    format!(
        "For reference, your result last time ({when}):\n---\n{text}\n---\nDon't repeat what's already in it unless something changed."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_robot_is_asked() {
        let mut r = Routine {
            id: "r1".into(),
            name: "Morning news".into(),
            emoji: String::new(),
            robot: "c1".into(),
            prompt: "  Top 5 AI chip stories.  ".into(),
            when: When::Daily {
                days: vec![1, 2, 3, 4, 5],
                times: vec!["08:00".into()],
            },
            show: Show::Card,
            on: true,
            catch_up: true,
            limit_min: 10,
            created_at: 0,
            slot: String::new(),
            last: None,
        };
        assert_eq!(title(&r), "⏰ Morning news");
        let text = run_text(&r, schedule::slot("2026-10-28T08:00"));
        assert!(text.starts_with("⏰ Routine “Morning news”. C-Bot runs this for the user on a schedule (Weekdays · 08:00); this run is for Wed 28 Oct 08:00.\n\nTop 5 AI chip stories.\n\nThe user isn't watching"));
        assert!(run_text(&r, None).contains("The user started this run by hand."));
        assert_eq!(last_note(&r), "");
        r.last = Some(Last {
            slot: String::new(),
            at: 0,
            outcome: Outcome::Failed,
            text: "timed out".into(),
        });
        assert_eq!(last_note(&r), "");
        r.last = Some(Last {
            slot: String::new(),
            at: 0,
            outcome: Outcome::Done,
            text: "TSMC record orders".into(),
        });
        assert!(last_note(&r).contains("\n---\nTSMC record orders\n---\nDon't repeat"));
    }
}
