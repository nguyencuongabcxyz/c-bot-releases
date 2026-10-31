//! One person's connection to a shared tab, whichever way it came (the office network or the
//! relay): their hello and invite, waiting for you to let them in, then the chat going out to
//! them and their suggestions coming in.

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::json;

use super::*;
use crate::features::share::wire::{self, Lines, Msg, Read1};

/// How long a new connection has to say hello, and you to let it in.
const HELLO_WAIT: Duration = Duration::from_secs(10);
const ANSWER_WAIT: Duration = Duration::from_secs(180);
/// Suggestions a guest may send a minute.
const PER_MINUTE: usize = 5;

type Tls = StreamOwned<ServerConnection, Box<dyn Stream>>;

/// One person's connection, from hello to goodbye: `addr` is where they are (an address on
/// the office network, or the one the relay saw).
pub(super) fn serve(
    app: &AppHandle,
    epoch: u64,
    config: Arc<ServerConfig>,
    stream: Box<dyn Stream>,
    addr: &str,
) {
    let Ok(sc) = ServerConnection::new(config) else {
        return;
    };
    let mut tls = StreamOwned::new(sc, stream);
    let mut lines = Lines::new(wire::GUEST_LINE_MAX);
    let Some(mut person) = hello(app, epoch, &mut tls, &mut lines, addr) else {
        return;
    };
    person.ip = addr.to_string();
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
    addr: &str,
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
                *h.fails.entry(addr.to_string()).or_insert(0) += 1;
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
    let Some(host) = shares(app, |s| s.host.as_ref().map(|h| h.view().host)) else {
        return;
    };
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
