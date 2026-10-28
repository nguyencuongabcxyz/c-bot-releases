//! Practising your words: a robot dreams of one now and then (its bubble), or quizzes you on it (a card), the ones that are due first.

use super::*;

/// A word to quiz you on when you ask for one: a due one, or else one you're still learning.
pub(super) fn quiz_pick(app: &AppHandle, n: usize) -> Option<Value> {
    words(app, |w| {
        w.vocab
            .next_due(now())
            .or_else(|| walkers::pick(&w.vocab.in_sight(n)).cloned())
    })
    .flatten()
}

/// A sleeping robot dreams of a word that's due, and a dream bubble beside it shows the word,
/// its meaning and an example. (From a robot's menu it shows even if that robot is awake.)
pub(super) fn start_dream(app: &AppHandle, word: Option<Value>, robot: Option<String>) -> bool {
    let (Some(word), Some(robot)) = (word, robot) else {
        return false;
    };
    let id = word["id"].as_str().unwrap_or("").to_string();
    // shown: it counts as seen, the next time is further off
    let Some(Some(seen)) = words(app, |w| {
        if w.quizzing.is_some() {
            None
        } else {
            w.vocab.dreamt(&id, now())
        }
    }) else {
        return false;
    };
    // sleepwalking: it stops and mumbles it where it is, and the bubble goes there
    if walkers::has(app, &robot) {
        walkers::dream(app, &robot, seen["word"].as_str().unwrap_or(""));
    } else {
        tell(app, Some(&robot), json!({ "phase": "dream", "word": seen }));
    }
    let near = hub::robot_rect(app, &robot);
    let paint = color_of(app, Some(&robot));
    island_says(app, &robot, "word", &seen);
    card::open(
        app,
        flagged(seen, &["dream", "known"]),
        Some(robot),
        paint,
        Spot::Near(near),
    );
    count_changed(app);
    true
}

pub(super) fn start_quiz(
    app: &AppHandle,
    word: Option<Value>,
    asked: bool,
    robot: Option<String>,
) -> bool {
    let (Some(word), Some(robot)) = (word, robot) else {
        return false;
    };
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let word_id = word["id"].as_str().unwrap_or("").to_string();
    words(app, |w| {
        w.quizzing = Some(Quiz {
            word_id,
            robot_id: robot.clone(),
        })
    });
    tell(
        app,
        Some(&robot),
        json!({ "phase": "quiz", "word": word, "asked": asked }),
    );
    let spot = card_spot(app, Some(&robot));
    let paint = color_of(app, Some(&robot));
    island_says(app, &robot, "quiz", &word);
    card::open(app, flagged(word, &["quiz"]), Some(robot), paint, spot);
    true
}

/// A quiz straight away (the tray, a robot's menu, My words): a due word, or else one you've
/// seen least, from a robot that's free. False if there's no word or no robot.
pub(super) fn quiz_now_from(app: &AppHandle) -> bool {
    let Some(word) = quiz_pick(app, 3) else {
        return false;
    };
    if words(app, |w| w.quizzing.is_some()) != Some(false) {
        return false;
    }
    let ok = start_quiz(app, Some(word), true, free_robot(app));
    if ok {
        words(app, |w| w.asked = true);
    }
    ok
}

/// What a celebration there is now: (learnt, streak) milestones reached, and what to save.
pub(super) fn milestones(
    stats: &Value,
    settings: &Value,
) -> Option<(i64, i64, Map<String, Value>, &'static str)> {
    let done = &settings["vocabMilestones"];
    let (done_learnt, done_streak) = (
        done["learnt"].as_i64().unwrap_or(0),
        done["streak"].as_i64().unwrap_or(0),
    );
    let (st_learnt, st_streak) = (
        stats["learnt"].as_i64().unwrap_or(0),
        stats["streak"].as_i64().unwrap_or(0),
    );
    let learnt = LEARNT_MILESTONES
        .iter()
        .copied()
        .rfind(|&n| st_learnt >= n && n > done_learnt)
        .unwrap_or(0);
    let streak = STREAK_MILESTONES
        .iter()
        .copied()
        .rfind(|&n| st_streak >= n && n > done_streak)
        .unwrap_or(0);
    if learnt == 0 && streak == 0 {
        return None;
    }
    let or = |a: i64, b: i64| if a != 0 { a } else { b };
    let mut save = patch(vec![(
        "vocabMilestones",
        json!({ "learnt": or(learnt, done_learnt), "streak": or(streak, done_streak) }),
    )]);
    // the 🎓 graduation cap (an accessory) once you've learnt 10
    let unlocked = if learnt >= 10 && settings["vocabRewards"]["gradcap"].as_bool() != Some(true) {
        "gradcap"
    } else {
        ""
    };
    if !unlocked.is_empty() {
        let mut rewards = settings["vocabRewards"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        rewards.insert("gradcap".into(), json!(true));
        save.insert("vocabRewards".into(), Value::Object(rewards));
    }
    Some((learnt, streak, save, unlocked))
}

/// A celebration when you've learnt 10, 25, 50… words or kept a streak going.
pub(super) fn check_milestones(app: &AppHandle, robot: Option<&str>) {
    let Some(stats) = words(app, |w| w.vocab.stats(now())) else {
        return;
    };
    let Some((learnt, streak, save, unlocked)) = milestones(&stats, &settings(app)) else {
        return;
    };
    hub::set_settings(app, save);
    tell(
        app,
        robot,
        json!({ "phase": "milestone", "learnt": learnt, "streak": streak, "unlocked": unlocked }),
    );
    if let Some(r) = robot {
        social::milestone(app, r);
    }
}

/// How the quiz ended: knew / forgot / later (put off for a couple of hours) / ignored.
pub(super) fn end_quiz(app: &AppHandle, how: &str) -> Option<Value> {
    let t = now();
    let (robot, word) = words(app, |w| {
        let q = w.quizzing.take()?;
        w.asked = false;
        let word = match how {
            "knew" | "forgot" => w.vocab.answer(&q.word_id, how == "knew", t),
            "later" => w.vocab.later(&q.word_id, 2 * HOUR, t),
            _ => w.vocab.later(&q.word_id, 30 * MIN, t),
        };
        Some((q.robot_id, word))
    })??;
    if let Some(w) = &word {
        tell(
            app,
            Some(&robot),
            json!({ "phase": "answered", "how": how, "word": w, "wait": words::due_of(w) - t }),
        );
    }
    count_changed(app); // (what's in sight changes as you learn)
    if how == "knew" || how == "forgot" {
        check_milestones(app, Some(&robot));
    }
    word
}

/// The card closed: a quiz still on it was left unanswered.
pub(super) fn card_closed(app: &AppHandle) {
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
}
