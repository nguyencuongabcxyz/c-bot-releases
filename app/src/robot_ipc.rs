//! What a robot window asks of main about itself: its robot, its window, its tabs and its
//! chat, a Tauri command each (gui/ipc/commands.ts calls them). The other robot_* commands
//! belong to the feature modules (vocab.rs, walkers.rs, mcp_apps.rs…).

use serde_json::{json, Map, Value};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::robots::sender;
use crate::util::patch;
use crate::{chat, files, hub, notes, personalities, robots, store, vocab, with};

const TOO_MANY_TABS: &str = "That's the most tabs I can juggle!";

type Answer = Result<Value, String>;

/// Everything the page needs on (re)load.
#[tauri::command(async)]
pub fn robot_init(app: AppHandle, window: WebviewWindow) -> Answer {
    let id = sender(&window)?;
    let (character, settings) = with(&app, |st| (st.store.get(&id).map(|c| robots::view(st, c)), st.store.settings().clone()));
    Ok(json!({
        "character": character,
        "personalities": personalities::public(),
        "settings": settings,
        "user": std::env::var("USERNAME").unwrap_or_else(|_| "friend".into()),
        "vocabCount": vocab::count(&app),
        "vocabSight": vocab::sight(&app),
        "vocabHotkey": vocab::hotkey(&app),
        "notesBoard": notes::board_for(&app, &id),
        "noteHotkey": notes::hotkey(&app),
        "hush": hub::hush(&app),
    }))
}

// ---------------------------------------------------------------- its window

#[tauri::command(async)]
pub fn robot_expand(app: AppHandle, window: WebviewWindow, expanded: bool, opts: Option<Value>) -> Result<(), String> {
    robots::expand(&app, &sender(&window)?, expanded, &opts.unwrap_or_default());
    Ok(())
}

/// Hidden at the screen's edge, peeking out, or back at its desk.
#[tauri::command(async)]
pub fn robot_peek(app: AppHandle, window: WebviewWindow, peek: bool) -> Result<(), String> {
    robots::set_peek(&app, &sender(&window)?, peek);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_drag(app: AppHandle, window: WebviewWindow, step: Value) -> Result<(), String> {
    robots::drag(&app, &sender(&window)?, &step);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_resize(app: AppHandle, window: WebviewWindow, step: Value) -> Result<(), String> {
    robots::resize(&app, &sender(&window)?, &step);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_click_through(app: AppHandle, window: WebviewWindow, through: bool) -> Result<(), String> {
    robots::click_through(&app, &sender(&window)?, through);
    Ok(())
}

/// Poked once more: how many times now.
#[tauri::command(async)]
pub fn robot_poke(app: AppHandle, window: WebviewWindow) -> Result<i64, String> {
    let id = sender(&window)?;
    Ok(with(&app, |st| {
        let c = st.store.get(&id)?;
        let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
        let pokes = stats.get("pokes").and_then(Value::as_i64).unwrap_or(0) + 1;
        stats.insert("pokes".into(), json!(pokes));
        st.store.update(&id, patch(vec![("stats", Value::Object(stats))]));
        Some(pokes)
    })
    .unwrap_or(0))
}

#[tauri::command(async)]
pub fn robot_open_folder(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    open_folder(&app, &sender(&window)?);
    Ok(())
}

/// A link an MCP tool's view asked to open: only a web link is.
#[tauri::command(async)]
pub fn robot_open_link(app: AppHandle, url: Option<String>) {
    let url = url.unwrap_or_default();
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------------------------------------------------------------- its tabs

/// A new tab; a temporary one keeps nothing (it and its transcripts go when it closes, and it's
/// never among the past conversations).
#[tauri::command(async)]
pub fn robot_tab_new(app: AppHandle, window: WebviewWindow, temporary: Option<bool>) -> Answer {
    let id = sender(&window)?;
    let fields = if temporary == Some(true) { patch(vec![("temporary", json!(true))]) } else { Map::new() };
    let tab = with(&app, |st| st.store.add_tab(&id, fields));
    Ok(match tab {
        Some(tab) => {
            robots::send_character(&app, &id);
            json!({ "ok": true, "tabId": tab["id"] })
        }
        None => json!({ "ok": false, "error": TOO_MANY_TABS }),
    })
}

#[tauri::command(async)]
pub fn robot_tab_close(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    let id = sender(&window)?;
    if with(&app, |st| st.terminals.get(&id) == Some(&tab_id)) {
        return Ok(json!({ "ok": false, "error": "That conversation is open in the terminal. Close the terminal first." }));
    }
    let closing = with(&app, |st| st.store.tab(&id, &tab_id).cloned());
    chat::close(&app, &id, &tab_id);
    if let Some(tab) = closing.filter(|t| t["temporary"] == true) {
        chat::erase_temporary(&app, &id, &tab);
    }
    let active = with(&app, |st| {
        st.store.remove_tab(&id, &tab_id);
        st.store.get(&id).map(|c| c["activeTab"].clone())
    });
    robots::send_character(&app, &id);
    Ok(json!({ "ok": true, "activeTab": active }))
}

/// Bring back a closed tab: that one, or the last closed.
#[tauri::command(async)]
pub fn robot_tab_reopen(app: AppHandle, window: WebviewWindow, tab_id: Option<String>) -> Answer {
    let id = sender(&window)?;
    let (tab, any_closed) = with(&app, |st| {
        let any = st.store.get(&id).and_then(|c| c["closedTabs"].as_array()).is_some_and(|t| !t.is_empty());
        (st.store.reopen_tab(&id, tab_id.as_deref()), any)
    });
    let Some(tab) = tab else {
        return Ok(json!({ "ok": false, "error": if any_closed { TOO_MANY_TABS } else { "No closed tabs to bring back." } }));
    };
    robots::send_character(&app, &id);
    Ok(json!({ "ok": true, "tabId": tab["id"], "title": store::title_for(&tab) }))
}

#[tauri::command(async)]
pub fn robot_tab_rename(app: AppHandle, window: WebviewWindow, tab_id: String, title: String) -> Result<(), String> {
    let id = sender(&window)?;
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect();
    with(&app, |st| st.store.update_tab(&id, &tab_id, patch(vec![("title", json!(title))])));
    robots::send_character(&app, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_tab_activate(app: AppHandle, window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let id = sender(&window)?;
    with(&app, |st| {
        if st.store.tab(&id, &tab_id).is_some() {
            st.store.update(&id, patch(vec![("activeTab", json!(tab_id))]));
        }
    });
    Ok(())
}

/// A fresh conversation in that tab (none: every tab).
#[tauri::command(async)]
pub fn robot_reset(app: AppHandle, window: WebviewWindow, tab_id: Option<String>) -> Result<(), String> {
    reset(&app, &sender(&window)?, tab_id.as_deref());
    Ok(())
}

/// The slash commands Claude Code reported for its folder.
#[tauri::command(async)]
pub fn robot_commands(app: AppHandle, window: WebviewWindow) -> Answer {
    let id = sender(&window)?;
    Ok(with(&app, |st| st.store.get(&id).map(|c| c["claudeCommands"].clone()).filter(Value::is_array).unwrap_or(json!([]))))
}

// ---------------------------------------------------------------- the chat

#[tauri::command(async)]
pub fn robot_ask(app: AppHandle, window: WebviewWindow, tab_id: String, prompt: String, attachments: Vec<String>, turn_id: Option<String>, kind: Option<String>) -> Answer {
    let attachments: Vec<Value> = attachments.into_iter().map(Value::from).collect();
    let turn_id = turn_id.filter(|t| !t.is_empty());
    let kind = if kind.as_deref() == Some("bonk") { "bonk" } else { "chat" };
    Ok(chat::ask(&app, &sender(&window)?, &tab_id, prompt.trim(), &attachments, turn_id, kind))
}

#[tauri::command(async)]
pub fn robot_compact(app: AppHandle, window: WebviewWindow, tab_id: String, turn_id: String) -> Answer {
    Ok(chat::ask(&app, &sender(&window)?, &tab_id, "/compact", &[], Some(turn_id), "compact"))
}

#[tauri::command(async)]
pub fn robot_cancel(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::cancel(&app, &sender(&window)?, &tab_id))
}

#[tauri::command(async)]
pub fn robot_unqueue(app: AppHandle, window: WebviewWindow, tab_id: String, turn_id: String) -> Result<bool, String> {
    Ok(chat::unqueue(&app, &sender(&window)?, &tab_id, &turn_id))
}

#[tauri::command(async)]
pub fn robot_send_now(app: AppHandle, window: WebviewWindow, tab_id: String, turn_id: String) -> Result<bool, String> {
    Ok(chat::send_now(&app, &sender(&window)?, &tab_id, &turn_id))
}

#[tauri::command(async)]
pub fn robot_brain(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::brain(&app, &sender(&window)?, &tab_id))
}

#[tauri::command(async)]
pub fn robot_set_brain(app: AppHandle, window: WebviewWindow, tab_id: String, patch: Value) -> Answer {
    Ok(chat::set_brain(&app, &sender(&window)?, &tab_id, &patch))
}

/// Your answer to Claude's question card.
#[tauri::command(async)]
pub fn robot_answer(app: AppHandle, window: WebviewWindow, tab_id: String, request_id: String, answers: Value, items: Value) -> Result<bool, String> {
    Ok(chat::answer(&app, &sender(&window)?, &tab_id, &request_id, &answers, &items))
}

/// Edit the last question: back to before it (its words come back, to edit and send again).
#[tauri::command(async)]
pub fn robot_rewind(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::rewind(&app, &sender(&window)?, &tab_id))
}

/// Past conversations in its folder.
#[tauri::command(async)]
pub fn robot_sessions(app: AppHandle, window: WebviewWindow) -> Answer {
    Ok(chat::sessions(&app, &sender(&window)?))
}

#[tauri::command(async)]
pub fn robot_session(app: AppHandle, window: WebviewWindow, session_id: String) -> Answer {
    Ok(chat::session(&app, &sender(&window)?, &session_id))
}

#[tauri::command(async)]
pub fn robot_resume(app: AppHandle, window: WebviewWindow, tab_id: String, session_id: String) -> Answer {
    Ok(chat::resume(&app, &sender(&window)?, &tab_id, &session_id))
}

// ---------------------------------------------------------------- files

/// @-mentions: files and folders in the robot's folder matching what's typed after @.
#[tauri::command(async)]
pub fn robot_files(app: AppHandle, window: WebviewWindow, query: String) -> Answer {
    let folder = folder_of(&app, &sender(&window)?);
    let query: String = query.chars().take(200).collect();
    Ok(if folder.is_empty() || !std::path::Path::new(&folder).exists() { json!([]) } else { files::search(&folder, &query, 40) })
}

/// Dropped or pasted files, with the previews for their chips.
#[tauri::command(async)]
pub fn robot_inspect_paths(paths: Vec<String>) -> Vec<Value> {
    paths.iter().take(20).filter_map(|p| crate::clipboard::inspect(p)).collect()
}

/// A pasted picture (the request's body, its extension in the `ext` header), saved with the
/// chat's attachments.
#[tauri::command(async)]
pub fn robot_save_paste(app: AppHandle, request: Request<'_>) -> Answer {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected the picture's bytes".into()) };
    if bytes.is_empty() || bytes.len() >= 25 * 1024 * 1024 {
        return Ok(Value::Null);
    }
    let ext = request.headers().get("ext").and_then(|v| v.to_str().ok()).unwrap_or("");
    let dir = with(&app, |st| st.data_dir.join("attachments"));
    Ok(files::save_paste(&dir, bytes, ext).map(crate::clipboard::with_thumb).unwrap_or(Value::Null))
}

/// The composer's ＋: files (or pictures) picked in the open dialog, as chips to send.
#[tauri::command(async)]
pub fn robot_pick_files(app: AppHandle, window: WebviewWindow, pictures: Option<bool>) -> Result<Vec<Value>, String> {
    let id = sender(&window)?;
    let folder = folder_of(&app, &id);
    let mut dialog = app.dialog().file().set_parent(&window).set_title(if pictures == Some(true) { "Pictures to show me" } else { "Files to show me" });
    if !folder.is_empty() {
        dialog = dialog.set_directory(&folder);
    }
    if pictures == Some(true) {
        dialog = dialog.add_filter("Pictures", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
    }
    let picked = dialog.blocking_pick_files().unwrap_or_default();
    Ok(picked.into_iter().filter_map(|f| f.into_path().ok()).take(20).filter_map(|p| crate::clipboard::inspect(&p.to_string_lossy())).collect())
}

/// How tall you made the chat (CSS px; none: the height of the screen).
#[tauri::command(async)]
pub fn robot_chat_height(app: AppHandle, window: WebviewWindow, height: Option<f64>) -> Result<(), String> {
    let id = sender(&window)?;
    let h = height.filter(|h| h.is_finite() && *h >= 200.0).map(|h| json!(h.round())).unwrap_or(Value::Null);
    with(&app, |st| st.store.update(&id, patch(vec![("chatHeight", h)])));
    Ok(())
}

#[tauri::command(async)]
pub fn robot_open_file(file: String, opts: Option<Value>) -> Value {
    files::open_file(&file, opts.is_some_and(|o| o["reveal"].as_bool().unwrap_or(false)))
}

pub fn folder_of(app: &AppHandle, id: &str) -> String {
    with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default()
}

pub fn open_folder(app: &AppHandle, id: &str) {
    let folder = folder_of(app, id);
    if !folder.is_empty() {
        let _ = app.opener().open_path(folder, None::<&str>);
    }
}

/// Clear one tab (or, with no tab, every tab: the Workshop's "forget") back to a fresh
/// conversation (main.js resetConversation).
pub fn reset(app: &AppHandle, id: &str, tab_id: Option<&str>) {
    let (tabs, term) = with(app, |st| {
        let tabs: Vec<String> = st.store.get(id).and_then(|c| c["tabs"].as_array()).map(|t| t.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        (tabs, st.terminals.get(id).cloned())
    });
    if tab_id.is_some() && term.as_deref() == tab_id {
        return;
    }
    let chosen: Vec<String> = match tab_id {
        Some(t) => tabs.iter().filter(|x| x.as_str() == t).cloned().collect(),
        None => tabs.clone(),
    };
    for t in &chosen {
        chat::close(app, id, t);
        let fresh = patch(vec![("sessionId", Value::Null), ("history", json!([])), ("title", json!("")), ("tasks", json!([])), ("context", Value::Null)]);
        with(app, |st| st.store.update_tab(id, t, fresh));
    }
    if tab_id.is_none() {
        // the Workshop's "forget": back to a single empty tab
        with(app, |st| {
            for t in tabs.iter().skip(1) {
                if st.terminals.get(id) != Some(t) {
                    st.store.remove_tab(id, t);
                }
            }
        });
    }
    robots::send_character(app, id);
}
