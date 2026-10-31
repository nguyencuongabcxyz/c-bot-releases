//! The tray icon and its menu (menu.rs), and a robot's right-click menu (robot.rs) (main.js
//! refreshTray and robot:menu); what a picked item does is picked.rs. Menu item ids are
//! "<where>|<what>…": tray|<action>[|<id>], robot|<id>|<action>[|<arg>], and
//! set|<setting>|<value> / toggle|<setting> for the settings either menu changes. Radio
//! items are check items (Tauri has no radios): the menu is rebuilt after every change, so
//! the tick always lands on the one picked.

mod menu;
mod picked;
mod robot;

pub use robot::*;

use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::image::Image;
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::agents::personalities;
use crate::context;
use crate::features::chat::group;
use crate::features::{notes, routines, vocab};
use crate::robots;
use crate::robots::{maid, stage, walkers};
use crate::runtime::{Error, hub, updater, with};
use crate::store::Fields;
use crate::ui::{views, workshop};
use crate::workbench::palette;

pub type MenuItems = Vec<Box<dyn IsMenuItem<Wry>>>;
type Item = tauri::Result<Box<dyn IsMenuItem<Wry>>>;

// ---------------------------------------------------------------- building menus

pub fn item(app: &AppHandle, id: String, label: &str, enabled: bool) -> Item {
    Ok(Box::new(MenuItem::with_id(
        app,
        id,
        label,
        enabled,
        None::<&str>,
    )?))
}

/// A line that says something (greyed out).
fn note(app: &AppHandle, label: &str) -> Item {
    item(app, "none".into(), label, false)
}

fn check(app: &AppHandle, id: String, label: &str, checked: bool) -> Item {
    Ok(Box::new(CheckMenuItem::with_id(
        app,
        id,
        label,
        true,
        checked,
        None::<&str>,
    )?))
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

// ---------------------------------------------------------------- what both menus show

/// A hotkey's keys and whether it works (no other app has it). Until its feature has
/// bound it: its keys, assumed fine.
fn hotkey(app: &AppHandle, setting: &str, default: &str) -> (String, bool) {
    hub::hotkey_status(app, setting)
        .unwrap_or_else(|| (hub::hotkey_keys(app, setting, default), true))
}

fn settings(app: &AppHandle) -> Value {
    with(app, |st| st.store.settings().clone())
}

/// On unless turned off (the settings that default to on).
fn on(settings: &Value, key: &str) -> bool {
    settings[key].as_bool() != Some(false)
}

fn visible_count(chars: &[Value]) -> usize {
    chars.iter().filter(|c| c.visible()).count()
}

/// The notes submenu's title: how many are still open.
fn notes_title(app: &AppHandle) -> String {
    match notes::open_count(app) {
        0 => "📒 Notes".into(),
        open => format!("📒 Notes ({open} open)"),
    }
}

/// The words submenu's title: how many are saved.
fn words_title(app: &AppHandle) -> String {
    format!("📚 English words ({})", vocab::count(app))
}

/// Two looks for every window, each light or dark (or following Windows).
fn theme_menu(app: &AppHandle, s: &Value) -> Item {
    let now = views::theme_of(s);
    let themes = [
        ("vintage", "📜  Vintage notebook"),
        ("future", "🛰️  Future tech"),
    ];
    let modes = [
        ("auto", "Follow Windows light / dark"),
        ("light", "Always light"),
        ("dark", "Always dark"),
    ];
    let mut items: Vec<Item> = themes
        .iter()
        .map(|(k, label)| check(app, format!("set|theme|{k}"), label, now["theme"] == *k))
        .collect();
    items.push(separator(app));
    items.extend(
        modes
            .iter()
            .map(|(k, label)| check(app, format!("set|themeMode|{k}"), label, now["mode"] == *k)),
    );
    sub(app, "🎨 Theme", items)
}

/// Robot sounds: just the ones that matter (the default), all of them, or none.
fn sounds_menu(app: &AppHandle, s: &Value) -> Item {
    let levels = [
        ("essential", "🔈 Essential only"),
        ("all", "🔊 Everything"),
        ("off", "🔇 Off"),
    ];
    let now = s["sounds"].as_str().unwrap_or("essential");
    let icon = levels
        .iter()
        .find(|(k, _)| *k == now)
        .and_then(|(_, l)| l.split(' ').next())
        .unwrap_or("🔈");
    let items = levels
        .iter()
        .map(|(k, label)| check(app, format!("set|sounds|{k}"), label, now == *k))
        .collect();
    sub(app, &format!("{icon} Sounds"), items)
}

// ---------------------------------------------------------------- the tray

/// The tray's menu, rebuilt from how things are now.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    match menu::tray_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => log::warn!("couldn't build the menu: {err}"),
    }
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
    thread::spawn(move || picked::picked(&app, &id));
}

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
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                workshop::open(tray.app_handle(), None);
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}
