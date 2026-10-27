//! The app's state, shared by every module under one lock (with()).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::features::chat::Chat;
use crate::robots::Robot;
use crate::store::Store;

pub struct State {
    pub store: Store,
    pub robots: HashMap<String, Robot>,
    pub chats: HashMap<String, Arc<Chat>>, // "robotId|tabId" -> its live conversation
    pub model_choices: Value, // learned from Claude Code: [{ value, displayName, description, efforts }]
    pub terminals: HashMap<String, String>, // robot id -> its tab open in a terminal (workbench/terminal.rs)
    pub data_dir: PathBuf,
}

/// Do something with the app's state, under its lock. Keep it short, and never call
/// into a window from inside (see robots/mod.rs).
pub fn with<R>(app: &AppHandle, f: impl FnOnce(&mut State) -> R) -> R {
    let state = app.state::<Mutex<State>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}
