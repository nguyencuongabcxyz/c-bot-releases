//! What the feature modules share (main.js's helpers between them): telling a robot
//! something, where a robot is, which robot is nearest the mouse, the settings (changing
//! them tells every window), the global hotkeys, and the hush while you present.

use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::win::{self, Rect};
use crate::{capture, chat, robots, tray, updater, views, walkers, with, workshop};

// ---------------------------------------------------------------- robots

/// Tell a robot's window something (robot:event, robot:vocab, robot:notes…).
pub fn send_to_robot(app: &AppHandle, id: &str, channel: &str, payload: Value) {
    if channel == "robot:character" {
        walkers::character(app, id); // (its walker looks the same)
    }
    let _ = app.emit_to(robots::label_of(id), channel, payload);
}

/// Is any of the robot's tabs answering?
pub fn robot_busy(app: &AppHandle, id: &str) -> bool {
    let tabs: Vec<String> = with(app, |st| {
        st.store.get(id).and_then(|c| c["tabs"].as_array()).map(|t| t.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect()).unwrap_or_default()
    });
    with(app, |st| tabs.iter().any(|t| chat::is_busy(st, id, t)))
}

/// Where the robot is on screen (physical px): out walking, where it walks; else its desk.
pub fn robot_rect(app: &AppHandle, id: &str) -> Option<Rect> {
    walkers::bounds(app, id).or_else(|| robots::desk_rect(app, id))
}

fn distance_to_cursor(r: Rect) -> f64 {
    let (cx, cy) = win::cursor();
    let (mx, my) = (r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 / 2.0);
    ((mx - cx as f64).powi(2) + (my - cy as f64).powi(2)).sqrt()
}

/// The robot at its desk nearest the mouse (main.js nearestRobot).
pub fn nearest_robot(app: &AppHandle) -> Option<String> {
    robots::open_ids(app)
        .into_iter()
        .filter(|id| !walkers::has(app, id))
        .filter(|id| robots::hwnd_of(app, id).is_some_and(win::is_visible))
        .filter_map(|id| Some((distance_to_cursor(robots::desk_rect(app, &id)?), id)))
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id)
}

/// The robot that reminds you about your notes: the one picked in the Workshop if it's
/// out, else the one nearest the mouse, else any (main.js notesRobot).
pub fn notes_robot(app: &AppHandle) -> Option<String> {
    let pick = with(app, |st| st.store.settings()["notesRobot"].as_str().unwrap_or("").to_string());
    let open = robots::open_ids(app);
    if open.contains(&pick) && robots::hwnd_of(app, &pick).is_some_and(win::is_visible) {
        return Some(pick);
    }
    nearest_robot(app).or_else(|| open.into_iter().find(|id| robots::hwnd_of(app, id).is_some_and(win::is_visible)))
}

/// A robot that can chat about something: this one, unless it's out walking (then it's
/// called back to its desk) (main.js chattyRobot).
pub fn chatty_robot(app: &AppHandle, id: Option<&str>) -> Option<String> {
    let id = match id {
        Some(i) if robots::open_ids(app).iter().any(|o| o == i) => i.to_string(),
        _ => notes_robot(app)?,
    };
    if walkers::has(app, &id) {
        walkers::dock(app, &id);
    }
    Some(id)
}

/// Put a robot on the desktop or away (main.js showRobot / hideRobot).
pub fn set_visible(app: &AppHandle, id: &str, visible: bool) {
    let index = with(app, |st| {
        st.store.update(id, crate::util::patch(vec![("visible", json!(visible))]))?;
        st.store.list().iter().position(|c| c["id"] == id)
    });
    let Some(index) = index else { return }; // (no such robot)
    if visible {
        // (put away, its window was closed: it opens again; already out, nothing to do)
        if let Err(err) = robots::open(app, id, index) {
            eprintln!("[robots] couldn't open {id}: {err}");
        }
    } else {
        close_robot_window(app, id);
    }
    tray::refresh(app);
    workshop::notify(app);
}

/// Its window goes, and a walk it was out on with it (main.js's robot window 'closed').
pub fn close_robot_window(app: &AppHandle, id: &str) {
    walkers::close(app, id);
    if let Some(w) = app.get_webview_window(&robots::label_of(id)) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- settings

/// Change settings and tell everyone who cares (main.js setSettings): the theme to every
/// window, a changed hotkey re-bound, the robots, the tray and the Workshop.
pub fn set_settings(app: &AppHandle, patch: Map<String, Value>) -> Value {
    let keys: Vec<String> = patch.keys().cloned().collect();
    let settings = with(app, |st| st.store.update_settings(patch));
    if keys.iter().any(|k| k == "theme" || k == "themeMode") {
        views::theme_changed(app);
    }
    for k in &keys {
        rebind_hotkey(app, k);
    }
    if keys.iter().any(|k| k == "startAtLogin") {
        apply_login_item(app);
    }
    // (which robot's corkboard shows the notes)
    if keys.iter().any(|k| k == "notesBoard" || k == "notesRobot") {
        crate::notes::changed(app);
    }
    for id in robots::open_ids(app) {
        let _ = app.emit_to(robots::label_of(&id), "robot:settings", settings.clone());
    }
    tray::refresh(app);
    workshop::notify(app);
    settings
}

// ---------------------------------------------------------------- Start with Windows

/// Where an installed C-Bot is: this app's installer's place, else the Electron app's.
fn installed_exe() -> Option<PathBuf> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    [local.join("C-Bot").join("C-Bot.exe"), local.join("C-Bot").join("c-bot.exe"), local.join("Programs").join("c-bot").join("C-Bot.exe")]
        .into_iter()
        .find(|p| p.is_file())
}

/// "Start with Windows" (setting startAtLogin, on unless turned off): C-Bot comes back with
/// your robots after a restart (main.js applyLoginItem). It opens the installed app; a
/// build run from source only points it at the installed one (it keeps itself up to date),
/// and leaves it alone when nothing is installed (it couldn't start on its own anyway).
pub fn apply_login_item(app: &AppHandle) {
    // (a test copy, CBOT_DATA_DIR, leaves your real C-Bot's start-up as it is)
    if std::env::var_os("CBOT_DATA_DIR").is_some() {
        return;
    }
    let on = with(app, |st| st.store.settings()["startAtLogin"].as_bool() != Some(false));
    let result = if updater::installed() {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        match (on, launcher.is_enabled().unwrap_or(false)) {
            (true, _) => launcher.enable().map_err(|e| e.to_string()),
            (false, true) => launcher.disable().map_err(|e| e.to_string()),
            (false, false) => Ok(()),
        }
    } else {
        let Some(exe) = installed_exe() else { return };
        let launcher = auto_launch::AutoLaunchBuilder::new()
            .set_app_name(&app.package_info().name)
            .set_app_path(&format!("\"{}\"", exe.display()))
            .set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser)
            .build();
        launcher.map_err(|e| e.to_string()).and_then(|l| match (on, l.is_enabled().unwrap_or(false)) {
            (true, _) => l.enable().map_err(|e| e.to_string()),
            (false, true) => l.disable().map_err(|e| e.to_string()),
            (false, false) => Ok(()),
        })
    };
    if let Err(err) = result {
        eprintln!("[startup] couldn't set Start with Windows: {err}");
    }
}

// ---------------------------------------------------------------- the save file

/// The save file was damaged (a power cut, say): say where the robots came back from.
fn recovered_notice(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let Some((message, detail)) = with(app, |st| {
        let r = st.store.recovered.as_ref()?;
        Some(match &r.from {
            Some(from) => (
                "Your robots were recovered from a backup.",
                format!("They came back from:\n{}\n\nThe damaged file was kept as:\n{}", from.display(), r.broken.display()),
            ),
            None => (
                "C-Bot's save file couldn't be read.",
                format!("No backup could be read either, so C-Bot starts fresh.\n\nThe damaged file was kept as:\n{}", r.broken.display()),
            ),
        })
    }) else {
        return;
    };
    app.dialog().message(format!("{message}\n\n{detail}")).title("C-Bot").kind(MessageDialogKind::Warning).show(|_| {});
}

// ---------------------------------------------------------------- hotkeys

/// A global hotkey a feature offers (main.js hotkeyList): the setting that changes it, what
/// it's called in the Workshop and the tray, its default, and what it does.
#[derive(Clone)]
pub struct Hotkey {
    pub setting: &'static str, // e.g. "paletteHotkey"
    pub label: &'static str,   // e.g. "Action menu"
    pub what: &'static str,    // e.g. "Every action in one menu, by the mouse"
    pub default: &'static str, // e.g. "Ctrl+Alt+C"
    pub run: fn(&AppHandle),
}

struct Bound {
    key: Hotkey,
    ok: bool, // registered (not taken by another app)
}

#[derive(Default)]
struct Hub {
    hotkeys: Vec<Bound>,
    hush: bool,
}

fn hub_state<R>(app: &AppHandle, f: impl FnOnce(&mut Hub) -> R) -> R {
    let state = app.state::<Mutex<Hub>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// The keys a hotkey is set to (the setting, or its default).
pub fn hotkey_keys(app: &AppHandle, setting: &str, default: &str) -> String {
    with(app, |st| st.store.settings()[setting].as_str().filter(|s| !s.is_empty()).unwrap_or(default).to_string())
}

/// Offer a hotkey: bound now, and again whenever its setting changes.
pub fn add_hotkey(app: &AppHandle, key: Hotkey) {
    let keys = hotkey_keys(app, key.setting, key.default);
    let ok = capture::register(app, key.setting, &keys, key.run);
    hub_state(app, |h| {
        h.hotkeys.retain(|b| b.key.setting != key.setting);
        h.hotkeys.push(Bound { key, ok });
    });
    tray::refresh(app);
}

fn rebind_hotkey(app: &AppHandle, setting: &str) {
    let key = hub_state(app, |h| h.hotkeys.iter().find(|b| b.key.setting == setting).map(|b| b.key.clone()));
    if let Some(key) = key {
        add_hotkey(app, key);
    }
}

/// Every hotkey, for the Workshop's Settings > Shortcuts and the tray: what it does, its
/// keys, its default, whether it works (registered, not taken by another app).
pub fn hotkey_list(app: &AppHandle) -> Value {
    let list = hub_state(app, |h| h.hotkeys.iter().map(|b| (b.key.clone(), b.ok)).collect::<Vec<_>>());
    Value::Array(
        list.into_iter()
            .map(|(k, ok)| json!({ "setting": k.setting, "label": k.label, "what": k.what, "key": hotkey_keys(app, k.setting, k.default), "def": k.default, "ok": ok }))
            .collect(),
    )
}

/// One hotkey's keys and whether it works: (keys, ok).
pub fn hotkey_status(app: &AppHandle, setting: &str) -> Option<(String, bool)> {
    let found = hub_state(app, |h| h.hotkeys.iter().find(|b| b.key.setting == setting).map(|b| (b.key.default, b.ok)));
    found.map(|(def, ok)| (hotkey_keys(app, setting, def), ok))
}

// ---------------------------------------------------------------- the hush

/// You're presenting, or a full-screen app or game has the screen: the robots keep their
/// sounds to themselves, except a question for you (sound.ts).
pub fn hush(app: &AppHandle) -> bool {
    hub_state(app, |h| h.hush)
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Hub::default()));
    recovered_notice(app);
    apply_login_item(app);
    // checked every few seconds (main.js watchPresenting)
    let app = app.clone();
    thread::spawn(move || loop {
        let now = capture::presenting();
        let changed = hub_state(&app, |h| std::mem::replace(&mut h.hush, now) != now);
        if changed {
            for id in robots::open_ids(&app) {
                let _ = app.emit_to(robots::label_of(&id), "robot:hush", now);
            }
        }
        thread::sleep(Duration::from_secs(5));
    });
}
