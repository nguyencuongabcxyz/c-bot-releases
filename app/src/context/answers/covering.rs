//! affected_tests: the tests that reach what changed (the symbols the uncommitted changes or a
//! branch's touch, read from `git diff`, or the symbols and files asked about), so only they
//! need running: each test function, and each line of a test file's own code (`it('…', …)`,
//! named by its test), with the command that runs just those, in the project's own test runner.

use regex::Regex;
use std::sync::LazyLock;

use super::*;
use crate::context::graph::Tested;

/// The tests shown, at most.
const SHOWN: usize = 60;
/// The test names a command is given, at most (past that, the whole file or package).
const FILTERS: usize = 25;

/// The symbols a `git diff -U0` touches: for each changed line of a file the graph has, the
/// innermost definition holding it (a line at a file's top level, an import, touches none);
/// a line taken away, the definition where it was. And the files it changed that the graph
/// doesn't read.
pub(in crate::context) fn changed_symbols(g: &Graph, diff: &str) -> (Vec<usize>, Vec<String>) {
    static HUNK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@").expect("a constant regex")
    });
    let (mut found, mut others): (Vec<usize>, Vec<String>) = (vec![], vec![]);
    let mut file: Option<usize> = None;
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            let path = path.strip_prefix("b/").unwrap_or(path);
            file = g.file_of(path);
            if file.is_none() && path != "/dev/null" {
                others.push(path.to_string());
            }
            continue;
        }
        let (Some(f), Some(c)) = (file, HUNK.captures(line)) else {
            continue;
        };
        let at: u32 = c[1].parse().unwrap_or(1);
        let n: u32 = c.get(2).map_or(1, |n| n.as_str().parse().unwrap_or(1));
        for l in at..at + n.max(1) {
            if let Some(s) = g.at_line(f, l)
                && !found.contains(&s)
            {
                found.push(s);
            }
        }
    }
    (found, others)
}

/// The tests that reach `targets` (what `why` says they are), within `depth` calls, by file,
/// and how to run just them.
pub(in crate::context) fn affected(
    g: &Graph,
    root: &Path,
    targets: &[usize],
    why: &str,
    depth: usize,
) -> String {
    if targets.is_empty() {
        return format!("Nothing to test: no definition of the code is {why}.");
    }
    let names: Vec<&str> = targets.iter().map(|&t| g.syms[t].fqn.as_str()).collect();
    let mut out = format!(
        "{} symbols {why}: {}\n",
        targets.len(),
        cut_list(&names, 12)
    );
    let tested = g.tests_of(targets, depth);
    let files: BTreeSet<usize> = tested
        .syms
        .iter()
        .map(|&(s, _, _)| g.syms[s].file)
        .chain(tested.lines.iter().map(|&(f, _, _)| f))
        .collect();
    if files.is_empty() {
        out.push_str(&format!(
            "No test reaches them within {depth} calls: nothing to run for them, or they're untested."
        ));
        return out;
    }
    let count = tested.syms.len() + tested.lines.len();
    out.push_str(&format!(
        "{count} tests reach them (up to {depth} calls away), in {} files:\n",
        files.len()
    ));
    out.push_str(&listed(g, root, &tested, &files));
    out.push_str("Run just these:\n");
    for command in commands(g, root, &tested, &files) {
        out.push_str(&format!("  {command}\n"));
    }
    out
}

/// The tests, file by file: each test function (with what it reaches, and how far), each top
/// line (with its test's name).
fn listed(g: &Graph, root: &Path, tested: &Tested, files: &BTreeSet<usize>) -> String {
    let mut out = String::new();
    let mut shown = 0;
    for &f in files {
        out.push_str(&format!("  {}\n", g.files[f].path));
        for &(s, t, d) in tested.syms.iter().filter(|(s, _, _)| g.syms[*s].file == f) {
            shown += 1;
            if shown <= SHOWN {
                let far = if d == 0 {
                    String::new()
                } else {
                    format!(", {d} calls away")
                };
                let sym = &g.syms[s];
                out.push_str(&format!(
                    "    {} {}:{}  (→ {}{far})\n",
                    sym.kind.word(),
                    sym.name,
                    sym.line,
                    g.syms[t].name
                ));
            }
        }
        let text = ingest::read_code(&root.join(&g.files[f].path)).unwrap_or_default();
        for &(_, line, t) in tested.lines.iter().filter(|(lf, _, _)| *lf == f) {
            shown += 1;
            if shown <= SHOWN {
                let name = test_name(&text, line).map_or(String::new(), |n| format!("{n}  "));
                out.push_str(&format!("    :{line}  {name}(→ {})\n", g.syms[t].name));
            }
        }
    }
    if shown > SHOWN {
        out.push_str(&format!("  … and {} more\n", shown - SHOWN));
    }
    out
}

/// The name of the test a line of a test file's own code is in: the nearest `it('…'` or
/// `test('…'` above it (or on it).
fn test_name(text: &str, line: u32) -> Option<String> {
    static TEST: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?:^|[^\w.])(?:it|test)(?:\.\w+)?\(\s*['"`]([^'"`]*)"#)
            .expect("a constant regex")
    });
    let lines: Vec<&str> = text.lines().collect();
    let at = (line as usize).min(lines.len());
    lines[..at].iter().rev().find_map(|l| {
        let name = TEST.captures(l)?.get(1)?.as_str();
        Some(format!("'{}'", parse::cut(name, 80)))
    })
}

/// The commands that run just these tests, as the project's own runner does, one per runner
/// (and per Rust crate or Go package).
fn commands(g: &Graph, root: &Path, tested: &Tested, files: &BTreeSet<usize>) -> Vec<String> {
    // (each runner's place, in the order first met: a language and its folder)
    let mut by_place: Vec<(Lang, String, Vec<String>)> = vec![];
    for &(s, _, _) in &tested.syms {
        let file = g.syms[s].file;
        let lang = g.files[file].lang;
        let path = &g.files[file].path;
        let Some((place, filter)) = filter_of(g, root, s, lang, path) else {
            continue;
        };
        let at = by_place
            .iter()
            .position(|(l, p, _)| *l == lang && *p == place);
        let at = at.unwrap_or_else(|| {
            by_place.push((lang, place, vec![]));
            by_place.len() - 1
        });
        if !by_place[at].2.contains(&filter) {
            by_place[at].2.push(filter);
        }
    }
    let mut out: Vec<String> = by_place
        .iter()
        .filter_map(|(lang, place, filters)| command(*lang, place, filters))
        .collect();
    // (JavaScript and TypeScript: by file, with the runner its package uses)
    let mut scripts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for &f in files {
        let path = &g.files[f].path;
        if matches!(g.files[f].lang, Lang::TypeScript | Lang::Tsx) {
            let dir = nearest(root, path, "package.json").unwrap_or_default();
            let rel = path.strip_prefix(&format!("{dir}/")).unwrap_or(path);
            scripts.entry(dir).or_default().push(rel.to_string());
        }
    }
    for (dir, list) in scripts {
        let manifest =
            std::fs::read_to_string(root.join(&dir).join("package.json")).unwrap_or_default();
        let runner = if manifest.contains("\"vitest\"") {
            "npx vitest run"
        } else if manifest.contains("\"jest\"") {
            "npx jest"
        } else {
            "npm test --"
        };
        out.push(format!("{}{runner} {}", within(&dir), list.join(" ")));
    }
    if out.is_empty() {
        out.push("(no runner known for these: run their files as the project does)".into());
    }
    out
}

/// Where a test symbol runs from and how a runner names it: a Rust crate's folder and
/// `tests::name`; a Go package's folder and `TestName`; a Python file and `path::Class::name`;
/// C#'s method name.
fn filter_of(g: &Graph, root: &Path, s: usize, lang: Lang, path: &str) -> Option<(String, String)> {
    let sym = &g.syms[s];
    if !sym.kind.fits("function") {
        return None;
    }
    let parent = sym.parent.map(|p| g.syms[p].name.as_str());
    match lang {
        Lang::Rust => {
            let krate = nearest(root, path, "Cargo.toml")?;
            let name = parent.map_or(sym.name.clone(), |p| format!("{p}::{}", sym.name));
            Some((krate, name))
        }
        Lang::Go if sym.name.starts_with("Test") => {
            Some((dir_of(path).to_string(), sym.name.clone()))
        }
        Lang::Python if sym.name.starts_with("test") => {
            let name = parent.map_or(sym.name.clone(), |p| format!("{p}::{}", sym.name));
            Some((String::new(), format!("{path}::{name}")))
        }
        Lang::CSharp => Some((String::new(), sym.name.clone())),
        _ => None,
    }
}

/// The command for one runner's tests (too many: the whole crate's or package's).
fn command(lang: Lang, place: &str, filters: &[String]) -> Option<String> {
    let all = filters.len() > FILTERS;
    let few = filters.iter().take(FILTERS).cloned().collect::<Vec<_>>();
    let at = within(place);
    Some(match lang {
        Lang::Rust if all => format!("{at}cargo test"),
        Lang::Rust => format!("{at}cargo test -- {}", few.join(" ")),
        Lang::Go => {
            let pkg = if place.is_empty() { "." } else { place };
            if all {
                format!("go test ./{pkg}")
            } else {
                format!("go test ./{pkg} -run '^({})$'", few.join("|"))
            }
        }
        Lang::Python => format!("pytest {}", few.join(" ")),
        Lang::CSharp if all => "dotnet test".into(),
        Lang::CSharp => {
            let names: Vec<String> = few.iter().map(|n| format!("Name~{n}")).collect();
            format!("dotnet test --filter \"{}\"", names.join("|"))
        }
        _ => return None,
    })
}

/// "(in app) " for a command run from a folder of the project ('' for its root).
fn within(dir: &str) -> String {
    if dir.is_empty() {
        String::new()
    } else {
        format!("(in {dir}) ")
    }
}

/// The nearest folder above a file (relative to the root, '' for it) holding `marker`.
fn nearest(root: &Path, path: &str, marker: &str) -> Option<String> {
    let mut dir = dir_of(path);
    loop {
        if root.join(dir).join(marker).is_file() {
            return Some(dir.to_string());
        }
        if dir.is_empty() {
            return None;
        }
        dir = dir_of(dir);
    }
}

/// A path's folder ('' at the root).
fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Names, the first `n` of them, with how many more.
fn cut_list(names: &[&str], n: usize) -> String {
    let shown = names.iter().take(n).copied().collect::<Vec<_>>().join(", ");
    match names.len().saturating_sub(n) {
        0 => shown,
        more => format!("{shown} … (+{more})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::answers::tests::folder;

    fn project() -> (PathBuf, Graph) {
        let (dir, code) = folder(&[
            (
                "package.json",
                "{ \"devDependencies\": { \"vitest\": \"^3\" } }\n",
            ),
            (
                "src/store.ts",
                "export class Store {\n  open(id: string) { return load(id); }\n}\nexport function load(id: string) { return id; }\nexport function unused() {}\n",
            ),
            (
                "src/api.ts",
                "import { Store } from './store';\nexport function get(id: string) {\n  const s = new Store();\n  return s.open(id);\n}\n",
            ),
            (
                "src/api.test.ts",
                "import { get } from './api';\nimport { describe, it, expect } from 'vitest';\ndescribe('api', () => {\n  it('gets an order', () => {\n    expect(get('1')).toBe('1');\n  });\n});\n",
            ),
        ]);
        let g = Graph::build(&code, &dir);
        (dir, g)
    }

    #[test]
    fn a_change_deep_down_reaches_the_test_calling_what_calls_it() {
        let (dir, g) = project();
        let load = g.resolve_name("load", "")[0];
        let got = affected(&g, &dir, &[load], "asked about", 5);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            got.contains("1 tests reach them (up to 5 calls away), in 1 files:\n  src/api.test.ts\n    :5  'gets an order'  (→ load)\n"),
            "{got}"
        );
        assert!(
            got.ends_with("Run just these:\n  npx vitest run src/api.test.ts\n"),
            "{got}"
        );
    }

    #[test]
    fn an_untested_symbol_says_so() {
        let (dir, g) = project();
        let unused = g.resolve_name("unused", "")[0];
        let got = affected(&g, &dir, &[unused], "asked about", 5);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(got.contains("No test reaches them within 5 calls"), "{got}");
    }

    #[test]
    fn a_diff_touches_the_innermost_definition_of_each_changed_line() {
        let (dir, g) = project();
        let _ = std::fs::remove_dir_all(&dir);
        let diff = "diff --git a/src/store.ts b/src/store.ts\n--- a/src/store.ts\n+++ b/src/store.ts\n@@ -2 +2 @@ export class Store {\n-  open(id) {}\n+  open(id: string) { return load(id); }\n@@ -4,0 +5 @@\n+export function unused() {}\n+++ b/README.md\n@@ -1 +1 @@\n";
        let (found, others) = changed_symbols(&g, diff);
        let names: Vec<&str> = found.iter().map(|&s| g.syms[s].name.as_str()).collect();
        assert_eq!(names, ["open", "unused"]);
        assert_eq!(others, ["README.md"]);
    }

    #[test]
    fn each_runner_is_given_the_tests_its_own_way() {
        let names = vec!["tests::opens".to_string(), "tests::saves".to_string()];
        assert_eq!(
            command(Lang::Rust, "app", &names).unwrap(),
            "(in app) cargo test -- tests::opens tests::saves"
        );
        let go = vec!["TestOpen".to_string()];
        assert_eq!(
            command(Lang::Go, "store", &go).unwrap(),
            "go test ./store -run '^(TestOpen)$'"
        );
        let cs = vec!["Opens".to_string(), "Saves".to_string()];
        assert_eq!(
            command(Lang::CSharp, "", &cs).unwrap(),
            "dotnet test --filter \"Name~Opens|Name~Saves\""
        );
    }
}
