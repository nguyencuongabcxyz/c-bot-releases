//! The context engine's tools (context/), about the code in the robot's folder: finding your
//! way (code_map, code_outline, find_symbol, search_code), following the code graph
//! (find_references, call_chain, file_dependencies, type_hierarchy, change_impact), and what
//! git remembers of it (code_history). Only conversations of a robot with the engine on are
//! given them (server.rs `--code`).

use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::context;
use crate::runtime::util::text;

const SEARCH_DEFAULT: usize = 8;
const SEARCH_MAX: usize = 25;
const DEPTH_MAX: usize = 10;
const HISTORY_DEFAULT: usize = 10;
const HISTORY_MAX: usize = 50;

/// The names of its tools.
pub const NAMES: [&str; 10] = [
    "code_map",
    "code_outline",
    "find_symbol",
    "find_references",
    "search_code",
    "call_chain",
    "file_dependencies",
    "type_hierarchy",
    "change_impact",
    "code_history",
];

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let mut all = finding().as_array().cloned().unwrap_or_default();
    all.extend(following().as_array().cloned().unwrap_or_default());
    Value::Array(all)
}

/// The tools that find your way round the code.
fn finding() -> Value {
    let at_once = super::at_once();
    json!([
        {
            "name": "code_map",
            "description": "A map of the code in your project folder: the files, and in each the definitions the rest of the code uses most (classes, functions, types…), with their signatures and the line each starts on. Use it to find your way round a codebase before reading files, and give a focus (the files, folders or names you're working on) to see what matters around them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "focus": { "type": "array", "items": { "type": "string" }, "description": "Files, folders or symbol names you're working on: the map leans towards them and what they use." },
                    "max_chars": { "type": "integer", "minimum": 1000, "maximum": context::MAP_MAX, "description": "How long the map may be, in characters (8000 if not given)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "code_outline",
            "description": "The outline of a code file: every class, function, method, type and constant in it, nested, with its signature and the line it starts on. Given a folder, the top-level definitions of each file in it. Much cheaper than reading the file: read only the lines you need afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A file or folder, relative to your project folder (or absolute). \".\" for the whole project." },
                },
                "required": ["path"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "find_symbol",
            "description": "Where something is defined in your project: classes, functions, methods, types, constants… by name (exact, else any case, else part of the name). Each result has its kind, file and lines, and signature; set body to also see the code of the first few.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Its name, or Holder.name / Holder::name for a member (Store.open)." },
                    "kind": { "type": "string", "enum": ["function", "method", "constructor", "class", "struct", "interface", "trait", "enum", "type", "property", "const", "module", "macro", "impl"], "description": "Only this kind. \"type\" is any type, \"function\" anything callable." },
                    "body": { "type": "boolean", "description": "Also give the code of the first 3 results." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "find_references",
            "description": "Who calls or makes a function, method or type in your project: each call followed through imports, fields, typed parameters and locals and inheritance to the definition it really reaches (not just text that matches), with its line and the function it's in; with depth, the callers' callers too. Then the other places the name appears that aren't calls of it. Use it before changing or renaming something.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "What's called: a name, Holder.name (Store.open), or a full name from find_symbol." },
                    "path": { "type": "string", "description": "Only callers in this file or folder." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": DEPTH_MAX, "description": "How many calls away (1 if not given: direct callers)." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "search_code",
            "description": "Find code (with the project's XML/XAML, Razor views, YAML and Dockerfiles, and its Markdown and text docs) when you don't know the names: by what it does, in plain words (English or Vietnamese: \"retry the upload when it fails\"), or by words and names (\"refresh token expiry\"). Ranked results, best first, each with its file and lines, what it's in (Class › method, or a doc's section) and the lines with the words. Names are matched in their parts too (getUserById matches user).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words, names or both." },
                    "path": { "type": "string", "description": "Only in this file or folder." },
                    "kind": { "type": "string", "enum": ["code", "docs", "all"], "description": "Only code, only docs, or both (the default)." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": SEARCH_MAX, "description": "How many results (8 if not given)." },
                },
                "required": ["query"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// The tools that follow the code graph.
fn following() -> Value {
    let at_once = super::at_once();
    json!([
        {
            "name": "call_chain",
            "description": "The shortest chain of calls in your project from one function or method to another (how does A end up calling B?), each step with the line it's called on.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "Where the chain starts: a name, Holder.name or a full name." },
                    "to": { "type": "string", "description": "Where it ends." },
                    "max_depth": { "type": "integer", "minimum": 1, "maximum": 20, "description": "The most calls in the chain (10 if not given)." },
                },
                "required": ["from", "to"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "file_dependencies",
            "description": "What a file of your project imports and what imports it, with how many steps away (imports resolved through relative paths, tsconfig paths, Rust modules, Python packages, Go's module, C# namespaces). With no path: the outside packages the project imports, most used first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A code file (relative to the project folder). Leave out for the outside packages." },
                    "direction": { "type": "string", "enum": ["imports", "dependents", "both"], "description": "What it imports, what imports it, or both (the default)." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": DEPTH_MAX, "description": "How many steps away (1 if not given)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "type_hierarchy",
            "description": "A class, interface, struct or trait's supertypes and subtypes in your project (extends, implements), all the way; for a method, the methods that override it and that it overrides.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "A type or a method: a name, Holder.name or a full name." },
                    "direction": { "type": "string", "enum": ["up", "down", "both"], "description": "Supertypes, subtypes or both (the default)." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "change_impact",
            "description": "What changing a function, method, type or file would touch in your project, before you change it: its callers (to a depth), overriding methods, subtypes and supertypes; for a file, the files importing it and the callers of what it defines. With a level: low, medium or high.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "A symbol (name, Holder.name, full name) or a file path." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": DEPTH_MAX, "description": "How many calls or imports away (2 if not given)." },
                },
                "required": ["target"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "code_history",
            "description": "What git remembers of the code: the latest commits that changed a file or folder (or the whole project), newest first, each with its date, author, message and the files it changed; or, given a symbol, who last changed its lines, commit by commit. Use it to see why code is the way it is, or what changed lately.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "A file or folder (the whole project if not given)." },
                    "symbol": { "type": "string", "description": "A function, method or type (a name, or Holder.name): who last changed its lines, instead of a file's commits." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": HISTORY_MAX, "description": "How many commits (10 if not given)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// A number argument, kept within its bounds.
fn number(v: &Value, default: usize, min: usize, max: usize) -> usize {
    v.as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default)
        .clamp(min, max)
}

pub fn call(app: &AppHandle, from: &str, tool: &str, args: &Value) -> Value {
    let answer = match tool {
        "code_map" => {
            let focus: Vec<String> = args["focus"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let budget = number(
                &args["max_chars"],
                context::MAP_DEFAULT,
                1000,
                context::MAP_MAX,
            );
            context::code_map(app, from, &focus, budget)
        }
        "code_outline" => context::outline(app, from, &text(&args["path"])),
        "find_symbol" => context::find_symbol(
            app,
            from,
            &text(&args["name"]),
            &text(&args["kind"]),
            args["body"].as_bool() == Some(true),
        ),
        "find_references" => context::find_references(
            app,
            from,
            &text(&args["name"]),
            &text(&args["path"]),
            number(&args["depth"], 1, 1, DEPTH_MAX),
        ),
        "call_chain" => context::call_chain(
            app,
            from,
            &text(&args["from"]),
            &text(&args["to"]),
            number(&args["max_depth"], 10, 1, 20),
        ),
        "file_dependencies" => {
            let direction = args["direction"].as_str().unwrap_or("both");
            let depth = number(&args["depth"], 1, 1, DEPTH_MAX);
            context::file_dependencies(app, from, &text(&args["path"]), direction, depth)
        }
        "type_hierarchy" => {
            let direction = args["direction"].as_str().unwrap_or("both");
            context::type_hierarchy(app, from, &text(&args["name"]), direction)
        }
        "change_impact" => {
            let depth = number(&args["depth"], 2, 1, DEPTH_MAX);
            context::change_impact(app, from, &text(&args["target"]), depth)
        }
        "code_history" => context::code_history(
            app,
            from,
            &text(&args["path"]),
            &text(&args["symbol"]),
            number(&args["limit"], HISTORY_DEFAULT, 1, HISTORY_MAX),
        ),
        _ => {
            let limit = number(&args["limit"], SEARCH_DEFAULT, 1, SEARCH_MAX);
            context::search_code(
                app,
                from,
                &text(&args["query"]),
                &text(&args["path"]),
                &text(&args["kind"]),
                limit,
            )
        }
    };
    match answer {
        Ok(text) => json!({ "text": text }),
        Err(e) => err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_tools_are_listed_by_their_names_and_read_only() {
        let tools = list();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, NAMES);
        assert!(
            tools
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["annotations"]["readOnlyHint"] == true)
        );
    }

    #[test]
    fn numbers_stay_in_bounds() {
        assert_eq!(number(&json!(null), 8, 1, 25), 8);
        assert_eq!(number(&json!(100), 8, 1, 25), 25);
        assert_eq!(number(&json!(0), 8, 1, 25), 1);
        assert_eq!(number(&json!("3"), 8, 1, 25), 8);
    }
}
