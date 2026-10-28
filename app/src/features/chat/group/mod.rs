//! The robot group chat and its meeting room (main groupChat.js, meeting.js): you pick a
//! topic and some robots, and they talk it over together, each in its own personality and
//! from what it knows of its own folder, until they've nothing more to add, agree, reach the
//! limit or you wrap it up; then the host sums it up. A window of its own ("groupchat",
//! renderer/groupchat) shows it live, and you can chime in. Two styles:
//!   free   (the default) like people in a chat app: every robot sees every message as it's
//!          posted and decides for itself whether to reply or stay quiet (<pass/>). Several
//!          can be typing at once; a message is posted when it's finished, so they can cross.
//!          A robot that finishes catches up on what came in meanwhile and decides again. It
//!          ends when nobody has more to add (everyone's quiet), at the message limit, the
//!          cost cap, or when you wrap it up.
//!   turns  one at a time: a round is every robot speaking once, the host first. Next up is
//!          whoever was last @-mentioned among those who haven't spoken this round, else the
//!          next in order. It ends after the last round, when every robot ends its message
//!          with <agree/> in the same round, at the cost cap, or when you wrap it up.
//! In both, a robot you @-mention answers you next (free: it's told it was asked).
//! Each robot speaks from a Claude Code conversation of its own for the chat, in its folder,
//! with its personality and the chat's rules. It's sent only what was said since it last
//! looked, so it remembers without re-reading. Talk only: Read, Grep and Glob, no MCP
//! servers, and anything that would need permission is refused.
//! The meeting room ("meeting", renderer/meeting; the default): everyone gets up from their
//! desk and rolls into one room round a table, where whoever's talking has a speech bubble
//! and the others turn to it. The moment the chat's over (done or stopped) the room goes and
//! they're back at their desks. Without it, on the desks: the others turn to whoever just
//! spoke, it says a line of it in its speech bubble, and a paper plane flies to whoever it
//! @-mentioned (taking turns: to whoever speaks next); they wave at the end.
//!
//! Everything happens under one lock (act), as groupChat.js did on its one thread; what that
//! changes outside (windows, robots, Claude Code processes, timers) is collected as effects
//! and done once the lock is let go.

mod commands;
mod talk;
mod windows;

pub use commands::*;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::claude::{Event, Session, locate};
use crate::agents::{claude, personalities};
use crate::features::notes;
use crate::platform::window::Rect;
use crate::platform::{clipboard, window};
use crate::robots;
use crate::robots::{planes, social, walkers};
use crate::runtime::util::{only, patch, text};
use crate::runtime::{Locked, hub, with};
use crate::store::Fields;
use crate::store::now_ms;
use crate::ui::views;

use windows::*;

const LABEL: &str = "groupchat";
const ROOM: &str = "meeting";
const SIZE: (f64, f64) = (460.0, 640.0);
const MIN_SIZE: (f64, f64) = (360.0, 420.0);
const ROUNDS: [u64; 3] = [2, 3, 5];
const MESSAGES: [u64; 3] = [10, 20, 40]; // the free chat's length: robot messages at most
const CAPS: [f64; 4] = [0.5, 1.0, 2.0, 5.0]; // US$
const MEMBERS_MAX: usize = 8;
const TURN_TIMEOUT_MS: u64 = 4 * 60_000; // a turn that takes longer is stopped and skipped
const STUCK_MS: u64 = 15_000; // (stopped and still not done: its process goes too)
const FAILS_MAX: u32 = 2; // turns a robot can fail before it drops out
const QUOTE_MAX: usize = 3000; // characters of a message passed on to the others
const TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
const THROW_AT_MS: u64 = 900; // into its throw that the plane leaves its hand (robot.ts plane-throw)
const ROOM_GAP: f64 = 10.0;

fn pass_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<pass\s*/?>").unwrap());
    &RE
}

fn agree_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</?agree\s*/?>").unwrap());
    &RE
}

fn mention_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@([\p{L}\p{N}_-]+)").unwrap());
    &RE
}

/// What the robots are told, on top of their personality.
fn rules(name: &str, others: &[String], mode: Style) -> String {
    let mut lines: Vec<String> = vec![
        String::new(),
        "You are taking part in a group chat with other C-Bot robots and the user, about one topic. Each robot looks after its own project folder.".into(),
        format!("The others: {}; and the user.", others.join("; ")),
        "How to take part:".into(),
        "- Bring what you know from your own folder. If it helps, look things up first (Read, Grep, Glob: quickly, a few files at most) and mention concrete findings (file names, values, how things work).".into(),
        "- This chat is talk only: do not change files or run commands (you cannot here). No <aside> remarks in this chat.".into(),
        format!("- Speak only for yourself, {name}, in your own personality. Never write lines for the others."),
    ];
    let more: &[&str] = if mode == Style::Turns {
        &[
            "- One message per turn, 2 to 6 sentences (a short list is fine).",
            "- Respond to what the others and the user said: agree, disagree, build on it, or ask someone directly with @Name. When the user speaks, answer them.",
            "- Steer toward a conclusion the group can share. When you agree with where the group has landed, end your message with <agree/> on its own line. Do not say it just to be nice.",
        ]
    } else {
        &[
            "- It is a live chat, like people in a chat app: everyone sees every message and speaks up only when they have something to add. Others may be typing at the same time as you.",
            "- Each time, you get the new messages. Reply with one short message (1 to 4 sentences), or with exactly <pass/> to stay quiet.",
            "- Speak up when someone asks you something, when the user speaks, when you know something relevant from your folder that has not been said, when you disagree, or when you can move the group toward a conclusion.",
            "- Use @Name only when you ask that robot something or answer its question, not to greet or include everyone. The user reads everything: never @ the user.",
            "- Stay quiet (<pass/>) when you would only repeat what was said, confirm, thank, or agree. Never post a message just to say you agree or that the plan works for you. Silence is normal: the chat ends when nobody has more to add.",
            "- When you agree with where the group has landed and have nothing new to add, reply <agree/> alone (it is not posted; it tells the group you agree). Once everyone agrees, the chat ends.",
        ]
    };
    lines.extend(more.iter().map(|l| l.to_string()));
    lines.join("\n")
}

/// Who a message @-mentions, among (id, name): by name, or the start of one ("@cap" for Captain).
fn mentions_in(text: &str, members: &[(String, String)]) -> Vec<String> {
    let words: Vec<String> = mention_re()
        .captures_iter(text)
        .map(|m| m[1].to_lowercase())
        .collect();
    members
        .iter()
        .filter(|(_, name)| {
            let n: String = name.to_lowercase().split_whitespace().collect();
            words
                .iter()
                .any(|w| *w == n || (w.chars().count() >= 2 && n.starts_with(w.as_str())))
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// A line of what it said, for a speech bubble.
fn bubble_line(text: &str) -> String {
    let line: String = text.chars().filter(|c| !"#*_`>".contains(*c)).collect();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 90 {
        format!("{}…", line.chars().take(88).collect::<String>())
    } else {
        line
    }
}

/// A message as the others read it, cut to QUOTE_MAX.
fn quote(text: &str) -> String {
    if text.chars().count() > QUOTE_MAX {
        format!("{}…", text.chars().take(QUOTE_MAX).collect::<String>())
    } else {
        text.to_string()
    }
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

// ---------------------------------------------------------------- effects

type Job = Box<dyn FnOnce(&AppHandle) + Send>;

/// Something to do once the lock is let go.
enum Fx {
    Emit(&'static str, &'static str, Value), // (window, channel, payload)
    Robot(String, &'static str, Value),      // to a robot's desk
    Dock(String),
    Ask(Arc<Session>, String, String),
    Interrupt(Arc<Session>),
    Close(Arc<Session>),
    Warm(Arc<Session>),
    After(u64, Job),
    RoomOpen { people: Value, room_gen: u64 },
    RoomClose,
}

struct Env<'a> {
    app: &'a AppHandle,
    fx: Vec<Fx>,
    changed: bool,
}

impl Env<'_> {
    fn tell(&mut self, id: &str, payload: Value) {
        self.fx
            .push(Fx::Robot(id.to_string(), "robot:social", payload));
    }

    fn action(&mut self, id: &str, action: &str) {
        self.fx
            .push(Fx::Robot(id.to_string(), "robot:action", json!(action)));
    }

    /// Do this to the chat in `ms` (if there's still one).
    fn later(&mut self, ms: u64, f: impl FnOnce(&mut Chat, &mut Env) + Send + 'static) {
        self.fx.push(Fx::After(
            ms,
            Box::new(move |app: &AppHandle| {
                act(app, |g, env| {
                    if let Some(c) = g.chat.as_mut() {
                        f(c, env);
                    }
                })
            }),
        ));
    }
}

static ROOM_GEN: AtomicU64 = AtomicU64::new(0); // goes up as the room opens or closes
static SEQ: AtomicU64 = AtomicU64::new(0); // message ids

fn run(app: &AppHandle, fx: Vec<Fx>) {
    for f in fx {
        match f {
            Fx::Emit(label, channel, payload) => {
                let _ = app.emit_to(label, channel, payload);
            }
            Fx::Robot(id, channel, payload) => hub::send_to_robot(app, &id, channel, payload),
            Fx::Dock(id) => walkers::dock(app, &id),
            Fx::Ask(s, prompt, turn_id) => {
                s.ask(prompt, turn_id);
            }
            Fx::Interrupt(s) => {
                s.interrupt();
            }
            Fx::Close(s) => s.close(),
            Fx::Warm(s) => s.warm(),
            Fx::After(ms, job) => {
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(ms));
                    job(&app);
                });
            }
            Fx::RoomOpen { people, room_gen } => {
                let app = app.clone();
                thread::spawn(move || open_room(&app, people, room_gen));
            }
            Fx::RoomClose => {
                if let Some(w) = app.get_webview_window(ROOM) {
                    let _ = w.destroy(); // (at once: everyone's back at their desks)
                }
            }
        }
    }
}

// ---------------------------------------------------------------- the chat

struct Turn {
    turn_id: String,
    msg: Option<u64>, // the message its words go into as they come (taking turns, the summary)
    text: String,
    looked: Vec<String>,
    on_done: OnDone,
    timed_out: bool,
}

enum OnDone {
    Posted { asked: bool }, // free chat: a message, or quiet
    Spoken { msg: u64 },    // taking turns, or the summary
}

#[derive(Default)]
struct Person {
    session: Option<Arc<Session>>,
    session_id: Option<String>,
    seen: usize, // how much of the log it has been sent
    turn: Option<Turn>,
    agree: bool,
}

/// How the talk goes: anyone may speak (the robots keep it going themselves), or in turns.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Style {
    Free,
    Turns,
}

struct Chat {
    mode: Style,
    topic: String,
    host_id: String,
    members: Vec<String>,
    max_rounds: u64,
    max_messages: u64,
    step: u64, // (keep talking: this many more)
    cap: f64,
    fast: bool,
    room: bool, // (in the meeting room)
    round: u64,
    spoke: HashSet<String>,
    agreed: Vec<String>,
    out: HashSet<String>,
    fails: HashMap<String, u32>,
    next_up: Vec<String>,
    cost: f64,
    status: &'static str, // running | summarising | done | stopped
    speaker: Option<String>,
    last_speaker: Option<String>,
    wrapping: bool,
    ended: String,
    log: Vec<Value>,
    people: HashMap<String, Person>,
    summary: Option<String>,
    room_open: bool,
    room_info: Option<Value>, // what the meeting room's page asks for when it loads
}

#[derive(Default)]
struct Group {
    host: Option<String>, // who it was opened from
    chat: Option<Chat>,   // the chat going on (or just over)
    shown: bool,          // its window has been placed and shown
}

/// Do something with the group chat, under its lock; then what it changed outside.
fn act<R>(app: &AppHandle, f: impl FnOnce(&mut Group, &mut Env) -> R) -> R {
    let Some(state) = app.try_state::<Mutex<Group>>() else {
        return f(
            &mut Group::default(),
            &mut Env {
                app,
                fx: vec![],
                changed: false,
            },
        );
    };
    let mut env = Env {
        app,
        fx: vec![],
        changed: false,
    };
    let r = {
        let mut g = state.locked();
        let r = f(&mut g, &mut env);
        if env.changed {
            let view = view(app, &g);
            env.fx.push(Fx::Emit(LABEL, "groupchat:state", view));
            if let Some(c) = g.chat.as_mut().filter(|c| c.room_open) {
                let state = c.meeting_state(app);
                if let Some(info) = c.room_info.as_mut() {
                    info["state"] = state.clone();
                }
                env.fx.push(Fx::Emit(ROOM, "meeting:state", state));
            }
        }
        r
    };
    run(app, std::mem::take(&mut env.fx));
    r
}

fn name(app: &AppHandle, id: &str) -> String {
    with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["name"].as_str().map(str::to_string))
    })
    .unwrap_or_else(|| "A robot".into())
}

fn visible(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some_and(window::is_visible)
}

fn is_asleep(app: &AppHandle, id: &str) -> bool {
    social::peek(app, id).is_some_and(|r| r["awake"] == false)
}

fn personality_of(c: &Value) -> Value {
    let all = personalities::all();
    all.get(c.personality())
        .or_else(|| all.values().next())
        .cloned()
        .unwrap_or(json!({}))
}

fn robot_info(app: &AppHandle, id: &str) -> Option<Value> {
    let c = with(app, |st| st.store.get(id).cloned())?;
    let p = personality_of(&c);
    let folder = c.folder();
    let base = Path::new(folder)
        .file_name()
        .map(|b| b.to_string_lossy().into_owned())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| folder.to_string());
    Some(json!({
        "id": id, "name": c["name"], "color": c["color"].as_str().unwrap_or(""), "emoji": p["emoji"].as_str().unwrap_or("🤖"),
        "personality": p["label"].as_str().unwrap_or(""), "folder": base, "onDesk": visible(app, id), "asleep": is_asleep(app, id),
    }))
}

fn view(app: &AppHandle, g: &Group) -> Value {
    let Some(c) = &g.chat else {
        let ids: Vec<String> = with(app, |st| {
            st.store
                .list()
                .iter()
                .filter_map(|c| c["id"].as_str().map(str::to_string))
                .collect()
        });
        let robots: Vec<Value> = ids.iter().filter_map(|id| robot_info(app, id)).collect();
        return json!({ "phase": "setup", "hostId": g.host, "robots": robots, "rounds": ROUNDS, "messages": MESSAGES, "caps": CAPS });
    };
    let robots: Vec<Value> = c
        .members
        .iter()
        .filter_map(|id| {
            let mut r = robot_info(app, id)?;
            r["out"] = json!(c.out.contains(id));
            r["agree"] = json!(c.people.get(id).is_some_and(|p| p.agree));
            Some(r)
        })
        .collect();
    // free chat: who's writing a message right now, and what they're looking at
    let typing: Vec<Value> = if c.free() {
        c.typing(app)
            .into_iter()
            .filter_map(|id| {
                let t = c
                    .people
                    .get(&id)?
                    .turn
                    .as_ref()
                    .filter(|t| t.msg.is_none())?;
                Some(json!({ "id": id, "looked": t.looked.last().cloned().unwrap_or_default() }))
            })
            .collect()
    } else {
        vec![]
    };
    json!({
        "phase": c.status, "mode": c.mode, "topic": c.topic, "hostId": c.host_id, "robots": robots,
        "round": c.round, "rounds": c.max_rounds, "said": c.said(), "messages": c.max_messages, "cost": c.cost, "cap": c.cap,
        "speaker": c.speaker, "typing": typing, "wrapping": c.wrapping, "ended": c.ended, "log": c.log,
    })
}

fn text_of(v: &Value) -> String {
    text(v)
}

fn centre(app: &AppHandle, id: &str) -> Option<(f64, f64)> {
    hub::robot_rect(app, id).map(|r| (r.x as f64 + r.w as f64 / 2.0, r.y as f64 + r.h as f64 / 2.0))
}

/// Which side `to` is on, seen from `from`.
fn side_of(app: &AppHandle, from: &str, to: &str) -> &'static str {
    let x = |id: &str| centre(app, id).map_or(0.0, |c| c.0);
    if x(to) < x(from) { "L" } else { "R" }
}

fn hand(app: &AppHandle, id: &str, side: &str, up: bool) -> Option<(f64, f64)> {
    let r = hub::robot_rect(app, id)?;
    Some((
        r.x as f64 + r.w as f64 * if side == "L" { 0.36 } else { 0.64 },
        r.y as f64 + r.h as f64 * if up { 0.3 } else { 0.42 },
    ))
}

/// The session's events, for the robot whose chat process it is (an old one's are ignored).
fn on_session(app: &AppHandle, id: &str, session: &Arc<Session>, event: Event) {
    let failed = matches!(event, Event::Fail(_));
    act(app, |g, env| {
        let Some(c) = g.chat.as_mut() else { return };
        let Some(me) = c.people.get_mut(id) else {
            return;
        };
        if !me.session.as_ref().is_some_and(|s| Arc::ptr_eq(s, session)) {
            return;
        }
        match event {
            Event::Text(delta) => {
                let Some(t) = me.turn.as_mut() else { return };
                t.text.push_str(&delta);
                let Some(msg_id) = t.msg else { return };
                if let Some(m) = c.msg(msg_id) {
                    m["text"] = json!(format!("{}{delta}", m["text"].as_str().unwrap_or("")));
                    env.fx.push(Fx::Emit(
                        LABEL,
                        "groupchat:delta",
                        json!({ "id": msg_id, "delta": delta }),
                    ));
                }
            }
            Event::Tool(data) => {
                let Some(t) = me.turn.as_mut() else { return };
                let detail = data["detail"]
                    .as_str()
                    .filter(|d| !d.is_empty())
                    .or(data["name"].as_str())
                    .unwrap_or("")
                    .to_string();
                t.looked.push(detail);
                let (looked, msg) = (t.looked.clone(), t.msg);
                if let Some(m) = msg.and_then(|m| c.msg(m)) {
                    m["looked"] = json!(looked);
                }
                env.changed = true;
            }
            Event::Aside(text) => {
                if me.turn.is_some() {
                    env.tell(id, json!({ "phase": "say", "text": format!("💭 {text}") }));
                }
            }
            Event::Done(data) | Event::Fail(data) => {
                if me
                    .turn
                    .as_ref()
                    .is_none_or(|t| data["turnId"] != t.turn_id.as_str())
                {
                    return;
                }
                let r = if !failed {
                    data
                } else {
                    let mut r = data.clone();
                    r["isError"] = json!(true);
                    r["text"] = json!("");
                    r["error"] = data["message"].clone();
                    r
                };
                c.end_turn(env, id, r);
            }
            _ => {}
        }
    });
}

// ---------------------------------------------------------------- for the others

/// Open the group chat (or bring it round), hosted by this robot (ticked, and the host).
pub fn open(app: &AppHandle, host_id: Option<String>) {
    act(app, |g, env| {
        if g.chat.is_none() {
            g.host = host_id;
        }
        env.changed = true;
    });
    let app = app.clone();
    // (off this thread: it's called from menus, on the main thread, where building a window would wait on itself)
    thread::spawn(move || match app.get_webview_window(LABEL) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => build_window(&app),
    });
}

/// This robot is in the chat going on (for its menu).
pub fn in_chat(app: &AppHandle, id: &str) -> bool {
    act(app, |g, _| {
        g.chat.as_ref().is_some_and(|c| {
            c.members.iter().any(|m| m == id)
                && (c.status == "running" || c.status == "summarising")
        })
    })
}

/// The group chat window is open.
pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

fn start(g: &mut Group, env: &mut Env, p: &Value) -> Value {
    let app = env.app;
    let topic: String = text(&p["topic"]).trim().chars().take(2000).collect();
    let mut members: Vec<String> = vec![];
    for m in p["members"].as_array().into_iter().flatten().map(text) {
        if !members.contains(&m) && with(app, |st| st.store.get(&m).is_some()) && visible(app, &m) {
            members.push(m);
        }
    }
    members.truncate(MEMBERS_MAX);
    if topic.is_empty() {
        return json!({ "error": "What should they talk about?" });
    }
    if members.len() < 2 {
        return json!({ "error": "Pick at least two robots (on the desk)." });
    }
    end(g, env);
    let host_id = g
        .host
        .clone()
        .filter(|h| members.contains(h))
        .unwrap_or_else(|| members[0].clone());
    members.retain(|m| *m != host_id);
    members.insert(0, host_id.clone());
    let pick = |v: &Value, list: &[u64], def: u64| {
        number(v)
            .filter(|n| list.iter().any(|x| *x as f64 == *n))
            .map_or(def, |n| n as u64)
    };
    let max_messages = pick(&p["messages"], &MESSAGES, 20);
    let cap = number(&p["cap"])
        .filter(|n| CAPS.contains(n))
        .unwrap_or(1.0);
    let mut c = Chat {
        mode: if p["style"] == "turns" {
            Style::Turns
        } else {
            Style::Free
        },
        topic,
        host_id,
        members: members.clone(),
        max_rounds: pick(&p["rounds"], &ROUNDS, 3),
        max_messages,
        step: max_messages,
        cap,
        fast: p["brain"] == "fast",
        room: p["meeting"] != false,
        round: 1,
        spoke: HashSet::new(),
        agreed: vec![],
        out: HashSet::new(),
        fails: HashMap::new(),
        next_up: vec![],
        cost: 0.0,
        status: "running",
        speaker: None,
        last_speaker: None,
        wrapping: false,
        ended: String::new(),
        log: vec![],
        people: HashMap::new(),
        summary: None,
        room_open: false,
        room_info: None,
    };
    let names: Vec<String> = members.iter().map(|id| name(app, id)).collect();
    let hello = if c.free() {
        format!(
            "{} are in the chat: up to {} messages, ${:.2} at most.",
            names.join(", "),
            max_messages,
            c.cap
        )
    } else {
        format!(
            "{} take turns: up to {} rounds, ${:.2} at most.",
            names.join(", "),
            c.max_rounds,
            c.cap
        )
    };
    c.say(hello, None);
    // to their desks, awake
    let mut walking = false;
    for id in &members {
        if walkers::has(app, id) {
            walking = true;
            env.fx.push(Fx::Dock(id.clone()));
        } else if is_asleep(app, id) {
            env.action(id, "wake-tucked");
        }
    }
    // (their Claude Code ready before they speak)
    for id in &members {
        if let Some(s) = c.person(app, id).session.clone() {
            env.fx.push(Fx::Warm(s));
        }
    }
    c.meet(env);
    g.chat = Some(c);
    env.changed = true;
    env.later(if walking { 2500 } else { 600 }, |c, env| c.next(env));
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crew() -> Vec<(String, String)> {
        vec![
            ("a".into(), "Captain".into()),
            ("b".into(), "Robo Bob".into()),
            ("c".into(), "Bolt".into()),
        ]
    }

    #[test]
    fn mentions_match_a_name_or_its_start() {
        assert_eq!(
            mentions_in("@cap what do you think? and @robobob", &crew()),
            ["a", "b"]
        );
        assert_eq!(mentions_in("@Bolt!", &crew()), ["c"]);
        assert!(mentions_in("@b is too short, email me@x", &crew()).is_empty());
        assert!(mentions_in("no one", &crew()).is_empty());
    }

    #[test]
    fn the_rules_differ_by_style() {
        let free = rules(
            "Bolt",
            &["Captain (Cheerful, looks after C:\\a)".into()],
            Style::Free,
        );
        assert!(free.starts_with("\nYou are taking part in a group chat"));
        assert!(free.contains("The others: Captain (Cheerful, looks after C:\\a); and the user."));
        assert!(free.contains("- Speak only for yourself, Bolt, in your own personality."));
        assert!(free.contains("<pass/>") && !free.contains("One message per turn"));
        let turns = rules("Bolt", &[], Style::Turns);
        assert!(turns.contains("One message per turn") && !turns.contains("exactly <pass/>"));
    }

    #[test]
    fn bubbles_get_a_short_plain_line() {
        assert_eq!(
            bubble_line("**Yes!**  The `config`\n> lives in _src_"),
            "Yes! The config lives in src"
        );
        let long = "word ".repeat(40);
        let b = bubble_line(&long);
        assert_eq!(b.chars().count(), 89);
        assert!(b.ends_with('…'));
    }

    #[test]
    fn agree_and_pass_tags_are_found_and_taken_out() {
        let raw = "Sounds right.\n<agree/>";
        assert!(agree_re().is_match(raw) && !pass_re().is_match(raw));
        assert_eq!(agree_re().replace_all(raw, "").trim(), "Sounds right.");
        assert!(agree_re().is_match("<AGREE>") && agree_re().is_match("</agree>"));
        assert!(pass_re().is_match("<pass />"));
        assert_eq!(
            pass_re().replacen("<pass/> <pass/>", 1, "").trim(),
            "<pass/>"
        ); // (as JS: only the first)
    }

    #[test]
    fn long_messages_are_cut_for_the_others() {
        assert_eq!(quote("hi"), "hi");
        assert_eq!(quote(&"x".repeat(3005)).chars().count(), 3001);
    }

    #[test]
    fn the_room_goes_left_then_right_then_above() {
        let wa = Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1040,
        };
        // room on the left: beside it, bottoms lined up
        let r = room_bounds(
            Rect {
                x: 730,
                y: 200,
                w: 460,
                h: 640,
            },
            3,
            wa,
            1.0,
        );
        assert_eq!(
            r,
            Rect {
                x: 180,
                y: 500,
                w: 540,
                h: 340
            }
        );
        // none on the left: the right
        let r = room_bounds(
            Rect {
                x: 100,
                y: 200,
                w: 460,
                h: 640,
            },
            5,
            wa,
            1.0,
        );
        assert_eq!(
            r,
            Rect {
                x: 570,
                y: 460,
                w: 640,
                h: 380
            }
        );
        // nor there: above it (kept on the screen)
        let narrow = Rect {
            x: 0,
            y: 0,
            w: 1000,
            h: 1040,
        };
        let r = room_bounds(
            Rect {
                x: 300,
                y: 400,
                w: 460,
                h: 600,
            },
            3,
            narrow,
            1.0,
        );
        assert_eq!(
            r,
            Rect {
                x: 260,
                y: 50,
                w: 540,
                h: 340
            }
        );
        // on a 150% screen it's bigger in physical px
        assert_eq!(
            room_bounds(
                Rect {
                    x: 1500,
                    y: 300,
                    w: 690,
                    h: 960
                },
                3,
                wa,
                1.5
            )
            .w,
            810
        );
    }
}
