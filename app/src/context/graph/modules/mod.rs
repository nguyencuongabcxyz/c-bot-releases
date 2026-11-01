//! Where an import goes: files of the folder, or a package from outside it. Each language
//! finds modules its own way: TypeScript and JavaScript by relative path or through the
//! nearest tsconfig.json's `paths` (typescript.rs); Python by dots for a relative import, else
//! by the module's dotted path; Rust by `crate::`, `self::`, `super::` and `mod x;`; Go by the
//! module path in the nearest go.mod; C# by namespace, Java by package; C++'s `#include` next
//! to the file, else by the end of a path in the folder; Dart, Zig, Ruby and the shells by
//! path, Dart's own package (`package:shop/…`) through the nearest pubspec.yaml, PHP by
//! namespace (scripts.rs).
//!   typescript.rs   tsconfig.json's paths, and TypeScript's and JavaScript's imports
//!   scripts.rs      Dart's, Zig's, PHP's, Ruby's, the shells'

mod scripts;
mod typescript;

use scripts::*;
use typescript::*;

use super::*;

/// Where an import goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Files(Vec<usize>),
    External(String),
    Nowhere,
}

/// What the folder says about its modules: its tsconfigs' paths, its go.mods' modules, its
/// pubspec.yamls' packages.
#[derive(Default)]
pub(super) struct Settings {
    /// Each folder's tsconfig paths, the deepest folder first.
    pub ts: Vec<(String, TsPaths)>,
    /// Each go.mod's folder and module path.
    pub go: Vec<(String, String)>,
    /// Each pubspec.yaml's folder and package name (Dart's `package:shop/…`).
    pub dart: Vec<(String, String)>,
}

impl Settings {
    /// The settings next to the folder's TypeScript, Go and Dart files, or above them.
    pub(super) fn read(root: &Path, code: &Code) -> Settings {
        let dirs = |langs: &[Lang]| {
            let mut dirs = BTreeSet::new();
            for (path, file) in &code.files {
                if !langs.contains(&file.lang) {
                    continue;
                }
                let mut dir = dir_of(path);
                // (a folder already in is in with all those above it)
                while dirs.insert(dir.to_string()) && !dir.is_empty() {
                    dir = dir_of(dir);
                }
            }
            dirs
        };
        Settings {
            ts: ts_settings(root, dirs(&[Lang::TypeScript, Lang::Tsx])),
            go: named_in(root, dirs(&[Lang::Go]), "go.mod", |text| {
                text.lines().find_map(|l| {
                    l.trim()
                        .strip_prefix("module ")
                        .map(|m| m.trim().trim_matches('"').to_string())
                })
            }),
            dart: named_in(root, dirs(&[Lang::Dart]), "pubspec.yaml", |text| {
                text.lines().find_map(|l| {
                    l.strip_prefix("name:")
                        .map(|n| n.trim().trim_matches(['"', '\'']).to_string())
                })
            }),
        }
    }
}

/// Of these folders, those holding this file, with the name `read` finds in it (a go.mod's
/// module, a pubspec.yaml's package).
fn named_in(
    root: &Path,
    dirs: BTreeSet<String>,
    file: &str,
    read: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    dirs.into_iter()
        .filter_map(|dir| {
            let text = std::fs::read_to_string(root.join(&dir).join(file)).ok()?;
            Some((dir.clone(), read(&text)?))
        })
        .collect()
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
        Lang::Dart => dart(g, settings, &file.path, spec),
        Lang::Zig => zig(g, &file.path, spec),
        Lang::Php => php(g, &file.path, spec),
        Lang::Ruby => ruby(g, &file.path, spec),
        Lang::Bash | Lang::PowerShell => script(g, &file.path, spec),
        // (their imports aren't read yet: extract/ sends none)
        Lang::Kotlin | Lang::Swift | Lang::Prisma | Lang::Proto | Lang::Hcl => Target::Nowhere,
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
        return first(g, &candidates(&base))
            .map(|f| Target::Files(vec![f]))
            .or_else(|| namespace_package(g, &base))
            .unwrap_or(Target::Nowhere);
    }
    // (absolute: the module's path anywhere in the folder, the shortest such path winning, as a
    // source root nearest the top)
    let found = candidates(&module)
        .iter()
        .filter_map(|e| g.py_ends.get(e).copied())
        .min_by_key(|&f| g.files[f].path.len());
    match found {
        Some(i) => Target::Files(vec![i]),
        None => {
            // (a folder without an __init__.py, PEP 420's: its modules, where it's at the top or
            // under a folder that's the root of the source)
            let folder = g
                .by_dir
                .keys()
                .filter(|d| *d == &module || d.ends_with(&format!("/{module}")))
                .min_by_key(|d| d.len());
            folder
                .and_then(|d| namespace_package(g, d))
                .unwrap_or_else(|| {
                    Target::External(spec.split('.').next().unwrap_or(spec).to_string())
                })
        }
    }
}

/// A Python namespace package (a folder of modules with no __init__.py): its modules.
fn namespace_package(g: &Graph, dir: &str) -> Option<Target> {
    let files: Vec<usize> = g
        .by_dir
        .get(dir)?
        .iter()
        .copied()
        .filter(|&f| g.files[f].lang == Lang::Python)
        .collect();
    (!files.is_empty()).then_some(Target::Files(files))
}

/// The folder a Rust file's child modules are in: next to main.rs, lib.rs and mod.rs, else in
/// a folder named after the file.
pub(super) fn rust_module_dir(path: &str) -> String {
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
    pub(super) struct Folder(pub(super) PathBuf);

    impl Folder {
        pub(super) fn of(files: &[(&str, &str)]) -> Folder {
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

    pub(super) fn code_of(paths: &[&str]) -> Code {
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
    fn a_rust_files_children_are_next_to_it_or_in_its_folder() {
        assert_eq!(rust_module_dir("src/main.rs"), "src");
        assert_eq!(rust_module_dir("src/a/mod.rs"), "src/a");
        assert_eq!(rust_module_dir("src/a/b.rs"), "src/a/b");
    }
}
