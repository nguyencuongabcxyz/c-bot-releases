//! What the tools that walk the code graph answer: where something is defined (its full name,
//! its lines, its signature, how many call it), the chain of calls from one to another, a
//! file's imports and importers, a type's lineage and a method's overrides, a type's members,
//! and what changing something would touch. Who calls something and where it's used: uses.rs.

use super::*;
use crate::context::graph::Heir;

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
            "Nothing named \"{query}\" is defined here. Try mcp__cbot__search_code to find it by words."
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

// ---------------------------------------------------------------- call_chain

/// The shortest chain of calls from one symbol to another.
pub(in crate::context) fn chain(g: &Graph, from: &str, to: &str, depth: usize) -> String {
    let (Some(&a), Some(&b)) = (
        g.resolve_name(from, "function").first(),
        g.resolve_name(to, "").first(),
    ) else {
        return format!(
            "Couldn't find both \"{from}\" and \"{to}\": try mcp__cbot__find_symbol for their full names."
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

// ---------------------------------------------------------------- type_members

/// A type's members (all its parts': a C# partial class, a Rust type's impls), each with its
/// kind, lines and signature; with `inherited`, its supertypes' too, nearest first, but for
/// those of a name already listed (overridden).
pub(in crate::context) fn members(g: &Graph, query: &str, inherited: bool) -> String {
    let Some(&t) = g.resolve_name(query, "type").first() else {
        return format!(
            "No type named \"{query}\" is defined here. Try mcp__cbot__find_symbol for its name."
        );
    };
    let own = g.own_members(t);
    let mut seen: HashSet<&str> = own.iter().map(|&m| g.syms[m].name.as_str()).collect();
    let mut out = format!("{}\n  {} members:\n", named(g, t), own.len());
    out.push_str(&member_lines(g, &own));
    if !inherited {
        return out;
    }
    for (sup, _, heir) in g.lineage(t, true) {
        let theirs: Vec<usize> = g
            .own_members(sup)
            .into_iter()
            .filter(|&m| seen.insert(g.syms[m].name.as_str()))
            .collect();
        if !theirs.is_empty() {
            let how = if heir == Heir::Implements {
                "implemented"
            } else {
                "inherited"
            };
            out.push_str(&format!(
                "  {how} from {} ({}):\n",
                g.syms[sup].fqn,
                theirs.len()
            ));
            out.push_str(&member_lines(g, &theirs));
        }
    }
    out
}

/// Members, a line each with their signature under.
fn member_lines(g: &Graph, members: &[usize]) -> String {
    members
        .iter()
        .map(|&m| {
            let s = &g.syms[m];
            format!(
                "    {} {} — {}:{}-{}\n      {}\n",
                s.kind.word(),
                s.name,
                g.path(m),
                s.line,
                s.end,
                s.sig
            )
        })
        .collect()
}

// ---------------------------------------------------------------- change_impact

/// What changing a symbol or a file would touch: its callers (to `depth`), overrides,
/// subtypes and supertypes, what uses it without a call (reads a constant, hands a function
/// on), and for a type what declares something of it (a parameter, a field, what a function
/// returns); for a file, the files importing it and the callers of what it defines from
/// elsewhere. With a level: low (under 5 places), medium (under 20), high.
pub(in crate::context) fn impact(
    g: &Graph,
    code: &Code,
    root: &Path,
    target: &str,
    depth: usize,
) -> String {
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
    let counted = |b: usize| b != s && !tests[b] && !callers.iter().any(|r| r.sym == b);
    // (what declares something of this type: a parameter, a field, what a function returns)
    let typed: BTreeSet<usize> = g.type_uses[s]
        .iter()
        .filter_map(|u| u.by)
        .filter(|&b| counted(b))
        .collect();
    let used: BTreeSet<usize> = used_by(g, code, root, s)
        .into_iter()
        .filter(|&b| counted(b) && !typed.contains(&b))
        .collect();
    let touched = callers.len() + below.len() + subtypes.len() + typed.len() + used.len();
    let files: BTreeSet<&str> = callers.iter().map(|r| g.path(r.sym)).collect();
    let as_type = if g.syms[s].kind.fits("type") {
        format!(", {} more declaring something of its type", typed.len())
    } else {
        String::new()
    };
    let without_calls = if used.is_empty() {
        String::new()
    } else {
        format!(", {} more using it without a call", used.len())
    };
    let mut out = format!(
        "{}\nimpact: {} ({} callers in {} files up to {} calls away, {} in tests; {} overriding methods, {} subtypes{as_type}{without_calls})\n\n",
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
    let lineage = |l: Vec<(usize, usize, Heir)>| l.into_iter().map(|(t, _, _)| t).collect();
    for (title, list) in [
        ("overridden by", below),
        ("overrides", above),
        ("subtypes", lineage(subtypes)),
        ("supertypes", lineage(supertypes)),
        (
            "declaring something of its type (a parameter, a field, what it returns)",
            typed.into_iter().collect(),
        ),
        (
            "using it without a call (reading it, handing it on)",
            used.into_iter().collect(),
        ),
    ] {
        if !list.is_empty() {
            out.push_str(&format!("{title}:\n"));
            out.extend(
                list.into_iter()
                    .take(CALLS_SHOWN)
                    .map(|m| format!("  {}\n", named(g, m))),
            );
        }
    }
    out
}

/// What uses a symbol without calling it (each once): what reads a constant or hands a
/// function on, by its name in reach where it's used (uses.rs).
fn used_by(g: &Graph, code: &Code, root: &Path, s: usize) -> BTreeSet<usize> {
    let called: HashSet<(String, u32)> = g.calls_in[s]
        .iter()
        .flat_map(|e| e.lines.iter().map(|&l| (g.path(e.to).to_string(), l)))
        .collect();
    let (used, _) = scan(g, code, root, &g.syms[s].name, &[s], "", &called);
    used.iter().filter_map(|p| place_in(g, p)).collect()
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
    use crate::context::answers::tests::shop;

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
    fn a_types_members_are_its_own_then_what_it_inherits_unless_overridden() {
        let g = Graph::build(
            &{
                let mut code = Code::default();
                code.put(
                    "src/shapes.ts",
                    FileType::Code(Lang::TypeScript),
                    parse::read(Lang::TypeScript, "export class Shape {\n  area(): number { return 0; }\n  name(): string { return ''; }\n}\nexport class Square extends Shape {\n  side = 1;\n  area(): number { return 1; }\n}\n").unwrap(),
                );
                code
            },
            Path::new("no such folder"),
        );
        let got = members(&g, "Square", false);
        assert_eq!(
            got,
            "class src.shapes.Square — src/shapes.ts:5-8\n  2 members:\n    property side — src/shapes.ts:6-6\n      side = 1\n    method area — src/shapes.ts:7-7\n      area(): number\n"
        );
        let got = members(&g, "Square", true);
        assert!(
            got.ends_with("  inherited from src.shapes.Shape (1):\n    method name — src/shapes.ts:3-3\n      name(): string\n"),
            "{got}"
        );
        assert!(members(&g, "Nope", false).starts_with("No type named"));
    }

    #[test]
    fn changing_a_constant_touches_what_reads_it() {
        let (dir, code) = crate::context::answers::tests::folder(&[
            ("src/limits.ts", "export const LIMIT = 10;\n"),
            (
                "src/api.ts",
                "import { LIMIT } from './limits';\nexport function page() {\n  return LIMIT;\n}\n",
            ),
        ]);
        let g = Graph::build(&code, &dir);
        let got = impact(&g, &code, &dir, "LIMIT", 2);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("0 subtypes, 1 more using it without a call)"),
            "{got}"
        );
        assert!(
            got.contains(
                "using it without a call (reading it, handing it on):\n  function src.api.page"
            ),
            "{got}"
        );
    }

    #[test]
    fn changing_a_type_touches_what_declares_something_of_it() {
        let (g, code) = shop();
        let got = impact(&g, &code, Path::new("."), "Store", 2);
        assert!(
            got.contains("1 subtypes, 1 more declaring something of its type)"),
            "{got}"
        );
        assert!(
            got.contains("declaring something of its type (a parameter, a field, what it returns):\n  method src.api.Api.constructor"),
            "{got}"
        );
    }

    #[test]
    fn the_impact_of_a_change_counts_what_it_touches() {
        let (g, code) = shop();
        let got = impact(&g, &code, Path::new("."), "Store.open", 3);
        assert!(got.starts_with("method src.store.Store.open — src/store.ts:2-2\nimpact: low (2 callers in 2 files up to 3 calls away, 0 in tests; 1 overriding methods, 0 subtypes)\n"), "{got}");
        let got = impact(&g, &code, Path::new("."), "src/store.ts", 2);
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
        let got = impact(&g, &code, Path::new("."), "load", 1);
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
