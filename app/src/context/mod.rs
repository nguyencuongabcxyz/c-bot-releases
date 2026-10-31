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
//!   parse.rs    reading one file through its syntax tree (tree-sitter)
//!   graph/      the code graph: calls, imports and heritage resolved across the folder
//!   search.rs   search_code's lanes (symbol, keyword, meaning), their fusion, the reranking
//!   map.rs      the repo map: the definitions the rest of the code uses most (PageRank)
//!   history.rs  what git remembers of the folder (code_history)
//!   answers/    what each tool answers
//!   details.rs  everything about the engine, for the chat's panel and its window
//!   browse.rs   what's in a folder's index, file by file, for the window
//!   window.rs   the Context engine window
//!   wipe.rs     deleting what it keeps, when the user asks

mod answers;
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
    "C-Bot's context engine has indexed the code in this folder (TypeScript/JavaScript, C#, Java, C/C++, Go, Python, Rust; Kotlin, Swift, PHP, Ruby, shell and PowerShell for their definitions only; its XML/XAML, Razor views, YAML, Dockerfiles, JSON, TOML, SQL, HTML, Vue, Svelte and CSS; its Markdown and text) and keeps it up to date. ",
    "Use its tools before grepping or reading whole files: code_map for the files and definitions that matter most (focus it on what you're working on), ",
    "code_outline for the signatures in a file or folder with their lines, find_symbol for where something is defined (body: true to see its code), ",
    "and search_code to find code or docs by words or meaning when you don't know the names. Then Read only the lines you need. ",
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

// ---------------------------------------------------------------- what the tools ask

/// code_map: the definitions that matter most, tilted towards `focus` (paths or names).
pub fn code_map(
    app: &AppHandle,
    id: &str,
    focus: &[String],
    budget: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let focus: Vec<String> = focus
        .iter()
        .map(|p| {
            ingest::asked_path(&f.root, p)
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| p.trim().to_string())
        })
        .collect();
    let map = map::repo_map(&graph_of(&f), &focus, budget);
    Ok(format!("{}\n\n{map}", summary(&f.code.locked())))
}

/// code_outline: a file's definitions, or a folder's files with theirs.
pub fn outline(app: &AppHandle, id: &str, path: &str) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let Some(rel) = ingest::asked_path(&f.root, path) else {
        return Err(format!(
            "{path} isn't in this robot's folder ({}).",
            f.root.display()
        )
        .into());
    };
    let code = f.code.locked();
    Ok(answers::outline(&code, &rel)?)
}

/// The folder's code graph at its code's generation (built again once that's moved on; one
/// build at a time, the others wait for it). It's built from a snapshot of the code, so a
/// search or a reading needn't wait for it.
fn graph_of(f: &Folder) -> Arc<Graph> {
    let mut graph = f.graph.locked();
    let generation = f.code.locked().generation;
    if let Some(g) = graph.as_ref().filter(|g| g.generation == generation) {
        return g.clone();
    }
    let code = f.code.locked().snapshot();
    let built = Arc::new(Graph::build(&code, &f.root));
    *graph = Some(built.clone());
    built
}

/// The graph built ahead, after a reading, if the code moved on (the first question about it
/// then doesn't wait), and how many calls it has told.
fn warm_graph(app: &AppHandle, f: &Arc<Folder>) {
    let stale = {
        let generation = f.code.locked().generation;
        f.graph
            .locked()
            .as_ref()
            .is_none_or(|g| g.generation != generation)
    };
    if !stale {
        return;
    }
    let (app, f) = (app.clone(), f.clone());
    thread::spawn(move || {
        let calls = graph_of(&f).edge_count();
        change_status(&app, &f, |s| {
            s.calls = calls;
            s.graph = true;
        });
    });
}

/// find_symbol: where something is defined.
pub fn find_symbol(
    app: &AppHandle,
    id: &str,
    name: &str,
    kind: &str,
    body: bool,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    Ok(answers::find(&graph_of(&f), &f.root, name, kind, body))
}

/// find_references: who calls what a name means, to `depth` (under `path`, '' for anywhere).
pub fn find_references(
    app: &AppHandle,
    id: &str,
    name: &str,
    path: &str,
    depth: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let under = ingest::asked_path(&f.root, path).unwrap_or_default();
    let g = graph_of(&f);
    let code = f.code.locked();
    Ok(answers::references(&g, &code, &f.root, name, &under, depth))
}

/// call_chain: the shortest chain of calls from one symbol to another.
pub fn call_chain(
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
    depth: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    Ok(answers::chain(&graph_of(&f), from, to, depth))
}

/// file_dependencies: what a file imports or what imports it ('' for the outside packages).
pub fn file_dependencies(
    app: &AppHandle,
    id: &str,
    path: &str,
    direction: &str,
    depth: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let rel = ingest::asked_path(&f.root, path).unwrap_or_else(|| path.to_string());
    Ok(answers::dependencies(&graph_of(&f), &rel, direction, depth))
}

/// type_hierarchy: a type's supertypes and subtypes, or a method's overrides.
pub fn type_hierarchy(
    app: &AppHandle,
    id: &str,
    name: &str,
    direction: &str,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    Ok(answers::hierarchy(&graph_of(&f), name, direction))
}

/// change_impact: what changing a symbol or a file would touch.
pub fn change_impact(
    app: &AppHandle,
    id: &str,
    target: &str,
    depth: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let g = graph_of(&f);
    let file = ingest::asked_path(&f.root, target).filter(|r| g.file_of(r).is_some());
    Ok(answers::impact(
        &g,
        file.as_deref().unwrap_or(target),
        depth,
    ))
}

/// search_code: code or documents found by name, words and meaning (under `path`, '' for
/// anywhere).
pub fn search_code(
    app: &AppHandle,
    id: &str,
    query: &str,
    path: &str,
    within: &str,
    limit: usize,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let under = ingest::asked_path(&f.root, path).unwrap_or_default();
    let filter = Filter {
        under: &under,
        within: Within::of(within),
    };
    let Some(keyword) = f.keyword.locked().clone() else {
        return Err("The index isn't ready yet.".into());
    };
    let db = look::database(app, None)?;
    let (dir, embedder) = engine(app, |e| (e.dir.clone(), e.embedder.clone()));
    // (the meaning lane embeds the question meanwhile)
    let (meaning, words) = thread::scope(|s| {
        let meaning = s.spawn(|| meaning_lane(&embedder, &dir, &db, &f, query, filter));
        let words = search::keyword_lane(&keyword, query, filter);
        (meaning.join().unwrap_or_else(|_| Ok(vec![])), words)
    });
    let targets = search::symbol_targets(&f.code.locked(), query, filter);
    let lanes = [
        ("symbol", db.store.chunks_at(&f.scope, &targets)?),
        ("bm25", words?),
        (
            "vector",
            meaning.unwrap_or_else(|e| {
                log::warn!("search by meaning: {e}");
                vec![]
            }),
        ),
    ];
    let pool = search::fuse(&lanes, search::plain(query), search::POOL.max(limit));
    let chunks: HashMap<(String, i32), StoredChunk> = db
        .store
        .chunks(&f.scope, &search::rerank_keys(&pool))?
        .into_iter()
        .map(|c| ((c.path.clone(), c.idx), c))
        .collect();
    let found = rerank(&embedder, &dir, query, pool, &chunks, limit);
    Ok(answers::search_code(query, &found, &chunks))
}

/// The meaning lane: the chunks nearest the question's vector (none while the model isn't
/// downloaded yet).
fn meaning_lane(
    embedder: &Embedder,
    dir: &Path,
    db: &Database,
    f: &Folder,
    query: &str,
    filter: Filter,
) -> Result<Vec<(String, i32)>, Error> {
    let Some(model) = embedder.ready(dir) else {
        return Ok(vec![]);
    };
    let Some(question) = model.embed(&[embed::question(query)])?.pop() else {
        return Ok(vec![]);
    };
    look::vectors_ready(&db.store, f)?;
    let near = f
        .vectors
        .locked()
        .search(&question, search::LANE_DEPTH, filter)?;
    Ok(near.into_iter().map(|(p, i, _)| (p, i)).collect())
}

/// The fused results in the reranker's order, `limit` of them (the lanes' order while it isn't
/// downloaded yet, or if it fails).
fn rerank(
    embedder: &Embedder,
    dir: &Path,
    query: &str,
    pool: Vec<Ranked>,
    chunks: &HashMap<(String, i32), StoredChunk>,
    limit: usize,
) -> Vec<Ranked> {
    let Some(reranker) = embedder.reranker(dir) else {
        return pool.into_iter().take(limit).collect();
    };
    match reranker.scores(query, &search::rerank_texts(&pool, chunks)) {
        Ok(scores) => search::rerank(pool, &scores, limit),
        Err(e) => {
            log::warn!("search_code: {e}");
            pool.into_iter().take(limit).collect()
        }
    }
}

/// What's indexed, in a line.
fn summary(code: &Code) -> String {
    let mut langs: BTreeMap<&str, usize> = BTreeMap::new();
    for f in code.files.values() {
        *langs.entry(f.lang.name()).or_default() += 1;
    }
    let langs: Vec<String> = langs.iter().map(|(l, n)| format!("{l} {n}")).collect();
    format!(
        "{} code files ({}), {} definitions. Each line: where it starts â”‚ its signature.",
        code.files.len(),
        langs.join(", "),
        code.symbols()
    )
}

/// What a robot's Claude is told about the engine and the code, when it's on (with the map
/// once the folder has been read: a conversation doesn't wait for the first reading).
pub fn note(app: &AppHandle, id: &str) -> Option<String> {
    let f = folder_for(app, id).ok()?;
    if !look::looked(&f) {
        return Some(NOTE.into());
    }
    if !look::trusted(&f) {
        look::look(app, &f, false);
    }
    let cached = {
        let code = f.code.locked();
        code.map_cache
            .as_ref()
            .filter(|(generation, _)| *generation == code.generation)
            .map(|(_, map)| map.clone())
    };
    // (the graph is built without the code locked: it locks it itself)
    let map = cached.unwrap_or_else(|| {
        let g = graph_of(&f);
        let map = map::repo_map(&g, &[], PROMPT_MAP);
        let mut code = f.code.locked();
        let map = format!("{}\n{map}", summary(&code));
        code.map_cache = Some((g.generation, map.clone()));
        map
    });
    Some(format!(
        "{NOTE}\n\nThe code map (the definitions the rest of the code uses most; code_map for more):\n{map}"
    ))
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
