//! The private local socket the tool calls come over (one line of JSON each way), and who's on it.

use super::*;

pub(super) fn serve(app: AppHandle, listener: TcpListener) {
    static CONN: AtomicU64 = AtomicU64::new(0);
    for sock in listener.incoming() {
        let Ok(sock) = sock else { continue };
        let conn = CONN.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        thread::spawn(move || connection(&app, sock, conn));
    }
}

/// One call: a line in, a line back.
pub(super) fn connection(app: &AppHandle, mut sock: TcpStream, conn: u64) {
    let mut line = String::new();
    {
        let mut reader = BufReader::new(&sock);
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
    }
    let answer = match serde_json::from_str::<Value>(line.trim()) {
        Ok(req) => {
            // the asking robot stopped waiting (its Claude was stopped): its request is cancelled
            if let Ok(mut watch) = sock.try_clone() {
                let app = app.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 64];
                    while matches!(watch.read(&mut buf), Ok(n) if n > 0) {}
                    let mine: Vec<String> = link(&app, |l| {
                        l.pending
                            .iter()
                            .filter(|(_, p)| p.conn == conn)
                            .map(|(k, _)| k.clone())
                            .collect()
                    });
                    for req_id in mine {
                        settle(&app, &req_id, "", "", true);
                    }
                });
            }
            handle(app, &req, conn)
        }
        Err(_) => err("Bad request."),
    };
    let _ = writeln!(sock, "{answer}").and_then(|_| sock.flush());
    let _ = sock.shutdown(Shutdown::Both);
}
