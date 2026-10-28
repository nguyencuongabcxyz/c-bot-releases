//! The user's English words (features/vocab/): listing them (list_words) and saving more
//! (save_words), looked up as the word hotkey does.

use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::features::vocab;
use crate::runtime::util::text;

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    json!([
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
    ])
}

pub fn call(app: &AppHandle, from: &str, tool: &str, args: &Value) -> Value {
    if tool == "list_words" {
        let limit = args["limit"]
            .as_u64()
            .map_or(50, |n| n.clamp(1, 300) as usize);
        return json!({ "text": vocab::list_for_chat(app, &text(&args["query"]), limit) });
    }
    let list: Vec<String> = match &args["words"] {
        Value::Array(a) => a.iter().map(text).collect(),
        Value::String(s) => vec![s.clone()], // (a single word, not in a list)
        _ => vec![],
    };
    if list.iter().all(|w| w.trim().is_empty()) {
        return err("There was no word to save.");
    }
    json!({ "text": vocab::save_for_chat(app, from, &list, text(&args["context"]).trim()) })
}
