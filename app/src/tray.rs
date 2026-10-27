//! The tray icon and its menu, and a robot's right-click menu (main.js refreshTray and
//! robot:menu). Menu item ids are "<where>|<what>…": tray|<action>[|<id>],
//! robot|<id>|<action>[|<arg>], and set|<setting>|<value> / toggle|<setting> for the
//! settings either menu changes. Radio items are check items (Tauri has no radios): the
//! menu is rebuilt after every change, so the tick always lands on the one picked.

use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{clipboard, groupchat, hub, maid, notes, palette, personalities, quick, robot_ipc, robots, snip, stage, updater, views, vocab, walkers, with, workshop};

pub type MenuItems = Vec<Box<dyn IsMenuItem<Wry>>>;
type Item = tauri::Result<Box<dyn IsMenuItem<Wry>>>;

// ---------------------------------------------------------------- building menus

pub fn item(app: &AppHandle, id: String, label: &str, enabled: bool) -> Item {
    Ok(Box::new(MenuItem::with_id(app, id, label, enabled, None::<&str>)?))
}

/// A line that says something (greyed out).
fn note(app: &AppHandle, label: &str) -> Item {
    item(app, "none".into(), label, false)
}

fn check(app: &AppHandle, id: String, label: &str, checked: bool) -> Item {
    Ok(Box::new(CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)?))
}

pub fn separator(app: &AppHandle) -> Item {
    Ok(Box::new(PredefinedMenuItem::separator(app)?))
}

fn sub(app: &AppHandle, label: &str, items: Vec<Item>) -> Item {
    let items = items.into_iter().collect::<tauri::Result<MenuItems>>()?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Ok(Box::new(Submenu::with_items(app, label, true, &refs)?))
}

pub fn build_menu(app: &AppHandle, items: Vec<Item>) -> tauri::Result<Menu<Wry>> {
    let items = items.into_iter().collect::<tauri::Result<MenuItems>>()?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

// ---------------------------------------------------------------- what they show

/// A hotkey's keys and whether it works (no other app has it). Until its feature has
/// bound it: its keys, assumed fine.
fn hotkey(app: &AppHandle, setting: &str, default: &str) -> (String, bool) {
    hub::hotkey_status(app, setting).unwrap_or_else(|| (hub::hotkey_keys(app, setting, default), true))
}

/// A hotkey's line in its feature's menu: what it does, or that another app has it.
fn hotkey_line(app: &AppHandle, setting: &str, default: &str, what: &str) -> Item {
    let (keys, ok) = hotkey(app, setting, default);
    note(app, &if ok { format!("{keys} anywhere: {what}") } else { format!("{keys} is taken by another app") })
}

fn settings(app: &AppHandle) -> Value {
    with(app, |st| st.store.settings().clone())
}

/// On unless turned off (the settings that default to on).
fn on(settings: &Value, key: &str) -> bool {
    settings[key].as_bool() != Some(false)
}

/// Two looks for every window, each light or dark (or following Windows).
fn theme_menu(app: &AppHandle, s: &Value) -> Item {
    let now = views::theme_of(s);
    let themes = [("vintage", "📜  Vintage notebook"), ("future", "🛰️  Future tech")];
    let modes = [("auto", "Follow Windows light / dark"), ("light", "Always light"), ("dark", "Always dark")];
    let mut items: Vec<Item> = themes.iter().map(|(k, label)| check(app, format!("set|theme|{k}"), label, now["theme"] == *k)).collect();
    items.push(separator(app));
    items.extend(modes.iter().map(|(k, label)| check(app, format!("set|themeMode|{k}"), label, now["mode"] == *k)));
    sub(app, "🎨 Theme", items)
}

/// Robot sounds: just the ones that matter (the default), all of them, or none.
fn sounds_menu(app: &AppHandle, s: &Value) -> Item {
    let levels = [("essential", "🔈 Essential only"), ("all", "🔊 Everything"), ("off", "🔇 Off")];
    let now = s["sounds"].as_str().unwrap_or("essential");
    let icon = levels.iter().find(|(k, _)| *k == now).and_then(|(_, l)| l.split(' ').next()).unwrap_or("🔈");
    let items = levels.iter().map(|(k, label)| check(app, format!("set|sounds|{k}"), label, now == *k)).collect();
    sub(app, &format!("{icon} Sounds"), items)
}

fn visible_count(chars: &[Value]) -> usize {
    chars.iter().filter(|c| c["visible"].as_bool().unwrap_or(false)).count()
}

/// The stage (stage.rs): the robots on the desk to tick for it, and taking it (or leaving it).
fn stage_menu(app: &AppHandle, chars: &[Value]) -> Item {
    let on = stage::is_on(app);
    let (picked, cast) = (stage::picked(app), stage::cast(app));
    let mut items: Vec<Item> = vec![];
    if on {
        items.push(note(app, &format!("{} robots on stage", cast.len())));
        items.push(item(app, "tray|stage-exit".into(), "⎋ Off the stage, back to the desks", true));
    } else {
        items.push(note(app, "Ctrl+click robots to pick them, or tick them here"));
    }
    items.push(separator(app));
    let out: Vec<&Value> = chars.iter().filter(|c| c["visible"].as_bool().unwrap_or(false)).collect();
    for c in &out {
        let id = c["id"].as_str().unwrap_or("");
        let ticked = if on { cast.iter().any(|x| x == id) } else { picked.iter().any(|x| x == id) };
        items.push(check(app, format!("tray|stage-pick|{id}"), c["name"].as_str().unwrap_or("Robo"), ticked));
    }
    items.push(separator(app));
    if !on {
        let label = if picked.is_empty() { "▦ Take the stage".to_string() } else { format!("▦ Take the stage ({} picked)", picked.len()) };
        items.push(item(app, "tray|stage-start".into(), &label, !picked.is_empty()));
    }
    items.push(item(app, "tray|stage-all".into(), "▦ Every robot on the desk", !out.is_empty()));
    items.push(item(app, "tray|stage-last".into(), "↺ The last stage again", stage::has_last(app)));
    sub(app, if on { "▦ Stage (on now)" } else { "▦ Arrange on stage" }, items)
}

/// The tray's menu, from how things are now.
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let chars = with(app, |st| st.store.list().clone());
    let s = settings(app);
    let mut items: Vec<Item> = vec![];
    // your robots: on the desktop or put away, and back from a walk
    if chars.is_empty() {
        items.push(note(app, "No robots yet"));
    }
    for c in &chars {
        let id = c["id"].as_str().unwrap_or("");
        let label = format!("{}  {}", personalities::emoji(c["personality"].as_str().unwrap_or("")), c["name"].as_str().unwrap_or("Robo"));
        items.push(check(app, format!("tray|robot|{id}"), &label, c["visible"].as_bool().unwrap_or(false)));
    }
    for c in chars.iter().filter(|c| walkers::has(app, c["id"].as_str().unwrap_or(""))) {
        items.push(item(app, format!("tray|dock|{}", c["id"].as_str().unwrap_or("")), &format!("🚶  Call {} back to the desk", c["name"].as_str().unwrap_or("Robo")), true));
    }
    items.push(item(app, "tray|workshop".into(), "🛠️ Robot Workshop…", true));
    items.push(item(app, "tray|new".into(), "➕ New robot…", true));
    items.push(item(app, "tray|groupchat".into(), "👥 Robot group chat…", visible_count(&chars) >= 2));
    items.push(stage_menu(app, &chars));
    items.push(separator(app));

    // the features
    let (palette_keys, palette_ok) = hotkey(app, "paletteHotkey", "Ctrl+Alt+C");
    let palette_label = if palette_ok { format!("⌨️ All actions… ({palette_keys})") } else { format!("⌨️ All actions… ({palette_keys} is taken by another app)") };
    items.push(item(app, "tray|palette".into(), &palette_label, true));
    let (screen_keys, _) = hotkey(app, "screenHotkey", "Ctrl+Alt+B");
    items.push(item(app, "tray|screen".into(), &format!("🔍 Ask about part of the screen… ({screen_keys})"), true));
    let quick_model = s["quickModel"].as_str().filter(|m| !m.is_empty()).unwrap_or("haiku");
    items.push(sub(app, "✨ Quick actions", vec![
        item(app, "tray|quick".into(), &format!("✨ Quick actions on text… ({})", quick::hotkey(app)), true),
        separator(app),
        check(app, "set|quickModel|haiku".into(), "Fast brain (Haiku)", quick_model == "haiku"),
        check(app, "set|quickModel|sonnet".into(), "Better writing (Sonnet)", quick_model == "sonnet"),
        separator(app),
        hotkey_line(app, "quickHotkey", "Ctrl+Alt+R", "select text, then refine, translate or explain it"),
    ]));
    let open_notes = notes::open_count(app);
    items.push(sub(app, &format!("📒 Notes{}", if open_notes > 0 { format!(" ({open_notes} open)") } else { String::new() }), vec![
        item(app, "tray|notebook".into(), "📒 Open my notebook…", true),
        item(app, "tray|note".into(), &format!("📝 Take a note… ({})", notes::hotkey(app)), true),
        separator(app),
        hotkey_line(app, "noteHotkey", "Ctrl+Alt+N", "take a note (with what you selected)"),
    ]));
    items.push(sub(app, &format!("📚 English words ({})", vocab::count(app)), vec![
        item(app, "tray|words".into(), "📚 My words…", true),
        item(app, "tray|box-word".into(), "🔍 Box a word on screen to save it…", true),
        item(app, "tray|quiz".into(), "🃏 Quiz me now", vocab::ready_count(app) > 0),
        separator(app),
        check(app, "toggle|vocabReminders".into(), "💭 Dream about my words during the day", on(&s, "vocabReminders")),
        separator(app),
        hotkey_line(app, "vocabHotkey", "Ctrl+Alt+W", "select a word to save it"),
    ]));
    items.push(separator(app));

    let social = s["socialising"].as_str().filter(|v| !v.is_empty()).unwrap_or("sometimes");
    items.push(sub(app, "⚙️ Settings", vec![
        theme_menu(app, &s),
        sounds_menu(app, &s),
        sub(app, "🧹 Evening housemaid", vec![
            check(app, "toggle|maid".into(), "Tidies the desks at 5 pm on workdays", on(&s, "maid")),
            item(app, "tray|maid".into(), "Send her round now", !maid::active(app)),
        ]),
        sub(app, "🤝 Robots socialising", vec![
            check(app, "set|socialising|often".into(), "Often", social == "often"),
            check(app, "set|socialising|sometimes".into(), "Sometimes", social == "sometimes"),
            check(app, "set|socialising|never".into(), "Never", social == "never"),
        ]),
        check(app, "toggle|paletteDrone".into(), "🛸 A drone brings the action menu", on(&s, "paletteDrone")),
        check(app, "toggle|island".into(), "🏝️ Robot island at the screen's edge", on(&s, "island")),
        check(app, "toggle|startAtLogin".into(), "🚀 Start with Windows", on(&s, "startAtLogin")),
        separator(app),
        item(app, "tray|backups".into(), "🗄️ Open backups folder", true),
    ]));
    items.push(separator(app));

    // the installed app updates itself from GitHub Releases (updater.rs)
    let up = updater::status(app);
    match &up.ready {
        Some(v) => items.push(item(app, "tray|update".into(), &format!("⬆️ Restart to update (v{v})"), true)),
        None => {
            let how = if up.checking { " — checking…".to_string() } else if up.last.is_empty() { String::new() } else { format!(" — {}", up.last) };
            let label = format!("C-Bot {}{how}", app.package_info().version);
            items.push(item(app, "tray|check".into(), &label, updater::installed() && !up.checking));
        }
    }
    items.push(item(app, "tray|quit".into(), "Quit C-Bot", true));
    build_menu(app, items)
}

/// The tray's menu, rebuilt from how things are now.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    match tray_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => eprintln!("[tray] couldn't build the menu: {err}"),
    }
}

// ---------------------------------------------------------------- a robot's menu

/// A robot was right-clicked: its menu, by the mouse (state: is it awake, out walking?).
#[tauri::command(async)]
pub fn robot_menu(app: AppHandle, window: tauri::WebviewWindow, state: Value) -> Result<(), String> {
    let id = robots::sender(&window)?;
    let (awake, away) = (state["awake"].as_bool().unwrap_or(false), state["away"].as_bool().unwrap_or(false));
    match robot_menu_of(&app, &id, awake, away) {
        Ok(Some(menu)) => {
            let _ = window.popup_menu(&menu);
        }
        Ok(None) => {}
        Err(err) => eprintln!("[tray] couldn't build {id}'s menu: {err}"),
    }
    Ok(())
}

/// The robot's right-click menu (main.js robot:menu): grouped by feature, the everyday
/// things at the top. Out for a walk, the short one.
fn robot_menu_of(app: &AppHandle, id: &str, awake: bool, away: bool) -> tauri::Result<Option<Menu<Wry>>> {
    let Some((c, visible, terminal_open)) = with(app, |st| Some((st.store.get(id)?.clone(), visible_count(st.store.list()), st.terminals.contains_key(id)))) else {
        return Ok(None);
    };
    let s = settings(app);
    let act = |a: &str| format!("robot|{id}|{a}");
    let name = c["name"].as_str().unwrap_or("Robo");
    let open_notes = notes::open_count(app);
    let ready = vocab::ready_count(app) > 0;
    let notes_menu = || {
        sub(app, &format!("📒 Notes{}", if open_notes > 0 { format!(" ({open_notes} open)") } else { String::new() }), vec![
            item(app, act("notebook"), "📒 Open my notebook…", true),
            item(app, act("note"), "📝 Take a note…", true),
            separator(app),
            check(app, act("notes-robot"), "🔔 This robot reminds me about my notes", s["notesRobot"] == id),
        ])
    };
    let words_menu = || {
        sub(app, &format!("📚 English words ({})", vocab::count(app)), vec![
            item(app, act("words"), "📚 My words…", true),
            item(app, act("box-word"), "🔍 Box a word on screen to save it…", true),
            item(app, act("dream"), "💭 Show me one of my words", ready),
            item(app, act("quiz"), "🃏 Quiz me on a word", ready),
            separator(app),
            check(app, act("tutor"), "🎓 This robot is my word tutor", s["vocabTutor"] == id),
        ])
    };
    let settings_menu = || {
        let kinds = personalities::all()
            .iter()
            .map(|(k, p)| {
                let label = format!("{}  {}", p["emoji"].as_str().unwrap_or("🤖"), p["label"].as_str().unwrap_or(k));
                check(app, act(&format!("personality|{k}")), &label, c["personality"] == k.as_str())
            })
            .collect();
        let modes = workshop::PERMISSION_MODES.iter().map(|(k, label)| check(app, act(&format!("permission|{k}")), label, c["permissionMode"] == *k)).collect();
        sub(app, "⚙️ Settings", vec![
            sub(app, "😄 Personality", kinds),
            sub(app, "🔐 Permissions", modes),
            sounds_menu(app, &s),
            theme_menu(app, &s),
            separator(app),
            item(app, act("workshop"), "🛠️ Customize in the Workshop…", true),
        ])
    };
    if away {
        return build_menu(app, vec![
            note(app, &format!("{name} is out for a walk")),
            separator(app),
            item(app, act("dock"), "🚶 Call back to the desk", true),
            item(app, act("open-folder"), "📁 Open folder", true),
            separator(app),
            notes_menu(),
            words_menu(),
            separator(app),
            settings_menu(),
            item(app, act("hide"), "🙈 Put away (hide)", true),
        ])
        .map(Some);
    }
    let folder = c["folder"].as_str().unwrap_or("");
    let base = folder.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or(folder);
    let can_paste = clipboard::has_something();
    let (screen_keys, _) = hotkey(app, "screenHotkey", "Ctrl+Alt+B");
    let peeking = with(app, |st| st.robots.get(id).is_some_and(|r| r.peek));
    build_menu(app, vec![
        note(app, &format!("{name} — {base}")),
        separator(app),
        if awake { item(app, act("sleep"), "💤 Go to sleep", true) } else { item(app, act("wake"), "☀️ Wake up", true) },
        separator(app),
        // the chat and Claude Code
        item(app, act("new-tab"), "💬 New tab", true),
        item(app, act("history"), "🕘 Past conversations…", true),
        item(app, act("paste"), if can_paste { "📋 Paste screenshot / file from clipboard" } else { "📋 Paste (copy a screenshot or file first)" }, can_paste),
        item(app, act("screen"), &format!("🔍 Ask about part of the screen… ({screen_keys})"), true),
        item(app, act("terminal"), if terminal_open { "⌨️ Terminal is open" } else { "⌨️ Open in terminal (full Claude Code)" }, !terminal_open),
        item(app, act("shell"), "💲 Shell in my folder (Ctrl+`)", true),
        item(app, act("open-folder"), "📁 Open folder", true),
        separator(app),
        // the features
        item(app, act("stage-pick"), if stage::is_on(app) { "▦ Join the stage" } else if stage::picked(app).iter().any(|p| p == id) { "▦ Unpick for the stage" } else { "▦ Pick for the stage (Ctrl+click)" }, true),
        item(app, act("groupchat"), if groupchat::in_chat(app, id) { "👥 Group chat (in it now)…" } else { "👥 Start a group chat…" }, visible >= 2),
        item(app, act("quick"), &format!("✨ Quick actions on text… ({})", quick::hotkey(app)), true),
        notes_menu(),
        words_menu(),
        sub(app, "🎮 Play", vec![
            item(app, act("bonk"), "🔨 Bonk with the squeaky hammer (wake up / hurry up)", true),
            item(app, act("wander"), if awake { "🚶 Go for a walk" } else { "🚶 Sleepwalk" }, true),
        ]),
        separator(app),
        settings_menu(),
        if peeking { item(app, act("unpeek"), "👋 Come back to the desk", true) } else { item(app, act("peek"), "🏝️ Send away to the robot island", crate::island::on(app)) },
        item(app, act("hide"), "🙈 Put away (hide)", true),
    ])
    .map(Some)
}

// ---------------------------------------------------------------- picked

/// The text on the clipboard (Quick actions from a menu work on it), trimmed and capped.
fn clipboard_text() -> String {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    let mut text = String::new();
    unsafe {
        // (another app may hold it for a moment)
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            return text;
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        if !handle.is_null() {
            let p = GlobalLock(handle as _) as *const u16;
            if !p.is_null() {
                let mut len = 0;
                while *p.add(len) != 0 {
                    len += 1;
                }
                text = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
                GlobalUnlock(handle as _);
            }
        }
        CloseClipboard();
    }
    text.trim().chars().take(12000).collect()
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

/// A menu item was picked (the tray's or a robot's).
pub fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    if id == "tray|quit" {
        updater::install_on_quit(app); // (a new version downloaded: in it goes, on the way out)
        with(app, |st| st.store.flush());
        app.exit(0);
        return;
    }
    // (off the main thread: most of these open a window, which waits on it)
    let app = app.clone();
    thread::spawn(move || picked(&app, &id));
}

fn picked(app: &AppHandle, id: &str) {
    let parts: Vec<&str> = id.split('|').collect();
    match parts.as_slice() {
        ["set", key, value] => set(app, key, json!(value)),
        ["toggle", key] => toggle(app, key),
        ["tray", "robot", id] => {
            let visible = with(app, |st| st.store.get(id).and_then(|c| c["visible"].as_bool()).unwrap_or(false));
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
        ["tray", what] => match *what {
            "workshop" => workshop::open(app, None),
            "new" => workshop::open(app, Some("new")),
            "groupchat" => groupchat::open(app, hub::nearest_robot(app)),
            "stage-start" => stage::start(app, None),
            "stage-all" => {
                let ids = with(app, |st| st.store.list().iter().filter(|c| c["visible"].as_bool().unwrap_or(false)).filter_map(|c| c["id"].as_str().map(str::to_string)).collect());
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
        },
        ["robot", id, "personality", key] => {
            workshop::update_character(app, id, crate::util::patch(vec![("personality", json!(key))]));
        }
        ["robot", id, "permission", key] => {
            workshop::update_character(app, id, crate::util::patch(vec![("permissionMode", json!(key))]));
        }
        ["robot", id, action] => {
            let rid = Some(id.to_string());
            match *action {
                // (the page acts these out: robot.ts robot:action)
                "wake" | "sleep" | "new-tab" | "history" | "paste" | "terminal" | "shell" | "bonk" | "wander" | "peek" | "unpeek" => {
                    let _ = app.emit_to(robots::label_of(id), "robot:action", *action);
                }
                "hide" => hub::set_visible(app, id, false),
                "open-folder" => robot_ipc::open_folder(app, id),
                "dock" => walkers::dock(app, id),
                "screen" => snip::ask_screen(app, rid, None),
                "groupchat" => groupchat::open(app, rid),
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
        _ => {}
    }
}

// ---------------------------------------------------------------- the icon

/// A 16×16 pixel-art robot head, drawn at 2× for a crisp tray (main trayIcon.js).
/// . see-through  a antenna  b body  e eye  m mouth  o outline
fn tray_icon() -> Image<'static> {
    const ART: [&str; 16] = [
        ".......aa.......",
        ".......aa.......",
        "........o.......",
        "...oooooooooo...",
        "..obbbbbbbbbbo..",
        "..obbbbbbbbbbo..",
        ".oobeeebbeeeboo.",
        ".oobeeebbeeeboo.",
        ".oobeeebbeeeboo.",
        "..obbbbbbbbbbo..",
        "..obbbmmmmbbbo..",
        "..obbbbbbbbbbo..",
        "...oooooooooo...",
        ".....obbbbo.....",
        "....oooooooo....",
        "................",
    ];
    const SCALE: usize = 2;
    let size = 16 * SCALE;
    let mut rgba = Vec::with_capacity(size * size * 4);
    for y in 0..size {
        for x in 0..size {
            let px: [u8; 4] = match ART[y / SCALE].as_bytes()[x / SCALE] {
                b'a' => [255, 94, 98, 255],
                b'b' => [90, 200, 250, 255],
                b'e' => [255, 255, 255, 255],
                b'm' | b'o' => [30, 40, 60, 255],
                _ => [0, 0, 0, 0],
            };
            rgba.extend_from_slice(&px);
        }
    }
    Image::new_owned(rgba, size as u32, size as u32)
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("main")
        .icon(tray_icon())
        .tooltip("C-Bot")
        // a click opens the Workshop; the menu is on the right button
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                workshop::open(tray.app_handle(), None);
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}
