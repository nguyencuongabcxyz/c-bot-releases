//! What a robot window asks of main about itself: its robot, its window, its tabs and its
//! chat, a Tauri command each (gui/ipc/commands.ts calls them). The other robot_* commands
//! belong to the feature modules (features/vocab/mod.rs, walkers.rs, mcp/apps.rs…).

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::agents::personalities;
use crate::features::chat::{brief, side};
use crate::features::{chat, notes, vocab};
use crate::mcp::link;
use crate::robots;
use crate::robots::sender;
use crate::runtime::util::patch;
use crate::runtime::{Error, hub, with};
use crate::store;
use crate::workbench::{files, shell};

const TOO_MANY_TABS: &str = "That's the most tabs I can juggle!";

type Answer = Result<Value, Error>;

/// Everything the page needs on (re)load.
#[tauri::command(async)]
pub fn robot_init(app: AppHandle, window: WebviewWindow) -> Answer {
    let id = sender(&window)?;
    shell::close(&app, &id); // (a page loaded afresh has no drawer showing the old one)
    let (character, settings) = with(&app, |st| {
        (
            st.store.get(&id).map(|c| robots::view(st, c)),
            st.store.settings().clone(),
        )
    });
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
pub fn robot_expand(
    app: AppHandle,
    window: WebviewWindow,
    expanded: bool,
    opts: Option<Value>,
) -> Result<(), Error> {
    robots::expand(&app, &sender(&window)?, expanded, &opts.unwrap_or_default());
    Ok(())
}

/// Hidden at the screen's edge, peeking out, or back at its desk.
#[tauri::command(async)]
pub fn robot_peek(app: AppHandle, window: WebviewWindow, peek: bool) -> Result<(), Error> {
    robots::set_peek(&app, &sender(&window)?, peek);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_drag(app: AppHandle, window: WebviewWindow, step: Value) -> Result<(), Error> {
    robots::drag(&app, &sender(&window)?, &step);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_resize(app: AppHandle, window: WebviewWindow, step: Value) -> Result<(), Error> {
    robots::resize(&app, &sender(&window)?, &step);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_click_through(
    app: AppHandle,
    window: WebviewWindow,
    through: bool,
) -> Result<(), Error> {
    robots::click_through(&app, &sender(&window)?, through);
    Ok(())
}

/// Poked once more: how many times now.
#[tauri::command(async)]
pub fn robot_poke(app: AppHandle, window: WebviewWindow) -> Result<i64, Error> {
    let id = sender(&window)?;
    Ok(with(&app, |st| {
        let c = st.store.get(&id)?;
        let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
        let pokes = stats.get("pokes").and_then(Value::as_i64).unwrap_or(0) + 1;
        stats.insert("pokes".into(), json!(pokes));
        st.store
            .update(&id, patch(vec![("stats", Value::Object(stats))]));
        Some(pokes)
    })
    .unwrap_or(0))
}

#[tauri::command(async)]
pub fn robot_open_folder(app: AppHandle, window: WebviewWindow) -> Result<(), Error> {
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
    let fields = if temporary == Some(true) {
        patch(vec![("temporary", json!(true))])
    } else {
        Map::new()
    };
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
        return Ok(
            json!({ "ok": false, "error": "That conversation is open in the terminal. Close the terminal first." }),
        );
    }
    let closing = with(&app, |st| st.store.tab(&id, &tab_id).cloned());
    if closing.as_ref().is_some_and(|t| t["remote"] == true) {
        chat::remote(&app, &id, &tab_id, false); // (its remote session ends with it)
    }
    chat::close(&app, &id, &tab_id);
    shell::close_tab(&app, &id, &tab_id); // (its shells go with it)
    link::forget_tab(&app, &id, &tab_id);
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
        let any = st
            .store
            .get(&id)
            .and_then(|c| c["closedTabs"].as_array())
            .is_some_and(|t| !t.is_empty());
        (st.store.reopen_tab(&id, tab_id.as_deref()), any)
    });
    let Some(tab) = tab else {
        return Ok(
            json!({ "ok": false, "error": if any_closed { TOO_MANY_TABS } else { "No closed tabs to bring back." } }),
        );
    };
    robots::send_character(&app, &id);
    Ok(json!({ "ok": true, "tabId": tab["id"], "title": store::title_for(&tab) }))
}

#[tauri::command(async)]
pub fn robot_tab_rename(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    title: String,
) -> Result<(), Error> {
    let id = sender(&window)?;
    let title: String = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(40)
        .collect();
    with(&app, |st| {
        st.store
            .update_tab(&id, &tab_id, patch(vec![("title", json!(title))]))
    });
    robots::send_character(&app, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn robot_tab_activate(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
) -> Result<(), Error> {
    let id = sender(&window)?;
    with(&app, |st| {
        if st.store.tab(&id, &tab_id).is_some() {
            st.store
                .update(&id, patch(vec![("activeTab", json!(tab_id))]));
        }
    });
    Ok(())
}

/// A fresh conversation in that tab (none: every tab).
#[tauri::command(async)]
pub fn robot_reset(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: Option<String>,
) -> Result<(), Error> {
    reset(&app, &sender(&window)?, tab_id.as_deref());
    Ok(())
}

/// The slash commands Claude Code reported for its folder.
#[tauri::command(async)]
pub fn robot_commands(app: AppHandle, window: WebviewWindow) -> Answer {
    let id = sender(&window)?;
    Ok(with(&app, |st| {
        st.store
            .get(&id)
            .map(|c| c["claudeCommands"].clone())
            .filter(Value::is_array)
            .unwrap_or(json!([]))
    }))
}

// ---------------------------------------------------------------- the chat

/// A question from the page (robotAsk in gui/ipc/commands.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskArgs {
    prompt: String,
    #[serde(default)]
    attachments: Vec<String>,
    turn_id: Option<String>,
    kind: Option<chat::AskKind>, // (the page asks a chat or a bonk; compacting is robot_compact)
    tag: Option<String>,
    #[serde(default)]
    briefs: Vec<brief::Brief>, // (from other tabs, mentioned with @#: robot_tab_brief)
}

#[tauri::command(async)]
pub fn robot_ask(app: AppHandle, window: WebviewWindow, tab_id: String, ask: AskArgs) -> Answer {
    let attachments: Vec<Value> = ask.attachments.into_iter().map(Value::from).collect();
    let kind = match ask.kind {
        Some(chat::AskKind::Bonk) => chat::AskKind::Bonk,
        _ => chat::AskKind::Chat,
    };
    let turn_id = ask.turn_id.filter(|t| !t.is_empty());
    let ask = chat::Ask {
        prompt: ask.prompt.trim(),
        attachments: &attachments,
        turn_id,
        kind,
        tag: ask.tag.as_deref(),
        briefs: &ask.briefs,
    };
    Ok(chat::ask(&app, &sender(&window)?, &tab_id, ask))
}

#[tauri::command(async)]
pub fn robot_compact(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    turn_id: String,
) -> Answer {
    let ask = chat::Ask {
        prompt: "/compact",
        attachments: &[],
        turn_id: Some(turn_id),
        kind: chat::AskKind::Compact,
        tag: None,
        briefs: &[],
    };
    Ok(chat::ask(&app, &sender(&window)?, &tab_id, ask))
}

#[tauri::command(async)]
pub fn robot_cancel(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::cancel(&app, &sender(&window)?, &tab_id))
}

/// Remote Control on or off for the tab (claude.ai/code and the Claude app).
#[tauri::command(async)]
pub fn robot_remote(app: AppHandle, window: WebviewWindow, tab_id: String, on: bool) -> Answer {
    Ok(chat::remote(&app, &sender(&window)?, &tab_id, on))
}

#[tauri::command(async)]
pub fn robot_unqueue(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    turn_id: String,
) -> Result<bool, Error> {
    Ok(chat::unqueue(&app, &sender(&window)?, &tab_id, &turn_id))
}

#[tauri::command(async)]
pub fn robot_send_now(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    turn_id: String,
) -> Result<bool, Error> {
    Ok(chat::send_now(&app, &sender(&window)?, &tab_id, &turn_id))
}

#[tauri::command(async)]
pub fn robot_brain(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::brain(&app, &sender(&window)?, &tab_id))
}

#[tauri::command(async)]
pub fn robot_set_brain(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    patch: Value,
) -> Answer {
    Ok(chat::set_brain(&app, &sender(&window)?, &tab_id, &patch))
}

/// Your answer to Claude's question card.
#[tauri::command(async)]
pub fn robot_answer(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    request_id: String,
    answers: Value,
    items: Value,
) -> Result<bool, Error> {
    Ok(chat::answer(
        &app,
        &sender(&window)?,
        &tab_id,
        &request_id,
        &answers,
        &items,
    ))
}

/// Your call on Claude's plan card: go ahead in a permission mode (`mode`), or keep planning (no mode) with notes.
#[tauri::command(async)]
pub fn robot_plan(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    request_id: String,
    plan: String,
    mode: Option<String>,
    feedback: String,
) -> Answer {
    Ok(chat::decide_plan(
        &app,
        &sender(&window)?,
        &tab_id,
        &request_id,
        &plan,
        mode.as_deref(),
        &feedback,
    ))
}

/// Edit the last question: back to before it (its words come back, to edit and send again).
#[tauri::command(async)]
pub fn robot_rewind(app: AppHandle, window: WebviewWindow, tab_id: String) -> Answer {
    Ok(chat::rewind(&app, &sender(&window)?, &tab_id))
}

/// A side question about an answer (features/chat/side.rs): in a thread asked before, or a new one.
#[tauri::command(async)]
pub fn robot_side_ask(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    thread_id: Option<String>,
    at: Option<f64>,
    quote: Option<String>,
    text: String,
) -> Answer {
    let at = at.map(|a| a.round() as i64);
    Ok(side::ask(
        &app,
        &sender(&window)?,
        &tab_id,
        thread_id.as_deref(),
        at,
        quote.as_deref().unwrap_or(""),
        &text,
    ))
}

/// A brief from another tab for the one you're writing in (@#tab: features/chat/brief.rs).
/// Waits till that tab has written it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefArgs {
    from_tab_id: String,
    to_tab_id: String,
    draft: Option<String>,
}

#[tauri::command(async)]
pub fn robot_tab_brief(
    app: AppHandle,
    window: WebviewWindow,
    args: BriefArgs,
) -> Result<String, Error> {
    let id = sender(&window)?;
    brief::brief(
        &app,
        &id,
        &args.from_tab_id,
        &args.to_tab_id,
        args.draft.as_deref().unwrap_or(""),
    )
}

#[tauri::command(async)]
pub fn robot_side_cancel(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    thread_id: String,
) -> Result<bool, Error> {
    Ok(side::cancel(&app, &sender(&window)?, &tab_id, &thread_id))
}

#[tauri::command(async)]
pub fn robot_side_remove(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    thread_id: String,
) -> Result<bool, Error> {
    Ok(side::remove(&app, &sender(&window)?, &tab_id, &thread_id))
}

/// The side panel open beside the chat (its width, CSS px) or shut (0): the window makes room.
#[tauri::command(async)]
pub fn robot_side_width(app: AppHandle, window: WebviewWindow, width: f64) -> Result<(), Error> {
    robots::set_side_width(&app, &sender(&window)?, width);
    Ok(())
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
pub fn robot_resume(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    session_id: String,
) -> Answer {
    Ok(chat::resume(&app, &sender(&window)?, &tab_id, &session_id))
}

/// Past conversations thrown away (none named: every one it had), not ones open in a tab:
/// how many went.
#[tauri::command(async)]
pub fn robot_forget_sessions(
    app: AppHandle,
    window: WebviewWindow,
    session_ids: Option<Vec<String>>,
) -> Result<usize, Error> {
    chat::forget_sessions(&app, &sender(&window)?, session_ids)
}

// ---------------------------------------------------------------- files

/// @-mentions: files and folders in the robot's folder matching what's typed after @.
#[tauri::command(async)]
pub fn robot_files(app: AppHandle, window: WebviewWindow, query: String) -> Answer {
    let folder = folder_of(&app, &sender(&window)?);
    let query: String = query.chars().take(200).collect();
    Ok(
        if folder.is_empty() || !std::path::Path::new(&folder).exists() {
            json!([])
        } else {
            files::search(&folder, &query, 40)
        },
    )
}

/// Dropped or pasted files, with the previews for their chips.
#[tauri::command(async)]
pub fn robot_inspect_paths(paths: Vec<String>) -> Vec<Value> {
    paths
        .iter()
        .take(20)
        .filter_map(|p| crate::workbench::paste::inspect(p))
        .collect()
}

/// A pasted picture (the request's body, its extension in the `ext` header), saved with the
/// chat's attachments.
#[tauri::command(async)]
pub fn robot_save_paste(app: AppHandle, request: Request<'_>) -> Answer {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the picture's bytes".into());
    };
    if bytes.is_empty() || bytes.len() >= 25 * 1024 * 1024 {
        return Ok(Value::Null);
    }
    let ext = request
        .headers()
        .get("ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let dir = with(&app, |st| st.data_dir.join("attachments"));
    Ok(files::save_paste(&dir, bytes, ext)
        .map(crate::workbench::paste::with_thumb)
        .unwrap_or(Value::Null))
}

/// The composer's ＋: files (or pictures) picked in the open dialog, as chips to send.
#[tauri::command(async)]
pub fn robot_pick_files(
    app: AppHandle,
    window: WebviewWindow,
    pictures: Option<bool>,
) -> Result<Vec<Value>, Error> {
    let id = sender(&window)?;
    let folder = folder_of(&app, &id);
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(if pictures == Some(true) {
            "Pictures to show me"
        } else {
            "Files to show me"
        });
    if !folder.is_empty() {
        dialog = dialog.set_directory(&folder);
    }
    if pictures == Some(true) {
        dialog = dialog.add_filter(
            "Pictures",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        );
    }
    let picked = dialog.blocking_pick_files().unwrap_or_default();
    Ok(picked
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .take(20)
        .filter_map(|p| crate::workbench::paste::inspect(&p.to_string_lossy()))
        .collect())
}

/// How tall you made the chat (CSS px; none: the height of the screen).
#[tauri::command(async)]
pub fn robot_chat_height(
    app: AppHandle,
    window: WebviewWindow,
    height: Option<f64>,
) -> Result<(), Error> {
    let id = sender(&window)?;
    let h = height
        .filter(|h| h.is_finite() && *h >= 200.0)
        .map(|h| json!(h.round()))
        .unwrap_or(Value::Null);
    with(&app, |st| {
        st.store.update(&id, patch(vec![("chatHeight", h)]))
    });
    Ok(())
}

#[tauri::command(async)]
pub fn robot_open_file(file: String, opts: Option<Value>) -> Value {
    files::open_file(
        &file,
        opts.is_some_and(|o| o["reveal"].as_bool().unwrap_or(false)),
    )
}

/// A file or folder opened in the chat's file viewer (files::read_for_view).
#[tauri::command(async)]
pub fn robot_read_file(app: AppHandle, path: String) -> Value {
    files::read_for_view(&path, &crate::runtime::paths::picture_roots(&app))
}

pub fn folder_of(app: &AppHandle, id: &str) -> String {
    with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["folder"].as_str().map(str::to_string))
    })
    .unwrap_or_default()
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
        let tabs: Vec<String> = st
            .store
            .get(id)
            .and_then(|c| c["tabs"].as_array())
            .map(|t| {
                t.iter()
                    .filter_map(|t| t["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
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
        if with(app, |st| {
            st.store.tab(id, t).is_some_and(|x| x["remote"] == true)
        }) {
            chat::remote(app, id, t, false); // (a fresh start: not on claude.ai any more)
        }
        chat::close(app, id, t);
        let sides = with(app, |st| st.store.tab(id, t).map(side::sessions_of)).unwrap_or_default();
        side::forget(app, id, sides); // (its side questions start over too)
        let fresh = patch(vec![
            ("sessionId", Value::Null),
            ("history", json!([])),
            ("title", json!("")),
            ("tasks", json!([])),
            ("context", Value::Null),
            ("sides", json!([])),
        ]);
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
