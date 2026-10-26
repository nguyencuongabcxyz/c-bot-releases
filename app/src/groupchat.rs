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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::clip;
use crate::claude::{self, Session};
use crate::store::now_ms;
use crate::util::{only, patch, text};
use crate::win::{self, Rect};
use crate::{find_claude, hub, notes, personalities, planes, robots, social, views, walkers, with};

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
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<pass\s*/?>").unwrap())
}

fn agree_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)</?agree\s*/?>").unwrap())
}

fn mention_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@([\p{L}\p{N}_-]+)").unwrap())
}

/// What the robots are told, on top of their personality.
fn rules(name: &str, others: &[String], mode: &str) -> String {
    let mut lines: Vec<String> = vec![
        String::new(),
        "You are taking part in a group chat with other C-Bot robots and the user, about one topic. Each robot looks after its own project folder.".into(),
        format!("The others: {}; and the user.", others.join("; ")),
        "How to take part:".into(),
        "- Bring what you know from your own folder. If it helps, look things up first (Read, Grep, Glob: quickly, a few files at most) and mention concrete findings (file names, values, how things work).".into(),
        "- This chat is talk only: do not change files or run commands (you cannot here). No <aside> remarks in this chat.".into(),
        format!("- Speak only for yourself, {name}, in your own personality. Never write lines for the others."),
    ];
    let more: &[&str] = if mode == "turns" {
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
    let words: Vec<String> = mention_re().captures_iter(text).map(|m| m[1].to_lowercase()).collect();
    members
        .iter()
        .filter(|(_, name)| {
            let n: String = name.to_lowercase().split_whitespace().collect();
            words.iter().any(|w| *w == n || (w.chars().count() >= 2 && n.starts_with(w.as_str())))
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// A line of what it said, for a speech bubble.
fn bubble_line(text: &str) -> String {
    let line: String = text.chars().filter(|c| !"#*_`>".contains(*c)).collect();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 90 { format!("{}…", line.chars().take(88).collect::<String>()) } else { line }
}

/// A message as the others read it, cut to QUOTE_MAX.
fn quote(text: &str) -> String {
    if text.chars().count() > QUOTE_MAX { format!("{}…", text.chars().take(QUOTE_MAX).collect::<String>()) } else { text.to_string() }
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
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
        self.fx.push(Fx::Robot(id.to_string(), "robot:social", payload));
    }

    fn action(&mut self, id: &str, action: &str) {
        self.fx.push(Fx::Robot(id.to_string(), "robot:action", json!(action)));
    }

    /// Do this to the chat in `ms` (if there's still one).
    fn later(&mut self, ms: u64, f: impl FnOnce(&mut Chat, &mut Env) + Send + 'static) {
        self.fx.push(Fx::After(ms, Box::new(move |app: &AppHandle| act(app, |g, env| {
            if let Some(c) = g.chat.as_mut() {
                f(c, env);
            }
        }))));
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

struct Chat {
    mode: &'static str, // free | turns
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
    let Some(state) = app.try_state::<Mutex<Group>>() else { return f(&mut Group::default(), &mut Env { app, fx: vec![], changed: false }) };
    let mut env = Env { app, fx: vec![], changed: false };
    let r = {
        let mut g = state.lock().unwrap_or_else(|e| e.into_inner());
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
    with(app, |st| st.store.get(id).and_then(|c| c["name"].as_str().map(str::to_string))).unwrap_or_else(|| "A robot".into())
}

fn visible(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some_and(win::is_visible)
}

fn is_asleep(app: &AppHandle, id: &str) -> bool {
    social::peek(app, id).is_some_and(|r| r["awake"] == false)
}

fn personality_of(c: &Value) -> Value {
    let all = personalities::all();
    all.get(c["personality"].as_str().unwrap_or("")).or_else(|| all.values().next()).cloned().unwrap_or(json!({}))
}

fn robot_info(app: &AppHandle, id: &str) -> Option<Value> {
    let c = with(app, |st| st.store.get(id).cloned())?;
    let p = personality_of(&c);
    let folder = c["folder"].as_str().unwrap_or("");
    let base = Path::new(folder).file_name().map(|b| b.to_string_lossy().into_owned()).filter(|b| !b.is_empty()).unwrap_or_else(|| folder.to_string());
    Some(json!({
        "id": id, "name": c["name"], "color": c["color"].as_str().unwrap_or(""), "emoji": p["emoji"].as_str().unwrap_or("🤖"),
        "personality": p["label"].as_str().unwrap_or(""), "folder": base, "onDesk": visible(app, id), "asleep": is_asleep(app, id),
    }))
}

fn view(app: &AppHandle, g: &Group) -> Value {
    let Some(c) = &g.chat else {
        let ids: Vec<String> = with(app, |st| st.store.list().iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect());
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
                let t = c.people.get(&id)?.turn.as_ref().filter(|t| t.msg.is_none())?;
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

impl Chat {
    fn free(&self) -> bool {
        self.mode == "free"
    }

    /// The members still in it: on the desktop, and not dropped out.
    fn active(&self, app: &AppHandle) -> Vec<String> {
        self.members.iter().filter(|id| !self.out.contains(*id) && with(app, |st| st.store.get(id).is_some()) && visible(app, id)).cloned().collect()
    }

    fn said(&self) -> usize {
        self.log.iter().filter(|m| m["who"] == "robot" && !m["text"].as_str().unwrap_or("").is_empty()).count()
    }

    fn typing(&self, app: &AppHandle) -> Vec<String> {
        self.active(app).into_iter().filter(|id| self.people.get(id).is_some_and(|p| p.turn.is_some())).collect()
    }

    fn msg(&mut self, id: u64) -> Option<&mut Value> {
        self.log.iter_mut().rev().find(|m| m["id"] == id)
    }

    fn add(&mut self, fields: Value) -> u64 {
        let id = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let mut m = json!({ "id": id, "at": now_ms(), "text": "" });
        for (k, v) in fields.as_object().into_iter().flatten() {
            m[k] = v.clone();
        }
        self.log.push(m);
        id
    }

    fn say(&mut self, text: String, nudge: Option<&str>) {
        let mut m = json!({ "who": "system", "text": text });
        if let Some(n) = nudge {
            m["nudge"] = json!(n);
        }
        self.add(m);
    }

    fn mentions(&self, app: &AppHandle, text: &str) -> Vec<String> {
        let members: Vec<(String, String)> = self.members.iter().map(|id| (id.clone(), name(app, id))).collect();
        mentions_in(text, &members)
    }

    // ------------------------------------------------------------ each robot's Claude Code

    /// The robot in this chat: what it has read, its turn, and its Claude Code conversation.
    fn person(&mut self, app: &AppHandle, id: &str) -> &mut Person {
        if !self.people.contains_key(id) {
            let session = self.connect(app, id, None);
            self.people.insert(id.to_string(), Person { session, ..Default::default() });
        }
        self.people.entry(id.to_string()).or_default()
    }

    /// Its Claude Code process for the chat: a new one each time the chat starts up again,
    /// on the same conversation (an old one may still be closing, and wouldn't hear the question).
    fn connect(&self, app: &AppHandle, id: &str, session_id: Option<String>) -> Option<Arc<Session>> {
        let (c, all, claude_path) = with(app, |st| {
            let c = st.store.get(id)?.clone();
            let all: HashMap<String, Value> = st.store.list().iter().filter_map(|x| Some((x["id"].as_str()?.to_string(), x.clone()))).collect();
            Some((c, all, st.store.settings()["claudePath"].as_str().unwrap_or("").to_string()))
        })?;
        let others: Vec<String> = self
            .members
            .iter()
            .filter(|o| o.as_str() != id)
            .filter_map(|o| {
                let oc = all.get(o)?;
                let p = personality_of(oc);
                Some(format!("{} ({}, looks after {})", oc["name"].as_str().unwrap_or(""), p["label"].as_str().unwrap_or("robot"), oc["folder"].as_str().unwrap_or("")))
            })
            .collect();
        let opts = claude::Opts {
            // (not found: starting fails, and the turn with it)
            claude_path: find_claude::find(&claude_path).unwrap_or_default(),
            cwd: c["folder"].as_str().unwrap_or("").into(),
            system_prompt: format!("{}\n{}", personalities::system_prompt_for(&c), rules(c["name"].as_str().unwrap_or(""), &others, self.mode)),
            permission_mode: "default".into(),
            model: if self.fast { "haiku".into() } else { c["model"].as_str().unwrap_or("").into() },
            tools: Some(TOOLS.iter().map(|t| t.to_string()).collect()),
            extra_args: vec!["--strict-mcp-config".into()], // (no MCP servers: talk only)
            ..Default::default()
        };
        let (app2, id2) = (app.clone(), id.to_string());
        let handler: claude::Handler = Arc::new(move |session, event, data| on_session(&app2, &id2, session, event, data));
        Some(Session::new(opts, session_id, handler))
    }

    // a message the robot gets to see: the others' and yours (and a nudge to keep going)
    fn seen_by(m: &Value, id: &str) -> bool {
        (m["who"] == "robot" && m["robot"] != id && !m["text"].as_str().unwrap_or("").is_empty()) || m["who"] == "user" || (m["who"] == "system" && !m["nudge"].as_str().unwrap_or("").is_empty())
    }

    fn unseen(&mut self, app: &AppHandle, id: &str) -> bool {
        let seen = self.person(app, id).seen;
        seen == 0 || self.log[seen.min(self.log.len())..].iter().any(|m| Chat::seen_by(m, id))
    }

    /// What was said since the robot last looked, as it reads it.
    fn since(&mut self, app: &AppHandle, id: &str) -> Vec<String> {
        let seen = self.person(app, id).seen.min(self.log.len());
        let lines = self.log[seen..]
            .iter()
            .filter(|m| Chat::seen_by(m, id))
            .map(|m| {
                if m["who"] == "system" {
                    return format!("({})", m["nudge"].as_str().unwrap_or(""));
                }
                let t = quote(m["text"].as_str().unwrap_or(""));
                if m["who"] == "user" { format!("The user: {t}") } else { format!("{}: {t}", m["name"].as_str().unwrap_or("")) }
            })
            .collect();
        let len = self.log.len();
        self.person(app, id).seen = len;
        lines
    }

    /// One turn of a robot's Claude Code: its words, what it looked at, then on_done.
    fn run_turn(&mut self, env: &mut Env, id: &str, prompt: String, msg: Option<u64>, on_done: OnDone) {
        let turn_id = uuid::Uuid::new_v4().to_string();
        let me = self.person(env.app, id);
        me.turn = Some(Turn { turn_id: turn_id.clone(), msg, text: String::new(), looked: vec![], on_done, timed_out: false });
        if me.session.is_none() {
            let session_id = me.session_id.clone();
            let session = self.connect(env.app, id, session_id);
            self.person(env.app, id).session = session;
        }
        if let Some(s) = self.person(env.app, id).session.clone() {
            env.fx.push(Fx::Ask(s, prompt, turn_id.clone()));
        }
        let (id2, t2) = (id.to_string(), turn_id);
        env.later(TURN_TIMEOUT_MS, move |c, env| c.timeout(env, &id2, &t2));
    }

    fn end_turn(&mut self, env: &mut Env, id: &str, r: Value) {
        let Some(t) = self.person(env.app, id).turn.take() else { return };
        self.cost += r["costUsd"].as_f64().unwrap_or(0.0);
        match t.on_done {
            OnDone::Posted { asked } => self.posted(env, id, &r, &t, asked),
            OnDone::Spoken { msg } => self.spoken(env, id, msg, &r, &t),
        }
    }

    fn timeout(&mut self, env: &mut Env, id: &str, turn_id: &str) {
        let me = self.person(env.app, id);
        let Some(t) = me.turn.as_mut().filter(|t| t.turn_id == turn_id) else { return };
        t.timed_out = true;
        if let Some(s) = me.session.clone() {
            env.fx.push(Fx::Interrupt(s)); // (that ends the turn: end_turn comes from its done event)
        }
        // stuck for good: its process goes too (the next turn starts it again)
        let (id2, t2) = (id.to_string(), turn_id.to_string());
        env.later(STUCK_MS, move |c, env| {
            if c.person(env.app, &id2).turn.as_ref().is_none_or(|t| t.turn_id != t2) {
                return;
            }
            c.rest1(env, &id2);
            c.end_turn(env, &id2, json!({ "turnId": t2, "isError": true, "error": "it took too long" }));
        });
    }

    /// It couldn't answer: twice and it leaves the chat.
    fn failed(&mut self, app: &AppHandle, id: &str, error: &str) {
        let fails = self.fails.entry(id.to_string()).or_insert(0);
        *fails += 1;
        if *fails < FAILS_MAX {
            return;
        }
        self.out.insert(id.to_string());
        self.say(format!("{} left the chat ({error}).", name(app, id)), None);
    }

    /// What it said, in its bubble, with the others turning to it (in the meeting room, or at their desks).
    fn heard(&mut self, env: &mut Env, id: &str, text: &str, agree: bool) {
        let short = bubble_line(text);
        if self.room_open {
            env.fx.push(Fx::Emit(ROOM, "meeting:say", json!({ "id": id, "text": short, "agree": agree })));
            return;
        }
        env.tell(id, json!({ "phase": "say", "text": short }));
        for o in self.active(env.app) {
            if o != id {
                env.tell(&o, json!({ "phase": "listen", "side": side_of(env.app, &o, id) }));
            }
        }
    }

    fn next(&mut self, env: &mut Env) {
        if self.free() { self.pump(env) } else { self.advance(env) }
    }

    // ------------------------------------------------------------ free chat

    /// Everyone who's free and has something new to read takes a look; with nobody busy, it's over.
    fn pump(&mut self, env: &mut Env) {
        if self.status != "running" || !self.free() {
            return;
        }
        let app = env.app;
        let active = self.active(app);
        let agreed = self.said() > 0 && active.iter().all(|id| self.people.get(id).is_some_and(|p| p.agree));
        let full = agreed || self.wrapping || self.cost >= self.cap || self.said() as u64 >= self.max_messages;
        if !full {
            for id in &active {
                if self.person(app, id).turn.is_none() && self.unseen(app, id) {
                    self.look(env, id);
                }
            }
        }
        if !self.typing(app).is_empty() {
            env.changed = true;
            return;
        }
        let reason = if self.wrapping {
            "you wrapped it up".to_string()
        } else if agreed {
            "everyone agreed".into()
        } else if self.cost >= self.cap {
            format!("it reached the ${:.2} cost cap", self.cap)
        } else if self.said() as u64 >= self.max_messages {
            format!("it reached {} messages", self.max_messages)
        } else if active.len() < 2 {
            "too few robots are left".into()
        } else if active.iter().all(|id| self.people.get(id).is_some_and(|p| p.agree)) {
            "everyone agreed".into()
        } else {
            "nobody had more to add".into()
        };
        self.summarise(env, &reason);
    }

    fn look(&mut self, env: &mut Env, id: &str) {
        let app = env.app;
        let seen = self.person(app, id).seen.min(self.log.len());
        let first = seen == 0;
        let fresh: Vec<Value> = self.log[seen..].to_vec();
        let asked = fresh.iter().any(|m| m["who"] == "user" && self.mentions(app, m["text"].as_str().unwrap_or("")).iter().any(|x| x == id));
        let mentioned = fresh.iter().any(|m| m["who"] == "robot" && m["robot"] != id && self.mentions(app, m["text"].as_str().unwrap_or("")).iter().any(|x| x == id));
        let user_asked = fresh.iter().any(|m| m["who"] == "user");
        let lines = self.since(app, id);
        let me = name(app, id);
        let mut out: Vec<String> = vec![];
        if first {
            out.extend([format!("[Group chat] Topic: {}", self.topic), String::new()]);
        }
        if !lines.is_empty() {
            out.push(if first { "Said so far:" } else { "New in the chat:" }.into());
            out.extend(lines);
            out.push(String::new());
        } else if first {
            out.extend(["Nobody has said anything yet: the user just opened the chat with this topic.".to_string(), String::new()]);
        }
        out.push(if asked {
            format!("The user asked you directly, {me}: answer them.")
        } else if user_asked {
            format!("Your move, {me}: reply (the user spoke), or <pass/> if the others have it covered.")
        } else if mentioned {
            format!("Your move, {me}: you were mentioned. If you were asked something, answer it; otherwise <pass/> (or <agree/>).")
        } else {
            format!("Your move, {me}: something new to add? A short message, or <pass/> (or <agree/> if you agree and have nothing to add).")
        });
        self.run_turn(env, id, out.join("\n"), None, OnDone::Posted { asked });
    }

    /// Its turn's over: a message to the group, or it stayed quiet (asked: you asked it directly).
    fn posted(&mut self, env: &mut Env, id: &str, r: &Value, t: &Turn, asked: bool) {
        let app = env.app;
        if self.status == "running" && !self.wrapping {
            let said = text(&r["text"]);
            let raw = if said.is_empty() { t.text.clone() } else { said };
            let raw = raw.trim();
            let agree = agree_re().is_match(raw);
            let pass = pass_re().is_match(raw);
            let text = pass_re().replacen(&agree_re().replace_all(raw, ""), 1, "").trim().to_string();
            let failed = t.timed_out || r["isError"].as_bool() == Some(true);
            if failed {
                let error = if t.timed_out { "it took too long".to_string() } else { Some(text_of(&r["error"])).filter(|e| !e.is_empty()).unwrap_or_else(|| "it had nothing to say".into()) };
                self.failed(app, id, &error);
            } else if r["interrupted"].as_bool() != Some(true) {
                let me = self.person(app, id);
                me.agree = agree || (pass && me.agree); // (quiet keeps what it thought; a message says it again)
                if !text.is_empty() && !pass {
                    self.add(json!({ "who": "robot", "robot": id, "name": name(app, id), "text": text, "agree": agree, "asked": asked, "looked": t.looked }));
                    self.heard(env, id, &text, agree);
                    let active = self.active(app);
                    if let Some(to) = self.mentions(app, &text).into_iter().find(|o| o != id && active.contains(o)) {
                        self.throw_plane(env, id, &to);
                    }
                    for o in active.iter().filter(|o| o.as_str() != id) {
                        let p = self.person(app, o);
                        p.agree = p.agree && agree; // (something new to consider)
                    }
                }
            }
        }
        env.changed = true;
        env.later(300, |c, env| c.pump(env));
    }

    // ------------------------------------------------------------ taking turns

    fn next_speaker(&mut self, app: &AppHandle) -> Option<(String, bool)> {
        let active = self.active(app);
        while !self.next_up.is_empty() {
            let id = self.next_up.remove(0);
            if active.contains(&id) {
                return Some((id, true));
            }
        }
        let left: Vec<String> = active.into_iter().filter(|id| !self.spoke.contains(id)).collect();
        if left.is_empty() {
            return None;
        }
        let last = self.log.iter().rev().find(|m| m["who"] == "robot" || m["who"] == "user").cloned();
        let asked: Vec<String> = match &last {
            Some(m) => self.mentions(app, m["text"].as_str().unwrap_or("")).into_iter().filter(|id| left.contains(id) && m["robot"] != id.as_str()).collect(),
            None => vec![],
        };
        Some((asked.first().cloned().unwrap_or_else(|| left[0].clone()), false))
    }

    /// The next turn, or the end.
    fn advance(&mut self, env: &mut Env) {
        if self.status != "running" || self.speaker.is_some() {
            return;
        }
        let app = env.app;
        if self.wrapping {
            return self.summarise(env, "you wrapped it up");
        }
        if self.cost >= self.cap {
            return self.summarise(env, &format!("it reached the ${:.2} cost cap", self.cap));
        }
        if self.active(app).len() < 2 {
            return self.summarise(env, "too few robots are left");
        }
        let mut up = self.next_speaker(app);
        if up.is_none() {
            if self.active(app).iter().all(|id| self.agreed.contains(id)) {
                return self.summarise(env, "everyone agreed");
            }
            if self.round >= self.max_rounds {
                return self.summarise(env, &format!("that was the last round ({})", self.max_rounds));
            }
            self.round += 1;
            self.spoke.clear();
            self.agreed.clear();
            up = self.next_speaker(app);
        }
        if let Some((id, asked)) = up {
            self.speak(env, &id, None, asked);
        }
    }

    fn prompt(&mut self, app: &AppHandle, id: &str, asked: bool) -> String {
        let first = self.person(app, id).seen == 0;
        let lines = self.since(app, id);
        let last = self.round >= self.max_rounds;
        let mut out: Vec<String> = vec![];
        if first {
            out.extend([format!("[Group chat] Topic: {}", self.topic), String::new()]);
        }
        if !lines.is_empty() {
            out.push(if first { "Said so far:" } else { "Since you last spoke:" }.into());
            out.extend(lines);
            out.push(String::new());
        } else if first {
            out.extend(["Nobody has spoken yet: you open the discussion.".to_string(), String::new()]);
        }
        let tail = if asked { ": the user asked you directly, so answer them." } else if last { ": the last round, so help the group land on a conclusion." } else { "." };
        out.push(format!("Your turn, {} (round {} of {}){tail}", name(app, id), self.round, self.max_rounds));
        out.join("\n")
    }

    /// A turn whose words show as they come (taking turns, and the summary).
    fn speak(&mut self, env: &mut Env, id: &str, summary: Option<String>, asked: bool) {
        let app = env.app;
        let who = if summary.is_some() { "summary" } else { "robot" };
        let msg = self.add(json!({ "who": who, "robot": id, "name": name(app, id), "round": self.round, "live": true, "asked": asked }));
        self.spoke.insert(id.to_string());
        self.speaker = Some(id.to_string());
        let is_summary = summary.is_some();
        let prompt = match summary {
            Some(s) => s,
            None => self.prompt(app, id, asked),
        };
        self.run_turn(env, id, prompt, Some(msg), OnDone::Spoken { msg });
        // on the desks: a paper plane over from whoever spoke last, and the others turn to listen
        if !is_summary {
            let from = self.last_speaker.replace(id.to_string());
            if let Some(from) = from.filter(|f| f != id) {
                self.throw_plane(env, &from, id);
            }
            env.tell(id, json!({ "phase": "listen-end" }));
            for o in self.active(app) {
                if o != id {
                    env.tell(&o, json!({ "phase": "listen", "side": side_of(app, &o, id) }));
                }
            }
        }
        env.changed = true;
    }

    /// The speaker's turn is over: what it said (or why not), then on to the next.
    fn spoken(&mut self, env: &mut Env, id: &str, msg_id: u64, r: &Value, t: &Turn) {
        let app = env.app;
        self.speaker = None;
        let Some(msg) = self.msg(msg_id) else { return };
        let said = text(&r["text"]);
        let raw = if said.is_empty() { text(&msg["text"]) } else { said };
        let raw = raw.trim();
        let agree = agree_re().is_match(raw);
        let text = agree_re().replace_all(raw, "").trim().to_string();
        let interrupted = r["interrupted"].as_bool() == Some(true);
        msg["live"] = json!(false);
        msg["text"] = json!(text);
        if t.timed_out {
            msg["note"] = json!("took too long: skipped");
        } else if interrupted {
            msg["note"] = json!("cut short");
        }
        let who = text_of(&msg["who"]);
        if self.status == "stopped" {
            env.changed = true;
            return;
        }
        if r["isError"].as_bool() == Some(true) || t.timed_out || (text.is_empty() && !interrupted) {
            let error = if t.timed_out { "it took too long".to_string() } else { Some(text_of(&r["error"])).filter(|e| !e.is_empty()).unwrap_or_else(|| "it had nothing to say".into()) };
            if let Some(m) = self.msg(msg_id) {
                m["error"] = json!(error);
            }
            if who != "summary" {
                self.failed(app, id, &error);
            }
        } else if who == "robot" {
            if agree && !self.agreed.iter().any(|a| a == id) {
                self.agreed.push(id.to_string());
            }
            if let Some(m) = self.msg(msg_id) {
                m["agree"] = json!(agree);
            }
            self.heard(env, id, &text, agree);
        }
        if who == "summary" {
            return self.summarised(env, msg_id);
        }
        env.changed = true;
        env.later(400, |c, env| c.advance(env));
    }

    // ------------------------------------------------------------ the end

    fn summarise(&mut self, env: &mut Env, reason: &str) {
        if self.status == "summarising" {
            return;
        }
        let app = env.app;
        let active = self.active(app);
        let host = if active.contains(&self.host_id) { self.host_id.clone() } else { active.first().cloned().unwrap_or_else(|| self.host_id.clone()) };
        self.status = "summarising";
        self.wrapping = false;
        self.ended = reason.to_string();
        self.say(format!("The chat is over: {reason}. {} is writing the summary…", name(app, &host)), None);
        let lines = self.since(app, &host);
        let mut out = vec![format!("The group chat is over ({reason}).")];
        if !lines.is_empty() {
            out.push("New in the chat since you last looked:".into());
            out.extend(lines);
        }
        out.extend([
            String::new(),
            "Now write the summary for the user, as the chat's host (this is not a chat message):".into(),
            "**Conclusion**: what the group concluded, or, if it did not agree, the options and who backs which.".into(),
            "**Key points**: the main points, saying who made them.".into(),
            "**Next steps**: concrete actions or open questions, if any.".into(),
            "Markdown, under 220 words, in your voice but plain. No <agree/> or <pass/>.".into(),
        ]);
        self.speak(env, &host, Some(out.join("\n")), false);
    }

    fn summarised(&mut self, env: &mut Env, msg_id: u64) {
        let app = env.app;
        self.status = "done";
        let (text, robot) = self.msg(msg_id).map(|m| (text_of(&m["text"]), text_of(&m["robot"]))).unwrap_or_default();
        self.summary = Some(text.clone());
        self.adjourn(env);
        for id in self.active(app) {
            env.tell(&id, json!({ "phase": "listen-end", "wave": true }));
        }
        if !text.is_empty() {
            env.fx.push(Fx::After(1400, Box::new(move |app: &AppHandle| hub::send_to_robot(app, &robot, "robot:social", json!({ "phase": "say", "text": "Summary’s ready! 📝" })))));
        }
        self.rest(env);
        env.changed = true;
    }

    /// Everyone stops talking: anything being written is cut short (free chat: never posted).
    fn hush(&mut self, env: &mut Env) {
        let busy: Vec<String> = self.people.iter().filter(|(_, p)| p.turn.is_some()).map(|(id, _)| id.clone()).collect();
        for id in busy {
            let Some(me) = self.people.get_mut(&id) else { continue };
            let turn = me.turn.take();
            if let Some(s) = me.session.clone() {
                env.fx.push(Fx::Interrupt(s));
            }
            if let Some(m) = turn.and_then(|t| t.msg).and_then(|m| self.msg(m)) {
                m["live"] = json!(false);
                m["note"] = json!("cut short");
            }
            env.tell(&id, json!({ "phase": "listen-end" }));
        }
        self.speaker = None;
    }

    /// The robots' chat processes go (a later "keep talking" picks the conversations up again).
    fn rest(&mut self, env: &mut Env) {
        let ids: Vec<String> = self.people.keys().cloned().collect();
        for id in ids {
            self.rest1(env, &id);
        }
    }

    fn rest1(&mut self, env: &mut Env, id: &str) {
        let Some(me) = self.people.get_mut(id) else { return };
        let Some(s) = me.session.take() else { return };
        me.session_id = s.session_id().or(me.session_id.take());
        env.fx.push(Fx::Close(s));
    }

    /// Stop now: whoever's talking is cut short, nobody else speaks.
    fn stop(&mut self, env: &mut Env) {
        if self.status != "running" && self.status != "summarising" {
            return;
        }
        self.status = "stopped";
        self.ended = "you stopped it".into();
        self.hush(env);
        self.adjourn(env);
        self.say("You stopped the chat.".into(), None);
        for id in self.active(env.app) {
            env.tell(&id, json!({ "phase": "listen-end" }));
        }
        self.rest(env);
        env.changed = true;
    }

    /// Wrap up: whoever's talking is cut short, then the summary.
    fn wrap(&mut self, env: &mut Env) {
        if self.status == "stopped" {
            return self.summarise(env, "you stopped it");
        }
        if self.status != "running" {
            return;
        }
        self.wrapping = true;
        if self.free() {
            let typing = self.typing(env.app);
            for id in &typing {
                if let Some(s) = self.people.get(id).and_then(|p| p.session.clone()) {
                    env.fx.push(Fx::Interrupt(s)); // (their turns end, unposted; then pump sums up)
                }
            }
            if typing.is_empty() {
                self.pump(env);
            }
        } else if let Some(s) = self.speaker.as_ref().and_then(|sp| self.people.get(sp)).and_then(|p| p.session.clone()) {
            env.fx.push(Fx::Interrupt(s));
        } else if self.speaker.is_none() {
            self.advance(env);
        }
        env.changed = true;
    }

    /// More, after it's over (nudge: the robots are asked to carry on; else something new came in).
    fn more(&mut self, env: &mut Env, nudge: bool) {
        if self.status != "done" && self.status != "stopped" {
            return;
        }
        self.status = "running";
        self.ended.clear();
        if self.cost >= self.cap {
            self.cap = ((self.cost + 0.5) * 2.0).ceil() / 2.0;
        }
        if self.free() {
            self.max_messages = self.max_messages.max(self.said() as u64 + self.step / 2);
            let text = format!("Keep talking: up to {} messages, ${:.2} at most.", self.max_messages, self.cap);
            self.say(text, nudge.then_some("The user asks you all to keep talking: pick up anything unresolved, or <pass/> if it is settled."));
            self.meet(env);
            env.changed = true;
            return self.pump(env);
        }
        self.meet(env);
        let active = self.active(env.app);
        let round_done = active.iter().all(|id| self.spoke.contains(id));
        self.max_rounds = self.round + u64::from(round_done);
        self.agreed.clear();
        self.say(format!("One more round{}, ${:.2} at most.", if round_done { "" } else { " (finishing this one)" }, self.cap), None);
        env.changed = true;
        self.advance(env);
    }

    /// You say something: it goes into the conversation, and the robots answer it.
    fn user_says(&mut self, env: &mut Env, text: &str) {
        let text: String = text.trim().chars().take(4000).collect();
        if text.is_empty() {
            return;
        }
        self.add(json!({ "who": "user", "name": "You", "text": text }));
        self.agreed.clear(); // (something new to consider)
        for me in self.people.values_mut() {
            me.agree = false;
        }
        for id in self.mentions(env.app, &text) {
            if !self.free() && !self.next_up.contains(&id) && self.speaker.as_deref() != Some(id.as_str()) {
                self.next_up.push(id.clone());
            }
            env.tell(&id, json!({ "phase": "say", "text": "👀" }));
        }
        if self.status == "done" || self.status == "stopped" {
            return self.more(env, false);
        }
        env.changed = true;
        if self.free() {
            self.pump(env);
        }
    }

    // ------------------------------------------------------------ on the desks

    /// A paper plane from one robot's desk to another's (not while they're in the meeting room).
    fn throw_plane(&mut self, env: &mut Env, a: &str, b: &str) {
        let app = env.app;
        if self.room_open || walkers::has(app, a) || walkers::has(app, b) {
            return;
        }
        let side = side_of(app, a, b);
        env.tell(a, json!({ "phase": "throw", "side": side }));
        let (a, b) = (a.to_string(), b.to_string());
        env.fx.push(Fx::After(THROW_AT_MS, Box::new(move |app: &AppHandle| {
            if let (Some(from), Some(to)) = (hand(app, &a, side, false), hand(app, &b, side_of(app, &b, &a), true)) {
                planes::fly(app, from, to, None);
            }
        })));
    }

    // ------------------------------------------------------------ the meeting room

    /// What the room shows of the chat: who's typing, talking, agreeing.
    fn meeting_state(&self, app: &AppHandle) -> Value {
        let active = self.active(app);
        let typing = if self.free() { self.typing(app) } else { vec![] };
        let agree: Vec<String> = if self.free() { active.iter().filter(|id| self.people.get(*id).is_some_and(|p| p.agree)).cloned().collect() } else { self.agreed.clone() };
        json!({ "ids": active, "mode": self.mode, "phase": self.status, "speaker": self.speaker, "typing": typing, "agree": agree })
    }

    /// Everyone gets up from their desk and rolls into the meeting room.
    fn meet(&mut self, env: &mut Env) {
        if !self.room || self.room_open {
            return;
        }
        let app = env.app;
        let ids = self.active(app);
        let people: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                let c = with(app, |st| st.store.get(id).cloned())?;
                let kit = if c["kit"].is_object() { c["kit"].to_string() } else { "{}".into() };
                Some(json!({
                    "id": id, "name": c["name"], "color": c["color"].as_str().filter(|s| !s.is_empty()).unwrap_or("#5ac8fa"), "kit": kit,
                    "acc": c["accessory"].as_str().filter(|s| !s.is_empty()).unwrap_or("none"), "theme": c["theme"].as_str().filter(|s| !s.is_empty()).unwrap_or("classic"),
                }))
            })
            .collect();
        self.room_open = true;
        self.room_info = Some(json!({ "people": people, "topic": self.topic, "state": self.meeting_state(app) }));
        let room_gen = ROOM_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        env.fx.push(Fx::RoomOpen { people: json!(people), room_gen });
        // (one after another, as they roll in there)
        for (i, id) in ids.into_iter().enumerate() {
            env.later(300 + i as u64 * 550, move |c, env| {
                if c.room_open {
                    env.action(&id, "meeting");
                }
            });
        }
    }

    /// The meeting's over: the room goes, and everyone's straight back at their desk.
    fn adjourn(&mut self, env: &mut Env) {
        if !self.room {
            return;
        }
        self.room_open = false;
        self.room_info = None;
        ROOM_GEN.fetch_add(1, Ordering::Relaxed);
        env.fx.push(Fx::RoomClose);
        for id in &self.members {
            env.action(id, "meeting-end");
        }
    }
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
    Some((r.x as f64 + r.w as f64 * if side == "L" { 0.36 } else { 0.64 }, r.y as f64 + r.h as f64 * if up { 0.3 } else { 0.42 }))
}

/// The session's events, for the robot whose chat process it is (an old one's are ignored).
fn on_session(app: &AppHandle, id: &str, session: &Arc<Session>, event: &str, data: Value) {
    act(app, |g, env| {
        let Some(c) = g.chat.as_mut() else { return };
        let Some(me) = c.people.get_mut(id) else { return };
        if !me.session.as_ref().is_some_and(|s| Arc::ptr_eq(s, session)) {
            return;
        }
        match event {
            "text" => {
                let delta = data.as_str().unwrap_or("").to_string();
                let Some(t) = me.turn.as_mut() else { return };
                t.text.push_str(&delta);
                let Some(msg_id) = t.msg else { return };
                if let Some(m) = c.msg(msg_id) {
                    m["text"] = json!(format!("{}{delta}", m["text"].as_str().unwrap_or("")));
                    env.fx.push(Fx::Emit(LABEL, "groupchat:delta", json!({ "id": msg_id, "delta": delta })));
                }
            }
            "tool" => {
                let Some(t) = me.turn.as_mut() else { return };
                let detail = data["detail"].as_str().filter(|d| !d.is_empty()).or(data["name"].as_str()).unwrap_or("").to_string();
                t.looked.push(detail);
                let (looked, msg) = (t.looked.clone(), t.msg);
                if let Some(m) = msg.and_then(|m| c.msg(m)) {
                    m["looked"] = json!(looked);
                }
                env.changed = true;
            }
            "aside" => {
                if me.turn.is_some() {
                    env.tell(id, json!({ "phase": "say", "text": format!("💭 {}", data.as_str().unwrap_or("")) }));
                }
            }
            "done" | "fail" => {
                if me.turn.as_ref().is_none_or(|t| data["turnId"] != t.turn_id.as_str()) {
                    return;
                }
                let r = if event == "done" {
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

// ---------------------------------------------------------------- the windows

/// In the middle of the screen the host robot is on (physical px).
fn place(app: &AppHandle, host: Option<&str>) -> Rect {
    let saved = with(app, |st| st.store.settings()["groupChatSize"].clone());
    let near = host.and_then(|h| hub::robot_rect(app, h)).map(|r| (r.x + r.w / 2, r.y + r.h / 2)).unwrap_or_else(win::cursor);
    let m = win::monitor_near(near.0, near.1);
    let s = m.scale;
    let w = MIN_SIZE.0.max(saved["w"].as_f64().unwrap_or(SIZE.0));
    let h = MIN_SIZE.1.max(saved["h"].as_f64().unwrap_or(SIZE.1)).min(m.work.h as f64 / s - 16.0);
    let (pw, ph) = ((w * s).round() as i32, (h * s).round() as i32);
    Rect { x: m.work.x + (m.work.w - pw) / 2, y: m.work.y + (m.work.h - ph) / 2, w: pw, h: ph }
}

fn build_window(app: &AppHandle) {
    // (two at once: one window)
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    act(app, |g, _| g.shown = false);
    let app2 = app.clone();
    let built = views::builder(app, LABEL, "groupchat", &[])
        .title("Robot group chat")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(true)
        .maximizable(false)
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .visible(false)
        .on_page_load(move |w, p| {
            if !matches!(p.event(), PageLoadEvent::Finished) || act(&app2, |g, _| g.shown) {
                return;
            }
            // (ready to show: placed, then shown)
            let host = act(&app2, |g, _| g.chat.as_ref().map(|c| c.host_id.clone()).or(g.host.clone()));
            if let Ok(hwnd) = w.hwnd() {
                win::set_bounds(hwnd.0 as isize, place(&app2, host.as_deref()));
            }
            let _ = w.show();
            let _ = w.set_focus();
            act(&app2, |g, _| g.shown = true);
        })
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[groupchat] couldn't open: {err}");
            return;
        }
    };
    let (app3, w2) = (app.clone(), window.clone());
    window.on_window_event(move |e| match e {
        // (its size is kept for next time, as you leave it)
        tauri::WindowEvent::Resized(size) => {
            if size.width == 0 || !act(&app3, |g, _| g.shown) || w2.is_minimized().unwrap_or(false) {
                return;
            }
            let s = w2.scale_factor().unwrap_or(1.0);
            let kept = json!({ "w": (size.width as f64 / s).round(), "h": (size.height as f64 / s).round() });
            with(&app3, |st| st.store.update_settings(patch(vec![("groupChatSize", kept)])));
        }
        // closing it ends the chat (the robots' chat processes too)
        tauri::WindowEvent::Destroyed => {
            let app = app3.clone();
            thread::spawn(move || {
                act(&app, |g, env| {
                    g.shown = false;
                    end(g, env);
                });
            });
        }
        _ => {}
    });
}

/// The chat's over and gone (a new one, or the window closed).
fn end(g: &mut Group, env: &mut Env) {
    let Some(c) = g.chat.as_mut() else { return };
    c.hush(env);
    c.adjourn(env);
    for id in c.members.clone() {
        env.tell(&id, json!({ "phase": "listen-end" }));
    }
    c.rest(env);
    g.chat = None;
}

/// The meeting room: beside the group chat window (left if there's room, else right, else above).
fn room_bounds(near: Rect, n: usize, wa: Rect, s: f64) -> Rect {
    let (w, h) =if n > 4 { (640.0, 380.0) } else { (540.0, 340.0) };
    let (w, h, gap) = ((w * s).round() as i32, (h * s).round() as i32, (ROOM_GAP * s).round() as i32);
    let mut x = near.x - w - gap;
    let mut y = near.y + near.h - h;
    if x < wa.x {
        x = near.right() + gap; // (no room on the left: the right)
    }
    if x + w > wa.right() {
        x = near.x + (near.w - w) / 2; // (nor there: above it)
        y = near.y - h - gap;
    }
    Rect { x: x.max(wa.x).min(wa.right() - w), y: y.max(wa.y).min(wa.bottom() - h), w, h }
}

fn open_room(app: &AppHandle, people: Value, room_gen: u64) {
    // (a room from before goes first)
    if let Some(old) = app.get_webview_window(ROOM) {
        let _ = old.destroy();
        for _ in 0..50 {
            if app.get_webview_window(ROOM).is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    let n = people.as_array().map_or(0, Vec::len);
    let near = app
        .get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| win::window_rect(h.0 as isize))
        .unwrap_or_else(|| {
            let (x, y) = win::cursor();
            Rect { x, y, w: 0, h: 0 }
        });
    let m = win::monitor_near(near.x + near.w / 2, near.y + near.h / 2);
    let b = room_bounds(near, n, m.work, m.scale);
    let s = m.scale;
    let built = views::builder(app, ROOM, "meeting", &[])
        .title("Meeting room")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(b.w as f64 / s, b.h as f64 / s)
        .build();
    match built {
        Ok(w) => {
            if let Ok(h) = w.hwnd() {
                win::set_bounds(h.0 as isize, b);
            }
            // (it ended while the room was being made)
            if ROOM_GEN.load(Ordering::Relaxed) != room_gen {
                let _ = w.destroy();
            }
        }
        Err(err) => eprintln!("[groupchat] couldn't open the meeting room: {err}"),
    }
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
    act(app, |g, _| g.chat.as_ref().is_some_and(|c| c.members.iter().any(|m| m == id) && (c.status == "running" || c.status == "summarising")))
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
    let host_id = g.host.clone().filter(|h| members.contains(h)).unwrap_or_else(|| members[0].clone());
    members.retain(|m| *m != host_id);
    members.insert(0, host_id.clone());
    let pick = |v: &Value, list: &[u64], def: u64| number(v).filter(|n| list.iter().any(|x| *x as f64 == *n)).map_or(def, |n| n as u64);
    let max_messages = pick(&p["messages"], &MESSAGES, 20);
    let cap = number(&p["cap"]).filter(|n| CAPS.contains(n)).unwrap_or(1.0);
    let mut c = Chat {
        mode: if p["style"] == "turns" { "turns" } else { "free" },
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
        format!("{} are in the chat: up to {} messages, ${:.2} at most.", names.join(", "), max_messages, c.cap)
    } else {
        format!("{} take turns: up to {} rounds, ${:.2} at most.", names.join(", "), c.max_rounds, c.cap)
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

// ---------------------------------------------------------------- commands (only its own pages')

#[tauri::command(async)]
pub fn groupchat_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, LABEL)?;
    Ok(act(&app, |g, _| view(&app, g)))
}

/// A button or the box in the chat window: start, chime in, wrap up, stop, copy…
#[tauri::command(async)]
pub fn groupchat_act(app: AppHandle, window: tauri::WebviewWindow, action: String, p: Option<Value>) -> Result<Value, String> {
    only(&window, LABEL)?;
    Ok(act_on(&app, &action, &p.unwrap_or_default()))
}

/// Who's in the meeting room and where they sit.
#[tauri::command(async)]
pub fn meeting_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, ROOM)?;
    Ok(act(&app, |g, _| g.chat.as_ref().filter(|c| c.room_open).and_then(|c| c.room_info.clone()).unwrap_or(Value::Null)))
}

fn act_on(app: &AppHandle, action: &str, p: &Value) -> Value {
    match action {
        "start" => act(app, |g, env| start(g, env, p)),
        "say" => act(app, |g, env| {
            if let Some(c) = g.chat.as_mut() {
                c.user_says(env, &text(&p["text"]));
            }
            Value::Null
        }),
        "wrap" | "stop" | "more" => act(app, |g, env| {
            if let Some(c) = g.chat.as_mut() {
                match action {
                    "wrap" => c.wrap(env),
                    "stop" => c.stop(env),
                    _ => c.more(env, true),
                }
            }
            Value::Null
        }),
        "new" => act(app, |g, env| {
            end(g, env);
            env.changed = true;
            json!(true)
        }),
        "copy" => {
            let t = act(app, |g, _| g.chat.as_ref().and_then(|c| Some(format!("{}\n\n{}", c.topic, c.summary.as_ref().filter(|s| !s.is_empty())?))));
            json!(t.is_some_and(|t| clip::set_text(&t)))
        }
        "copy-all" => {
            let t = act(app, |g, _| {
                let c = g.chat.as_ref()?;
                let mut lines = vec![format!("Group chat: {}", c.topic), String::new()];
                for m in c.log.iter().filter(|m| !m["text"].as_str().unwrap_or("").is_empty() && m["who"] != "system") {
                    let who = if m["who"] == "summary" { format!("Summary ({})", text(&m["name"])) } else { text(&m["name"]) };
                    lines.push(format!("{who}: {}", text(&m["text"])));
                }
                Some(lines.join("\n\n"))
            });
            json!(t.is_some_and(|t| clip::set_text(&t)))
        }
        "save-note" => {
            let t = act(app, |g, _| g.chat.as_ref().and_then(|c| Some(format!("👥 {}\n\n{}", c.topic, c.summary.as_ref().filter(|s| !s.is_empty())?))));
            let Some(t) = t else { return json!(false) };
            let note = notes::add(app, &t, "Robot group chat");
            json!(!note.is_null() && note != false)
        }
        "minimize" => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.minimize();
            }
            Value::Null
        }
        "close" => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.close();
            }
            Value::Null
        }
        _ => Value::Null,
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Group::default()));
    // (CBOT_TEST_GROUPCHAT: it opens by itself a moment after the start, so a test can drive
    // it without the tray menu, as groupChat.js's CBOT_TEST hook let the tests do)
    if std::env::var_os("CBOT_TEST_GROUPCHAT").is_some() {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            let host = hub::nearest_robot(&app);
            open(&app, host);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crew() -> Vec<(String, String)> {
        vec![("a".into(), "Captain".into()), ("b".into(), "Robo Bob".into()), ("c".into(), "Bolt".into())]
    }

    #[test]
    fn mentions_match_a_name_or_its_start() {
        assert_eq!(mentions_in("@cap what do you think? and @robobob", &crew()), ["a", "b"]);
        assert_eq!(mentions_in("@Bolt!", &crew()), ["c"]);
        assert!(mentions_in("@b is too short, email me@x", &crew()).is_empty());
        assert!(mentions_in("no one", &crew()).is_empty());
    }

    #[test]
    fn the_rules_differ_by_style() {
        let free = rules("Bolt", &["Captain (Cheerful, looks after C:\\a)".into()], "free");
        assert!(free.starts_with("\nYou are taking part in a group chat"));
        assert!(free.contains("The others: Captain (Cheerful, looks after C:\\a); and the user."));
        assert!(free.contains("- Speak only for yourself, Bolt, in your own personality."));
        assert!(free.contains("<pass/>") && !free.contains("One message per turn"));
        let turns = rules("Bolt", &[], "turns");
        assert!(turns.contains("One message per turn") && !turns.contains("exactly <pass/>"));
    }

    #[test]
    fn bubbles_get_a_short_plain_line() {
        assert_eq!(bubble_line("**Yes!**  The `config`\n> lives in _src_"), "Yes! The config lives in src");
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
        assert_eq!(pass_re().replacen("<pass/> <pass/>", 1, "").trim(), "<pass/>"); // (as JS: only the first)
    }

    #[test]
    fn long_messages_are_cut_for_the_others() {
        assert_eq!(quote("hi"), "hi");
        assert_eq!(quote(&"x".repeat(3005)).chars().count(), 3001);
    }

    #[test]
    fn the_room_goes_left_then_right_then_above() {
        let wa = Rect { x: 0, y: 0, w: 1920, h: 1040 };
        // room on the left: beside it, bottoms lined up
        let r = room_bounds(Rect { x: 730, y: 200, w: 460, h: 640 }, 3, wa, 1.0);
        assert_eq!(r, Rect { x: 180, y: 500, w: 540, h: 340 });
        // none on the left: the right
        let r = room_bounds(Rect { x: 100, y: 200, w: 460, h: 640 }, 5, wa, 1.0);
        assert_eq!(r, Rect { x: 570, y: 460, w: 640, h: 380 });
        // nor there: above it (kept on the screen)
        let narrow = Rect { x: 0, y: 0, w: 1000, h: 1040 };
        let r = room_bounds(Rect { x: 300, y: 400, w: 460, h: 600 }, 3, narrow, 1.0);
        assert_eq!(r, Rect { x: 260, y: 50, w: 540, h: 340 });
        // on a 150% screen it's bigger in physical px
        assert_eq!(room_bounds(Rect { x: 1500, y: 300, w: 690, h: 960 }, 3, wa, 1.5).w, 810);
    }
}
