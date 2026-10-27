//! The other robots on the desktop: who's there (list_robots), asking one something (ask_robot)
//! and handing one a piece of work (hand_off_task). The asking itself, with its guards and
//! the answer waited for, is link.rs's (ask).

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::mcp::link;

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
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
    ])
}

/// list_robots, or asking one (ask_robot) or handing it work (hand_off_task): those wait for
/// its answer (link.rs ask).
pub fn call(app: &AppHandle, from: &str, tool: &str, args: &Value, conn: u64) -> Value {
    if tool != "list_robots" {
        return link::ask(app, from, args, tool == "hand_off_task", conn);
    }
    let list = link::others(app, from);
    if list.is_empty() {
        return json!({ "text": "There are no other robots on the desktop right now." });
    }
    let lines: Vec<String> = list
        .iter()
        .map(|(id, n, f)| format!("- {n}: looks after {f} ({})", link::status_of(app, id)))
        .collect();
    json!({ "text": lines.join("\n") })
}
