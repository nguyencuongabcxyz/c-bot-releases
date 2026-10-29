//! The user's routines (features/routines/): prompts a robot runs on a schedule. Listing
//! them (list_routines), adding one (add_routine), deleting one (remove_routine), and
//! running one now (run_routine).

use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::features::routines;
use crate::runtime::util::text;

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let at_once = super::at_once();
    json!([
        {
            "name": "list_routines",
            "description": "List the user's C-Bot routines: prompts a robot runs on a schedule (when, which robot, the prompt, the next and last run). Use it when the user asks about their routines or scheduled tasks.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": at_once,
        },
        {
            "name": "add_routine",
            "description": "Add a routine: a prompt a C-Bot robot runs on a schedule, in a chat tab of its own, showing the user the result (\"every weekday at 8, bring me the news on AI chips\"). Give times (with days), or every_hours (with between), or once_at. Write the prompt as a full, standalone instruction for that future run (what to look up or do, and how to present it): it's all the robot will have then.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "A short name, like \"Morning news\"." },
                    "emoji": { "type": "string", "description": "One emoji for it, like 📰." },
                    "prompt": { "type": "string", "description": "What the robot does on each run, as a standalone instruction." },
                    "times": { "type": "array", "items": { "type": "string" }, "description": "Times of day, 24-hour HH:MM, like [\"08:00\", \"17:30\"]." },
                    "days": { "type": "array", "items": { "type": "string" }, "description": "Days it runs: mon … sun, weekdays, weekends. Leave out for every day." },
                    "every_hours": { "type": "integer", "minimum": 1, "maximum": 24, "description": "Instead of times: every this many hours…" },
                    "between": { "type": "array", "items": { "type": "string" }, "description": "…between these two times, like [\"09:00\", \"18:00\"]." },
                    "once_at": { "type": "string", "description": "Instead: just once, at this local date and time, like \"2026-10-30 14:00\"." },
                    "show": { "type": "string", "enum": ["card", "pop", "toast"], "description": "How the result is shown: card (a window beside the robot, the default), pop (the robot says its first line), toast (a Windows notification)." },
                    "robot": { "type": "string", "description": "Another robot to run it, by name. Leave out for yourself." },
                    "catch_up": { "type": "boolean", "description": "If the PC was asleep at the time, run it when the user is back that day (default true)." },
                    "time_limit_minutes": { "type": "integer", "minimum": 1, "maximum": 60, "description": "Stop a run that takes longer (default 10)." },
                },
                "required": ["name", "prompt"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "remove_routine",
            "description": "Delete one of the user's C-Bot routines, by name.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string", "description": "The routine's name." } },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "run_routine",
            "description": "Run one of the user's C-Bot routines now, by name (to try it out). It runs in a tab of its own and the user sees the result when it's done: don't wait for it.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string", "description": "The routine's name." } },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

pub fn call(app: &AppHandle, from: &str, tool: &str, args: &Value) -> Value {
    let said = match tool {
        "list_routines" => Ok(routines::list_for_chat(app)),
        "add_routine" => routines::add_for_chat(app, from, args),
        "remove_routine" => routines::remove_for_chat(app, &text(&args["name"])),
        _ => routines::run_for_chat(app, &text(&args["name"])),
    };
    match said {
        Ok(text) => json!({ "text": text }),
        Err(e) => err(e.to_string()),
    }
}
