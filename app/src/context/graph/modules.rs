//! Where an import goes: files of the folder, or a package from outside it. Each language
//! finds modules its own way: TypeScript and JavaScript by relative path (with or without an
//! extension, an index file, `.js` written for a `.ts`) or through the `paths` of the nearest
//! tsconfig.json (and its siblings, tsconfig.app.json…, and what they extend); Python by dots
//! for a relative import, else by the module's dotted path; Rust by `crate::`, `self::`,
//! `super::` and `mod x;`; Go by the module path in the nearest go.mod; C# by namespace, Java
//! by package; C++'s `#include` next to the file, else by the end of a path in the folder.

use super::*;

/// How far a tsconfig's `extends` is followed.
const EXTENDS: usize = 5;

/// Where an import goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Files(Vec<usize>),
    External(String),
    Nowhere,
}

/// A tsconfig's paths: each alias and where it goes, ("@/*", ["src/*"]), already joined to
/// where they're from.
type TsPaths = Vec<(String, Vec<String>)>;

/// What the folder says about its modules: its tsconfigs' paths, its go.mods' modules.
#[derive(Default)]
pub(super) struct Settings {
    /// Each folder's tsconfig paths, the deepest folder first.
    pub ts: Vec<(String, TsPaths)>,
    /// Each go.mod's folder and module path.
    pub go: Vec<(String, String)>,
}

impl Settings {
    /// The settings next to the folder's TypeScript and Go files, or above them.
    pub(super) fn read(root: &Path, code: &Code) -> Settings {
        let (mut ts_dirs, mut go_dirs) = (BTreeSet::new(), BTreeSet::new());
        for (path, file) in &code.files {
            let dirs = match file.lang {
                Lang::TypeScript | Lang::Tsx => &mut ts_dirs,
                Lang::Go => &mut go_dirs,
                _ => continue,
            };
            let mut dir = dir_of(path);
            // (a folder already in is in with all those above it)
            while dirs.insert(dir.to_string()) && !dir.is_empty() {
                dir = dir_of(dir);
            }
        }
        let mut ts: Vec<(String, TsPaths)> = ts_dirs
            .into_iter()
            .filter_map(|dir| {
                let paths: Vec<_> = ts_configs(root, &dir)
                    .iter()
                    .flat_map(|c| ts_config(root, c))
                    .collect();
                (!paths.is_empty()).then_some((dir, paths))
            })
            .collect();
        ts.sort_by_key(|(dir, _)| {
            std::cmp::Reverse(if dir.is_empty() {
                0
            } else {
                dir.matches('/').count() + 1
            })
        });
        let go = go_dirs
            .into_iter()
            .filter_map(|dir| {
                let text = std::fs::read_to_string(root.join(&dir).join("go.mod")).ok()?;
                let module = text.lines().find_map(|l| {
                    l.trim()
                        .strip_prefix("module ")
                        .map(|m| m.trim().trim_matches('"').to_string())
                })?;
                Some((dir, module))
            })
            .collect();
        Settings { ts, go }
    }

    /// The tsconfig paths a file sees: its nearest folder's first.
    fn ts_paths_for<'a>(
        &'a self,
        file: &'a str,
    ) -> impl Iterator<Item = &'a (String, Vec<String>)> {
        self.ts
            .iter()
            .filter(move |(dir, _)| crate::context::search::under_path(file, dir))
            .flat_map(|(_, paths)| paths)
    }
}

/// A folder's tsconfigs (tsconfig.json first, then jsconfig.json, then tsconfig.*.json), as
/// paths in the folder.
fn ts_configs(root: &Path, dir: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            n == "tsconfig.json"
                || n == "jsconfig.json"
                || (n.starts_with("tsconfig.") && n.ends_with(".json"))
        })
        .collect();
    names.sort_by_key(|n| (n != "tsconfig.json", n != "jsconfig.json", n.clone()));
    names.into_iter().map(|n| join(dir, &n)).collect()
}

/// A tsconfig's `compilerOptions.paths`, joined to where they're from: its `baseUrl` (or that
/// of one it extends), else the folder of the config that gave them. `rel` is its path in the
/// folder.
fn ts_config(root: &Path, rel: &str) -> TsPaths {
    let mut paths: Option<(String, serde_json::Map<String, serde_json::Value>)> = None;
    let mut base: Option<String> = None;
    let mut at = Some(rel.to_string());
    let mut seen = HashSet::new();
    while let Some(file) = at.take() {
        if !seen.insert(file.clone()) || seen.len() > EXTENDS {
            break;
        }
        let Some(json) = std::fs::read_to_string(root.join(&file))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&strip_jsonc(&t)).ok())
        else {
            break;
        };
        let dir = dir_of(&file);
        let options = &json["compilerOptions"];
        if base.is_none() {
            base = options["baseUrl"].as_str().and_then(|b| climb(dir, b));
        }
        if paths.is_none() {
            paths = options["paths"]
                .as_object()
                .map(|p| (dir.to_string(), p.clone()));
        }
        // (only a file of the folder: a package's, `@tsconfig/node20`, says nothing of its paths)
        at = extended(&json["extends"]).and_then(|e| {
            let e = if e.ends_with(".json") {
                e.to_string()
            } else {
                format!("{e}.json")
            };
            climb(dir, &e)
        });
    }
    let Some((dir, paths)) = paths else {
        return vec![];
    };
    let base = base.unwrap_or(dir);
    paths
        .iter()
        .map(|(alias, to)| {
            let to = to
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(serde_json::Value::as_str)
                        .filter_map(|p| climb(&base, p))
                        .collect()
                })
                .unwrap_or_default();
            (alias.clone(), to)
        })
        .collect()
}

/// The file a tsconfig extends (the last given wins: it's the one that counts most), if it's
/// a path rather than a package.
fn extended(value: &serde_json::Value) -> Option<&str> {
    let last = match value {
        serde_json::Value::Array(a) => a.iter().rev().find_map(serde_json::Value::as_str),
        v => v.as_str(),
    }?;
    last.starts_with('.').then_some(last)
}

/// JSON with comments (`//`, `/* */`) and trailing commas, as tsconfig.json allows: as JSON.
fn strip_jsonc(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < c.len() {
        if in_string {
            out.push(c[i]);
            if c[i] == '\\' {
                if let Some(&n) = c.get(i + 1) {
                    out.push(n);
                    i += 1;
                }
            } else if c[i] == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if let Some(after) = comment_end(&c, i) {
            i = after;
        } else if c[i] == ',' && closes(&c, i + 1) {
            i += 1;
        } else {
            in_string = c[i] == '"';
            out.push(c[i]);
            i += 1;
        }
    }
    out
}

/// Where a comment starting at `i` ends, if one does.
fn comment_end(c: &[char], i: usize) -> Option<usize> {
    match (c.get(i), c.get(i + 1)) {
        (Some('/'), Some('/')) => Some((i + 2..c.len()).find(|&j| c[j] == '\n').unwrap_or(c.len())),
        (Some('/'), Some('*')) => Some(
            (i + 2..c.len())
                .find(|&j| c[j] == '*' && c.get(j + 1) == Some(&'/'))
                .map_or(c.len(), |j| j + 2),
        ),
        _ => None,
    }
}

/// What comes at `i`, past spaces and comments, closes an object or an array.
fn closes(c: &[char], mut i: usize) -> bool {
    loop {
        match c.get(i) {
            Some(ch) if ch.is_whitespace() => i += 1,
            Some('}' | ']') => return true,
            Some(_) => match comment_end(c, i) {
                Some(after) => i = after,
                None => return false,
            },
            None => return false,
        }
    }
}

/// `rel` from folder `dir`, as a path in the folder: None if it climbs out of it.
fn climb(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

/// a/b joined with c/d, `.` and `..` worked out.
pub(super) fn join(dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    parts.join("/")
}

pub(super) fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Where `spec`, imported by file `from`, goes.
pub(super) fn resolve(g: &Graph, settings: &Settings, from: usize, spec: &str) -> Target {
    let file = &g.files[from];
    match file.lang {
        Lang::TypeScript | Lang::Tsx => typescript(g, settings, &file.path, spec),
        Lang::Python => python(g, &file.path, spec),
        Lang::Rust => rust(g, &file.path, spec),
        Lang::Go => go(g, settings, spec),
        Lang::CSharp | Lang::Java => {
            let files = g.namespaces.get(spec).cloned().unwrap_or_default();
            if !files.is_empty() {
                Target::Files(files)
            } else if file.lang == Lang::Java {
                // (a package from outside: by its first two parts, org.springframework)
                let parts: Vec<&str> = spec.split('.').take(2).collect();
                Target::External(parts.join("."))
            } else {
                Target::External(spec.to_string())
            }
        }
        Lang::Cpp => cpp(g, &file.path, spec),
    }
}

/// `#include "x.h"`: next to the file, else a file of the folder whose path ends so (an
/// include folder); `#include <x.h>` the same way, else a library's (by its first part).
fn cpp(g: &Graph, from: &str, spec: &str) -> Target {
    let system = spec.starts_with('<');
    let path = spec.trim_matches(['<', '>', '"']);
    if !system && let Some(&f) = g.by_path.get(&join(dir_of(from), path)) {
        return Target::Files(vec![f]);
    }
    match g.cpp_ends.get(path.trim_start_matches("./")) {
        Some(&f) => Target::Files(vec![f]),
        None => Target::External(path.split('/').next().unwrap_or(path).to_string()),
    }
}

fn first(g: &Graph, candidates: &[String]) -> Option<usize> {
    candidates.iter().find_map(|c| g.by_path.get(c).copied())
}

fn typescript(g: &Graph, settings: &Settings, from: &str, spec: &str) -> Target {
    let mut bases = vec![];
    if spec.starts_with('.') {
        bases.push(join(dir_of(from), spec));
    } else {
        for (alias, to) in settings.ts_paths_for(from) {
            let (head, wild) = alias
                .split_once('*')
                .map_or((alias.as_str(), false), |(h, _)| (h, true));
            if wild && spec.starts_with(head) {
                let rest = &spec[head.len()..];
                bases.extend(to.iter().map(|t| t.replacen('*', rest, 1)));
            } else if !wild && spec == alias {
                bases.extend(to.iter().cloned());
            }
        }
        if bases.is_empty() {
            let package = match spec.split('/').collect::<Vec<_>>()[..] {
                [scope, name, ..] if scope.starts_with('@') => format!("{scope}/{name}"),
                [name, ..] => name.to_string(),
                _ => spec.to_string(),
            };
            return Target::External(package);
        }
    }
    const EXTENSIONS: &[&str] = &[
        ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ];
    for base in bases {
        // (`./x.js` written for `./x.ts`, as ESM wants)
        let stem = base.strip_suffix(".js").unwrap_or(&base);
        let mut candidates = vec![base.clone()];
        candidates.extend(EXTENSIONS.iter().map(|e| format!("{stem}{e}")));
        candidates.extend(EXTENSIONS.iter().map(|e| format!("{base}/index{e}")));
        if let Some(f) = first(g, &candidates) {
            return Target::Files(vec![f]);
        }
    }
    Target::Nowhere
}

fn python(g: &Graph, from: &str, spec: &str) -> Target {
    let dots = spec.chars().take_while(|c| *c == '.').count();
    let module = spec[dots..].replace('.', "/");
    let candidates = |base: &str| {
        vec![
            format!("{base}.py"),
            format!("{base}/__init__.py"),
            format!("{base}.pyi"),
        ]
    };
    if dots > 0 {
        let mut dir = dir_of(from).to_string();
        for _ in 1..dots {
            dir = dir_of(&dir).to_string();
        }
        let base = if module.is_empty() {
            dir
        } else {
            join(&dir, &module)
        };
        return first(g, &candidates(&base)).map_or(Target::Nowhere, |f| Target::Files(vec![f]));
    }
    // (absolute: the module's path anywhere in the folder, the shortest such path winning, as a
    // source root nearest the top)
    let found = candidates(&module)
        .iter()
        .filter_map(|e| g.py_ends.get(e).copied())
        .min_by_key(|&f| g.files[f].path.len());
    match found {
        Some(i) => Target::Files(vec![i]),
        None => Target::External(spec.split('.').next().unwrap_or(spec).to_string()),
    }
}

/// The folder a Rust file's child modules are in: next to main.rs, lib.rs and mod.rs, else in
/// a folder named after the file.
fn rust_module_dir(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name {
        "main.rs" | "lib.rs" | "mod.rs" => dir_of(path).to_string(),
        _ => path.trim_end_matches(".rs").to_string(),
    }
}

/// The crate's root folder: where its main.rs or lib.rs is, going up from the file.
fn rust_crate_dir(g: &Graph, path: &str) -> String {
    let mut dir = dir_of(path).to_string();
    loop {
        if ["main.rs", "lib.rs"]
            .iter()
            .any(|f| g.by_path.contains_key(&join(&dir, f)))
            || dir.is_empty()
        {
            return dir;
        }
        dir = dir_of(&dir).to_string();
    }
}

fn rust(g: &Graph, from: &str, spec: &str) -> Target {
    let mut parts: Vec<&str> = spec.split("::").filter(|p| !p.is_empty()).collect();
    let mut dir = match parts.first() {
        Some(&"crate") => rust_crate_dir(g, from),
        Some(&"self") => rust_module_dir(from),
        Some(&"super") => dir_of(&rust_module_dir(from)).to_string(),
        // (`use page::*` next to a `mod page;`: a child module, else a crate from outside)
        Some(p) => {
            let here = rust_module_dir(from);
            let child = join(&here, p);
            if first(g, &[format!("{child}.rs"), format!("{child}/mod.rs")]).is_none() {
                return Target::External((*p).to_string());
            }
            parts.insert(0, "self");
            here
        }
        None => return Target::Nowhere,
    };
    parts.remove(0);
    while parts.first() == Some(&"super") {
        parts.remove(0);
        dir = dir_of(&dir).to_string();
    }
    if parts.is_empty() {
        // (the module itself: its own file, mod.rs or the crate root)
        let candidates = [
            join(&dir, "mod.rs"),
            join(&dir, "lib.rs"),
            join(&dir, "main.rs"),
            format!("{dir}.rs"),
        ];
        return first(g, &candidates).map_or(Target::Nowhere, |f| Target::Files(vec![f]));
    }
    // (the longest prefix of the path that's a module file: the rest are items in it)
    for n in (1..=parts.len()).rev() {
        let base = join(&dir, &parts[..n].join("/"));
        if let Some(f) = first(g, &[format!("{base}.rs"), format!("{base}/mod.rs")]) {
            return Target::Files(vec![f]);
        }
    }
    Target::Nowhere
}

fn go(g: &Graph, settings: &Settings, spec: &str) -> Target {
    // (the module whose path is the longest the import starts with)
    let found = settings
        .go
        .iter()
        .filter_map(|(dir, module)| {
            let rest = spec.strip_prefix(module.as_str())?;
            (rest.is_empty() || rest.starts_with('/'))
                .then(|| (module.len(), join(dir, rest.trim_start_matches('/'))))
        })
        .max_by_key(|(n, _)| *n);
    let Some((_, dir)) = found else {
        return Target::External(spec.to_string());
    };
    let files: Vec<usize> = g
        .by_dir
        .get(&dir)
        .into_iter()
        .flatten()
        .copied()
        .filter(|&i| {
            let f = &g.files[i];
            f.lang == Lang::Go && !f.path.ends_with("_test.go")
        })
        .collect();
    if files.is_empty() {
        Target::Nowhere
    } else {
        Target::Files(files)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn paths_join_and_go_up() {
        assert_eq!(join("src/a", "./b"), "src/a/b");
        assert_eq!(join("src/a", "../c/d"), "src/c/d");
        assert_eq!(join("", "x"), "x");
        assert_eq!(dir_of("src/a/b.ts"), "src/a");
        assert_eq!(dir_of("b.ts"), "");
    }

    /// A folder holding these files, removed when dropped.
    struct Folder(PathBuf);

    impl Folder {
        fn of(files: &[(&str, &str)]) -> Folder {
            let root = std::env::temp_dir()
                .join(format!("cbot-modules-{}", uuid::Uuid::new_v4().simple()));
            for (path, text) in files {
                let at = root.join(path);
                std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                std::fs::write(at, text).unwrap();
            }
            Folder(root)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn code_of(paths: &[&str]) -> Code {
        let mut code = Code::default();
        for path in paths {
            let ty = crate::context::langs::FileType::of(path).unwrap();
            code.put(
                path,
                ty,
                crate::context::parse::read(ty.lang().unwrap(), "").unwrap(),
            );
        }
        code
    }

    fn strings(v: &[(&str, &[&str])]) -> TsPaths {
        v.iter()
            .map(|(a, to)| {
                (
                    (*a).to_string(),
                    to.iter().map(|t| (*t).to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn jsonc_loses_its_comments_and_trailing_commas_but_not_its_strings() {
        let t = "{\n  // the pages\n  \"a\": \"http://x/*y*/\", /* why */\n  \"b\": [1, 2,],\n  \"c\": {\"d\": \",}\",}, // last\n}";
        let json: serde_json::Value = serde_json::from_str(&strip_jsonc(t)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"a": "http://x/*y*/", "b": [1, 2], "c": {"d": ",}"}})
        );
    }

    #[test]
    fn tsconfig_paths_come_from_its_base_or_what_it_extends() {
        let f = Folder::of(&[
            (
                "tsconfig.base.json",
                "{ \"compilerOptions\": { \"baseUrl\": \"./src\", } }",
            ),
            (
                "tsconfig.json",
                "{\n  \"extends\": \"./tsconfig.base\",\n  /* the pages */\n  \"compilerOptions\": { \"paths\": { \"@/*\": [\"./gui/*\"], \"x\": [\"../lib/x\"] } },\n}",
            ),
            (
                "web/tsconfig.app.json",
                "{ \"compilerOptions\": { \"paths\": { \"~/*\": [\"./app/*\"] } } }",
            ),
        ]);
        assert_eq!(
            ts_config(&f.0, "tsconfig.json"),
            strings(&[("@/*", &["src/gui/*"]), ("x", &["lib/x"])])
        );
        // (no baseUrl: from its own folder)
        assert_eq!(
            ts_config(&f.0, "web/tsconfig.app.json"),
            strings(&[("~/*", &["web/app/*"])])
        );
        assert!(ts_config(&f.0, "nope.json").is_empty());
    }

    #[test]
    fn a_file_sees_the_nearest_tsconfig_first_and_a_go_import_the_nearest_module() {
        let f = Folder::of(&[
            (
                "tsconfig.json",
                "{ \"compilerOptions\": { \"paths\": { \"@/*\": [\"./lib/*\"] } } }",
            ),
            (
                "web/tsconfig.app.json",
                "{ \"compilerOptions\": { \"paths\": { \"@/*\": [\"./src/*\"] } } }",
            ),
            ("svc/go.mod", "module example.com/svc\n\ngo 1.22\n"),
        ]);
        let code = code_of(&["web/src/a.ts", "lib/b.ts", "svc/api/h.go"]);
        let s = Settings::read(&f.0, &code);
        let seen = |file: &str| -> Vec<String> {
            s.ts_paths_for(file)
                .flat_map(|(_, to)| to.clone())
                .collect()
        };
        assert_eq!(seen("web/src/a.ts"), ["web/src/*", "lib/*"]);
        assert_eq!(seen("lib/b.ts"), ["lib/*"]);
        assert_eq!(s.go, [("svc".to_string(), "example.com/svc".to_string())]);
    }

    #[test]
    fn a_path_cannot_climb_out_of_the_folder() {
        assert_eq!(climb("a/b", "../c").as_deref(), Some("a/c"));
        assert_eq!(climb("", "./x/*").as_deref(), Some("x/*"));
        assert_eq!(climb("a", "../../c"), None);
    }

    #[test]
    fn a_rust_files_children_are_next_to_it_or_in_its_folder() {
        assert_eq!(rust_module_dir("src/main.rs"), "src");
        assert_eq!(rust_module_dir("src/a/mod.rs"), "src/a");
        assert_eq!(rust_module_dir("src/a/b.rs"), "src/a/b");
    }
}
