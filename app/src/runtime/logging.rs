//! What the app writes down as it goes (mostly what went wrong: a window that couldn't open,
//! a save that failed), into a file, since an app with windows has no console on Windows.
//! The installed app's go to its logs folder (%LOCALAPPDATA%\com.cbot.desktop\logs), a test
//! copy's (CBOT_DATA_DIR) to a logs folder of its own. Panics go there too.

use std::path::PathBuf;

use log::LevelFilter;
use tauri::Runtime;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const MAX_FILE: u128 = 2_000_000; // bytes in a log file, then a new one
const FILES_KEPT: usize = 3;

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let file = match std::env::var_os("CBOT_DATA_DIR") {
        Some(dir) => TargetKind::Folder {
            path: PathBuf::from(dir).join("logs"),
            file_name: None,
        },
        None => TargetKind::LogDir { file_name: None },
    };
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(file))
        .target(Target::new(TargetKind::Stdout)) // (run from a terminal: there too)
        .level(LevelFilter::Info)
        // (the context engine's database and its download say a lot as they go: only what's wrong)
        .level_for("tracing", LevelFilter::Warn)
        .level_for("postgresql_archive", LevelFilter::Warn)
        .level_for("postgresql_embedded", LevelFilter::Warn)
        .level_for("reqwest_tracing", LevelFilter::Warn)
        .level_for("sqlx", LevelFilter::Warn)
        .level_for("tantivy", LevelFilter::Warn)
        .max_file_size(MAX_FILE)
        .rotation_strategy(RotationStrategy::KeepSome(FILES_KEPT))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}

/// A panic is written down too, before Rust's own report (which nobody sees).
pub fn log_panics() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("{info}");
        report(info);
    }));
}
