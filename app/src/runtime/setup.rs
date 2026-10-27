//! Starting up (the state, then each part in the order they need each other, then the
//! robots out on the desk) and shutting down.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::{App, AppHandle, Manager, RunEvent};

use crate::features::{chat, notes, vocab};
use crate::features::chat::awake;
use crate::mcp::{apps, link};
use crate::robots;
use crate::robots::{island, maid, planes, revive, screens, social, stage, topmost, walkers};
use crate::runtime::updater;
use crate::store::Store;
use crate::ui::{tray, workshop};
use crate::workbench::{capture, palette, paste, quick, shell, snip, terminal};
use super::{hub, migrate, with, State};
use super::paths::{self, electron_data_dir};

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    paths::init(app.handle()); // (first: where the user's folders are)
    // (CBOT_DATA_DIR: somewhere else, to try things without touching your robots)
    let dir = match std::env::var_os("CBOT_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir()?,
    };
    let store = Store::open(&dir, electron_data_dir());
    if let Some(r) = &store.recovered {
        eprintln!(
            "[store] recovered from {:?}; the damaged file was kept as {}",
            r.from,
            r.broken.display()
        );
    }
    let mut st = State {
        store,
        robots: HashMap::new(),
        chats: HashMap::new(),
        model_choices: json!([]),
        terminals: HashMap::new(),
        data_dir: dir,
    };
    migrate::migrate_looks(&mut st);
    let visible: Vec<String> = st
        .store
        .list()
        .iter()
        .filter(|c| c["visible"].as_bool().unwrap_or(false))
        .filter_map(|c| c["id"].as_str().map(str::to_string))
        .collect();
    let order: Vec<String> = st
        .store
        .list()
        .iter()
        .filter_map(|c| c["id"].as_str().map(str::to_string))
        .collect();
    let no_robots = order.is_empty();
    app.manage(Mutex::new(st));

    let handle = app.handle().clone();
    chat::sweep_temporary(&handle); // (temporary chats left open when it last quit)
    hub::setup(&handle);
    revive::setup(&handle); // (before the robots: it watches each as it opens)
    tray::setup(&handle)?;
    // the feature modules (each keeps its own state, binds its own hotkeys)
    capture::setup(&handle);
    paste::setup(&handle);
    snip::setup(&handle);
    walkers::setup(&handle);
    planes::setup(&handle);
    social::setup(&handle);
    maid::setup(&handle);
    vocab::setup(&handle);
    notes::setup(&handle);
    quick::setup(&handle);
    palette::setup(&handle);
    link::setup(&handle);
    apps::setup(&handle);
    chat::group::setup(&handle);
    terminal::setup(&handle);
    shell::setup(&handle);
    updater::setup(&handle);
    workshop::setup(&handle);

    for id in &visible {
        let index = order.iter().position(|o| o == id).unwrap_or(0);
        if let Err(err) = robots::open(&handle, id, index) {
            eprintln!("[robots] couldn't open {id}: {err}");
        }
    }
    if no_robots {
        workshop::open(&handle, Some("new"));
    }
    stage::setup(&handle);
    island::setup(&handle); // (once the robots are out: their faces, at the screen's edge)
    robots::watch_cursor(handle.clone());
    chat::close_idle(handle.clone());
    awake::setup(&handle); // (the PC stays awake while Remote Control is on)
    {
        let h = handle.clone();
        thread::spawn(move || chat::revive_remote(&h)); // (Remote Control left on: reachable again)
    }
    topmost::setup(&handle); // (robots that lost "always on top" get it back)
    screens::setup(&handle); // (screens changing, a sleep, an unlock)
    // changes are saved a moment after they happen (store/mod.rs save)
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(100));
            with(&handle, |st| st.store.tick());
        }
    });
    Ok(())
}

pub fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        // it lives in the tray: closing every window doesn't quit it
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            chat::close_all(app);
            shell::close_all(app);
            with(app, |st| st.store.flush());
        }
        _ => {}
    }
}
