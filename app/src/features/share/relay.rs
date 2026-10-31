//! Sharing over the internet: both C-Bots connect out to C-Bot's relay (relay/, a Cloudflare
//! Worker) over a WebSocket, so nothing has to reach in through a router or a firewall. The
//! host opens a room; each guest's bytes come to it numbered, and go back the same way. What
//! they carry is the same TLS as on the office network, end to end between the two C-Bots,
//! so the relay can't read it or change it: it only passes it on.

use std::collections::HashMap;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use rustls::crypto::ring;
use rustls::{ClientConfig, RootCertStore};
use serde::Deserialize;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Connector, Message, WebSocket};

use super::pipe::{Outgoing, Pipe};
use super::wire;
use crate::runtime::Error;

/// The relay C-Bot shares through, unless the `shareRelay` setting names another.
pub(super) const RELAY: &str = "cbot-relay.cbot-relay.workers.dev";
/// How long a read waits (how quickly what's queued to go out goes).
const TICK: Duration = Duration::from_millis(20);
/// How long a pipe's read waits before saying "nothing yet" (as a socket's read timeout).
const PIPE_WAIT: Duration = Duration::from_millis(50);
const CONNECT_WAIT: Duration = Duration::from_secs(8);
/// A ping this often keeps the connection from being dropped while nobody says anything.
const PING_EVERY: Duration = Duration::from_secs(25);
/// How long a stopping share keeps passing on what's still queued (the guests' goodbyes).
const GOODBYE: Duration = Duration::from_millis(600);

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

/// A room's id: 128 random bits, as hex.
pub(super) fn room() -> Result<String, Error> {
    Ok(super::tls::token()?[..32].to_string())
}

/// Into a room on a relay, as its host or a guest.
fn connect(relay: &str, room: &str, host: bool) -> Result<Ws, Error> {
    if !wire::is_relay_host(relay) {
        return Err(format!("{relay} isn't a relay I can use.").into());
    }
    let local = relay.starts_with("localhost:") || relay.starts_with("127.0.0.1:");
    let role = if host { "host" } else { "guest" };
    let url = format!(
        "{}://{relay}/room/{room}?as={role}",
        if local { "ws" } else { "wss" }
    );
    let (name, port) = match relay.split_once(':') {
        Some((n, p)) => (n, p.parse().unwrap_or(443)),
        None => (relay, 443),
    };
    // (each of its addresses in turn: "localhost" may say IPv6 first to a relay on IPv4 only)
    let mut last = None;
    let mut tcp = None;
    for addr in (name, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, CONNECT_WAIT) {
            Ok(t) => {
                tcp = Some(t);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let tcp = tcp.ok_or_else(|| {
        Error::from(format!(
            "Couldn't reach the relay ({relay}): {}",
            last.map_or_else(|| "it has no address".to_string(), |e| e.to_string())
        ))
    })?;
    let _ = tcp.set_nodelay(true);
    let connector = if local {
        Connector::Plain
    } else {
        Connector::Rustls(client_config())
    };
    let (ws, _) = tungstenite::client_tls_with_config(url, tcp, None, Some(connector))
        .map_err(|e| refused(&e.to_string()))?;
    let tcp = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s,
        MaybeTlsStream::Rustls(s) => s.get_ref(),
        _ => return Err("The relay's connection is of a kind I don't know.".into()),
    };
    tcp.set_read_timeout(Some(TICK))?;
    Ok(ws)
}

/// What the relay's refusal means, in words.
fn refused(e: &str) -> Error {
    let why = if e.contains("404") {
        "That share has stopped (or the link is wrong)."
    } else if e.contains("409") {
        "The relay says that room is taken. Try sharing again."
    } else if e.contains("429") {
        "That share is full."
    } else {
        return format!("Couldn't connect to the relay: {e}").into();
    };
    why.into()
}

/// TLS to the relay itself, checked against the system's certificates (on the ring that
/// rustls is already built with).
fn client_config() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring's defaults have protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

/// A frame for the relay: a guest's number, then its bytes.
fn numbered(peer: u32, bytes: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(4 + bytes.len());
    f.extend_from_slice(&peer.to_be_bytes());
    f.extend_from_slice(bytes);
    f
}

fn quiet(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

// ---------------------------------------------------------------- the host's side

/// What the relay tells the host about its guests.
#[derive(Deserialize)]
struct Note {
    t: String,
    peer: u32,
    #[serde(default)]
    ip: String,
}

/// The host's room, open on the relay.
pub(super) struct Room {
    ws: Ws,
}

pub(super) fn open_room(relay: &str, room: &str) -> Result<Room, Error> {
    Ok(Room {
        ws: connect(relay, room, true)?,
    })
}

impl Room {
    /// Passes bytes between the relay and each guest until `going` says stop or the relay
    /// goes: a guest arriving is handed to `arrive` as a stream, with the address the relay
    /// saw. Why it ended, if the relay ended it.
    pub(super) fn serve(
        mut self,
        going: impl Fn() -> bool,
        arrive: impl Fn(Pipe, String),
    ) -> Option<String> {
        let (out, from_pipes) = mpsc::channel();
        let mut peers: HashMap<u32, Sender<Vec<u8>>> = HashMap::new();
        let mut pinged = Instant::now();
        let mut closing: Option<Instant> = None;
        let ended = loop {
            // (stopping: a moment more, so the goodbyes queued for the guests still go out)
            if closing.is_none() && !going() {
                closing = Some(Instant::now() + GOODBYE);
            }
            if closing.is_some_and(|t| Instant::now() >= t) {
                break None;
            }
            if let Err(why) = self.send_queued(&from_pipes, &mut peers) {
                break Some(why);
            }
            if pinged.elapsed() > PING_EVERY {
                pinged = Instant::now();
                let _ = self.ws.send(Message::Ping(Vec::new().into()));
            }
            match self.ws.read() {
                Ok(Message::Text(t)) => self.heard(&t, &mut peers, &out, &arrive),
                Ok(Message::Binary(b)) if b.len() >= 4 => {
                    let peer = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
                    if let Some(tx) = peers.get(&peer) {
                        let _ = tx.send(b[4..].to_vec());
                    }
                }
                Ok(Message::Close(_)) => break Some("The relay closed the share.".into()),
                Ok(_) => {}
                Err(e) if quiet(&e) => {}
                Err(_) => break Some("Lost the connection to the relay.".into()),
            }
        };
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
        ended
    }

    /// What the guests' streams wrote, out to the relay (an empty write: that one's done).
    fn send_queued(
        &mut self,
        from_pipes: &Receiver<(u32, Vec<u8>)>,
        peers: &mut HashMap<u32, Sender<Vec<u8>>>,
    ) -> Result<(), String> {
        while let Ok((peer, bytes)) = from_pipes.try_recv() {
            let msg = if bytes.is_empty() {
                peers.remove(&peer);
                Message::Text(format!(r#"{{"t":"close","peer":{peer}}}"#).into())
            } else {
                Message::Binary(numbered(peer, &bytes).into())
            };
            self.ws
                .send(msg)
                .map_err(|_| "Lost the connection to the relay.".to_string())?;
        }
        let _ = self.ws.flush();
        Ok(())
    }

    fn heard(
        &mut self,
        text: &str,
        peers: &mut HashMap<u32, Sender<Vec<u8>>>,
        out: &Outgoing,
        arrive: &impl Fn(Pipe, String),
    ) {
        let Ok(n) = serde_json::from_str::<Note>(text) else {
            return;
        };
        match n.t.as_str() {
            "open" => {
                let (tx, rx) = mpsc::channel();
                peers.insert(n.peer, tx);
                arrive(Pipe::new(n.peer, rx, out.clone(), PIPE_WAIT), n.ip);
            }
            "close" => {
                if let Some(tx) = peers.remove(&n.peer) {
                    let _ = tx.send(Vec::new());
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- the guest's side

/// Into the host's room as a guest: a stream to the host, its bytes passed on by a thread
/// of its own until either end closes.
pub(super) fn join_room(relay: &str, room: &str) -> Result<Pipe, Error> {
    let mut ws = connect(relay, room, false)?;
    let (to_host, from_pipe) = mpsc::channel::<(u32, Vec<u8>)>();
    let (to_pipe, from_host) = mpsc::channel();
    thread::spawn(move || {
        let mut pinged = Instant::now();
        loop {
            match from_pipe.try_recv() {
                Ok((_, bytes)) if bytes.is_empty() => break,
                Ok((_, bytes)) => {
                    if ws.send(Message::Binary(bytes.into())).is_err() {
                        break;
                    }
                    continue;
                }
                Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) => {}
            }
            let _ = ws.flush();
            if pinged.elapsed() > PING_EVERY {
                pinged = Instant::now();
                let _ = ws.send(Message::Ping(Vec::new().into()));
            }
            match ws.read() {
                Ok(Message::Binary(b)) => {
                    let _ = to_pipe.send(b.to_vec());
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(e) if quiet(&e) => {}
                Err(_) => break,
            }
        }
        let _ = to_pipe.send(Vec::new());
        let _ = ws.close(None);
        let _ = ws.flush();
    });
    Ok(Pipe::new(0, from_host, to_host, PIPE_WAIT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_carries_its_guests_number_first() {
        assert_eq!(numbered(258, b"hi"), vec![0, 0, 1, 2, b'h', b'i']);
    }

    #[test]
    fn the_relays_refusals_are_said_plainly() {
        assert!(
            refused("HTTP error: 404 Not Found")
                .to_string()
                .contains("stopped")
        );
        assert!(refused("HTTP error: 429").to_string().contains("full"));
        assert!(
            refused("tls handshake eof")
                .to_string()
                .starts_with("Couldn't connect")
        );
    }

    #[test]
    fn a_room_is_32_hex_characters() {
        let r = room().unwrap();
        assert_eq!(r.len(), 32);
        assert!(r.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
