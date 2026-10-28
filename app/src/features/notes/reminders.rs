//! The daily reminders: a robot holds up its corkboard (or Windows shows a notification), checked once a minute and when you come back to the PC.

use super::*;

/// A daily reminder is due: a robot holds up its corkboard and the notebook opens (robot.ts
/// asks for it with notes:remind-open). It waits while that robot's busy; with no robot out,
/// a Windows notification. False: it couldn't be shown now (tried again on the next check).
pub(super) fn remind(app: &AppHandle, kind: Reminder, info: &Value) -> bool {
    let summary = json!({ "today": info["today"], "open": info["open"], "taken": info["taken"] });
    let Some(id) = hub::notes_robot(app) else {
        use tauri_plugin_notification::NotificationExt;
        let title = if kind == Reminder::Morning {
            "🌅 Your notes from yesterday"
        } else {
            "🌇 Before you go: your notes"
        };
        let body: Vec<String> = info["notes"]
            .as_array()
            .into_iter()
            .flatten()
            .take(4)
            .map(|n| {
                let done = n["doneAt"].as_i64().is_some_and(|d| d != 0);
                format!(
                    "{} {}",
                    if done { "✓" } else { "•" },
                    text(&n["text"]).split('\n').next().unwrap_or("")
                )
            })
            .collect();
        // (a click on it can't open the notebook here: the plugin doesn't say when it's clicked)
        if let Err(err) = app
            .notification()
            .builder()
            .title(title)
            .body(body.join("\n"))
            .show()
        {
            log::warn!("couldn't show the reminder: {err}");
            return false;
        }
        return true;
    };
    // away on the island: the island holds it up for you, the robot stays put (busy or not)
    if robots::is_away(app, &id) {
        let title = if kind == Reminder::Morning {
            "Your notes from yesterday"
        } else {
            "Before you go: your notes"
        };
        let open = info["open"].as_i64().unwrap_or(0);
        let text = if open > 0 {
            format!("{title} ({open} open)")
        } else {
            title.to_string()
        };
        let reminder = json!({ "kind": kind, "info": { "today": summary["today"], "open": summary["open"], "taken": summary["taken"], "line": text } });
        return crate::robots::island::say(app, &id, "notes", &text, Some(reminder));
    }
    if hub::robot_busy(app, &id) {
        return false;
    }
    tell(
        app,
        Some(&id),
        json!({ "phase": "remind", "kind": kind, "info": summary }),
    );
    true
}

/// Is a reminder due? Then show it (once it has been, not again today).
pub(super) fn check(app: &AppHandle) {
    let present = !presence::locked() && input::idle_secs() < AWAY_AFTER;
    let c = book::cfg(&settings(app));
    let d = Local::now();
    let Some(Some((due, info))) = state(app, |s| {
        let due: Due = s.clock.due(&s.notes, &c, d, present)?;
        let info = book::gather(&s.notes, due.kind, d, &c);
        Some((due, info))
    }) else {
        return;
    };
    // nothing to say: counts as done for today
    let shown = info["notes"].as_array().is_none_or(Vec::is_empty) || remind(app, due.kind, &info);
    if shown {
        state(app, |s| NoteClock::shown(&mut s.notes, &due, d));
    }
}

/// Checks once a minute, a little after C-Bot starts, and whenever you're back at the PC (an
/// unlock, waking from sleep).
pub(super) fn watch(app: AppHandle) {
    thread::spawn(move || {
        let mut next = Instant::now() + FIRST_CHECK;
        let mut was_locked = presence::locked();
        let mut last = SystemTime::now();
        loop {
            thread::sleep(Duration::from_secs(2));
            let t = SystemTime::now();
            let slept = t
                .duration_since(last)
                .is_ok_and(|d| d > Duration::from_secs(30));
            last = t;
            let is_locked = presence::locked();
            if slept || (was_locked && !is_locked) {
                next = next.min(Instant::now() + BACK_CHECK);
            }
            was_locked = is_locked;
            if Instant::now() >= next {
                next = Instant::now() + CHECK_EVERY;
                check(&app);
            }
        }
    });
}
