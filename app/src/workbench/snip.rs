//! Drag a box round part of the screen (main snip.js, and main.js askScreen / screenShot):
//! the screen under the mouse is captured and shown dimmed in a window over it; the box you
//! drag is cut out. "Ask about part of the screen" hands it to a robot as a pasted picture;
//! the word box (features/vocab/mod.rs) reads a word off it. Window label "snip". [wave 1: input]
//!
//! Esc, a click without a drag, a right-click or switching away cancels (the page says so,
//! or the window loses focus).

use std::io::Cursor;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};
use serde_json::{Value, json};
use tauri::window::Color;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt;

use crate::platform::{screenshot, window};
use crate::robots;
use crate::robots::walkers;
use crate::runtime::hub::Hotkey;
use crate::runtime::util::only;
use crate::runtime::{Error, Locked, hub, with};
use crate::ui::views;
use crate::workbench::{capture, files, paste};

/// What to do with the box once it's dragged: its PNG bytes. (Not called if you cancel.)
pub type OnShot = Box<dyn FnOnce(&AppHandle, Vec<u8>) + Send>;

const LABEL: &str = "snip";
const ASK_HINT: &str = "🔍 Drag a box round what you want to ask about · Esc to cancel";
// a box smaller than this (physical px) is a click, not a box
const MIN_BOX: i64 = 6;
// losing the focus to one of our own windows this soon after it opens isn't switching away
const GRACE: Duration = Duration::from_secs(1);
const SETTLE: Duration = Duration::from_millis(50);

/// The screen as it was when the snip started, while its window is up.
struct Shot {
    round: u64, // which snip (a late event from a closed window mustn't end the next one)
    image: RgbaImage,
    scale: f64, // the monitor's: the page's CSS px times this are the capture's px
    hint: String,
    data_url: String,
    on_shot: OnShot,
}

static SHOT: Mutex<Option<Shot>> = Mutex::new(None);
static ROUND: AtomicU64 = AtomicU64::new(0);
static STARTING: AtomicBool = AtomicBool::new(false);

// (never held across a window call: the window's events, on the main thread, take it too)
fn take_shot(round: Option<u64>) -> Option<Shot> {
    let mut shot = SHOT.locked();
    if round.is_some_and(|g| shot.as_ref().map(|s| s.round) != Some(g)) {
        return None;
    }
    shot.take()
}

fn is_up(round: u64) -> bool {
    SHOT.locked().as_ref().is_some_and(|s| s.round == round)
}

fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// The dragged box (the page's CSS px) in the capture's pixels, cut to fit it: (x, y, w, h).
/// None if it's too small to be a box (main snip.js snip:done).
pub fn crop_box(b: &Value, scale: f64, (iw, ih): (u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let px = |k: &str| (b[k].as_f64().unwrap_or(0.0) * scale).round() as i64;
    let (x, y) = (px("x").max(0), px("y").max(0));
    let w = (iw as i64 - x).min(px("width"));
    let h = (ih as i64 - y).min(px("height"));
    if w < MIN_BOX || h < MIN_BOX {
        return None;
    }
    Some((x as u32, y as u32, w as u32, h as u32))
}

/// The capture for the page to show (a quick PNG: it's on screen for a moment).
fn data_url(image: &RgbaImage) -> Option<String> {
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

fn png_bytes(image: &RgbaImage) -> Option<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Capture the screen under the mouse and let the user drag a box (hint: the line at the
/// top; hide_robots: fade the robot windows out of the way first).
pub fn start(app: &AppHandle, hint: &str, hide_robots: bool, on_shot: OnShot) -> Result<(), Error> {
    // one box at a time (a second press of the hotkey while one's up does nothing)
    if app.get_webview_window(LABEL).is_some() || SHOT.locked().is_some() {
        return Ok(());
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let res = begin(app, hint, hide_robots, on_shot);
    STARTING.store(false, Ordering::SeqCst);
    res
}

fn begin(app: &AppHandle, hint: &str, hide_robots: bool, on_shot: OnShot) -> Result<(), Error> {
    let (cx, cy) = window::cursor();
    let screen = window::monitor_near(cx, cy); // (all of it: the box can go over the taskbar too)
    // the screen as it is now, before the window covers it (and without the robots in the way)
    let hidden: Vec<isize> = if hide_robots {
        robots::open_ids(app)
            .iter()
            .filter_map(|id| robots::hwnd_of(app, id))
            .filter(|&h| window::is_visible(h))
            .collect()
    } else {
        vec![]
    };
    for &h in &hidden {
        screenshot::cloak(h, true);
    }
    if !hidden.is_empty() {
        thread::sleep(Duration::from_millis(120)); // (till the screen's redrawn without them)
    }
    let shown = show(app, screen, hint, on_shot);
    // the robots come back only once the box has the focus: a robot that had it (the palette
    // hands it to one as it goes) takes it back as it's uncloaked, and the box would cancel
    for &h in &hidden {
        screenshot::cloak(h, false);
    }
    shown
}

/// The screen captured as it is now, and the box over it.
fn show(
    app: &AppHandle,
    screen: window::Monitor,
    hint: &str,
    on_shot: OnShot,
) -> Result<(), Error> {
    let image = screenshot::capture(screen.bounds).ok_or("couldn't capture the screen")?;
    let data_url = data_url(&image).ok_or("couldn't encode the screen")?;
    let round = ROUND.fetch_add(1, Ordering::SeqCst) + 1;
    *SHOT.locked() = Some(Shot {
        round,
        image,
        scale: screen.scale,
        hint: hint.to_string(),
        data_url,
        on_shot,
    });
    open_window(app, screen, round).inspect_err(|_| {
        take_shot(Some(round));
    })
}

/// The window over the whole monitor (taskbar too), on top of everything.
fn open_window(app: &AppHandle, screen: window::Monitor, round: u64) -> Result<(), Error> {
    let r = screen.bounds;
    let w = views::builder(app, LABEL, "snip", &[])
        .title("Drag a box round a word")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(false)
        .visible(false)
        .background_color(Color(0, 0, 0, 255))
        .inner_size(r.w as f64 / screen.scale, r.h as f64 / screen.scale)
        .build()?;
    let hwnd = w.hwnd()?.0 as isize;
    // (moving it onto a screen of another scale rescales it once: placed again after)
    window::set_bounds(hwnd, r);
    if window::window_rect(hwnd) != r {
        window::set_bounds(hwnd, r);
    }
    let app2 = app.clone();
    let opened = Instant::now();
    w.on_window_event(move |e| match e {
        WindowEvent::Focused(false) => {
            let app = app2.clone();
            // (once the focus has landed, off the main thread)
            thread::spawn(move || focus_lost(&app, round, opened));
        }
        WindowEvent::Destroyed => {
            take_shot(Some(round));
        }
        _ => {}
    });
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

/// The box lost the focus. One of our own windows took it just as the box came up (the
/// robot the palette left it with): the box takes it back. Else you switched away
/// (Alt+Tab): no box after all.
fn focus_lost(app: &AppHandle, round: u64, opened: Instant) {
    thread::sleep(SETTLE);
    if opened.elapsed() < GRACE && capture::foreground_is_ours() && is_up(round) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.set_focus();
        }
        return;
    }
    if take_shot(Some(round)).is_some() {
        close_window(app);
    }
}

// ---------------------------------------------------------------- ask about the screen

/// "Ask about part of the screen" for this robot (the nearest one if none), from that app.
pub fn ask_screen(app: &AppHandle, robot_id: Option<String>, source: Option<String>) {
    ask(app, robot_id, source);
}

fn ask(app: &AppHandle, robot_id: Option<String>, source: Option<String>) -> bool {
    let robot_id = robot_id.or_else(|| hub::nearest_robot(app));
    // the app you were in (not when it's one of ours: the menu, the chat button)
    let source = source.unwrap_or_else(crate::workbench::capture::foreground_title);
    let on_shot: OnShot = Box::new(move |app, png| screen_shot(app, robot_id, source, png));
    match start(app, ASK_HINT, true, on_shot) {
        Ok(()) => true,
        Err(err) => {
            log::warn!("{err}");
            false
        }
    }
}

/// The box you dragged: saved like a pasted screenshot, and handed to a robot at its desk.
fn screen_shot(app: &AppHandle, robot_id: Option<String>, source: String, png: Vec<u8>) {
    let dir = with(app, |st| st.data_dir.join("attachments"));
    let Some(file) = files::save_paste(&dir, &png, "png").map(paste::with_thumb) else {
        return;
    };
    let payload = json!({ "file": file, "source": source });
    let at_desk = |id: &String| {
        robots::hwnd_of(app, id).is_some_and(window::is_visible) && !walkers::has(app, id)
    };
    if let Some(id) = robot_id.filter(at_desk).or_else(|| hub::nearest_robot(app)) {
        hub::send_to_robot(app, &id, "robot:screen", payload);
        return;
    }
    // everyone's out for a walk: call one back to its desk first
    if let Some(walker) = robots::open_ids(app)
        .into_iter()
        .find(|id| walkers::has(app, id))
    {
        walkers::dock(app, &walker);
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(2500));
            hub::send_to_robot(&app, &walker, "robot:screen", payload);
        });
        return;
    }
    app.dialog()
        .message("No robot is out to ask. Show one from the tray menu first.")
        .title("C-Bot")
        .show(|_| {});
}

// ---------------------------------------------------------------- the page

/// A robot's 🔍 / "Ask about part of the screen".
#[tauri::command(async)]
pub fn robot_screen_ask(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    ask(
        &app,
        robots::id_of(window.label()).map(str::to_string),
        None,
    )
}

/// The screen as it was, for the snip window to draw.
#[tauri::command(async)]
pub fn snip_init(window: tauri::WebviewWindow) -> Result<Value, Error> {
    only(&window, LABEL)?;
    let shot = SHOT.locked();
    Ok(shot.as_ref().map_or(
        Value::Null,
        |s| json!({ "image": s.data_url, "hint": s.hint }),
    ))
}

/// The box was dragged (CSS px): its part of the screen goes where it was asked for.
#[tauri::command(async)]
pub fn snip_done(app: AppHandle, window: tauri::WebviewWindow, area: Value) -> Result<bool, Error> {
    only(&window, LABEL)?;
    let Some(shot) = take_shot(None) else {
        return Ok(false);
    };
    close_window(&app);
    let Some((x, y, w, h)) = crop_box(&area, shot.scale, shot.image.dimensions()) else {
        return Ok(false);
    };
    let part = image::imageops::crop_imm(&shot.image, x, y, w, h).to_image();
    let Some(png) = png_bytes(&part) else {
        return Ok(false);
    };
    (shot.on_shot)(&app, png);
    Ok(true)
}

#[tauri::command(async)]
pub fn snip_cancel(app: AppHandle, window: tauri::WebviewWindow) -> Result<bool, Error> {
    only(&window, LABEL)?;
    let had = take_shot(None).is_some();
    close_window(&app);
    Ok(had)
}

pub fn setup(app: &AppHandle) {
    hub::add_hotkey(
        app,
        Hotkey {
            setting: "screenHotkey",
            label: "Ask about part of the screen",
            what: "Drag a box round anything and ask a robot",
            default: "Ctrl+Alt+B",
            run: |app| ask_screen(app, None, None),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_maths() {
        let b = |x: f64, y: f64, w: f64, h: f64| json!({ "x": x, "y": y, "width": w, "height": h });
        // CSS px to physical at 150%
        assert_eq!(
            crop_box(&b(10.0, 20.0, 100.0, 50.0), 1.5, (2880, 1620)),
            Some((15, 30, 150, 75))
        );
        // at 100%
        assert_eq!(
            crop_box(&b(0.0, 0.0, 1920.0, 1080.0), 1.0, (1920, 1080)),
            Some((0, 0, 1920, 1080))
        );
        // cut to the capture at its right and bottom edges
        assert_eq!(
            crop_box(&b(1900.0, 1000.0, 100.0, 100.0), 1.0, (1920, 1080)),
            Some((1900, 1000, 20, 80))
        );
        // starts off the left/top: from 0
        assert_eq!(
            crop_box(&b(-5.0, -5.0, 50.0, 50.0), 1.0, (100, 100)),
            Some((0, 0, 50, 50))
        );
        // too small to be a box (a click), or nothing left inside the capture
        assert_eq!(crop_box(&b(10.0, 10.0, 3.0, 40.0), 1.0, (100, 100)), None);
        assert_eq!(crop_box(&b(98.0, 10.0, 40.0, 40.0), 1.0, (100, 100)), None);
        assert_eq!(crop_box(&json!(null), 2.0, (100, 100)), None);
    }

    #[test]
    fn capture_data_url() {
        let img = RgbaImage::from_pixel(8, 4, image::Rgba([1, 2, 3, 255]));
        let url = data_url(&img).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&url[22..])
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8(), img);
        let part = image::imageops::crop_imm(&img, 2, 1, 3, 2).to_image();
        assert_eq!(
            image::load_from_memory(&png_bytes(&part).unwrap())
                .unwrap()
                .to_rgba8()
                .dimensions(),
            (3, 2)
        );
    }
}
