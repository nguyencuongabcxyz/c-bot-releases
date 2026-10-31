//! Search by meaning: each chunk's vector, made by the sentence model (model.rs) and kept in
//! the store by (model, chunk hash), so a chunk embedded once never is again, whichever folder
//! it's in. One worker thread embeds what has no vector yet, a batch at a time, when a reading
//! wakes it (and every NAP anyway); search works meanwhile, its meaning lane joining in as
//! vectors come. The model is downloaded the first time there's work, loaded while there's
//! work or a question, and let go after IDLE (it takes about 500 MB). The reranker (rerank.rs)
//! is downloaded by the worker once a folder's vectors are done, loaded for a question, and
//! let go after IDLE too.

mod model;
mod rerank;

pub(in crate::context) use model::Model;
pub(in crate::context) use rerank::Reranker;

use super::*;

/// What names the vectors: the model, how a vector is made of it, how its input is made. A
/// change here is a new model to the store, so vectors made two ways never mix.
pub(in crate::context) const IDENTITY: &str = "multilingual-e5-small:mean:l2:384:t256:h2:qp";
pub(in crate::context) const DIMENSIONS: usize = 384;
/// What the model reads before a question, and before what may answer one (e5 was trained so:
/// `qp` in the identity).
const QUERY: &str = "query: ";
const PASSAGE: &str = "passage: ";
/// The most of a file's opening comment each of its chunks carries.
const ABOUT_CHARS: usize = 300;
const BATCH: i64 = 32;
const IDLE: Duration = Duration::from_secs(180);
const NAP: Duration = Duration::from_secs(30);

/// What a chunk's vector is made of, and what the reranker reads of it (`h2`): where it is and
/// what it's in, what its file says it's for (from its `opening`: the comment the file opens
/// with, which its first chunk holds already; a C# file's, the doc comment on its first type),
/// then its text. A function deep in a file rarely says what the file is for; with this, a
/// question about that finds it.
pub(in crate::context) fn input_of(
    path: &str,
    idx: i32,
    first: &str,
    symbol: &str,
    text: &str,
) -> String {
    let mut out = path.to_string();
    if !symbol.is_empty() {
        out.push_str(" › ");
        out.push_str(symbol);
    }
    let about = if csharp(path) {
        csharp_about(first)
    } else if idx == 0 {
        String::new()
    } else {
        about(first)
    };
    if !about.is_empty() {
        out.push('\n');
        out.push_str(&about);
    }
    out.push('\n');
    out.push_str(text);
    out
}

/// What a file says it's for: the comment it opens with (its first chunk's leading comment
/// lines, markers off, attributes skipped), in one line, cut at ABOUT_CHARS.
fn about(first: &str) -> String {
    let mut out = String::new();
    let mut docstring = false; // (inside Python's """…""")
    for line in first.lines() {
        let t = line.trim();
        if t.starts_with("#[") || t.starts_with("#![") {
            continue;
        }
        let body = if docstring {
            Some(t)
        } else {
            [
                "//!", "///", "//", "/**", "/*", "*/", "*", "#", "\"\"\"", "'''",
            ]
            .iter()
            .find_map(|m| t.strip_prefix(m).map(|b| (m, b)))
            .map(|(m, b)| {
                docstring = (*m == "\"\"\"" || *m == "'''") && !b.contains(m);
                b
            })
        };
        let Some(body) = body else {
            if t.is_empty() && out.is_empty() {
                continue;
            }
            break;
        };
        if docstring && (body.contains("\"\"\"") || body.contains("'''")) {
            docstring = false;
        }
        let body = body.trim_end_matches("*/").trim_matches(['"', '\'', ' ']);
        if !body.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(body);
        }
        if out.chars().count() >= ABOUT_CHARS {
            break;
        }
    }
    out.chars().take(ABOUT_CHARS).collect()
}

/// A C# file: its first chunk is its usings, and what it's for is the doc comment on its first
/// type, a chunk or two on.
fn csharp(path: &str) -> bool {
    path.ends_with(".cs")
}

/// A file's opening, as input_of reads it, from its first chunks' texts (in order): its first
/// chunk's; a C# file's first three.
pub(in crate::context) fn opening(path: &str, first: &[&str]) -> String {
    let n = if csharp(path) { 3 } else { 1 };
    first[..first.len().min(n)].join("\n")
}

/// What a C# file says it's for: the doc comment on its first type, past its usings, its
/// namespace and its directives, its XML tags off (a reference's name kept: `<see cref="Store"/>`
/// is Store).
fn csharp_about(opening: &str) -> String {
    let doc: Vec<&str> = opening
        .lines()
        .skip_while(|l| {
            let t = l.trim();
            t.is_empty()
                || t.starts_with("using ")
                || t.starts_with("global using ")
                || t.starts_with("namespace ")
                || t.starts_with('#')
                || t == "{"
        })
        .collect();
    let mut out = String::new();
    let mut rest = about(&doc.join("\n"));
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let Some(end) = rest[at..].find('>') else {
            out.push_str(&rest[at..]);
            rest.clear();
            break;
        };
        let tag = &rest[at..at + end];
        if let Some(cref) = tag
            .split("cref=\"")
            .nth(1)
            .and_then(|c| c.split('"').next())
        {
            out.push_str(cref.rsplit(['.', ':']).next().unwrap_or(cref));
        }
        rest = rest[at + end + 1..].to_string();
    }
    out.push_str(&rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What the model reads to make a chunk's vector (its input_of).
pub(in crate::context) fn passage(input: &str) -> String {
    format!("{PASSAGE}{input}")
}

/// What the model reads to make a question's vector.
pub(in crate::context) fn question(query: &str) -> String {
    format!("{QUERY}{query}")
}

/// A vector as the store keeps it: half precision, little-endian.
pub(in crate::context) fn to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter()
        .flat_map(|x| half::f16::from_f32(*x).to_le_bytes())
        .collect()
}

pub(in crate::context) fn from_bytes(b: &[u8]) -> Vec<f32> {
    b.as_chunks::<2>()
        .0
        .iter()
        .map(|h| half::f16::from_le_bytes(*h).to_f32())
        .collect()
}

/// The model (when loaded), and the worker's waking.
#[derive(Default)]
pub(in crate::context) struct Embedder {
    state: Mutex<State>,
    turn: Condvar,
}

#[derive(Default)]
struct State {
    woken: bool,
    loading: bool,
    model: Option<Arc<Model>>,
    used: Option<Instant>,
    reranker: Option<Arc<Reranker>>,
    reranker_used: Option<Instant>,
}

impl Embedder {
    /// There's something to embed.
    pub(in crate::context) fn wake(&self) {
        self.state.locked().woken = true;
        self.turn.notify_all();
    }

    /// The model, loaded (and downloaded, the first time) if need be; `say` hears how that goes.
    pub(in crate::context) fn model(
        &self,
        dir: &Path,
        say: &(dyn Fn(&str) + Sync),
    ) -> Result<Arc<Model>, Error> {
        {
            let mut s = self.state.locked();
            while s.loading {
                s = self.turn.wait(s).unwrap_or_else(PoisonError::into_inner);
            }
            if let Some(m) = s.model.clone() {
                s.used = Some(Instant::now());
                return Ok(m);
            }
            s.loading = true;
        }
        let loaded = install::runtime(dir, say)
            .and_then(|dll| {
                install::model(dir, &install::SENTENCE, say).and_then(|at| Model::load(&at, &dll))
            })
            .map(Arc::new);
        {
            let mut s = self.state.locked();
            s.loading = false;
            if let Ok(m) = &loaded {
                s.model = Some(m.clone());
                s.used = Some(Instant::now());
            }
        }
        self.turn.notify_all();
        loaded
    }

    /// The model if it's downloaded (loaded if need be), for a question: None while it isn't.
    pub(in crate::context) fn ready(&self, dir: &Path) -> Option<Arc<Model>> {
        install::runtime_downloaded(dir)?;
        install::model_downloaded(dir, &install::SENTENCE)?;
        self.model(dir, &|_| {}).ok()
    }

    /// The reranker if it's downloaded (loaded if need be), for a question: None while it isn't,
    /// or when it can't be loaded (search then keeps the lanes' order).
    pub(in crate::context) fn reranker(&self, dir: &Path) -> Option<Arc<Reranker>> {
        let dll = install::runtime_downloaded(dir)?;
        let at = install::model_downloaded(dir, &install::RERANKER)?;
        {
            let mut s = self.state.locked();
            if let Some(r) = s.reranker.clone() {
                s.reranker_used = Some(Instant::now());
                return Some(r);
            }
        }
        // (two questions at once may both load it: the second one's is kept, no harm done)
        let loaded = Reranker::load(&at, &dll)
            .map(Arc::new)
            .inspect_err(|e| log::warn!("the reranker: {e}"))
            .ok()?;
        let mut s = self.state.locked();
        s.reranker = Some(loaded.clone());
        s.reranker_used = Some(Instant::now());
        Some(loaded)
    }

    /// The models let go (their files are about to go: wipe.rs).
    pub(in crate::context) fn unload(&self) {
        let mut s = self.state.locked();
        s.model = None;
        s.used = None;
        s.reranker = None;
        s.reranker_used = None;
    }

    /// Whether the sentence model and the reranker are loaded now.
    pub(in crate::context) fn loaded(&self) -> (bool, bool) {
        let s = self.state.locked();
        (s.model.is_some(), s.reranker.is_some())
    }

    /// Wait to be woken, or a NAP; the models go if they haven't been used for a while.
    fn rest(&self) {
        let mut s = self.state.locked();
        if !s.woken {
            s = self
                .turn
                .wait_timeout(s, NAP)
                .map_or_else(|p| p.into_inner().0, |(s, _)| s);
        }
        s.woken = false;
        if !s.loading && s.used.is_some_and(|t| t.elapsed() > IDLE) {
            s.model = None;
            s.used = None;
        }
        if s.reranker_used.is_some_and(|t| t.elapsed() > IDLE) {
            s.reranker = None;
            s.reranker_used = None;
        }
    }
}

/// The worker: forever, each folder's chunks with no vector yet embedded, then rest.
pub(in crate::context) fn work(app: &AppHandle) {
    loop {
        let (embedder, folders) = engine(app, |e| {
            (
                e.embedder.clone(),
                e.folders.values().cloned().collect::<Vec<_>>(),
            )
        });
        for f in folders {
            if let Err(e) = embed_folder(app, &f, &embedder) {
                log::warn!("search by meaning in {}: {e}", f.root.display());
                change_status(app, &f, |s| {
                    s.note = Some(format!("Search by meaning: {e}"))
                });
            }
        }
        embedder.rest();
    }
}

/// A folder's chunks with no vector yet, embedded batch by batch, the chat hearing how far.
fn embed_folder(app: &AppHandle, f: &Folder, embedder: &Embedder) -> Result<(), Error> {
    if !look::looked(f) {
        return Ok(()); // (its first reading isn't done: it wakes us when it is)
    }
    // (nothing written since its vectors were all made: not even counted again)
    let generation = f.code.locked().generation;
    if *f.embedded_at.locked() == Some(generation) {
        return Ok(());
    }
    let db = look::database(app, None)?;
    let (mut embedded, all) = db.store.embedded(&f.scope, IDENTITY)?;
    let dir = engine(app, |e| e.dir.clone());
    let say = |note: &str| change_status(app, f, |s| s.note = Some(note.into()));
    if embedded >= all {
        // (the vectors are done: now the reranker, the first time)
        if install::model_downloaded(&dir, &install::RERANKER).is_none() {
            install::model(&dir, &install::RERANKER, &say)?;
            change_status(app, f, |s| s.note = None);
        }
        *f.embedded_at.locked() = Some(generation);
        return Ok(());
    }
    let model = embedder.model(&dir, &say)?;
    change_status(app, f, |s| s.note = None);
    let mut told = Instant::now();
    let mut after = vec![];
    loop {
        if !still_on(app, f) {
            return Ok(());
        }
        let batch = db.store.unembedded(&f.scope, IDENTITY, BATCH, &after)?;
        let Some(last) = batch.last() else {
            break;
        };
        after.clone_from(&last.hash);
        let inputs: Vec<String> = batch
            .iter()
            .map(|p| passage(&input_of(&p.path, p.idx, &p.first, &p.symbol, &p.text)))
            .collect();
        let vectors = model.embed(&inputs)?;
        let rows: Vec<(Vec<u8>, Vec<u8>)> = batch
            .iter()
            .zip(&vectors)
            .map(|(p, v)| (p.hash.clone(), to_bytes(v)))
            .collect();
        db.store.put_embeddings(IDENTITY, &rows)?;
        let mut paths: Vec<String> = batch.into_iter().map(|p| p.path).collect();
        paths.sort_unstable();
        paths.dedup();
        look::vectors_for(&db.store, f, &paths)?;
        embedded += i64::try_from(rows.len()).unwrap_or(0);
        if told.elapsed() > PROGRESS_EVERY {
            told = Instant::now();
            let n = usize::try_from(embedded).unwrap_or(0);
            change_status(app, f, |s| s.embedded = n);
        }
    }
    let (n, all) = db.store.embedded(&f.scope, IDENTITY)?;
    if n >= all {
        *f.embedded_at.locked() = Some(generation);
    }
    change_status(app, f, |s| s.embedded = usize::try_from(n).unwrap_or(0));
    Ok(())
}

#[cfg(test)]
mod live_tests {
    use super::*;

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    /// The real models (downloaded once into %TEMP%\cbot-context-live): a question comes out
    /// nearer the code that answers it than code about something else, in English and
    /// Vietnamese; and the reranker scores that code higher too.
    #[test]
    #[ignore]
    fn the_models_put_a_question_near_what_answers_it() {
        let dir = std::env::temp_dir().join("cbot-context-live");
        let say = |note: &str| log::info!("{note}");
        let dll = install::runtime(&dir, &say).unwrap();
        let at = install::model(&dir, &install::SENTENCE, &say).unwrap();
        let t = Instant::now();
        let model = Model::load(&at, &dll).unwrap();
        let loading = t.elapsed();
        let answer = "src/net.rs › backoff\nfn backoff(attempt: u32) -> Duration { /* wait longer after each failed send */ }";
        let other = "src/draw.rs › circle\nfn circle(r: f32) { canvas.arc(0.0, 0.0, r) }";
        let texts = vec![
            question("retry the upload when it fails"),
            passage(answer),
            passage(other),
            question("thử lại khi tải lên bị lỗi"),
        ];
        let v = model.embed(&texts).unwrap();
        assert!(
            v.iter()
                .all(|x| x.len() == DIMENSIONS && (dot(x, x) - 1.0).abs() < 1e-3)
        );
        assert!(dot(&v[0], &v[1]) > dot(&v[0], &v[2]));
        assert!(dot(&v[3], &v[1]) > dot(&v[3], &v[2]));
        // (the same question in two languages, nearer each other than either is to the other code)
        assert!(dot(&v[0], &v[3]) > dot(&v[0], &v[2]));

        let at = install::model(&dir, &install::RERANKER, &say).unwrap();
        let reranker = Reranker::load(&at, &dll).unwrap();
        for q in [
            "retry the upload when it fails",
            "thử lại khi tải lên bị lỗi",
        ] {
            let s = reranker.scores(q, &[answer.into(), other.into()]).unwrap();
            assert!(s[0] > s[1], "{q}: {s:?}");
        }

        let long: Vec<String> = (0..64)
            .map(|i| {
                let body: String = (0..24)
                    .map(|l| format!("    let value_{l} = compute_{i}(input, {l}) + offset;\n"))
                    .collect();
                passage(&format!(
                    "src/a{i}.rs › f{i}\nfn f{i}(input: u32) -> u32 {{\n{body}}}"
                ))
            })
            .collect();
        let t = Instant::now();
        model.embed(&long).unwrap();
        let embedding = t.elapsed();
        let t = Instant::now();
        reranker
            .scores("compute the offset", &long[..search::POOL])
            .unwrap();
        println!(
            "loaded in {loading:?}; 64 chunks of {} tokens in {embedding:?}; {} reranked in {:?}",
            model::MAX_TOKENS,
            search::POOL,
            t.elapsed()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_keep_at_half_precision() {
        let v = [0.5f32, -0.25, 0.123_456];
        let back = from_bytes(&to_bytes(&v));
        assert_eq!(back.len(), 3);
        assert!(back.iter().zip(v).all(|(a, b)| (a - b).abs() < 1e-3));
        assert_eq!(to_bytes(&v).len(), 6);
    }

    #[test]
    fn a_chunk_is_embedded_with_where_it_is_and_what_its_file_is_for() {
        let first = "//! Opening the store.\n//! (and closing it)\n\nuse std::io;";
        assert_eq!(
            input_of("src/a.rs", 2, first, "Store › open", "fn open() {}"),
            "src/a.rs › Store › open\nOpening the store. (and closing it)\nfn open() {}"
        );
        // (the first chunk holds the comment already)
        assert_eq!(
            input_of("src/a.rs", 0, first, "", first),
            format!("src/a.rs\n{first}")
        );
        assert_eq!(
            input_of("README.md", 1, "", "", "Hello"),
            "README.md\nHello"
        );
    }

    #[test]
    fn a_csharp_file_says_what_its_for_in_the_doc_on_its_first_type() {
        let chunks = [
            "using System;\nusing ChatLibAI.Core;\n\nnamespace ChatLibAI.Application;",
            "/// <summary>\n/// Sends a message and streams the answer, using the <see cref=\"Core.ITokenCounter\"/>.\n/// </summary>\n[Serializable]\npublic sealed class ChatOrchestrator\n{",
            "    public void Send() {}",
            "    public void Later() {}",
        ];
        let head = opening("Services/ChatOrchestrator.cs", &chunks);
        assert!(!head.contains("Later"));
        let about = "Sends a message and streams the answer, using the ITokenCounter.";
        assert_eq!(csharp_about(&head), about);
        // (every chunk carries it, the first too: it's only the usings)
        assert_eq!(
            input_of("Services/ChatOrchestrator.cs", 0, &head, "", chunks[0]),
            format!("Services/ChatOrchestrator.cs\n{about}\n{}", chunks[0])
        );
        // (other languages: their first chunk only, as before)
        assert_eq!(opening("a.rs", &chunks), chunks[0]);
        assert_eq!(csharp_about("using X;\npublic class K {}"), "");
        assert_eq!(csharp_about("/// <summary>Half <b"), "Half <b");
    }

    #[test]
    fn a_file_says_what_its_for_in_the_comment_it_opens_with() {
        assert_eq!(
            about("#![expect(x)]\n//! Robots.\n//! Their windows.\nuse a;"),
            "Robots. Their windows."
        );
        assert_eq!(
            about("/**\n * Markdown to HTML.\n */\nimport x;"),
            "Markdown to HTML."
        );
        assert_eq!(
            about("// Tiny noises.\n\nexport const a = 1;"),
            "Tiny noises."
        );
        assert_eq!(
            about("\"\"\"Reads the config.\n\nAnd checks it.\n\"\"\"\nimport os"),
            "Reads the config. And checks it."
        );
        assert_eq!(about("# Install\n\nRun it."), "Install");
        assert_eq!(about("fn main() {}\n// late"), "");
        assert_eq!(
            about(&format!("// {}", "word ".repeat(100)))
                .chars()
                .count(),
            ABOUT_CHARS
        );
    }
}
