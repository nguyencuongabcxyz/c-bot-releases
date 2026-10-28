//! Updates for the installed app (main updater.js): checks GitHub Releases at start and
//! every few hours, downloads a newer version in the background, and installs it the next
//! time C-Bot quits from the tray, or straight away from the tray's "Restart to update".
//! A build run from source does nothing (it would only nag). The releases are signed: the
//! public key is in tauri.conf.json (plugins.updater), the endpoint is the latest
//! release's latest.json. [wave 1: shell]

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::features::chat;
use crate::runtime::{Error, part_if, with};
use crate::ui::tray;

const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// Where it's at, for the tray: a downloaded version waiting for a restart, checking now,
/// and the last check's outcome ("up to date", "couldn't check"…).
#[derive(Clone, Debug, Default)]
pub struct Status {
    pub ready: Option<String>,
    pub checking: bool,
    pub last: String,
}

#[derive(Default)]
struct Updates {
    status: Status,
    downloaded: Option<(Update, Vec<u8>)>, // the new version, checked against its signature
}

fn updates<R>(app: &AppHandle, f: impl FnOnce(&mut Updates) -> R) -> Option<R> {
    part_if(app, f)
}

/// Is this the installed app (Electron's app.isPackaged)? A build run from source lives in
/// cargo's target folder.
pub fn installed() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    !exe.ancestors().any(|d| {
        d.file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("target"))
    })
}

pub fn status(app: &AppHandle) -> Status {
    updates(app, |u| u.status.clone()).unwrap_or_default()
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    updates(app, |u| f(&mut u.status));
    tray::refresh(app);
}

/// Check now (at start, every few hours, and the tray's version line).
pub fn check(app: &AppHandle) {
    if !installed() {
        return;
    }
    // (one check at a time; a version already downloaded just waits for the restart)
    let go = updates(app, |u| {
        let go = !u.status.checking && u.downloaded.is_none();
        if go {
            u.status.checking = true;
        }
        go
    });
    if go != Some(true) {
        return;
    }
    tray::refresh(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match fetch(&app).await {
            Ok(None) => set_status(&app, |s| {
                s.checking = false;
                s.last = "up to date".into();
            }),
            Ok(Some(version)) => {
                set_status(&app, |s| {
                    s.checking = false;
                    s.ready = Some(version.clone());
                });
                let body = format!(
                    "Version {version} installs when C-Bot restarts. Right-click the tray icon → Restart to update."
                );
                let _ = app
                    .notification()
                    .builder()
                    .title("C-Bot update ready")
                    .body(body)
                    .show();
            }
            Err(err) => {
                eprintln!("[update] {err}");
                set_status(&app, |s| {
                    s.checking = false;
                    s.last = "couldn't check".into();
                });
            }
        }
    });
}

/// Ask GitHub; a newer version is downloaded (and its signature checked) right away.
async fn fetch(app: &AppHandle) -> Result<Option<String>, Error> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    set_status(app, |s| s.last = format!("downloading {version}…"));
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    updates(app, |u| u.downloaded = Some((update, bytes)));
    Ok(Some(version))
}

/// Run the downloaded installer (quietly) and leave: everything is saved first, as the
/// installer needs C-Bot gone. restart: start the new version once it's in.
fn install(app: &AppHandle, restart: bool) {
    let Some(Some((update, bytes))) = updates(app, |u| u.downloaded.take()) else {
        return;
    };
    chat::close_all(app);
    with(app, |st| st.store.flush());
    // (on success this doesn't come back: the installer takes over)
    if let Err(err) = update.restart_after_install(restart).install(&bytes) {
        eprintln!("[update] couldn't install: {err}");
        set_status(app, |s| {
            s.ready = None;
            s.last = "couldn't update".into();
        });
    }
}

/// Install the downloaded version and start it (the tray's "Restart to update").
pub fn restart(app: &AppHandle) {
    install(app, true);
}

/// Quitting with a new version downloaded: it goes in on the way out (electron-updater's
/// autoInstallOnAppQuit). Doesn't come back if it does.
pub fn install_on_quit(app: &AppHandle) {
    install(app, false);
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Updates::default()));
    if !installed() {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        loop {
            check(&app);
            thread::sleep(CHECK_EVERY);
        }
    });
}
