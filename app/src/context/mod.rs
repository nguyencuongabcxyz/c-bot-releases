//! The context engine: the code and documents in a robot's folder (the languages and files in
//! langs.rs; Markdown, text) read, kept up to date, and asked about by the robot's
//! Claude Code (mcp/tools/code.rs), which also starts each conversation with a map of the code.
//! The user switches it on robot by robot, from the chat (the robot's `contextEngine`); it's
//! off until then. Robots sharing a folder share its index.
//!
//! What it knows lives in its own PostgreSQL (the store: install/, store/), downloaded the
//! first time a robot switches it on; what search and the tools read is derived from the store
//! and follows its generation (the keyword index, keyword.rs; the code in memory, code.rs). A
//! folder is watched once it's been read, and the files saved are read again as they change
//! (watch.rs, look.rs); a folder that isn't watched is looked at again before it's asked about
//! (at most every FRESH). Meanwhile a worker gives each chunk its vector for search by meaning
//! (embed/, vectors.rs). The chat shows how all that goes (robot:context), and its details
//! (details.rs).
//!
//!   install/    PostgreSQL and the models, downloaded once
//!   store/      what the store keeps, and commits fenced by generation
//!   ingest/     which files, what changed, reading one into chunks and facts
//!   look.rs     bringing a folder up to date, batch by batch
//!   watch.rs    a folder's files watched as they're saved
//!   keyword.rs  the keyword index (Tantivy, BM25)
//!   embed/      the sentence model and the worker giving chunks their vectors; the reranker
//!   vectors.rs  a folder's vectors, in an HNSW index (usearch)
//!   code.rs     each file's definitions, the names it uses and its links, in memory
//!   langs.rs    the languages: grammars, what's a definition, what's a name
//!   parse/      reading one file through its syntax tree (tree-sitter)
//!   graph/      the code graph: calls, imports and heritage resolved across the folder
//!   search.rs   search_code's lanes (symbol, keyword, meaning), their fusion, the reranking
//!   map.rs      the repo map: the definitions the rest of the code uses most (PageRank)
//!   history.rs  what git remembers of the folder (code_history)
//!   asked.rs    what the code tools ask, and the note each conversation starts with
//!   answers/    what each tool answers
//!   details.rs  everything about the engine, for the chat's panel and its window
//!   browse.rs   what's in a folder's index, file by file, for the window
//!   window.rs   the Context engine window
//!   wipe.rs     deleting what it keeps, when the user asks

mod answers;
mod asked;
mod browse;
mod code;
mod details;
mod embed;
mod graph;
mod history;
mod ingest;
mod install;
mod keyword;
mod langs;
mod look;
mod map;
mod parse;
mod search;
mod store;
mod vectors;
mod watch;
mod window;
mod wipe;

pub use asked::*;
pub use browse::*;
pub use details::*;
pub use history::*;
pub use window::*;
pub use wipe::*;

use code::{Code, File};
use embed::Embedder;
use graph::Graph;
use ingest::{Found, Read, Stored};
use install::{Database, Setup};
use keyword::{Change, Doc, Keyword};
use langs::{Config, FileType, Kind, Lang};
use look::Gate;
use parse::{Def, Facts};
use search::{Filter, Ranked, Within};
use store::{Commit, FileRow, ScopeId, Since, Store, StoredChunk, StoredFacts};
use vectors::Vectors;
use watch::Watch;

use std::cell::RefCell;
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tree_sitter::{Node, Parser, Tree};

use crate::features::chat;
use crate::robots;
use crate::runtime::{Error, Locked, hub, part_or_default, paths, util, with};
use crate::store::Fields;
use crate::ui::views;

/// A folder looked at this recently isn't looked at again yet.
const FRESH: Duration = Duration::from_secs(3);
/// How often the chat hears how a reading is going.
const PROGRESS_EVERY: Duration = Duration::from_millis(300);
/// The map at the start of a conversation, in characters (about a thousand tokens).
const PROMPT_MAP: usize = 4_500;
pub const MAP_DEFAULT: usize = 8_000;
pub const MAP_MAX: usize = 40_000;

/// What every conversation of a robot with the engine on is told about it.
const NOTE: &str = concat!(
    "C-Bot's context engine has indexed the code in this folder (TypeScript/JavaScript, C#, Java, C/C++, Go, Python with Jupyter notebooks, Rust, Dart/Flutter, Zig, PHP, Ruby, shell, PowerShell; Kotlin, Swift, Prisma, Protocol Buffers and Terraform for their definitions only; its XML/XAML, Razor views, YAML, Dockerfiles, JSON, TOML, SQL, HTML, Vue, Svelte, CSS, INI, .properties and .conf; its Markdown, text and Word documents) and keeps it up to date. ",
    "Use its tools before grepping or reading whole files: code_map for the files and definitions that matter most (focus it on what you're working on), ",
    "code_outline for the signatures in a file or folder with their lines, find_symbol for where something is defined (body: true to see its code), ",
    "and search_code to find code or docs by words or meaning when you don't know the names (ask it in English, in the code's words, whatever language the user writes in). Then Read only the lines you need. ",
    "It also knows who calls what (not yet in the languages read for their definitions only), through imports, fields and types: find_references for a function's or type's callers, call_chain for how one reaches another, ",
    "file_dependencies for what a file imports and what imports it, type_hierarchy for supertypes, subtypes and overrides, and change_impact before changing something."
);

/// Where a folder's index is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Off,
    Installing,
    Indexing,
    Ready,
    Failed,
}

/// How a robot's index is, as its chat shows it (robot:context, robot_context).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub files: usize,
    pub chunks: usize,
    pub embedded: usize, // (chunks with their vector, for search by meaning)
    pub symbols: usize,
    pub calls: usize,         // (the code graph's, once it's built: who calls what)
    pub graph: bool,          // (the code graph is built for the code as it is now)
    pub done: usize,          // (while indexing: files readâ€¦)
    pub total: usize,         // (â€¦of these)
    pub capped: bool,         // (more files than it reads)
    pub note: Option<String>, // (what it's doing, while installing)
    pub error: Option<String>,
}

/// One folder: its id in the store, what's derived from it, and who's looking at it.
struct Folder {
    key: String,
    root: PathBuf,
    scope: ScopeId,
    status: Mutex<Status>,
    gate: Mutex<Gate>,
    turn: Condvar, // (a look finished: the next may go)
    code: Mutex<Code>,
    keyword: Mutex<Option<Arc<Keyword>>>, // (opened on the first look)
    vectors: Mutex<Vectors>,              // (loaded when search by meaning first needs them)
    graph: Mutex<Option<Arc<Graph>>>,     // (built when first asked, at the code's generation)
    watch: Mutex<Watch>,                  // (from its first look)
    embedded_at: Mutex<Option<i64>>,      // (the generation its vectors were last all made at)
}

#[derive(Default)]
struct Engine {
    dir: PathBuf, // (its database, model and indexes: <app local data>/context)
    setup: Arc<Setup>,
    embedder: Arc<Embedder>,
    folders: HashMap<String, Arc<Folder>>, // folder key -> its folder
}

fn engine<R>(app: &AppHandle, f: impl FnOnce(&mut Engine) -> R) -> R {
    part_or_default(app, f)
}

/// Wait for something the database or the download does, on the app's async runtime. A
/// thread of that runtime itself (an async command's, such as a question starting a chat)
/// can't wait on it: then another thread waits.
fn block<F>(f: F) -> F::Output
where
    F: Future + Send,
    F::Output: Send,
{
    if tokio::runtime::Handle::try_current().is_err() {
        return tauri::async_runtime::block_on(f);
    }
    thread::scope(|s| {
        s.spawn(|| tauri::async_runtime::block_on(f))
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

/// The same folder however it's written.
fn key(folder: &str) -> String {
    folder
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

// ---------------------------------------------------------------- whose folder

/// The robot has the engine on (and a folder to read).
pub fn on(app: &AppHandle, id: &str) -> bool {
    with(app, |st| {
        st.store
            .get(id)
            .is_some_and(|c| c.context_engine() && !c.folder().is_empty())
    })
}

/// A robot's folder (made the first time it's asked for).
fn folder_for(app: &AppHandle, id: &str) -> Result<Arc<Folder>, Error> {
    let Some((on, folder)) = with(app, |st| {
        st.store
            .get(id)
            .map(|c| (c.context_engine(), c.folder().to_string()))
    }) else {
        return Err("That robot isn't there any more.".into());
    };
    if !on {
        return Err("The context engine is off for this robot. The user can switch it on in the chat, from the bar under it.".into());
    }
    if folder.is_empty() || !Path::new(&folder).is_dir() {
        return Err(format!("This robot's folder ({folder}) isn't there.").into());
    }
    let k = key(&folder);
    Ok(engine(app, |e| {
        e.folders
            .entry(k.clone())
            .or_insert_with(|| {
                Arc::new(Folder {
                    scope: store::scope_id(&k),
                    key: k,
                    root: PathBuf::from(folder),
                    status: Mutex::new(Status {
                        phase: Phase::Indexing,
                        ..Status::default()
                    }),
                    gate: Mutex::new(Gate::default()),
                    turn: Condvar::new(),
                    code: Mutex::new(Code::default()),
                    keyword: Mutex::new(None),
                    vectors: Mutex::new(Vectors::default()),
                    graph: Mutex::new(None),
                    watch: Mutex::new(Watch::default()),
                    embedded_at: Mutex::new(None),
                })
            })
            .clone()
    }))
}

/// The folders no robot with the engine on looks after any more are let go.
fn forget_unused(app: &AppHandle) {
    let used: HashSet<String> = with(app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c.context_engine())
            .map(|c| key(c.folder()))
            .collect()
    });
    engine(app, |e| e.folders.retain(|k, _| used.contains(k)));
}

/// The folder is still the one the engine keeps for its robots (not let go since: switched off,
/// or its index deleted, maybe made anew).
fn still_on(app: &AppHandle, f: &Folder) -> bool {
    engine(app, |e| {
        e.folders
            .get(&f.key)
            .is_some_and(|g| std::ptr::eq(Arc::as_ptr(g), f))
    })
}

/// The robots whose chats show this folder's index.
fn robots_on(app: &AppHandle, folder_key: &str) -> Vec<String> {
    with(app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c.context_engine() && key(c.folder()) == folder_key)
            .map(|c| c.id().to_string())
            .collect()
    })
}

fn set_status(app: &AppHandle, f: &Folder, status: Status) {
    *f.status.locked() = status.clone();
    tell_status(app, f, &status);
}

/// A part of the status changed (how many chunks have vectors, a note), the rest as it was.
fn change_status(app: &AppHandle, f: &Folder, edit: impl FnOnce(&mut Status)) {
    let status = {
        let mut s = f.status.locked();
        edit(&mut s);
        s.clone()
    };
    tell_status(app, f, &status);
}

fn tell_status(app: &AppHandle, f: &Folder, status: &Status) {
    for id in robots_on(app, &f.key) {
        hub::send_to_robot(app, &id, "robot:context", json!(status));
    }
    window::tell(app, &f.root, status);
}

/// A folder in memory (a robot with the engine on reads it), by its root however it's written.
fn folder_at(app: &AppHandle, root: &str) -> Option<Arc<Folder>> {
    engine(app, |e| e.folders.get(&key(root)).cloned())
}

/// Read a robot's folder in the background (the engine just came on, or the app started).
fn start(app: &AppHandle, id: &str, again: bool) {
    match folder_for(app, id) {
        Ok(f) => {
            let app = app.clone();
            thread::spawn(move || look::look(&app, &f, again));
        }
        Err(e) => log::warn!("context engine for {id}: {e}"),
    }
}

/// A robot's folder, up to date, to answer from (looked at first, unless its watch keeps it so).
fn fresh(app: &AppHandle, id: &str) -> Result<Arc<Folder>, Error> {
    let f = folder_for(app, id)?;
    if !look::trusted(&f) {
        look::look(app, &f, false);
    }
    let status = f.status.locked().clone();
    match status.phase {
        Phase::Failed => Err(status
            .error
            .unwrap_or_else(|| "The index couldn't be made.".into())
            .into()),
        _ => Ok(f),
    }
}

// ---------------------------------------------------------------- what the chat asks

/// How the robot's index is.
fn status_of(app: &AppHandle, id: &str) -> Status {
    if !on(app, id) {
        return Status::default();
    }
    match folder_for(app, id) {
        Ok(f) => f.status.locked().clone(),
        Err(e) => Status {
            phase: Phase::Failed,
            error: Some(e.to_string()),
            ..Status::default()
        },
    }
}

/// How the robot's index is (the chat's bar shows it).
#[tauri::command(async)]
pub fn robot_context(app: AppHandle, window: tauri::WebviewWindow) -> Result<Status, Error> {
    let id = robots::sender(&window)?;
    Ok(status_of(&app, &id))
}

/// The user switches the engine on or off for this robot. Its conversations that aren't
/// working pick up (or drop) the tools on their next question.
#[tauri::command(async)]
pub fn robot_context_set(
    app: AppHandle,
    window: tauri::WebviewWindow,
    on: bool,
) -> Result<Status, Error> {
    let id = robots::sender(&window)?;
    crate::features::share::not_visiting(&app, &id)?;
    with(&app, |st| {
        st.store
            .update(&id, util::patch(vec![("contextEngine", json!(on))]))
    })
    .ok_or("That robot isn't there any more.")?;
    chat::close_robot_idle(&app, &id);
    if on {
        start(&app, &id, false);
    } else {
        forget_unused(&app);
    }
    Ok(status_of(&app, &id))
}

/// Read the robot's folder again from scratch.
#[tauri::command(async)]
pub fn robot_context_reindex(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Status, Error> {
    let id = robots::sender(&window)?;
    let f = folder_for(&app, &id)?;
    set_status(
        &app,
        &f,
        Status {
            phase: Phase::Indexing,
            ..Status::default()
        },
    );
    start(&app, &id, true);
    Ok(status_of(&app, &id))
}

/// Where the engine keeps its database, model and indexes: the machine's own app data (they're
/// big, and no use roaming), or the test copy's data folder.
fn data_dir(app: &AppHandle) -> PathBuf {
    let base = match std::env::var_os("CBOT_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| paths::local_data().join("C-Bot")),
    };
    base.join("context")
}

pub fn setup(app: &AppHandle) {
    let dir = data_dir(app);
    wipe::leftovers(&dir); // (what was in use when the user deleted it)
    app.manage(Mutex::new(Engine {
        dir,
        ..Engine::default()
    }));
    // the worker giving chunks their vectors, for search by meaning
    let worker = app.clone();
    thread::spawn(move || embed::work(&worker));
    // the robots with the engine on read their folders, once the app is up
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        let ids: Vec<String> = with(&app, |st| {
            st.store
                .list()
                .iter()
                .filter(|c| c.context_engine())
                .map(|c| c.id().to_string())
                .collect()
        });
        for id in ids {
            start(&app, &id, false);
        }
    });
}

/// C-Bot is going: the database stops (if C-Bot started it).
pub fn shutdown(app: &AppHandle) {
    engine(app, |e| e.setup.clone()).stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_goes_to_the_page_as_it_reads_it() {
        let s = Status {
            phase: Phase::Installing,
            files: 3,
            chunks: 9,
            embedded: 5,
            symbols: 40,
            calls: 70,
            graph: true,
            done: 1,
            total: 2,
            capped: false,
            note: Some("Downloading PostgreSQL (once)â€¦".into()),
            error: None,
        };
        assert_eq!(
            json!(s),
            json!({ "phase": "installing", "files": 3, "chunks": 9, "embedded": 5, "symbols": 40, "calls": 70, "graph": true, "done": 1, "total": 2, "capped": false, "note": "Downloading PostgreSQL (once)â€¦", "error": null })
        );
        assert_eq!(json!(Status::default())["phase"], "off");
        assert_eq!(json!(Phase::Failed), "failed");
    }

    #[test]
    fn waiting_works_from_the_runtimes_own_threads_too() {
        assert_eq!(block(async { 1 }), 1);
        let inside = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn(async { block(async { 2 }) }).await
        });
        assert_eq!(inside.unwrap(), 2);
    }

    #[test]
    fn a_folder_is_the_same_however_it_is_written() {
        assert_eq!(key("C:/Work/Shop/"), key("c:\\work\\shop"));
        assert_ne!(key("C:\\work\\shop"), key("C:\\work\\shopping"));
    }
}
