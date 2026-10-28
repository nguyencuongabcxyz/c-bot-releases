//! A robot's right-click menu (main.js robot:menu): only what has no quicker way. Out for a
//! walk, no group chat.

use super::*;

/// A robot was right-clicked: its menu, by the mouse (state: is it out walking?).
#[tauri::command(async)]
pub fn robot_menu(app: AppHandle, window: tauri::WebviewWindow, state: Value) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    let away = state["away"].as_bool().unwrap_or(false);
    match robot_menu_of(&app, &id, away) {
        Ok(Some(menu)) => {
            let _ = window.popup_menu(&menu);
        }
        Ok(None) => {}
        Err(err) => log::warn!("couldn't build {id}'s menu: {err}"),
    }
    Ok(())
}

/// An item's id in this robot's menu.
fn act(id: &str, action: &str) -> String {
    format!("robot|{id}|{action}")
}

/// Only what has no quicker way (a click, a button, a hotkey, the action menu).
fn robot_menu_of(app: &AppHandle, id: &str, away: bool) -> tauri::Result<Option<Menu<Wry>>> {
    let Some((c, visible)) = with(app, |st| {
        Some((st.store.get(id)?.clone(), visible_count(st.store.list())))
    }) else {
        return Ok(None);
    };
    let s = settings(app);
    let name = c["name"].as_str().unwrap_or("Robo");
    let mut items = if away {
        vec![note(app, &format!("{name} is out for a walk"))]
    } else {
        let folder = c.folder();
        let base = folder
            .rsplit(['\\', '/'])
            .find(|s| !s.is_empty())
            .unwrap_or(folder);
        vec![note(app, &format!("{name} — {base}"))]
    };
    items.push(separator(app));
    if !away {
        items.push(item(
            app,
            act(id, "groupchat"),
            if group::in_chat(app, id) {
                "👥 Group chat (in it now)…"
            } else {
                "👥 Start a group chat…"
            },
            visible >= 2,
        ));
    }
    items.push(notes_menu(app, id, &s));
    items.push(item(app, act(id, "routines"), "⏰ Routines…", true));
    items.push(words_menu(app, id, &s));
    items.push(separator(app));
    items.push(settings_menu(app, id, &c));
    items.push(item(app, act(id, "hide"), "🙈 Put away (hide)", true));
    build_menu(app, items).map(Some)
}

fn notes_menu(app: &AppHandle, id: &str, s: &Value) -> Item {
    sub(
        app,
        &notes_title(app),
        vec![
            item(app, act(id, "notebook"), "📒 Open my notebook…", true),
            item(app, act(id, "note"), "📝 Take a note…", true),
            separator(app),
            check(
                app,
                act(id, "notes-robot"),
                "🔔 This robot reminds me about my notes",
                s["notesRobot"] == id,
            ),
        ],
    )
}

fn words_menu(app: &AppHandle, id: &str, s: &Value) -> Item {
    let ready = vocab::ready_count(app) > 0;
    sub(
        app,
        &words_title(app),
        vec![
            item(app, act(id, "words"), "📚 My words…", true),
            item(
                app,
                act(id, "box-word"),
                "🔍 Box a word on screen to save it…",
                true,
            ),
            item(app, act(id, "dream"), "💭 Show me one of my words", ready),
            separator(app),
            check(
                app,
                act(id, "tutor"),
                "🎓 This robot is my word tutor",
                s["vocabTutor"] == id,
            ),
        ],
    )
}

/// Its personality and permissions (the looks every window shares: the tray's).
fn settings_menu(app: &AppHandle, id: &str, c: &Value) -> Item {
    let kinds = personalities::all()
        .iter()
        .map(|(k, p)| {
            let label = format!(
                "{}  {}",
                p["emoji"].as_str().unwrap_or("🤖"),
                p["label"].as_str().unwrap_or(k)
            );
            check(
                app,
                act(id, &format!("personality|{k}")),
                &label,
                c["personality"] == k.as_str(),
            )
        })
        .collect();
    let modes = workshop::PERMISSION_MODES
        .iter()
        .map(|(k, label)| {
            check(
                app,
                act(id, &format!("permission|{k}")),
                label,
                c["permissionMode"] == *k,
            )
        })
        .collect();
    sub(
        app,
        "⚙️ Settings",
        vec![
            sub(app, "😄 Personality", kinds),
            sub(app, "🔐 Permissions", modes),
            separator(app),
            item(
                app,
                act(id, "workshop"),
                "🛠️ Customize in the Workshop…",
                true,
            ),
        ],
    )
}
