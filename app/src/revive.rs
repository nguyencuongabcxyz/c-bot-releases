//! Bringing back robots that vanished. Their windows are see-through, so a robot whose page
//! died (or just stopped drawing) disappears while its window is still there, and the tray
//! still ticks it. Caught three ways:
//! - WebView2 says a page's process went (ProcessFailed): the robot's window is built again.
//! - After a sleep or an unlock (screens.rs), every robot's webview is told it's hidden and
//!   shown again, so WebView2 works out afresh that it's on screen and draws it.
//! - Each robot page checks in every few seconds (robot_alive). One that stops checking in
//!   is built again; one that thinks it's hidden while its window shows on top is nudged as
//!   after a wake.
//!
//! (And a robot whose 3D canvas lost the GPU for good asks to be built again: robot_revive.)
//!
//! Building again is what putting it away and back out from the tray does: a fresh page, its
//! chats (kept here, not in the page) carry on.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;

use crate::{robots, screens, win, with};

const EVERY: Duration = Duration::from_secs(5);
// a look that comes this late means the PC was asleep (pages checked in meanwhile or not)
const SLEPT: Duration = Duration::from_secs(30);
// no word from a page for this long: it's gone (a hidden page's timers may run just once a minute)
const SILENT: Duration = Duration::from_secs(180);
// a page that thinks it's hidden while its window shows, this long: nudged, at most so often
const HIDDEN_FOR: Duration = Duration::from_secs(10);
const NUDGE_EVERY: Duration = Duration::from_secs(60);
// built again at most this many times in this long (a page that dies as it starts would loop)
const REBUILDS: usize = 3;
const REBUILDS_IN: Duration = Duration::from_secs(600);
// the browser process going takes every window with it: the others are cleared out once
const BROWSER_GONE_ONCE: Duration = Duration::from_secs(10);

/// A robot page's last word.
struct Pulse {
    at: Instant,
    hidden_since: Option<Instant>,
    nudged: Option<Instant>,
}

impl Pulse {
    fn new() -> Self {
        Pulse { at: Instant::now(), hidden_since: None, nudged: None }
    }
}

#[derive(Default)]
struct Revive {
    pulses: HashMap<String, Pulse>,
    rebuilt: HashMap<String, Vec<Instant>>,
    browser_gone: Option<Instant>,
}

fn rv<R>(app: &AppHandle, f: impl FnOnce(&mut Revive) -> R) -> R {
    let state = app.state::<Mutex<Revive>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

// ---------------------------------------------------------------- a robot's window

/// A robot's window was just built: listen for its page's processes failing.
pub fn watch(app: &AppHandle, window: &WebviewWindow, id: &str) {
    rv(app, |r| r.pulses.insert(id.to_string(), Pulse::new()));
    let (app, id) = (app.clone(), id.to_string());
    let _ = window.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                let _ = args.ProcessFailedKind(&mut kind);
            }
            let why = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "its page's process exited",
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "its page stopped responding",
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "the WebView2 browser process exited",
                // (the GPU process WebView2 restarts itself; the page gets its canvas back)
                _ => return Ok(()),
            };
            let browser = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
            let (app, id) = (app.clone(), id.clone());
            // (off the main thread: this runs on it, and building a window waits on it)
            thread::spawn(move || {
                if browser {
                    clear_dead_windows(&app);
                }
                rebuild(&app, &id, why);
            });
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

/// Its window went (put away, or built again).
pub fn forget(app: &AppHandle, id: &str) {
    rv(app, |r| r.pulses.remove(id));
}

/// Close its window and build it again, if it's still meant to be out. Not on the main thread.
pub fn rebuild(app: &AppHandle, id: &str, why: &str) {
    let allowed = rv(app, |r| {
        let times = r.rebuilt.entry(id.to_string()).or_default();
        times.retain(|t| t.elapsed() < REBUILDS_IN);
        let ok = times.len() < REBUILDS;
        if ok {
            times.push(Instant::now());
        }
        ok
    });
    if !allowed {
        eprintln!("[revive] {id}: {why}, but it was built again {REBUILDS} times lately; leaving it be");
        return;
    }
    eprintln!("[revive] {id}: {why}; building its window again");
    let label = robots::label_of(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    // (its label is free once it's gone)
    for _ in 0..60 {
        if app.get_webview_window(&label).is_none() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let index = with(app, |st| {
        let list = st.store.list();
        let i = list.iter().position(|c| c["id"] == id)?;
        list[i]["visible"].as_bool().unwrap_or(false).then_some(i)
    });
    let Some(index) = index else { return }; // (put away meanwhile, or deleted)
    if let Err(err) = robots::open(app, id, index) {
        eprintln!("[revive] couldn't open {id} again: {err}");
    }
}

/// The browser process went: every window's page went with it. The robots are built again
/// (each hears it too); the rest are closed, and their features make them again when wanted.
fn clear_dead_windows(app: &AppHandle) {
    let first = rv(app, |r| {
        let first = r.browser_gone.is_none_or(|t| t.elapsed() > BROWSER_GONE_ONCE);
        if first {
            r.browser_gone = Some(Instant::now());
        }
        first
    });
    if !first {
        return;
    }
    for (label, w) in app.webview_windows() {
        if robots::id_of(&label).is_none() {
            let _ = w.destroy();
        }
    }
}

/// Tell its webview it's hidden and shown again: WebView2 works out afresh whether it's on
/// screen, and draws it (it can miss that after a sleep, and leave the window blank).
fn nudge(app: &AppHandle, id: &str) {
    let Some(w) = app.get_webview_window(&robots::label_of(id)) else { return };
    let _ = w.with_webview(|wv| unsafe {
        let c = wv.controller();
        let _ = c.SetIsVisible(false);
        let _ = c.SetIsVisible(true);
        let _ = c.NotifyParentWindowPositionChanged();
    });
}

/// After a sleep or an unlock (screens.rs): every robot that's showing.
pub fn nudge_all(app: &AppHandle) {
    for id in robots::open_ids(app) {
        if robots::hwnd_of(app, &id).is_some_and(win::is_visible) {
            nudge(app, &id);
        }
    }
}

// ---------------------------------------------------------------- what the page says

/// A robot page checking in (every few seconds, and when it's hidden or shown).
#[tauri::command(async)]
pub fn robot_alive(app: AppHandle, window: WebviewWindow, hidden: bool) -> Result<(), String> {
    let id = robots::sender(&window)?;
    rv(&app, |r| {
        let p = r.pulses.entry(id).or_insert_with(Pulse::new);
        p.at = Instant::now();
        p.hidden_since = if hidden { p.hidden_since.or(Some(p.at)) } else { None };
    });
    Ok(())
}

/// The robot's 3D canvas lost the GPU and didn't get it back: build it again.
#[tauri::command(async)]
pub fn robot_revive(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let id = robots::sender(&window)?;
    rebuild(&app, &id, "its 3D canvas lost the GPU");
    Ok(())
}

// ---------------------------------------------------------------- the watch

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Revive::default()));
    let app = app.clone();
    thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            thread::sleep(EVERY);
            let slept = last.elapsed() > SLEPT;
            last = Instant::now();
            // asleep or locked, the pages may well say nothing, or that they're hidden
            if slept || screens::locked() {
                rv(&app, |r| r.pulses.values_mut().for_each(|p| *p = Pulse::new()));
                continue;
            }
            let mut silent = vec![];
            let mut nudges = vec![];
            for id in robots::open_ids(&app) {
                let showing = robots::hwnd_of(&app, &id).is_some_and(win::is_visible);
                let away = robots::is_away(&app, &id); // (veiled on the island: it may think it's hidden, rightly)
                rv(&app, |r| {
                    let p = r.pulses.entry(id.clone()).or_insert_with(Pulse::new);
                    if !showing {
                        // (hidden on purpose, out for a walk: its page may rest)
                        *p = Pulse::new();
                    } else if p.at.elapsed() > SILENT {
                        *p = Pulse::new();
                        silent.push(id.clone());
                    } else if !away && p.hidden_since.is_some_and(|t| t.elapsed() > HIDDEN_FOR) && p.nudged.is_none_or(|t| t.elapsed() > NUDGE_EVERY) {
                        p.nudged = Some(Instant::now());
                        nudges.push(id.clone());
                    }
                });
            }
            for id in nudges {
                eprintln!("[revive] {id}: its page thinks it's hidden; nudging it");
                nudge(&app, &id);
            }
            for id in silent {
                rebuild(&app, &id, "its page stopped checking in");
            }
        }
    });
}
