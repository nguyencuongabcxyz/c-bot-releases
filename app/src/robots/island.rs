//! The robot island (docs/mockups/island-*.svg): a little dark strip on an edge of the
//! screen with every robot's face, the ones out on the desk bright, the ones sent away
//! faded. Hover it and a panel slides out to bring robots out or send them away; a robot
//! that's away and has news (done, a snag, a question) says so from there, as a toast.
//! Press and hold it to drag it anywhere along any edge (setting islandAt).
//!
//! Sent away is robots/mod.rs's peek: its window stays, veiled, and its page keeps working. Each
//! robot page says how it is (robot_island); this keeps the last word of each and hands the
//! island page the whole list (island:robots). The island page sizes its window (island_size:
//! room for its biggest look, so opening the panel never resizes it, which would flicker)
//! and says where the strip is in it (island_box); this puts the window flush against its
//! edge, and lets clicks through it except over the strip.
//!
//! Its own lock (no State lock held inside it, nor it inside State's), and no call into a
//! window while holding it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::platform::window::Rect;
use crate::platform::{input, window};
use crate::robots;
use crate::robots::walkers;
use crate::runtime::util::{only, patch};
use crate::runtime::{hub, part, with};
use crate::ui::views;

pub const LABEL: &str = "island";
// its window before the page has said how big it is (CSS px)
const START: (f64, f64) = (240.0, 60.0);

struct Island {
    hwnd: Option<isize>,
    making: bool,
    size: (f64, f64),          // its window, as the page last asked (CSS px)
    edge: String,              // top | bottom | left | right
    at: (i32, i32), // a point by its edge (physical px): it centres on it, along the edge
    hit: (f64, f64, f64, f64), // the strip in its window (CSS px): x, y, w, h
    through: Option<bool>, // clicks pass through the window (as last set)
    dragging: bool,
    hover: bool,
    target: &'static str, // a robot dragged round the screen: off | near | over (the island)
    reports: HashMap<String, Value>, // robot id -> how it last said it was
    reminder: HashMap<String, Value>, // robot id -> the notes reminder it holds for you (features/notes/mod.rs)
    sent: Option<Value>,              // the list as the page last had it
}

fn isl<R>(app: &AppHandle, f: impl FnOnce(&mut Island) -> R) -> R {
    part(app, f)
}

// ---------------------------------------------------------------- where it goes

const EDGES: [&str; 4] = ["top", "bottom", "left", "right"];

/// The edge of its screen a point is nearest.
fn edge_near(p: (i32, i32)) -> &'static str {
    let wa = window::monitor_near(p.0, p.1).work;
    let d = [p.1 - wa.y, wa.bottom() - p.1, p.0 - wa.x, wa.right() - p.0];
    let i = (0..4).min_by_key(|&i| d[i]).unwrap_or(0);
    EDGES[i]
}

/// Flush against its edge, centred on its point along it, kept on the screen.
fn bounds(edge: &str, at: (i32, i32), size: (f64, f64)) -> Rect {
    let m = window::monitor_near(at.0, at.1);
    let wa = m.work;
    let w = ((size.0 * m.scale).round() as i32).min(wa.w);
    let h = ((size.1 * m.scale).round() as i32).min(wa.h);
    let x = (at.0 - w / 2).max(wa.x).min(wa.right() - w);
    let y = (at.1 - h / 2).max(wa.y).min(wa.bottom() - h);
    match edge {
        "bottom" => Rect {
            x,
            y: wa.bottom() - h,
            w,
            h,
        },
        "left" => Rect { x: wa.x, y, w, h },
        "right" => Rect {
            x: wa.right() - w,
            y,
            w,
            h,
        },
        _ => Rect { x, y: wa.y, w, h },
    }
}

/// Where it starts: the middle of the main screen's top edge.
fn default_spot() -> (String, (i32, i32)) {
    let wa = window::primary_monitor().work;
    ("top".into(), (wa.x + wa.w / 2, wa.y))
}

fn place(app: &AppHandle) {
    let job = isl(app, |i| Some((i.hwnd?, bounds(&i.edge, i.at, i.size))));
    if let Some((hwnd, b)) = job {
        window::set_bounds(hwnd, b);
    }
}

// ---------------------------------------------------------------- the window

/// The island is on (unless turned off in the tray's settings: setting island).
pub fn on(app: &AppHandle) -> bool {
    with(app, |st| {
        st.store.settings()["island"].as_bool() != Some(false)
    })
}

/// Shown at all: on, and there are robots.
fn wanted(app: &AppHandle) -> bool {
    on(app) && with(app, |st| !st.store.list().is_empty())
}

/// Make it, off the calling thread (a window event may be what asks, on the main thread).
fn open(app: &AppHandle) {
    let go = isl(app, |i| {
        let go = !i.making && i.hwnd.is_none();
        i.making |= go;
        go
    });
    if !go {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let hwnd = make(&app);
        isl(&app, |i| {
            i.making = false;
            i.hwnd = hwnd;
        });
        place(&app);
    });
}

fn make(app: &AppHandle) -> Option<isize> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return w.hwnd().ok().map(|h| h.0 as isize);
    }
    let built = views::builder(app, LABEL, "island", &[])
        .title("C-Bot robots")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(START.0, START.1)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[island] couldn't make it: {err}");
            return None;
        }
    };
    let hwnd = w.hwnd().ok()?.0 as isize;
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            isl(&app2, |i| {
                if i.hwnd == Some(hwnd) {
                    i.hwnd = None;
                    i.dragging = false;
                    i.hover = false;
                    i.through = None;
                    i.sent = None;
                }
            });
        }
    });
    Some(hwnd)
}

fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- the robots

/// Every robot, in the Workshop's order, with how it is: out on the desk, sent away (peek),
/// or put away altogether (its window closed), and what it last said it was doing.
pub fn robots_view(app: &AppHandle) -> Value {
    let list: Vec<(Value, Option<bool>)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .map(|c| {
                let id = c["id"].as_str().unwrap_or("");
                (
                    json!({ "id": id, "name": c["name"], "color": c["color"] }),
                    st.robots.get(id).map(|r| r.peek),
                )
            })
            .collect()
    });
    let reports = isl(app, |i| i.reports.clone());
    let out: Vec<Value> = list
        .into_iter()
        .map(|(mut v, peek)| {
            let id = v["id"].as_str().unwrap_or("").to_string();
            let r = reports.get(&id).cloned().unwrap_or_default();
            v["closed"] = json!(peek.is_none());
            v["away"] = json!(peek.unwrap_or(true));
            v["walking"] = json!(walkers::has(app, &id));
            for k in ["awake", "busy", "text", "since", "asking"] {
                v[k] = r.get(k).cloned().unwrap_or(Value::Null);
            }
            v
        })
        .collect();
    json!(out)
}

/// Something about the robots changed (one came out, went away, was renamed, said it's
/// busy…): the island hears it, or comes, or goes.
pub fn changed(app: &AppHandle) {
    crate::robots::stage::changed(app); // (the stage's bar shows them too)
    if app.try_state::<Mutex<Island>>().is_none() {
        return;
    }
    if !wanted(app) {
        close(app);
        // (turned off: nobody stays away where you couldn't get them back)
        let away: Vec<String> = with(app, |st| {
            st.robots
                .iter()
                .filter(|(_, r)| r.peek)
                .map(|(id, _)| id.clone())
                .collect()
        });
        for id in away {
            let _ = app.emit_to(robots::label_of(&id), "robot:action", "unpeek");
        }
        return;
    }
    if isl(app, |i| i.hwnd.is_none()) {
        return open(app); // (it gets the list as it starts: island_init)
    }
    let list = robots_view(app);
    let new = isl(app, |i| {
        (i.sent.as_ref() != Some(&list))
            .then(|| i.sent = Some(list.clone()))
            .is_some()
    });
    if new {
        let _ = app.emit_to(LABEL, "island:robots", list);
    }
}

/// A robot's window went: what it said goes with it.
pub fn gone(app: &AppHandle, id: &str) {
    if app.try_state::<Mutex<Island>>().is_none() {
        return;
    }
    isl(app, |i| i.reports.remove(id));
    changed(app);
}

/// Where the strip is on screen (physical px): what's for a robot that's away goes beside it
/// (hub::robot_rect: the word card, the notebook…).
pub fn strip_rect(app: &AppHandle) -> Option<Rect> {
    app.try_state::<Mutex<Island>>()?;
    let (hwnd, (hx, hy, hw, hh)) = isl(app, |i| Some((i.hwnd?, i.hit)))?;
    if hw <= 0.0 || !window::is_visible(hwnd) {
        return None;
    }
    let b = window::window_rect(hwnd);
    let s = window::scale_of(hwnd);
    let px = |v: f64| (v * s).round() as i32;
    Some(Rect {
        x: b.x + px(hx),
        y: b.y + px(hy),
        w: px(hw),
        h: px(hh),
    })
}

/// Something for you from a robot that's away, said from the island: kind word (it dreamt of
/// one: its card is open by the island), quiz (it's asking you one), notes (your daily notes
/// reminder: `reminder` opens it, island_act notes). False: no island to say it.
pub fn say(app: &AppHandle, id: &str, kind: &str, text: &str, reminder: Option<Value>) -> bool {
    if app.try_state::<Mutex<Island>>().is_none() || isl(app, |i| i.hwnd.is_none()) {
        return false;
    }
    if let Some(r) = reminder {
        isl(app, |i| i.reminder.insert(id.to_string(), r));
    }
    app.emit_to(
        LABEL,
        "island:news",
        json!({ "id": id, "kind": kind, "text": text }),
    )
    .is_ok()
}

/// A robot being dragged round its desk (robots/mod.rs drag): the island lights up (island:target
/// near), and more so with the mouse over it (over). Let go over it (end): true, it's sent
/// away to the island.
pub fn robot_drag(app: &AppHandle, phase: &str) -> bool {
    if app.try_state::<Mutex<Island>>().is_none() {
        return false;
    }
    let moving = isl(app, |i| i.target != "off");
    // (a little room round the strip: it's small to aim at)
    let (cx, cy) = window::cursor();
    let over = strip_rect(app).is_some_and(|r| {
        Rect {
            x: r.x - 24,
            y: r.y - 24,
            w: r.w + 48,
            h: r.h + 48,
        }
        .contains(cx, cy)
    });
    let now = match phase {
        "move" if over => "over",
        "move" => "near",
        _ => "off", // start (a press, maybe a click) or end
    };
    if isl(app, |i| std::mem::replace(&mut i.target, now) != now) {
        let _ = app.emit_to(LABEL, "island:target", now);
    }
    phase == "end" && moving && over
}

// ---------------------------------------------------------------- the mouse

/// The cursor, as robots/mod.rs watches it: dragged, the island follows it round the edges of
/// the screen (on the nearest one); else whether it's over the island (island:hover).
pub fn cursor(app: &AppHandle, at: (i32, i32)) {
    if app.try_state::<Mutex<Island>>().is_none() {
        return;
    }
    enum Do {
        Nothing,
        Hover(Option<bool>, Option<bool>), // (hovered now or not, if that changed; clicks through or not, if that did)
        Move(isize, Rect, Option<String>),
        Dropped(String, (i32, i32)),
    }
    let job = isl(app, |i| {
        let Some(hwnd) = i.hwnd else {
            return Do::Nothing;
        };
        if i.dragging {
            if !input::main_button_down() {
                i.dragging = false;
                return Do::Dropped(i.edge.clone(), i.at);
            }
            let edge = edge_near(at);
            let turned = (edge != i.edge).then(|| edge.to_string());
            i.edge = edge.into();
            i.at = at;
            return Do::Move(hwnd, bounds(&i.edge, i.at, i.size), turned);
        }
        // over the strip itself (a couple of px round it), not the see-through rest
        let b = window::window_rect(hwnd);
        let s = window::scale_of(hwnd);
        let (hx, hy, hw, hh) = i.hit;
        let px = |v: f64| (v * s).round() as i32;
        let strip = Rect {
            x: b.x + px(hx) - 2,
            y: b.y + px(hy) - 2,
            w: px(hw) + 4,
            h: px(hh) + 4,
        };
        let over = window::is_visible(hwnd) && strip.contains(at.0, at.1);
        let through = (i.through != Some(!over)).then(|| {
            i.through = Some(!over);
            !over
        });
        let hover = (over != i.hover).then_some(over);
        i.hover = over;
        if hover.is_none() && through.is_none() {
            return Do::Nothing;
        }
        Do::Hover(hover, through)
    });
    match job {
        Do::Nothing => {}
        Do::Hover(hover, through) => {
            if let Some(t) = through
                && let Some(w) = app.get_webview_window(LABEL)
            {
                let _ = w.set_ignore_cursor_events(t);
            }
            if let Some(over) = hover {
                let _ = app.emit_to(LABEL, "island:hover", over);
            }
        }
        Do::Move(hwnd, b, turned) => {
            if let Some(edge) = turned {
                let _ = app.emit_to(
                    LABEL,
                    "island:edge",
                    json!({ "edge": edge, "dragging": true }),
                );
            }
            window::set_bounds(hwnd, b);
        }
        Do::Dropped(edge, at) => dropped(app, &edge, at),
    }
}

/// Let go: it stays there, after a restart too.
fn dropped(app: &AppHandle, edge: &str, at: (i32, i32)) {
    with(app, |st| {
        st.store.update_settings(patch(vec![(
            "islandAt",
            json!({ "edge": edge, "x": at.0, "y": at.1 }),
        )]))
    });
    let _ = app.emit_to(
        LABEL,
        "island:edge",
        json!({ "edge": edge, "dragging": false }),
    );
    place(app);
}

// ---------------------------------------------------------------- what it asks

#[tauri::command(async)]
pub fn island_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, LABEL)?;
    let list = robots_view(&app);
    let edge = isl(&app, |i| {
        i.sent = Some(list.clone());
        i.edge.clone()
    });
    Ok(json!({ "robots": list, "edge": edge }))
}

/// How big it came out (CSS px, its shadow and all).
#[tauri::command(async)]
pub fn island_size(
    app: AppHandle,
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    only(&window, LABEL)?;
    isl(&app, |i| i.size = (width.max(1.0), height.max(1.0)));
    place(&app);
    Ok(())
}

/// Where the strip is in its window (CSS px): the mouse over it counts as over the island,
/// and only there does it take clicks.
#[tauri::command(async)]
pub fn island_box(
    app: AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    only(&window, LABEL)?;
    isl(&app, |i| i.hit = (x, y, width, height));
    Ok(())
}

/// Pressed and held: it follows the mouse till it's let go (start), or it was let go (end).
#[tauri::command(async)]
pub fn island_drag(
    app: AppHandle,
    window: tauri::WebviewWindow,
    phase: String,
) -> Result<(), String> {
    only(&window, LABEL)?;
    match phase.as_str() {
        "start" => isl(&app, |i| {
            i.dragging = true;
            i.hover = false;
            i.through = None; // (looked at afresh once it's put down)
        }),
        "end" => {
            let was = isl(&app, |i| {
                std::mem::replace(&mut i.dragging, false).then(|| (i.edge.clone(), i.at))
            });
            if let Some((edge, at)) = was {
                dropped(&app, &edge, at);
            }
        }
        _ => {}
    }
    Ok(())
}

/// A button on it: out (back to its desk), away (off the desk, to the island), chat (out,
/// and its chat open), notes (the notes reminder it holds: the notebook), workshop, all-out,
/// all-away.
#[tauri::command(async)]
pub fn island_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    id: Option<String>,
) -> Result<(), String> {
    only(&window, LABEL)?;
    let state = |id: &str| with(&app, |st| st.robots.get(id).map(|r| r.peek)); // None: put away
    let tell = |id: &str, what: &str| {
        let _ = app.emit_to(robots::label_of(id), "robot:action", what);
    };
    let id = id.unwrap_or_default();
    match action.as_str() {
        "out" | "chat" => match state(&id) {
            None => hub::set_visible(&app, &id, true),
            Some(peek) if action == "chat" || peek => {
                tell(&id, if action == "chat" { "chat" } else { "unpeek" })
            }
            _ => {}
        },
        "away" => {
            if state(&id) == Some(false) {
                tell(&id, "peek");
            }
        }
        "workshop" => crate::ui::workshop::open(&app, None),
        "notes" => {
            let reminder = isl(&app, |i| i.reminder.remove(&id));
            crate::features::notes::open_reminder(
                &app,
                Some(id.clone()),
                reminder.unwrap_or(Value::Null),
            );
        }
        "all-out" | "all-away" => {
            let ids: Vec<String> = with(&app, |st| {
                st.store
                    .list()
                    .iter()
                    .filter_map(|c| c["id"].as_str().map(str::to_string))
                    .collect()
            });
            for id in ids {
                match (action.as_str(), state(&id)) {
                    ("all-out", None) => hub::set_visible(&app, &id, true),
                    ("all-out", Some(true)) => tell(&id, "unpeek"),
                    ("all-away", Some(false)) => tell(&id, "peek"),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// A robot page saying how it is (awake, busy, what it's doing and since when, a question
/// waiting), and, while it's away, news for the island to show (done, error, ask).
#[tauri::command(async)]
pub fn robot_island(
    app: AppHandle,
    window: tauri::WebviewWindow,
    report: Value,
    news: Option<Value>,
) -> Result<(), String> {
    let id = robots::sender(&window)?;
    let fresh = isl(&app, |i| {
        i.reports
            .insert(id.clone(), report.clone())
            .is_none_or(|old| old != report)
    });
    let missing = isl(&app, |i| i.hwnd.is_none());
    if fresh || missing {
        changed(&app); // (and back if it went: its page's process died, say)
    }
    let away = with(&app, |st| st.robots.get(&id).is_some_and(|r| r.peek));
    if let Some(mut news) = news.filter(|n| n.is_object())
        && away
    {
        news["id"] = json!(id);
        let _ = app.emit_to(LABEL, "island:news", news);
    }
    Ok(())
}

pub fn setup(app: &AppHandle) {
    let (edge, at) = with(app, |st| {
        let s = &st.store.settings()["islandAt"];
        let edge = s["edge"]
            .as_str()
            .filter(|e| EDGES.contains(e))
            .map(str::to_string);
        let at = s["x"]
            .as_i64()
            .zip(s["y"].as_i64())
            .map(|(x, y)| (x as i32, y as i32));
        edge.zip(at)
    })
    .unwrap_or_else(default_spot);
    app.manage(Mutex::new(Island {
        hwnd: None,
        making: false,
        size: START,
        edge,
        at,
        hit: (0.0, 0.0, 0.0, 0.0),
        through: None,
        target: "off",
        dragging: false,
        hover: false,
        reports: HashMap::new(),
        reminder: HashMap::new(),
        sent: None,
    }));
    changed(app);
}
