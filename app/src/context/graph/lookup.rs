//! Finding a type or a member by name, as a file sees it: its own, imported, its package's or
//! namespace's, seen whole, else the only one in the folder (or the nearest); a type's members
//! (any of its parts, its supertypes'), the type a symbol is in, a field's declared type.

use super::*;

use super::build::common_prefix;

/// How far up a type's supertypes a member is looked for.
const SUPERS: u8 = 10;

impl Graph {
    pub(super) fn is_type(&self, s: usize) -> bool {
        let k = self.syms[s].kind;
        (k.holds_methods() && k != Kind::Impl) || k == Kind::Type
    }

    /// A type named so, as seen from `file`: its own, imported, its package's or namespace's,
    /// seen whole, else the only one in the folder (or the nearest, for C#, Go and Rust).
    pub(super) fn resolve_type(&self, file: usize, name: &str) -> Option<usize> {
        self.resolve(file, name, &|s| self.is_type(s))
    }

    /// A symbol named so that `keep` takes, as seen from `file` (as resolve_type).
    pub(super) fn resolve(
        &self,
        file: usize,
        name: &str,
        keep: &dyn Fn(usize) -> bool,
    ) -> Option<usize> {
        // (Go's `ast.File`: in the package imported as ast, if it's the folder's; a library's,
        // `testing.T`, is none of the folder's types)
        if self.files[file].lang == Lang::Go
            && let Some((pkg, rest)) = name.split_once('.')
        {
            let files = self.scopes[file].modules.get(pkg)?;
            return files
                .iter()
                .flat_map(|&f| self.top(f))
                .find(|&s| self.syms[s].name == rest && keep(s));
        }
        let pick = |mut cands: &mut dyn Iterator<Item = usize>| {
            Iterator::find(&mut cands, |&s| self.syms[s].name == name && keep(s))
        };
        if let Some(s) = pick(&mut self.files[file].syms.clone()) {
            return Some(s);
        }
        let scope = &self.scopes[file];
        // (imported under this name, whatever its own: `import { Planner as YardPlanner }`)
        if let Some(s) = scope
            .names
            .get(name)
            .and_then(|v| v.iter().copied().find(|&s| keep(s)))
        {
            return Some(s);
        }
        // (brought in from outside, `use std::path::Path`: not the folder's Path, wherever one is)
        if scope.outside.contains(name) {
            return None;
        }
        // (its package's or namespaces' top level: looked for among the symbols of that name,
        // which are fewer than the files of a big namespace)
        let neighbour = self.by_name.get(name).and_then(|named| {
            named.iter().copied().find(|&s| {
                let f = self.syms[s].file;
                f != file && self.is_top(s) && self.neighbours(file, f) && keep(s)
            })
        });
        if neighbour.is_some() {
            return neighbour;
        }
        // (Go: what another package's files show, dot-imported, is only what it exports)
        let exported = self.files[file].lang != Lang::Go || name.starts_with(char::is_uppercase);
        for &f in scope.wild.iter().filter(|_| exported) {
            if let Some(s) = pick(&mut self.top(f)) {
                return Some(s);
            }
            // (Rust's `use super::*` sees what that module brought in too: its `use`s)
            let Some(theirs) = self.scopes.get(f) else {
                continue;
            };
            let named = theirs.names.get(name);
            if let Some(s) = named.and_then(|v| v.iter().copied().find(|&s| keep(s))) {
                return Some(s);
            }
            if theirs.outside.contains(name) {
                return None;
            }
        }
        self.only(file, name, keep)
    }

    /// Whether `file` may name a symbol of another file at all: a Rust item without `pub` is
    /// its module's (and its children's) alone, `struct Path` in planes.rs no one else's Path.
    fn reachable(&self, file: usize, s: usize) -> bool {
        let there = self.syms[s].file;
        if there == file || self.files[file].lang != Lang::Rust || self.owner[s].is_some() {
            return true;
        }
        self.syms[s].sig.starts_with("pub")
            || crate::context::search::under_path(
                &self.files[file].path,
                &modules::rust_module_dir(&self.files[there].path),
            )
    }

    /// Whether a file sees another's top level without importing it: they're in one Go
    /// package, share a C# or PHP namespace, or are in one Java package.
    pub(super) fn neighbours(&self, file: usize, other: usize) -> bool {
        let (a, b) = (&self.files[file], &self.files[other]);
        match (a.lang, b.lang) {
            (Lang::Go, Lang::Go) => modules::dir_of(&a.path) == modules::dir_of(&b.path),
            (Lang::CSharp, Lang::CSharp) | (Lang::Java, Lang::Java) | (Lang::Php, Lang::Php) => {
                let spaces = |f: &GFile| -> Vec<&str> {
                    f.syms
                        .clone()
                        .filter(|&s| self.syms[s].kind == Kind::Module)
                        .map(|s| self.syms[s].name.as_str())
                        .collect()
                };
                let theirs = spaces(b);
                spaces(a).iter().any(|ns| theirs.contains(ns))
            }
            _ => false,
        }
    }

    /// The one symbol of that name `keep` takes in the language family; for C#, Go, Rust, Java,
    /// C++, PHP, Ruby (whose constants load without a require) and Dart, the one nearest `file`
    /// when there are several.
    pub(super) fn only(
        &self,
        file: usize,
        name: &str,
        keep: &dyn Fn(usize) -> bool,
    ) -> Option<usize> {
        let lang = self.files[file].lang;
        let cands: Vec<usize> = self
            .by_name
            .get(name)?
            .iter()
            .copied()
            .filter(|&s| {
                keep(s)
                    && family(lang, self.files[self.syms[s].file].lang)
                    && self.reachable(file, s)
                    // (Go: a name said alone is its own package's, or a builtin's: `copy`, `min`)
                    && (lang != Lang::Go || self.neighbours(file, self.syms[s].file))
            })
            .collect();
        match cands.len() {
            0 => None,
            1 => Some(cands[0]),
            _ if matches!(
                lang,
                Lang::CSharp
                    | Lang::Go
                    | Lang::Rust
                    | Lang::Java
                    | Lang::Cpp
                    | Lang::Php
                    | Lang::Ruby
                    | Lang::Dart
            ) =>
            {
                let here = &self.files[file].path;
                cands
                    .into_iter()
                    .max_by_key(|&s| common_prefix(here, &self.files[self.syms[s].file].path))
            }
            _ => None,
        }
    }

    /// A member of a type (any of its parts, or of its supertypes, nearest first), a callable
    /// before a field.
    pub(in crate::context) fn member(&self, ty: usize, name: &str) -> Option<usize> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([(ty, 0u8)]);
        while let Some((t, depth)) = queue.pop_front() {
            if !seen.insert(t) {
                continue;
            }
            let named: Vec<usize> = self
                .parts(t)
                .flat_map(|p| self.members_of(p).iter().copied())
                .filter(|&m| self.syms[m].name == name)
                .collect();
            let callable = named.iter().copied().find(|&m| {
                matches!(
                    self.syms[m].kind,
                    Kind::Method | Kind::Function | Kind::Constructor
                )
            });
            if let Some(m) = callable.or_else(|| named.first().copied()) {
                return Some(m);
            }
            if depth < SUPERS {
                for p in self.parts(t) {
                    queue.extend(self.supers[p].iter().map(|(s, _)| (*s, depth + 1)));
                }
            }
        }
        None
    }

    /// The type a symbol is in (itself, if it's a type): for calls through `this`.
    pub(super) fn enclosing(&self, sym: usize) -> Option<usize> {
        let mut at = Some(sym);
        while let Some(s) = at {
            if self.is_type(s) {
                return Some(s);
            }
            if let Some(o) = self.owner[s] {
                return Some(o);
            }
            at = self.syms[s].parent;
        }
        None
    }

    /// A field's declared type, in a type or its supertypes.
    pub(super) fn field_type(&self, ty: usize, field: &str) -> Option<(usize, String)> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([ty]);
        while let Some(t) = queue.pop_front() {
            if !seen.insert(t) {
                continue;
            }
            for p in self.parts(t) {
                if let Some(f) = self.fields.get(&(p, field.to_string())) {
                    return Some((self.syms[p].file, f.clone()));
                }
            }
            for p in self.parts(t) {
                queue.extend(self.supers[p].iter().map(|(s, _)| *s));
            }
        }
        None
    }
}
