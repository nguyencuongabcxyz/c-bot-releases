//! The context optimizer's tools (context/), about the code in the robot's folder: finding your
//! way (code_map, code_outline, find_symbol, explain_symbol, search_code, and library_api for
//! the packages it uses), following the code graph (find_references, call_chain,
//! file_dependencies, type_hierarchy, type_members, find_type_usages, change_impact,
//! affected_tests), what the project's compiler says (diagnostics), and what
//! git remembers of it (code_history). Only conversations of a robot with the optimizer on are
//! given them (server.rs `--code`).

use std::time::Instant;

use serde_json::{Value, json};
use tauri::AppHandle;

use super::err;
use crate::context;
use crate::runtime::Error;
use crate::runtime::util::text;

const SEARCH_DEFAULT: usize = 8;
const SEARCH_MAX: usize = 25;
const DEPTH_MAX: usize = 10;
const HISTORY_DEFAULT: usize = 10;
const HISTORY_MAX: usize = 50;

/// The names of its tools.
pub const NAMES: [&str; 16] = [
    "code_map",
    "code_outline",
    "find_symbol",
    "explain_symbol",
    "find_references",
    "search_code",
    "library_api",
    "call_chain",
    "file_dependencies",
    "type_hierarchy",
    "type_members",
    "find_type_usages",
    "change_impact",
    "affected_tests",
    "diagnostics",
    "code_history",
];

/// Its tools, as tools/list gives them.
pub fn list() -> Value {
    let mut all = finding().as_array().cloned().unwrap_or_default();
    all.extend(following().as_array().cloned().unwrap_or_default());
    Value::Array(all)
}

/// A list of strings argument (what isn't a string left out).
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The tools that find your way round the code.
#[expect(
    clippy::too_many_lines,
    reason = "a flat table of the tools' JSON schemas"
)]
fn finding() -> Value {
    let at_once = super::at_once();
    json!([
        {
            "name": "code_map",
            "description": "A map of your project's code: its files, and the definitions the rest of the code uses most, with signatures and lines. Use it to find your way round before reading files; give a focus (files, folders, names) to see what's around them.",
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
            "description": "A code file's outline: every class, function, method, type and constant, nested, with signature and line (a folder: each file's top level). Much cheaper than reading the file.",
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
            "description": "Where something is defined: classes, functions, methods, types, constants, by name (exact, else any case, else part of it), with kind, file, lines and signature; body: the code of the first few too.",
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
            "name": "explain_symbol",
            "description": "One function, method or type with everything around it, instead of several lookups: its code (a type's head, members and lineage), what it calls with their signatures, what calls it, the types it takes and returns, the tests that reach it, who changed it last. Use it before changing or calling something.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Its name, Holder.name (Store.open), or a full name from find_symbol." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "find_references",
            "description": "Who calls or makes a function, method or type: each call followed through imports, fields, typed locals and inheritance to what it really reaches, with its line and the function it's in (depth: the callers' callers too). Then where it's used without a call (a constant read, a callback handed on) and the other places its name appears. Use it before changing or renaming something.",
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
            "description": "Find code or docs (config files, Markdown, Word too) when you don't know the names: by what it does in plain words (\"retry the upload when it fails\"), or by words and names. Ask in English, in the code's words, even when the user writes in another language. Ranked results with file, lines, what they're in (Class › method, a doc's section) and the lines with the words; names match by their parts (getUserById matches user).",
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
        {
            "name": "library_api",
            "description": "A library's API as the project has it installed (npm and @types, Cargo's registry at Cargo.lock's version, a .venv, Go's module cache, NuGet's docs), not as remembered: a name's signature, doc comment and members, or the package's top level. Use it before calling an API you're not sure of.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The function, type or method: useQuery, serde_json::from_str, JsonConvert.SerializeObject. Leave out for the package's top level." },
                    "package": { "type": "string", "description": "The package: @tanstack/react-query, serde_json, requests, github.com/spf13/cobra, Newtonsoft.Json. Leave out to use the one the project imports the name from." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
    ])
}

/// The tools that follow the code graph.
#[expect(
    clippy::too_many_lines,
    reason = "a flat table of the tools' JSON schemas"
)]
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
            "description": "What a file imports and what imports it, with how many steps away (relative paths, tsconfig paths, Rust modules, Python packages, Go modules, C# namespaces). No path: the outside packages the project imports, most used first.",
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
            "name": "type_members",
            "description": "A type's members (all its parts': a C# partial class, a Rust type's impls), with kind, lines and signature; inherited: its supertypes' too, but for those it overrides.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The type: a name, or a full name from find_symbol." },
                    "inherited": { "type": "boolean", "description": "Also the members it gets from its supertypes." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "find_type_usages",
            "description": "Where a type is used as one: a parameter's type, what a function returns, a field's or property's type, elsewhere (a local, a cast), each with its line and what it's in; then where it's made and what extends it. Use it before changing a type's shape.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The type: a name, or a full name from find_symbol." },
                    "path": { "type": "string", "description": "Only uses in this file or folder." },
                },
                "required": ["name"],
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "change_impact",
            "description": "What changing a function, method, constant, type or file would touch, before you change it: callers (to a depth), uses without a call, overrides, subtypes and supertypes, what declares something of a type; for a file, its importers and the callers of what it defines. With a level: low, medium or high.",
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
            "name": "affected_tests",
            "description": "The tests that reach what you changed, so you run only those: what isn't committed (new files too), what changed since a branch or commit, or the symbols and files you name. Each with what it reaches, then the commands that run just them (cargo test, vitest, jest, pytest, go test, dotnet test). Use it after a change, before the whole suite.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "symbols": { "type": "array", "items": { "type": "string" }, "description": "Functions, methods or types (names, Holder.name or full names) instead of what changed." },
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Code files: everything they define." },
                    "since": { "type": "string", "description": "A branch or commit: what changed since it, instead of what isn't committed yet." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": DEPTH_MAX, "description": "How many calls away a test may reach them from (5 if not given)." },
                },
                "additionalProperties": false,
            },
            "annotations": at_once,
        },
        {
            "name": "diagnostics",
            "description": "What the project's own compiler says about the code now, in short: each error with file, line, column and code (cargo check, tsc, dotnet build, go vet), for the projects the uncommitted changes (or the paths you give) are in, errors in the changed files first. Use it after editing, instead of reading a whole build's output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Files or folders to check the projects of, instead of what changed." },
                    "warnings": { "type": "boolean", "description": "Also list warnings (else only counted)." },
                },
                "additionalProperties": false,
            },
            // (it runs the build: one at a time)
            "annotations": super::in_turn(),
        },
        {
            "name": "code_history",
            "description": "What git remembers: the latest commits to a file, a folder or the project (date, author, message, files), or who last changed a symbol's lines. Use it to see why code is as it is, or what changed lately.",
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
    let started = Instant::now();
    let said = answer(app, from, tool, args).map_err(|e| e.to_string());
    // (counted for the Context optimizer window's Tools: which are used, and what they cost)
    let length = said.as_ref().map_or_else(String::len, String::len);
    context::record_use(app, tool, started.elapsed(), length, said.is_ok());
    match said {
        Ok(text) => json!({ "text": text }),
        Err(e) => err(e),
    }
}

/// What a tool answers.
fn answer(app: &AppHandle, from: &str, tool: &str, args: &Value) -> Result<String, Error> {
    match tool {
        "code_map" => {
            let focus = strings(&args["focus"]);
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
        "explain_symbol" => context::explain_symbol(app, from, &text(&args["name"])),
        "library_api" => {
            context::library_api(app, from, &text(&args["package"]), &text(&args["name"]))
        }
        "affected_tests" => context::affected_tests(
            app,
            from,
            &strings(&args["symbols"]),
            &strings(&args["paths"]),
            &text(&args["since"]),
            number(&args["depth"], 5, 1, DEPTH_MAX),
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
        "type_members" => context::type_members(
            app,
            from,
            &text(&args["name"]),
            args["inherited"].as_bool() == Some(true),
        ),
        "diagnostics" => context::diagnostics(
            app,
            from,
            &strings(&args["paths"]),
            args["warnings"].as_bool() == Some(true),
        ),
        "find_type_usages" => {
            context::find_type_usages(app, from, &text(&args["name"]), &text(&args["path"]))
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
        // (but diagnostics, which runs the project's build)
        let read_only: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["annotations"]["readOnlyHint"] == true)
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let others: Vec<&str> = NAMES.into_iter().filter(|n| *n != "diagnostics").collect();
        assert_eq!(read_only, others);
    }

    #[test]
    fn numbers_stay_in_bounds() {
        assert_eq!(number(&json!(null), 8, 1, 25), 8);
        assert_eq!(number(&json!(100), 8, 1, 25), 25);
        assert_eq!(number(&json!(0), 8, 1, 25), 1);
        assert_eq!(number(&json!("3"), 8, 1, 25), 8);
    }
}
