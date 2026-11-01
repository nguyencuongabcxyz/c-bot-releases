//! What the robots' pages ask of a shared chat: the host's share card and suggestion cards,
//! and the visiting robot's suggestions. Each checks which end its robot is at.

use serde::Deserialize;
use tauri::WebviewWindow;

use super::*;
use crate::robots::sender;
use crate::runtime::Error;

fn hosting(app: &AppHandle, window: &WebviewWindow) -> Result<String, Error> {
    let id = sender(window)?;
    if shares(app, |s| s.host.as_ref().is_some_and(|h| h.robot == id)) {
        Ok(id)
    } else {
        Err("This robot isn't sharing a tab.".into())
    }
}

fn visiting(app: &AppHandle, window: &WebviewWindow) -> Result<String, Error> {
    let id = sender(window)?;
    if shares(app, |s| s.visits.contains_key(&id)) {
        Ok(id)
    } else {
        Err("The shared chat has ended.".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    tab_id: String,
    from_now: bool,
    tool_output: bool,
    internet: bool,
}

/// Share one of this robot's tabs: on the office network, or over the internet.
#[tauri::command(async)]
pub fn share_start(
    app: AppHandle,
    window: WebviewWindow,
    args: StartArgs,
) -> Result<ShareView, Error> {
    let id = sender(&window)?;
    let o = host::Opts {
        from_now: args.from_now,
        tool_output: args.tool_output,
        internet: args.internet,
    };
    host::start(&app, &id, &args.tab_id, &o)
}

/// A new invite link (for one person, once).
#[tauri::command(async)]
pub fn share_invite(app: AppHandle, window: WebviewWindow) -> Result<String, Error> {
    let id = hosting(&app, &window)?;
    host::invite(&app, &id)
}

/// Let someone in, or not.
#[tauri::command(async)]
pub fn share_admit(
    app: AppHandle,
    window: WebviewWindow,
    conn: u64,
    yes: bool,
) -> Result<(), Error> {
    hosting(&app, &window)?;
    host::admit(&app, conn, yes);
    Ok(())
}

/// What became of a suggestion (sent, taken to edit, declined).
#[tauri::command(async)]
pub fn share_answer(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    state: Suggestion,
) -> Result<(), Error> {
    hosting(&app, &window)?;
    host::answer(&app, &id, state);
    Ok(())
}

#[tauri::command(async)]
pub fn share_stop(app: AppHandle, window: WebviewWindow) -> Result<(), Error> {
    hosting(&app, &window)?;
    host::stop(&app, &format!("{} stopped sharing.", me().name));
    Ok(())
}

/// A suggestion from the visiting robot's chat. Its id.
#[tauri::command(async)]
pub fn share_suggest(app: AppHandle, window: WebviewWindow, text: String) -> Result<String, Error> {
    let id = visiting(&app, &window)?;
    guest::suggest(&app, &id, &text)
}

#[tauri::command(async)]
pub fn share_take_back(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), Error> {
    let robot = visiting(&app, &window)?;
    guest::take_back(&app, &robot, &id);
    Ok(())
}

#[tauri::command(async)]
pub fn share_leave(app: AppHandle, window: WebviewWindow) -> Result<(), Error> {
    let id = visiting(&app, &window)?;
    guest::leave(&app, &id);
    Ok(())
}

/// Say something to the people in the shared chat (not to Claude): the host or a visitor.
#[tauri::command(async)]
pub fn share_talk(app: AppHandle, window: WebviewWindow, text: String) -> Result<(), Error> {
    let id = sender(&window)?;
    if shares(&app, |s| s.host.as_ref().is_some_and(|h| h.robot == id)) {
        return host::host_talk(&app, &id, &text);
    }
    let id = visiting(&app, &window)?;
    guest::to_host(&app, &id, &wire::Msg::Talk { text })
}

/// A visitor's comment on a piece of the chat (what they selected).
#[tauri::command(async)]
pub fn share_comment(
    app: AppHandle,
    window: WebviewWindow,
    quote: String,
    text: String,
) -> Result<(), Error> {
    let id = visiting(&app, &window)?;
    guest::to_host(&app, &id, &wire::Msg::Comment { quote, text })
}

/// A visitor's recommendation on a plan or a question waiting for the host.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendArgs {
    request_id: String,
    choice: String,
    why: Option<String>,
}

#[tauri::command(async)]
pub fn share_recommend(
    app: AppHandle,
    window: WebviewWindow,
    args: RecommendArgs,
) -> Result<(), Error> {
    let id = visiting(&app, &window)?;
    let m = wire::Msg::Recommend {
        request_id: args.request_id,
        choice: args.choice,
        why: args.why.unwrap_or_default(),
    };
    guest::to_host(&app, &id, &m)
}

/// The tray's "Join a shared chat": with the invite link you copied.
pub fn join_copied(app: &AppHandle) {
    let text = crate::platform::clipboard::text();
    if let Err(e) = guest::join(app, &text) {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .message(format!(
                "{e}\n\nCopy the invite link you were sent, then pick this again."
            ))
            .title("Shared chat")
            .show(|_| {});
    }
}
