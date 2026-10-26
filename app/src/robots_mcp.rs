//! The "other robots" tools for a robot's Claude Code (main robotsMcp.js): an MCP server over
//! stdio that Claude Code starts for each conversation, as `c-bot.exe --robots-mcp <robot id>
//! <port>` (robotlink.rs writes the --mcp-config that says so). There's no Node here, so the
//! app's own exe serves it, from the very top of main(), before the Tauri builder (whose
//! single-instance plugin would otherwise hand the launch to the running app and quit).
//!   list_robots   the other robots on the desktop: names, folders, awake / busy / asleep
//!   ask_robot     send one of them a message; resolves to its answer (it works on it in its
//!                 own folder, in a tab of its own chat). Call it again to follow up.
//!   hand_off_task give one of them a piece of work to do in its project (tracked as a task
//!                 on both desks); resolves to its report once it's done, or why it couldn't.
//!   list_words    the English words the user saved (vocab.rs), newest first, or a search
//!   save_words    save words to that list; they're looked up as with the word hotkey
//!   list_notes    the notes in the user's notebook (notes.rs): the open ones, maybe done ones
//!   add_note      put a note in the notebook (the robot pins it on its board)
//! Each call goes to the running C-Bot over a private local socket (127.0.0.1:<port>, with the
//! token from CBOT_TOKEN as its password), which does the asking (robotlink.rs).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

pub const FLAG: &str = "--robots-mcp";

/// The tools, as tools/list gives them. readOnlyHint: Claude Code runs a tool's calls one
/// after another unless the tool says it's read-only, so without it asking two robots in one
/// turn waited for the first answer before even sending the second. Asking doesn't change
/// anything here, so they can all go at once (and saving words or notes is safe in parallel).
pub fn tools() -> Value {
    let at_once = json!({ "readOnlyHint": true });
    json!([
        {
            "name": "list_robots",
            "description": "List the other C-Bot robots on this desktop: their names, the project folder each one looks after, and whether it is awake, busy or asleep. Use it to find out who you can ask.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": at_once,
        },
        {
            "name": "ask_robot",
            "description": concat!(
                "Send a message to another C-Bot robot (by name) and get its answer. That robot works in its own project folder with its own tools, so ask it about its project: how something works, where something is, a value you need, or to check or do something there. ",
                "Ask one clear question at a time. To ask several robots, call ask_robot for each of them in the same turn: they all work on it at the same time. ",
                "Call this again with a follow-up if its answer is not enough or it asks you something back; it remembers the conversation. ",
                "Stop once you have what you need, then answer the user yourself. Set new_conversation when you start on an unrelated question."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "robot": { "type": "string", "description": "The other robot's name, as list_robots shows it." },
                    "message": { "type": "string", "description": "What you want to ask or tell it. Include the context it needs: it cannot see your conversation." },
                    "new_conversation": { "type": "boolean", "description": "Start a fresh conversation with it instead of following up on the last one." },
                },
                "required": ["robot", "message"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "hand_off_task",
            "description": concat!(
                "Hand a piece of work to another C-Bot robot (by name) to do in its own project folder: a change to make, a feature or fix to build there, something to set up or check. ",
                "It works on it in a tab of its own chat (the user sees it as a task on both robots' desks) and this call returns its report when it is done: what it changed and what you need to know. ",
                "Use it instead of ask_robot when the other robot has to do work, not just answer. Give a short title and everything it needs in details (it cannot see your conversation): what to do, any names, shapes or values to use, and what done looks like. ",
                "To hand work to several robots, call it for each in the same turn: they work at the same time. Work that depends on another task's result goes after that task is done."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "robot": { "type": "string", "description": "The other robot's name, as list_robots shows it." },
                    "title": { "type": "string", "description": "The task in a few words, e.g. \"Add a GET /orders endpoint\". Shown on both desks." },
                    "details": { "type": "string", "description": "What to do, with the context and values it needs, and what done looks like." },
                },
                "required": ["robot", "title", "details"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "list_words",
            "description": concat!(
                "List the English words and phrases the user has saved to learn (their \"My words\" list in C-Bot), newest first, with how they sound, their meanings (Vietnamese, then English) and whether they're learnt. ",
                "Use it when the user asks what words they've saved, to review or quiz them on their words, or whether a word is in their list (pass query to search)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Only words matching this (in the word or a meaning). Leave out for all of them." },
                    "limit": { "type": "integer", "description": "At most this many (default 50, up to 300)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "save_words",
            "description": concat!(
                "Save English words or short phrases (up to 5 words each, up to 10 at a time) to the user's \"My words\" list in C-Bot, as their word hotkey does: each is looked up (meanings in Vietnamese, phrases, examples) and comes back in reviews and quizzes. ",
                "Use it when the user asks you to save, remember or add a word to their vocabulary. Save the word in its base form (\"run\", not \"ran\") unless they want the exact phrase."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "words": { "type": "array", "items": { "type": "string" }, "description": "The words or phrases to save." },
                    "context": { "type": "string", "description": "The sentence they came from, if there is one: it helps pick the right meaning." },
                },
                "required": ["words"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "list_notes",
            "description": "List the notes in the user's C-Bot notebook (shared by all their robots): the open ones, important first, with when each was noted. Set include_done to also see the ones ticked off lately. Use it when the user asks about their notes, to-dos or what they noted down.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_done": { "type": "boolean", "description": "Also list the notes ticked off lately." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "add_note",
            "description": "Add a note to the user's C-Bot notebook (it is pinned on the robots' corkboards and comes up in the daily reminders). Use it when the user asks you to note, jot down or remember something, or to add a to-do. One note per thing to remember.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The note, in the user's words where possible." },
                    "important": { "type": "boolean", "description": "Mark it important (⭐: it goes to the top of the board)." },
                },
                "required": ["text"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// What to do with one message from Claude Code.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// Answer it now.
    Reply(Value),
    /// A tools/call: ask the app, then answer (id: the JSON-RPC id).
    Call { id: Value, tool: String, args: Value },
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
    let reply = |result: Value| Step::Reply(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match method {
        "initialize" => {
            let version = params["protocolVersion"].as_str().filter(|v| !v.is_empty()).unwrap_or("2024-11-05");
            reply(json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "cbot", "version": "1.0.0" } }))
        }
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools() })),
        "tools/call" => {
            let args = params.get("arguments").filter(|a| !a.is_null()).cloned().unwrap_or(json!({}));
            Step::Call { id, tool: params["name"].as_str().unwrap_or("").to_string(), args }
        }
        _ => Step::Reply(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("No method {method}") } })),
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
    out: Mutex<std::io::Stdout>,
    open: Mutex<HashMap<String, TcpStream>>, // JSON-RPC id -> its line to the app (to hang up on)
}

impl Server {
    fn send(&self, msg: &Value) {
        let mut out = self.out.lock().unwrap_or_else(|e| e.into_inner());
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
            self.open.lock().unwrap_or_else(|e| e.into_inner()).insert(key_of(id), clone);
        }
        let request = json!({ "token": self.token, "from": self.robot, "tool": tool, "args": args });
        let answer = (|| {
            if writeln!(sock, "{request}").and_then(|_| sock.flush()).is_err() {
                return fail("C-Bot closed the line before answering.".into());
            }
            let mut line = String::new();
            match BufReader::new(&sock).read_line(&mut line) {
                Ok(n) if n > 0 && line.ends_with('\n') => serde_json::from_str(line.trim()).unwrap_or_else(|_| fail("C-Bot sent back something unreadable.".into())),
                _ => fail("C-Bot closed the line before answering.".into()),
            }
        })();
        self.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&key_of(id));
        let _ = sock.shutdown(Shutdown::Both);
        answer
    }
}

/// `c-bot.exe --robots-mcp <robot id> <port>`: serve the tools on stdin/stdout until
/// Claude Code closes stdin. Returns the exit code, or None when it's an ordinary launch.
pub fn run_if_asked() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == FLAG)?;
    let (Some(robot), Some(port)) = (args.get(at + 1), args.get(at + 2)) else {
        eprintln!("usage: c-bot --robots-mcp <robot id> <port>");
        return Some(2);
    };
    let server = Arc::new(Server {
        port: port.clone(),
        token: std::env::var("CBOT_TOKEN").unwrap_or_default(),
        robot: robot.clone(),
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
        let Ok(msg) = serde_json::from_str::<Value>(line) else { continue };
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
                if let Some(sock) = server.open.lock().unwrap_or_else(|e| e.into_inner()).remove(&key_of(&id)) {
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
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })) else { panic!() };
        assert_eq!(r["id"], 0);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "cbot");
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" })) else { panic!() };
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn it_lists_the_tools_all_read_only() {
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" })) else { panic!() };
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_robots", "ask_robot", "hand_off_task", "list_words", "save_words", "list_notes", "add_note"]);
        assert!(r["result"]["tools"].as_array().unwrap().iter().all(|t| t["annotations"]["readOnlyHint"] == true));
    }

    #[test]
    fn a_call_goes_to_the_app_and_comes_back_as_text() {
        let s = step(&json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "ask_robot", "arguments": { "robot": "Bo", "message": "hi" } } }));
        assert_eq!(s, Step::Call { id: json!(7), tool: "ask_robot".into(), args: json!({ "robot": "Bo", "message": "hi" }) });
        let r = call_result(&json!(7), &json!({ "text": "Bo says:\nhello" }));
        assert_eq!(r["result"]["content"][0]["text"], "Bo says:\nhello");
        assert_eq!(r["result"]["isError"], false);
        let r = call_result(&json!(7), &json!({ "text": "Not allowed.", "isError": true }));
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn notifications_get_no_answer_but_a_cancel_hangs_up() {
        assert_eq!(step(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), Step::Nothing);
        assert_eq!(step(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7 } })), Step::Cancel(json!(7)));
    }

    #[test]
    fn an_unknown_method_is_an_error() {
        let Step::Reply(r) = step(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" })) else { panic!() };
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["error"]["message"], "No method resources/list");
    }
}
