//! The Robot Workshop window: build, change and remove robots, and the app's settings
//! (main.js openManager, the mgr:* handlers, sanitize, updateCharacter; renderer: manager).
//! Window label "manager". [wave 1: shell]

use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use serde_json::{Map, Value, json};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::agents::claude::locate;
use crate::agents::personalities;
use crate::features::{chat, notes};
use crate::robots;
use crate::robots::ipc;
use crate::runtime::util::patch;
use crate::runtime::{Locked, hub, with};
use crate::store::Fields;
use crate::ui::{tray, views};

const LABEL: &str = "manager";

/// What each permission mode is called (main.js PERMISSION_MODES), in the order offered.
pub const PERMISSION_MODES: [(&str, &str); 4] = [
    ("default", "Look, don't touch (read-only)"),
    ("acceptEdits", "Helpful hands (can edit files)"),
    ("bypassPermissions", "Unleashed (can do anything)"),
    ("plan", "Planner (plans only)"),
];

/// The characters there used to be (main.js OLD_LOOKS): their names still come in, as a
/// build like them (runtime/migrate.rs kit_like).
const OLD_LOOKS: [&str; 6] = ["robot", "custom", "loopy", "cat", "nerd", "girl"];
const SIZES: [&str; 4] = ["small", "normal", "large", "huge"];
const KIT_SLOTS: [&str; 11] = [
    "head", "face", "top", "body", "arms", "base", "finish", "clothes", "neck", "extra", "specs",
];
const KIT_COLOURS: [&str; 5] = ["second", "accent", "eye", "cloth", "hair"];

/// The notes' reminder settings until you change them (notes.js DEFAULTS).
fn note_defaults() -> Value {
    json!({ "notesReminders": true, "notesEvening": "17:30", "notesMorning": true, "notesWorkdays": [1, 2, 3, 4, 5], "notesCarry": true })
}

// ---------------------------------------------------------------- the window

/// Open the Workshop (or bring it forward); focus: a robot's id to show, or "new".
/// (Off the calling thread: it's called from menus and the second launch, on the main
/// thread, where building a window would wait on itself.)
pub fn open(app: &AppHandle, focus: Option<&str>) {
    let (app, focus) = (app.clone(), focus.map(str::to_string));
    thread::spawn(move || open_now(&app, focus.as_deref()));
}

fn open_now(app: &AppHandle, focus: Option<&str>) {
    // (two at once, say a double click on the tray: one window)
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.locked();
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(f) = focus {
            let _ = app.emit_to(LABEL, "mgr:focus", f);
        }
        return;
    }
    let query: Vec<(&str, &str)> = focus.map(|f| vec![("focus", f)]).unwrap_or_default();
    let built = views::builder(app, LABEL, "manager", &query)
        .title("C-Bot · Robot Workshop")
        .inner_size(1040.0, 620.0)
        .min_inner_size(880.0, 520.0)
        .center()
        .background_color(Color(0x1b, 0x1f, 0x2e, 0xff))
        .build();
    if let Err(err) = built {
        log::warn!("couldn't open: {err}");
    }
}

/// Something it shows changed: it asks again (mgr:changed).
pub fn notify(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "mgr:changed", ());
    }
    crate::robots::island::changed(app); // (a robot made, deleted, put away or out; the island turned on or off)
}

// ---------------------------------------------------------------- what it asks

#[tauri::command(async)]
pub fn mgr_state(app: AppHandle) -> Value {
    state(&app)
}

/// A robot's home folder, picked in the folder dialog (null: cancelled).
#[tauri::command(async)]
pub fn mgr_pick_folder(app: AppHandle, current: Option<String>) -> Option<String> {
    pick_folder(&app, current.as_deref().unwrap_or(""))
}

#[tauri::command(async)]
pub fn mgr_create(app: AppHandle, fields: Value) -> Value {
    create(&app, &fields)
}

#[tauri::command(async)]
pub fn mgr_update(app: AppHandle, id: String, patch: Value) -> Value {
    update_character(&app, &id, sanitize(&patch))
}

#[tauri::command(async)]
pub fn mgr_delete(app: AppHandle, id: String) {
    delete(&app, &id);
}

/// Show a robot, or put it away.
#[tauri::command(async)]
pub fn mgr_visible(app: AppHandle, id: String, visible: bool) {
    hub::set_visible(&app, &id, visible);
}

/// "Forget conversation": every tab back to a fresh one.
#[tauri::command(async)]
pub fn mgr_reset(app: AppHandle, id: String) {
    ipc::reset(&app, &id, None);
}

#[tauri::command(async)]
pub fn mgr_settings(app: AppHandle, patch: Map<String, Value>) -> Value {
    hub::set_settings(&app, patch)
}

/// "Locate it myself…": the claude command, picked in a file dialog and checked.
#[tauri::command(async)]
pub fn mgr_pick_claude(app: AppHandle) -> Value {
    pick_claude(&app)
}

/// "Search again": look everywhere (just installed it, or it moved); a picked path that's
/// gone is forgotten.
#[tauri::command(async)]
pub fn mgr_find_claude(app: AppHandle) -> Value {
    let chosen = with(&app, |st| {
        let chosen = st.store.settings()["claudePath"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if !chosen.is_empty() && !std::path::Path::new(&chosen).exists() {
            st.store
                .update_settings(patch(vec![("claudePath", json!(""))]));
            return String::new();
        }
        chosen
    });
    locate::locate(&chosen, true);
    notify(&app);
    claude_info(&app)
}

/// Everything the Workshop shows (main.js mgr:state).
fn state(app: &AppHandle) -> Value {
    let (characters, settings) = with(app, |st| {
        let characters: Vec<Value> = st
            .store
            .list()
            .iter()
            .map(|c| robots::view(st, c))
            .collect();
        (characters, st.store.settings().clone())
    });
    let personalities: Map<String, Value> = personalities::all()
        .iter()
        .map(|(k, p)| {
            (
                k.clone(),
                json!({ "label": p["label"], "emoji": p["emoji"] }),
            )
        })
        .collect();
    let modes: Map<String, Value> = PERMISSION_MODES
        .iter()
        .map(|(k, label)| (k.to_string(), json!(label)))
        .collect();
    let note_ok = hub::hotkey_status(app, "noteHotkey").is_none_or(|(_, ok)| ok);
    let mut out = json!({
        "characters": characters,
        "personalities": personalities,
        "permissionModes": modes,
        "settings": settings,
        "notes": { "hotkey": notes::hotkey(app), "hotkeyOk": note_ok, "defaults": note_defaults() },
        "hotkeys": hub::hotkey_list(app),
    });
    if let (Some(o), Value::Object(info)) = (out.as_object_mut(), claude_info(app)) {
        o.extend(info);
    }
    out
}

/// Where Claude Code is, for the Workshop: { claudePath, claudeSource }.
fn claude_info(app: &AppHandle) -> Value {
    let chosen = with(app, |st| {
        st.store.settings()["claudePath"]
            .as_str()
            .unwrap_or("")
            .to_string()
    });
    match locate::locate(&chosen, false) {
        Some(f) => json!({ "claudePath": f.path.to_string_lossy(), "claudeSource": f.source }),
        None => json!({ "claudePath": null, "claudeSource": "" }),
    }
}

fn home() -> PathBuf {
    crate::runtime::paths::home()
}

fn pick_folder(app: &AppHandle, current: &str) -> Option<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Which folder should this robot live in?");
    dialog = dialog.set_directory(if current.is_empty() {
        home()
    } else {
        PathBuf::from(current)
    });
    if let Some(w) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&w);
    }
    let picked = dialog.blocking_pick_folder()?.into_path().ok()?;
    Some(picked.to_string_lossy().into_owned())
}

/// Pick claude by hand (opens where the installer puts it), and check it really is Claude Code.
fn pick_claude(app: &AppHandle) -> Value {
    let bin = home().join(".local").join("bin");
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Locate Claude Code (claude)")
        .set_directory(if bin.exists() { bin } else { home() })
        .add_filter("Claude Code", &["exe", "cmd"])
        .add_filter("All files", &["*"]);
    if let Some(w) = app.get_webview_window(LABEL) {
        dialog = dialog.set_parent(&w);
    }
    let Some(file) = dialog.blocking_pick_file().and_then(|f| f.into_path().ok()) else {
        return json!({ "ok": false });
    };
    match locate::check(&file) {
        Ok(version) => {
            let path = file.to_string_lossy().into_owned();
            hub::set_settings(app, patch(vec![("claudePath", json!(path))]));
            json!({ "ok": true, "path": path, "version": version })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

// ---------------------------------------------------------------- the robots

fn hex_colour(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
    })
}

/// Only what a robot may have, in the shapes it may have it (main.js sanitize).
pub fn sanitize(fields: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let s = |k: &str| fields.get(k).and_then(Value::as_str);
    if let Some(name) = s("name") {
        let name: String = name.trim().chars().take(24).collect();
        out.insert(
            "name".into(),
            json!(if name.is_empty() {
                "Robo".to_string()
            } else {
                name
            }),
        );
    }
    if let Some(folder) = s("folder") {
        out.insert("folder".into(), json!(folder));
    }
    if let Some(p) = s("personality").filter(|p| personalities::all().contains_key(*p)) {
        out.insert("personality".into(), json!(p));
    }
    if let Some(m) = s("permissionMode").filter(|m| PERMISSION_MODES.iter().any(|(k, _)| k == m)) {
        out.insert("permissionMode".into(), json!(m));
    }
    if hex_colour(&fields["color"]) {
        out.insert("color".into(), fields["color"].clone());
    }
    if let Some(model) = s("model") {
        out.insert("model".into(), json!(model.trim()));
    }
    if let Some(a) = s("accessory") {
        out.insert("accessory".into(), json!(a));
    }
    // every robot is one you build (the old characters' names still come in: as a build like them)
    let body = s("body").unwrap_or("");
    let old = OLD_LOOKS.contains(&body);
    if body == "kit" || old {
        out.insert("body".into(), json!("kit"));
    }
    let kit_given = fields
        .get("kit")
        .is_some_and(|k| !k.is_null() && k != false && k != "" && k != 0);
    if old && !kit_given {
        out.insert(
            "kit".into(),
            crate::runtime::migrate::kit_like(body, s("color").unwrap_or("")),
        );
    }
    // a robot built from parts: a part name per slot and its colours (office3d/kit3d.ts knows the parts)
    if let Some(given) = fields.get("kit").filter(|k| k.is_object() || k.is_array()) {
        let mut kit = Map::new();
        for slot in KIT_SLOTS {
            let part = given.get(slot).and_then(Value::as_str).unwrap_or("");
            if (1..=16).contains(&part.len()) && part.chars().all(|c| c.is_ascii_lowercase()) {
                kit.insert(slot.into(), json!(part));
            }
        }
        for c in KIT_COLOURS {
            if given.get(c).is_some_and(hex_colour) {
                kit.insert(c.into(), given[c].clone());
            }
        }
        out.insert("kit".into(), Value::Object(kit));
    }
    if let Some(t) = s("theme").filter(|t| matches!(*t, "classic" | "sioux")) {
        out.insert("theme".into(), json!(t));
    }
    if let Some(size) = s("size").filter(|z| SIZES.contains(z)) {
        out.insert("size".into(), json!(size));
    }
    if let Some(c) = s("clickOpens").filter(|c| matches!(*c, "chat" | "terminal")) {
        out.insert("clickOpens".into(), json!(c));
    }
    if let Some(w) = fields.get("wanders").and_then(Value::as_bool) {
        out.insert("wanders".into(), json!(w));
    }
    out
}

/// A new robot: it comes out on the desktop straight away.
fn create(app: &AppHandle, fields: &Value) -> Value {
    let fields = sanitize(fields);
    let (c, index) = with(app, |st| {
        let c = st.store.create(fields);
        (c, st.store.list().len().saturating_sub(1))
    });
    let id = c.id().to_string();
    if let Err(err) = robots::open(app, &id, index) {
        log::warn!("couldn't open {id}: {err}");
    }
    tray::refresh(app);
    notify(app);
    c
}

/// Gone for good (its folder and its Claude Code conversations aren't touched).
fn delete(app: &AppHandle, id: &str) {
    chat::close_robot(app, id);
    hub::close_robot_window(app, id);
    with(app, |st| st.store.remove(id));
    tray::refresh(app);
    notify(app);
}

/// A robot changed (the Workshop, or its own menu's personality and permissions): what's
/// live follows (main.js updateCharacter). Its new self, or null if there's no such robot.
pub fn update_character(app: &AppHandle, id: &str, changes: Map<String, Value>) -> Value {
    let Some(before) = with(app, |st| st.store.get(id).cloned()) else {
        return Value::Null;
    };
    let str_of = |k: &str| {
        changes
            .get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let folder_changed =
        str_of("folder").is_some_and(|f| Some(f.as_str()) != before["folder"].as_str());
    let new_size =
        str_of("size").filter(|s| s.as_str() != before["size"].as_str().unwrap_or("normal"));
    let new_mode = str_of("permissionMode");
    with(app, |st| st.store.update(id, changes));
    if folder_changed {
        // a new folder means new conversations: Claude Code keeps them per folder
        chat::close_robot(app, id);
        with(app, |st| {
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
            for t in tabs {
                st.store
                    .update_tab(id, &t, patch(vec![("sessionId", Value::Null)]));
            }
        });
    } else if let Some(mode) = new_mode {
        chat::set_permission_mode(app, id, &mode);
    }
    if robots::hwnd_of(app, id).is_some() {
        let name = with(app, |st| {
            st.store
                .get(id)
                .and_then(|c| c["name"].as_str().map(str::to_string))
        })
        .unwrap_or_default();
        robots::set_title(app, id, &name);
        if let Some(size) = new_size {
            // a new size grows (or shrinks) round its feet
            robots::resize_robot(app, id, &size);
        }
        if let Some(view) = with(app, |st| st.store.get(id).map(|c| robots::view(st, c))) {
            hub::send_to_robot(app, id, "robot:character", view); // (and its walker, if it's out)
        }
    }
    tray::refresh(app);
    notify(app);
    with(app, |st| st.store.get(id).cloned()).unwrap_or(Value::Null)
}

pub fn setup(_app: &AppHandle) {}
