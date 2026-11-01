//! A robot's tabs: new, closed, reopened, renamed, moved, and switched to.

use super::*;

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

/// A tab dragged to another place in the strip (`to`: its index after the move).
#[tauri::command(async)]
pub fn robot_tab_move(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    to: usize,
) -> Result<(), Error> {
    let id = sender(&window)?;
    with(&app, |st| st.store.move_tab(&id, &tab_id, to));
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
