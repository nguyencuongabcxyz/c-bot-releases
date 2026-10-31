//! The repo map (code_map, and the start of each conversation): the definitions that matter
//! most, with their signatures and lines, file by file, within a budget of characters. What
//! matters is what the rest of the code uses, as the code graph has it: files are ranked with
//! PageRank over their calls, constructions, imports and heritage into other files, and each
//! file's rank flows along them to the definitions they reach. A focus (files or names being
//! worked on) tilts the ranking towards them and what they touch.

use super::*;

const DAMPING: f32 = 0.85;
const ROUNDS: usize = 30;

/// What a link says, against a call: a name imported (a type used in signatures, say), a type
/// extended or implemented, a file imported with nothing of it named.
const IMPORTED: f32 = 0.5;
const INHERITED: f32 = 2.0;
const FILE_ONLY: f32 = 0.2;
/// How much of what reaches a member reaches its type.
const OWNER: f32 = 0.5;

/// A link from a file to another, and the definition it reaches there, if one.
struct Edge {
    from: usize,
    to: usize,
    sym: Option<usize>,
    weight: f32,
}

/// The map, in at most about `budget` characters, tilted towards `focus` (paths or names).
pub(super) fn repo_map(g: &Graph, focus: &[String], budget: usize) -> String {
    if g.files.is_empty() {
        return "No code files found here yet.".into();
    }
    let focus_files: HashSet<usize> = (0..g.files.len())
        .filter(|&i| {
            focus
                .iter()
                .any(|f| search::under_path(&g.files[i].path, f))
        })
        .collect();
    let focus_syms: HashSet<usize> = (0..g.syms.len())
        .filter(|&s| {
            focus
                .iter()
                .any(|f| *f == g.syms[s].name || *f == g.syms[s].fqn)
        })
        .collect();
    let tests = g.tests();
    let edges = edges(g, &tests, &focus_files, &focus_syms);
    let rank = page_rank(g.files.len(), &edges, &focus_files);
    let ranked = rank_defs(g, &tests, &edges, &rank, &focus_files);
    render(g, &ranked, budget)
}

fn edges(
    g: &Graph,
    tests: &[bool],
    focus_files: &HashSet<usize>,
    focus_syms: &HashSet<usize>,
) -> Vec<Edge> {
    let edge =
        |from_sym: Option<usize>, from: usize, sym: Option<usize>, to: usize, mut weight: f32| {
            if from == to {
                return None;
            }
            // (a `mod x;` brought in by `use`: the file counts, not the line declaring it)
            let sym = sym.filter(|&s| g.syms[s].kind != Kind::Module);
            if from_sym.is_some_and(|s| tests[s]) {
                weight *= 0.1; // (tests use everything)
            }
            if focus_files.contains(&from) {
                weight *= 20.0;
            }
            if sym.is_some_and(|s| focus_syms.contains(&s)) {
                weight *= 10.0;
            }
            Some(Edge {
                from,
                to,
                sym,
                weight,
            })
        };
    let mut out = vec![];
    for (s, calls) in g.calls_out.iter().enumerate() {
        let from = g.syms[s].file;
        out.extend(calls.iter().filter_map(|e| {
            edge(
                Some(s),
                from,
                Some(e.to),
                g.syms[e.to].file,
                (e.lines.len() as f32).sqrt(),
            )
        }));
    }
    for (s, sups) in g.supers.iter().enumerate() {
        let from = g.syms[s].file;
        out.extend(
            sups.iter()
                .filter_map(|&(t, _)| edge(Some(s), from, Some(t), g.syms[t].file, INHERITED)),
        );
    }
    for from in 0..g.files.len() {
        let named: BTreeSet<usize> = g.imported(from).collect();
        let named_files: HashSet<usize> = named.iter().map(|&s| g.syms[s].file).collect();
        out.extend(
            named
                .iter()
                .filter_map(|&s| edge(None, from, Some(s), g.syms[s].file, IMPORTED)),
        );
        out.extend(
            g.imports[from]
                .iter()
                .filter(|t| !named_files.contains(t))
                .filter_map(|&t| edge(None, from, None, t, FILE_ONLY)),
        );
    }
    out
}

fn page_rank(n: usize, edges: &[Edge], focus: &HashSet<usize>) -> Vec<f32> {
    // where a jump lands: anywhere, or on the focus when there is one
    let start: Vec<f32> = if focus.is_empty() {
        vec![1.0 / n as f32; n]
    } else {
        (0..n)
            .map(|i| {
                if focus.contains(&i) {
                    1.0 / focus.len() as f32
                } else {
                    0.0
                }
            })
            .collect()
    };
    let out_weight = out_weights(n, edges);
    let mut rank = start.clone();
    for _ in 0..ROUNDS {
        // (a file using nothing gives its rank back to where jumps land)
        let dangling: f32 = (0..n)
            .filter(|&i| out_weight[i] == 0.0)
            .map(|i| rank[i])
            .sum();
        let mut next: Vec<f32> = start
            .iter()
            .map(|s| (1.0 - DAMPING + DAMPING * dangling) * s)
            .collect();
        for e in edges {
            next[e.to] += DAMPING * rank[e.from] * e.weight / out_weight[e.from];
        }
        rank = next;
    }
    rank
}

fn out_weights(n: usize, edges: &[Edge]) -> Vec<f32> {
    let mut out = vec![0.0f32; n];
    for e in edges {
        out[e.from] += e.weight;
    }
    out
}

/// The symbols, best first: what flowed to each along the edges (a member's uses count for its
/// type too, a Rust impl's for its struct), and a little of its file's own rank so that files
/// nobody uses still show their top level.
fn rank_defs(
    g: &Graph,
    tests: &[bool],
    edges: &[Edge],
    rank: &[f32],
    focus: &HashSet<usize>,
) -> Vec<usize> {
    let out_weight = out_weights(g.files.len(), edges);
    let mut flowed: HashMap<usize, f32> = HashMap::new();
    for e in edges {
        if let Some(s) = e.sym {
            let flow = rank[e.from] * e.weight / out_weight[e.from];
            *flowed.entry(s).or_default() += flow;
            if let Some(ty) = g.owner_of(s) {
                *flowed.entry(ty).or_default() += flow * OWNER;
            }
        }
    }
    let mut scored: Vec<(f32, usize)> = vec![];
    for (fi, file) in g.files.iter().enumerate() {
        let own = rank[fi] / file.syms.len().max(1) as f32;
        for s in file.syms.clone() {
            let top_level = g.syms[s].parent.is_none();
            let mut score =
                flowed.get(&s).copied().unwrap_or(0.0) + own * if top_level { 0.1 } else { 0.02 };
            if focus.contains(&fi) && top_level {
                score += 1.0; // (the focus files show what they define)
            }
            if tests[s] {
                score *= 0.05;
            }
            scored.push((score, s));
        }
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, s)| s).collect()
}

/// The chosen symbols, file by file (in path order), each with the ones holding it.
fn render(g: &Graph, ranked: &[usize], budget: usize) -> String {
    let mut chosen: BTreeMap<usize, BTreeSet<usize>> = BTreeMap::new();
    let mut size = 0;
    for &s in ranked {
        let fi = g.syms[s].file;
        let mut cost = 0;
        if !chosen.contains_key(&fi) {
            cost += g.files[fi].path.len() + 1;
        }
        let picked = chosen.get(&fi);
        let with_holders = holders(g, s);
        for &h in &with_holders {
            if !picked.is_some_and(|p| p.contains(&h)) {
                cost += sym_line(g, h).len() + 1;
            }
        }
        if size + cost > budget {
            if size > budget / 2 {
                break;
            }
            continue;
        }
        size += cost;
        chosen.entry(fi).or_default().extend(with_holders);
    }
    let mut out = String::new();
    for (fi, syms) in chosen {
        out.push_str(&g.files[fi].path);
        out.push('\n');
        for s in syms {
            out.push_str(&sym_line(g, s));
            out.push('\n');
        }
    }
    out
}

/// A symbol and those holding it (its class, impl, module), outermost first.
fn holders(g: &Graph, s: usize) -> Vec<usize> {
    let mut v = vec![s];
    let mut at = s;
    while let Some(p) = g.syms[at].parent {
        v.push(p);
        at = p;
    }
    v.reverse();
    v
}

/// A symbol's line of the map, as `line_of` writes a definition's.
fn sym_line(g: &Graph, s: usize) -> String {
    let sym = &g.syms[s];
    let depth = holders(g, s).len() - 1;
    format!("{:>6}│ {}{}", sym.line, "  ".repeat(depth), sym.sig)
}

/// One line of the map: where, then the signature, indented by how deep it is.
pub(super) fn line_of(d: &Def) -> String {
    format!("{:>6}│ {}{}", d.line, "  ".repeat(d.depth as usize), d.sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(files: &[(&str, &str)]) -> Graph {
        let mut code = Code::default();
        for (rel, src) in files {
            code.put(
                rel,
                FileType::Code(Lang::Rust),
                parse::read(Lang::Rust, src).unwrap(),
            );
        }
        Graph::build(&code, Path::new("no such folder"))
    }

    fn shop() -> Graph {
        graph(&[
            (
                "src/store.rs",
                "pub struct OrderStore {}\nimpl OrderStore {\n    pub fn open_store() -> OrderStore { OrderStore {} }\n    fn unused_helper() {}\n}\n",
            ),
            (
                "src/api.rs",
                "use crate::store::OrderStore;\npub fn get_orders() { let s = OrderStore::open_store(); }\n",
            ),
            (
                "src/jobs.rs",
                "use crate::store::OrderStore;\nuse crate::api::get_orders;\npub fn nightly() { let s = OrderStore::open_store(); get_orders(); }\n",
            ),
            ("src/misc.rs", "pub fn lonely_function() {}\n"),
        ])
    }

    #[test]
    fn what_the_rest_uses_comes_first_with_what_holds_it() {
        let map = repo_map(&shop(), &[], 120);
        assert_eq!(
            map,
            "src/store.rs\n     1│ pub struct OrderStore\n     2│ impl OrderStore\n     3│   pub fn open_store() -> OrderStore\n"
        );
    }

    #[test]
    fn a_bigger_budget_shows_the_rest_in_path_order() {
        let map = repo_map(&shop(), &[], 10_000);
        let files: Vec<&str> = map.lines().filter(|l| !l.starts_with(' ')).collect();
        assert_eq!(
            files,
            ["src/api.rs", "src/jobs.rs", "src/misc.rs", "src/store.rs"]
        );
        assert!(map.contains("fn unused_helper()"));
    }

    #[test]
    fn a_focus_shows_its_own_file_first() {
        let map = repo_map(&shop(), &["src/misc.rs".into()], 60);
        assert_eq!(map, "src/misc.rs\n     1│ pub fn lonely_function()\n");
    }

    #[test]
    fn only_resolved_uses_count_not_a_name_alike() {
        // (both define `open`; only the store's is called)
        let g = graph(&[
            (
                "src/store.rs",
                "pub struct Store {}\nimpl Store {\n    pub fn open(&self) {}\n}\n",
            ),
            (
                "src/door.rs",
                "pub struct Door {}\nimpl Door {\n    pub fn open(&self) {}\n}\n",
            ),
            (
                "src/main.rs",
                "use crate::store::Store;\nfn main() {\n    let s = Store {};\n    s.open();\n}\n",
            ),
        ]);
        let none = HashSet::new();
        let tests = g.tests();
        let edges = edges(&g, &tests, &none, &none);
        let rank = page_rank(g.files.len(), &edges, &none);
        let ranked = rank_defs(&g, &tests, &edges, &rank, &none);
        let top: Vec<&str> = ranked[..2]
            .iter()
            .map(|&s| g.syms[s].fqn.as_str())
            .collect();
        assert_eq!(top, ["src.store.Store", "src.store.Store.open"]);
    }
}
