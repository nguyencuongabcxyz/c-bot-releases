//! "Open with C-Bot" in Explorer's right-click menu on a folder: the robot that looks after
//! that folder comes out with its chat open, or a new one is made for it (named after the
//! folder) when none does. Explorer starts C-Bot with `--open-folder "<folder>"`; a C-Bot
//! already running hears it from the second launch (main.rs).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::thread;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::platform::explorer;
use crate::runtime::{hub, migrate, part_or_default, with};
use crate::store::Fields;
use crate::ui::workshop;

/// What Explorer starts C-Bot with, before the folder.
const ARG: &str = "--open-folder";

/// A new robot's paint, in turn (the Workshop's own, gui/views/workshop/choices.ts COLORS).
const COLORS: [&str; 8] = [
    "#5ac8fa", "#ff9f43", "#7bed9f", "#ff6b81", "#a29bfe", "#feca57", "#c8d6e5", "#ffffff",
];

/// Robots whose window is on its way: they wake with their chat open once their page loads.
#[derive(Default)]
struct Waking(HashSet<String>);

fn waking<R>(app: &AppHandle, f: impl FnOnce(&mut Waking) -> R) -> R {
    part_or_default(app, f)
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Waking::default()));
}

/// The menu entry, pointing at this C-Bot (not for a test copy on data of its own).
pub fn register() {
    if std::env::var_os("CBOT_DATA_DIR").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    thread::spawn(move || {
        if let Err(e) = explorer::register_folder_entry("C-Bot", "Open with C-Bot", &exe, ARG) {
            log::warn!("Explorer's right-click menu won't offer C-Bot: {e}");
        }
    });
}

/// C-Bot was just started from the menu: is that why? (Then it needn't open the Workshop
/// for a first robot: one is on its way.)
pub fn asked_at_start() -> bool {
    folder_in(&std::env::args().collect::<Vec<_>>()).is_some()
}

/// Started from the menu: once the robots are out, the folder's robot too.
pub fn open_at_start(app: &AppHandle) {
    open_from_args(app, &std::env::args().collect::<Vec<_>>(), true);
}

/// A second launch from the menu, while C-Bot runs. False: it wasn't one.
pub fn open_from_args(app: &AppHandle, args: &[String], starting: bool) -> bool {
    let Some(folder) = folder_in(args) else {
        return false;
    };
    let app = app.clone();
    thread::spawn(move || open_folder(&app, &folder, starting)); // (it may build a window)
    true
}

/// Its page loaded: should it wake with its chat open? (Asked once.)
pub fn wakes(app: &AppHandle, id: &str) -> bool {
    waking(app, |w| w.0.remove(id))
}

fn open_folder(app: &AppHandle, folder: &str, starting: bool) {
    if !Path::new(folder).is_dir() {
        log::warn!("Open with C-Bot: {folder} isn't a folder");
        return;
    }
    let (found, count) = with(app, |st| {
        let list = st.store.list();
        let found = list
            .iter()
            .find(|c| same_folder(c.folder(), folder))
            .map(|c| c.id().to_string());
        (found, list.len())
    });
    let id = match found {
        Some(id) => id,
        None => workshop::add(app, &new_robot(folder, count))
            .id()
            .to_string(),
    };
    // (a page that's loaded hears it now; one still loading asks when it's ready)
    let loaded = !starting && with(app, |st| st.robots.contains_key(&id));
    if loaded {
        hub::send_to_robot(app, &id, "robot:action", json!("chat"));
    } else {
        waking(app, |w| w.0.insert(id.clone()));
        hub::set_visible(app, &id, true);
    }
}

/// What a robot made for a folder is like: its name, and the classic robot in the next paint.
fn new_robot(folder: &str, count: usize) -> Value {
    let color = COLORS[count % COLORS.len()];
    json!({
        "name": name_for(folder),
        "folder": folder,
        "color": color,
        "body": "kit",
        "kit": migrate::kit_like("robot", color),
    })
}

/// The folder in Explorer's command line, if it's there.
fn folder_in(args: &[String]) -> Option<String> {
    let at = args.iter().position(|a| a == ARG)?;
    let folder = args.get(at + 1)?.trim().trim_matches('"');
    (!folder.is_empty()).then(|| folder.to_string())
}

/// The folder's own name ("C" for the root of C:\).
fn name_for(folder: &str) -> String {
    let trimmed = folder.trim_end_matches(['\\', '/']);
    let last = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    last.trim_end_matches(':').to_string()
}

/// The same folder, however it's written (Windows doesn't mind the case or the slashes).
fn same_folder(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        p.trim()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    !a.trim().is_empty() && norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn finds_the_folder_after_its_flag() {
        let a = args(&["c-bot.exe", "--open-folder", r"C:\Work\shop"]);
        assert_eq!(folder_in(&a).as_deref(), Some(r"C:\Work\shop"));
    }

    #[test]
    fn no_flag_or_no_folder_is_none() {
        assert_eq!(folder_in(&args(&["c-bot.exe"])), None);
        assert_eq!(folder_in(&args(&["c-bot.exe", "--open-folder"])), None);
        assert_eq!(folder_in(&args(&["c-bot.exe", "--open-folder", " "])), None);
    }

    #[test]
    fn names_a_robot_after_its_folder() {
        assert_eq!(name_for(r"C:\Users\me\Desktop\My App"), "My App");
        assert_eq!(name_for(r"C:\Users\me\shop\"), "shop");
        assert_eq!(name_for(r"D:\"), "D");
    }

    #[test]
    fn the_same_folder_however_written() {
        assert!(same_folder(r"C:\Work\Shop", "c:/work/shop/"));
        assert!(same_folder(r"D:\", "D:"));
        assert!(!same_folder(r"C:\Work\Shop", r"C:\Work\Shop2"));
        assert!(!same_folder("", ""));
    }

    #[test]
    fn a_new_robot_is_the_classic_build_in_the_next_paint() {
        let r = new_robot(r"C:\Work\shop", 1);
        assert_eq!(r["name"], "shop");
        assert_eq!(r["color"], "#ff9f43");
        assert_eq!(r["body"], "kit");
        assert!(r["kit"].is_object());
    }
}
