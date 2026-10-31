//! Bringing a folder up to date, one look at a time (the others wait for it, then find the
//! folder fresh): the database set up if need be (the first time it's downloaded, and the
//! chat shows it), what's derived from the store (the code in memory, the keyword index)
//! brought up to it, then the files that changed read and committed in batches, each batch
//! mirrored into what's derived as it lands. A folder is watched from its first look on
//! (watch.rs, so what's saved while it's first read isn't missed): what's saved is read again
//! then (only those files, unless a folder came or went), and a question doesn't need a look
//! first.

use super::*;

/// Files per commit (what's derived catches up batch by batch, and a reading shows progress).
const BATCH: usize = 300;

#[derive(Default)]
pub(super) struct Gate {
    busy: bool,            // (someone is looking at it)
    last: Option<Instant>, // (when it was last looked at)
    dirty: bool,           // (its watch saw files change since a look began)
    /// While dirty: only these files changed (None: anything may have, so the folder is walked).
    changed: Option<BTreeSet<String>>,
    pub(super) when: Option<SystemTime>, // (when it was last brought up to date, for the chat)
}

/// Bring a folder up to date (unless it just was, or `again`: read it all afresh).
pub(super) fn look(app: &AppHandle, f: &Arc<Folder>, again: bool) {
    let only = {
        let mut gate = f.gate.locked();
        while gate.busy {
            gate = f.turn.wait(gate).unwrap_or_else(PoisonError::into_inner);
        }
        if !again && !gate.dirty && gate.last.is_some_and(|t| t.elapsed() < FRESH) {
            return;
        }
        gate.busy = true;
        // (a look of just the files saved, once the folder has been read whole)
        let only = gate
            .changed
            .take()
            .filter(|_| gate.dirty && !again && gate.last.is_some());
        gate.dirty = false;
        only
    };
    if f.root.is_dir() {
        watch::start(app, f);
    }
    let status = refresh(app, f, again, only).unwrap_or_else(|e| {
        log::warn!("code index of {}: {e}", f.root.display());
        Status {
            phase: Phase::Failed,
            error: Some(e.to_string()),
            ..Status::default()
        }
    });
    let ready = status.phase == Phase::Ready;
    {
        let mut gate = f.gate.locked();
        gate.busy = false;
        gate.last = Some(Instant::now());
        if ready {
            gate.when = Some(SystemTime::now());
        }
    }
    f.turn.notify_all();
    set_status(app, f, status);
    engine(app, |e| e.embedder.clone()).wake(); // (what's new gets its vectors)
    if ready {
        warm_graph(app, f);
    }
}

/// Files changed (its watch saw them: `files`, or None when it can't say which): bring the
/// folder up to date now, though it was a moment ago (and again after a look that's under way,
/// which may have missed them).
pub(super) fn changed(app: &AppHandle, f: &Arc<Folder>, files: Option<BTreeSet<String>>) {
    {
        let mut gate = f.gate.locked();
        gate.changed = match (gate.dirty, gate.changed.take(), files) {
            (false, _, files) => files,
            (true, Some(mut before), Some(files)) => {
                before.extend(files);
                Some(before)
            }
            _ => None,
        };
        gate.dirty = true;
    }
    look(app, f, false);
}

/// It has been looked at, and isn't being looked at now.
pub(super) fn looked(f: &Folder) -> bool {
    let gate = f.gate.locked();
    !gate.busy && gate.last.is_some()
}

/// Its index can be answered from as it is: watched, read, and nothing seen changing since.
pub(super) fn trusted(f: &Folder) -> bool {
    let gate = f.gate.locked();
    !gate.busy && !gate.dirty && gate.last.is_some() && watch::watched(f)
}

fn refresh(
    app: &AppHandle,
    f: &Folder,
    again: bool,
    only: Option<BTreeSet<String>>,
) -> Result<Status, Error> {
    if !f.root.is_dir() {
        return Err(format!("The folder {} isn't there.", f.root.display()).into());
    }
    let db = database(app, Some(f))?;
    let store = &db.store;
    let mut generation = store
        .open_scope(&f.scope, &f.root.to_string_lossy())?
        .generation;
    if again {
        let clear = Commit {
            clear: true,
            ..Commit::default()
        };
        generation = store.commit(&f.scope, generation, &clear)?;
        *f.vectors.locked() = Vectors::default(); // (loaded again when next needed)
    }
    let keyword = keyword_of(app, f)?;
    catch_up(store, f, &keyword, generation)?;
    let (stored, found, capped) = match only {
        Some(paths) => {
            let paths: Vec<String> = paths.into_iter().collect();
            let capped = f.status.locked().capped;
            let stored = store.stored_these(&f.scope, &paths)?;
            (stored, ingest::find_these(&f.root, &paths), capped)
        }
        None => {
            let stored = store.stored(&f.scope)?;
            let (found, capped) = ingest::find(&f.root);
            (stored, found, capped)
        }
    };
    let (check, gone) = ingest::changes(found, &stored);
    if !check.is_empty() || !gone.is_empty() {
        let shown = check.len() > 50 || f.status.locked().phase != Phase::Ready;
        let reads = read(app, f, check, &stored, shown, capped);
        let at = Batches {
            store,
            f,
            keyword: &keyword,
        };
        at.write(app, generation, reads, gone, shown, capped)?;
    }
    let (files, chunks) = store.counts(&f.scope)?;
    let (embedded, _) = store.embedded(&f.scope, embed::IDENTITY)?;
    // (a note of the embedder's stays; a reading's own "Saving…" doesn't)
    let note = {
        let s = f.status.locked();
        s.note.clone().filter(|_| s.phase == Phase::Ready)
    };
    // (one lock at a time: graph_of takes the graph's, then the code's)
    let (symbols, at) = {
        let code = f.code.locked();
        (code.symbols(), code.generation)
    };
    let (calls, graph) = f
        .graph
        .locked()
        .as_ref()
        .map_or((0, false), |g| (g.edge_count(), g.generation == at));
    Ok(Status {
        phase: Phase::Ready,
        files: usize::try_from(files).unwrap_or(0),
        chunks: usize::try_from(chunks).unwrap_or(0),
        embedded: usize::try_from(embedded).unwrap_or(0),
        symbols,
        calls,
        graph,
        capped,
        note,
        ..Status::default()
    })
}

/// The folder's vectors in memory, loaded from the store the first time they're needed.
pub(super) fn vectors_ready(store: &Store, f: &Folder) -> Result<(), Error> {
    let mut v = f.vectors.locked();
    if !v.loaded {
        v.load(store.vectors(&f.scope, embed::IDENTITY, None)?)?;
    }
    Ok(())
}

/// These files' vectors in memory as the store has them now (nothing to do while the folder's
/// aren't loaded: they come with the rest).
pub(super) fn vectors_for(store: &Store, f: &Folder, paths: &[String]) -> Result<(), Error> {
    let mut v = f.vectors.locked();
    if !v.loaded {
        return Ok(());
    }
    v.remove(paths)?;
    v.put(store.vectors(&f.scope, embed::IDENTITY, Some(paths))?)
}

/// The folder's keyword index, opened the first time.
fn keyword_of(app: &AppHandle, f: &Folder) -> Result<Arc<Keyword>, Error> {
    let mut k = f.keyword.locked();
    if let Some(k) = &*k {
        return Ok(k.clone());
    }
    let dir = engine(app, |e| e.dir.clone())
        .join("scopes")
        .join(store::hex(&f.scope))
        .join("bm25");
    let opened = Arc::new(Keyword::open(&dir)?);
    *k = Some(opened.clone());
    Ok(opened)
}

/// What's derived, brought up to the store's generation (after a restart, or a write that
/// didn't reach it).
fn catch_up(store: &Store, f: &Folder, keyword: &Keyword, generation: i64) -> Result<(), Error> {
    let since = f.code.locked().generation;
    if since != generation {
        let (s, written) = store.facts_since(&f.scope, since)?;
        f.code.locked().catch_up(s, written);
    }
    let since = keyword.generation();
    if since != generation {
        let (s, chunks) = store.chunks_since(&f.scope, since)?;
        keyword.apply(&Change {
            generation: s.generation,
            clear: s.full,
            remove: &s.gone,
            add: chunks.iter().map(doc_of).collect(),
        })?;
    }
    Ok(())
}

pub(super) fn doc_of(c: &StoredChunk) -> Doc<'_> {
    Doc {
        path: &c.path,
        idx: c.idx,
        code: c.code,
        from: u32::try_from(c.line_from).unwrap_or(0),
        to: u32::try_from(c.line_to).unwrap_or(0),
        symbol: &c.symbol,
        text: &c.text,
    }
}

/// The changed files read, the chat hearing how far it's got (`shown`: a few changed files
/// don't flash "indexing").
fn read(
    app: &AppHandle,
    f: &Folder,
    check: Vec<Found>,
    stored: &HashMap<String, Stored>,
    shown: bool,
    capped: bool,
) -> Vec<Read> {
    let total = check.len();
    let last_told = Mutex::new(Instant::now());
    let progress = |done: usize| {
        if !shown {
            return;
        }
        {
            let mut t = last_told.locked();
            if t.elapsed() < PROGRESS_EVERY && done < total {
                return;
            }
            *t = Instant::now();
        }
        let status = Status {
            phase: Phase::Indexing,
            done,
            total,
            capped,
            ..Status::default()
        };
        set_status(app, f, status);
    };
    progress(0);
    let reads = ingest::read_all(&f.root, check, stored, &progress);
    if total > 200 {
        log::info!("read {total} files in {}", f.root.display());
    }
    reads
}

/// Where a reading's batches go.
struct Batches<'a> {
    store: &'a Store,
    f: &'a Folder,
    keyword: &'a Keyword,
}

impl Batches<'_> {
    /// Commit what was read (and the files gone), batch by batch, each mirrored into what's
    /// derived as it lands.
    fn write(
        &self,
        app: &AppHandle,
        mut generation: i64,
        reads: Vec<Read>,
        gone: Vec<String>,
        shown: bool,
        capped: bool,
    ) -> Result<(), Error> {
        let total = reads.len();
        let mut gone = Some(gone);
        let mut reads = reads.into_iter().peekable();
        let mut done = 0;
        while gone.is_some() || reads.peek().is_some() {
            let batch: Vec<Read> = reads.by_ref().take(BATCH).collect();
            done += batch.len();
            generation = self.one(generation, batch, gone.take().unwrap_or_default())?;
            if shown {
                let status = Status {
                    phase: Phase::Indexing,
                    done,
                    total,
                    capped,
                    note: Some("Saving…".into()),
                    ..Status::default()
                };
                set_status(app, self.f, status);
            }
        }
        Ok(())
    }

    /// One batch: committed, then mirrored. The new generation.
    fn one(&self, on: i64, batch: Vec<Read>, gone: Vec<String>) -> Result<i64, Error> {
        let mut written = vec![];
        let mut touched = vec![];
        for r in batch {
            match r {
                Read::Touched(found) => touched.push((found.rel, found.stamp)),
                Read::Written(w) => written.push(*w),
            }
        }
        let facts: Vec<String> = written
            .iter()
            .map(|w| serde_json::to_string(&w.facts))
            .collect::<Result<_, _>>()?;
        let commit = Commit {
            clear: false,
            gone: gone.clone(),
            touched,
            written: written
                .iter()
                .zip(facts)
                .map(|(w, facts)| FileRow {
                    path: &w.found.rel,
                    stamp: w.found.stamp,
                    hash: &w.hash,
                    ty: w.found.ty.id(),
                    chunks: &w.chunks,
                    facts,
                })
                .collect(),
        };
        let generation = self.store.commit(&self.f.scope, on, &commit)?;
        drop(commit);
        self.mirror(on, generation, &gone, written);
        Ok(generation)
    }

    /// A committed batch (from generation `on`) into what's derived. (Should the keyword index
    /// fail, or not be at `on` because a batch before failed, it's left at its generation and
    /// replays from the store next time: a later batch on top would hide the one it missed.)
    fn mirror(&self, on: i64, generation: i64, gone: &[String], written: Vec<ingest::Written>) {
        let mut removed = gone.to_vec();
        removed.extend(written.iter().map(|w| w.found.rel.clone()));
        let add: Vec<Doc> = written
            .iter()
            .flat_map(|w| {
                w.chunks.iter().enumerate().map(|(i, c)| Doc {
                    path: &w.found.rel,
                    idx: i32::try_from(i).unwrap_or(i32::MAX),
                    code: c.code,
                    from: c.from,
                    to: c.to,
                    symbol: &c.symbol,
                    text: &c.text,
                })
            })
            .collect();
        let change = Change {
            generation,
            clear: false,
            remove: &removed,
            add,
        };
        if self.keyword.generation() == on
            && let Err(e) = self.keyword.apply(&change)
        {
            log::warn!("code index: the keyword index will catch up later: {e}");
        }
        // (a chunk that's been seen before, anywhere, has its vector already)
        if let Err(e) = vectors_for(self.store, self.f, &removed) {
            log::warn!("code index: vectors: {e}");
            *self.f.vectors.locked() = Vectors::default();
        }
        let mut code = self.f.code.locked();
        for path in gone {
            code.remove(path);
        }
        for w in written {
            code.put(&w.found.rel, w.found.ty, w.facts);
        }
        code.generation = generation;
    }
}

/// The database, set up if need be; `f` (when there's one) shows how that's going.
pub(super) fn database(app: &AppHandle, f: Option<&Folder>) -> Result<Arc<Database>, Error> {
    // (a reading of a folder let go meanwhile doesn't set up again what was just deleted)
    if let Some(f) = f
        && !still_on(app, f)
    {
        return Err("The context engine was switched off for this folder.".into());
    }
    let (dir, setup) = engine(app, |e| (e.dir.clone(), e.setup.clone()));
    let say = |note: &str| {
        if let Some(f) = f {
            let status = Status {
                phase: Phase::Installing,
                note: Some(note.into()),
                ..Status::default()
            };
            set_status(app, f, status);
        }
    };
    setup.database(&dir, &say)
}
