//! Where things are: the user's own folders (as Tauri's path resolver finds them on this
//! system, taken once at start for the parts that have no AppHandle), the folders the chat
//! may show files from, and the Electron app's data.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use super::with;

struct Dirs {
    home: PathBuf,
    data: PathBuf,       // %APPDATA% on Windows, ~/Library/Application Support, ~/.local/share
    local_data: PathBuf, // %LOCALAPPDATA% on Windows (the same as data elsewhere)
}

static DIRS: OnceLock<Dirs> = OnceLock::new();

/// Look them up (first thing at start: setup.rs).
pub fn init(app: &AppHandle) {
    let p = app.path();
    let home = p.home_dir().unwrap_or_default();
    let _ = DIRS.set(Dirs {
        data: p.data_dir().unwrap_or_else(|_| home.clone()),
        local_data: p.local_data_dir().unwrap_or_else(|_| home.clone()),
        home,
    });
}

fn dirs() -> &'static Dirs {
    // (before init, as in the tests: std's own idea of home)
    DIRS.get_or_init(|| {
        let home = std::env::home_dir().unwrap_or_default();
        Dirs { data: home.clone(), local_data: home.clone(), home }
    })
}

/// The user's home folder.
pub fn home() -> PathBuf {
    dirs().home.clone()
}

/// Where apps keep their data (roaming, on Windows).
pub fn data() -> PathBuf {
    dirs().data.clone()
}

/// Where apps keep their machine-local data (and installs, on Windows).
pub fn local_data() -> PathBuf {
    dirs().local_data.clone()
}

/// The folders pictures in the chat may come from: the user's home, temp, pasted
/// screenshots and the robots' folders. Not, say, C:\Windows. (The file viewer too.)
pub fn picture_roots(app: &AppHandle) -> Vec<String> {
    let mut roots = vec![home().to_string_lossy().into_owned(), std::env::temp_dir().to_string_lossy().into_owned()];
    with(app, |st| {
        roots.push(st.data_dir.join("attachments").to_string_lossy().into_owned());
        roots.extend(st.store.list().iter().filter_map(|c| c["folder"].as_str().map(str::to_string)));
    });
    roots
}

/// Where the Electron app kept its data (%APPDATA%\C-Bot): its files are copied over on
/// this app's first run (store/mod.rs, and the modules that keep files of their own).
pub fn electron_data_dir() -> Option<PathBuf> {
    Some(data().join("C-Bot"))
}
