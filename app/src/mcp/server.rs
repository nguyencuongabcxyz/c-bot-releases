//! C-Bot's MCP server: what gives a robot's Claude Code C-Bot's tools (tools/: the other
//! robots, the user's words and notes, the shells in its chat). Claude Code starts it for each
//! conversation over stdio, as `c-bot.exe --robots-mcp <robot id> <port> <chat tab id>`
//! (link.rs writes the --mcp-config that says so). There's no Node here, so the app's own exe
//! serves it, from the very top of main(), before the Tauri builder (whose single-instance
//! plugin would otherwise hand the launch to the running app and quit).
//!
//! It only speaks the protocol (initialize, tools/list, tools/call, cancelling): each call
//! goes to the running C-Bot over a private local socket (127.0.0.1:<port>, with the token
//! from CBOT_TOKEN as its password), which does it (link.rs, tools/).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{Value, json};

use super::tools;
use crate::runtime::Locked;

pub const FLAG: &str = "--robots-mcp";

/// What to do with one message from Claude Code.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// Answer it now.
    Reply(Value),
    /// A tools/call: ask the app, then answer (id: the JSON-RPC id).
    Call {
        id: Value,
        tool: String,
        args: Value,
    },
    /// Claude Code gave up on a call (the user stopped it): hang up on it.
    Cancel(Value),
    Nothing,
}

pub fn step(msg: &Value) -> Step {
    let method = msg["method"].as_str().unwrap_or("");
    let params = &msg["params"];
    let Some(id) = msg.get("id").cloned() else {
        // a notification: when Claude Code cancels a call, hang up on it
        if method == "notifications/cancelled" && !params["requestId"].is_null() {
            return Step::Cancel(params["requestId"].clone());
        }
        return Step::Nothing;
    };
    let reply =
        |result: Value| Step::Reply(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match method {
        "initialize" => {
            let version = params["protocolVersion"]
                .as_str()
                .filter(|v| !v.is_empty())
                .unwrap_or("2024-11-05");
            reply(
                json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "cbot", "version": "1.0.0" } }),
            )
        }
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools::list() })),
        "tools/call" => {
            let args = params
                .get("arguments")
                .filter(|a| !a.is_null())
                .cloned()
                .unwrap_or(json!({}));
            Step::Call {
                id,
                tool: params["name"].as_str().unwrap_or("").to_string(),
                args,
            }
        }
        _ => Step::Reply(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("No method {method}") } }),
        ),
    }
}

/// A call's answer ({ text, isError } from the app) as the tool's result.
pub fn call_result(id: &Value, r: &Value) -> Value {
    let text = match &r["text"] {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let is_error = r["isError"].as_bool().unwrap_or(false);
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }], "isError": is_error } })
}

/// The key a JSON-RPC id is kept under (numbers and strings alike).
fn key_of(id: &Value) -> String {
    id.to_string()
}

struct Server {
    port: String,
    token: String,
    robot: String,
    tab: String, // (the conversation it serves: its chat tab; '' from a config written before)
    out: Mutex<std::io::Stdout>,
    open: Mutex<HashMap<String, TcpStream>>, // JSON-RPC id -> its line to the app (to hang up on)
}

impl Server {
    fn send(&self, msg: &Value) {
        let mut out = self.out.locked();
        let _ = writeln!(out, "{msg}").and_then(|_| out.flush());
    }

    /// One call: over the socket to the app, and back with { text, isError }.
    fn call(&self, id: &Value, tool: &str, args: &Value) -> Value {
        let fail = |text: String| json!({ "text": text, "isError": true });
        let mut sock = match TcpStream::connect(format!("127.0.0.1:{}", self.port)) {
            Ok(s) => s,
            Err(e) => return fail(format!("C-Bot isn't reachable ({e}). Is it still running?")),
        };
        if let Ok(clone) = sock.try_clone() {
            self.open.locked().insert(key_of(id), clone);
        }
        let request = json!({ "token": self.token, "from": self.robot, "tab": self.tab, "tool": tool, "args": args });
        let answer = (|| {
            if writeln!(sock, "{request}")
                .and_then(|_| sock.flush())
                .is_err()
            {
                return fail("C-Bot closed the line before answering.".into());
            }
            let mut line = String::new();
            match BufReader::new(&sock).read_line(&mut line) {
                Ok(n) if n > 0 && line.ends_with('\n') => serde_json::from_str(line.trim())
                    .unwrap_or_else(|_| fail("C-Bot sent back something unreadable.".into())),
                _ => fail("C-Bot closed the line before answering.".into()),
            }
        })();
        self.open.locked().remove(&key_of(id));
        let _ = sock.shutdown(Shutdown::Both);
        answer
    }
}

/// `c-bot.exe --robots-mcp <robot id> <port> [<chat tab id>]`: serve the tools on stdin/stdout until
/// Claude Code closes stdin. Returns the exit code, or None when it's an ordinary launch.
pub fn run_if_asked() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == FLAG)?;
    let (Some(robot), Some(port)) = (args.get(at + 1), args.get(at + 2)) else {
        eprintln!("usage: c-bot --robots-mcp <robot id> <port> [<chat tab id>]");
        return Some(2);
    };
    let server = Arc::new(Server {
        port: port.clone(),
        token: std::env::var("CBOT_TOKEN").unwrap_or_default(),
        robot: robot.clone(),
        tab: args.get(at + 3).cloned().unwrap_or_default(),
        out: Mutex::new(std::io::stdout()),
        open: Mutex::new(HashMap::new()),
    });
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().trim_start_matches('\u{feff}'); // (a byte-order mark some writers put first)
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match step(&msg) {
            Step::Reply(r) => server.send(&r),
            // (each on its own thread: several robots can be asked at once)
            Step::Call { id, tool, args } => {
                let server = server.clone();
                thread::spawn(move || {
                    let r = server.call(&id, &tool, &args);
                    server.send(&call_result(&id, &r));
                });
            }
            Step::Cancel(id) => {
                if let Some(sock) = server.open.locked().remove(&key_of(&id)) {
                    let _ = sock.shutdown(Shutdown::Both);
                }
            }
            Step::Nothing => {}
        }
    }
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_introduces_itself_with_the_version_asked_for() {
        let Step::Reply(r) = step(
            &json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        ) else {
            panic!()
        };
        assert_eq!(r["id"], 0);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "cbot");
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
        else {
            panic!()
        };
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn it_lists_the_tools_read_only_but_typing_in_a_shell() {
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" }))
        else {
            panic!()
        };
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "list_robots",
                "ask_robot",
                "hand_off_task",
                "list_words",
                "save_words",
                "list_notes",
                "add_note",
                "terminal_read",
                "terminal_type",
                "terminal_run"
            ]
        );
        let read_only: Vec<&str> = tools
            .iter()
            .filter(|t| t["annotations"]["readOnlyHint"] == true)
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(read_only, names[..8]);
    }

    #[test]
    fn a_call_goes_to_the_app_and_comes_back_as_text() {
        let s = step(
            &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "ask_robot", "arguments": { "robot": "Bo", "message": "hi" } } }),
        );
        assert_eq!(
            s,
            Step::Call {
                id: json!(7),
                tool: "ask_robot".into(),
                args: json!({ "robot": "Bo", "message": "hi" })
            }
        );
        let r = call_result(&json!(7), &json!({ "text": "Bo says:\nhello" }));
        assert_eq!(r["result"]["content"][0]["text"], "Bo says:\nhello");
        assert_eq!(r["result"]["isError"], false);
        let r = call_result(
            &json!(7),
            &json!({ "text": "Not allowed.", "isError": true }),
        );
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn notifications_get_no_answer_but_a_cancel_hangs_up() {
        assert_eq!(
            step(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            Step::Nothing
        );
        assert_eq!(
            step(
                &json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7 } })
            ),
            Step::Cancel(json!(7))
        );
    }

    #[test]
    fn an_unknown_method_is_an_error() {
        let Step::Reply(r) =
            step(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }))
        else {
            panic!()
        };
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["error"]["message"], "No method resources/list");
    }
}
