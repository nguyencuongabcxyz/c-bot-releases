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
mod catch;
mod commands;
mod dreams;
mod lookup;
mod words;

pub use commands::*;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use chrono::{Local, Timelike};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::platform::window;
use crate::platform::window::Rect;
use crate::robots;
use crate::robots::{social, walkers};
use crate::runtime::{hub, with};
use crate::runtime::hub::Hotkey;
use crate::runtime::util::{only, patch, text};
use crate::store::saved::Saved;
use crate::ui::{tray, views};
use crate::workbench::{capture, snip};

use card::Spot;
use catch::*;
use dreams::DreamClock;
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
/// With none out on the desk, one away on the robot island (it asks from there).
fn free_robot(app: &AppHandle) -> Option<String> {
    let free = |id: &str| robots::is_showing(app, id) && !walkers::has(app, id) && !hub::robot_busy(app, id);
    let tutor = settings(app)["vocabTutor"].as_str().unwrap_or("").to_string();
    if !tutor.is_empty() && free(&tutor) {
        return Some(tutor);
    }
    let cursor = window::cursor();
    robots::open_ids(app)
        .into_iter()
        .filter(|id| free(id))
        .filter_map(|id| Some((distance(window::window_rect(robots::hwnd_of(app, &id)?), cursor), id)))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
        .or_else(|| away_robot(app, &tutor))
}

/// A robot away on the robot island and not at work: the tutor if it is, else the first.
fn away_robot(app: &AppHandle, tutor: &str) -> Option<String> {
    let ok = |id: &str| robots::is_away(app, id) && !hub::robot_busy(app, id);
    if !tutor.is_empty() && ok(tutor) {
        return Some(tutor.to_string());
    }
    robots::open_ids(app).into_iter().find(|id| ok(id))
}

/// A robot that's asleep, at its desk or sleepwalking round the screen: the tutor if it is,
/// else the one nearest the mouse.
fn sleeping_robot(app: &AppHandle) -> Option<String> {
    let asleep = |id: &str| {
        if robots::hwnd_of(app, id).is_none() || hub::robot_busy(app, id) {
            return false;
        }
        if walkers::has(app, id) {
            return walkers::is_sleepwalking(app, id);
        }
        robots::is_showing(app, id) && !robots::is_awake(app, id)
    };
    let tutor = settings(app)["vocabTutor"].as_str().unwrap_or("").to_string();
    if !tutor.is_empty() && asleep(&tutor) {
        return Some(tutor);
    }
    let cursor = window::cursor();
    robots::open_ids(app)
        .into_iter()
        .filter(|id| asleep(id))
        .map(|id| (hub::robot_rect(app, &id).map_or(f64::INFINITY, |r| distance(r, cursor)), id))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
        .or_else(|| away_robot(app, &tutor)) // (all away on the island: it dreams from there)
}

/// Where a card goes for this robot: as big as its chat (card.rs chat_bounds), beside its
/// desk, or beside the robot island it's away on (as big all the same: the full card).
fn card_bounds(app: &AppHandle, id: Option<&str>) -> Option<Rect> {
    let id = id?;
    let away = robots::is_away(app, id).then(|| crate::robots::island::strip_rect(app)).flatten();
    let desk = away.or_else(|| robots::desk_rect(app, id))?;
    let chat_open = away.is_none() && with(app, |st| st.robots.get(id).is_some_and(|r| r.expanded));
    let m = window::monitor_near(desk.x + desk.w / 2, desk.y + desk.h / 2);
    Some(card::chat_bounds(desk, m.work, m.scale, chat_open))
}

/// A word on the card, as big as this robot's chat (a new word takes over a quiz card).
fn show_card(app: &AppHandle, word: Value, robot: Option<String>) {
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let spot = card_spot(app, robot.as_deref());
    let paint = color_of(app, robot.as_deref());
    card::open(app, word, robot, paint, spot);
}

/// Where a card for this robot goes: chat-sized by its desk, or beside the island it's away
/// on (hub::robot_rect), or by the mouse.
fn card_spot(app: &AppHandle, robot: Option<&str>) -> Spot {
    card_bounds(app, robot).map_or_else(|| Spot::Near(robot.and_then(|r| hub::robot_rect(app, r))), Spot::Bounds)
}

/// A robot away on the island: the island says what it's showing you.
fn island_says(app: &AppHandle, robot: &str, kind: &str, word: &Value) {
    if robots::is_away(app, robot) {
        crate::robots::island::say(app, robot, kind, word["word"].as_str().unwrap_or(""), None);
    }
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
    island_says(app, &robot, "word", &seen);
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
    let spot = card_spot(app, Some(&robot));
    let paint = color_of(app, Some(&robot));
    island_says(app, &robot, "quiz", &word);
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
    crate::runtime::hub::hotkey_keys(app, "vocabHotkey", "Ctrl+Alt+W")
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

/// Your words, for a robot's chat (its list_words tool): the newest first, only those
/// matching query if there is one, at most limit.
pub fn list_for_chat(app: &AppHandle, query: &str, limit: usize) -> String {
    let Some((all, learnt)) = words(app, |w| {
        let all = w.vocab.list();
        let learnt = all.iter().filter(|x| x["status"] == "ready" && words::step_of(x) >= words::LEARNT_STEP).count();
        (all, learnt)
    }) else {
        return "Your word list isn't loaded yet.".into();
    };
    if all.is_empty() {
        return format!("You haven't saved any English words yet. Select one anywhere and press {} to catch it, or ask me to save it.", hotkey(app));
    }
    let found: Vec<&Value> = all.iter().filter(|w| words::matches(w, query)).collect();
    let q = query.trim();
    if found.is_empty() {
        return format!("None of your {} saved words matches \"{q}\".", all.len());
    }
    let shown: Vec<String> = found.iter().take(limit).map(|w| words::chat_line(w)).collect();
    let head = if q.is_empty() {
        format!("You have {} saved words ({learnt} learnt).", all.len())
    } else {
        format!("{} of your {} saved words match \"{q}\".", found.len(), all.len())
    };
    let more = if found.len() > shown.len() { format!("\n…and {} more (newest shown first).", found.len() - shown.len()) } else { String::new() };
    format!("{head}\n{}{more}", shown.join("\n"))
}

/// Words to save, asked for in a robot's chat (its save_words tool). One word is caught as
/// with the hotkey (the robot shows its card); several are looked up quietly, as a card's ＋
/// does. What happened to each, for the chat.
pub fn save_for_chat(app: &AppHandle, robot_id: &str, list: &[String], context: &str) -> String {
    const SOURCE: &str = "C-Bot chat";
    let wanted: Vec<String> = list.iter().map(|w| trim_edges(w).trim().to_string()).filter(|w| !w.is_empty()).collect();
    if wanted.is_empty() {
        return "There was no word to save.".into();
    }
    let too_long = |w: &str| w.encode_utf16().count() > 60 || w.split_whitespace().count() > 5;
    if let [one] = wanted.as_slice() {
        if too_long(one) {
            return format!("\"{one}\" is too long to save: a word or a short phrase (up to 5 words) only.");
        }
        let known = words(app, |w| w.vocab.find(one).is_some_and(|k| k["status"] == "ready")).unwrap_or(false);
        catch(app, one, SOURCE, Some(robot_id.to_string()), context);
        return if known {
            format!("\"{one}\" was already in your words: its card is up again, and it'll come up for review sooner.")
        } else {
            format!("Saved \"{one}\" to your words. Its meaning is being looked up now and will be on its card in a moment.")
        };
    }
    let t = now();
    let mut lines = vec![];
    let mut added = vec![];
    for one in wanted.iter().take(10) {
        if too_long(one) {
            lines.push(format!("- \"{one}\": too long (a word or a phrase of up to 5 words)"));
            continue;
        }
        let new = words(app, |w| if w.vocab.find(one).is_some() { None } else { Some(w.vocab.add(one, context, SOURCE, t)) }).flatten();
        match new {
            Some(word) => {
                added.push(text(&word["id"]));
                lines.push(format!("- \"{one}\": saved, being looked up"));
            }
            None => lines.push(format!("- \"{one}\": already in your words")),
        }
    }
    if wanted.len() > 10 {
        lines.push(format!("- (the other {} weren't saved: up to 10 at a time)", wanted.len() - 10));
    }
    if !added.is_empty() {
        count_changed(app);
    }
    for id in added {
        find_meaning(app, id, Some(robot_id.to_string()), true);
    }
    lines.join("\n")
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
