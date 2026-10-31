//! What two C-Bots say to each other over a shared chat: one JSON message per line (over TLS:
//! tls.rs), the invite link, and the checks on what comes in. Pure, so it's tested here.

use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Bumped when the messages change: a C-Bot on another version is told to update.
pub(super) const PROTO: u32 = 1;
/// The longest line a guest may send (a suggestion is a few lines of text).
pub(super) const GUEST_LINE_MAX: usize = 16 * 1024;
/// The longest line the host may send (a step's pictures, when tool output is shared).
pub(super) const HOST_LINE_MAX: usize = 16 * 1024 * 1024;
/// The longest suggestion, in characters.
pub(super) const SUGGESTION_MAX: usize = 4000;

/// Someone at either end: what they're called, their PC, and where they are on the network
/// (shown on both sides, so a made-up name can't hide who's asking).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub pc: String,
    #[serde(default)]
    pub ip: String,
}

/// Where a guest's suggestion is at.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Suggestion {
    Waiting,
    Sent,
    Editing,
    Declined,
    Refused, // (not even shown to the host: a command, too long, too many)
}

/// One line on the wire.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub(super) enum Msg {
    // ---- guest -> host (the only four a guest may send once it's in)
    Hello {
        proto: u32,
        token: String,
        me: Person,
    },
    Suggest {
        id: String,
        text: String,
    },
    TakeBack {
        id: String,
    },
    Leave,
    Ping,
    // ---- host -> guest
    Welcome {
        host: Person,
        robot: Value,
    },
    Refused {
        reason: String,
    },
    /// What the host's chat heard (a robot:event, with its tabId), shaped for guests.
    Event {
        event: Value,
    },
    /// The tab again, after its history changed.
    Tab {
        tab: Value,
    },
    Suggestion {
        id: String,
        state: Suggestion,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        why: String,
    },
    Who {
        people: Vec<Person>,
    },
    End {
        reason: String,
    },
}

impl Msg {
    pub(super) fn line(&self) -> String {
        let mut s = serde_json::to_string(self).expect("a message is plain JSON");
        s.push('\n');
        s
    }
}

// ---------------------------------------------------------------- lines

/// Reads whole lines off a stream that may time out between them (its read timeout is how
/// often the other side's messages are looked at): what's half read waits for the rest.
pub(super) struct Lines {
    buf: Vec<u8>,
    max: usize,
}

pub(super) enum Read1 {
    Line(String),
    Nothing, // (the read timed out: nothing whole yet)
    Closed,
    TooLong,
}

impl Lines {
    pub(super) fn new(max: usize) -> Lines {
        Lines {
            buf: Vec::new(),
            max,
        }
    }

    /// A line already in, without reading.
    fn take(&mut self) -> Option<String> {
        let at = self.buf.iter().position(|b| *b == b'\n')?;
        let line: Vec<u8> = self.buf.drain(..=at).collect();
        Some(String::from_utf8_lossy(&line[..at]).into_owned())
    }

    pub(super) fn next(&mut self, r: &mut impl Read) -> Read1 {
        if let Some(l) = self.take() {
            return Read1::Line(l);
        }
        let mut chunk = [0u8; 16 * 1024];
        match r.read(&mut chunk) {
            Ok(0) => Read1::Closed,
            Ok(n) => {
                self.buf.extend_from_slice(&chunk[..n]);
                match self.take() {
                    Some(l) => Read1::Line(l),
                    None if self.buf.len() > self.max => Read1::TooLong,
                    None => Read1::Nothing,
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Read1::Nothing
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => Read1::Nothing,
            Err(_) => Read1::Closed,
        }
    }
}

pub(super) fn send(w: &mut impl Write, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.flush()
}

// ---------------------------------------------------------------- the invite link

/// Where an invite link's host is: on the office network, or in a room on a relay.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum At {
    Lan(SocketAddr),
    Relay { relay: String, room: String },
}

/// What an invite link says: where the host is, the one-time token, and its certificate's
/// fingerprint (so the guest knows it's talking to that C-Bot and no other, relay or not).
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Link {
    pub at: At,
    pub token: String,
    pub fingerprint: String,
}

const SCHEME: &str = "cbot://join/";

impl Link {
    pub(super) fn text(&self) -> String {
        let (t, f) = (&self.token, &self.fingerprint);
        match &self.at {
            At::Lan(addr) => format!("{SCHEME}{addr}/{t}/{f}"),
            At::Relay { relay, room } => format!("{SCHEME}r/{relay}/{room}/{t}/{f}"),
        }
    }

    /// A link as it was pasted or clicked (spaces round it, a trailing slash, the scheme in
    /// any case). None for anything else, or for a host outside the private network that
    /// isn't in a relay's room.
    pub fn parse(s: &str) -> Option<Link> {
        let s = s.trim().trim_end_matches('/');
        let rest = s
            .get(..SCHEME.len())
            .filter(|p| p.eq_ignore_ascii_case(SCHEME))
            .map(|_| &s[SCHEME.len()..])?;
        let parts: Vec<&str> = rest.split('/').collect();
        let hex = |t: &str, n: usize| t.len() == n && t.bytes().all(|b| b.is_ascii_hexdigit());
        let (at, token, fingerprint) = match parts.as_slice() {
            [addr, t, f] => {
                let addr: SocketAddr = addr.parse().ok()?;
                (is_private(addr.ip()).then_some(At::Lan(addr))?, t, f)
            }
            ["r", relay, room, t, f] if is_relay_host(relay) && hex(room, 32) => (
                At::Relay {
                    relay: relay.to_ascii_lowercase(),
                    room: room.to_ascii_lowercase(),
                },
                t,
                f,
            ),
            _ => return None,
        };
        (hex(token, 64) && hex(fingerprint, 64)).then(|| Link {
            at,
            token: token.to_string(),
            fingerprint: fingerprint.to_string(),
        })
    }
}

/// A relay's host as a link may name it: a domain name (a port only for one on this PC, to
/// try a relay running here).
pub(super) fn is_relay_host(h: &str) -> bool {
    let (name, port) = h.split_once(':').unwrap_or((h, ""));
    let named = !name.is_empty()
        && name.len() <= 253
        && name.contains('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let local = matches!(name, "localhost" | "127.0.0.1") && port.parse::<u16>().is_ok();
    (named && port.is_empty()) || local
}

/// On the office network: private, link-local or this PC. Nothing else may join or be joined.
pub(super) fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

// ---------------------------------------------------------------- suggestions

/// Why a suggestion can't go to the host at all, if it can't.
pub(super) fn refuse(text: &str) -> Option<&'static str> {
    let t = text.trim_start();
    if t.is_empty() {
        return Some("It's empty.");
    }
    if t.starts_with('/') || t.starts_with('!') {
        return Some("Suggestions can't start with / or ! (those run commands).");
    }
    if text.chars().count() > SUGGESTION_MAX {
        return Some("It's too long (4,000 characters at most).");
    }
    None
}

/// Characters you can't see that could hide words from the host: zero-width ones, the ones
/// that turn text round (bidi), and HTML comments.
pub(super) fn hidden_marks(text: &str) -> bool {
    text.contains("<!--")
        || text.chars().any(|c| {
            matches!(c,
                '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}' | '\u{180E}'
                | '\u{E0000}'..='\u{E007F}')
        })
}

/// The suggestion with what can't be seen shown: each such character as its code.
pub(super) fn shown(text: &str) -> String {
    if !hidden_marks(text) {
        return text.to_string();
    }
    text.chars()
        .map(|c| {
            if hidden_marks(c.encode_utf8(&mut [0; 4])) {
                format!("⟨U+{:04X}⟩", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect()
}

// ---------------------------------------------------------------- what guests see

/// What the host chose to share.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Shown {
    pub tool_output: bool,
}

/// The kinds of chat events a guest never gets: the host's own controls (questions and plans
/// are answered by the host alone), MCP Apps (a page of the host's tools), Remote Control.
fn kept_from_guests(kind: &str) -> bool {
    matches!(
        kind,
        "question"
            | "request-cancelled"
            | "plan"
            | "app"
            | "app-result"
            | "remote"
            | "remote-state"
            | "context"
            | "terminal"
            | "mirror"
            | "side"
    ) || kind.starts_with("share-")
}

const MASKED: &str = "🔒 Not shared";

/// A chat event as a guest gets it, or None when guests don't get that kind. Unless the host
/// shares tool output, steps keep their name and what they're on, not what went in or came out.
pub(super) fn for_guests(ev: &Value, shown: Shown) -> Option<Value> {
    let kind = ev["type"].as_str().unwrap_or("");
    if kind.is_empty() || kept_from_guests(kind) {
        return None;
    }
    if shown.tool_output {
        return Some(ev.clone());
    }
    let mut ev = ev.clone();
    match kind {
        "tool-images" => return None,
        "tool" => ev["args"] = json!({}),
        "tool-output" => {
            ev["text"] = json!(MASKED);
            ev["media"] = json!([]);
        }
        "agent" => {
            for k in ["prompt", "result", "output"] {
                if ev.get(k).is_some() {
                    ev[k] = json!(MASKED);
                }
            }
        }
        _ => {}
    }
    Some(ev)
}

/// A history entry as a guest gets it: the same rules as for_guests.
fn entry_for_guests(h: &Value, shown: Shown) -> Value {
    let mut h = h.clone();
    if let Some(o) = h.as_object_mut() {
        o.remove("apps");
        if !shown.tool_output {
            o.remove("images");
            if let Some(tools) = o.get_mut("tools").and_then(Value::as_array_mut) {
                for t in tools {
                    if let Some(t) = t.as_object_mut() {
                        t.remove("input");
                        t.remove("args");
                        t.remove("media");
                        if t.contains_key("result") {
                            t.insert("result".into(), json!(MASKED));
                        }
                        if t.contains_key("output") {
                            t.insert("output".into(), json!(MASKED));
                        }
                    }
                }
            }
        }
    }
    h
}

/// The shared tab as a guest gets it: its name and history (from `from` on), nothing that
/// would let it be resumed.
pub(super) fn tab_for_guests(tab: &Value, from: usize, shown: Shown) -> Value {
    let history: Vec<Value> = tab["history"]
        .as_array()
        .map(|h| {
            h.iter()
                .skip(from)
                .map(|e| entry_for_guests(e, shown))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": tab["id"], "title": tab["title"], "custom": tab["custom"], "createdAt": tab["createdAt"],
        "history": history, "busy": tab["busy"],
    })
}

/// The robot as a guest's visiting copy of it: how it looks and what it's called, its
/// folder's name (not where it is: a visitor has no folder), and only the shared tab.
pub(super) fn robot_for_guests(c: &Value, tab: Value) -> Value {
    let mut v = json!({});
    for k in [
        "name",
        "personality",
        "color",
        "accessory",
        "body",
        "theme",
        "size",
        "kit",
    ] {
        if let Some(x) = c.get(k) {
            v[k] = x.clone();
        }
    }
    let folder = c["folder"]
        .as_str()
        .unwrap_or("")
        .split(['\\', '/'])
        .rfind(|p| !p.is_empty())
        .unwrap_or("")
        .to_string();
    v["folderName"] = json!(folder);
    v["activeTab"] = tab["id"].clone();
    v["tabs"] = json!([tab]);
    v
}

/// The visiting robot a guest makes from what the host sent: only how it looks, its name and
/// its folder's name, and the tab (checked again here, whatever the other end sent). It has
/// no folder, so nothing in its chat can run or read files here.
pub(super) fn visitor(id: &str, from_host: &Value) -> Value {
    let tab = from_host["tabs"]
        .get(0)
        .cloned()
        .unwrap_or_else(|| json!({}));
    let tab = tab_for_guests(&tab, 0, Shown { tool_output: true });
    let mut v = json!({});
    for k in [
        "name",
        "personality",
        "color",
        "accessory",
        "body",
        "theme",
        "size",
        "kit",
    ] {
        if let Some(x) = from_host.get(k) {
            v[k] = x.clone();
        }
    }
    let name: String = from_host["name"]
        .as_str()
        .unwrap_or("Robo")
        .chars()
        .take(40)
        .collect();
    let folder: String = from_host["folderName"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect();
    v["id"] = json!(id);
    v["name"] = json!(name);
    v["folder"] = json!("");
    v["folderName"] = json!(folder);
    v["visitor"] = json!(true);
    v["visible"] = json!(true);
    v["wanders"] = json!(false);
    v["clickOpens"] = json!("chat");
    v["permissionMode"] = json!("default");
    v["model"] = json!("");
    v["activeTab"] = tab["id"].clone();
    v["tabs"] = json!([tab]);
    v["closedTabs"] = json!([]);
    v
}

/// A name to show for someone: their Windows user name, its first word ("CuongNguyen" →
/// "Cuong", "minh.tran" → "Minh").
pub(super) fn short_name(user: &str) -> String {
    let word: String = user
        .chars()
        .enumerate()
        .take_while(|(i, c)| c.is_alphanumeric() && !(*i > 0 && c.is_uppercase()))
        .map(|(_, c)| c)
        .collect();
    let mut cs = word.chars();
    match cs.next() {
        Some(f) => f.to_uppercase().chain(cs).collect(),
        None => "Someone".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "aa11bb22cc33dd44ee55ff6600112233aa11bb22cc33dd44ee55ff6600112233";

    #[test]
    fn a_link_goes_there_and_back() {
        let l = Link {
            at: At::Lan("10.0.4.27:47821".parse().unwrap()),
            token: T.into(),
            fingerprint: T.into(),
        };
        assert_eq!(Link::parse(&format!("  {}/ ", l.text())), Some(l.clone()));
        assert_eq!(
            Link::parse(&l.text().replace("cbot://", "CBOT://")),
            Some(l)
        );
    }

    #[test]
    fn a_relay_link_goes_there_and_back() {
        let l = Link {
            at: At::Relay {
                relay: "cbot-relay.example.workers.dev".into(),
                room: "0123456789abcdef0123456789abcdef".into(),
            },
            token: T.into(),
            fingerprint: T.into(),
        };
        assert!(
            l.text()
                .starts_with("cbot://join/r/cbot-relay.example.workers.dev/0123")
        );
        assert_eq!(Link::parse(&l.text()), Some(l));
        let local = format!("cbot://join/r/localhost:8787/{}/{T}/{T}", "a".repeat(32));
        assert!(Link::parse(&local).is_some());
    }

    #[test]
    fn links_outside_the_office_network_or_odd_ones_are_refused() {
        assert_eq!(Link::parse(&format!("cbot://join/8.8.8.8:1/{T}/{T}")), None);
        assert_eq!(
            Link::parse(&format!("cbot://join/10.0.0.1:1/abc/{T}")),
            None
        );
        assert_eq!(
            Link::parse(&format!("https://join/10.0.0.1:1/{T}/{T}")),
            None
        );
        assert_eq!(
            Link::parse(&format!("cbot://join/10.0.0.1:1/{T}/{T}/x")),
            None
        );
        assert!(Link::parse(&format!("cbot://join/192.168.1.5:9/{T}/{T}")).is_some());
        assert!(Link::parse(&format!("cbot://join/[fe80::1]:9/{T}/{T}")).is_some());
    }

    #[test]
    fn odd_relays_and_rooms_are_refused() {
        let room = "a".repeat(32);
        for relay in [
            "evil.com:8443",
            "nodots",
            "a/b.com",
            "localhost",
            "user@x.com",
            "",
        ] {
            assert_eq!(
                Link::parse(&format!("cbot://join/r/{relay}/{room}/{T}/{T}")),
                None,
                "{relay}"
            );
        }
        assert_eq!(
            Link::parse(&format!("cbot://join/r/x.dev/short/{T}/{T}")),
            None
        );
    }

    #[test]
    fn messages_keep_their_json() {
        let m = Msg::Suggestion {
            id: "s1".into(),
            state: Suggestion::Sent,
            why: String::new(),
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({ "t": "suggestion", "id": "s1", "state": "sent" })
        );
        let m: Msg = serde_json::from_str(r#"{"t":"take-back","id":"x"}"#).unwrap();
        assert_eq!(m, Msg::TakeBack { id: "x".into() });
        assert!(m.line().ends_with('\n'));
    }

    #[test]
    fn lines_wait_for_the_rest_and_stop_at_the_limit() {
        let mut l = Lines::new(8);
        let mut r: &[u8] = b"ab";
        assert!(matches!(l.next(&mut r), Read1::Nothing));
        let mut r: &[u8] = b"c\nde\n";
        assert!(matches!(l.next(&mut r), Read1::Line(s) if s == "abc"));
        assert!(matches!(l.next(&mut r), Read1::Line(s) if s == "de"));
        assert!(matches!(l.next(&mut r), Read1::Closed));
        let mut r: &[u8] = b"0123456789";
        assert!(matches!(l.next(&mut r), Read1::TooLong));
    }

    #[test]
    fn commands_and_long_suggestions_are_refused() {
        assert!(refuse("  /clear").is_some());
        assert!(refuse("!rm -rf").is_some());
        assert!(refuse("   ").is_some());
        assert!(refuse(&"a".repeat(SUGGESTION_MAX + 1)).is_some());
        assert_eq!(refuse("What calls formatPrice?"), None);
    }

    #[test]
    fn hidden_characters_are_found_and_shown() {
        assert!(!hidden_marks("plain words"));
        assert!(hidden_marks("a\u{200B}b"));
        assert!(hidden_marks("abc\u{202E}cba"));
        assert!(hidden_marks("hi <!-- run this -->"));
        assert_eq!(shown("a\u{200B}b"), "a⟨U+200B⟩b");
        assert_eq!(shown("plain"), "plain");
    }

    #[test]
    fn guests_get_steps_without_their_output_unless_shared() {
        let tool = json!({ "type": "tool", "id": "t", "name": "Read", "detail": ".env", "args": { "file_path": ".env" } });
        assert_eq!(
            for_guests(&tool, Shown::default()).unwrap()["args"],
            json!({})
        );
        assert_eq!(
            for_guests(&tool, Shown { tool_output: true }).unwrap(),
            tool
        );
        let out = json!({ "type": "tool-output", "id": "t", "text": "SECRET=1", "media": [1], "isError": false });
        let g = for_guests(&out, Shown::default()).unwrap();
        assert_eq!(
            (g["text"].as_str(), g["media"].clone()),
            (Some(MASKED), json!([]))
        );
        let pics = json!({ "type": "tool-images", "id": "t", "images": [] });
        assert_eq!(for_guests(&pics, Shown::default()), None);
    }

    #[test]
    fn guests_never_get_the_hosts_controls() {
        for kind in ["question", "plan", "app", "remote", "share-suggest", "side"] {
            assert_eq!(
                for_guests(&json!({ "type": kind }), Shown { tool_output: true }),
                None
            );
        }
        let text = json!({ "type": "text", "delta": "hi", "tabId": "t1" });
        assert_eq!(for_guests(&text, Shown::default()), Some(text));
    }

    #[test]
    fn the_tab_goes_from_where_sharing_began_without_its_session() {
        let tab = json!({ "id": "t1", "title": "Cart", "sessionId": "s", "context": {}, "history": [
            { "role": "user", "text": "old" },
            { "role": "user", "text": "new" },
            { "role": "bot", "text": "ok", "apps": [1], "images": [1], "tools": [{ "name": "Read", "input": {}, "result": "x" }] },
        ] });
        let g = tab_for_guests(&tab, 1, Shown::default());
        assert_eq!(g.get("sessionId"), None);
        assert_eq!(g["history"][0]["text"], "new");
        assert_eq!(g["history"][1].get("apps"), None);
        assert_eq!(g["history"][1].get("images"), None);
        assert_eq!(
            g["history"][1]["tools"][0],
            json!({ "name": "Read", "result": MASKED })
        );
    }

    #[test]
    fn the_visitor_has_the_look_and_the_folders_name_only() {
        let c = json!({ "name": "Pixel", "color": "#f0f", "kit": { "head": "dome" }, "folder": "C:\\Users\\me\\shop-web\\",
            "stats": { "costUsd": 9 }, "sessionIds": ["s"], "permissionMode": "bypassPermissions" });
        let v = robot_for_guests(&c, json!({ "id": "t1" }));
        assert_eq!(v["folderName"], "shop-web");
        assert_eq!(v.get("folder"), None);
        assert_eq!(v["kit"]["head"], "dome");
        assert_eq!(v.get("stats"), None);
        assert_eq!(v.get("sessionIds"), None);
        assert_eq!(v.get("permissionMode"), None);
        assert_eq!(v["activeTab"], "t1");
    }

    #[test]
    fn a_visitor_keeps_only_its_look_and_has_no_folder() {
        let from_host = json!({ "name": "Pixel", "kit": { "head": "dome" }, "folder": "C:/secret", "folderName": "shop-web",
            "permissionMode": "bypassPermissions", "sessionIds": ["s"],
            "tabs": [{ "id": "t1", "title": "Cart", "sessionId": "s", "remote": true, "history": [{ "role": "user", "text": "hi" }] }] });
        let v = visitor("visit-1", &from_host);
        assert_eq!(
            (v["id"].as_str(), v["folder"].as_str()),
            (Some("visit-1"), Some(""))
        );
        assert_eq!(v["folderName"], "shop-web");
        assert_eq!(v["permissionMode"], "default");
        assert_eq!(v.get("sessionIds"), None);
        assert_eq!(v["tabs"][0].get("sessionId"), None);
        assert_eq!(v["tabs"][0].get("remote"), None);
        assert_eq!(v["tabs"][0]["history"][0]["text"], "hi");
        assert_eq!(v["activeTab"], "t1");
    }

    #[test]
    fn names_are_the_first_word() {
        assert_eq!(short_name("CuongNguyen"), "Cuong");
        assert_eq!(short_name("minh.tran"), "Minh");
        assert_eq!(short_name(""), "Someone");
    }
}
