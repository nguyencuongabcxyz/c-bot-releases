//! Sharing on the office network: listening on this PC's address there (never on a network
//! Windows calls Public), and taking the connections that come from it.

use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use rustls::ServerConfig;

use super::*;
use crate::features::share::wire;
use crate::platform::network;

/// How often it looks for a new connection.
const TICK: Duration = Duration::from_millis(50);
/// Connections not yet let in, at most.
const OPEN_MAX: usize = 6;

/// A port to listen on, on this PC's address on the office network.
pub(super) fn open() -> Result<(TcpListener, SocketAddr), Error> {
    let ip = local_ip()
        .filter(|ip| wire::is_private(*ip) && !ip.is_loopback())
        .ok_or_else(|| {
            Error::from(
                "This PC isn't on an office network (it has no private address), so it can't share there. Share over the internet instead.",
            )
        })?;
    if network::is_public(ip) == Some(true) {
        return Err("Windows calls this network Public, so I won't share on it. Share over the internet instead, or make it Private (Settings → Network & internet → your network → Network profile type).".into());
    }
    let listener = TcpListener::bind((ip, 0))
        .map_err(|e| Error::from(format!("Couldn't listen on the network: {e}")))?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    Ok((listener, addr))
}

/// This PC's address on the network it goes out through (nothing is sent: a UDP socket only
/// picks its way out when it's connected).
pub(super) fn local_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip())
}

pub(super) fn listen(
    app: &AppHandle,
    epoch: u64,
    l: &TcpListener,
    config: &Arc<ServerConfig>,
    stop: &Stop,
) {
    let open = Arc::new(AtomicUsize::new(0));
    while !stop.is() && current(app, epoch) {
        match l.accept() {
            Ok((tcp, peer)) => {
                let ip = peer.ip();
                let shut = !wire::is_private(ip)
                    || open.load(Ordering::Relaxed) >= OPEN_MAX
                    || locked_out(app, &ip.to_string());
                if shut {
                    continue; // (dropped: closed at once)
                }
                let (app, config, open) = (app.clone(), config.clone(), open.clone());
                open.fetch_add(1, Ordering::Relaxed);
                thread::spawn(move || {
                    let _ = tcp.set_nonblocking(false);
                    let _ = tcp.set_read_timeout(Some(TICK));
                    let _ = tcp.set_nodelay(true);
                    serve::serve(&app, epoch, config, Box::new(tcp), &ip.to_string());
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
