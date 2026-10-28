//! The action palette and the drone that brings it (main palette.js, drone.js, and
//! main.js's openPalette, paletteItems, onPaletteAction and the palette hotkey): one hotkey
//! for everything, a small menu by the mouse ("palette"), flown over by the robot's drone
//! ("drone"). [wave 2: quick & palette]
//!
//! Press it with some text selected and the menu offers what fits (save the word, refine,
//! translate, explain, sum up, note it, ask a robot); with nothing selected, the rest (box
//! part of the screen, box a word, a new note, My words…). Keys 1–9, the arrows and Enter
//! pick; Esc or clicking away closes it. The window is made once, hidden, and kept: opening
//! it is just showing it (fast). The page draws the new items while it's still hidden and
//! says how tall it is (palette:size), so the old items never flash up.

pub mod drone;

use std::sync::mpsc::{self, Sender};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::features::{notes, vocab};
use crate::platform::window::Rect;
use crate::platform::{clipboard, window};
use crate::runtime::hub::Hotkey;
use crate::runtime::util::only;
use crate::runtime::{Error, Locked, hub, with};
use crate::workbench::quick::{MAX_TEXT, slice16};
use crate::workbench::{capture, quick, snip};

const LABEL: &str = "palette";
const W: f64 = 320.0; // (CSS px)
const GAP: f64 = 10.0;
// the longest it waits for the page to draw the new items
const STAGING: Duration = Duration::from_millis(250);
const PAINT: &str = "#5ac8fa";

/// What it's open on: the text you selected, the app it's in (and its window), the robot
/// nearest the mouse, the items it offers, and whether the drone projects it.
#[derive(Clone, Debug, Default)]
struct Ctx {
    text: String,
    source: String,
    hwnd: isize,
    robot_id: Option<String>,
    items: Vec<Value>,
    projected: bool,
}

#[derive(Default)]
struct Palette {
    ctx: Option<Ctx>,
    height: f64,                                 // what the page asked for (CSS px)
    at: (i32, i32),                              // the mouse when it opened
    ready: bool,                                 // the page has loaded (it asked for palette:init)
    staged: Option<(u64, Sender<Option<Rect>>)>, // while it draws (hidden): settles where it will open
    seq: u64,
    drone_out: bool, // the drone's out, hovering over the menu
    opening: bool,
}

static PALETTE: LazyLock<Mutex<Palette>> = LazyLock::new(|| {
    Mutex::new(Palette {
        height: 300.0,
        ..Palette::default()
    })
});

fn pal<R>(f: impl FnOnce(&mut Palette) -> R) -> R {
    f(&mut PALETTE.locked())
}

fn hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

// ---------------------------------------------------------------- where it goes

/// Below and right of the mouse (above it near the bottom, left of it near the right edge),
/// kept on its screen. All physical px; s is the screen's scale, tall the page's height.
fn plan(at: (i32, i32), tall: f64, wa: Rect, s: f64) -> Rect {
    let px = |v: f64| (v * s).round() as i32;
    let (w, gap) = (px(W), px(GAP));
    let h = px(tall).min(wa.h - 2 * gap);
    let mut x = at.0 + px(12.0);
    let mut y = at.1 + px(14.0);
    if x + w > wa.right() - gap {
        x = at.0 - w - px(12.0);
    }
    if y + h > wa.bottom() - gap {
        y = at.1 - h - px(14.0);
    }
    let x = x.max(wa.x + gap).min(wa.right() - w - gap);
    let y = y.max(wa.y + gap).min(wa.bottom() - h - gap);
    Rect { x, y, w, h }
}

fn plan_at(at: (i32, i32), tall: f64) -> Rect {
    let m = window::monitor_near(at.0, at.1);
    plan(at, tall, m.work, m.scale)
}

fn place(app: &AppHandle) {
    let Some(h) = hwnd(app) else { return };
    let (at, height) = pal(|p| (p.at, p.height));
    let r = plan_at(at, height);
    window::set_bounds(h, r);
    // (moving it onto a screen of another scale rescales it once: placed again after)
    if window::window_rect(h) != r {
        window::set_bounds(h, r);
    }
}

// ---------------------------------------------------------------- the menu

/// A selection's leading and trailing quotes, brackets and punctuation (main.js EDGES).
fn edges() -> &'static Regex {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"^[\s"'“”‘’(\[{]+|[\s"'“”‘’)\]}.,;:!?]+$"#).unwrap());
    &RE
}

/// What the menu offers for this text (main.js paletteItems).
fn items_for(text: &str) -> Vec<Value> {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let word = edges().replace_all(&one, "").to_string();
    let wordy =
        !word.is_empty() && word.encode_utf16().count() <= 60 && word.split(' ').count() <= 5;
    let item =
        |id: &str, icon: &str, label: &str| json!({ "id": id, "icon": icon, "label": label });
    if one.is_empty() {
        return vec![
            item("screen", "scan", "Ask about part of the screen"),
            item("box-word", "text-box", "Box a word on screen to save it"),
            item("new-note", "note-plus", "New note"),
            item("quick", "sparkles", "Quick actions on text…"),
            item("words", "book", "My words"),
            item("notes", "notebook", "My notes"),
        ];
    }
    let mut items = vec![json!({ "heading": "With what you selected" })];
    if wordy {
        items.push(item(
            "word",
            "book-plus",
            &format!("Save “{word}” to my words"),
        ));
    }
    items.extend([
        json!({ "id": "refine", "icon": "wand", "label": "Refine it", "hint": "polished, professional…" }),
        item("translate", "languages", "Translate it"),
        item("explain", "bulb", "Explain it"),
        item("summarise", "summary", "Sum it up"),
        item("note", "note-plus", "Note it down"),
        item("ask", "chat-ask", "Ask a robot about it"),
        json!({ "heading": "Anything" }),
        item("screen", "scan", "Ask about part of the screen"),
        item("words", "book", "My words"),
    ]);
    items
}

fn view(ctx: &Ctx) -> Value {
    json!({ "text": ctx.text, "source": ctx.source, "items": ctx.items, "projected": ctx.projected })
}

/// The chat tab's draft for "Ask a robot about it".
fn ask_prompt(source: &str, text: &str) -> String {
    let about = if source.is_empty() {
        String::new()
    } else {
        format!(" in {source}")
    };
    [
        format!("About this text I selected{about}:"),
        String::new(),
        "---".into(),
        text.into(),
        "---".into(),
        String::new(),
        String::new(),
    ]
    .join("\n")
}

/// What picking an item does (main.js onPaletteAction).
fn on_pick(app: &AppHandle, id: &str, ctx: Ctx) {
    let Ctx {
        text,
        source,
        hwnd,
        robot_id,
        ..
    } = ctx;
    match id {
        "word" => vocab::catch_word(app, &text, &source, robot_id),
        "refine" | "translate" | "explain" | "summarise" => {
            let ctx = quick::ctx_for(
                app,
                text,
                source,
                hwnd,
                robot_id,
                Some(json!({ "action": id })),
            );
            quick::open_with(app, ctx);
        }
        "note" => notes::take_note(app, robot_id, slice16(&text, 2000), &source),
        "ask" => {
            // a new chat tab with the text in it, for you to say what you want to know
            let Some(r) = hub::chatty_robot(app, robot_id.as_deref()) else {
                return;
            };
            quick::tell_notes_later(app, &r, ask_prompt(&source, &text));
        }
        "screen" => snip::ask_screen(
            app,
            robot_id.or_else(|| hub::nearest_robot(app)),
            Some(source),
        ),
        "box-word" => vocab::box_word(app, robot_id.or_else(|| hub::nearest_robot(app)), source),
        "new-note" => notes::open_notebook(app, robot_id, Some("add")),
        "quick" => {
            let text = slice16(clipboard::text().trim(), MAX_TEXT).to_string();
            quick::open(app, text, robot_id);
        }
        "words" => vocab::open_words(app),
        "notes" => notes::open_notebook(app, robot_id, None),
        _ => {}
    }
}

// ---------------------------------------------------------------- the window

/// Make the window (hidden) if it isn't there.
fn make(app: &AppHandle) {
    static MAKING: Mutex<()> = Mutex::new(());
    let _one = MAKING.locked();
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    pal(|p| p.ready = false);
    let height = pal(|p| p.height);
    let built = crate::ui::views::builder(app, LABEL, "palette", &[])
        .title("C-Bot")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .inner_size(W, height)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[palette] couldn't make it: {err}");
            return;
        }
    };
    let app2 = app.clone();
    w.on_window_event(move |e| match e {
        // clicked somewhere else: it's a menu, it goes (off the main thread: it waits on it)
        WindowEvent::Focused(false) => {
            let app = app2.clone();
            thread::spawn(move || close(&app));
        }
        WindowEvent::Destroyed => pal(|p| {
            p.ready = false;
            p.ctx = None;
        }),
        _ => {}
    });
}

/// The page draws the items in the hidden window and says how tall it is (a moment at
/// most): where it will open, or None if it was closed meanwhile. reveal() shows it.
fn stage(app: &AppHandle, ctx: Ctx) -> Option<Rect> {
    let at = window::cursor();
    make(app);
    let v = view(&ctx);
    let (tx, rx) = mpsc::channel();
    let (seq, ready, before) = pal(|p| {
        p.ctx = Some(ctx);
        p.at = at;
        p.seq += 1;
        (p.seq, p.ready, p.staged.replace((p.seq, tx)))
    });
    if let Some((_, earlier)) = before {
        let _ = earlier.send(None);
    }
    if ready {
        let _ = app.emit_to(LABEL, "palette:open", v);
    }
    match rx.recv_timeout(STAGING) {
        Ok(spot) => spot,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // the page didn't say in time: where it would open at the height it had
            let height = pal(|p| match &p.staged {
                Some((n, _)) if *n == seq => {
                    p.staged = None;
                    Some(p.height)
                }
                _ => None,
            });
            match height {
                Some(h) => Some(plan_at(at, h)),
                None => rx.try_recv().ok().flatten(), // (settled just then)
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => None,
    }
}

fn reveal(app: &AppHandle) {
    if pal(|p| p.ctx.is_none()) {
        return;
    }
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    place(app);
    let _ = w.show();
    let _ = w.set_focus();
    // the drone hovers over the menu's top edge while it's open
    let Some(h) = hwnd(app) else { return };
    if pal(|p| p.drone_out) {
        let b = window::window_rect(h);
        let s = window::scale_of(h);
        drone::hover(
            app,
            b.x as f64 + b.w as f64 / 2.0,
            b.y as f64 + 6.0 * s,
            b.w as f64 - 12.0 * s,
        );
    }
}

/// Close it (it's hidden, and kept); the drone flies home.
pub fn close(app: &AppHandle) {
    let staged = pal(|p| {
        if p.staged.is_some() {
            p.ctx = None;
        }
        p.staged.take()
    });
    if let Some((_, tx)) = staged {
        let _ = tx.send(None);
    }
    if hwnd(app).is_some_and(window::is_visible) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.hide();
        }
        if pal(|p| std::mem::take(&mut p.drone_out)) {
            drone::recall(app);
        }
    }
}

/// It's showing, or about to.
fn is_open(app: &AppHandle) -> bool {
    hwnd(app).is_some_and(|h| window::is_visible(h) || pal(|p| p.staged.is_some()))
}

/// Open the palette (as its hotkey does). With the drone on (the default): the robot
/// nearest the mouse waves its drone off at once; once your selection's read and the menu
/// is drawn (hidden), the drone flies over in one smooth arc to just above it and projects
/// it; when the menu goes, it flies home (main.js openPalette).
pub fn open(app: &AppHandle) {
    if is_open(app) {
        return close(app);
    }
    if pal(|p| std::mem::replace(&mut p.opening, true)) {
        return;
    }
    open_now(app);
    pal(|p| p.opening = false);
}

fn open_now(app: &AppHandle) {
    let robot_id = hub::nearest_robot(app).or_else(|| hub::notes_robot(app));
    let flying = with(app, |st| st.store.settings()["paletteDrone"] != false);
    if let (true, Some(id)) = (flying, &robot_id) {
        hub::send_to_robot(app, id, "robot:palette", json!({ "phase": "launch" }));
    }
    let sel = capture::read_selection(app, &hotkey(app), true);
    open_on(app, sel, robot_id, flying);
}

/// The menu for what was selected, brought by the drone (flying) from this robot's desk.
fn open_on(app: &AppHandle, sel: capture::Selection, robot_id: Option<String>, flying: bool) {
    let text = slice16(&sel.text, MAX_TEXT).to_string();
    let hwnd = if text.is_empty() { 0 } else { sel.hwnd };
    let items = items_for(&text);
    let ctx = Ctx {
        text,
        source: sel.source,
        hwnd,
        robot_id: robot_id.clone(),
        items,
        projected: flying,
    };
    let Some(spot) = stage(app, ctx) else { return }; // (closed meanwhile)
    if flying {
        let m = window::monitor_near(spot.x + spot.w / 2, spot.y + spot.h / 2);
        let (wa, s) = (m.work, m.scale);
        // from the robot's desk (or, with no robot out, from the tray's corner) to just above the menu
        let from = match robot_id.as_deref().and_then(|id| hub::robot_rect(app, id)) {
            Some(r) => (r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 * 0.3),
            None => (wa.right() as f64 - 40.0 * s, wa.bottom() as f64),
        };
        // (30: the drone page's hover gap)
        let to = (
            spot.x as f64 + spot.w as f64 / 2.0,
            spot.y as f64 + (6.0 - 30.0) * s,
        );
        let paint = robot_id
            .as_deref()
            .and_then(|id| {
                with(app, |st| {
                    st.store
                        .get(id)
                        .and_then(|c| c["color"].as_str().map(str::to_string))
                })
            })
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| PAINT.into());
        pal(|p| p.drone_out = true);
        drone::launch(app, from, to, &paint);
    }
    reveal(app);
}

/// The palette hotkey's keys.
pub fn hotkey(app: &AppHandle) -> String {
    crate::runtime::hub::hotkey_keys(app, "paletteHotkey", "Ctrl+Alt+C")
}

// ---------------------------------------------------------------- commands (only the palette's)

/// The menu, once the window is ready for it (null while there's nothing to show).
#[tauri::command(async)]
pub fn palette_init(window: tauri::WebviewWindow) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(pal(|p| {
        p.ready = true;
        match (&p.staged, &p.ctx) {
            (Some(_), Some(c)) => view(c),
            _ => Value::Null,
        }
    }))
}

/// How tall the menu came out (CSS px): the window takes that size, where it goes.
#[tauri::command(async)]
pub fn palette_size(
    app: AppHandle,
    window: tauri::WebviewWindow,
    height: f64,
) -> Result<(), Error> {
    only(&window, LABEL)?;
    if !height.is_finite() {
        return Ok(());
    }
    let (at, staged) = pal(|p| {
        p.height = height.ceil().clamp(80.0, 640.0);
        (p.at, p.staged.take().map(|s| (s.1, p.height)))
    });
    match staged {
        Some((tx, height)) => {
            let _ = tx.send(Some(plan_at(at, height)));
        }
        None => place(&app),
    }
    Ok(())
}

#[tauri::command(async)]
pub fn palette_pick(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<bool, Error> {
    only(&window, LABEL)?;
    let Some(picked) = pal(|p| p.ctx.clone()) else {
        return Ok(false);
    };
    close(&app);
    // (a moment for the menu to go, so whatever opens next gets the focus)
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(60));
        on_pick(&app, &id, picked);
    });
    Ok(true)
}

#[tauri::command(async)]
pub fn palette_close(app: AppHandle, window: tauri::WebviewWindow) -> Result<bool, Error> {
    only(&window, LABEL)?;
    close(&app);
    Ok(true)
}

pub fn setup(app: &AppHandle) {
    hub::add_hotkey(
        app,
        Hotkey {
            setting: "paletteHotkey",
            label: "Action menu",
            what: "Every action in one menu, by the mouse",
            default: "Ctrl+Alt+C",
            run: open,
        },
    );
    // ready before the first hotkey, without slowing the start
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(4));
        make(&app);
        drone::prepare(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WA: Rect = Rect {
        x: 0,
        y: 0,
        w: 1920,
        h: 1040,
    };

    fn ids(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .map(|i| i["id"].as_str().or(i["heading"].as_str()).unwrap_or(""))
            .collect()
    }

    #[test]
    fn nothing_selected() {
        assert_eq!(
            ids(&items_for("")),
            ["screen", "box-word", "new-note", "quick", "words", "notes"]
        );
        assert_eq!(
            ids(&items_for("  \n\t ")),
            ["screen", "box-word", "new-note", "quick", "words", "notes"]
        );
    }

    #[test]
    fn a_word_or_some_text() {
        let items = items_for("  “serendipity,” ");
        assert_eq!(
            ids(&items),
            [
                "With what you selected",
                "word",
                "refine",
                "translate",
                "explain",
                "summarise",
                "note",
                "ask",
                "Anything",
                "screen",
                "words"
            ]
        );
        assert_eq!(items[1]["label"], "Save “serendipity” to my words");
        assert_eq!(items[2]["hint"], "polished, professional…");
        // a phrase of up to five words can be saved too
        assert_eq!(
            items_for("break the\nice")[1]["label"],
            "Save “break the ice” to my words"
        );
        // a sentence is too long to be a word
        let long = items_for("This is a whole sentence of more than five words.");
        assert_eq!(ids(&long)[1], "refine");
        assert_eq!(ids(&items_for(&"x".repeat(61)))[1], "refine");
        // only punctuation: something's selected, but no word in it
        assert_eq!(ids(&items_for("?!"))[1], "refine");
    }

    #[test]
    fn by_the_mouse() {
        // below and right of the mouse
        assert_eq!(
            plan((500, 400), 300.0, WA, 1.0),
            Rect {
                x: 512,
                y: 414,
                w: 320,
                h: 300
            }
        );
        // near the right edge: left of it; near the bottom: above it
        assert_eq!(
            plan((1800, 900), 300.0, WA, 1.0),
            Rect {
                x: 1800 - 320 - 12,
                y: 900 - 300 - 14,
                w: 320,
                h: 300
            }
        );
        // taller than the screen: as tall as fits
        let r = plan((10, 10), 5000.0, WA, 1.0);
        assert_eq!((r.x, r.y, r.h), (22, 10, 1020));
        // on a 150% screen
        let wa = Rect {
            x: -2560,
            y: 0,
            w: 2560,
            h: 1400,
        };
        assert_eq!(
            plan((-2000, 100), 200.0, wa, 1.5),
            Rect {
                x: -2000 + 18,
                y: 121,
                w: 480,
                h: 300
            }
        );
    }

    #[test]
    fn ask_draft() {
        assert_eq!(
            ask_prompt("Outlook", "hi"),
            "About this text I selected in Outlook:\n\n---\nhi\n---\n\n"
        );
        assert_eq!(
            ask_prompt("", "hi"),
            "About this text I selected:\n\n---\nhi\n---\n\n"
        );
    }
}
