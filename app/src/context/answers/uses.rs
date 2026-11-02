//! Where something is used, for the tools that ask: who calls a function or makes a type (each
//! call followed to what it reaches), where it's used without being called (a constant read, a
//! function handed on), the other places its name appears; and where a type is used as one.

use super::*;
use crate::context::graph::{Edge, RefKind, TypeRole, TypeUseAt};

// ---------------------------------------------------------------- find_references

/// Who calls what a name means, up to `depth` calls away (under `under`), each call with its
/// line and what it's in; then where it's used without a call, and the other places the name
/// appears that aren't resolved to it.
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
    let (used, other) = scan(g, code, root, &name, &targets, under, &resolved);
    out.push_str(&used_without_calls(g, &used));
    out.push_str(&other_places(&name, &other));
    out
}

/// A place a name is used: its file, its line, the code there.
pub(super) struct Place {
    pub path: String,
    pub line: u32,
    pub code: String,
}

/// Where a name appears (under `under`), read again from the files that use it, but for the
/// calls already followed (`resolved`): the places that mean one of `targets` there (the name
/// in reach is it: a constant read, a function handed on, a call the graph couldn't follow),
/// and the others (other things of that name, members, what the syntax can't tell).
pub(super) fn scan(
    g: &Graph,
    code: &Code,
    root: &Path,
    name: &str,
    targets: &[usize],
    under: &str,
    resolved: &HashSet<(String, u32)>,
) -> (Vec<Place>, Vec<Place>) {
    let (mut used, mut other) = (vec![], vec![]);
    for (path, lang) in users(code, name, under) {
        let Some(text) = ingest::read_code(&root.join(&path)) else {
            continue;
        };
        let Some(facts) = parse::read_for(lang, &text, Some(name)) else {
            continue;
        };
        let all: Vec<&str> = text.lines().collect();
        let file = g.file_of(&path);
        for l in facts.uses {
            if resolved.contains(&(path.clone(), l)) {
                continue;
            }
            let code = all.get(l as usize - 1).map_or("", |s| s.trim());
            let place = Place {
                path: path.clone(),
                line: l,
                code: parse::cut(code, 160),
            };
            let means = file
                .filter(|_| facts.bare.contains(&l))
                .and_then(|f| g.bare_meaning(f, name, l));
            if means.is_some_and(|m| targets.contains(&m)) {
                used.push(place);
            } else {
                other.push(place);
            }
        }
    }
    (used, other)
}

/// The symbol a place is in, by its full name (or the top of its file).
pub(super) fn place_in(g: &Graph, p: &Place) -> Option<usize> {
    g.file_of(&p.path).and_then(|f| g.at_line(f, p.line))
}

fn used_without_calls(g: &Graph, used: &[Place]) -> String {
    if used.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "Used without being called (read, or handed on), resolved to it ({}):\n",
        used.len()
    );
    for p in used.iter().take(CALLS_SHOWN) {
        let what =
            place_in(g, p).map_or_else(|| "the top of the file".into(), |s| g.syms[s].fqn.clone());
        out.push_str(&format!(
            "  {}:{}  in {what}\n    {}\n",
            p.path, p.line, p.code
        ));
    }
    out.push('\n');
    out
}

fn other_places(name: &str, other: &[Place]) -> String {
    if other.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "Other places \"{name}\" appears, not resolved to the above ({}):\n",
        other.len()
    );
    for p in other.iter().take(30) {
        out.push_str(&format!("  {}:{}  {}\n", p.path, p.line, p.code));
    }
    out
}

// ---------------------------------------------------------------- find_type_usages

/// The places a type is named in a declaration, by what for.
const ROLES: [(TypeRole, &str); 4] = [
    (TypeRole::Param, "as a parameter's type"),
    (TypeRole::Returns, "as what's returned"),
    (TypeRole::Field, "as a field's or a property's type"),
    (
        TypeRole::Other,
        "elsewhere (a local's type, a cast, an alias)",
    ),
];

/// Where a type is used as one (under `under`): each place a declaration names it, by what
/// for, with its line and what it's in; then where it's made, and what extends or implements
/// it.
pub(in crate::context) fn type_usages(g: &Graph, root: &Path, query: &str, under: &str) -> String {
    let targets: Vec<usize> = g
        .resolve_name(query, "type")
        .into_iter()
        .take(TARGETS)
        .collect();
    if targets.is_empty() {
        return format!(
            "No type named \"{query}\" is defined here. Try mcp__cbot__find_symbol for its name."
        );
    }
    let mut lines = Lines::default();
    targets
        .iter()
        .map(|&t| uses_of(g, root, t, under, &mut lines))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One type's uses, for type_usages.
fn uses_of(g: &Graph, root: &Path, t: usize, under: &str, lines: &mut Lines) -> String {
    let inside = |file: usize| search::under_path(&g.files[file].path, under);
    let uses: Vec<&TypeUseAt> = g.type_uses[t].iter().filter(|u| inside(u.file)).collect();
    let made: Vec<&Edge> = g.calls_in[t]
        .iter()
        .filter(|e| e.kind == RefKind::New && inside(g.syms[e.to].file))
        .collect();
    let subs: Vec<usize> = g.subs[t]
        .iter()
        .map(|&(s, _)| s)
        .filter(|&s| inside(g.syms[s].file))
        .collect();
    let mut out = format!("{}\n", named(g, t));
    if uses.is_empty() && made.is_empty() && subs.is_empty() {
        out.push_str("  not used as a type anywhere\n");
        return out;
    }
    let files: BTreeSet<usize> = uses.iter().map(|u| u.file).collect();
    out.push_str(&format!(
        "  named as a type in {} places, in {} files\n",
        uses.len(),
        files.len()
    ));
    let mut shown = 0;
    for (role, title) in ROLES {
        let of: Vec<&&TypeUseAt> = uses.iter().filter(|u| u.role == role).collect();
        if of.is_empty() {
            continue;
        }
        out.push_str(&format!("  {title} ({}):\n", of.len()));
        for u in of.into_iter().take(CALLS_SHOWN.saturating_sub(shown)) {
            shown += 1;
            let path = &g.files[u.file].path;
            let what =
                u.by.map_or_else(|| "the top of the file".into(), |s| g.syms[s].fqn.clone());
            out.push_str(&format!("    {path}:{}  in {what}\n", u.line));
            out.push_str(&format!("      {}\n", lines.get(root, path, u.line)));
        }
    }
    if shown >= CALLS_SHOWN {
        out.push_str("  (more than shown: give a path to narrow it)\n");
    }
    if !made.is_empty() {
        out.push_str(&format!("  made ({}):\n", made.len()));
        for e in made.iter().take(TESTS_SHOWN) {
            let at = e.lines.first().copied().unwrap_or(g.syms[e.to].line);
            out.push_str(&format!(
                "    {}:{at}  in {}\n",
                g.path(e.to),
                g.syms[e.to].fqn
            ));
        }
    }
    if !subs.is_empty() {
        out.push_str(&format!("  extended or implemented by ({}):\n", subs.len()));
        out.extend(subs.iter().map(|&s| format!("    {}\n", named(g, s))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::answers::tests::shop;

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

    /// A constant read and a function handed on, in a folder of their own.
    fn limits() -> (std::path::PathBuf, Code, Graph) {
        let (dir, code) = crate::context::answers::tests::folder(&[
            (
                "src/limits.ts",
                "export const LIMIT = 10;\nexport function format(n: number) { return String(n); }\n",
            ),
            (
                "src/api.ts",
                "import { LIMIT, format } from './limits';\nexport function page(items: number[]) {\n  const cut = items.slice(0, LIMIT);\n  return cut.map(format);\n}\nexport function other(cfg: { LIMIT: number }) {\n  return cfg.LIMIT;\n}\n",
            ),
        ]);
        let g = Graph::build(&code, &dir);
        (dir, code, g)
    }

    #[test]
    fn a_constant_read_is_a_use_of_it_not_another_of_its_name() {
        let (dir, code, g) = limits();
        let got = references(&g, &code, &dir, "LIMIT", "", 1);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("Used without being called (read, or handed on), resolved to it (1):\n  src/api.ts:3  in src.api.page\n    const cut = items.slice(0, LIMIT);\n"),
            "{got}"
        );
        // (its import, a key of a type of that name, a member of that name: not it)
        assert!(
            got.contains(
                "Other places \"LIMIT\" appears, not resolved to the above (3):\n  src/api.ts:1"
            ),
            "{got}"
        );
    }

    #[test]
    fn a_use_inside_a_method_is_the_methods_not_its_classs() {
        let (dir, code) = crate::context::answers::tests::folder(&[
            ("src/limits.ts", "export const LIMIT = 10;\n"),
            (
                "src/shop.ts",
                "import { LIMIT } from './limits';\nexport class Shop {\n  page(items: number[]) {\n    return items.slice(0, LIMIT);\n  }\n}\n",
            ),
        ]);
        let g = Graph::build(&code, &dir);
        let got = references(&g, &code, &dir, "LIMIT", "", 1);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("resolved to it (1):\n  src/shop.ts:4  in src.shop.Shop.page\n"),
            "{got}"
        );
    }

    #[test]
    fn a_function_handed_on_is_a_use_of_it() {
        let (dir, code, g) = limits();
        let got = references(&g, &code, &dir, "format", "", 1);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("resolved to it (1):\n  src/api.ts:4  in src.api.page\n    return cut.map(format);\n"),
            "{got}"
        );
    }

    #[test]
    fn a_types_uses_say_what_for_and_what_extends_it() {
        let (g, _) = shop();
        let got = type_usages(&g, Path::new("."), "Store", "");
        assert!(
            got.contains("  named as a type in 1 places, in 1 files\n  as a parameter's type (1):\n    src/api.ts:3  in src.api.Api.constructor\n"),
            "{got}"
        );
        assert!(
            got.contains("  extended or implemented by (1):\n    class src.store.Cache"),
            "{got}"
        );
        assert!(
            type_usages(&g, Path::new("."), "Store", "src/main.ts")
                .contains("not used as a type anywhere")
        );
        assert!(type_usages(&g, Path::new("."), "Nope", "").starts_with("No type named"));
    }

    #[test]
    fn where_a_type_is_made_is_among_its_uses() {
        let (g, _) = shop();
        let got = type_usages(&g, Path::new("."), "Api", "");
        assert!(
            got.contains("  made (1):\n    src/main.ts:4  in src.main.main\n"),
            "{got}"
        );
    }
}
