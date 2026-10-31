//! A folder's keyword index (Tantivy, BM25), derived from the store: one document per chunk,
//! with its path, what it's in (the symbol) and its text, each read by the code tokenizer
//! (search.rs `words`: names whole and in their parts, and stems), and what a search can be
//! kept to (the folders it's in, whether it's code). It lives in <dir>/scopes/<id>/bm25; the
//! generation it reflects is its last commit's payload, and it catches up by replaying what
//! the store wrote after that. It can be deleted at any time: it is rebuilt (and is, when it
//! was made with other fields).

use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, ConstScoreQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions,
    Value,
};
use tantivy::tokenizer::{TextAnalyzer, Token, TokenStream, Tokenizer};
use tantivy::{Index, IndexReader, ReloadPolicy, TantivyDocument, Term};

use super::*;

const TOKENIZER: &str = "code";
const WRITER_MEMORY: usize = 50_000_000;
/// How much a word found in a chunk's path or symbol counts, against its text.
const PATH_BOOST: f32 = 1.5;
const SYMBOL_BOOST: f32 = 2.5;

#[derive(Clone, Copy)]
struct Fields {
    path: Field,
    dirs: Field, // (the folders it's in, and the file itself: app, app/src, app/src/a.rs)
    idx: Field,
    code: Field,
    from: Field,
    to: Field,
    path_text: Field,
    symbol: Field,
    text: Field,
}

pub(super) struct Keyword {
    index: Index,
    reader: IndexReader,
    f: Fields,
}

/// What brings the index to a generation: everything cleared first, or these paths removed,
/// then these chunks added.
pub(super) struct Change<'a> {
    pub generation: i64,
    pub clear: bool,
    pub remove: &'a [String],
    pub add: Vec<Doc<'a>>,
}

/// A chunk, as the index takes it.
pub(super) struct Doc<'a> {
    pub path: &'a str,
    pub idx: i32,
    pub code: bool,
    pub from: u32,
    pub to: u32,
    pub symbol: &'a str,
    pub text: &'a str,
}

/// A chunk found, best first.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Hit {
    pub path: String,
    pub idx: i32,
    pub code: bool,
    pub from: u32,
    pub to: u32,
    pub symbol: String,
    pub score: f32,
}

fn schema() -> (Schema, Fields) {
    let words = |stored: bool| {
        let o = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqs),
        );
        if stored { o.set_stored() } else { o }
    };
    let mut b = Schema::builder();
    let f = Fields {
        path: b.add_text_field("path", STRING | STORED),
        dirs: b.add_text_field("dirs", STRING),
        idx: b.add_u64_field("idx", STORED),
        code: b.add_u64_field("code", STORED | INDEXED),
        from: b.add_u64_field("from", STORED),
        to: b.add_u64_field("to", STORED),
        path_text: b.add_text_field("path_text", words(false)),
        symbol: b.add_text_field("symbol", words(true)),
        text: b.add_text_field("text", words(false)),
    };
    (b.build(), f)
}

impl Keyword {
    /// The index in `dir`, made (or made again, when it's unreadable or from another C-Bot).
    pub(super) fn open(dir: &Path) -> Result<Keyword, Error> {
        let (schema, f) = schema();
        let index = match Index::open_in_dir(dir) {
            Ok(index) if index.schema() == schema => index,
            _ => {
                let _ = std::fs::remove_dir_all(dir);
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
                Index::create_in_dir(dir, schema)?
            }
        };
        index
            .tokenizers()
            .register(TOKENIZER, TextAnalyzer::from(CodeTokenizer));
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        Ok(Keyword { index, reader, f })
    }

    /// The generation it reflects (0: none yet).
    pub(super) fn generation(&self) -> i64 {
        self.index
            .load_metas()
            .ok()
            .and_then(|m| m.payload)
            .and_then(|p| p.parse().ok())
            .unwrap_or(0)
    }

    pub(super) fn apply(&self, change: &Change) -> Result<(), Error> {
        let mut writer = self.index.writer::<TantivyDocument>(WRITER_MEMORY)?;
        if change.clear {
            writer.delete_all_documents()?;
        }
        for path in change.remove {
            writer.delete_term(Term::from_field_text(self.f.path, path));
        }
        let f = self.f;
        for d in &change.add {
            let mut doc = TantivyDocument::default();
            doc.add_text(f.path, d.path);
            for dir in dirs(d.path) {
                doc.add_text(f.dirs, dir);
            }
            doc.add_u64(f.idx, u64::try_from(d.idx).unwrap_or(0));
            doc.add_u64(f.code, u64::from(d.code));
            doc.add_u64(f.from, u64::from(d.from));
            doc.add_u64(f.to, u64::from(d.to));
            doc.add_text(f.path_text, d.path);
            doc.add_text(f.symbol, d.symbol);
            doc.add_text(f.text, d.text);
            writer.add_document(doc)?;
        }
        let mut commit = writer.prepare_commit()?;
        commit.set_payload(&change.generation.to_string());
        commit.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    /// The `limit` chunks best matching the words, among those the filter keeps.
    pub(super) fn search(
        &self,
        words: &[String],
        limit: usize,
        filter: Filter,
    ) -> Result<Vec<Hit>, Error> {
        let f = self.f;
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![];
        for w in words {
            for (field, boost) in [
                (f.path_text, PATH_BOOST),
                (f.symbol, SYMBOL_BOOST),
                (f.text, 1.0),
            ] {
                let term = TermQuery::new(
                    Term::from_field_text(field, w),
                    IndexRecordOption::WithFreqs,
                );
                clauses.push((
                    Occur::Should,
                    Box::new(BoostQuery::new(Box::new(term), boost)),
                ));
            }
        }
        if clauses.is_empty() {
            return Ok(vec![]);
        }
        let mut query: Vec<(Occur, Box<dyn Query>)> =
            vec![(Occur::Must, Box::new(BooleanQuery::new(clauses)))];
        query.extend(self.kept_to(filter).into_iter().map(|q| (Occur::Must, q)));
        let searcher = self.reader.searcher();
        // (a few more than asked for: `keeps` has the last word on a folder's case)
        let top = searcher.search(
            &BooleanQuery::new(query),
            &TopDocs::with_limit(limit + limit / 4).order_by_score(),
        )?;
        let mut hits = vec![];
        for (score, at) in top {
            let doc: TantivyDocument = searcher.doc(at)?;
            let text = |field| {
                doc.get_first(field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let number = |field| doc.get_first(field).and_then(|v| v.as_u64()).unwrap_or(0);
            let (path, code) = (text(f.path), number(f.code) == 1);
            if !filter.keeps(&path, code) {
                continue;
            }
            hits.push(Hit {
                path,
                idx: i32::try_from(number(f.idx)).unwrap_or(0),
                code,
                from: u32::try_from(number(f.from)).unwrap_or(0),
                to: u32::try_from(number(f.to)).unwrap_or(0),
                symbol: text(f.symbol),
                score,
            });
            if hits.len() == limit {
                break;
            }
        }
        Ok(hits)
    }

    /// What keeps a search to the filter's folder and kind (each scoring nothing, so the words
    /// alone rank).
    fn kept_to(&self, filter: Filter) -> Vec<Box<dyn Query>> {
        let term = |t: Term| -> Box<dyn Query> {
            let q = TermQuery::new(t, IndexRecordOption::Basic);
            Box::new(ConstScoreQuery::new(Box::new(q), 0.0))
        };
        let mut out = vec![];
        let under = filter.under.trim_matches('/').to_lowercase();
        if !under.is_empty() {
            out.push(term(Term::from_field_text(self.f.dirs, &under)));
        }
        match filter.within {
            Within::Code => out.push(term(Term::from_field_u64(self.f.code, 1))),
            Within::Docs => out.push(term(Term::from_field_u64(self.f.code, 0))),
            Within::All => {}
        }
        out
    }
}

/// The folders a path is in, and the path itself, as a filter asks for them (lowercase).
fn dirs(path: &str) -> Vec<String> {
    let lower = path.to_lowercase();
    let mut out: Vec<String> = lower
        .match_indices('/')
        .map(|(i, _)| lower[..i].to_string())
        .collect();
    out.push(lower);
    out
}

// ---------------------------------------------------------------- tokenizer

/// The code tokenizer: search.rs `words`, as Tantivy tokens.
#[derive(Clone)]
struct CodeTokenizer;

struct CodeTokens {
    tokens: Vec<Token>,
    at: usize,
}

impl Tokenizer for CodeTokenizer {
    type TokenStream<'a> = CodeTokens;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> CodeTokens {
        let mut tokens = vec![];
        search::words(text, |w| {
            if w.len() <= 64 {
                tokens.push(Token {
                    position: tokens.len(),
                    text: w,
                    ..Token::default()
                });
            }
        });
        CodeTokens { tokens, at: 0 }
    }
}

impl TokenStream for CodeTokens {
    fn advance(&mut self) -> bool {
        self.at += 1;
        self.at <= self.tokens.len()
    }

    fn token(&self) -> &Token {
        &self.tokens[self.at - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.at - 1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc<'a>(path: &'a str, idx: i32, symbol: &'a str, text: &'a str) -> Doc<'a> {
        Doc {
            path,
            idx,
            code: !path.ends_with(".md"),
            from: 1,
            to: 9,
            symbol,
            text,
        }
    }

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("cbot-bm25-{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn chunks_are_found_by_their_names_in_parts_best_first() {
        let dir = scratch();
        let k = Keyword::open(&dir).unwrap();
        assert_eq!(k.generation(), 0);
        k.apply(&Change {
            generation: 3,
            clear: false,
            remove: &[],
            add: vec![
                doc(
                    "src/auth/login.ts",
                    0,
                    "login",
                    "export async function login(user, password) { return check(user, password); }",
                ),
                doc(
                    "src/ui/button.ts",
                    0,
                    "render",
                    "// a login button\nexport function render() {}",
                ),
                doc(
                    "docs/auth.md",
                    0,
                    "Signing in",
                    "How users sign in with a password.",
                ),
            ],
        })
        .unwrap();
        assert_eq!(k.generation(), 3);
        let all = Filter::default();
        let hits = k
            .search(&search::query_words("login password"), 10, all)
            .unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths[0], "src/auth/login.ts");
        assert_eq!(hits[0].symbol, "login");
        // (a name's parts find what's written in words: getUserById's user, the docs' users)
        let hits = k
            .search(&search::query_words("getUserById"), 10, all)
            .unwrap();
        let mut paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["docs/auth.md", "src/auth/login.ts"]);
        assert!(
            k.search(&search::query_words("zebra quantum"), 10, all)
                .unwrap()
                .is_empty()
        );
        drop(k);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_search_kept_to_a_folder_or_a_kind_finds_only_there_however_many_are_elsewhere() {
        let dir = scratch();
        let k = Keyword::open(&dir).unwrap();
        let elsewhere: Vec<String> = (0..300).map(|i| format!("src/many/m{i}.ts")).collect();
        let mut add: Vec<Doc> = elsewhere
            .iter()
            .map(|p| doc(p, 0, "token", "token token token refresh"))
            .collect();
        add.push(doc("Lib/Auth/token.ts", 0, "", "refresh it once"));
        add.push(doc("Lib/Auth/notes.md", 0, "", "refresh token notes"));
        k.apply(&Change {
            generation: 1,
            clear: false,
            remove: &[],
            add,
        })
        .unwrap();
        let words = search::query_words("refresh token");
        let paths = |filter: Filter| -> Vec<String> {
            let mut v: Vec<String> = k
                .search(&words, 5, filter)
                .unwrap()
                .into_iter()
                .map(|h| h.path)
                .collect();
            v.sort();
            v
        };
        let under = |under, within| Filter { under, within };
        // (the 300 elsewhere score higher, and are never looked at)
        assert_eq!(
            paths(under("lib/auth", Within::All)),
            ["Lib/Auth/notes.md", "Lib/Auth/token.ts"]
        );
        assert_eq!(
            paths(under("lib/auth/", Within::Code)),
            ["Lib/Auth/token.ts"]
        );
        assert_eq!(paths(under("", Within::Docs)), ["Lib/Auth/notes.md"]);
        assert_eq!(
            paths(under("Lib/Auth/token.ts", Within::All)),
            ["Lib/Auth/token.ts"]
        );
        assert!(paths(under("lib/aut", Within::All)).is_empty());
        drop(k);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_is_in_each_of_its_folders() {
        assert_eq!(dirs("App/src/a.rs"), ["app", "app/src", "app/src/a.rs"]);
        assert_eq!(dirs("README.md"), ["readme.md"]);
    }

    #[test]
    fn a_change_removes_a_files_chunks_and_a_clear_empties_it() {
        let dir = scratch();
        let k = Keyword::open(&dir).unwrap();
        k.apply(&Change {
            generation: 1,
            clear: false,
            remove: &[],
            add: vec![doc("a.rs", 0, "open_store", "fn open_store() {}")],
        })
        .unwrap();
        let all = Filter::default();
        let words = search::query_words("store");
        assert_eq!(k.search(&words, 5, all).unwrap().len(), 1);
        k.apply(&Change {
            generation: 2,
            clear: false,
            remove: &["a.rs".to_string()],
            add: vec![],
        })
        .unwrap();
        assert!(k.search(&words, 5, all).unwrap().is_empty());
        k.apply(&Change {
            generation: 3,
            clear: false,
            remove: &[],
            add: vec![doc("b.rs", 0, "store", "fn store() {}")],
        })
        .unwrap();
        k.apply(&Change {
            generation: 4,
            clear: true,
            remove: &[],
            add: vec![],
        })
        .unwrap();
        assert!(k.search(&words, 5, all).unwrap().is_empty());
        assert_eq!(k.generation(), 4);
        drop(k);
        // (reopened: the same generation)
        assert_eq!(Keyword::open(&dir).unwrap().generation(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
