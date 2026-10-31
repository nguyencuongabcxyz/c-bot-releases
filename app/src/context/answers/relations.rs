//! What the tools that walk the code graph answer: where something is defined (its full name,
//! its lines, its signature, how many call it), who calls it (each call's line, in what), the
//! chain of calls from one to another, a file's imports and importers, a type's lineage and a
//! method's overrides, and what changing something would touch.

use super::*;

const TARGETS: usize = 5;
const CALLS_SHOWN: usize = 80;
const TESTS_SHOWN: usize = 20;

/// A symbol in a line: its kind, full name, where.
fn named(g: &Graph, s: usize) -> String {
    let sym = &g.syms[s];
    format!(
        "{} {} — {}:{}-{}",
        sym.kind.word(),
        sym.fqn,
        g.path(s),
        sym.line,
        sym.end
    )
}

/// Each file's lines, read once.
#[derive(Default)]
struct Lines {
    files: HashMap<String, Vec<String>>,
}

impl Lines {
    fn get(&mut self, root: &Path, path: &str, line: u32) -> String {
        let lines = self.files.entry(path.to_string()).or_insert_with(|| {
            std::fs::read_to_string(root.join(path))
                .map(|t| t.lines().map(str::to_string).collect())
                .unwrap_or_default()
        });
        lines
            .get(line as usize - 1)
            .map_or(String::new(), |l| parse::cut(l.trim(), 160))
    }
}

// ---------------------------------------------------------------- find_symbol

/// Where something is defined, best first (its full name, a name it ends, its name…).
pub(in crate::context) fn find(
    g: &Graph,
    root: &Path,
    query: &str,
    kind: &str,
    body: bool,
) -> String {
    let found = g.resolve_name(query, kind);
    if found.is_empty() {
        return format!(
            "Nothing named \"{query}\" is defined here. Try search_code to find it by words."
        );
    }
    let mut out = String::new();
    for (i, &s) in found.iter().take(FIND_MAX).enumerate() {
        let sym = &g.syms[s];
        let callers = g.calls_in[s].len();
        let used = if callers > 0 {
            format!("   ({callers} callers)")
        } else {
            String::new()
        };
        out.push_str(&format!("{}{used}\n  {}\n", named(g, s), sym.sig));
        if body && i < BODIES {
            out.push_str(&body_of(root, g.path(s), sym.line, sym.end));
        }
    }
    if found.len() > FIND_MAX {
        out.push_str(&format!(
            "… and {} more: be more exact (Holder.name, a full name), or give a kind.\n",
            found.len() - FIND_MAX
        ));
    }
    out
}

// ---------------------------------------------------------------- find_references

/// Who calls what a name means, up to `depth` calls away (under `under`), each call with its
/// line and what it's in; then the other places the name appears that aren't resolved to it.
pub(in crate::context) fn references(
    g: &Graph,
    code: &Code,
    root: &Path,
    query: &str,
    under: &str,
    depth: usize,
) -> String {
    let targets: Vec<usize> = g
        .resolve_name(query, "")
        .into_iter()
        .take(TARGETS)
        .collect();
    if targets.is_empty() {
        return name_uses(code, root, query, under);
    }
    let mut lines = Lines::default();
    let mut out = String::new();
    let mut resolved = HashSet::new();
    let mut shown = 0;
    for &t in &targets {
        let callers = g.callers(t, depth.max(1), &|p| !search::under_path(p, under));
        let through = g.dispatched_through(t);
        out.push_str(&format!("{}\n", named(g, t)));
        if callers.is_empty() {
            out.push_str("  no calls found to it\n\n");
            continue;
        }
        out.push_str(&format!(
            "  {} callers{}:\n",
            callers.len(),
            if depth > 1 {
                format!(" (up to {depth} calls away)")
            } else {
                String::new()
            }
        ));
        for r in &callers {
            let caller = &g.syms[r.sym];
            let path = g.path(r.sym).to_string();
            for &l in &r.lines {
                resolved.insert((path.clone(), l));
            }
            if shown >= CALLS_SHOWN {
                continue;
            }
            shown += 1;
            let at = r.lines.first().copied().unwrap_or(caller.line);
            let indent = "  ".repeat(r.depth);
            let calls = if r.via == t {
                String::new()
            } else if through.contains(&r.via) {
                format!(" (through {})", g.syms[r.via].fqn)
            } else {
                format!(" → {}", g.syms[r.via].name)
            };
            out.push_str(&format!("{indent}{path}:{at}  in {}{calls}\n", caller.fqn));
            out.push_str(&format!("{indent}  {}\n", lines.get(root, &path, at)));
        }
        out.push('\n');
    }
    if shown >= CALLS_SHOWN {
        out.push_str("(more callers than shown: give a path to narrow it)\n");
    }
    let name = g.syms[targets[0]].name.clone();
    out.push_str(&unresolved(code, root, &name, under, &resolved));
    out
}

/// The places a name appears that the graph didn't resolve to what it means (other things of
/// that name, or calls the syntax can't follow), in short.
fn unresolved(
    code: &Code,
    root: &Path,
    name: &str,
    under: &str,
    resolved: &HashSet<(String, u32)>,
) -> String {
    let mut lines: Vec<(String, u32, String)> = vec![];
    for (path, lang) in users(code, name, under) {
        let Some(text) = ingest::read_code(&root.join(&path)) else {
            continue;
        };
        let Some(facts) = parse::read_for(lang, &text, Some(name)) else {
            continue;
        };
        let all: Vec<&str> = text.lines().collect();
        for l in facts.uses {
            if !resolved.contains(&(path.clone(), l)) {
                let code = all.get(l as usize - 1).map_or("", |s| s.trim());
                lines.push((path.clone(), l, parse::cut(code, 160)));
            }
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "Other places \"{name}\" appears, not resolved to the above ({}):\n",
        lines.len()
    );
    for (path, l, code) in lines.iter().take(30) {
        out.push_str(&format!("  {path}:{l}  {code}\n"));
    }
    out
}

// ---------------------------------------------------------------- call_chain

/// The shortest chain of calls from one symbol to another.
pub(in crate::context) fn chain(g: &Graph, from: &str, to: &str, depth: usize) -> String {
    let (Some(&a), Some(&b)) = (
        g.resolve_name(from, "function").first(),
        g.resolve_name(to, "").first(),
    ) else {
        return format!(
            "Couldn't find both \"{from}\" and \"{to}\": try find_symbol for their full names."
        );
    };
    let Some(path) = g.chain(a, b, depth) else {
        return format!(
            "No chain of calls from {} to {} within {depth} calls.",
            g.syms[a].fqn, g.syms[b].fqn
        );
    };
    let mut out = format!(
        "{} calls from {} to {}:\n",
        path.len() - 1,
        g.syms[a].fqn,
        g.syms[b].fqn
    );
    for (i, &s) in path.iter().enumerate() {
        let line = i
            .checked_sub(1)
            .and_then(|p| g.calls_out[path[p]].iter().find(|e| e.to == s))
            .and_then(|e| e.lines.first())
            .map(|l| format!("  (called at {}:{l})", g.path(path[i - 1])))
            .unwrap_or_default();
        out.push_str(&format!("{}{}{line}\n", "  ".repeat(i), named(g, s)));
    }
    out
}

// ---------------------------------------------------------------- file_dependencies

/// What a file imports and/or what imports it, to a depth; with no file, the packages from
/// outside that the folder's code imports, most used first.
pub(in crate::context) fn dependencies(
    g: &Graph,
    path: &str,
    direction: &str,
    depth: usize,
) -> String {
    if path.is_empty() {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for e in &g.externals {
            for p in e {
                *counts.entry(p).or_default() += 1;
            }
        }
        let mut list: Vec<(&str, usize)> = counts.into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let mut out = format!(
            "{} packages from outside the folder, by how many files import each:\n",
            list.len()
        );
        for (p, n) in list.iter().take(150) {
            out.push_str(&format!("  {p}  ({n})\n"));
        }
        return out;
    }
    let Some(f) = g.file_of(path) else {
        return format!("There's no code file \"{path}\" here.");
    };
    let mut out = String::new();
    for (forward, wanted, title) in [
        (true, "imports", "imports"),
        (false, "dependents", "is imported by"),
    ] {
        if direction != "both" && direction != wanted {
            continue;
        }
        let list = g.file_closure(f, forward, depth.max(1));
        out.push_str(&format!(
            "{} {title} {} files:\n",
            g.files[f].path,
            list.len()
        ));
        for (file, d) in list.iter().take(200) {
            out.push_str(&format!("{}{}\n", "  ".repeat(*d), g.files[*file].path));
        }
        if forward && !g.externals[f].is_empty() {
            let ext: Vec<&str> = g.externals[f].iter().map(String::as_str).collect();
            out.push_str(&format!("  and from outside: {}\n", ext.join(", ")));
        }
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------- type_hierarchy

/// A type's supertypes and subtypes; for a method, what overrides it and what it overrides.
pub(in crate::context) fn hierarchy(g: &Graph, query: &str, direction: &str) -> String {
    let Some(&s) = g.resolve_name(query, "").first() else {
        return format!("Nothing named \"{query}\" is defined here.");
    };
    let mut out = format!("{}\n", named(g, s));
    if g.syms[s].kind.fits("function") {
        let (below, above) = g.overrides(s);
        for (title, list) in [("overridden by", below), ("overrides", above)] {
            out.push_str(&format!("  {title} {}:\n", list.len()));
            for m in list {
                out.push_str(&format!("    {}\n", named(g, m)));
            }
        }
        return out;
    }
    for (up, wanted, title) in [(true, "up", "supertypes"), (false, "down", "subtypes")] {
        if direction != "both" && direction != wanted {
            continue;
        }
        let list = g.lineage(s, up);
        out.push_str(&format!("  {title} {}:\n", list.len()));
        for (t, d, kind) in list {
            out.push_str(&format!(
                "  {}{:?}: {}\n",
                "  ".repeat(d),
                kind,
                named(g, t)
            ));
        }
    }
    out
}

// ---------------------------------------------------------------- change_impact

/// What changing a symbol or a file would touch: its callers (to `depth`), overrides,
/// subtypes and supertypes; for a file, the files importing it and the callers of what it
/// defines from elsewhere. With a level: low (under 5 places), medium (under 20), high.
pub(in crate::context) fn impact(g: &Graph, target: &str, depth: usize) -> String {
    if let Some(f) = g.file_of(target) {
        return file_impact(g, f, depth);
    }
    let Some(&s) = g.resolve_name(target, "").first() else {
        return format!("Nothing named \"{target}\" is defined here, and no file of that path.");
    };
    // (tests call everything: they're counted apart, and don't make a change riskier)
    let tests = g.tests();
    let (in_tests, callers): (Vec<_>, Vec<_>) = g
        .callers(s, depth.max(1), &|_| false)
        .into_iter()
        .partition(|r| tests[r.sym]);
    let (below, above) = g.overrides(s);
    let subtypes = g.lineage(s, false);
    let supertypes = g.lineage(s, true);
    let touched = callers.len() + below.len() + subtypes.len();
    let files: BTreeSet<&str> = callers.iter().map(|r| g.path(r.sym)).collect();
    let mut out = format!(
        "{}\nimpact: {} ({} callers in {} files up to {} calls away, {} in tests; {} overriding methods, {} subtypes)\n\n",
        named(g, s),
        level(touched),
        callers.len(),
        files.len(),
        depth.max(1),
        in_tests.len(),
        below.len(),
        subtypes.len()
    );
    for r in callers.iter().take(CALLS_SHOWN) {
        out.push_str(&format!("{}{}\n", "  ".repeat(r.depth), named(g, r.sym)));
    }
    if !in_tests.is_empty() {
        out.push_str("in tests:\n");
        for r in in_tests.iter().take(TESTS_SHOWN) {
            out.push_str(&format!("  {}\n", named(g, r.sym)));
        }
    }
    for (title, list) in [("overridden by", below), ("overrides", above)] {
        if !list.is_empty() {
            out.push_str(&format!("{title}:\n"));
            out.extend(list.into_iter().map(|m| format!("  {}\n", named(g, m))));
        }
    }
    for (title, list) in [("subtypes", subtypes), ("supertypes", supertypes)] {
        if !list.is_empty() {
            out.push_str(&format!("{title}:\n"));
            out.extend(
                list.into_iter()
                    .map(|(t, _, _)| format!("  {}\n", named(g, t))),
            );
        }
    }
    out
}

fn file_impact(g: &Graph, f: usize, depth: usize) -> String {
    let dependents = g.file_closure(f, false, depth.max(1));
    let tests = g.tests();
    let mut callers: BTreeSet<usize> = BTreeSet::new();
    let mut in_tests = 0;
    for s in g.files[f].syms.clone() {
        for c in g.calls_in[s]
            .iter()
            .map(|e| e.to)
            .filter(|&c| g.syms[c].file != f)
        {
            if tests[c] {
                in_tests += 1;
            } else {
                callers.insert(c);
            }
        }
    }
    let mut out = format!(
        "{}\nimpact: {} ({} files import it, up to {} away; {} callers elsewhere of what it defines, and {} calls from tests)\n\n",
        g.files[f].path,
        level(dependents.len() + callers.len()),
        dependents.len(),
        depth.max(1),
        callers.len(),
        in_tests
    );
    out.push_str("imported by:\n");
    for (file, d) in dependents.iter().take(150) {
        out.push_str(&format!("{}{}\n", "  ".repeat(*d), g.files[*file].path));
    }
    out.push_str("called from:\n");
    for c in callers.iter().take(CALLS_SHOWN) {
        out.push_str(&format!("  {}\n", named(g, *c)));
    }
    out
}

fn level(n: usize) -> &'static str {
    match n {
        0..5 => "low",
        5..20 => "medium",
        _ => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shop() -> (Graph, Code) {
        let mut code = Code::default();
        let files = [
            (
                "src/store.ts",
                "export class Store {\n  open(id: string) { return load(id); }\n}\nexport class Cache extends Store {\n  open(id: string) { return 'x'; }\n}\nexport function load(id: string) { return id; }\n",
            ),
            (
                "src/api.ts",
                "import { Store } from './store';\nexport class Api {\n  constructor(private store: Store) {}\n  get(id: string) {\n    return this.store.open(id);\n  }\n}\n",
            ),
            (
                "src/main.ts",
                "import { Api } from './api';\nimport express from 'express';\nfunction main() {\n  new Api(null).get('1');\n}\n",
            ),
        ];
        for (path, src) in files {
            code.put(
                path,
                FileType::Code(Lang::TypeScript),
                parse::read(Lang::TypeScript, src).unwrap(),
            );
        }
        let g = Graph::build(&code, Path::new("no such folder"));
        (g, code)
    }

    #[test]
    fn a_symbol_is_found_by_its_full_name_and_says_who_calls_it() {
        let (g, _) = shop();
        let got = find(&g, Path::new("."), "Store.open", "", false);
        assert!(
            got.starts_with(
                "method src.store.Store.open — src/store.ts:2-2   (1 callers)\n  open(id: string)\n"
            ),
            "{got}"
        );
        assert!(find(&g, Path::new("."), "Nope", "", false).starts_with("Nothing named"));
    }

    #[test]
    fn a_call_to_the_method_it_overrides_may_land_on_an_override() {
        let (g, code) = shop();
        let got = references(&g, &code, Path::new("."), "Cache.open", "", 1);
        assert!(
            got.contains("in src.api.Api.get (through src.store.Store.open)\n"),
            "{got}"
        );
        let store_open = g.resolve_name("Store.open", "")[0];
        assert!(g.dispatched_through(store_open).is_empty());
    }

    #[test]
    fn a_call_chain_goes_through_each_call() {
        let (g, _) = shop();
        let got = chain(&g, "main", "load", 5);
        assert!(
            got.starts_with("3 calls from src.main.main to src.store.load:\n"),
            "{got}"
        );
        assert!(
            got.contains("  method src.api.Api.get — src/api.ts:4-6  (called at src/main.ts:4)\n"),
            "{got}"
        );
    }

    #[test]
    fn files_say_what_they_import_and_what_imports_them() {
        let (g, _) = shop();
        let got = dependencies(&g, "src/api.ts", "both", 3);
        assert!(
            got.contains("src/api.ts imports 1 files:\n  src/store.ts\n"),
            "{got}"
        );
        assert!(
            got.contains("src/api.ts is imported by 1 files:\n  src/main.ts\n"),
            "{got}"
        );
        assert_eq!(
            dependencies(&g, "", "both", 1),
            "1 packages from outside the folder, by how many files import each:\n  express  (1)\n"
        );
    }

    #[test]
    fn a_types_lineage_and_a_methods_overrides() {
        let (g, _) = shop();
        let got = hierarchy(&g, "Store", "both");
        assert!(
            got.contains("  subtypes 1:\n    Extends: class src.store.Cache"),
            "{got}"
        );
        let got = hierarchy(&g, "Store.open", "both");
        assert!(
            got.contains("  overridden by 1:\n    method src.store.Cache.open"),
            "{got}"
        );
    }

    #[test]
    fn the_impact_of_a_change_counts_what_it_touches() {
        let (g, _) = shop();
        let got = impact(&g, "Store.open", 3);
        assert!(got.starts_with("method src.store.Store.open — src/store.ts:2-2\nimpact: low (2 callers in 2 files up to 3 calls away, 0 in tests; 1 overriding methods, 0 subtypes)\n"), "{got}");
        let got = impact(&g, "src/store.ts", 2);
        assert!(got.contains("impact: low (2 files import it, up to 2 away; 1 callers elsewhere of what it defines, and 0 calls from tests)"), "{got}");
        assert_eq!(level(4), "low");
        assert_eq!(level(19), "medium");
        assert_eq!(level(20), "high");
    }

    #[test]
    fn tests_calling_a_symbol_are_counted_apart() {
        let mut code = Code::default();
        for (path, src) in [
            (
                "src/load.ts",
                "export function load() {}\nexport function run() { load(); }\n",
            ),
            (
                "src/load.test.ts",
                "import { load } from './load';\nfunction checks() { load(); }\n",
            ),
        ] {
            code.put(
                path,
                FileType::Code(Lang::TypeScript),
                parse::read(Lang::TypeScript, src).unwrap(),
            );
        }
        let g = Graph::build(&code, Path::new("no such folder"));
        let got = impact(&g, "load", 1);
        assert!(
            got.contains("(1 callers in 1 files up to 1 calls away, 1 in tests;"),
            "{got}"
        );
        assert!(
            got.contains("in tests:\n  function src.load.test.checks"),
            "{got}"
        );
    }
}
