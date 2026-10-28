//! The robot's other conversations (its other chat tabs, working in the same folder): what each
//! is up to (list_tabs), and waiting for one to finish (wait_for_tab). Also the edit guard Claude
//! Code's hook asks before a file is changed (edit_guard: not a tool it's shown, mcp/guard.rs).
//! What the tabs are doing is features/chat/tabs.rs's.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::features::chat::tabs;

/// The guard's name, as the hook asks it (it's in no tools/list).
pub const GUARD: &str = "edit_guard";

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    json!([
        {
            "name": "list_tabs",
            "description": concat!(
                "List your other conversations with the user: the other chat tabs of you, working in this same folder, maybe at the same time as you. ",
                "For each: whether it's working or idle, what it was asked, what it's doing now and the files it's changing (or, idle, what it last changed). ",
                "Use it before changing files when other tabs may be at work, or when the user asks what your other tabs are doing."
            ),
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": at_once,
        },
        {
            "name": "wait_for_tab",
            "description": concat!(
                "Wait till another of your tabs (by its title, as list_tabs shows it) has finished what it's working on, then get what it did: its answer and the files it changed. ",
                "Use it when you need a file another tab is changing, or its result, before you can go on (you're told so when that happens). ",
                "Read the files it changed again before you change them. It returns at once if that tab isn't working."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": { "type": "string", "description": "The other tab's title, as list_tabs shows it (the start of it will do)." },
                    "wait": { "type": "integer", "description": "Seconds to wait at most (default 600, up to 1800)." },
                },
                "required": ["tab"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// tab: the conversation the call came from (its chat tab).
pub fn call(app: &AppHandle, from: &str, tab: &str, tool: &str, args: &Value) -> Value {
    match tool {
        "list_tabs" => json!({ "text": tabs::list(app, from, tab) }),
        "wait_for_tab" => {
            let name = args["tab"].as_str().unwrap_or("");
            match tabs::wait(app, from, tab, name, args["wait"].as_u64()) {
                Ok(text) => json!({ "text": text }),
                Err(e) => super::err(e.to_string()),
            }
        }
        // (the hook: why not, or nothing)
        _ => {
            let file = args["file"].as_str().unwrap_or("");
            json!({ "text": tabs::guard(app, from, tab, file).unwrap_or_default() })
        }
    }
}
