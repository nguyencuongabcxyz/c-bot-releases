//! Catching a word (selected anywhere, or read off a picture) and looking it up, and what the
//! word card's buttons do with it.

use super::*;

// ---------------------------------------------------------------- catching a word

/// Quotes and punctuation round a selection trimmed off ("meticulous," → meticulous).
pub(super) fn trim_edges(s: &str) -> &str {
    let lead = |c: char| c.is_whitespace() || "\"'“”‘’([{".contains(c);
    let trail = |c: char| c.is_whitespace() || "\"'“”‘’)]}.,;:!?".contains(c);
    s.trim_start_matches(lead).trim_end_matches(trail)
}

pub(super) fn catch(
    app: &AppHandle,
    raw: &str,
    source: &str,
    robot: Option<String>,
    context: &str,
) {
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
pub(super) enum Found {
    Gone,         // undone while it was looking
    Twin(Value),  // "ran" is "run": the one you already have
    Ready(Value), // looked up
}

/// Look it up (on a thread of its own). quiet: a word saved from a card's lists (＋): looked
/// up in the background, no show.
pub(super) fn find_meaning(app: &AppHandle, id: String, robot: Option<String>, quiet: bool) {
    let app = app.clone();
    thread::spawn(move || {
        let looking = patch(vec![("status", json!("looking")), ("error", json!(""))]);
        let Some(Some(word)) = words(&app, |w| w.vocab.update(&id, looking)) else {
            return;
        };
        card::update(&app, &word);
        let claude_path = settings(&app)["claudePath"]
            .as_str()
            .unwrap_or("")
            .to_string();
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
                    let twin = w
                        .vocab
                        .find(found["word"].as_str().unwrap_or(""))
                        .filter(|t| t["id"] != id.as_str() && t["status"] == "ready")
                        .cloned();
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
                    let gone: &[&str] = if extras_failed {
                        &["usage", "synonyms"]
                    } else {
                        &["usage"]
                    };
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
                    tell(
                        &app,
                        r,
                        json!({ "phase": "failed", "word": failed, "error": err }),
                    );
                }
            }
        }
        count_changed(&app);
    });
}

/// Drag a box round a word on screen, for this robot. False if the box couldn't start.
pub(super) fn box_for(app: &AppHandle, robot: Option<String>, source: String) -> bool {
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
pub(super) fn read_boxed(app: &AppHandle, robot: Option<String>, source: String, png: Vec<u8>) {
    let app = app.clone();
    thread::spawn(move || {
        tell(&app, robot.as_deref(), json!({ "phase": "reading" }));
        let claude_path = settings(&app)["claudePath"]
            .as_str()
            .unwrap_or("")
            .to_string();
        match lookup::read_picture(&png, &claude_path) {
            Ok((found, _)) if found.is_empty() => {
                tell(&app, robot.as_deref(), json!({ "phase": "unreadable" }))
            }
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
pub(super) fn capture_word(app: &AppHandle) {
    let sel = capture::read_selection(app, &hotkey(app), false);
    let robot = hub::nearest_robot(app);
    if !sel.text.is_empty() {
        catch(app, &sel.text, &sel.source, robot, "");
    } else {
        box_for(app, robot, sel.source);
    }
}

/// A saved word's card again (a sticky note on a monitor, the My words window).
pub(super) fn open_word(app: &AppHandle, id: &str, robot: Option<String>) -> bool {
    if get(app, id).is_none() {
        return false;
    }
    if words(app, |w| w.quizzing.is_some()) == Some(true) {
        end_quiz(app, "ignored");
    }
    let Some(Some(w)) = words(app, |w| {
        w.vocab
            .update(id, patch(vec![("lastSeenAt", json!(now()))]))
    }) else {
        return false;
    };
    let spot = card_bounds(app, robot.as_deref()).map_or(Spot::Near(None), Spot::Bounds);
    let paint = color_of(app, robot.as_deref());
    card::open(app, flagged(w, &["known"]), robot, paint, spot);
    true
}

// ---------------------------------------------------------------- the card's buttons

/// What you change on the card (✏️ Edit, then Save), cut to size.
pub(super) fn edits(p: &Value) -> Map<String, Value> {
    let cut = |v: &Value, n: usize| text(v).chars().take(n).collect::<String>();
    let mut out = Map::new();
    if let Some(senses) = p["senses"].as_array() {
        let s: Vec<Value> = senses.iter().take(5).map(|x| json!({ "pos": text(&x["pos"]), "vi": cut(&x["vi"], 300), "en": cut(&x["en"], 300) })).collect();
        out.insert("senses".into(), json!(s));
    }
    if let Some(examples) = p["examples"].as_array() {
        let e: Vec<Value> = examples
            .iter()
            .take(6)
            .map(|e| json!({ "en": cut(&e["en"], 400), "vi": cut(&e["vi"], 400) }))
            .collect();
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
        out.insert(
            "tip".into(),
            json!(tip.chars().take(400).collect::<String>()),
        );
    }
    out
}

pub(super) fn on_card(app: &AppHandle, action: &str, payload: &Value) -> Value {
    let Some(shown) = card::shown(app) else {
        return Value::Null;
    };
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
                let spot =
                    card_bounds(app, robot.as_deref()).map_or(Spot::Near(None), Spot::Bounds);
                let paint = color_of(app, robot.as_deref());
                card::open(app, flagged(w, &["known"]), robot, paint, spot);
            }
            json!(true)
        }
        "know" => {
            let w = words(app, |w| w.vocab.know_it(&id, t)).flatten();
            if let Some(w) = &w {
                tell(
                    app,
                    robot.as_deref(),
                    json!({ "phase": "knowit", "word": w }),
                );
            }
            count_changed(app);
            card::close_after(app, 900);
            w.map_or(Value::Null, |w| json!({ "review": w["review"] }))
        }
        // the quiz card: ✓ Knew it / ✗ Forgot / ⏰ Later, or left unanswered
        "quiz" => {
            if words(app, |w| {
                w.quizzing.as_ref().is_some_and(|q| q.word_id == id)
            }) != Some(true)
            {
                return Value::Null;
            }
            let how = payload
                .as_str()
                .filter(|h| ["knew", "forgot", "later", "ignored"].contains(h))
                .unwrap_or("ignored");
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
            let with = shown.word["word"]
                .as_str()
                .filter(|w| !w.is_empty())
                .or(shown.word["text"].as_str())
                .unwrap_or("")
                .to_string();
            let added = words(app, |w| {
                if new.is_empty() || w.vocab.find(&new).is_some() {
                    return None;
                }
                Some(w.vocab.add(&new, "", &format!("with “{with}”"), t))
            });
            let Some(Some(added)) = added else {
                return json!(false);
            };
            find_meaning(
                app,
                added["id"].as_str().unwrap_or("").to_string(),
                robot,
                true,
            );
            json!(true)
        }
        "undo" => {
            words(app, |w| w.vocab.remove(&id));
            tell(
                app,
                robot.as_deref(),
                json!({ "phase": "undone", "word": shown.word }),
            );
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
            tell(
                app,
                robot.as_deref(),
                json!({ "phase": "ask", "word": word }),
            );
            card::close(app);
            json!(true)
        }
        _ => Value::Null,
    }
}
