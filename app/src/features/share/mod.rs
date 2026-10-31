//! Shared chat: a colleague's C-Bot watches one of your robot's tabs over the office network
//! and suggests prompts; only you send them, on your own Claude Code. The host's side
//! (host.rs) listens while it shares, lets in the people you allow (each with an invite of
//! their own) and passes the tab on as it goes. The guest's side (guest.rs) shows it on a
//! visiting copy of the robot: a robot window like any other, kept in memory only, with no
//! folder and no Claude Code of its own. They talk in wire.rs's messages, over TLS (tls.rs).

mod commands;
mod guest;
mod host;
mod pipe;
mod relay;
mod tls;
mod walk;
mod wire;

pub use commands::*;
pub use guest::join_from_args;
pub use wire::{Person, Suggestion};

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::features::chat::{self, PageEvent};
use crate::platform::network;
use crate::runtime::{part_or_default, with};

/// How long a share lasts, and an invite link.
const SHARE_MS: i64 = 60 * 60 * 1000;
const INVITE_MS: u64 = 10 * 60 * 1000;
/// The most people in at once (and asking to be).
const GUESTS_MAX: usize = 3;

#[derive(Default)]
struct Shares {
    host: Option<host::Host>,
    visits: HashMap<String, guest::Visit>, // visiting robot id -> its connection
    next: u64,                             // (numbers each connection)
}

fn shares<R>(app: &AppHandle, f: impl FnOnce(&mut Shares) -> R) -> R {
    part_or_default(app, f)
}

pub fn setup(app: &AppHandle) {
    app.manage(std::sync::Mutex::new(Shares::default()));
}

/// Someone asking to come in, for the host to allow or not.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Asking {
    pub conn: u64,
    pub person: Person,
}

/// Which end of a shared chat a robot's page is at.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Guest,
}

/// What a robot's page shows of a shared chat (its tab's strip, the share card).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub role: Role,
    pub on: bool,
    pub tab_id: String,
    pub host: Person,
    pub people: Vec<Person>, // (who's in, the host first for guests)
    pub asking: Vec<Asking>,
    pub ends_at: i64,
    pub tool_output: bool,
    pub from_now: bool,
    pub internet: bool, // (through the relay, not the office network)
    pub folder_name: String,
}

/// Is this robot a visitor (a guest's copy of someone's robot)?
pub fn is_visitor(app: &AppHandle, id: &str) -> bool {
    with(app, |st| st.store.is_visitor(id))
}

/// An error for a visiting robot: it has no folder of its own, so nothing that works in one
/// (a shell, a terminal, the context engine) is for it.
pub fn not_visiting(app: &AppHandle, id: &str) -> Result<(), crate::runtime::Error> {
    if is_visitor(app, id) {
        Err("I'm only visiting: that's for my owner's C-Bot.".into())
    } else {
        Ok(())
    }
}

/// The shared chat a robot's page is part of, if it is (its robot_init, and a reload).
pub fn view_for(app: &AppHandle, id: &str) -> Option<ShareView> {
    shares(app, |s| match &s.host {
        Some(h) if h.robot == id => Some(h.view()),
        _ => s.visits.get(id).map(guest::Visit::view),
    })
}

/// A chat event for the host's robot: on to the guests too, if it's the tab being shared
/// (chat::tell sends everything through here).
pub fn forward(app: &AppHandle, id: &str, tab_id: &str, ev: &Value) {
    let Some((txs, shown, from)) = shares(app, |s| {
        let h = s
            .host
            .as_ref()
            .filter(|h| h.robot == id && h.tab == tab_id)?;
        Some((h.senders(), h.shown, h.from))
    }) else {
        return;
    };
    let Some(ev) = wire::for_guests(ev, shown) else {
        return;
    };
    let done = ev["type"] == "done";
    let line = wire::Msg::Event { event: ev }.line();
    for tx in &txs {
        let _ = tx.send(line.clone());
    }
    // (the answer's gone into the history: the guests' copy of the tab catches up)
    if done && let Some(tab) = host::tab_for_guests(app, id, tab_id, from, shown) {
        let line = wire::Msg::Tab { tab }.line();
        for tx in &txs {
            let _ = tx.send(line.clone());
        }
    }
}

/// You asked the shared tab something: the guests see your message (or a guest's, sent).
pub fn said(app: &AppHandle, id: &str, tab_id: &str, text: &str, tag: Option<&str>) {
    let ev =
        json!({ "type": "remote-prompt", "text": text, "tag": tag.unwrap_or(""), "tabId": tab_id });
    let Some(txs) = shares(app, |s| {
        let h = s
            .host
            .as_ref()
            .filter(|h| h.robot == id && h.tab == tab_id)?;
        Some(h.senders())
    }) else {
        return;
    };
    let line = wire::Msg::Event { event: ev }.line();
    for tx in &txs {
        let _ = tx.send(line.clone());
    }
}

/// A robot's window closed: if it was visiting, it leaves; if it was sharing, that stops.
pub fn gone(app: &AppHandle, id: &str) {
    guest::leave(app, id);
    let hosting = shares(app, |s| s.host.as_ref().is_some_and(|h| h.robot == id));
    if hosting {
        host::stop(app, "The robot's window closed.");
    }
}

/// cbot:// links open this C-Bot (in the background: it asks the system, and only writes when
/// the link doesn't already point here). Not for a test copy, which would take them over.
pub fn register_links() {
    if std::env::var_os("CBOT_DATA_DIR").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    std::thread::spawn(move || {
        if let Err(e) = network::register_scheme("cbot", "C-Bot invite link", &exe) {
            log::warn!("cbot:// links won't open C-Bot: {e}");
        }
    });
}

/// Every share and visit ends (C-Bot is closing).
pub fn end_all(app: &AppHandle) {
    host::stop(app, "C-Bot closed.");
    let ids: Vec<String> = shares(app, |s| s.visits.keys().cloned().collect());
    for id in ids {
        guest::leave(app, &id);
    }
}

fn tell(app: &AppHandle, id: &str, tab_id: &str, ev: PageEvent) {
    chat::tell(app, id, tab_id, ev);
}

/// Who's at this PC: a short name, and the PC's own.
fn me() -> Person {
    Person {
        name: wire::short_name(&std::env::var("USERNAME").unwrap_or_default()),
        pc: std::env::var("COMPUTERNAME").unwrap_or_default(),
        ip: String::new(),
    }
}

/// A flag a connection's thread watches, to end it from elsewhere.
#[derive(Clone, Default)]
struct Stop(Arc<AtomicBool>);

impl Stop {
    fn now(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    fn is(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// A connection to someone, whichever way it goes (a socket on the office network, or a pipe
/// through the relay): TLS runs over it.
trait Stream: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> Stream for T {}

/// Lines waiting to go to one connection (its thread writes them).
type Out = Sender<String>;
