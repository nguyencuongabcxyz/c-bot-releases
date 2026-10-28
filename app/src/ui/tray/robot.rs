//! A robot's right-click menu (main.js robot:menu): grouped by feature, the everyday things
//! at the top. Out for a walk, the short one.

use super::*;

/// A robot was right-clicked: its menu, by the mouse (state: is it awake, out walking?).
#[tauri::command(async)]
pub fn robot_menu(app: AppHandle, window: tauri::WebviewWindow, state: Value) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    let (awake, away) = (
        state["awake"].as_bool().unwrap_or(false),
        state["away"].as_bool().unwrap_or(false),
    );
    match robot_menu_of(&app, &id, awake, away) {
        Ok(Some(menu)) => {
            let _ = window.popup_menu(&menu);
        }
        Ok(None) => {}
        Err(err) => eprintln!("[tray] couldn't build {id}'s menu: {err}"),
    }
    Ok(())
}

/// An item's id in this robot's menu.
fn act(id: &str, action: &str) -> String {
    format!("robot|{id}|{action}")
}

fn robot_menu_of(
    app: &AppHandle,
    id: &str,
    awake: bool,
    away: bool,
) -> tauri::Result<Option<Menu<Wry>>> {
    let Some((c, visible, terminal_open)) = with(app, |st| {
        Some((
            st.store.get(id)?.clone(),
            visible_count(st.store.list()),
            st.terminals.contains_key(id),
        ))
    }) else {
        return Ok(None);
    };
    let s = settings(app);
    let name = c["name"].as_str().unwrap_or("Robo");
    let items = if away {
        vec![
            note(app, &format!("{name} is out for a walk")),
            separator(app),
            item(app, act(id, "dock"), "🚶 Call back to the desk", true),
            item(app, act(id, "open-folder"), "📁 Open folder", true),
            separator(app),
            notes_menu(app, id, &s),
            words_menu(app, id, &s),
            separator(app),
            settings_menu(app, id, &c, &s),
            item(app, act(id, "hide"), "🙈 Put away (hide)", true),
        ]
    } else {
        let folder = c.folder();
        let base = folder
            .rsplit(['\\', '/'])
            .find(|s| !s.is_empty())
            .unwrap_or(folder);
        let mut items = vec![
            note(app, &format!("{name} — {base}")),
            separator(app),
            if awake {
                item(app, act(id, "sleep"), "💤 Go to sleep", true)
            } else {
                item(app, act(id, "wake"), "☀️ Wake up", true)
            },
            separator(app),
        ];
        items.extend(chat_items(app, id, terminal_open));
        items.push(separator(app));
        items.extend(feature_items(app, id, &s, awake, visible));
        items.push(separator(app));
        items.push(settings_menu(app, id, &c, &s));
        items.push(island_item(app, id));
        items.push(item(app, act(id, "hide"), "🙈 Put away (hide)", true));
        items
    };
    build_menu(app, items).map(Some)
}

/// The chat and Claude Code: a tab, past conversations, pasting, the screen, a terminal, the folder.
fn chat_items(app: &AppHandle, id: &str, terminal_open: bool) -> Vec<Item> {
    let can_paste = paste::has_something();
    let (screen_keys, _) = hotkey(app, "screenHotkey", "Ctrl+Alt+B");
    vec![
        item(app, act(id, "new-tab"), "💬 New tab", true),
        item(app, act(id, "history"), "🕘 Past conversations…", true),
        item(
            app,
            act(id, "paste"),
            if can_paste {
                "📋 Paste screenshot / file from clipboard"
            } else {
                "📋 Paste (copy a screenshot or file first)"
            },
            can_paste,
        ),
        item(
            app,
            act(id, "screen"),
            &format!("🔍 Ask about part of the screen… ({screen_keys})"),
            true,
        ),
        item(
            app,
            act(id, "terminal"),
            if terminal_open {
                "⌨️ Terminal is open"
            } else {
                "⌨️ Open in terminal (full Claude Code)"
            },
            !terminal_open,
        ),
        item(
            app,
            act(id, "shell"),
            "💲 Shell in my folder (Ctrl+`)",
            true,
        ),
        item(app, act(id, "open-folder"), "📁 Open folder", true),
    ]
}

/// The features: the stage, the group chat, Quick actions, notes, words, and play.
fn feature_items(app: &AppHandle, id: &str, s: &Value, awake: bool, visible: usize) -> Vec<Item> {
    vec![
        item(
            app,
            act(id, "stage-pick"),
            if stage::is_on(app) {
                "▦ Join the stage"
            } else if stage::picked(app).iter().any(|p| p == id) {
                "▦ Unpick for the stage"
            } else {
                "▦ Pick for the stage (Ctrl+click)"
            },
            true,
        ),
        item(
            app,
            act(id, "groupchat"),
            if group::in_chat(app, id) {
                "👥 Group chat (in it now)…"
            } else {
                "👥 Start a group chat…"
            },
            visible >= 2,
        ),
        item(
            app,
            act(id, "quick"),
            &format!("✨ Quick actions on text… ({})", quick::hotkey(app)),
            true,
        ),
        notes_menu(app, id, s),
        words_menu(app, id, s),
        sub(
            app,
            "🎮 Play",
            vec![
                item(
                    app,
                    act(id, "bonk"),
                    "🔨 Bonk with the squeaky hammer (wake up / hurry up)",
                    true,
                ),
                item(
                    app,
                    act(id, "wander"),
                    if awake {
                        "🚶 Go for a walk"
                    } else {
                        "🚶 Sleepwalk"
                    },
                    true,
                ),
            ],
        ),
    ]
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
            item(app, act(id, "quiz"), "🃏 Quiz me on a word", ready),
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

/// Its personality and permissions, and the looks every window shares.
fn settings_menu(app: &AppHandle, id: &str, c: &Value, s: &Value) -> Item {
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
            sounds_menu(app, s),
            theme_menu(app, s),
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

/// Off to the robot island, or back from it.
fn island_item(app: &AppHandle, id: &str) -> Item {
    let peeking = with(app, |st| st.robots.get(id).is_some_and(|r| r.peek));
    if peeking {
        item(app, act(id, "unpeek"), "👋 Come back to the desk", true)
    } else {
        item(
            app,
            act(id, "peek"),
            "🏝️ Send away to the robot island",
            crate::robots::island::on(app),
        )
    }
}
