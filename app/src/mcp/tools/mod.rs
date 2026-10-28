//! The tools a robot's Claude Code gets from C-Bot, over MCP (server.rs serves them; link.rs
//! carries each call to the app and checks who it's from). One file per kind, each with what
//! Claude Code is told about its tools (their schemas) and what calling them does:
//!   robots.rs    list_robots, ask_robot, hand_off_task: the other robots
//!   words.rs     list_words, save_words: the user's English words
//!   notes.rs     list_notes, add_note: the user's notebook
//!   terminal.rs  terminal_read, terminal_type, terminal_run: the shells in the chat's drawer
//!   screen.rs    screenshot: the screen as it is now, as a picture to look at

pub mod notes;
pub mod robots;
pub mod screen;
pub mod terminal;
pub mod words;

use serde_json::{Value, json};
use tauri::AppHandle;

/// As MCP names them: what Claude Code calls a tool of this server.
const PREFIX: &str = "mcp__cbot__";

/// Read-only, for Claude Code: it runs a tool's calls one after another unless the tool says
/// it's read-only, so without it asking two robots in one turn waited for the first answer
/// before even sending the second. Asking doesn't change anything here, so they can all go
/// at once (and saving words or notes is safe in parallel).
fn at_once() -> Value {
    json!({ "readOnlyHint": true })
}

/// One at a time, in order (typing in a shell).
fn in_turn() -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": false })
}

/// Every tool, as tools/list gives them.
pub fn list() -> Value {
    let all: Vec<Value> = [
        robots::list(),
        words::list(),
        notes::list(),
        terminal::list(),
        screen::list(),
    ]
    .into_iter()
    .flat_map(|v| v.as_array().cloned().unwrap_or_default())
    .collect();
    Value::Array(all)
}

/// The tools usable without asking (--allowedTools), as Claude Code names them: all but
/// terminal_run (running something is up to the robot's permission mode, as its own Bash is).
pub fn allowed() -> Vec<String> {
    let names = [
        "ask_robot",
        "list_robots",
        "hand_off_task",
        "list_words",
        "save_words",
        "list_notes",
        "add_note",
        "terminal_read",
        "terminal_type",
        "screenshot",
    ];
    names.iter().map(|n| format!("{PREFIX}{n}")).collect()
}

/// An answer that's an error.
pub fn err(text: impl Into<String>) -> Value {
    json!({ "text": text.into(), "isError": true })
}

/// A call from robot `from`'s Claude (link.rs has checked it's one of ours), in the
/// conversation of chat tab `tab`, on connection `conn`: { text, isError }.
pub fn call(app: &AppHandle, from: &str, tab: &str, tool: &str, args: &Value, conn: u64) -> Value {
    match tool {
        "list_robots" | "ask_robot" | "hand_off_task" => robots::call(app, from, tool, args, conn),
        "list_words" | "save_words" => words::call(app, from, tool, args),
        "list_notes" | "add_note" => notes::call(app, from, tool, args),
        "terminal_read" | "terminal_type" | "terminal_run" => {
            terminal::call(app, from, tab, tool, args)
        }
        "screenshot" => screen::call(app, args),
        _ => err(format!("No tool {tool}.")),
    }
}
