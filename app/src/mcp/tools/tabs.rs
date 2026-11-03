//! The robot's other conversations (its other chat tabs, working in the same folder): what each
//! is up to (list_tabs), waiting for one to finish (wait_for_tab), and talking to them: asking
//! one and waiting for the answer (ask_tab), telling one something (tell_tab), opening a new one
//! for a job (open_tab). Also the edit guard Claude Code's hook asks before a file is changed
//! (edit_guard: not a tool it's shown, mcp/guard.rs). What the tabs are doing is
//! features/chat/tabs.rs's; their talking, features/chat/peers.rs's.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::features::chat::{peers, tabs};
use crate::runtime::Error;

/// The guard's name, as the hook asks it (it's in no tools/list).
pub const GUARD: &str = "edit_guard";

/// Its tools' names.
pub const NAMES: [&str; 5] = [
    "list_tabs",
    "wait_for_tab",
    "ask_tab",
    "tell_tab",
    "open_tab",
];

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    let tab = json!({ "type": "string", "description": "The other tab's title, as mcp__cbot__list_tabs shows it (the start of it will do)." });
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
                "Wait till another of your tabs (by its title, as mcp__cbot__list_tabs shows it) has finished what it's working on, then get what it did: its answer and the files it changed. ",
                "Use it when you need a file another tab is changing, or its result (a tab you opened with mcp__cbot__open_tab: its report), before you can go on. ",
                "Read the files it changed again before you change them. It returns at once if that tab isn't working."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": tab,
                    "wait": { "type": "integer", "description": "Seconds to wait at most (default 600, up to 1800)." },
                },
                "required": ["tab"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "ask_tab",
            "description": concat!(
                "Ask another of your tabs something and wait for its answer: it reads your message as a question of its own (shown to the user as from you), answers it with what it knows of its own conversation, and its answer comes back here. ",
                "Use it when another tab knows something you need (what it decided, found or changed) or should check something. Include the context it needs: it can't see your conversation. ",
                "A busy tab answers once it's done with what it's on. To ask several tabs, call it for each in the same turn."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": tab,
                    "message": { "type": "string", "description": "What you want to ask it, with the context it needs." },
                },
                "required": ["tab", "message"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "tell_tab",
            "description": concat!(
                "Tell another of your tabs something without waiting for an answer: it reads your message as a question of its own (shown to the user as from you) and takes it into account. ",
                "Use it to pass on something it should know (a decision, a name, a change that affects its work) or more instructions for a job you gave it."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab": tab,
                    "message": { "type": "string", "description": "What you want to tell it, with the context it needs." },
                },
                "required": ["tab", "message"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "open_tab",
            "description": concat!(
                "Open a new tab of yours (a conversation of its own in this same folder) and give it a job; it starts on it straight away and you carry on. ",
                "It's grouped with this tab in the tab strip. Get its report with mcp__cbot__wait_for_tab when you need it; talk to it meanwhile with mcp__cbot__ask_tab or mcp__cbot__tell_tab. ",
                "Use it when the user asks you to split work across tabs, or for a separate piece of work that can go on beside yours. To start several, call it for each in the same turn. ",
                "Give each tab its own files to change, so they don't get in each other's way."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "The new tab's title, a few words, e.g. \"Migrate DB\"." },
                    "task": { "type": "string", "description": "The job, with everything it needs (it can't see your conversation): what to do, the files it's to change, names or values to use, and what done looks like." },
                },
                "required": ["title", "task"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// tab: the conversation the call came from (its chat tab).
pub fn call(app: &AppHandle, from: &str, tab: &str, tool: &str, args: &Value) -> Value {
    let arg = |k: &str| args[k].as_str().unwrap_or("");
    let answer = |r: Result<String, Error>| match r {
        Ok(text) => json!({ "text": text }),
        Err(e) => super::err(e.to_string()),
    };
    match tool {
        "list_tabs" => json!({ "text": tabs::list(app, from, tab) }),
        "wait_for_tab" => answer(tabs::wait(
            app,
            from,
            tab,
            arg("tab"),
            args["wait"].as_u64(),
        )),
        "ask_tab" => answer(peers::ask_tab(app, from, tab, arg("tab"), arg("message"))),
        "tell_tab" => answer(peers::tell_tab(app, from, tab, arg("tab"), arg("message"))),
        "open_tab" => answer(peers::open_tab(app, from, tab, arg("title"), arg("task"))),
        // (the hook: why not, or nothing)
        _ => json!({ "text": tabs::guard(app, from, tab, arg("file")).unwrap_or_default() }),
    }
}
