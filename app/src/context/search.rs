//! Finding code (search_code). Three lanes look for the question, each ranking chunks its own
//! way: the symbol lane takes a name the question says to where it's defined; the keyword lane
//! (keyword.rs, BM25) finds the words, a name's parts included (getUserById is also get, user,
//! by, id) and stems (dragged: drag); the meaning lane (vectors.rs) finds what's about the same
//! thing in other words. Each lane looks only where it's asked to (a folder, code or docs:
//! Filter), so a narrow search still gets a full ranking. Their rankings are fused (reciprocal
//! rank fusion), each result keeping the lanes that found it, and come at most PER_FILE from one
//! file, so the rest of the folder gets a say. Then the reranker (embed/rerank.rs) reads the
//! question with each of the best POOL and puts them in order.

use super::*;

const PER_FILE: usize = 2;
/// How many of the fused results the reranker reads. (Measured on questions about C-Bot's own
/// code with known answers: 20 found the most in the first five; past that, more look-alikes
/// outrank the answer, and each costs the reranker time.)
pub(super) const POOL: usize = 20;
/// How much a result's place in the fused ranking counts beside the reranker's score
/// (FUSED_PRIOR / (1 + place)), so a near tie goes the lanes' way.
const FUSED_PRIOR: f32 = 1.0;
/// How far down each lane's ranking goes…
pub(super) const LANE_DEPTH: usize = 50;
/// …and how much a rank counts in the fusion: 1 / (RRF_K + rank).
const RRF_K: f64 = 60.0;
/// How much more the meaning lane counts for a question in plain words. (Measured on questions
/// about C-Bot's own code with known answers: in plain words, leaving names out and meaning
/// doubled put the right file first 50% of the time instead of 31%; questions with names in them
/// don't change.)
const PLAIN_MEANING: f64 = 2.0;

/// What search_code looks in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Within {
    Code,
    Docs,
    #[default]
    All,
}

impl Within {
    pub(super) fn of(s: &str) -> Within {
        match s {
            "code" => Within::Code,
            "docs" => Within::Docs,
            _ => Within::All,
        }
    }

    pub(super) fn takes(self, code: bool) -> bool {
        match self {
            Within::Code => code,
            Within::Docs => !code,
            Within::All => true,
        }
    }
}

/// Where search_code looks: under a folder or at a file ('' for anywhere), in code, docs or
/// both.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Filter<'a> {
    pub under: &'a str,
    pub within: Within,
}

impl Filter<'_> {
    pub(super) fn keeps(self, path: &str, code: bool) -> bool {
        under_path(path, self.under) && self.within.takes(code)
    }

    /// It keeps everything.
    pub(super) fn all(self) -> bool {
        self.under.trim_matches('/').is_empty() && self.within == Within::All
    }
}

/// A chunk found, by (path, chunk index), with the lanes that found it.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Ranked {
    pub path: String,
    pub idx: i32,
    pub lanes: Vec<&'static str>,
}

/// A question in plain words rather than names: three words or more, none written as code
/// would be (a capital inside or first, `_`, `.`, `::`).
pub(super) fn plain(query: &str) -> bool {
    let words: Vec<&str> = query.split_whitespace().collect();
    let named = |w: &&str| {
        w.contains(['_', '.']) || w.chars().next().is_some_and(char::is_uppercase) || {
            let c: Vec<char> = w.chars().collect();
            c.windows(2)
                .any(|p| p[0].is_lowercase() && p[1].is_uppercase())
        }
    };
    words.len() >= 3 && !words.iter().any(named)
}

/// The lanes' rankings, fused: best first, at most PER_FILE from a file, `limit` in all. For a
/// question in plain words, the symbol lane stays out (its plain words name whatever is called
/// `text` or `open`) and meaning counts more.
pub(super) fn fuse(
    lanes: &[(&'static str, Vec<(String, i32)>)],
    plain: bool,
    limit: usize,
) -> Vec<Ranked> {
    let mut scored: Vec<(f64, Ranked)> = vec![];
    let mut at: HashMap<(String, i32), usize> = HashMap::new();
    for (lane, ranking) in lanes {
        let weight = match (*lane, plain) {
            ("symbol", true) => continue,
            ("vector", true) => PLAIN_MEANING,
            _ => 1.0,
        };
        for (rank, key) in ranking.iter().enumerate() {
            let add = weight / (RRF_K + rank as f64 + 1.0);
            match at.get(key) {
                Some(&i) => {
                    scored[i].0 += add;
                    if !scored[i].1.lanes.contains(lane) {
                        scored[i].1.lanes.push(lane);
                    }
                }
                None => {
                    at.insert(key.clone(), scored.len());
                    let r = Ranked {
                        path: key.0.clone(),
                        idx: key.1,
                        lanes: vec![lane],
                    };
                    scored.push((add, r));
                }
            }
        }
    }
    // (stable: equal scores keep the order they were first seen in)
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut per_file: HashMap<String, usize> = HashMap::new();
    scored
        .into_iter()
        .map(|(_, r)| r)
        .filter(|r| {
            let n = per_file.entry(r.path.clone()).or_default();
            *n += 1;
            *n <= PER_FILE
        })
        .take(limit)
        .collect()
}

/// The fused results (best first) in the reranker's order, `limit` of them; `scores` are its,
/// one for each.
pub(super) fn rerank(found: Vec<Ranked>, scores: &[f32], limit: usize) -> Vec<Ranked> {
    let mut scored: Vec<(f32, Ranked)> = found
        .into_iter()
        .zip(scores)
        .enumerate()
        .map(|(place, (r, s))| (s + FUSED_PRIOR / (1.0 + place as f32), r))
        .collect();
    // (stable: equal scores keep the lanes' order)
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.into_iter().map(|(_, r)| r).take(limit).collect()
}

/// The chunks the reranker needs: each result's, and its file's first three (its opening:
/// rerank_texts).
pub(super) fn rerank_keys(found: &[Ranked]) -> Vec<(String, i32)> {
    let mut keys: Vec<(String, i32)> = found.iter().map(|r| (r.path.clone(), r.idx)).collect();
    for r in found {
        for idx in 0..3 {
            let k = (r.path.clone(), idx);
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    keys
}

/// A file's opening (embed::opening), from its first chunks among these.
pub(super) fn opening_of(path: &str, chunks: &HashMap<(String, i32), StoredChunk>) -> String {
    let first: Vec<&str> = (0..3)
        .map_while(|idx| {
            chunks
                .get(&(path.to_string(), idx))
                .map(|c| c.text.as_str())
        })
        .collect();
    embed::opening(path, &first)
}

/// What the reranker reads of each result: what its vector is made of (embed::input_of).
pub(super) fn rerank_texts(
    found: &[Ranked],
    chunks: &HashMap<(String, i32), StoredChunk>,
) -> Vec<String> {
    found
        .iter()
        .map(|r| {
            let first = opening_of(&r.path, chunks);
            chunks
                .get(&(r.path.clone(), r.idx))
                .map(|c| embed::input_of(&c.path, c.idx, &first, &c.symbol, &c.text))
                .unwrap_or_default()
        })
        .collect()
}

/// The keyword lane.
pub(super) fn keyword_lane(
    keyword: &Keyword,
    query: &str,
    filter: Filter,
) -> Result<Vec<(String, i32)>, Error> {
    let hits = keyword.search(&query_words(query), LANE_DEPTH, filter)?;
    Ok(hits.into_iter().map(|h| (h.path, h.idx)).collect())
}

/// The symbol lane's targets: where each name the question says (Store, open_store, the parts
/// of Store.open) is defined, best first (the name as written before another case, a type or
/// function before a field or constant), as (path, line).
pub(super) fn symbol_targets(code: &Code, query: &str, filter: Filter) -> Vec<(String, u32)> {
    let names: Vec<&str> = query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| w.chars().count() >= 3)
        .collect();
    let mut found: Vec<(u8, &String, &Def)> = vec![];
    for (path, file) in code.files.iter().filter(|(p, _)| filter.keeps(p, true)) {
        // (not an impl: it's named after its type, which is there already)
        for d in file.defs.iter().filter(|d| d.kind != Kind::Impl) {
            // (a plain word only names what's spelled exactly so: "keep" isn't KEEP)
            let named = |n: &&&str| {
                if n.chars().all(|c| c.is_lowercase()) {
                    d.name == **n
                } else {
                    d.name.eq_ignore_ascii_case(n)
                }
            };
            let Some(name) = names.iter().find(named) else {
                continue;
            };
            let other_case = u8::from(d.name != *name);
            let member = u8::from(matches!(d.kind, Kind::Property | Kind::Const));
            found.push((other_case * 2 + member, path, d));
        }
    }
    found.sort_by_key(|(rank, path, d)| (*rank, d.depth, *path, d.line));
    found
        .into_iter()
        .take(LANE_DEPTH)
        .map(|(_, path, d)| (path.clone(), d.line))
        .collect()
}
/// Words a question is made of that say nothing about code.
const STOP: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in",
    "is", "it", "of", "on", "or", "the", "this", "that", "to", "what", "where", "which", "who",
    "with",
];

/// The words of some text as the search knows them (each once per name, in order), and the
/// stem of each that has one (dragged, dragging: drag).
pub(super) fn words(text: &str, mut out: impl FnMut(String)) {
    let mut emit = |w: &str| {
        let lower = w.to_lowercase();
        if lower.chars().count() >= 2 && !lower.chars().all(|c| c.is_ascii_digit()) {
            let stem = stem(&lower);
            out(lower);
            if let Some(stem) = stem {
                out(stem);
            }
        }
    };
    for name in text.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        if name.is_empty() {
            continue;
        }
        emit(name);
        let parts = parts(name);
        if parts.len() > 1 {
            parts.iter().for_each(|p| emit(p));
        }
    }
}

/// An English word without its ending, roughly (so handle, handles, handled and handling all
/// meet at handl); None when it has none to lose.
fn stem(w: &str) -> Option<String> {
    if w.len() < 5 || !w.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let base = ["ing", "ed", "es"]
        .iter()
        .find_map(|e| w.strip_suffix(e))
        .or_else(|| w.strip_suffix('s').filter(|b| !b.ends_with('s')))
        .or_else(|| w.strip_suffix('e'))?;
    let b = base.as_bytes();
    // (a doubled last letter, as in dragged, is one: but fill and pass keep theirs)
    let base = match b {
        [.., x, y] if x == y && !b"lsz".contains(y) => &base[..base.len() - 1],
        _ => base,
    };
    (base.len() >= 3).then(|| base.to_string())
}

/// A name's parts: split at _ and where camelCase changes (HTTPServer: HTTP, Server).
fn parts(name: &str) -> Vec<&str> {
    let mut out = vec![];
    for piece in name.split('_').filter(|p| !p.is_empty()) {
        let chars: Vec<(usize, char)> = piece.char_indices().collect();
        let mut from = 0;
        for i in 1..chars.len() {
            let (prev, cur) = (chars[i - 1].1, chars[i].1);
            let next_lower = chars.get(i + 1).is_some_and(|(_, c)| c.is_lowercase());
            let lower_to_upper =
                (prev.is_lowercase() || prev.is_ascii_digit()) && cur.is_uppercase();
            let acronym_end = prev.is_uppercase() && cur.is_uppercase() && next_lower;
            if lower_to_upper || acronym_end {
                out.push(&piece[from..chars[i].0]);
                from = chars[i].0;
            }
        }
        out.push(&piece[from..]);
    }
    out
}

/// The words of a question, without the ones that say nothing (unless that's all it has).
pub(super) fn query_words(query: &str) -> Vec<String> {
    let mut all = vec![];
    words(query, |w| {
        if !all.contains(&w) {
            all.push(w);
        }
    });
    let stop: Vec<String> = STOP
        .iter()
        .flat_map(|s| [Some(s.to_string()), stem(s)])
        .flatten()
        .collect();
    let kept: Vec<String> = all.iter().filter(|w| !stop.contains(w)).cloned().collect();
    if kept.is_empty() { all } else { kept }
}

/// A path is under a folder (or is the file) asked for ('' for anywhere).
pub(super) fn under_path(rel: &str, under: &str) -> bool {
    let under = under.trim_matches('/');
    under.is_empty()
        || rel.eq_ignore_ascii_case(under)
        || (rel.len() > under.len()
            && rel.as_bytes()[under.len()] == b'/'
            && rel[..under.len()].eq_ignore_ascii_case(under))
}
#[cfg(test)]
mod tests {
    use super::*;

    fn all_words(text: &str) -> Vec<String> {
        let mut v = vec![];
        words(text, |w| v.push(w));
        v
    }
    #[test]
    fn names_are_words_whole_and_in_parts() {
        assert_eq!(
            all_words("getUserById(x) HTTPServer snake_case_name 42 a"),
            [
                "getuserbyid",
                "get",
                "user",
                "by",
                "id",
                "httpserver",
                "http",
                "server",
                "snake_case_name",
                "snake",
                "snak",
                "case",
                "name"
            ]
        );
        assert_eq!(all_words("đăng nhập"), ["đăng", "nhập"]);
    }

    #[test]
    fn words_meet_at_their_stems() {
        let stems = |ws: &[&str]| ws.iter().map(|w| stem(w)).collect::<Vec<_>>();
        let some = |s: &str| Some(s.to_string());
        assert_eq!(
            stems(&["handle", "handles", "handled", "handling"]),
            [some("handl"), some("handl"), some("handl"), some("handl")]
        );
        assert_eq!(
            stems(&["dragged", "dragging", "robots", "filled"]),
            [some("drag"), some("drag"), some("robot"), some("fill")]
        );
        assert_eq!(
            stems(&["drag", "class", "parser", "Users"]),
            [None, None, None, None]
        );
    }

    #[test]
    fn a_question_drops_the_words_that_say_nothing() {
        assert_eq!(
            query_words("where is the login handled"),
            ["login", "handled", "handl"]
        );
        assert_eq!(query_words("the"), ["the"]);
        assert_eq!(
            query_words("parseConfig parse"),
            ["parseconfig", "parse", "pars", "config"]
        );
    }

    #[test]
    fn paths_are_under_their_folders_only() {
        assert!(under_path("src/a.ts", ""));
        assert!(under_path("src/a.ts", "src"));
        assert!(under_path("src/a.ts", "SRC/"));
        assert!(under_path("src/a.ts", "src/a.ts"));
        assert!(!under_path("srcx/a.ts", "src"));
        assert!(!under_path("src", "src/a.ts"));
    }
    #[test]
    fn results_come_at_most_two_from_a_file() {
        let lanes = [("bm25", keys(&[("a", 0), ("a", 1), ("a", 2), ("b", 0)]))];
        let got: Vec<(String, i32)> = fuse(&lanes, false, 3)
            .into_iter()
            .map(|r| (r.path, r.idx))
            .collect();
        assert_eq!(got, keys(&[("a", 0), ("a", 1), ("b", 0)]));
    }

    fn keys(v: &[(&str, i32)]) -> Vec<(String, i32)> {
        v.iter().map(|(p, i)| ((*p).to_string(), *i)).collect()
    }

    #[test]
    fn lanes_are_fused_and_what_several_found_comes_first() {
        let lanes = [
            ("bm25", keys(&[("a", 0), ("b", 0), ("c", 0)])),
            ("vector", keys(&[("c", 0), ("d", 0), ("a", 0)])),
        ];
        let got: Vec<(String, Vec<&str>)> = fuse(&lanes, false, 10)
            .into_iter()
            .map(|r| (r.path, r.lanes))
            .collect();
        let s = |p: &str| p.to_string();
        assert_eq!(
            got,
            [
                (s("a"), vec!["bm25", "vector"]),
                (s("c"), vec!["bm25", "vector"]),
                (s("b"), vec!["bm25"]),
                (s("d"), vec!["vector"]),
            ]
        );
    }

    #[test]
    fn questions_in_plain_words_are_told_from_names() {
        assert!(plain("keep the computer awake"));
        assert!(plain("giữ máy tính không ngủ"));
        assert!(!plain("drag window"));
        assert!(!plain("where is getUserById called"));
        assert!(!plain("open_store and its callers"));
        assert!(!plain("Store open method"));
        assert!(!plain("what calls store.open"));
    }

    #[test]
    fn in_plain_words_meaning_leads_and_names_stay_out() {
        let lanes = [
            ("symbol", keys(&[("named", 0)])),
            ("bm25", keys(&[("a", 0), ("b", 0)])),
            ("vector", keys(&[("b", 0), ("a", 0)])),
        ];
        let paths = |plain: bool| -> Vec<String> {
            fuse(&lanes, plain, 10)
                .into_iter()
                .map(|r| r.path)
                .collect()
        };
        assert_eq!(paths(false), ["a", "b", "named"]);
        assert_eq!(paths(true), ["b", "a"]);
    }

    #[test]
    fn a_name_the_question_says_goes_to_where_it_is_defined() {
        let mut code = Code::default();
        let facts = |src: &str| parse::read(Lang::Rust, src).unwrap();
        code.put(
            "src/store.rs",
            FileType::Code(Lang::Rust),
            facts("pub struct Store {}\nimpl Store {\n    fn open() {}\n}\n"),
        );
        code.put(
            "src/other.rs",
            FileType::Code(Lang::Rust),
            facts("fn store() {}\nconst OPEN: u32 = 1;\n"),
        );
        let all = Filter::default();
        let at = |p: &str, l: u32| (p.to_string(), l);
        // (Store as written first, then store in another case; "open" is a plain word: open only)
        assert_eq!(
            symbol_targets(&code, "where does Store open?", all),
            [
                at("src/store.rs", 1),
                at("src/store.rs", 3),
                at("src/other.rs", 1)
            ]
        );
        assert_eq!(
            symbol_targets(&code, "the OPEN flag", all),
            [at("src/other.rs", 2), at("src/store.rs", 3)]
        );
        assert!(symbol_targets(&code, "a an of", all).is_empty());
        let other = Filter {
            under: "src/other.rs",
            within: Within::All,
        };
        assert_eq!(
            symbol_targets(&code, "the OPEN flag", other),
            [at("src/other.rs", 2)]
        );
    }

    #[test]
    fn search_looks_in_code_docs_or_both() {
        assert_eq!(Within::of("code"), Within::Code);
        assert_eq!(Within::of(""), Within::All);
        assert!(Within::Docs.takes(false) && !Within::Docs.takes(true));
    }

    #[test]
    fn a_filter_keeps_a_folder_and_a_kind() {
        let docs = Filter {
            under: "docs/",
            within: Within::Docs,
        };
        assert!(docs.keeps("docs/a.md", false));
        assert!(!docs.keeps("docs/a.rs", true));
        assert!(!docs.keeps("src/a.md", false));
        assert!(!docs.all());
        assert!(Filter::default().all());
        assert!(
            Filter {
                under: "/",
                within: Within::All
            }
            .all()
        );
    }

    #[test]
    fn the_reranker_orders_and_a_near_tie_goes_the_lanes_way() {
        let r = |p: &str| Ranked {
            path: p.into(),
            idx: 0,
            lanes: vec!["bm25"],
        };
        let paths = |v: Vec<Ranked>| v.into_iter().map(|r| r.path).collect::<Vec<_>>();
        let found = || vec![r("a"), r("b"), r("c")];
        // (c is clearly best; a and b are nearly tied, and a was first)
        assert_eq!(
            paths(rerank(found(), &[1.0, 1.1, 5.0], 10)),
            ["c", "a", "b"]
        );
        assert_eq!(paths(rerank(found(), &[1.0, 1.1, 5.0], 1)), ["c"]);
        // (well apart, the reranker wins)
        assert_eq!(
            paths(rerank(found(), &[-3.0, 2.0, -5.0], 10)),
            ["b", "a", "c"]
        );
    }
}
