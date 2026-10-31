//! The host's side: while a tab is shared, letting in the people you allow (each with an
//! invite link of their own, used once), passing the tab on to them, and bringing you their
//! suggestions. They come over the office network (lan.rs) or through the relay (relay.rs);
//! either way each is one connection (serve.rs). Stops when you say, at the time limit, or
//! when the network (or the relay) goes.

mod lan;
mod serve;

use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use rustls::ServerConfig;
use serde_json::{Value, json};

use super::relay::{self, Room};
use super::wire::{self, At, Link, Msg, Shown};
use super::*;
use crate::runtime::Error;
use crate::store::{now_ms, title_for};

/// Wrong or used links from one address before it's not listened to any more.
const FAILS_MAX: u32 = 5;

/// Where the host is waiting for guests.
enum Net {
    Lan(SocketAddr),
    Relay { relay: String, room: String },
}

pub(super) struct Host {
    epoch: u64,
    pub(super) robot: String,
    pub(super) tab: String,
    pub(super) from: usize,
    pub(super) shown: Shown,
    ends_at: i64,
    net: Net,
    fingerprint: String,
    invites: Vec<(blake3::Hash, Instant)>,
    guests: Vec<Guest>,
    fails: HashMap<String, u32>,                 // (by address)
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
        host.ip = match &self.net {
            Net::Lan(addr) => addr.ip().to_string(),
            Net::Relay { .. } => "the internet".into(),
        };
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
            internet: matches!(self.net, Net::Relay { .. }),
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
}

/// Has this address sent too many wrong or used links (or has sharing stopped)?
fn locked_out(app: &AppHandle, addr: &str) -> bool {
    shares(app, |s| {
        s.host
            .as_ref()
            .is_none_or(|h| h.fails.get(addr).is_some_and(|n| *n >= FAILS_MAX))
    })
}

// ---------------------------------------------------------------- starting and stopping

/// What the host picked in the share card.
pub(super) struct Opts {
    pub from_now: bool,
    pub tool_output: bool,
    pub internet: bool,
}

/// How guests get in: the office network's listener, or a room on the relay.
enum Door {
    Lan(TcpListener),
    Relay(Box<Room>), // (its WebSocket is big)
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
    let (config, fingerprint) = tls::server()?;
    let (net, door) = if o.internet {
        let relay = relay_of(app);
        let room = relay::room()?;
        let door = Door::Relay(Box::new(relay::open_room(&relay, &room)?));
        (Net::Relay { relay, room }, door)
    } else {
        let (listener, addr) = lan::open()?;
        (Net::Lan(addr), Door::Lan(listener))
    };
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
            net,
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
    thread::spawn(move || match door {
        Door::Lan(l) => lan::listen(&app2, epoch, &l, &config, &stop),
        Door::Relay(room) => through_relay(&app2, epoch, *room, &config),
    });
    let app3 = app.clone();
    thread::spawn(move || watch(&app3, epoch));
    log::info!(
        "sharing a tab {}",
        if o.internet {
            "over the internet"
        } else {
            "on the office network"
        }
    );
    changed(app);
    view_for(app, robot).ok_or_else(|| "Sharing stopped.".into())
}

/// The relay C-Bot shares through: the `shareRelay` setting's, if it names one, else C-Bot's.
fn relay_of(app: &AppHandle) -> String {
    let set = with(app, |st| {
        st.store.settings()["shareRelay"]
            .as_str()
            .map(str::to_string)
    });
    set.filter(|r| wire::is_relay_host(r))
        .unwrap_or_else(|| relay::RELAY.to_string())
}

/// Guests through the relay: each one's stream to its own connection.
fn through_relay(app: &AppHandle, epoch: u64, room: Room, config: &Arc<ServerConfig>) {
    let ended = room.serve(
        || current(app, epoch),
        |pipe, addr| {
            if locked_out(app, &addr) {
                return; // (dropped: the relay closes it)
            }
            let (app, config) = (app.clone(), config.clone());
            thread::spawn(move || serve::serve(&app, epoch, config, Box::new(pipe), &addr));
        },
    );
    if let Some(why) = ended
        && current(app, epoch)
    {
        stop(app, &format!("{why} Sharing stopped."));
    }
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
        let at = match &h.net {
            Net::Lan(addr) => At::Lan(*addr),
            Net::Relay { relay, room } => At::Relay {
                relay: relay.clone(),
                room: room.clone(),
            },
        };
        Some(
            Link {
                at,
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
pub(super) fn changed(app: &AppHandle) {
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

fn current(app: &AppHandle, epoch: u64) -> bool {
    shares(app, |s| s.host.as_ref().is_some_and(|h| h.epoch == epoch))
}

/// The time limit, old invites, and (on the office network) the network changing under it.
fn watch(app: &AppHandle, epoch: u64) {
    let mut n = 0u32;
    while current(app, epoch) {
        thread::sleep(Duration::from_secs(2));
        n += 1;
        let (over, lan_ip) = shares(app, |s| {
            let Some(h) = s.host.as_mut().filter(|h| h.epoch == epoch) else {
                return (false, None);
            };
            h.invites.retain(|(_, until)| *until > Instant::now());
            let ip = match &h.net {
                Net::Lan(addr) => Some(addr.ip()),
                Net::Relay { .. } => None,
            };
            (now_ms() >= h.ends_at, ip)
        });
        if over {
            stop(app, "Sharing ran out of time (an hour).");
        } else if n.is_multiple_of(5) && lan_ip.is_some() && lan::local_ip() != lan_ip {
            stop(app, "The network changed, so sharing stopped.");
        }
    }
}
