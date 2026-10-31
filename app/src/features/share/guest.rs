//! The guest's side: following an invite link to a colleague's C-Bot, and showing their tab
//! on a visiting copy of their robot (in memory only: it has no folder and no Claude Code, so
//! nothing it shows can run here). Suggestions go back; the host decides.

use std::io;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use rustls::{ClientConnection, StreamOwned};
use serde_json::Value;
use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use super::relay;
use super::wire::{self, At, Lines, Link, Msg, Read1};
use super::*;
use crate::robots::{self, label_of};
use crate::runtime::Error;

const TICK: Duration = Duration::from_millis(50);
const CONNECT_WAIT: Duration = Duration::from_secs(5);
const HANDSHAKE_WAIT: Duration = Duration::from_secs(15);
/// How long to wait for the host to let you in (a little longer than they have).
const LET_IN_WAIT: Duration = Duration::from_secs(200);
/// How long the visitor stays after the chat ends (so you can read why) before it walks off.
const GOODBYE: Duration = Duration::from_secs(2);

pub(super) struct Visit {
    tab: String,
    host: Person,
    people: Vec<Person>,
    folder_name: String,
    internet: bool,
    out: Out,
    stop: Stop,
}

impl Visit {
    pub(super) fn view(&self) -> ShareView {
        ShareView {
            role: Role::Guest,
            on: true,
            tab_id: self.tab.clone(),
            host: self.host.clone(),
            people: self.people.clone(),
            asking: Vec::new(),
            ends_at: 0,
            tool_output: false,
            from_now: false,
            internet: self.internet,
            folder_name: self.folder_name.clone(),
        }
    }
}

/// A cbot:// invite among a launch's arguments (a link clicked while C-Bot runs, or one
/// that started it): off to join it. Whether there was one.
pub fn join_from_args(app: &AppHandle, args: &[String]) -> bool {
    let Some(link) = args.iter().find_map(|a| Link::parse(a)) else {
        return false;
    };
    let app = app.clone();
    thread::spawn(move || visit(&app, &link));
    true
}

/// Join from a link's text (the tray's "Join a shared chat", with the link you copied).
pub(super) fn join(app: &AppHandle, text: &str) -> Result<(), Error> {
    let link = Link::parse(text).ok_or_else(|| {
        Error::from(
            "That isn't a C-Bot invite link (or it's for a PC outside your office network).",
        )
    })?;
    let app = app.clone();
    thread::spawn(move || visit(&app, &link));
    Ok(())
}

fn say(app: &AppHandle, text: &str) {
    app.dialog()
        .message(text)
        .title("Shared chat")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn note(app: &AppHandle, text: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Shared chat")
        .body(text)
        .show();
}

type Tls = StreamOwned<ClientConnection, Box<dyn Stream>>;

fn visit(app: &AppHandle, link: &Link) {
    let place = match &link.at {
        At::Lan(addr) => addr.ip().to_string(),
        At::Relay { .. } => "over the internet".to_string(),
    };
    let go = app
        .dialog()
        .message(format!(
            "Join the shared chat {}?\n\nYou'll watch a colleague's robot and suggest prompts; they decide what's sent. Only join links from people you know.",
            if matches!(link.at, At::Lan(_)) { format!("at {place}") } else { place.clone() }
        ))
        .title("Shared chat")
        .buttons(MessageDialogButtons::OkCancelCustom("Join".into(), "Not now".into()))
        .blocking_show();
    if !go {
        return;
    }
    let mut tls = match connect(link) {
        Ok(t) => t,
        Err(e) if matches!(link.at, At::Relay { .. }) => return say(app, &e.to_string()),
        Err(e) => {
            return say(
                app,
                &format!(
                    "Couldn't reach {place}: {e}\n\nAre you both on the same network? If you are, Windows Firewall on the host's PC may be blocking C-Bot: there, allow C-Bot on private networks (Windows Security → Firewall → Allow an app through firewall)."
                ),
            );
        }
    };
    note(app, "Asking to be let in…");
    let mut lines = Lines::new(wire::HOST_LINE_MAX);
    let (host, robot) = match let_in(&mut tls, &mut lines) {
        Ok(w) => w,
        Err(why) => return say(app, &why),
    };
    let internet = matches!(link.at, At::Relay { .. });
    let Some((id, rx, stop)) = arrive(app, host.clone(), &robot, internet) else {
        return;
    };
    let reason = follow(app, &id, &mut tls, &mut lines, &rx, &stop)
        .unwrap_or_else(|| format!("The connection to {} was lost.", host.name));
    let _ = wire::send(&mut tls, &Msg::Leave.line());
    goodbye(app, &id, &reason);
}

/// To the host: straight there on the office network, or into its room on the relay. Either
/// way TLS to the host itself, checked against the link's fingerprint.
fn connect(link: &Link) -> Result<Tls, Error> {
    let stream: Box<dyn Stream> = match &link.at {
        At::Lan(addr) => {
            let tcp = TcpStream::connect_timeout(addr, CONNECT_WAIT)?;
            tcp.set_read_timeout(Some(TICK))?;
            let _ = tcp.set_nodelay(true);
            Box::new(tcp)
        }
        At::Relay { relay, room } => Box::new(relay::join_room(relay, room)?),
    };
    let cc = ClientConnection::new(tls::client(&link.fingerprint)?, tls::name())
        .map_err(|e| Error::from(format!("Couldn't set up encryption: {e}")))?;
    let mut tls = StreamOwned::new(cc, stream);
    handshake(&mut tls).map_err(|e| match e.kind() {
        io::ErrorKind::InvalidData => Error::from("it isn't the C-Bot the link was for"),
        _ => Error::from(format!("the encrypted connection didn't start ({e})")),
    })?;
    let hello = Msg::Hello {
        proto: wire::PROTO,
        token: link.token.clone(),
        me: me(),
    };
    wire::send(&mut tls, &hello.line()).map_err(|e| match e.kind() {
        io::ErrorKind::InvalidData => Error::from("it isn't the C-Bot the link was for"),
        _ => Error::from(e),
    })?;
    Ok(tls)
}

/// The TLS handshake, to its end: each read waits only a moment ("nothing yet" until the host
/// answers, which through the relay takes a few of them), so it's tried again for a while.
fn handshake(tls: &mut Tls) -> io::Result<()> {
    let until = Instant::now() + HANDSHAKE_WAIT;
    while tls.conn.is_handshaking() {
        match tls.conn.complete_io(&mut tls.sock) {
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) && Instant::now() < until => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Waiting at the door: in (who the host is, their robot), or why not.
fn let_in(tls: &mut Tls, lines: &mut Lines) -> Result<(Person, Value), String> {
    let until = Instant::now() + LET_IN_WAIT;
    loop {
        match lines.next(tls) {
            Read1::Line(l) => match serde_json::from_str::<Msg>(&l) {
                Ok(Msg::Welcome { host, robot }) => return Ok((host, robot)),
                Ok(Msg::Refused { reason }) => return Err(reason),
                _ => return Err("The other C-Bot said something I don't understand.".into()),
            },
            Read1::Nothing if Instant::now() < until => {}
            Read1::Nothing => return Err("Nobody let you in in time.".into()),
            Read1::Closed | Read1::TooLong => {
                return Err(
                    "The host's C-Bot hung up (or it isn't the C-Bot the link was for).".into(),
                );
            }
        }
    }
}

/// In: the visiting robot comes onto your desktop.
fn arrive(
    app: &AppHandle,
    host: Person,
    robot: &Value,
    internet: bool,
) -> Option<(String, Receiver<String>, Stop)> {
    let id = format!("visit-{}", uuid::Uuid::new_v4());
    let visitor = wire::visitor(&id, robot);
    let tab = visitor["activeTab"].as_str().unwrap_or("").to_string();
    let tab_id = tab.clone();
    let name = visitor["name"].as_str().unwrap_or("A robot").to_string();
    let folder_name = visitor["folderName"].as_str().unwrap_or("").to_string();
    let (out, rx) = mpsc::channel();
    let stop = Stop::default();
    with(app, |st| st.store.add_visitor(visitor));
    shares(app, |s| {
        s.visits.insert(
            id.clone(),
            Visit {
                tab,
                people: vec![host.clone()],
                host: host.clone(),
                folder_name,
                internet,
                out,
                stop: stop.clone(),
            },
        )
    });
    let index = robots::open_ids(app).len();
    if let Err(e) = robots::open(app, &id, index) {
        log::warn!("the visiting robot's window didn't open: {e}");
        forget(app, &id);
        return None;
    }
    walk::walk_in(app, &id, &tab_id, &host.name);
    note(
        app,
        &format!("{name} is visiting from {}. Click it to watch.", host.name),
    );
    Some((id, rx, stop))
}

/// Following the host's tab until the chat ends: the reason it ended, if it was said.
fn follow(
    app: &AppHandle,
    id: &str,
    tls: &mut Tls,
    lines: &mut Lines,
    rx: &Receiver<String>,
    stop: &Stop,
) -> Option<String> {
    loop {
        while let Ok(line) = rx.try_recv() {
            wire::send(tls, &line).ok()?;
        }
        if stop.is() {
            return Some("You left the chat.".into());
        }
        match lines.next(tls) {
            Read1::Line(l) => match serde_json::from_str::<Msg>(&l) {
                Ok(Msg::End { reason }) => return Some(reason),
                Ok(m) => heard(app, id, m),
                Err(_) => {}
            },
            Read1::Nothing => {}
            Read1::Closed | Read1::TooLong => return None,
        }
    }
}

fn heard(app: &AppHandle, id: &str, m: Msg) {
    let Some(tab) = shares(app, |s| s.visits.get(id).map(|v| v.tab.clone())) else {
        return;
    };
    match m {
        // (checked again here: whatever the other end sends, the visitor shows only the chat)
        Msg::Event { event } => {
            if let Some(mut ev) = wire::for_guests(&event, wire::Shown { tool_output: true }) {
                ev["tabId"] = Value::String(tab);
                let _ = app.emit_to(label_of(id), "robot:event", ev);
            }
        }
        Msg::Tab { tab: t } => {
            let t = wire::tab_for_guests(&t, 0, wire::Shown { tool_output: true });
            with(app, |st| st.store.set_visitor_tab(id, &tab, t));
        }
        Msg::Suggestion {
            id: sid,
            state,
            why,
        } => {
            tell(
                app,
                id,
                &tab,
                PageEvent::ShareSuggestion {
                    id: sid,
                    state,
                    why,
                },
            );
        }
        Msg::Who { people } => {
            let view = shares(app, |s| {
                let v = s.visits.get_mut(id)?;
                v.people = people.into_iter().take(GUESTS_MAX + 1).collect();
                Some(v.view())
            });
            if let Some(state) = view {
                tell(app, id, &tab, PageEvent::ShareState { state });
            }
        }
        _ => {}
    }
}

/// The chat's over: the visitor says why, then goes home.
fn goodbye(app: &AppHandle, id: &str, reason: &str) {
    let visit = shares(app, |s| {
        s.visits
            .get(id)
            .map(|v| (v.tab.clone(), v.host.name.clone()))
    });
    if let Some((tab, _)) = &visit {
        tell(
            app,
            id,
            tab,
            PageEvent::ShareEnded {
                reason: reason.into(),
            },
        );
    }
    shares(app, |s| s.visits.remove(id));
    thread::sleep(GOODBYE);
    let host = visit.map(|(_, h)| h).unwrap_or_default();
    walk::walk_off(app, id, &host, forget);
}

fn forget(app: &AppHandle, id: &str) {
    shares(app, |s| s.visits.remove(id));
    if let Some(w) = app.get_webview_window(&label_of(id)) {
        let _ = w.close();
    }
    with(app, |st| st.store.remove_visitor(id));
}

/// A suggestion from the visiting robot's chat, to the host. Its id, for what becomes of it.
pub(super) fn suggest(app: &AppHandle, id: &str, text: &str) -> Result<String, Error> {
    if let Some(why) = wire::refuse(text) {
        return Err(why.into());
    }
    let sid = uuid::Uuid::new_v4().simple().to_string();
    let out = shares(app, |s| s.visits.get(id).map(|v| v.out.clone()))
        .ok_or_else(|| Error::from("The shared chat has ended."))?;
    out.send(
        Msg::Suggest {
            id: sid.clone(),
            text: text.into(),
        }
        .line(),
    )
    .map_err(|_| Error::from("The shared chat has ended."))?;
    Ok(sid)
}

pub(super) fn take_back(app: &AppHandle, id: &str, sid: &str) {
    if let Some(out) = shares(app, |s| s.visits.get(id).map(|v| v.out.clone())) {
        let _ = out.send(Msg::TakeBack { id: sid.into() }.line());
    }
}

/// Leave the chat (the visitor's window closed, or you said so).
pub(super) fn leave(app: &AppHandle, id: &str) {
    if let Some(stop) = shares(app, |s| s.visits.get(id).map(|v| v.stop.clone())) {
        stop.now();
    }
}
