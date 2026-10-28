//! My words: the window that lists them all (search, edit, delete), and exporting them.

use super::*;

pub(super) fn open_words_window(app: &AppHandle) {
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.locked();
    if let Some(w) = app.get_webview_window(WORDS) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = views::builder(app, WORDS, "words", &[])
        .title("My words — C-Bot")
        .inner_size(560.0, 720.0)
        .min_inner_size(420.0, 420.0)
        .build();
    if let Err(err) = built {
        log::warn!("couldn't open My words: {err}");
    }
}

pub(super) fn words_list_of(app: &AppHandle) -> Value {
    let s = settings(app);
    let (rows, stats) = words(app, |w| {
        (
            w.vocab
                .list()
                .iter()
                .map(words::word_row)
                .collect::<Vec<_>>(),
            w.vocab.stats(now()),
        )
    })
    .unwrap_or_default();
    let hours = s["vocabHours"]
        .as_array()
        .filter(|h| h.len() == 2)
        .map_or(json!([9, 18]), |h| json!(h));
    json!({ "words": rows, "stats": stats, "hotkey": hotkey(app), "reminders": dreams::enabled(&s), "hours": hours })
}

/// Dreams on or off, and your working hours (from My words).
pub(super) fn words_settings_of(app: &AppHandle, p: &Value) -> Value {
    let mut out = Map::new();
    if let Some(on) = p["reminders"].as_bool() {
        out.insert("vocabReminders".into(), json!(on));
    }
    if let Some(h) = p["hours"].as_array() {
        let hours: Vec<i64> = h
            .iter()
            .filter_map(Value::as_i64)
            .filter(|x| (0..=24).contains(x))
            .collect();
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
pub(super) fn export(app: &AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;
    let name = format!(
        "my-english-words-{}.csv",
        chrono::Utc::now().format("%Y-%m-%d")
    );
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export my words")
        .set_file_name(&name)
        .add_filter("CSV (Anki, Quizlet, Excel)", &["csv"]);
    if let Ok(docs) = app.path().document_dir() {
        dialog = dialog.set_directory(docs);
    }
    if let Some(w) = app.get_webview_window(WORDS) {
        dialog = dialog.set_parent(&w);
    }
    let Some(path) = dialog.blocking_save_file().and_then(|f| f.into_path().ok()) else {
        return Value::Null;
    };
    let rows = words(app, |w| words::csv(&w.vocab.list())).unwrap_or_default();
    if let Err(err) = std::fs::write(&path, rows) {
        log::warn!("couldn't export: {err}");
        return Value::Null;
    }
    let _ = app.opener().reveal_item_in_dir(&path);
    json!(path.to_string_lossy())
}

pub(super) fn delete_word(app: &AppHandle, id: &str) -> Value {
    let ok = words(app, |w| w.vocab.remove(id)).unwrap_or(false);
    if ok {
        count_changed(app);
    }
    json!(ok)
}
