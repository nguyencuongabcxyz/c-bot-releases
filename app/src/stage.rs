//! The stage (docs/mockups/stage-*.svg): several robots' chats side by side, tiled over one
//! screen like windows. You pick the cast (Ctrl+click robots, or the tray), then take the
//! stage: each robot's window becomes a tile of the grid (robots.rs lays it out so: its chat
//! fills it, its face in the title bar), and a bar along the bottom (the "stage" window,
//! gui/views/stage) sends one message to all of them. Before that, the same window is a
//! little pill saying how many robots are picked.
//!
//! The grid is groups of tiles: columns of tiles stacked one above the other, or (four
//! robots and more) rows of tiles side by side. Each group and each tile has a weight; drag
//! the gap between two and the one shrinking gives way (the nearest first, each down to its
//! minimum, then the next). The tiles' windows touch; each chat sits a few px inside its
//! window (INSET), so the gap between two chats belongs to both windows and either one hears
//! you drag it.
//!
//! Its own lock (no State lock held inside it, nor it inside State's), and no call into a
//! window while holding it.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::util::only;
use crate::win::{self, Rect};
use crate::{island, robots, tray, views, walkers, with};

pub const LABEL: &str = "stage";
/// How far each tile's chat sits inside its window (CSS px): two of these make the gap.
pub const INSET: f64 = 4.0;
// the smallest a tile may be dragged to (CSS px): the chat's narrowest
const MIN_W: f64 = 360.0;
const MIN_H: f64 = 200.0;
// spotlight: the others in a column of strips this wide
const STRIP_W: f64 = 300.0;
// the bar along the bottom of the stage, and the pill while picking (CSS px)
const BAR_H: f64 = 64.0;
const PILL: (f64, f64) = (470.0, 72.0);
// as many rows of tiles as there may be
const MAX_ROWS: usize = 3;

#[derive(Clone)]
struct Tile {
    id: String,
    w: f64,
}

#[derive(Clone)]
struct Group {
    w: f64,
    tiles: Vec<Tile>,
}

/// A gap between two: groups k and k+1, or tiles k and k+1 of group g.
#[derive(Clone, Copy, PartialEq)]
enum Split {
    Outer(usize),
    Inner(usize, usize),
}

impl Split {
    fn name(self) -> String {
        match self {
            Split::Outer(k) => format!("o{k}"),
            Split::Inner(g, k) => format!("i{g}.{k}"),
        }
    }
    fn parse(s: &str) -> Option<Split> {
        if let Some(k) = s.strip_prefix('o') {
            return k.parse().ok().map(Split::Outer);
        }
        let (g, k) = s.strip_prefix('i')?.split_once('.')?;
        Some(Split::Inner(g.parse().ok()?, k.parse().ok()?))
    }
}

struct Drag {
    split: Split,
    sizes: Vec<i32>, // along the gap's axis when the drag began (physical px)
    min: i32,
}

struct Swap {
    from: String,
    over: Option<String>,
}

#[derive(Clone)]
struct Placed {
    id: String,
    rect: Rect,
    info: Value,
}

struct Stage {
    picked: Vec<String>, // Ctrl+clicked, in order (not on stage yet)
    on: bool,
    screen: Rect, // the screen's work area it's on (physical px)
    scale: f64,
    rows: bool, // groups are rows (else columns)
    groups: Vec<Group>,
    spot: Option<String>,      // in the spotlight, the others in strips
    off: HashSet<String>,      // left out of "send to all"
    drag: Option<Drag>,
    swap: Option<Swap>,
    placed: HashMap<String, (Rect, Value)>, // what each robot's window was last given
    bar: Option<isize>,
    making: bool,
    sent: Option<Value>, // the bar's state, as it last had it
}

fn stg<R>(app: &AppHandle, f: impl FnOnce(&mut Stage) -> R) -> R {
    let state = app.state::<Mutex<Stage>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

fn ready(app: &AppHandle) -> bool {
    app.try_state::<Mutex<Stage>>().is_some()
}

// ---------------------------------------------------------------- the grid

/// `total` px shared out by weight (the last one takes what rounding left over).
fn split_px(total: i32, weights: &[f64]) -> Vec<i32> {
    let sum = weights.iter().sum::<f64>().max(1e-9);
    let mut used = 0;
    weights
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let v = if i + 1 == weights.len() { total - used } else { (total as f64 * w / sum).round() as i32 };
            used += v;
            v
        })
        .collect()
}

/// The gap after item k moved by d px: the item on the side it moved away from grows, and
/// the ones on the other side give way, the nearest first, each down to min.
fn give(sizes: &[i32], k: usize, d: i32, min: i32) -> Vec<i32> {
    let mut s = sizes.to_vec();
    if k + 1 >= s.len() || d == 0 {
        return s;
    }
    let (grow, takers): (usize, Vec<usize>) = if d > 0 { (k, (k + 1..s.len()).collect()) } else { (k + 1, (0..=k).rev().collect()) };
    let need = d.abs();
    let mut got = 0;
    for j in takers {
        let can = (s[j] - min).max(0).min(need - got);
        s[j] -= can;
        got += can;
        if got == need {
            break;
        }
    }
    s[grow] += got;
    s
}

/// How a cast of robots first shares the screen (CSS px of room): two side by side, three
/// one big and two stacked (all three side by side on a very wide screen), four and more in
/// rows, the first rows taking any odd one out; never narrower than a chat can be.
fn arrange(ids: &[String], w: f64, h: f64) -> (bool, Vec<Group>) {
    let n = ids.len();
    let fit = ((w / MIN_W).floor() as usize).max(1);
    let group = |ids: &[String]| Group { w: 1.0, tiles: ids.iter().map(|id| Tile { id: id.clone(), w: 1.0 }).collect() };
    let cols = |chunks: Vec<&[String]>| (false, chunks.into_iter().map(group).collect());
    match n {
        0 => (false, vec![]),
        1 => cols(vec![ids]),
        2 if fit >= 2 => cols(vec![&ids[..1], &ids[1..]]),
        3 if fit >= 3 && w / h > 2.2 => cols(vec![&ids[..1], &ids[1..2], &ids[2..]]),
        3 if fit >= 2 => cols(vec![&ids[..1], &ids[1..]]),
        _ if fit == 1 => cols(vec![ids]),
        _ => {
            let rows = ((n as f64).sqrt().round() as usize).max(n.div_ceil(fit)).max(1);
            let (base, extra) = (n / rows, n % rows);
            let mut at = 0;
            let groups = (0..rows)
                .map(|r| {
                    let len = base + usize::from(r < extra);
                    let g = group(&ids[at..at + len]);
                    at += len;
                    g
                })
                .filter(|g| !g.tiles.is_empty())
                .collect();
            (true, groups)
        }
    }
}

impl Stage {
    fn cast(&self) -> Vec<String> {
        self.groups.iter().flat_map(|g| g.tiles.iter().map(|t| t.id.clone())).collect()
    }

    fn has(&self, id: &str) -> bool {
        self.groups.iter().any(|g| g.tiles.iter().any(|t| t.id == id))
    }

    fn px(&self, css: f64) -> i32 {
        (css * self.scale).round() as i32
    }

    /// Where the tiles go: the screen less the bar along its bottom.
    fn area(&self) -> Rect {
        let bar = self.px(BAR_H);
        Rect { x: self.screen.x, y: self.screen.y, w: self.screen.w, h: self.screen.h - bar }
    }

    fn bar_rect(&self) -> Rect {
        let bar = self.px(BAR_H);
        Rect { x: self.screen.x, y: self.screen.bottom() - bar, w: self.screen.w, h: bar }
    }

    fn pill_rect(&self) -> Rect {
        let (w, h) = (self.px(PILL.0).min(self.screen.w), self.px(PILL.1));
        Rect { x: self.screen.x + (self.screen.w - w) / 2, y: self.screen.bottom() - h - self.px(16.0), w, h }
    }

    fn arrange(&mut self, ids: &[String]) {
        let a = self.area();
        let (rows, groups) = arrange(ids, a.w as f64 / self.scale, a.h as f64 / self.scale);
        self.rows = rows;
        self.groups = groups;
    }

    /// The most robots that fit on the screen.
    fn room(&self) -> usize {
        let a = self.area();
        let fit = ((a.w as f64 / self.scale / MIN_W).floor() as usize).max(1);
        let rows = ((a.h as f64 / self.scale / MIN_H).floor() as usize).clamp(1, MAX_ROWS);
        fit * rows
    }

    /// Each robot's window on the stage, and what its page needs to know about its tile
    /// (which of its edges are gaps you can drag, and which gap; or that it's in the
    /// spotlight, or a strip beside it).
    fn placements(&self) -> Vec<Placed> {
        let a = self.area();
        let cast = self.cast();
        let mut out = vec![];
        if let Some(spot) = self.spot.as_ref().filter(|s| cast.len() > 1 && cast.contains(s)) {
            let sw = self.px(STRIP_W).min(a.w / 3);
            out.push(Placed { id: spot.clone(), rect: Rect { x: a.x, y: a.y, w: a.w - sw, h: a.h }, info: json!({ "spot": true }) });
            let others: Vec<&String> = cast.iter().filter(|c| *c != spot).collect();
            let mut y = a.y;
            for (id, h) in others.iter().zip(split_px(a.h, &vec![1.0; others.len()])) {
                out.push(Placed { id: (*id).clone(), rect: Rect { x: a.right() - sw, y, w: sw, h }, info: json!({ "strip": true }) });
                y += h;
            }
            return out;
        }
        let (outer, inner) = if self.rows { (a.h, a.w) } else { (a.w, a.h) };
        let ng = self.groups.len();
        let mut o = 0;
        for (gi, (g, gsz)) in self.groups.iter().zip(split_px(outer, &self.groups.iter().map(|g| g.w).collect::<Vec<_>>())).enumerate() {
            let nt = g.tiles.len();
            let mut i = 0;
            for (ti, (t, tsz)) in g.tiles.iter().zip(split_px(inner, &g.tiles.iter().map(|t| t.w).collect::<Vec<_>>())).enumerate() {
                let rect = if self.rows { Rect { x: a.x + i, y: a.y + o, w: tsz, h: gsz } } else { Rect { x: a.x + o, y: a.y + i, w: gsz, h: tsz } };
                let before_o = (gi > 0).then(|| Split::Outer(gi - 1).name());
                let after_o = (gi + 1 < ng).then(|| Split::Outer(gi).name());
                let before_i = (ti > 0).then(|| Split::Inner(gi, ti - 1).name());
                let after_i = (ti + 1 < nt).then(|| Split::Inner(gi, ti).name());
                let (left, right, top, bottom) = if self.rows { (before_i, after_i, before_o, after_o) } else { (before_o, after_o, before_i, after_i) };
                out.push(Placed { id: t.id.clone(), rect, info: json!({ "edges": { "left": left, "right": right, "top": top, "bottom": bottom } }) });
                i += tsz;
            }
            o += gsz;
        }
        out
    }

    /// The sizes along a gap's axis (physical px), and whether that axis is across.
    fn sizes_of(&self, split: Split) -> Option<(Vec<i32>, bool)> {
        let a = self.area();
        let (outer, inner) = if self.rows { (a.h, a.w) } else { (a.w, a.h) };
        match split {
            Split::Outer(k) if k + 1 < self.groups.len() => Some((split_px(outer, &self.groups.iter().map(|g| g.w).collect::<Vec<_>>()), !self.rows)),
            Split::Inner(g, k) => {
                let tiles = &self.groups.get(g)?.tiles;
                (k + 1 < tiles.len()).then(|| (split_px(inner, &tiles.iter().map(|t| t.w).collect::<Vec<_>>()), self.rows))
            }
            _ => None,
        }
    }

    fn set_weights(&mut self, split: Split, sizes: &[i32]) {
        let ws = sizes.iter().map(|&v| v.max(1) as f64);
        match split {
            Split::Outer(_) => self.groups.iter_mut().zip(ws).for_each(|(g, w)| g.w = w),
            Split::Inner(g, _) => {
                if let Some(g) = self.groups.get_mut(g) {
                    g.tiles.iter_mut().zip(ws).for_each(|(t, w)| t.w = w);
                }
            }
        }
    }

    /// Out of the grid (its group goes too, once empty).
    fn remove(&mut self, id: &str) -> bool {
        let before = self.cast().len();
        for g in &mut self.groups {
            g.tiles.retain(|t| t.id != id);
        }
        self.groups.retain(|g| !g.tiles.is_empty());
        if self.spot.as_deref() == Some(id) {
            self.spot = None;
        }
        self.cast().len() != before
    }
}

// ---------------------------------------------------------------- the robots' windows

/// Lay every tile out (only the windows whose tile changed), and the bar.
fn apply(app: &AppHandle) {
    let jobs = stg(app, |s| {
        let now = if s.on { s.placements() } else { vec![] };
        let jobs: Vec<Placed> = now.iter().filter(|p| s.placed.get(&p.id) != Some(&(p.rect, p.info.clone()))).cloned().collect();
        s.placed = now.into_iter().map(|p| (p.id, (p.rect, p.info))).collect();
        jobs
    });
    for p in jobs {
        robots::set_tile(app, &p.id, Some(robots::StageTile { rect: p.rect, info: p.info }));
    }
    show_bar(app);
}

fn tell_robot(app: &AppHandle, id: &str, what: Value) {
    let _ = app.emit_to(robots::label_of(id), "robot:stage", what);
}

/// Each robot hears whether it's picked, and its number.
fn tell_picks(app: &AppHandle) {
    let picked = stg(app, |s| s.picked.clone());
    for id in robots::open_ids(app) {
        let n = picked.iter().position(|p| *p == id).map(|i| i + 1);
        tell_robot(app, &id, json!({ "kind": "pick", "n": n }));
    }
}

/// Can go on stage: its window open, at its desk (not out for a walk).
fn can_go(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some() && !walkers::has(app, id)
}

// ---------------------------------------------------------------- what it does

pub fn is_on(app: &AppHandle) -> bool {
    ready(app) && stg(app, |s| s.on)
}

pub fn picked(app: &AppHandle) -> Vec<String> {
    if !ready(app) {
        return vec![];
    }
    stg(app, |s| s.picked.clone())
}

pub fn cast(app: &AppHandle) -> Vec<String> {
    if !ready(app) {
        return vec![];
    }
    stg(app, |s| s.cast())
}

/// Ctrl+clicked (or ticked in the tray): picked, or not any more. On stage already, a robot
/// picked joins it.
pub fn toggle_pick(app: &AppHandle, id: &str) {
    if !can_go(app, id) {
        return;
    }
    if is_on(app) {
        if !stg(app, |s| s.has(id)) {
            add(app, id);
        }
        return;
    }
    let first = stg(app, |s| {
        if let Some(i) = s.picked.iter().position(|p| p == id) {
            s.picked.remove(i);
            false
        } else {
            s.picked.push(id.to_string());
            s.picked.len() == 1
        }
    });
    if first {
        // the pill shows on the screen you're working on
        let (cx, cy) = win::cursor();
        let m = win::monitor_near(cx, cy);
        stg(app, |s| (s.screen, s.scale) = (m.work, m.scale));
    }
    tell_picks(app);
    show_bar(app);
    tray::refresh(app);
}

pub fn clear_picks(app: &AppHandle) {
    stg(app, |s| s.picked.clear());
    tell_picks(app);
    show_bar(app);
    tray::refresh(app);
}

/// Take the stage: these robots (none: the ones picked), tiled over the screen the mouse is
/// on, each with its chat open.
pub fn start(app: &AppHandle, ids: Option<Vec<String>>) {
    if is_on(app) {
        exit(app);
    }
    let wanted = ids.unwrap_or_else(|| picked(app));
    let mut ids: Vec<String> = vec![];
    for id in wanted {
        if can_go(app, &id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    let (cx, cy) = win::cursor();
    let m = win::monitor_near(cx, cy);
    let cast = stg(app, |s| {
        s.screen = m.work;
        s.scale = m.scale;
        ids.truncate(s.room());
        if ids.is_empty() {
            return None;
        }
        s.picked.clear();
        s.on = true;
        s.spot = None;
        s.drag = None;
        s.swap = None;
        s.off.retain(|o| ids.contains(o));
        s.arrange(&ids);
        Some(ids.clone())
    });
    let Some(cast) = cast else { return };
    with(app, |st| st.store.update_settings(crate::util::patch(vec![("stageLast", json!(cast))])));
    tell_picks(app);
    apply(app);
    for id in &cast {
        // (awake with its chat open: robots.rs lays it out as its tile)
        let _ = app.emit_to(robots::label_of(id), "robot:action", "chat");
    }
    tray::refresh(app);
}

/// The last cast again (as it was when it last took the stage).
pub fn start_last(app: &AppHandle) {
    let last: Vec<String> = with(app, |st| {
        st.store.settings()["stageLast"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
    });
    if !last.is_empty() {
        start(app, Some(last));
    }
}

pub fn has_last(app: &AppHandle) -> bool {
    with(app, |st| st.store.settings()["stageLast"].as_array().is_some_and(|a| !a.is_empty()))
}

/// Off the stage: every robot back at its desk with its chat tucked away (still at work).
pub fn exit(app: &AppHandle) {
    if !is_on(app) {
        return;
    }
    let cast = stg(app, |s| {
        let cast = s.cast();
        s.on = false;
        s.groups.clear();
        s.spot = None;
        s.drag = None;
        s.swap = None;
        s.placed.clear();
        cast
    });
    for id in &cast {
        // (the tile's forgotten, but the window stays put till the page tucks the chat away:
        // laid out at its desk with the chat open first, it would jump there and back)
        robots::clear_tile(app, id);
        let _ = app.emit_to(robots::label_of(id), "robot:action", "tuck");
    }
    show_bar(app);
    tray::refresh(app);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(700));
        for id in &cast {
            robots::apply_layout(&app, id); // (one that didn't tuck away goes back to its desk anyway)
        }
    });
}

/// Onto the stage as it is (the grid is shared out afresh).
pub fn add(app: &AppHandle, id: &str) {
    let ok = stg(app, |s| {
        let mut cast = s.cast();
        if cast.iter().any(|c| c == id) || cast.len() >= s.room() {
            return false;
        }
        cast.push(id.to_string());
        s.arrange(&cast);
        true
    });
    if ok {
        apply(app);
        let _ = app.emit_to(robots::label_of(id), "robot:action", "chat");
    }
}

/// Off the stage, just this robot: its chat back beside it at its desk. The last one off
/// ends the stage.
pub fn leave(app: &AppHandle, id: &str) {
    if !is_on(app) {
        return;
    }
    let left = stg(app, |s| {
        if !s.remove(id) {
            return None;
        }
        s.placed.remove(id);
        s.off.remove(id);
        Some(s.groups.is_empty())
    });
    let Some(empty) = left else { return };
    robots::set_tile(app, id, None);
    if empty {
        stg(app, |s| s.on = false);
        show_bar(app);
        tray::refresh(app);
    } else {
        apply(app);
    }
}

/// Its window went (put away, or its page died for good).
pub fn gone(app: &AppHandle, id: &str) {
    if !ready(app) {
        return;
    }
    let (was_on, empty) = stg(app, |s| {
        s.picked.retain(|p| p != id);
        let was = s.remove(id);
        s.placed.remove(id);
        if was && s.groups.is_empty() {
            s.on = false;
        }
        (was, s.groups.is_empty())
    });
    if was_on && !empty {
        apply(app);
    } else {
        show_bar(app);
    }
    tray::refresh(app);
}

/// The screens changed: onto the screen it was on (or the nearest), shared out afresh.
pub fn refit(app: &AppHandle) {
    if !is_on(app) {
        return;
    }
    stg(app, |s| {
        let m = win::monitor_near(s.screen.x + s.screen.w / 2, s.screen.y + s.screen.h / 2);
        s.screen = m.work;
        s.scale = m.scale;
        let cast = s.cast();
        s.arrange(&cast);
        s.placed.clear();
    });
    apply(app);
}

// ---------------------------------------------------------------- the bar

fn bar_state(app: &AppHandle) -> Value {
    let robots = island::robots_view(app);
    stg(app, |s| {
        json!({
            "mode": if s.on { "stage" } else { "pick" },
            "picked": s.picked,
            "cast": s.cast(),
            "off": s.off.iter().collect::<Vec<_>>(),
            "spot": s.spot,
            "room": s.room(),
            "robots": robots,
        })
    })
}

/// The bar hears how things are now (a robot busy, one more picked…).
pub fn changed(app: &AppHandle) {
    if !ready(app) || stg(app, |s| s.bar.is_none()) {
        return;
    }
    let now = bar_state(app);
    let new = stg(app, |s| (s.sent.as_ref() != Some(&now)).then(|| s.sent = Some(now.clone())).is_some());
    if new {
        let _ = app.emit_to(LABEL, "stage:state", now);
    }
}

/// The bar where it goes (the pill while picking, the bar on stage), made or closed.
fn show_bar(app: &AppHandle) {
    let (want, hwnd, making) = stg(app, |s| {
        let want = if s.on { Some(s.bar_rect()) } else if !s.picked.is_empty() { Some(s.pill_rect()) } else { None };
        (want, s.bar, s.making)
    });
    match (want, hwnd) {
        (None, Some(_)) => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.close();
            }
        }
        (Some(r), Some(h)) => {
            win::set_bounds(h, r);
            changed(app);
        }
        (Some(_), None) if !making => {
            stg(app, |s| s.making = true);
            let app = app.clone();
            // (off this thread: a window event may be what asks, on the main thread)
            thread::spawn(move || {
                let hwnd = make_bar(&app);
                stg(&app, |s| {
                    s.making = false;
                    s.bar = hwnd;
                    s.sent = None;
                });
                show_bar(&app); // (where it goes now, or gone again if it's no longer wanted)
            });
        }
        _ => {}
    }
}

fn make_bar(app: &AppHandle) -> Option<isize> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return w.hwnd().ok().map(|h| h.0 as isize);
    }
    let built = views::builder(app, LABEL, "stage", &[])
        .title("C-Bot stage")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(PILL.0, PILL.1)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[stage] couldn't make the bar: {err}");
            return None;
        }
    };
    let hwnd = w.hwnd().ok()?.0 as isize;
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            stg(&app2, |s| {
                if s.bar == Some(hwnd) {
                    s.bar = None;
                    s.sent = None;
                }
            });
        }
    });
    Some(hwnd)
}

/// One message to every robot on stage that's not left out: each robot's page sends it in
/// its own chat, as if you'd typed it there (waiting its turn if it's busy).
fn send(app: &AppHandle, prompt: &str, paths: &[String]) -> Value {
    let to = stg(app, |s| s.cast().into_iter().filter(|id| !s.off.contains(id)).collect::<Vec<_>>());
    if to.is_empty() {
        return json!({ "ok": false, "error": "Nobody's chosen to send it to." });
    }
    let names: Vec<Value> = with(app, |st| to.iter().map(|id| st.store.get(id).map(|c| c["name"].clone()).unwrap_or(Value::Null)).collect());
    for id in &to {
        tell_robot(app, id, json!({ "kind": "ask", "prompt": prompt, "paths": paths, "to": names, "all": to.len() == stg(app, |s| s.cast().len()) }));
    }
    json!({ "ok": true, "count": to.len() })
}

// ---------------------------------------------------------------- what the pages ask

/// A robot Ctrl+clicked: picked for the stage, or not.
#[tauri::command(async)]
pub fn stage_pick(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    toggle_pick(&app, &robots::sender(&window)?);
    Ok(())
}

/// A tile's title bar: spotlight it (again: back to the grid), or step off the stage.
#[tauri::command(async)]
pub fn stage_tile(app: AppHandle, window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    let id = robots::sender(&window)?;
    match action.as_str() {
        "spot" => {
            if stg(&app, |s| {
                if !s.on || !s.has(&id) {
                    return false;
                }
                s.spot = if s.spot.as_deref() == Some(&id) { None } else { Some(id.clone()) };
                true
            }) {
                apply(&app);
            }
        }
        "leave" => leave(&app, &id),
        _ => {}
    }
    Ok(())
}

/// A gap between tiles dragged (d: CSS px along it since the press), or double-clicked
/// ("even": every tile on that line the same size).
#[tauri::command(async)]
pub fn stage_split(app: AppHandle, window: tauri::WebviewWindow, step: Value) -> Result<(), String> {
    robots::sender(&window)?;
    let Some(split) = step["split"].as_str().and_then(Split::parse) else { return Ok(()) };
    let k = match split {
        Split::Outer(k) | Split::Inner(_, k) => k,
    };
    let moved = stg(&app, |s| {
        if !s.on || s.spot.is_some() {
            return false;
        }
        match step["phase"].as_str() {
            Some("start") => {
                let Some((sizes, across)) = s.sizes_of(split) else { return false };
                let min = s.px(if across { MIN_W } else { MIN_H });
                s.drag = Some(Drag { split, sizes, min });
                false
            }
            Some("move") => {
                let Some(d) = s.drag.as_ref().filter(|d| d.split == split) else { return false };
                let px = s.px(step["d"].as_f64().unwrap_or(0.0));
                let sizes = give(&d.sizes, k, px, d.min);
                s.set_weights(split, &sizes);
                true
            }
            Some("end") => {
                s.drag = None;
                false
            }
            Some("even") => {
                let Some((sizes, _)) = s.sizes_of(split) else { return false };
                s.set_weights(split, &vec![1; sizes.len()]);
                true
            }
            _ => false,
        }
    });
    if moved {
        apply(&app);
    }
    Ok(())
}

/// A tile's title bar dragged onto another tile: they change places.
#[tauri::command(async)]
pub fn stage_swap(app: AppHandle, window: tauri::WebviewWindow, phase: String) -> Result<(), String> {
    let id = robots::sender(&window)?;
    match phase.as_str() {
        "start" => stg(&app, |s| s.swap = s.on.then(|| Swap { from: id.clone(), over: None })),
        "move" => {
            let (cx, cy) = win::cursor();
            let hover = stg(&app, |s| {
                let sw = s.swap.as_mut()?;
                let over = s.placed.iter().find(|(pid, (r, _))| **pid != sw.from && r.contains(cx, cy)).map(|(pid, _)| pid.clone());
                (over != sw.over).then(|| (std::mem::replace(&mut sw.over, over.clone()), over))
            });
            if let Some((was, now)) = hover {
                if let Some(was) = was {
                    tell_robot(&app, &was, json!({ "kind": "target", "on": false }));
                }
                if let Some(now) = now {
                    tell_robot(&app, &now, json!({ "kind": "target", "on": true }));
                }
            }
        }
        "end" => {
            let target = stg(&app, |s| {
                let sw = s.swap.take()?;
                let to = sw.over?;
                let at = |s: &Stage, id: &str| s.groups.iter().enumerate().find_map(|(g, gr)| gr.tiles.iter().position(|t| t.id == id).map(|t| (g, t)));
                let (a, b) = (at(s, &sw.from)?, at(s, &to)?);
                let ida = s.groups[a.0].tiles[a.1].id.clone();
                s.groups[a.0].tiles[a.1].id = s.groups[b.0].tiles[b.1].id.clone();
                s.groups[b.0].tiles[b.1].id = ida;
                Some(to)
            });
            if let Some(t) = target {
                tell_robot(&app, &t, json!({ "kind": "target", "on": false }));
                apply(&app);
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command(async)]
pub fn stage_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, LABEL)?;
    let now = bar_state(&app);
    stg(&app, |s| s.sent = Some(now.clone()));
    Ok(now)
}

/// The bar's buttons: take the stage, forget the picks, end it, even the tiles out, bring
/// another robot on, leave one out of "send to all" (or back in).
#[tauri::command(async)]
pub fn stage_act(app: AppHandle, window: tauri::WebviewWindow, action: String, id: Option<String>) -> Result<(), String> {
    only(&window, LABEL)?;
    let id = id.unwrap_or_default();
    match action.as_str() {
        "start" => start(&app, None),
        "clear" => clear_picks(&app),
        "unpick" => toggle_pick(&app, &id),
        "exit" => exit(&app),
        "add" => add(&app, &id),
        "even" => {
            let cast = stg(&app, |s| {
                s.spot = None;
                s.cast()
            });
            stg(&app, |s| s.arrange(&cast));
            apply(&app);
        }
        "chip" => {
            stg(&app, |s| {
                if !s.off.remove(&id) {
                    s.off.insert(id.clone());
                }
            });
            changed(&app);
        }
        _ => {}
    }
    Ok(())
}

/// The bar's ＋: a menu of the robots on the desk that aren't on stage (tray.rs picks it).
#[tauri::command(async)]
pub fn stage_add_menu(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    only(&window, LABEL)?;
    let cast = cast(&app);
    let others: Vec<(String, String)> = with(&app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c["visible"].as_bool().unwrap_or(false))
            .filter_map(|c| Some((c["id"].as_str()?.to_string(), c["name"].as_str().unwrap_or("Robo").to_string())))
            .filter(|(id, _)| !cast.contains(id))
            .collect()
    });
    let mut items: Vec<tauri::Result<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> = others
        .iter()
        .filter(|(id, _)| can_go(&app, id))
        .map(|(id, name)| tray::item(&app, format!("stage|add|{id}"), name, true))
        .collect();
    if items.is_empty() {
        items.push(tray::item(&app, "none".into(), "Every robot on the desk is on stage", false));
    }
    if let Ok(menu) = tray::build_menu(&app, items) {
        let _ = window.popup_menu(&menu);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn stage_send(app: AppHandle, window: tauri::WebviewWindow, prompt: String, paths: Vec<String>) -> Result<Value, String> {
    only(&window, LABEL)?;
    let prompt = prompt.trim();
    if prompt.is_empty() && paths.is_empty() {
        return Ok(json!({ "ok": false, "error": "Nothing to send." }));
    }
    Ok(send(&app, prompt, &paths))
}

/// The bar's 📎: files (or pictures) to send along.
#[tauri::command(async)]
pub fn stage_pick_files(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<Value>, String> {
    only(&window, LABEL)?;
    let picked = app.dialog().file().set_parent(&window).set_title("Files to show every robot").blocking_pick_files().unwrap_or_default();
    Ok(picked.into_iter().filter_map(|f| f.into_path().ok()).take(20).filter_map(|p| crate::clipboard::inspect(&p.to_string_lossy())).collect())
}

pub fn setup(app: &AppHandle) {
    let p = win::primary_monitor();
    app.manage(Mutex::new(Stage {
        picked: vec![],
        on: false,
        screen: p.work,
        scale: p.scale,
        rows: false,
        groups: vec![],
        spot: None,
        off: HashSet::new(),
        drag: None,
        swap: None,
        placed: HashMap::new(),
        bar: None,
        making: false,
        sent: None,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("r{i}")).collect()
    }

    fn shape(rows: bool, groups: &[Group]) -> (bool, Vec<usize>) {
        (rows, groups.iter().map(|g| g.tiles.len()).collect())
    }

    #[test]
    fn arranges_by_count() {
        let (w, h) = (1920.0, 1000.0);
        let s = |n| {
            let (r, g) = arrange(&ids(n), w, h);
            shape(r, &g)
        };
        assert_eq!(s(1), (false, vec![1]));
        assert_eq!(s(2), (false, vec![1, 1]));
        assert_eq!(s(3), (false, vec![1, 2]));
        assert_eq!(s(4), (true, vec![2, 2]));
        assert_eq!(s(5), (true, vec![3, 2]));
        assert_eq!(s(6), (true, vec![3, 3]));
        assert_eq!(s(7), (true, vec![3, 2, 2]));
        // a very wide screen: three side by side
        let (r, g) = arrange(&ids(3), 3440.0, 1400.0);
        assert_eq!(shape(r, &g), (false, vec![1, 1, 1]));
        // too narrow for two side by side: stacked
        let (r, g) = arrange(&ids(2), 600.0, 1000.0);
        assert_eq!(shape(r, &g), (false, vec![2]));
    }

    #[test]
    fn shares_out_every_pixel() {
        assert_eq!(split_px(1000, &[1.0, 1.0, 1.0]), vec![333, 333, 334]);
        assert_eq!(split_px(900, &[2.0, 1.0]), vec![600, 300]);
    }

    #[test]
    fn neighbours_give_way() {
        // the nearest gives way first, down to its minimum, then the next
        assert_eq!(give(&[400, 400, 400], 0, 30, 360), vec![430, 370, 400]);
        assert_eq!(give(&[400, 400, 400], 0, 100, 360), vec![480, 360, 360]);
        assert_eq!(give(&[400, 400, 400], 1, -50, 360), vec![390, 360, 450]);
        // no further than everyone's minimum
        assert_eq!(give(&[400, 400], 0, 500, 360), vec![440, 360]);
    }

    #[test]
    fn splits_round_trip() {
        for s in [Split::Outer(2), Split::Inner(1, 3)] {
            assert!(Split::parse(&s.name()) == Some(s));
        }
        assert!(Split::parse("x1").is_none());
    }
}
