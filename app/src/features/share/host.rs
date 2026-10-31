//! The host's side: listening on the office network while a tab is shared, letting in the
//! people you allow (each with an invite link of their own, used once), passing the tab on to
//! them, and bringing you their suggestions. Stops when you say, at the time limit, or when
//! the network changes.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::{Value, json};

use super::wire::{self, Lines, Link, Msg, Read1, Shown};
use super::*;
use crate::platform::network;
use crate::runtime::Error;
use crate::store::{now_ms, title_for};

/// How often a connection looks for what to send and what came in.
const TICK: Duration = Duration::from_millis(50);
/// How long a new connection has to say hello, and you to let it in.
const HELLO_WAIT: Duration = Duration::from_secs(10);
const ANSWER_WAIT: Duration = Duration::from_secs(180);
/// Wrong or used links from one address before it's not listened to any more.
const FAILS_MAX: u32 = 5;
/// Suggestions a guest may send a minute.
const PER_MINUTE: usize = 5;
/// Connections not yet let in, at most.
const OPEN_MAX: usize = 6;

pub(super) struct Host {
    epoch: u64,
    pub(super) robot: String,
    pub(super) tab: String,
    pub(super) from: usize,
    pub(super) shown: Shown,
    ends_at: i64,
    addr: SocketAddr,
    fingerprint: String,
    invites: Vec<(blake3::Hash, Instant)>,
    guests: Vec<Guest>,
    fails: HashMap<IpAddr, u32>,
    suggestions: HashMap<String, (u64, String)>, // the host's id for it -> (connection, the guest's id)
    stop: Stop,
}

struct Guest {
    conn: u64,
    person: Person,
    out: Out,
    admitted: bool,
    answer: Option<mpsc::Sender<bool>>,
    stop: Stop,
    recent: Vec<Instant>, // (when it last suggested)
}

impl Host {
    pub(super) fn view(&self) -> ShareView {
        let mut host = me();
        host.ip = self.addr.ip().to_string();
        ShareView {
            role: Role::Host,
            on: true,
            tab_id: self.tab.clone(),
            host,
            people: self.people(),
            asking: self
                .guests
                .iter()
                .filter(|g| !g.admitted)
                .map(|g| Asking {
                    conn: g.conn,
                    person: g.person.clone(),
                })
                .collect(),
            ends_at: self.ends_at,
            tool_output: self.shown.tool_output,
            from_now: self.from > 0,
            folder_name: String::new(),
        }
    }

    fn people(&self) -> Vec<Person> {
        self.guests
            .iter()
            .filter(|g| g.admitted)
            .map(|g| g.person.clone())
            .collect()
    }

    /// Where each guest that's in gets its lines.
    pub(super) fn senders(&self) -> Vec<Out> {
        self.guests
            .iter()
            .filter(|g| g.admitted)
            .map(|g| g.out.clone())
            .collect()
    }

    fn locked_out(&self, ip: IpAddr) -> bool {
        self.fails.get(&ip).is_some_and(|n| *n >= FAILS_MAX)
    }
}

// ---------------------------------------------------------------- starting and stopping

/// What the host picked in the share card.
pub(super) struct Opts {
    pub from_now: bool,
    pub tool_output: bool,
}

pub(super) fn start(app: &AppHandle, robot: &str, tab: &str, o: &Opts) -> Result<ShareView, Error> {
    if is_visitor(app, robot) {
        return Err("This robot is visiting: only its owner can share it.".into());
    }
    if let Some(v) = shares(app, |s| match &s.host {
        Some(h) if h.robot == robot && h.tab == tab => Some(Ok(h.view())),
        Some(_) => Some(Err(Error::from(
            "Another tab is being shared. Stop that first.",
        ))),
        None => None,
    }) {
        return v;
    }
    let Some(len) = with(app, |st| {
        st.store
            .tab(robot, tab)
            .map(|t| t["history"].as_array().map_or(0, Vec::len))
    }) else {
        return Err("That conversation is gone.".into());
    };
    let ip = local_ip().filter(|ip| wire::is_private(*ip) && !ip.is_loopback()).ok_or_else(|| {
        Error::from("This PC isn't on an office network (it has no private address), so it can't share.")
    })?;
    if network::is_public(ip) == Some(true) {
        return Err("Windows calls this network Public, so I won't share on it. Use your office (or home) network.".into());
    }
    let (config, fingerprint) = tls::server()?;
    let listener = TcpListener::bind((ip, 0))
        .map_err(|e| Error::from(format!("Couldn't listen on the network: {e}")))?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    let stop = Stop::default();
    let epoch = shares(app, |s| {
        s.next += 1;
        s.host = Some(Host {
            epoch: s.next,
            robot: robot.into(),
            tab: tab.into(),
            from: if o.from_now { len } else { 0 },
            shown: Shown {
                tool_output: o.tool_output,
            },
            ends_at: now_ms() + SHARE_MS,
            addr,
            fingerprint,
            invites: Vec::new(),
            guests: Vec::new(),
            fails: HashMap::new(),
            suggestions: HashMap::new(),
            stop: stop.clone(),
        });
        s.next
    });
    let app2 = app.clone();
    thread::spawn(move || listen(&app2, epoch, &listener, &config, &stop));
    let app3 = app.clone();
    thread::spawn(move || watch(&app3, epoch));
    log::info!("sharing a tab on {addr}");
    changed(app);
    view_for(app, robot).ok_or_else(|| "Sharing stopped.".into())
}

/// Sharing stops: everyone's told why, and the port closes.
pub(super) fn stop(app: &AppHandle, reason: &str) {
    let Some(h) = shares(app, |s| s.host.take()) else {
        return;
    };
    let end = Msg::End {
        reason: reason.into(),
    }
    .line();
    for g in &h.guests {
        let _ = g.out.send(end.clone());
        g.stop.now();
    }
    h.stop.now();
    tell(
        app,
        &h.robot,
        &h.tab,
        PageEvent::ShareEnded {
            reason: reason.into(),
        },
    );
}

/// A new invite link: for one person, once, for ten minutes.
pub(super) fn invite(app: &AppHandle, robot: &str) -> Result<String, Error> {
    let token = tls::token()?;
    shares(app, |s| {
        let h = s.host.as_mut().filter(|h| h.robot == robot)?;
        h.invites.retain(|(_, until)| *until > Instant::now());
        h.invites.truncate(9);
        h.invites.push((
            blake3::hash(token.as_bytes()),
            Instant::now() + Duration::from_millis(INVITE_MS),
        ));
        Some(
            Link {
                addr: h.addr,
                token: token.clone(),
                fingerprint: h.fingerprint.clone(),
            }
            .text(),
        )
    })
    .ok_or_else(|| "Sharing has stopped.".into())
}

/// Let someone in, or not.
pub(super) fn admit(app: &AppHandle, conn: u64, yes: bool) {
    let tx = shares(app, |s| {
        let g = s
            .host
            .as_mut()?
            .guests
            .iter_mut()
            .find(|g| g.conn == conn)?;
        g.answer.take()
    });
    if let Some(tx) = tx {
        let _ = tx.send(yes);
    }
}

/// What you did with a suggestion, for the guest who sent it.
pub(super) fn answer(app: &AppHandle, id: &str, state: Suggestion) {
    shares(app, |s| {
        let h = s.host.as_mut()?;
        let (conn, gid) = h.suggestions.remove(id)?;
        let g = h.guests.iter().find(|g| g.conn == conn)?;
        let _ = g.out.send(
            Msg::Suggestion {
                id: gid,
                state,
                why: String::new(),
            }
            .line(),
        );
        Some(())
    });
}

/// The share changed (someone came, went or asked): the host's page and the guests hear.
fn changed(app: &AppHandle) {
    let Some((robot, tab, view, outs, host)) = shares(app, |s| {
        let h = s.host.as_ref()?;
        Some((
            h.robot.clone(),
            h.tab.clone(),
            h.view(),
            h.senders(),
            h.view().host,
        ))
    }) else {
        return;
    };
    let mut people = vec![host];
    people.extend(view.people.iter().cloned());
    let who = Msg::Who { people }.line();
    for tx in &outs {
        let _ = tx.send(who.clone());
    }
    tell(app, &robot, &tab, PageEvent::ShareState { state: view });
}

pub(super) fn tab_for_guests(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    from: usize,
    shown: Shown,
) -> Option<Value> {
    let t = with(app, |st| {
        let mut t = st.store.tab(id, tab_id)?.clone();
        t["custom"] = json!(!t["title"].as_str().unwrap_or("").is_empty());
        t["title"] = json!(title_for(&t));
        t["busy"] = json!(chat::is_busy(st, id, tab_id));
        Some(t)
    })?;
    Some(wire::tab_for_guests(&t, from, shown))
}

/// This PC's address on the network it goes out through (nothing is sent: a UDP socket only
/// picks its way out when it's connected).
fn local_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip())
}

fn current(app: &AppHandle, epoch: u64) -> bool {
    shares(app, |s| s.host.as_ref().is_some_and(|h| h.epoch == epoch))
}

/// The time limit, old invites, and the network changing under it.
fn watch(app: &AppHandle, epoch: u64) {
    let mut n = 0u32;
    while current(app, epoch) {
        thread::sleep(Duration::from_secs(2));
        n += 1;
        let (over, addr) = shares(app, |s| {
            let Some(h) = s.host.as_mut().filter(|h| h.epoch == epoch) else {
                return (false, None);
            };
            h.invites.retain(|(_, until)| *until > Instant::now());
            (now_ms() >= h.ends_at, Some(h.addr.ip()))
        });
        if over {
            stop(app, "Sharing ran out of time (an hour).");
        } else if n.is_multiple_of(5) && addr.is_some() && local_ip() != addr {
            stop(app, "The network changed, so sharing stopped.");
        }
    }
}

// ---------------------------------------------------------------- connections

fn listen(app: &AppHandle, epoch: u64, l: &TcpListener, config: &Arc<ServerConfig>, stop: &Stop) {
    let open = Arc::new(AtomicUsize::new(0));
    while !stop.is() && current(app, epoch) {
        match l.accept() {
            Ok((tcp, peer)) => {
                let ip = peer.ip();
                let shut = !wire::is_private(ip)
                    || open.load(Ordering::Relaxed) >= OPEN_MAX
                    || shares(app, |s| s.host.as_ref().is_none_or(|h| h.locked_out(ip)));
                if shut {
                    continue; // (dropped: closed at once)
                }
                let (app, config, open) = (app.clone(), config.clone(), open.clone());
                open.fetch_add(1, Ordering::Relaxed);
                thread::spawn(move || {
                    serve(&app, epoch, config, tcp, ip);
                    open.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(TICK * 2),
            Err(e) => {
                log::warn!("sharing stopped listening: {e}");
                break;
            }
        }
    }
}

type Tls = StreamOwned<ServerConnection, TcpStream>;

fn serve(app: &AppHandle, epoch: u64, config: Arc<ServerConfig>, tcp: TcpStream, ip: IpAddr) {
    let Ok(sc) = ServerConnection::new(config) else {
        return;
    };
    let _ = tcp.set_nonblocking(false);
    let _ = tcp.set_read_timeout(Some(TICK));
    let _ = tcp.set_nodelay(true);
    let mut tls = StreamOwned::new(sc, tcp);
    let mut lines = Lines::new(wire::GUEST_LINE_MAX);
    let Some(mut person) = hello(app, epoch, &mut tls, &mut lines, ip) else {
        return;
    };
    person.ip = ip.to_string();
    let (out, rx) = mpsc::channel();
    let (yes, answer) = mpsc::channel();
    let stop = Stop::default();
    let conn = shares(app, |s| {
        s.next += 1;
        let conn = s.next;
        let h = s.host.as_mut().filter(|h| h.epoch == epoch)?;
        if h.guests.len() >= GUESTS_MAX {
            return None;
        }
        h.guests.push(Guest {
            conn,
            person: person.clone(),
            out,
            admitted: false,
            answer: Some(yes),
            stop: stop.clone(),
            recent: Vec::new(),
        });
        Some(conn)
    });
    let Some(conn) = conn else {
        refuse(&mut tls, "The chat is full (three people at most).");
        return;
    };
    changed(app);
    if wait_for_answer(app, epoch, &answer, &stop) {
        welcome(app, conn, &mut tls);
        run(app, conn, &mut tls, &mut lines, &rx, &stop);
    } else {
        refuse(&mut tls, &format!("{} didn't let you in.", me().name));
    }
    shares(app, |s| {
        if let Some(h) = s.host.as_mut() {
            h.guests.retain(|g| g.conn != conn);
            h.suggestions.retain(|_, (c, _)| *c != conn);
        }
    });
    changed(app);
}

fn refuse(tls: &mut Tls, reason: &str) {
    let _ = wire::send(
        tls,
        &Msg::Refused {
            reason: reason.into(),
        }
        .line(),
    );
}

/// The first thing a guest says: its version, its invite (used up now) and who it is.
fn hello(
    app: &AppHandle,
    epoch: u64,
    tls: &mut Tls,
    lines: &mut Lines,
    ip: IpAddr,
) -> Option<Person> {
    let until = Instant::now() + HELLO_WAIT;
    let line = loop {
        match lines.next(tls) {
            Read1::Line(l) => break l,
            Read1::Nothing if Instant::now() < until => {}
            _ => return None,
        }
    };
    let Ok(Msg::Hello { proto, token, me }) = serde_json::from_str::<Msg>(&line) else {
        return None; // (not a C-Bot: a browser, say)
    };
    if proto != wire::PROTO {
        refuse(
            tls,
            "Your C-Bot and the host's are different versions. Update both, then try again.",
        );
        return None;
    }
    let hash = blake3::hash(token.as_bytes());
    let ok = shares(app, |s| {
        let h = s.host.as_mut().filter(|h| h.epoch == epoch)?;
        let at = h
            .invites
            .iter()
            .position(|(t, until)| *t == hash && *until > Instant::now());
        match at {
            Some(i) => {
                h.invites.remove(i); // (once only)
                Some(true)
            }
            None => {
                *h.fails.entry(ip).or_insert(0) += 1;
                Some(false)
            }
        }
    })?;
    if !ok {
        refuse(
            tls,
            "This invite link was already used, or it ran out. Ask for a new one.",
        );
        return None;
    }
    let cut = |s: String| {
        s.chars()
            .filter(|c| !c.is_control())
            .take(40)
            .collect::<String>()
    };
    Some(Person {
        name: cut(me.name),
        pc: cut(me.pc),
        ip: String::new(),
    })
}

fn wait_for_answer(app: &AppHandle, epoch: u64, answer: &Receiver<bool>, stop: &Stop) -> bool {
    let until = Instant::now() + ANSWER_WAIT;
    while Instant::now() < until && !stop.is() && current(app, epoch) {
        match answer.recv_timeout(Duration::from_millis(250)) {
            Ok(yes) => return yes,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

/// Let in: the robot and the tab so far, and the answer under way if there is one.
fn welcome(app: &AppHandle, conn: u64, tls: &mut Tls) {
    let Some((robot, tab, from, shown)) = shares(app, |s| {
        let h = s.host.as_mut()?;
        h.guests.iter_mut().find(|g| g.conn == conn)?.admitted = true;
        Some((h.robot.clone(), h.tab.clone(), h.from, h.shown))
    }) else {
        return;
    };
    let Some(t) = tab_for_guests(app, &robot, &tab, from, shown) else {
        return;
    };
    let busy = t["busy"] == true;
    let Some(c) = with(app, |st| st.store.get(&robot).cloned()) else {
        return;
    };
    let mut host = me();
    host.ip = shares(app, |s| s.host.as_ref().map(|h| h.addr.ip().to_string())).unwrap_or_default();
    let robot_json = wire::robot_for_guests(&c, t);
    let _ = wire::send(
        tls,
        &Msg::Welcome {
            host,
            robot: robot_json,
        }
        .line(),
    );
    if busy {
        let ev = json!({ "type": "turn-start", "turnId": "live", "tabId": tab });
        let _ = wire::send(tls, &Msg::Event { event: ev }.line());
    }
    changed(app);
}

/// In the chat: what's for the guest goes out, what it says comes in.
fn run(
    app: &AppHandle,
    conn: u64,
    tls: &mut Tls,
    lines: &mut Lines,
    rx: &Receiver<String>,
    stop: &Stop,
) {
    loop {
        while let Ok(line) = rx.try_recv() {
            if wire::send(tls, &line).is_err() {
                return;
            }
        }
        if stop.is() {
            return;
        }
        match lines.next(tls) {
            Read1::Line(l) => match serde_json::from_str::<Msg>(&l) {
                Ok(Msg::Suggest { id, text }) => suggested(app, conn, &id, &text),
                Ok(Msg::TakeBack { id }) => taken_back(app, conn, &id),
                Ok(Msg::Ping) => {}
                _ => return, // (leaving, or something a guest may not say)
            },
            Read1::Nothing => {}
            Read1::Closed | Read1::TooLong => return,
        }
    }
}

fn suggested(app: &AppHandle, conn: u64, id: &str, text: &str) {
    let id: String = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .collect();
    let host_id = format!("{conn}-{id}");
    let refused = wire::refuse(text);
    let Some((robot, tab, person, out, why)) = shares(app, |s| {
        let h = s.host.as_mut()?;
        let g = h.guests.iter_mut().find(|g| g.conn == conn)?;
        g.recent.retain(|t| t.elapsed() < Duration::from_secs(60));
        let why = refused
            .or((g.recent.len() >= PER_MINUTE)
                .then_some("That's a lot of suggestions: wait a minute."));
        if why.is_none() {
            g.recent.push(Instant::now());
        }
        let (person, out) = (g.person.clone(), g.out.clone());
        if why.is_none() {
            h.suggestions.insert(host_id.clone(), (conn, id.clone()));
        }
        Some((h.robot.clone(), h.tab.clone(), person, out, why))
    }) else {
        return;
    };
    if let Some(why) = why {
        let _ = out.send(
            Msg::Suggestion {
                id,
                state: Suggestion::Refused,
                why: why.into(),
            }
            .line(),
        );
        return;
    }
    let _ = out.send(
        Msg::Suggestion {
            id,
            state: Suggestion::Waiting,
            why: String::new(),
        }
        .line(),
    );
    tell(
        app,
        &robot,
        &tab,
        PageEvent::ShareSuggest {
            id: host_id,
            from: person,
            text: wire::shown(text),
            hidden: wire::hidden_marks(text),
        },
    );
}

fn taken_back(app: &AppHandle, conn: u64, id: &str) {
    let host_id = format!("{conn}-{id}");
    let Some((robot, tab)) = shares(app, |s| {
        let h = s.host.as_mut()?;
        h.suggestions.remove(&host_id)?;
        Some((h.robot.clone(), h.tab.clone()))
    }) else {
        return;
    };
    tell(app, &robot, &tab, PageEvent::ShareTakenBack { id: host_id });
}
