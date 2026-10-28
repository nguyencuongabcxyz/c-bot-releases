//! What a picked menu item does (the tray's or a robot's): a setting changed, a window
//! opened, the robot's page told.

use super::*;

/// The text on the clipboard (Quick actions from a menu work on it), trimmed and capped.
fn clipboard_text() -> String {
    crate::platform::clipboard::text()
        .trim()
        .chars()
        .take(12000)
        .collect()
}

fn set(app: &AppHandle, key: &str, value: Value) {
    let mut patch = Map::new();
    patch.insert(key.into(), value);
    hub::set_settings(app, patch);
}

/// A setting that's on unless turned off, flipped.
fn toggle(app: &AppHandle, key: &str) {
    let now = on(&settings(app), key);
    set(app, key, json!(!now));
}

/// A setting that names a robot: this one, or (this one already) none.
fn pick_robot(app: &AppHandle, key: &str, id: &str) {
    let now = settings(app)[key] == id;
    set(app, key, json!(if now { "" } else { id }));
}

fn message(app: &AppHandle, text: &str) {
    app.dialog().message(text).title("C-Bot").show(|_| {});
}

pub(super) fn picked(app: &AppHandle, id: &str) {
    let parts: Vec<&str> = id.split('|').collect();
    match parts.as_slice() {
        ["set", key, value] => set(app, key, json!(value)),
        ["toggle", key] => toggle(app, key),
        ["tray", "robot", id] => {
            let visible = with(app, |st| st.store.get(id).is_some_and(|c| c.visible()));
            hub::set_visible(app, id, !visible);
        }
        ["tray", "dock", id] => walkers::dock(app, id),
        ["stage", "add", id] => stage::add(app, id),
        ["tray", "stage-pick", id] => {
            if stage::cast(app).iter().any(|c| c == id) {
                stage::leave(app, id);
            } else {
                stage::toggle_pick(app, id);
            }
            refresh(app);
        }
        ["tray", what] => tray_action(app, what),
        ["robot", id, "personality", key] => {
            workshop::update_character(
                app,
                id,
                crate::runtime::util::patch(vec![("personality", json!(key))]),
            );
        }
        ["robot", id, "permission", key] => {
            workshop::update_character(
                app,
                id,
                crate::runtime::util::patch(vec![("permissionMode", json!(key))]),
            );
        }
        ["robot", id, action] => robot_action(app, id, action),
        _ => {}
    }
}

/// The tray's own items.
fn tray_action(app: &AppHandle, what: &str) {
    match what {
        "workshop" => workshop::open(app, None),
        "new" => workshop::open(app, Some("new")),
        "groupchat" => group::open(app, hub::nearest_robot(app)),
        "stage-start" => stage::start(app, None),
        "stage-all" => {
            let ids = with(app, |st| {
                st.store
                    .list()
                    .iter()
                    .filter(|c| c.visible())
                    .filter_map(|c| c["id"].as_str().map(str::to_string))
                    .collect()
            });
            stage::start(app, Some(ids));
        }
        "stage-last" => stage::start_last(app),
        "stage-exit" => stage::exit(app),
        "palette" => palette::open(app),
        "screen" => snip::ask_screen(app, None, None),
        "quick" => quick::open(app, clipboard_text(), None),
        "notebook" => notes::open_notebook(app, None, None),
        "note" => notes::open_notebook(app, None, Some("add")),
        "words" => vocab::open_words(app),
        "box-word" => {
            thread::sleep(Duration::from_millis(250)); // (after the menu has gone)
            vocab::box_word(app, None, String::new());
        }
        "quiz" => {
            if !vocab::quiz_now(app) {
                message(app, "No robot is free to quiz you right now.");
            }
        }
        "maid" => maid::start(app),
        "backups" => {
            let dir = with(app, |st| st.store.backup_dir.clone());
            let _ = std::fs::create_dir_all(&dir);
            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
        }
        "update" => updater::restart(app),
        "check" => updater::check(app),
        _ => {}
    }
}

/// A robot's menu items.
fn robot_action(app: &AppHandle, id: &str, action: &str) {
    let rid = Some(id.to_string());
    match action {
        // (the page acts these out: robot.ts robot:action)
        "wake" | "sleep" | "new-tab" | "history" | "paste" | "terminal" | "shell" | "bonk"
        | "wander" | "peek" | "unpeek" => {
            let _ = app.emit_to(robots::label_of(id), "robot:action", action);
        }
        "hide" => hub::set_visible(app, id, false),
        "open-folder" => ipc::open_folder(app, id),
        "dock" => walkers::dock(app, id),
        "screen" => snip::ask_screen(app, rid, None),
        "groupchat" => group::open(app, rid),
        "stage-pick" => stage::toggle_pick(app, id),
        "quick" => quick::open(app, clipboard_text(), rid),
        "notebook" => notes::open_notebook(app, rid, None),
        "note" => notes::open_notebook(app, rid, Some("add")),
        "notes-robot" => pick_robot(app, "notesRobot", id),
        "words" => vocab::open_words(app),
        "box-word" => {
            thread::sleep(Duration::from_millis(250)); // (after the menu has gone)
            vocab::box_word(app, rid, String::new());
        }
        "dream" => {
            vocab::dream_for(app, id);
        }
        "quiz" => {
            vocab::quiz_for(app, id, true);
        }
        "tutor" => pick_robot(app, "vocabTutor", id),
        "workshop" => workshop::open(app, Some(id)),
        _ => {}
    }
}
