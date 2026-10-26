//! Your English words (main vocab.js, reminders.js, wordCard.js, and main.js's catchWord,
//! findMeaning, quizzes, dreams, milestones, the My words window and the word hotkey):
//! captured with a hotkey, looked up by Claude's quick model, shown on a word card
//! ("card"), kept in vocab.json, and seen again in dreams and quizzes. The My words window
//! is "words". [wave 2: words & notes]
//!
//! Select a word anywhere and press the hotkey: the robot nearest the mouse catches it and
//! looks it up in its dictionary while the card shows it; then the meanings in Vietnamese
//! and the phrases fill in, and the card goes in the word box on its desk. Nothing selected
//! (a word in a picture, a video…): drag a box round it, and Claude reads it off the screen.
//!
//! Locks: this module's state (Words) is never held while calling out of it: not into a
//! window, the robots' state (with()), the tray or another module.

pub mod card;
mod dreams;
mod lookup;
pub mod saved;
mod words;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use chrono::{Local, Timelike};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::hub::{self, Hotkey};
use crate::util::{only, patch, text};
use crate::win::{self, Rect};
use crate::{capture, robots, snip, social, tray, views, walkers, with};

pub use dreams::locked;

use card::Spot;
use dreams::DreamClock;
use saved::Saved;
use words::{HOUR, MIN, Vocab};

const WORDS: &str = "words"; // the My words window
const LEARNT_MILESTONES: [i64; 7] = [10, 25, 50, 100, 200, 500, 1000];
const STREAK_MILESTONES: [i64; 7] = [3, 7, 14, 30, 60, 100, 365];

/// A quiz card that's up: on which word, from which robot.
struct Quiz {
    word_id: String,
    robot_id: String,
}

struct Words {
    vocab: Vocab,
    saved: Saved,
    quizzing: Option<Quiz>,
    asked: bool, // the quiz up is one you asked for (no dreams meanwhile)
    clock: DreamClock,
}

fn words<R>(app: &AppHandle, f: impl FnOnce(&mut Words) -> R) -> Option<R> {
    // (None before setup: the tray asks for the count while it's being built)
    let state = app.try_state::<Mutex<Words>>()?;
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let out = f(&mut guard);
    if guard.vocab.dirty {
        guard.vocab.dirty = false;
        guard.saved.save();
    }
    Some(out)
}

fn now() -> i64 {
    crate::store::now_ms()
}

fn settings(app: &AppHandle) -> Value {
    with(app, |st| st.store.settings().clone())
}

/// Tell a robot what happens with your words (it acts it out: robot.ts robot:vocab).
fn tell(app: &AppHandle, id: Option<&str>, payload: Value) {
    if let Some(id) = id {
        hub::send_to_robot(app, id, "robot:vocab", payload);
    }
}

fn color_of(app: &AppHandle, id: Option<&str>) -> Option<String> {
    let id = id?;
    with(app, |st| st.store.get(id).and_then(|c| c["color"].as_str().map(str::to_string)))
}

/// The word with these flags on it (known, quiz, dream: how the card shows it).
fn flagged(mut word: Value, flags: &[&str]) -> Value {
    if let Some(o) = word.as_object_mut() {
        for f in flags {
            o.insert(f.to_string(), json!(true));
        }
    }
    word
}

fn get(app: &AppHandle, id: &str) -> Option<Value> {
    words(app, |w| w.vocab.get(id).cloned()).flatten()
}

/// The count and the words in sight changed: every robot hears, the tray and My words too.
fn count_changed(app: &AppHandle) {
    let Some((count, sight)) = words(app, |w| (w.vocab.count(), w.vocab.sight_words())) else { return };
    for id in robots::open_ids(app) {
        tell(app, Some(&id), json!({ "phase": "count", "count": count }));
        tell(app, Some(&id), json!({ "phase": "sight", "words": sight }));
    }
    tray::refresh(app);
    let _ = app.emit_to(WORDS, "words:changed", ());
}

// ---------------------------------------------------------------- which robot

fn distance(r: Rect, (cx, cy): (i32, i32)) -> f64 {
    let (mx, my) = (r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 / 2.0);
    ((mx - cx as f64).powi(2) + (my - cy as f64).powi(2)).sqrt()
}

/// A robot free to quiz you: the tutor if it's free, else the free robot nearest the mouse.
fn free_robot(app: &AppHandle) -> Option<String> {
    let free = |id: &str| robots::hwnd_of(app, id).is_some_and(win::is_visible) && !walkers::has(app, id) && !hub::robot_busy(app, id);
    let tutor = settings(app)["vocabTutor"].as_str().unwrap_or("").to_string();
    if !tutor.is_empty() && free(&tutor) {
        return Some(tutor);
    }
    let cursor = win::cursor();
    robots::open_ids(app)
        .into_iter()
        .filter(|id| free(id))
        .filter_map(|id| Some((distance(win::window_rect(robots::hwnd_of(app, &id)?), cursor), id)))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
}

/// A robot that's asleep, at its desk or sleepwalking round the screen: the tutor if it is,
/// else the one nearest the mouse.
fn sleeping_robot(app: &AppHandle) -> Option<String> {
    let asleep = |id: &str| {
        let Some(hwnd) = robots::hwnd_of(app, id) else { return false };
        if hub::robot_busy(app, id) {
            return false;
        }
        if walkers::has(app, id) {
            return walkers::is_sleepwalking(app, id);
        }
        win::is_visible(hwnd) && !robots::is_awake(app, id)
    };
    let tutor = settings(app)["vocabTutor"].as_str().unwrap_or("").to_string();
    if !tutor.is_empty() && asleep(&tutor) {
        return Some(tutor);
    }
    let cursor = win::cursor();
    robots::open_ids(app)
        .into_iter()
        .filter(|id| asleep(id))
        .map(|id| (hub::robot_rect(app, &id).map_or(f64::INFINITY, |r| distance(r, cursor)), id))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
}

/// Where a card goes for this robot: as big as its chat (card.rs chat_bounds).
fn card_bounds(app: &AppHandle, id: Option<&str>) -> Option<Rect> {
    let id = id?;
    let desk = robots::desk_rect(app, id)?;
    let chat_open = with(app, |st| st.robots.get(id).is_some_and(|r| r.expanded));
    let m = win::monitor_near(desk.x + desk.w / 2, desk.y + desk.h / 2);
    Some(card::chat_bounds(desk, m.work, m.scale, chat_open))
}

/// A word on the card, as big as this robot's chat (a new word takes over a quiz card).
fn show_card(app: &AppHandle, word: Value, robot: Option<String>) {
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let spot = card_bounds(app, robot.as_deref()).map_or(Spot::Near(None), Spot::Bounds);
    let paint = color_of(app, robot.as_deref());
    card::open(app, word, robot, paint, spot);
}

// ---------------------------------------------------------------- dreams and quizzes

/// A word to quiz you on when you ask for one: a due one, or else one you're still learning.
fn quiz_pick(app: &AppHandle, n: usize) -> Option<Value> {
    words(app, |w| w.vocab.next_due(now()).or_else(|| walkers::pick(&w.vocab.in_sight(n)).cloned())).flatten()
}

/// A sleeping robot dreams of a word that's due, and a dream bubble beside it shows the word,
/// its meaning and an example. (From a robot's menu it shows even if that robot is awake.)
fn start_dream(app: &AppHandle, word: Option<Value>, robot: Option<String>) -> bool {
    let (Some(word), Some(robot)) = (word, robot) else { return false };
    let id = word["id"].as_str().unwrap_or("").to_string();
    // shown: it counts as seen, the next time is further off
    let Some(Some(seen)) = words(app, |w| if w.quizzing.is_some() { None } else { w.vocab.dreamt(&id, now()) }) else { return false };
    // sleepwalking: it stops and mumbles it where it is, and the bubble goes there
    if walkers::has(app, &robot) {
        walkers::dream(app, &robot, seen["word"].as_str().unwrap_or(""));
    } else {
        tell(app, Some(&robot), json!({ "phase": "dream", "word": seen }));
    }
    let near = hub::robot_rect(app, &robot);
    let paint = color_of(app, Some(&robot));
    card::open(app, flagged(seen, &["dream", "known"]), Some(robot), paint, Spot::Near(near));
    count_changed(app);
    true
}

fn start_quiz(app: &AppHandle, word: Option<Value>, asked: bool, robot: Option<String>) -> bool {
    let (Some(word), Some(robot)) = (word, robot) else { return false };
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let word_id = word["id"].as_str().unwrap_or("").to_string();
    words(app, |w| w.quizzing = Some(Quiz { word_id, robot_id: robot.clone() }));
    tell(app, Some(&robot), json!({ "phase": "quiz", "word": word, "asked": asked }));
    let spot = card_bounds(app, Some(&robot)).map_or(Spot::Near(None), Spot::Bounds);
    let paint = color_of(app, Some(&robot));
    card::open(app, flagged(word, &["quiz"]), Some(robot), paint, spot);
    true
}

/// A quiz straight away (the tray, a robot's menu, My words): a due word, or else one you've
/// seen least, from a robot that's free. False if there's no word or no robot.
fn quiz_now_from(app: &AppHandle) -> bool {
    let Some(word) = quiz_pick(app, 3) else { return false };
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
fn milestones(stats: &Value, settings: &Value) -> Option<(i64, i64, Map<String, Value>, &'static str)> {
    let done = &settings["vocabMilestones"];
    let (done_learnt, done_streak) = (done["learnt"].as_i64().unwrap_or(0), done["streak"].as_i64().unwrap_or(0));
    let (st_learnt, st_streak) = (stats["learnt"].as_i64().unwrap_or(0), stats["streak"].as_i64().unwrap_or(0));
    let learnt = LEARNT_MILESTONES.iter().copied().rfind(|&n| st_learnt >= n && n > done_learnt).unwrap_or(0);
    let streak = STREAK_MILESTONES.iter().copied().rfind(|&n| st_streak >= n && n > done_streak).unwrap_or(0);
    if learnt == 0 && streak == 0 {
        return None;
    }
    let or = |a: i64, b: i64| if a != 0 { a } else { b };
    let mut save = patch(vec![("vocabMilestones", json!({ "learnt": or(learnt, done_learnt), "streak": or(streak, done_streak) }))]);
    // the 🎓 graduation cap (an accessory) once you've learnt 10
    let unlocked = if learnt >= 10 && settings["vocabRewards"]["gradcap"].as_bool() != Some(true) { "gradcap" } else { "" };
    if !unlocked.is_empty() {
        let mut rewards = settings["vocabRewards"].as_object().cloned().unwrap_or_default();
        rewards.insert("gradcap".into(), json!(true));
        save.insert("vocabRewards".into(), Value::Object(rewards));
    }
    Some((learnt, streak, save, unlocked))
}

/// A celebration when you've learnt 10, 25, 50… words or kept a streak going.
fn check_milestones(app: &AppHandle, robot: Option<&str>) {
    let Some(stats) = words(app, |w| w.vocab.stats(now())) else { return };
    let Some((learnt, streak, save, unlocked)) = milestones(&stats, &settings(app)) else { return };
    hub::set_settings(app, save);
    tell(app, robot, json!({ "phase": "milestone", "learnt": learnt, "streak": streak, "unlocked": unlocked }));
    if let Some(r) = robot {
        social::milestone(app, r);
    }
}

/// How the quiz ended: knew / forgot / later (put off for a couple of hours) / ignored.
fn end_quiz(app: &AppHandle, how: &str) -> Option<Value> {
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
        tell(app, Some(&robot), json!({ "phase": "answered", "how": how, "word": w, "wait": words::due_of(w) - t }));
    }
    count_changed(app); // (what's in sight changes as you learn)
    if how == "knew" || how == "forgot" {
        check_milestones(app, Some(&robot));
    }
    word
}

/// The card closed: a quiz still on it was left unanswered.
fn card_closed(app: &AppHandle) {
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
}

// ---------------------------------------------------------------- catching a word

/// Quotes and punctuation round a selection trimmed off ("meticulous," → meticulous).
fn trim_edges(s: &str) -> &str {
    let lead = |c: char| c.is_whitespace() || "\"'“”‘’([{".contains(c);
    let trail = |c: char| c.is_whitespace() || "\"'“”‘’)]}.,;:!?".contains(c);
    s.trim_start_matches(lead).trim_end_matches(trail)
}

fn catch(app: &AppHandle, raw: &str, source: &str, robot: Option<String>, context: &str) {
    let text = trim_edges(raw).trim();
    let r = robot.as_deref();
    if text.is_empty() {
        return tell(app, r, json!({ "phase": "empty", "hotkey": hotkey(app) }));
    }
    if text.encode_utf16().count() > 60 || text.split_whitespace().count() > 5 {
        return tell(app, r, json!({ "phase": "too-long" }));
    }
    let t = now();
    let Some((word, known)) = words(app, |w| {
        if let Some(known) = w.vocab.find(text).cloned() {
            if known["status"] == "ready" {
                // you met it again: it comes up for review sooner
                let id = known["id"].as_str().unwrap_or("").to_string();
                return (w.vocab.seen_again(&id, t).unwrap_or(known), true);
            }
            return (known, false);
        }
        (w.vocab.add(text, context, source, t), false)
    }) else {
        return;
    };
    if known {
        tell(app, r, json!({ "phase": "known", "word": word }));
        show_card(app, flagged(word, &["known"]), robot);
        return;
    }
    tell(app, r, json!({ "phase": "catch", "word": word }));
    let id = word["id"].as_str().unwrap_or("").to_string();
    show_card(app, word, robot.clone());
    find_meaning(app, id, robot, false);
}

/// What the lookup made of a word.
enum Found {
    Gone,         // undone while it was looking
    Twin(Value),  // "ran" is "run": the one you already have
    Ready(Value), // looked up
}

/// Look it up (on a thread of its own). quiet: a word saved from a card's lists (＋): looked
/// up in the background, no show.
fn find_meaning(app: &AppHandle, id: String, robot: Option<String>, quiet: bool) {
    let app = app.clone();
    thread::spawn(move || {
        let looking = patch(vec![("status", json!("looking")), ("error", json!(""))]);
        let Some(Some(word)) = words(&app, |w| w.vocab.update(&id, looking)) else { return };
        card::update(&app, &word);
        let claude_path = settings(&app)["claudePath"].as_str().unwrap_or("").to_string();
        let (txt, context) = (text(&word["text"]), text(&word["context"]));
        let r = robot.as_deref();
        // the meaning comes back first: shown while the phrases, synonyms and family are still coming
        let on_core = |meaning: &Value| {
            let m = meaning.as_object().cloned().unwrap_or_default();
            if let Some(Some(partial)) = words(&app, |w| w.vocab.update(&id, m)) {
                card::update(&app, &partial); // (still 'looking' until the rest is in)
            }
        };
        match lookup::lookup(&txt, &context, &claude_path, on_core) {
            Ok(found) => {
                let outcome = words(&app, |w| {
                    if w.vocab.get(&id).is_none() {
                        return Found::Gone;
                    }
                    let twin = w.vocab.find(found["word"].as_str().unwrap_or("")).filter(|t| t["id"] != id.as_str() && t["status"] == "ready").cloned();
                    if let Some(twin) = twin {
                        w.vocab.remove(&id);
                        return Found::Twin(twin);
                    }
                    let mut fields = found.as_object().cloned().unwrap_or_default();
                    fields.insert("status".into(), json!("ready"));
                    let extras_failed = !fields.contains_key("synonyms");
                    w.vocab.update(&id, fields);
                    // (dropped, as the Electron app's undefined: an old usage box, and old
                    // synonyms when this time's extras failed)
                    let gone: &[&str] = if extras_failed { &["usage", "synonyms"] } else { &["usage"] };
                    w.vocab.unset(&id, gone).map_or(Found::Gone, Found::Ready)
                });
                match outcome {
                    None | Some(Found::Gone) => return,
                    Some(Found::Twin(twin)) => {
                        if !quiet {
                            tell(&app, r, json!({ "phase": "known", "word": twin }));
                            show_card(&app, flagged(twin, &["known"]), robot.clone());
                        }
                        count_changed(&app);
                        return;
                    }
                    Some(Found::Ready(done)) => {
                        card::update(&app, &done);
                        if !quiet {
                            tell(&app, r, json!({ "phase": "found", "word": done }));
                            check_milestones(&app, r); // (a new day's first word can extend the streak)
                        }
                    }
                }
            }
            Err(err) => {
                let failed = patch(vec![("status", json!("failed")), ("error", json!(err))]);
                let failed = words(&app, |w| w.vocab.update(&id, failed)).flatten();
                if let Some(f) = &failed {
                    card::update(&app, f);
                }
                if !quiet {
                    tell(&app, r, json!({ "phase": "failed", "word": failed, "error": err }));
                }
            }
        }
        count_changed(&app);
    });
}

/// Drag a box round a word on screen, for this robot. False if the box couldn't start.
fn box_for(app: &AppHandle, robot: Option<String>, source: String) -> bool {
    let r = robot.clone();
    let on_shot: snip::OnShot = Box::new(move |app, png| read_boxed(app, robot, source, png));
    match snip::start(app, "", false, on_shot) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[snip] {err}");
            tell(app, r.as_deref(), json!({ "phase": "unreadable" }));
            false
        }
    }
}

/// The box you dragged: Claude reads the word in it (and its sentence), then it's caught as usual.
fn read_boxed(app: &AppHandle, robot: Option<String>, source: String, png: Vec<u8>) {
    let app = app.clone();
    thread::spawn(move || {
        tell(&app, robot.as_deref(), json!({ "phase": "reading" }));
        let claude_path = settings(&app)["claudePath"].as_str().unwrap_or("").to_string();
        match lookup::read_picture(&png, &claude_path) {
            Ok((found, _)) if found.is_empty() => tell(&app, robot.as_deref(), json!({ "phase": "unreadable" })),
            Ok((found, sentence)) => catch(&app, &found, &source, robot, &sentence),
            Err(err) => {
                eprintln!("[snip] reading failed: {err}");
                tell(&app, robot.as_deref(), json!({ "phase": "unreadable" }));
            }
        }
    });
}

/// The word hotkey: whatever's selected in the app in front; nothing selected (a word in a
/// picture, a video…): drag a box round it instead.
fn capture_word(app: &AppHandle) {
    let sel = capture::read_selection(app, &hotkey(app), false);
    let robot = hub::nearest_robot(app);
    if !sel.text.is_empty() {
        catch(app, &sel.text, &sel.source, robot, "");
    } else {
        box_for(app, robot, sel.source);
    }
}

/// A saved word's card again (a sticky note on a monitor, the My words window).
fn open_word(app: &AppHandle, id: &str, robot: Option<String>) -> bool {
    if get(app, id).is_none() {
        return false;
    }
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let Some(Some(w)) = words(app, |w| w.vocab.update(id, patch(vec![("lastSeenAt", json!(now()))]))) else { return false };
    let spot = card_bounds(app, robot.as_deref()).map_or(Spot::Near(None), Spot::Bounds);
    let paint = color_of(app, robot.as_deref());
    card::open(app, flagged(w, &["known"]), robot, paint, spot);
    true
}

// ---------------------------------------------------------------- the card's buttons

/// What you change on the card (✏️ Edit, then Save), cut to size.
fn edits(p: &Value) -> Map<String, Value> {
    let cut = |v: &Value, n: usize| text(v).chars().take(n).collect::<String>();
    let mut out = Map::new();
    if let Some(senses) = p["senses"].as_array() {
        let s: Vec<Value> = senses.iter().take(5).map(|x| json!({ "pos": text(&x["pos"]), "vi": cut(&x["vi"], 300), "en": cut(&x["en"], 300) })).collect();
        out.insert("senses".into(), json!(s));
    }
    if let Some(examples) = p["examples"].as_array() {
        let e: Vec<Value> = examples.iter().take(6).map(|e| json!({ "en": cut(&e["en"], 400), "vi": cut(&e["vi"], 400) })).collect();
        out.insert("examples".into(), json!(e));
    }
    if let Some(phrases) = p["phrases"].as_array() {
        let ph: Vec<Value> = phrases
            .iter()
            .take(6)
            .map(|x| json!({ "phrase": cut(&x["phrase"], 80), "vi": cut(&x["vi"], 200), "example": cut(&x["example"], 400), "exampleVi": cut(&x["exampleVi"], 400) }))
            .collect();
        out.insert("phrases".into(), json!(ph));
    }
    if let Some(tip) = p["tip"].as_str() {
        out.insert("tip".into(), json!(tip.chars().take(400).collect::<String>()));
    }
    out
}

fn on_card(app: &AppHandle, action: &str, payload: &Value) -> Value {
    let Some(shown) = card::shown(app) else { return Value::Null };
    if action == "close" {
        card::close(app);
        return Value::Null;
    }
    let id = shown.word["id"].as_str().unwrap_or("").to_string();
    let robot = shown.robot_id.clone();
    let t = now();
    match action {
        "retry" => {
            find_meaning(app, id, robot, false);
            Value::Null
        }
        // the dream bubble: 📖 Details opens the whole card, ✓ I know this one skips it ahead
        "details" => {
            if let Some(w) = get(app, &id) {
                let spot = card_bounds(app, robot.as_deref()).map_or(Spot::Near(None), Spot::Bounds);
                let paint = color_of(app, robot.as_deref());
                card::open(app, flagged(w, &["known"]), robot, paint, spot);
            }
            json!(true)
        }
        "know" => {
            let w = words(app, |w| w.vocab.know_it(&id, t)).flatten();
            if let Some(w) = &w {
                tell(app, robot.as_deref(), json!({ "phase": "knowit", "word": w }));
            }
            count_changed(app);
            card::close_after(app, 900);
            w.map_or(Value::Null, |w| json!({ "review": w["review"] }))
        }
        // the quiz card: ✓ Knew it / ✗ Forgot / ⏰ Later, or left unanswered
        "quiz" => {
            if words(app, |w| w.quizzing.as_ref().is_some_and(|q| q.word_id == id)) != Some(true) {
                return Value::Null;
            }
            let how = payload.as_str().filter(|h| ["knew", "forgot", "later", "ignored"].contains(h)).unwrap_or("ignored");
            let done = end_quiz(app, how);
            match how {
                "ignored" => card::close_after(app, 0),
                "later" => card::close_after(app, 900),
                _ => {}
            }
            done.map_or(Value::Null, |w| json!({ "review": w["review"] }))
        }
        // ＋ by a synonym, an antonym or a family word: saved as a word of its own
        "add" => {
            let new: String = trim_edges(&text(payload)).trim().chars().take(60).collect();
            let with = shown.word["word"].as_str().filter(|w| !w.is_empty()).or(shown.word["text"].as_str()).unwrap_or("").to_string();
            let added = words(app, |w| {
                if new.is_empty() || w.vocab.find(&new).is_some() {
                    return None;
                }
                Some(w.vocab.add(&new, "", &format!("with “{with}”"), t))
            });
            let Some(Some(added)) = added else { return json!(false) };
            find_meaning(app, added["id"].as_str().unwrap_or("").to_string(), robot, true);
            json!(true)
        }
        "undo" => {
            words(app, |w| w.vocab.remove(&id));
            tell(app, robot.as_deref(), json!({ "phase": "undone", "word": shown.word }));
            count_changed(app);
            card::close_after(app, 700);
            json!(true)
        }
        "save" => {
            let mut fields = edits(payload);
            fields.insert("editedAt".into(), json!(t));
            let saved = words(app, |w| w.vocab.update(&id, fields)).flatten();
            if let Some(s) = &saved {
                card::update(app, s);
            }
            saved.unwrap_or(Value::Null)
        }
        "ask" => {
            let robot = robot.or_else(|| hub::nearest_robot(app));
            let word = get(app, &id).unwrap_or(shown.word);
            tell(app, robot.as_deref(), json!({ "phase": "ask", "word": word }));
            card::close(app);
            json!(true)
        }
        _ => Value::Null,
    }
}

// ---------------------------------------------------------------- My words

fn open_words_window(app: &AppHandle) {
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(WORDS) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = views::builder(app, WORDS, "words", &[]).title("My words — C-Bot").inner_size(560.0, 720.0).min_inner_size(420.0, 420.0).build();
    if let Err(err) = built {
        eprintln!("[words] couldn't open My words: {err}");
    }
}

fn words_list_of(app: &AppHandle) -> Value {
    let s = settings(app);
    let (rows, stats) = words(app, |w| (w.vocab.list().iter().map(words::word_row).collect::<Vec<_>>(), w.vocab.stats(now()))).unwrap_or_default();
    let hours = s["vocabHours"].as_array().filter(|h| h.len() == 2).map_or(json!([9, 18]), |h| json!(h));
    json!({ "words": rows, "stats": stats, "hotkey": hotkey(app), "reminders": dreams::enabled(&s), "hours": hours })
}

/// Dreams on or off, and your working hours (from My words).
fn words_settings_of(app: &AppHandle, p: &Value) -> Value {
    let mut out = Map::new();
    if let Some(on) = p["reminders"].as_bool() {
        out.insert("vocabReminders".into(), json!(on));
    }
    if let Some(h) = p["hours"].as_array() {
        let hours: Vec<i64> = h.iter().filter_map(Value::as_i64).filter(|x| (0..=24).contains(x)).collect();
        if h.len() == 2 && hours.len() == 2 && hours[0] < hours[1] {
            out.insert("vocabHours".into(), json!(hours));
        }
    }
    if !out.is_empty() {
        hub::set_settings(app, out);
    }
    json!(true)
}

/// A CSV of your words for Anki or Quizlet, saved where you pick; null if you didn't.
fn export(app: &AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;
    let name = format!("my-english-words-{}.csv", chrono::Utc::now().format("%Y-%m-%d"));
    let mut dialog = app.dialog().file().set_title("Export my words").set_file_name(&name).add_filter("CSV (Anki, Quizlet, Excel)", &["csv"]);
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    if let Some(w) = app.get_webview_window(WORDS) {
        dialog = dialog.set_parent(&w);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|f| f.into_path().ok()) else { return Value::Null };
    let rows = words(app, |w| words::csv(&w.vocab.list())).unwrap_or_default();
    if let Err(err) = std::fs::write(&path, rows) {
        eprintln!("[words] couldn't export: {err}");
        return Value::Null;
    }
    let _ = app.opener().reveal_item_in_dir(&path);
    json!(path.to_string_lossy())
}

fn delete_word(app: &AppHandle, id: &str) -> Value {
    let ok = words(app, |w| w.vocab.remove(id)).unwrap_or(false);
    if ok {
        count_changed(app);
    }
    json!(ok)
}

// ---------------------------------------------------------------- for the others

/// How many words you have.
pub fn count(app: &AppHandle) -> usize {
    words(app, |w| w.vocab.count()).unwrap_or(0)
}

/// How many are looked up and ready (for quizzes and dreams).
pub fn ready_count(app: &AppHandle) -> usize {
    words(app, |w| w.vocab.ready().len()).unwrap_or(0)
}

/// The words each robot keeps in sight (main.js sightWords).
pub fn sight(app: &AppHandle) -> Value {
    words(app, |w| w.vocab.sight_words()).unwrap_or_else(|| json!([]))
}

/// The word hotkey's keys.
pub fn hotkey(app: &AppHandle) -> String {
    crate::hub::hotkey_keys(app, "vocabHotkey", "Ctrl+Alt+W")
}

/// Open the My words window.
pub fn open_words(app: &AppHandle) {
    open_words_window(app);
}

/// A word you selected (the palette, the word hotkey): caught by this robot (the nearest
/// if none), shown on the word card and looked up (main.js catchWord).
pub fn catch_word(app: &AppHandle, text: &str, source: &str, robot_id: Option<String>) {
    let robot = robot_id.or_else(|| hub::nearest_robot(app));
    catch(app, text, source, robot, "");
}

/// Drag a box round a word on screen to save it, for this robot (the nearest if none).
pub fn box_word(app: &AppHandle, robot_id: Option<String>, source: String) {
    let robot = robot_id.or_else(|| hub::nearest_robot(app));
    box_for(app, robot, source);
}

/// One of your words in a dream bubble beside this robot. False if there's none to show.
pub fn dream_for(app: &AppHandle, robot_id: &str) -> bool {
    start_dream(app, quiz_pick(app, 4), Some(robot_id.to_string()))
}

/// A quiz on one of your words from this robot (asked: you asked for it).
pub fn quiz_for(app: &AppHandle, robot_id: &str, asked: bool) -> bool {
    start_quiz(app, quiz_pick(app, 4), asked, Some(robot_id.to_string()))
}

/// A quiz now, from a robot that's free. False if none is.
pub fn quiz_now(app: &AppHandle) -> bool {
    quiz_now_from(app)
}

/// A word card is up.
pub fn card_showing(app: &AppHandle) -> bool {
    card::shown(app).is_some()
}

// ---------------------------------------------------------------- commands

fn sender_of(window: &tauri::WebviewWindow) -> Option<String> {
    robots::id_of(window.label()).map(str::to_string)
}

/// A robot's 📚 Save this word (offered under an answer about what a word means).
#[tauri::command(async)]
pub fn robot_vocab_save(app: AppHandle, window: tauri::WebviewWindow, text: String) {
    catch(&app, &text, "", sender_of(&window), "");
}

/// A sticky note on its monitor clicked: that word's card.
#[tauri::command(async)]
pub fn robot_vocab_open(app: AppHandle, window: tauri::WebviewWindow, id: String) -> bool {
    open_word(&app, &id, sender_of(&window))
}

/// Its quiz ends: put off till later, or slapped away (ignored).
#[tauri::command(async)]
pub fn robot_vocab_quiz(app: AppHandle, window: tauri::WebviewWindow, how: String) -> bool {
    let sender = sender_of(&window);
    let mine = sender.is_some() && words(&app, |w| w.quizzing.as_ref().map(|q| q.robot_id.clone())).flatten() == sender;
    if !mine {
        return false;
    }
    // (ended before the card goes, so its closing doesn't end it as ignored first)
    let ended = end_quiz(&app, if how == "later" { "later" } else { "ignored" }).is_some();
    card::close(&app);
    ended
}

#[tauri::command(async)]
pub fn robot_vocab_quiz_me(app: AppHandle) -> bool {
    quiz_now_from(&app)
}

#[tauri::command(async)]
pub fn robot_vocab_words(app: AppHandle) {
    open_words_window(&app);
}

/// 💭 Show me one of my words.
#[tauri::command(async)]
pub fn robot_vocab_dream(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    start_dream(&app, quiz_pick(&app, 4), sender_of(&window))
}

/// 🔍 Box a word on screen.
#[tauri::command(async)]
pub fn robot_vocab_box(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    box_for(&app, sender_of(&window), String::new())
}

// (the word card's own: only it may ask)

#[tauri::command(async)]
pub fn card_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, card::LABEL)?;
    Ok(card::init(&app))
}

/// How tall the card came out (CSS px).
#[tauri::command(async)]
pub fn card_size(app: AppHandle, window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    only(&window, card::LABEL)?;
    card::size(&app, height);
    Ok(())
}

/// A button on the card.
#[tauri::command(async)]
pub fn card_act(app: AppHandle, window: tauri::WebviewWindow, action: String, payload: Option<Value>) -> Result<Value, String> {
    only(&window, card::LABEL)?;
    Ok(on_card(&app, &action, &payload.unwrap_or_default()))
}

// (the My words window)

#[tauri::command(async)]
pub fn words_list(app: AppHandle) -> Value {
    words_list_of(&app)
}

#[tauri::command(async)]
pub fn words_settings(app: AppHandle, patch: Value) -> Value {
    words_settings_of(&app, &patch)
}

/// ⬇️ Export: a CSV, where the save dialog says (its path; null if cancelled).
#[tauri::command(async)]
pub fn words_export(app: AppHandle) -> Value {
    export(&app)
}

#[tauri::command(async)]
pub fn words_open(app: AppHandle, id: String) -> bool {
    open_word(&app, &id, hub::nearest_robot(&app))
}

#[tauri::command(async)]
pub fn words_delete(app: AppHandle, id: String) -> Value {
    delete_word(&app, &id)
}

#[tauri::command(async)]
pub fn words_quiz(app: AppHandle) -> bool {
    quiz_now_from(&app)
}

/// Write vocab.json now if a change is waiting (C-Bot is quitting).
fn flush(app: &AppHandle) {
    if let Some(state) = app.try_state::<Mutex<Words>>() {
        let mut w = state.lock().unwrap_or_else(|e| e.into_inner());
        let Words { vocab, saved, .. } = &mut *w;
        if vocab.dirty {
            vocab.dirty = false;
            saved.save();
        }
        saved.flush_pending(&vocab.data);
    }
}

pub fn setup(app: &AppHandle) {
    let dir = with(app, |st| st.data_dir.clone());
    let saved = Saved::new(&dir, "vocab", "words", false);
    saved.import(crate::electron_data_dir());
    let vocab = Vocab::from(saved.load());
    let t = now();
    app.manage(Mutex::new(Words { vocab, saved, quizzing: None, asked: false, clock: DreamClock::new(t, &words::local_day(t)) }));
    card::setup(app);
    // (what's waiting is written as C-Bot quits)
    let quitting = tauri::plugin::Builder::<tauri::Wry>::new("cbot-vocab")
        .on_event(|app, e| {
            if let RunEvent::Exit = e {
                flush(app);
            }
        })
        .build();
    if let Err(err) = app.plugin(quitting) {
        eprintln!("[vocab] couldn't watch for quitting: {err}");
    }
    hub::add_hotkey(app, Hotkey {
        setting: "vocabHotkey",
        label: "Save a word",
        what: "The word you selected goes into My words",
        default: "Ctrl+Alt+W",
        run: capture_word,
    });

    // changes are saved a moment after they happen
    let a = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        if let Some(state) = a.try_state::<Mutex<Words>>() {
            let mut w = state.lock().unwrap_or_else(|e| e.into_inner());
            let Words { vocab, saved, .. } = &mut *w;
            saved.tick(&vocab.data);
        }
    });
    // now and then a sleeping robot dreams of a word that's due
    let a = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(dreams::TICK_MS));
        dream_tick(&a);
    });
    // what's in sight moves on as words come due
    let a = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(HOUR as u64));
        count_changed(&a);
    });
}

fn dream_tick(app: &AppHandle) {
    let s = settings(app);
    let (t, local) = (now(), Local::now());
    let ok = dreams::enabled(&s) && dreams::in_hours(&s, local.hour(), local.minute());
    let ok = ok && dreams::present();
    let day = words::local_day(t);
    let Some(Some(not)) = words(app, |w| {
        let ok = ok && !w.asked;
        w.clock.may_dream(t, &day, ok)
    }) else {
        return;
    };
    let Some(word) = words(app, |w| w.vocab.next_dream(t, &not)).flatten() else { return }; // nothing due: look again soon
    let id = text(&word["id"]);
    if start_dream(app, Some(word), sleeping_robot(app)) {
        words(app, |w| w.clock.dreamt(t, &id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_trimmed() {
        assert_eq!(trim_edges("“meticulous,”"), "meticulous");
        assert_eq!(trim_edges("  (give up!)  "), "give up");
        assert_eq!(trim_edges("'tis"), "tis");
        assert_eq!(trim_edges("don't."), "don't");
        assert_eq!(trim_edges("...?"), "");
    }

    #[test]
    fn milestones_reached() {
        let s = json!({});
        assert!(milestones(&json!({ "learnt": 9, "streak": 2 }), &s).is_none());
        let (learnt, streak, save, unlocked) = milestones(&json!({ "learnt": 12, "streak": 3 }), &s).unwrap();
        assert_eq!((learnt, streak, unlocked), (10, 3, "gradcap"));
        assert_eq!(save["vocabMilestones"], json!({ "learnt": 10, "streak": 3 }));
        assert_eq!(save["vocabRewards"], json!({ "gradcap": true }));
        // already celebrated: only what's new, the cap only once
        let s = json!({ "vocabMilestones": { "learnt": 10, "streak": 3 }, "vocabRewards": { "gradcap": true, "other": 1 } });
        assert!(milestones(&json!({ "learnt": 24, "streak": 6 }), &s).is_none());
        let (learnt, streak, save, unlocked) = milestones(&json!({ "learnt": 30, "streak": 6 }), &s).unwrap();
        assert_eq!((learnt, streak, unlocked), (25, 0, ""));
        assert_eq!(save["vocabMilestones"], json!({ "learnt": 25, "streak": 3 }));
        assert!(save.get("vocabRewards").is_none());
        // a long way past several: the biggest
        let (_, streak, _, _) = milestones(&json!({ "learnt": 0, "streak": 40 }), &json!({})).unwrap();
        assert_eq!(streak, 30);
    }

    #[test]
    fn card_edits_cut_to_size() {
        let long = "x".repeat(500);
        let e = edits(&json!({ "senses": [{ "pos": "adj", "vi": long.clone(), "en": "careful" }], "tip": long, "phrases": [{}, {}, {}, {}, {}, {}, {}] }));
        assert_eq!(e["senses"][0]["vi"].as_str().unwrap().len(), 300);
        assert_eq!(e["tip"].as_str().unwrap().len(), 400);
        assert_eq!(e["phrases"].as_array().unwrap().len(), 6);
        assert!(e.get("examples").is_none());
        assert!(edits(&json!(null)).is_empty());
    }
}
