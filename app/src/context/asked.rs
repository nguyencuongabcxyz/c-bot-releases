//! What the code tools ask (mcp/tools/code.rs), each answered from a robot's folder brought up
//! to date first: its map, a file's outline, where something is defined and who calls it, a
//! chain of calls, a file's imports, a type's lineage, what a change would touch, code found by
//! name, words and meaning; and the note (with the map) each of its conversations starts with.

use super::*;

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
pub(super) fn graph_of(f: &Folder) -> Arc<Graph> {
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
pub(super) fn warm_graph(app: &AppHandle, f: &Arc<Folder>) {
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

/// find_type_usages: where a type is used as one (under `path`, '' for anywhere).
pub fn find_type_usages(
    app: &AppHandle,
    id: &str,
    name: &str,
    path: &str,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let under = ingest::asked_path(&f.root, path).unwrap_or_default();
    Ok(answers::type_usages(&graph_of(&f), &f.root, name, &under))
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
    let code = f.code.locked();
    Ok(answers::impact(
        &g,
        &code,
        &f.root,
        file.as_deref().unwrap_or(target),
        depth,
    ))
}

/// type_members: a type's members (and with `inherited`, its supertypes').
pub fn type_members(
    app: &AppHandle,
    id: &str,
    name: &str,
    inherited: bool,
) -> Result<String, Error> {
    let f = fresh(app, id)?;
    Ok(answers::members(&graph_of(&f), name, inherited))
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
    let (found, chunks) = search::pick(
        query,
        &lanes,
        limit,
        |keys| db.store.chunks(&f.scope, keys),
        |texts| {
            embedder
                .reranker(&dir)?
                .scores(query, texts)
                .inspect_err(|e| log::warn!("search_code: {e}"))
                .ok()
        },
    )?;
    Ok(answers::search_code(query, &found, &chunks))
}

/// The meaning lane: the chunks nearest the question's vector (none while the model isn't
/// downloaded yet).
pub(super) fn meaning_lane(
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

/// What's indexed, in a line.
pub(super) fn summary(code: &Code) -> String {
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

/// What a robot's Claude is told about the optimizer and the code, when it's on (with the map
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
        "{NOTE}\n\nThe code map (the definitions the rest of the code uses most; mcp__cbot__code_map for more):\n{map}"
    ))
}
