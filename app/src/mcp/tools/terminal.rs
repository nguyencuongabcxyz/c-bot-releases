//! The shells in the drawer of the conversation's own chat (workbench/shell.rs): reading what's
//! on screen (terminal_read), typing a command for the user to run (terminal_type), and running
//! one (terminal_run). A conversation only ever reaches its own shells.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::workbench::shell;

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    let in_turn = super::in_turn();
    let shell_arg = json!({ "type": "integer", "description": "Which shell: the number on its tab (pwsh 2 is 2, bash 3 is 3). Leave out for the one showing." });
    let kind_arg = json!({ "type": "string", "enum": ["powershell", "bash"], "description": "PowerShell or Git Bash (if it's installed). Leave out for whichever is there (a new shell: PowerShell); given, a shell of that kind is used, or a new one opened." });
    json!([
        {
            "name": "terminal_read",
            "description": concat!(
                "Read what's on screen in the user's terminal for this conversation: the shells in the drawer of your chat in C-Bot (PowerShell or Git Bash, in your project folder). ",
                "Use it when the user asks about something in their terminal (an error, a server's log, a test run's output) or to check on a command you ran there that's still going. ",
                "Returns the last lines of a shell and a list of this conversation's shells."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "shell": shell_arg,
                    "lines": { "type": "integer", "description": "How many of the last lines (default 80, up to 1000)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "terminal_type",
            "description": concat!(
                "Type a command into the user's terminal for this conversation (the shell drawer of your chat in C-Bot) WITHOUT running it: it waits at the prompt, and the user presses Enter if they want it. ",
                "Use it to hand the user a command to run themselves, especially one that changes things. One line. Opens a shell (and the drawer) if there isn't one."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The command, one line, for the kind of shell it goes to." },
                    "shell": shell_arg,
                    "shell_type": kind_arg,
                    "new_shell": { "type": "boolean", "description": "Type it into a new shell (a new tab) instead." },
                },
                "required": ["command"],
                "additionalProperties": false,
            },
            "annotations": in_turn,
        },
        {
            "name": "terminal_run",
            "description": concat!(
                "Run a command in the user's terminal for this conversation (the shell drawer of your chat in C-Bot: PowerShell or Git Bash, in your project folder) and get its output. The user sees it typed and run. ",
                "It waits until the prompt comes back or the wait runs out; a command still going then (a dev server, a watcher) keeps running there, and terminal_read checks on it later. Use new_shell for something long-running, so the other shells stay free. ",
                "Use it when the user wants something run in their terminal, or for things that should keep running where they can see them; for quick checks of your own, your usual tools are fine."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The command, for the kind of shell it goes to. Several lines run one after another." },
                    "shell": shell_arg,
                    "shell_type": kind_arg,
                    "new_shell": { "type": "boolean", "description": "Run it in a new shell (a new tab) instead." },
                    "wait": { "type": "number", "description": "Seconds to wait for it to finish (default 15, up to 300)." },
                },
                "required": ["command"],
                "additionalProperties": false,
            },
            "annotations": in_turn,
        },
    ])
}

/// tab: the conversation the call came from (its chat tab), whose shells these are.
pub fn call(app: &AppHandle, from: &str, tab: &str, tool: &str, args: &Value) -> Value {
    shell::tool(app, from, tab, tool, args)
}
