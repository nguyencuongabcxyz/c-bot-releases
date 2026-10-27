//! The words' commands: a robot's page, the word card and the My words window ask these.

use super::*;

// ---------------------------------------------------------------- commands

pub(super) fn sender_of(window: &tauri::WebviewWindow) -> Option<String> {
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
pub(super) fn flush(app: &AppHandle) {
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
    saved.import(crate::runtime::paths::electron_data_dir());
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

pub(super) fn dream_tick(app: &AppHandle) {
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
