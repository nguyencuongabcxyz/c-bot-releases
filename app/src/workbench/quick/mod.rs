//! Quick actions on text you selected anywhere (main quick.js, quickWindow.js, and main.js's
//! openQuick / onQuickAction and the quick hotkey): refine, translate, explain or sum it up
//! with Claude's quick model, in a window beside the robot nearest the mouse ("quick").
//! [wave 2: quick & palette]
//!
//! The page (renderer/quick) asks for its text with quick:init, runs an action with
//! quick:run (the words come as quick:text), reports its height with quick:size and its
//! buttons with quick:act. The robot writes on its pad while it works (robot:quick).

mod run;

pub use run::{MAX_TEXT, slice16};

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::platform::window::Rect;
use crate::platform::{clipboard, window};
use crate::robots;
use crate::robots::walkers;
use crate::runtime::hub::Hotkey;
use crate::runtime::util::{only, patch, text};
use crate::runtime::{Error, Locked, hub, part, with};
use crate::store::now_ms;
use crate::ui::place;
use crate::workbench::capture;

const LABEL: &str = "quick";
const W: f64 = 420.0; // (CSS px)
const GAP: f64 = 8.0;
const PAINT: &str = "#5ac8fa";

/// What the window is open on: the text, the app it came from (and its window, to paste
/// the answer back into), the robot that caught it and its box on screen.
#[derive(Clone, Debug, Default)]
pub struct Ctx {
    pub text: String,
    pub source: String,
    pub hwnd: isize,
    pub robot_id: Option<String>,
    pub near: Option<Rect>,
    pub paint: String,
    pub prefs: Option<Value>, // (an action picked in the palette: { action })
}

struct Quick {
    ctx: Option<Ctx>,
    height: f64,                     // what the page asked for (CSS px)
    job: Option<(u64, run::Handle)>, // the action running now
    seq: u64,
}

fn quick<R>(app: &AppHandle, f: impl FnOnce(&mut Quick) -> R) -> R {
    part(app, f)
}

/// Stop the action running now, if any.
fn cancel_job(app: &AppHandle) {
    if let Some((_, h)) = quick(app, |q| q.job.take()) {
        h.cancel();
    }
}

// ---------------------------------------------------------------- where it goes

/// Beside the robot (its box), on the side with room (left first); else above the mouse.
/// near and the work area in physical px, s the screen's scale, tall the page's height.
fn plan(near: Rect, wa: Rect, s: f64, tall: f64) -> Rect {
    place::beside(near, wa, s, (W, tall), GAP)
}

fn place(app: &AppHandle) {
    let Some((near, height)) = quick(app, |q| q.ctx.as_ref().map(|c| (c.near, q.height))) else {
        return;
    };
    let Some(hwnd) = app
        .get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
    else {
        return;
    };
    let (near, m) = place::around(near);
    let r = plan(near, m.work, m.scale, height);
    window::set_bounds(hwnd, r);
    // (moving it onto a screen of another scale rescales it once: placed again after)
    if window::window_rect(hwnd) != r {
        window::set_bounds(hwnd, r);
    }
}

fn show(app: &AppHandle) {
    place(app);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- opening and closing

/// What the page needs: the text, where it came from, the last action and style you used.
fn view(app: &AppHandle, ctx: &Ctx) -> Value {
    let s = with(app, |st| st.store.settings().clone());
    let mut prefs = json!({ "action": "refine", "style": "polished", "lang": "en" });
    for extra in [s.get("quickPrefs"), ctx.prefs.as_ref()]
        .into_iter()
        .flatten()
    {
        if let (Some(p), Some(e)) = (prefs.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
    }
    json!({
        "text": ctx.text,
        "source": ctx.source,
        "canReplace": ctx.hwnd != 0,
        "paint": ctx.paint,
        "prefs": prefs,
        "styles": run::STYLES.iter().map(|(id, label, how)| json!({ "id": id, "label": label, "how": how })).collect::<Vec<_>>(),
        "model": quick_model(&s),
        "max": MAX_TEXT,
    })
}

fn quick_model(settings: &Value) -> String {
    settings["quickModel"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or("haiku")
        .to_string()
}

fn paint_of(app: &AppHandle, robot_id: Option<&str>) -> String {
    let color = robot_id.and_then(|id| {
        with(app, |st| {
            st.store
                .get(id)
                .and_then(|c| c["color"].as_str().map(str::to_string))
        })
    });
    color
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| PAINT.into())
}

/// The context for opening on this text beside this robot (the nearest one, else the notes
/// robot, when none's given) (main.js openQuick).
pub fn ctx_for(
    app: &AppHandle,
    text: String,
    source: String,
    hwnd: isize,
    robot_id: Option<String>,
    prefs: Option<Value>,
) -> Ctx {
    let robot_id = robot_id
        .or_else(|| hub::nearest_robot(app))
        .or_else(|| hub::notes_robot(app));
    let near = robot_id.as_deref().and_then(|id| hub::robot_rect(app, id));
    let paint = paint_of(app, robot_id.as_deref());
    Ctx {
        text,
        source,
        hwnd,
        robot_id,
        near,
        paint,
        prefs,
    }
}

/// Open Quick actions on this text, beside this robot (the nearest if none).
pub fn open(app: &AppHandle, text: String, robot_id: Option<String>) {
    let ctx = ctx_for(app, text, String::new(), 0, robot_id, None);
    open_with(app, ctx);
}

/// Open Quick actions as ctx says (a fresh start: an action running is stopped).
/// (Off the calling thread: it may be a menu's, on the main thread, where building a
/// window would wait on itself.)
pub fn open_with(app: &AppHandle, ctx: Ctx) {
    let app = app.clone();
    thread::spawn(move || open_now(&app, ctx));
}

fn open_now(app: &AppHandle, ctx: Ctx) {
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.locked();
    cancel_job(app);
    let v = view(app, &ctx);
    quick(app, |q| q.ctx = Some(ctx));
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "quick:open", v);
        show(app);
        return;
    }
    let height = quick(app, |q| q.height);
    let app2 = app.clone();
    let built = crate::ui::views::builder(app, LABEL, "quick", &[])
        .title("Quick actions")
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
        // shown once its page is there (ready-to-show)
        .on_page_load(move |_, p| {
            if let PageLoadEvent::Finished = p.event() {
                let app = app2.clone();
                thread::spawn(move || show(&app));
            }
        })
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            log::warn!("couldn't open: {err}");
            quick(app, |q| q.ctx = None);
            return;
        }
    };
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            cancel_job(&app2);
            quick(&app2, |q| q.ctx = None);
        }
    });
}

/// Close the window (if it's open).
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// The Quick actions window is open.
pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// The quick hotkey's keys.
pub fn hotkey(app: &AppHandle) -> String {
    crate::runtime::hub::hotkey_keys(app, "quickHotkey", "Ctrl+Alt+R")
}

/// The hotkey: what's selected in the app in front, beside the robot nearest the mouse
/// (main.js captureQuick).
fn capture_quick(app: &AppHandle) {
    let sel = capture::read_selection(app, &hotkey(app), true);
    let (source, hwnd) = if sel.text.is_empty() {
        (String::new(), 0)
    } else {
        (sel.source, sel.hwnd)
    };
    let ctx = ctx_for(app, sel.text, source, hwnd, None, None);
    open_with(app, ctx);
}

// ---------------------------------------------------------------- what it does beyond itself

/// The robot's reactions (robot:quick), and what the window's buttons do outside it
/// (main.js onQuickAction).
fn on_action(app: &AppHandle, action: &str, ctx: &Ctx, p: &Value) -> Value {
    let tell = |phase: &str| {
        if let Some(id) = &ctx.robot_id {
            hub::send_to_robot(
                app,
                id,
                "robot:quick",
                json!({ "phase": phase, "action": p.get("action").cloned().unwrap_or(Value::Null) }),
            );
        }
    };
    match action {
        "start" | "done" | "fail" | "copied" => {
            tell(action);
            Value::Null
        }
        "replace" => {
            // back to the app it came from, over the selection there
            let t = text(&p["text"]);
            let ok = capture::paste_into(ctx.hwnd, &t);
            if !ok {
                clipboard::set_text(&t); // (that window's gone: it's on the clipboard instead)
            }
            tell(if ok { "replaced" } else { "copied" });
            json!(ok)
        }
        "ask" => {
            // talk it over with the robot: a new chat tab with the text (and the answer so far)
            let Some(robot_id) = hub::chatty_robot(app, ctx.robot_id.as_deref()) else {
                return json!(false);
            };
            let prompt = ask_prompt(
                &text(&p["action"]),
                p["style"].as_str(),
                &text(&p["text"]),
                &text(&p["result"]),
            );
            close(app);
            tell_notes_later(app, &robot_id, prompt);
            json!(true)
        }
        _ => Value::Null,
    }
}

/// The chat tab's draft for "Ask more": the text, what you asked, the answer so far.
fn ask_prompt(action: &str, style: Option<&str>, selected: &str, result: &str) -> String {
    let what = match action {
        "refine" => format!(
            "refine it ({})",
            style.filter(|s| !s.is_empty()).unwrap_or("polished")
        ),
        "translate" => "translate it".into(),
        "explain" => "explain it".into(),
        "summarise" => "summarise it".into(),
        _ => "help with it".into(),
    };
    let mut lines = vec![
        format!("I selected this text and asked you to {what}."),
        String::new(),
        "---".into(),
        selected.into(),
        "---".into(),
    ];
    if !result.is_empty() {
        lines.extend([
            String::new(),
            "Your answer was:".into(),
            "---".into(),
            result.into(),
            "---".into(),
        ]);
    }
    lines.extend([String::new(), "Let's go over it together: ".into()]);
    lines.join("\n")
}

/// A new chat tab with this draft in it, at the robot's desk (a robot called back from a
/// walk gets there first) (main.js tellNotes { phase: 'ask' }).
pub fn tell_notes_later(app: &AppHandle, robot_id: &str, prompt: String) {
    let wait = if walkers::has(app, robot_id) { 1800 } else { 0 };
    let (app, id) = (app.clone(), robot_id.to_string());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(wait));
        hub::send_to_robot(
            &app,
            &id,
            "robot:notes",
            json!({ "phase": "ask", "prompt": prompt, "draft": true }),
        );
    });
}

// ---------------------------------------------------------------- the page

/// Run an action on the text: the words stream as quick:text { id, text }; the answer
/// (or cancelled, or an error) is what it returns.
fn run_action(app: &AppHandle, req: &Value) -> Value {
    let Some(ctx) = quick(app, |q| q.ctx.clone()) else {
        return Value::Null;
    };
    let id = now_ms();
    let s = with(app, |st| st.store.settings().clone());
    let model = quick_model(&s);
    let job = run::Job {
        action: text(&req["action"]),
        text: text(&req["text"]),
        style: text(&req["style"]),
        custom: text(&req["custom"]),
        to: text(&req["to"]),
        lang: text(&req["lang"]),
        model: model.clone(),
        claude_path: s["claudePath"].as_str().unwrap_or("").to_string(),
    };
    let handle = run::Handle::default();
    // this one in place of the one running, in one go (two asked at once: the later stops
    // the earlier, and neither is left running unseen)
    let (seq, before) = quick(app, |q| {
        q.seq += 1;
        (q.seq, q.job.replace((q.seq, handle.clone())))
    });
    if let Some((_, h)) = before {
        h.cancel();
    }
    let _ = app.emit_to(LABEL, "quick:text", json!({ "id": id, "text": "" }));
    let what = json!({ "action": req["action"] });
    on_action(app, "start", &ctx, &what);
    let t0 = Instant::now();
    let res = run::run(&job, &handle, |so_far| {
        let _ = app.emit_to(LABEL, "quick:text", json!({ "id": id, "text": so_far }));
    });
    quick(app, |q| {
        if q.job.as_ref().is_some_and(|(n, _)| *n == seq) {
            q.job = None;
        }
    });
    match res {
        Ok(a) => {
            on_action(app, "done", &ctx, &what);
            json!({ "id": id, "text": a.text, "changes": a.changes, "ms": t0.elapsed().as_millis() as u64, "model": model })
        }
        Err(run::Failed::Cancelled) => json!({ "id": id, "cancelled": true }),
        Err(run::Failed::Error(error)) => {
            on_action(app, "fail", &ctx, &what);
            json!({ "id": id, "error": error })
        }
    }
}

/// The window's buttons (quick:act).
fn act(app: &AppHandle, action: &str, p: &Value) -> Value {
    let Some(ctx) = quick(app, |q| q.ctx.clone()) else {
        return Value::Null;
    };
    match action {
        "close" => {
            close(app);
            Value::Null
        }
        "prefs" => {
            // the action / style / language you picked: next time it starts there
            let Some(picked) = p.as_object() else {
                return Value::Null;
            };
            with(app, |st| {
                let mut prefs: Map<String, Value> = st.store.settings()["quickPrefs"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                prefs.extend(picked.clone());
                st.store
                    .update_settings(patch(vec![("quickPrefs", Value::Object(prefs))]))
            })
        }
        "copy" => {
            clipboard::set_text(&text(&p["text"]));
            on_action(app, "copied", &ctx, p);
            json!(true)
        }
        "replace" => {
            close(app);
            on_action(app, "replace", &ctx, p)
        }
        "stop" => {
            cancel_job(app);
            json!(true)
        }
        _ => on_action(app, action, &ctx, p),
    }
}

// ---------------------------------------------------------------- commands

/// A robot's "Quick actions" with nothing selected: an empty window by it (or with that text).
#[tauri::command(async)]
pub fn quick_open_blank(app: AppHandle, window: tauri::WebviewWindow, p: Option<Value>) {
    let t = slice16(&text(&p.unwrap_or_default()["text"]), MAX_TEXT).to_string();
    open(&app, t, robots::id_of(window.label()).map(str::to_string));
}

// (only the Quick actions window may ask the rest)

#[tauri::command(async)]
pub fn quick_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(quick(&app, |q| q.ctx.clone()).map_or(Value::Null, |c| view(&app, &c)))
}

/// How tall the window's content came out (CSS px).
#[tauri::command(async)]
pub fn quick_size(app: AppHandle, window: tauri::WebviewWindow, height: f64) -> Result<(), Error> {
    only(&window, LABEL)?;
    if height.is_finite() {
        quick(&app, |q| q.height = height.ceil().clamp(200.0, 780.0));
        place(&app);
    }
    Ok(())
}

/// Run an action on the text (it streams in through quick:text; up to 90 s).
#[tauri::command(async)]
pub fn quick_run(app: AppHandle, window: tauri::WebviewWindow, req: Value) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(run_action(&app, &req))
}

/// A button in the window: close, prefs, copy, replace, stop, ask.
#[tauri::command(async)]
pub fn quick_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    p: Option<Value>,
) -> Result<Value, Error> {
    only(&window, LABEL)?;
    Ok(act(&app, &action, &p.unwrap_or_default()))
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Quick {
        ctx: None,
        height: 360.0,
        job: None,
        seq: 0,
    }));
    hub::add_hotkey(
        app,
        Hotkey {
            setting: "quickHotkey",
            label: "Quick actions",
            what: "Refine, translate or explain the text you selected",
            default: "Ctrl+Alt+R",
            run: capture_quick,
        },
    );
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

    #[test]
    fn beside_the_robot() {
        // a robot in the bottom-right corner: on its left, bottoms lined up
        let robot = Rect {
            x: 1590,
            y: 740,
            w: 300,
            h: 290,
        };
        assert_eq!(
            plan(robot, WA, 1.0, 360.0),
            Rect {
                x: 1590 - 420 - 8,
                y: 1030 - 360,
                w: 420,
                h: 360
            }
        );
        // no room on its left: on its right
        let left = Rect {
            x: 100,
            y: 300,
            w: 300,
            h: 290,
        };
        assert_eq!(
            plan(left, WA, 1.0, 360.0),
            Rect {
                x: 408,
                y: 230,
                w: 420,
                h: 360
            }
        );
        // too tall for the screen: as tall as fits, kept on it
        let r = plan(robot, WA, 1.0, 2000.0);
        assert_eq!((r.y, r.h), (8, 1040 - 16));
        // high up: kept below the top edge
        let up = Rect {
            x: 1500,
            y: 0,
            w: 300,
            h: 100,
        };
        assert_eq!(plan(up, WA, 1.0, 360.0).y, 8);
    }

    #[test]
    fn by_the_mouse_and_scaled() {
        // no robot: above the mouse (a box of no size), its left edge clear of it
        let r = plan(
            Rect {
                x: 1000,
                y: 600,
                w: 0,
                h: 0,
            },
            WA,
            1.0,
            300.0,
        );
        assert_eq!(
            r,
            Rect {
                x: 572,
                y: 300,
                w: 420,
                h: 300
            }
        );
        // on a 150% screen to the right of the main one
        let wa = Rect {
            x: 1920,
            y: 0,
            w: 2560,
            h: 1400,
        };
        let r = plan(
            Rect {
                x: 1925,
                y: 900,
                w: 0,
                h: 0,
            },
            wa,
            1.5,
            300.0,
        );
        assert_eq!((r.x, r.w, r.h), (1925 + 12, 630, 450));
        assert_eq!(r.y, 450);
    }

    #[test]
    fn ask_more() {
        let p = ask_prompt("refine", Some("formal"), "hello", "Hello.");
        assert_eq!(
            p,
            "I selected this text and asked you to refine it (formal).\n\n---\nhello\n---\n\nYour answer was:\n---\nHello.\n---\n\nLet's go over it together: "
        );
        let p = ask_prompt("translate", None, "xin chào", "");
        assert_eq!(
            p,
            "I selected this text and asked you to translate it.\n\n---\nxin chào\n---\n\nLet's go over it together: "
        );
        assert!(ask_prompt("refine", None, "a", "").contains("refine it (polished)"));
        assert!(ask_prompt("", None, "a", "").contains("help with it"));
    }
}
