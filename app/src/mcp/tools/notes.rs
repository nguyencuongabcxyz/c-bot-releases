//! The user's notebook (features/notes/): listing the notes (list_notes) and adding one
//! (add_note), pinned on the robots' corkboards.

use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::features::notes;
use crate::runtime::util::text;

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    json!([
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

pub fn call(app: &AppHandle, from: &str, tool: &str, args: &Value) -> Value {
    if tool == "list_notes" {
        return json!({ "text": notes::list_for_chat(app, args["include_done"].as_bool() == Some(true)) });
    }
    match notes::add_for_chat(
        app,
        from,
        &text(&args["text"]),
        args["important"].as_bool() == Some(true),
    ) {
        Ok(said) => json!({ "text": said }),
        Err(e) => err(e),
    }
}
