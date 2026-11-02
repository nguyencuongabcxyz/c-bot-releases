//! explain_symbol: one symbol and what's around it, in one answer: its code (a type's head);
//! for a type, its members, what it extends and what extends it; what it calls and what calls
//! it; the types it names (its parameters', what it returns); the tests that reach it; and who
//! changed it last. What several tools and reads would tell, at once.

use super::*;
use crate::context::graph::{RefKind, TypeRole};

/// What each part shows, at most.
const CALLS: usize = 25;
const CALLERS: usize = 15;
const MEMBERS: usize = 40;
const TESTS: usize = 8;
/// A type's head shown: its first lines (its members are listed after).
const TYPE_HEAD: u32 = 20;
/// How many calls away a test may reach it from.
const TEST_DEPTH: usize = 4;

/// A symbol (the best of what a name means) and what's around it.
pub(in crate::context) fn explain(g: &Graph, root: &Path, query: &str) -> String {
    let found = g.resolve_name(query, "");
    let Some(&s) = found.first() else {
        return format!(
            "Nothing named \"{query}\" is defined here. Try mcp__cbot__search_code to find it by words."
        );
    };
    let sym = &g.syms[s];
    let mut out = format!("{}\n", named(g, s));
    if found.len() > 1 {
        let others: Vec<&str> = found[1..]
            .iter()
            .take(5)
            .map(|&o| g.syms[o].fqn.as_str())
            .collect();
        out.push_str(&format!(
            "(also named so: {}; ask by full name for one of them)\n",
            others.join(", ")
        ));
    }
    let is_type = sym.kind.fits("type");
    let end = if is_type {
        sym.end.min(sym.line + TYPE_HEAD - 1)
    } else {
        sym.end
    };
    out.push_str(&body_of(root, g.path(s), sym.line, end));
    if is_type {
        out.push_str(&type_part(g, s));
    }
    out.push_str(&calls_part(g, s));
    out.push_str(&callers_part(g, s));
    out.push_str(&types_named(g, s));
    out.push_str(&tests_part(g, s));
    let head = format!("Last changed ({}:{}-{})", g.path(s), sym.line, sym.end);
    if let Ok(changed) = history::blame(root, g.path(s), sym.line, sym.end, &head, 3) {
        out.push_str(&changed);
    }
    out
}

/// A type's members (a line each), what it extends or implements and what extends it, and
/// how much it's used as a type.
fn type_part(g: &Graph, t: usize) -> String {
    let members = g.own_members(t);
    let mut out = format!("Members ({}):\n", members.len());
    for &m in members.iter().take(MEMBERS) {
        let sym = &g.syms[m];
        out.push_str(&format!(
            "  {}:{}  {}\n",
            sym.kind.word(),
            sym.line,
            sym.sig
        ));
    }
    if members.len() > MEMBERS {
        out.push_str(&format!(
            "  … and {} more (mcp__cbot__type_members)\n",
            members.len() - MEMBERS
        ));
    }
    for (title, list) in [("Extends", &g.supers[t]), ("Extended by", &g.subs[t])] {
        if !list.is_empty() {
            let names: Vec<String> = list
                .iter()
                .map(|&(o, heir)| format!("{} ({heir:?})", g.syms[o].fqn))
                .collect();
            out.push_str(&format!("{title}: {}\n", names.join(", ")));
        }
    }
    let made = g.calls_in[t]
        .iter()
        .filter(|e| e.kind == RefKind::New)
        .count();
    out.push_str(&format!(
        "Named as a type in {} places, made in {made} (mcp__cbot__find_type_usages)\n",
        g.type_uses[t].len()
    ));
    out
}

/// What it calls: each with its signature.
fn calls_part(g: &Graph, s: usize) -> String {
    let calls = &g.calls_out[s];
    if calls.is_empty() {
        return String::new();
    }
    let mut out = format!("Calls ({}):\n", calls.len());
    for e in calls.iter().take(CALLS) {
        let to = &g.syms[e.to];
        out.push_str(&format!(
            "  {}  — {}:{}\n      {}\n",
            to.fqn,
            g.path(e.to),
            to.line,
            to.sig
        ));
    }
    if calls.len() > CALLS {
        out.push_str(&format!("  … and {} more\n", calls.len() - CALLS));
    }
    out
}

/// What calls it, each where.
fn callers_part(g: &Graph, s: usize) -> String {
    let callers = &g.calls_in[s];
    if callers.is_empty() {
        return "Called by: nothing the graph follows\n".into();
    }
    let mut out = format!("Called by ({}):\n", callers.len());
    for e in callers.iter().take(CALLERS) {
        let at = e.lines.first().copied().unwrap_or(g.syms[e.to].line);
        out.push_str(&format!(
            "  {}:{at}  in {}\n",
            g.path(e.to),
            g.syms[e.to].fqn
        ));
    }
    if callers.len() > CALLERS {
        out.push_str(&format!(
            "  … and {} more (mcp__cbot__find_references)\n",
            callers.len() - CALLERS
        ));
    }
    out
}

/// The folder's types it names in its declarations (its parameters', what it returns, its
/// fields'), each once.
fn types_named(g: &Graph, s: usize) -> String {
    let mut named: Vec<(usize, TypeRole)> = vec![];
    for (t, uses) in g.type_uses.iter().enumerate() {
        for u in uses.iter().filter(|u| u.by == Some(s)) {
            if !named.contains(&(t, u.role)) {
                named.push((t, u.role));
            }
        }
    }
    if named.is_empty() {
        return String::new();
    }
    named.sort_by_key(|&(t, role)| (role, t));
    let mut out = String::from("Types it names:\n");
    for (t, role) in named {
        let role = format!("{role:?}").to_lowercase();
        out.push_str(&format!(
            "  {role}: {}  — {}:{}\n",
            g.syms[t].fqn,
            g.path(t),
            g.syms[t].line
        ));
    }
    out
}

/// The tests that reach it.
fn tests_part(g: &Graph, s: usize) -> String {
    let tested = g.tests_of(&[s], TEST_DEPTH);
    let count = tested.syms.len() + tested.lines.len();
    if count == 0 {
        return format!("Tests: none reach it within {TEST_DEPTH} calls\n");
    }
    let mut shown: Vec<String> = tested
        .syms
        .iter()
        .filter(|&&(t, _, _)| t != s)
        .map(|&(t, _, _)| format!("{} ({})", g.syms[t].name, g.path(t)))
        .collect();
    shown.extend(
        tested
            .lines
            .iter()
            .map(|&(f, l, _)| format!("{}:{l}", g.files[f].path)),
    );
    let more = shown.len().saturating_sub(TESTS);
    shown.truncate(TESTS);
    let more = if more > 0 {
        format!(" … (+{more}, mcp__cbot__affected_tests)")
    } else {
        String::new()
    };
    format!("Tests reaching it ({count}): {}{more}\n", shown.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::answers::tests::folder;

    #[test]
    fn a_symbol_comes_with_its_code_calls_callers_types_and_tests() {
        let (dir, code) = folder(&[
            (
                "src/store.ts",
                "export class Order {}\nexport function load(id: string): Order {\n  return check(new Order());\n}\nfunction check(o: Order): Order { return o; }\n",
            ),
            (
                "src/api.ts",
                "import { load } from './store';\nexport function get(id: string) {\n  return load(id);\n}\n",
            ),
            (
                "src/store.test.ts",
                "import { load } from './store';\nit('loads', () => {\n  load('1');\n});\n",
            ),
        ]);
        let g = Graph::build(&code, &dir);
        let got = explain(&g, &dir, "load");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.starts_with("function src.store.load — src/store.ts:2-4\n```\n     2│ export function load(id: string): Order {\n"),
            "{got}"
        );
        assert!(
            got.contains("Calls (2):\n  src.store.check  — src/store.ts:5\n      function check(o: Order): Order\n  src.store.Order  — src/store.ts:1\n      export class Order\n"),
            "{got}"
        );
        assert!(
            got.contains("Called by (1):\n  src/api.ts:3  in src.api.get\n"),
            "{got}"
        );
        assert!(
            got.contains("Types it names:\n  returns: src.store.Order  — src/store.ts:1\n"),
            "{got}"
        );
        assert!(
            got.contains("Tests reaching it (1): src/store.test.ts:3\n"),
            "{got}"
        );
    }

    #[test]
    fn a_type_comes_with_its_members_and_its_lineage() {
        let (dir, code) = folder(&[(
            "src/shapes.ts",
            "export class Shape {\n  area(): number { return 0; }\n}\nexport class Square extends Shape {\n  side = 1;\n  area(): number { return 1; }\n}\n",
        )]);
        let g = Graph::build(&code, &dir);
        let got = explain(&g, &dir, "Shape");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("Members (1):\n  method:2  area(): number\nExtended by: src.shapes.Square (Extends)\n"),
            "{got}"
        );
        assert!(explain(&g, &dir, "Nope").starts_with("Nothing named"));
    }
}
