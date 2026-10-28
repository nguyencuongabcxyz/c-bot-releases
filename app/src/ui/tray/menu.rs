//! The tray's menu: your robots, the features, the settings, and the version (updates).

use super::*;

/// The tray's menu, from how things are now.
pub(super) fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let chars = with(app, |st| st.store.list().clone());
    let s = settings(app);
    let mut items = robot_items(app, &chars);
    items.push(separator(app));
    items.extend(feature_items(app, &s));
    items.push(separator(app));
    items.push(settings_menu(app, &s));
    items.push(separator(app));
    items.push(version_item(app));
    items.push(item(app, "tray|quit".into(), "Quit C-Bot", true));
    build_menu(app, items)
}

/// Your robots: on the desktop or put away, and back from a walk; making them, and together.
fn robot_items(app: &AppHandle, chars: &[Value]) -> Vec<Item> {
    let mut items: Vec<Item> = vec![];
    if chars.is_empty() {
        items.push(note(app, "No robots yet"));
    }
    for c in chars {
        let id = c.id();
        let label = format!(
            "{}  {}",
            personalities::emoji(c.personality()),
            c["name"].as_str().unwrap_or("Robo")
        );
        items.push(check(app, format!("tray|robot|{id}"), &label, c.visible()));
    }
    for c in chars.iter().filter(|c| walkers::has(app, c.id())) {
        items.push(item(
            app,
            format!("tray|dock|{}", c.id()),
            &format!(
                "🚶  Call {} back to the desk",
                c["name"].as_str().unwrap_or("Robo")
            ),
            true,
        ));
    }
    items.push(item(
        app,
        "tray|workshop".into(),
        "🛠️ Robot Workshop…",
        true,
    ));
    items.push(item(app, "tray|new".into(), "➕ New robot…", true));
    items.push(item(
        app,
        "tray|groupchat".into(),
        "👥 Robot group chat…",
        visible_count(chars) >= 2,
    ));
    items.push(stage_menu(app, chars));
    items
}

/// The stage (robots/stage/mod.rs): the robots on the desk to tick for it, and taking it (or leaving it).
fn stage_menu(app: &AppHandle, chars: &[Value]) -> Item {
    let on = stage::is_on(app);
    let (picked, cast) = (stage::picked(app), stage::cast(app));
    let mut items: Vec<Item> = vec![];
    if on {
        items.push(note(app, &format!("{} robots on stage", cast.len())));
        items.push(item(
            app,
            "tray|stage-exit".into(),
            "⎋ Off the stage, back to the desks",
            true,
        ));
    } else {
        items.push(note(
            app,
            "Ctrl+click robots to pick them, or tick them here",
        ));
    }
    items.push(separator(app));
    let out: Vec<&Value> = chars.iter().filter(|c| c.visible()).collect();
    for c in &out {
        let id = c.id();
        let ticked = if on {
            cast.iter().any(|x| x == id)
        } else {
            picked.iter().any(|x| x == id)
        };
        items.push(check(
            app,
            format!("tray|stage-pick|{id}"),
            c["name"].as_str().unwrap_or("Robo"),
            ticked,
        ));
    }
    items.push(separator(app));
    if !on {
        let label = if picked.is_empty() {
            "▦ Take the stage".to_string()
        } else {
            format!("▦ Take the stage ({} picked)", picked.len())
        };
        items.push(item(
            app,
            "tray|stage-start".into(),
            &label,
            !picked.is_empty(),
        ));
    }
    items.push(item(
        app,
        "tray|stage-all".into(),
        "▦ Every robot on the desk",
        !out.is_empty(),
    ));
    items.push(item(
        app,
        "tray|stage-last".into(),
        "↺ The last stage again",
        stage::has_last(app),
    ));
    sub(
        app,
        if on {
            "▦ Stage (on now)"
        } else {
            "▦ Arrange on stage"
        },
        items,
    )
}

/// The features: the action menu, the screen, Quick actions, notes and words.
fn feature_items(app: &AppHandle, s: &Value) -> Vec<Item> {
    let (palette_keys, palette_ok) = hotkey(app, "paletteHotkey", "Ctrl+Alt+C");
    let palette_label = if palette_ok {
        format!("⌨️ All actions… ({palette_keys})")
    } else {
        format!("⌨️ All actions… ({palette_keys} is taken by another app)")
    };
    let (screen_keys, _) = hotkey(app, "screenHotkey", "Ctrl+Alt+B");
    vec![
        item(app, "tray|palette".into(), &palette_label, true),
        item(
            app,
            "tray|screen".into(),
            &format!("🔍 Ask about part of the screen… ({screen_keys})"),
            true,
        ),
        quick_menu(app, s),
        notes_menu(app),
        words_menu(app, s),
    ]
}

fn quick_menu(app: &AppHandle, s: &Value) -> Item {
    let quick_model = s["quickModel"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or("haiku");
    sub(
        app,
        "✨ Quick actions",
        vec![
            item(
                app,
                "tray|quick".into(),
                &format!("✨ Quick actions on text… ({})", quick::hotkey(app)),
                true,
            ),
            separator(app),
            check(
                app,
                "set|quickModel|haiku".into(),
                "Fast brain (Haiku)",
                quick_model == "haiku",
            ),
            check(
                app,
                "set|quickModel|sonnet".into(),
                "Better writing (Sonnet)",
                quick_model == "sonnet",
            ),
            separator(app),
            hotkey_line(
                app,
                "quickHotkey",
                "Ctrl+Alt+R",
                "select text, then refine, translate or explain it",
            ),
        ],
    )
}

fn notes_menu(app: &AppHandle) -> Item {
    sub(
        app,
        &notes_title(app),
        vec![
            item(app, "tray|notebook".into(), "📒 Open my notebook…", true),
            item(
                app,
                "tray|note".into(),
                &format!("📝 Take a note… ({})", notes::hotkey(app)),
                true,
            ),
            separator(app),
            hotkey_line(
                app,
                "noteHotkey",
                "Ctrl+Alt+N",
                "take a note (with what you selected)",
            ),
        ],
    )
}

fn words_menu(app: &AppHandle, s: &Value) -> Item {
    sub(
        app,
        &words_title(app),
        vec![
            item(app, "tray|words".into(), "📚 My words…", true),
            item(
                app,
                "tray|box-word".into(),
                "🔍 Box a word on screen to save it…",
                true,
            ),
            item(
                app,
                "tray|quiz".into(),
                "🃏 Quiz me now",
                vocab::ready_count(app) > 0,
            ),
            separator(app),
            check(
                app,
                "toggle|vocabReminders".into(),
                "💭 Dream about my words during the day",
                on(s, "vocabReminders"),
            ),
            separator(app),
            hotkey_line(app, "vocabHotkey", "Ctrl+Alt+W", "select a word to save it"),
        ],
    )
}

fn settings_menu(app: &AppHandle, s: &Value) -> Item {
    let social = s["socialising"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("sometimes");
    sub(
        app,
        "⚙️ Settings",
        vec![
            theme_menu(app, s),
            sounds_menu(app, s),
            sub(
                app,
                "🧹 Evening housemaid",
                vec![
                    check(
                        app,
                        "toggle|maid".into(),
                        "Tidies the desks at 5 pm on workdays",
                        on(s, "maid"),
                    ),
                    item(
                        app,
                        "tray|maid".into(),
                        "Send her round now",
                        !maid::active(app),
                    ),
                ],
            ),
            sub(
                app,
                "🤝 Robots socialising",
                vec![
                    check(
                        app,
                        "set|socialising|often".into(),
                        "Often",
                        social == "often",
                    ),
                    check(
                        app,
                        "set|socialising|sometimes".into(),
                        "Sometimes",
                        social == "sometimes",
                    ),
                    check(
                        app,
                        "set|socialising|never".into(),
                        "Never",
                        social == "never",
                    ),
                ],
            ),
            check(
                app,
                "toggle|paletteDrone".into(),
                "🛸 A drone brings the action menu",
                on(s, "paletteDrone"),
            ),
            check(
                app,
                "toggle|island".into(),
                "🏝️ Robot island at the screen's edge",
                on(s, "island"),
            ),
            check(
                app,
                "toggle|startAtLogin".into(),
                "🚀 Start with Windows",
                on(s, "startAtLogin"),
            ),
            separator(app),
            item(app, "tray|backups".into(), "🗄️ Open backups folder", true),
        ],
    )
}

/// The version, and updates: the installed app updates itself from GitHub Releases (updater.rs).
fn version_item(app: &AppHandle) -> Item {
    let up = updater::status(app);
    if let Some(v) = &up.ready {
        return item(
            app,
            "tray|update".into(),
            &format!("⬆️ Restart to update (v{v})"),
            true,
        );
    }
    let how = if up.checking {
        " — checking…".to_string()
    } else if up.last.is_empty() {
        String::new()
    } else {
        format!(" — {}", up.last)
    };
    let label = format!("C-Bot {}{how}", app.package_info().version);
    item(
        app,
        "tray|check".into(),
        &label,
        updater::installed() && !up.checking,
    )
}
