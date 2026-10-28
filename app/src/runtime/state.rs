//! The app's state, shared by every module under one lock (with()), and each part's own state
//! (part(), part_if(), part_or_default(): what a module put in with `app.manage(Mutex::new(…))`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

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

/// A lock that a panic while it was held doesn't leave unusable: what's in it is still used
/// (a part of the app carries on rather than going down with one bad moment).
pub trait Locked<T> {
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Do something with the app's state, under its lock. Keep it short, and never call
/// into a window from inside (see robots/mod.rs).
pub fn with<R>(app: &AppHandle, f: impl FnOnce(&mut State) -> R) -> R {
    f(&mut app.state::<Mutex<State>>().locked())
}

/// Do something with a part's own state, under its lock (it's there from the part's setup on).
pub fn part<T: Send + 'static, R>(app: &AppHandle, f: impl FnOnce(&mut T) -> R) -> R {
    f(&mut app.state::<Mutex<T>>().locked())
}

/// The same, or None before the part's setup (asked for early, as the tray is while it's built).
pub fn part_if<T: Send + 'static, R>(app: &AppHandle, f: impl FnOnce(&mut T) -> R) -> Option<R> {
    Some(f(&mut app.try_state::<Mutex<T>>()?.locked()))
}

/// The same, with a fresh default meanwhile before the part's setup (and in tests).
pub fn part_or_default<T: Default + Send + 'static, R>(
    app: &AppHandle,
    f: impl FnOnce(&mut T) -> R,
) -> R {
    match app.try_state::<Mutex<T>>() {
        Some(state) => f(&mut state.locked()),
        None => f(&mut T::default()),
    }
}
