//! The imports of Dart, Zig, PHP, Ruby and the shells. Dart's: `package:shop/x.dart` is
//! lib/x.dart of the folder whose pubspec.yaml names the package shop (the deepest such folder
//! holding the file first), another package's or `dart:async` a package from outside;
//! anything else a path from the file. Zig's: `@import("x.zig")` a path from the file; `std`,
//! `builtin` or a package named in build.zig.zon from outside. PHP's `use App\Models\Store`:
//! the files declaring the namespace App\Models (else a package's, by its vendor); its
//! `require` a path. Ruby's `require_relative` a path, its `require 'shop/store'` the file of
//! the folder ending so (lib/shop/store.rb), else a gem's. A shell script's `source` and
//! PowerShell's dot-sourcing and `Import-Module ./x.psm1` a path; a module by its name alone
//! from outside.

use super::*;

/// A file of the folder, by its path from the file importing it.
fn path_from(g: &Graph, from: &str, spec: &str) -> Target {
    g.by_path
        .get(&join(dir_of(from), spec))
        .map_or(Target::Nowhere, |&f| Target::Files(vec![f]))
}

pub(super) fn dart(g: &Graph, settings: &Settings, from: &str, spec: &str) -> Target {
    if let Some(lib) = spec.strip_prefix("dart:") {
        return Target::External(format!("dart:{lib}"));
    }
    if let Some(rest) = spec.strip_prefix("package:") {
        let (package, path) = rest.split_once('/').unwrap_or((rest, ""));
        let own = settings
            .dart
            .iter()
            .filter(|(_, name)| name == package)
            .max_by_key(|(dir, _)| {
                let holds = crate::context::search::under_path(from, dir);
                (holds, dir.len())
            });
        return match own {
            Some((dir, _)) => g
                .by_path
                .get(&join(dir, &format!("lib/{path}")))
                .map_or(Target::Nowhere, |&f| Target::Files(vec![f])),
            None => Target::External(package.to_string()),
        };
    }
    path_from(g, from, spec)
}

pub(super) fn zig(g: &Graph, from: &str, spec: &str) -> Target {
    if !spec.ends_with(".zig") {
        return Target::External(spec.to_string());
    }
    path_from(g, from, spec)
}

pub(super) fn php(g: &Graph, from: &str, spec: &str) -> Target {
    if spec.starts_with("./") || spec.ends_with(".php") {
        return path_from(g, from, spec);
    }
    // (`use Exception;`: the global namespace's, PHP's own)
    if spec.is_empty() {
        return Target::Nowhere;
    }
    match g.namespaces.get(spec) {
        Some(files) if !files.is_empty() => Target::Files(files.clone()),
        _ => Target::External(spec.split('\\').next().unwrap_or(spec).to_string()),
    }
}

pub(super) fn ruby(g: &Graph, from: &str, spec: &str) -> Target {
    let file = if spec.ends_with(".rb") {
        spec.to_string()
    } else {
        format!("{spec}.rb")
    };
    if spec.starts_with('.') {
        return path_from(g, from, &file);
    }
    let end = format!("/{file}");
    let found = g
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.lang == Lang::Ruby && (f.path == file || f.path.ends_with(&end)))
        .min_by_key(|(_, f)| f.path.len());
    match found {
        Some((i, _)) => Target::Files(vec![i]),
        None => Target::External(spec.split('/').next().unwrap_or(spec).to_string()),
    }
}

/// A shell script's `source`, PowerShell's dot-sourcing and `Import-Module`.
pub(super) fn script(g: &Graph, from: &str, spec: &str) -> Target {
    let name = spec.rsplit('/').next().unwrap_or(spec);
    if spec.contains('/') || name.contains('.') {
        path_from(g, from, spec)
    } else {
        Target::External(spec.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Folder;
    use super::*;
    use crate::context::langs::FileType;
    use crate::context::parse;

    #[test]
    fn a_dart_package_import_goes_to_its_lib_folder_and_others_are_from_outside() {
        let f = Folder::of(&[("app/pubspec.yaml", "name: shop\nversion: 1.0.0\n")]);
        let mut code = Code::default();
        let files = [
            (
                "app/lib/data/store.dart",
                "class Store { void open() {} }\n",
            ),
            (
                "app/lib/main.dart",
                "import 'package:shop/data/store.dart';\nimport 'package:http/http.dart';\nimport 'dart:async';\nvoid run() { Store().open(); }\n",
            ),
        ];
        for (path, src) in files {
            let ty = FileType::of(path).unwrap();
            code.put(path, ty, parse::read(Lang::Dart, src).unwrap());
        }
        let g = Graph::build(&code, &f.0);
        let main = g.file_of("app/lib/main.dart").unwrap();
        let store = g.file_of("app/lib/data/store.dart").unwrap();
        assert!(g.imports[main].contains(&store));
        assert!(g.externals[main].contains("http") && g.externals[main].contains("dart:async"));
        assert_eq!(g.calls_in.iter().map(Vec::len).sum::<usize>(), 2);
    }
}
