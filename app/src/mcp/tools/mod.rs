//! The tools a robot's Claude Code gets from C-Bot, over MCP (server.rs serves them; link.rs
//! carries each call to the app and checks who it's from). One file per kind, each with what
//! Claude Code is told about its tools (their schemas) and what calling them does:
//!   robots.rs    list_robots, ask_robot, hand_off_task: the other robots
//!   words.rs     list_words, save_words: the user's English words
//!   notes.rs     list_notes, add_note: the user's notebook
//!   routines.rs  list_routines, add_routine, remove_routine, run_routine: prompts run on a schedule
//!   terminal.rs  terminal_read, terminal_type, terminal_run: the shells in the chat's drawer
//!   screen.rs    screenshot: the screen as it is now, as a picture to look at
//!   tabs.rs      list_tabs, wait_for_tab: the robot's other conversations (and the edit guard)
//!   code.rs      code_map, code_outline, find_symbol, find_references, search_code: the
//!                context engine, for robots that have it on
//! The chat lists them all for the user (/tools: robot_tools).

pub mod code;
pub mod notes;
pub mod robots;
pub mod routines;
pub mod screen;
pub mod tabs;
pub mod terminal;
pub mod words;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::context;
use crate::runtime::Error;

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

/// What a group of tools is about (one file each).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    Robots,
    Words,
    Notes,
    Routines,
    Terminal,
    Screen,
    Tabs,
    Code,
}

/// Every group, with its tools as tools/list gives them.
fn groups() -> [(Group, Value); 8] {
    [
        (Group::Robots, robots::list()),
        (Group::Words, words::list()),
        (Group::Notes, notes::list()),
        (Group::Routines, routines::list()),
        (Group::Terminal, terminal::list()),
        (Group::Screen, screen::list()),
        (Group::Tabs, tabs::list()),
        (Group::Code, code::list()),
    ]
}

/// Every tool, as tools/list gives them (the context engine's too when `code`).
pub fn list(code: bool) -> Value {
    let all: Vec<Value> = groups()
        .into_iter()
        .filter(|(g, _)| code || *g != Group::Code)
        .flat_map(|(_, v)| v.as_array().cloned().unwrap_or_default())
        .collect();
    Value::Array(all)
}

/// A tool, as the chat lists it: its name as Claude Code calls it, what it does, and whether
/// using it asks first (the robot's permission mode decides).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    name: String,
    description: String,
    asks: bool,
}

/// A group of tools; on: this robot's conversations get them (the context engine's only while
/// it's on).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    group: Group,
    on: bool,
    tools: Vec<ToolInfo>,
}

/// Every tool C-Bot gives a robot's Claude Code, by group, as the robot `code` (its context
/// engine on or off) has them.
fn infos(code: bool) -> Vec<GroupInfo> {
    let free = allowed(true);
    groups()
        .into_iter()
        .map(|(group, list)| GroupInfo {
            group,
            on: code || group != Group::Code,
            tools: list
                .as_array()
                .map(|tools| {
                    tools
                        .iter()
                        .map(|t| {
                            let name = format!("{PREFIX}{}", t["name"].as_str().unwrap_or(""));
                            ToolInfo {
                                asks: !free.contains(&name),
                                name,
                                description: t["description"].as_str().unwrap_or("").to_string(),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

/// The tools this robot's conversations get (the chat's /tools).
#[tauri::command(async)]
pub fn robot_tools(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<GroupInfo>, Error> {
    let id = crate::robots::sender(&window)?;
    Ok(infos(context::on(&app, &id)))
}

/// The tools usable without asking (--allowedTools), as Claude Code names them: all but
/// terminal_run (running something is up to the robot's permission mode, as its own Bash is).
pub fn allowed(code: bool) -> Vec<String> {
    let names = [
        "ask_robot",
        "list_robots",
        "hand_off_task",
        "list_words",
        "save_words",
        "list_notes",
        "add_note",
        "list_routines",
        "add_routine",
        "remove_routine",
        "run_routine",
        "terminal_read",
        "terminal_type",
        "screenshot",
        "list_tabs",
        "wait_for_tab",
    ];
    let code_names: &[&str] = if code { &code::NAMES } else { &[] };
    names
        .iter()
        .chain(code_names)
        .map(|n| format!("{PREFIX}{n}"))
        .collect()
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
        "list_routines" | "add_routine" | "remove_routine" | "run_routine" => {
            routines::call(app, from, tool, args)
        }
        "terminal_read" | "terminal_type" | "terminal_run" => {
            terminal::call(app, from, tab, tool, args)
        }
        "screenshot" => screen::call(app, args),
        "list_tabs" | "wait_for_tab" | tabs::GUARD => tabs::call(app, from, tab, tool, args),
        _ if code::NAMES.contains(&tool) => code::call(app, from, tool, args),
        _ => err(format!("No tool {tool}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chats_list_goes_to_the_page_as_it_reads_it() {
        let v = serde_json::to_value(infos(false)).unwrap();
        assert_eq!(v[0]["group"], "robots");
        assert_eq!(v[0]["tools"][0]["name"], "mcp__cbot__list_robots");
        assert!(
            v[0]["tools"][0]["description"]
                .as_str()
                .is_some_and(|d| !d.is_empty())
        );
        assert_eq!(v[7]["group"], "code");
        assert_eq!(v[7]["on"], false);
        assert_eq!(serde_json::to_value(infos(true)).unwrap()[7]["on"], true);
    }

    #[test]
    fn the_chats_list_holds_every_tool_once_and_says_which_ask_first() {
        let all: Vec<ToolInfo> = infos(true).into_iter().flat_map(|g| g.tools).collect();
        assert_eq!(all.len(), list(true).as_array().unwrap().len());
        let asking: Vec<&str> = all
            .iter()
            .filter(|t| t.asks)
            .map(|t| t.name.as_str())
            .collect();
        assert_eq!(asking, ["mcp__cbot__terminal_run"]);
    }

    #[test]
    fn the_context_engines_tools_are_listed_only_when_its_on() {
        let names = |code| -> Vec<String> {
            list(code)
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert!(!names(false).iter().any(|n| n == "code_map"));
        assert!(names(true).iter().any(|n| n == "code_map"));
        assert_eq!(names(true).len(), names(false).len() + code::NAMES.len());
    }
}
