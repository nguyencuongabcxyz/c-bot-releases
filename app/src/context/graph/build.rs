//! Putting the graph together from every file's facts, in passes: the symbols and their full
//! names; each file's scope from its imports (a name brought in, a module under a name, a
//! file seen whole), following re-exports; which type each member belongs to (a Rust method
//! to the type its impl is for) and each type's typed fields; heritage; and last the calls,
//! each by what it goes through (calls.rs). And finding a type or a member by name, as a
//! file sees it.

use super::*;

/// How far a re-export (`pub use`, `export * from`, a package's __init__) is followed.
const REEXPORTS: u8 = 4;

impl Graph {
    pub(in crate::context) fn build(code: &Code, root: &Path) -> Graph {
        let mut g = Graph {
            generation: code.generation,
            settings: Settings::read(root, code),
            ..Graph::default()
        };
        g.symbols(code);
        g.scopes(code);
        g.owners(code);
        g.partials();
        g.heritage(code);
        g.calls(code);
        g
    }

    fn symbols(&mut self, code: &Code) {
        for (path, file) in &code.files {
            let i = self.files.len();
            let module = module_name(path, file.lang);
            let start = self.syms.len();
            let mut stack: Vec<(u8, usize)> = vec![];
            for d in &file.defs {
                while stack.last().is_some_and(|(depth, _)| *depth >= d.depth) {
                    stack.pop();
                }
                let parent = stack.last().map(|(_, s)| *s);
                // (a Go method is named after its receiver's type: pkg.S.Go)
                let receiver = file
                    .links
                    .receivers
                    .iter()
                    .find(|r| r.line == d.line && d.kind == Kind::Method);
                // (C#'s and PHP's namespaces and Java's packages name things, not their files:
                // N.Api.Get)
                let named_by_space = matches!(file.lang, Lang::CSharp | Lang::Java | Lang::Php);
                let fqn = match (parent, receiver) {
                    (Some(p), _) => format!("{}.{}", self.syms[p].fqn, d.name),
                    (None, Some(r)) => format!("{module}.{}.{}", r.ty.replace("::", "."), d.name),
                    (None, None) if named_by_space => d.name.clone(),
                    (None, None) => format!("{module}.{}", d.name),
                };
                let id = self.syms.len();
                if d.kind == Kind::Module && named_by_space {
                    self.namespaces.entry(d.name.clone()).or_default().push(i);
                }
                self.by_name.entry(d.name.clone()).or_default().push(id);
                self.syms.push(Sym {
                    file: i,
                    name: d.name.clone(),
                    kind: d.kind,
                    fqn,
                    parent,
                    line: d.line,
                    end: d.end,
                    sig: d.sig.clone(),
                });
                stack.push((d.depth, id));
            }
            self.by_path.insert(path.clone(), i);
            self.files.push(GFile {
                path: path.clone(),
                lang: file.lang,
                syms: start..self.syms.len(),
            });
        }
        let (n, files) = (self.syms.len(), self.files.len());
        self.owner = vec![None; n];
        self.supers = vec![vec![]; n];
        self.subs = vec![vec![]; n];
        self.calls_out = vec![vec![]; n];
        self.calls_in = vec![vec![]; n];
        self.imports = vec![BTreeSet::new(); files];
        self.imported_by = vec![BTreeSet::new(); files];
        self.externals = vec![BTreeSet::new(); files];
        self.lookups();
    }

    /// The files by folder, by the end of a Python or C++ file's path, and by a Rust module's
    /// name, so finding a module is a lookup rather than a pass over every file.
    fn lookups(&mut self) {
        for (i, f) in self.files.iter().enumerate() {
            self.by_dir
                .entry(modules::dir_of(&f.path).to_string())
                .or_default()
                .push(i);
            match f.lang {
                Lang::Python | Lang::Cpp => {
                    let lookup = if f.lang == Lang::Python {
                        &mut self.py_ends
                    } else {
                        &mut self.cpp_ends
                    };
                    let ends = std::iter::once(f.path.as_str())
                        .chain(f.path.match_indices('/').map(|(at, _)| &f.path[at + 1..]));
                    for end in ends {
                        let shortest = lookup.entry(end.to_string()).or_insert(i);
                        if f.path.len() < self.files[*shortest].path.len() {
                            *shortest = i;
                        }
                    }
                }
                Lang::Rust => {
                    let (dir, name) = f.path.rsplit_once('/').unwrap_or(("", &f.path));
                    let stem = match name.strip_suffix(".rs") {
                        Some("mod") => dir.rsplit_once('/').map(|(_, d)| d),
                        Some(s) if !dir.is_empty() => Some(s),
                        _ => None,
                    };
                    if let Some(stem) = stem {
                        self.rust_stems.entry(stem.to_string()).or_default().push(i);
                    }
                }
                _ => {}
            }
        }
    }

    /// A file's top-level symbols (in a C# namespace: still top-level).
    pub(super) fn top(&self, file: usize) -> impl Iterator<Item = usize> + '_ {
        self.files[file].syms.clone().filter(|&s| self.is_top(s))
    }

    pub(super) fn is_top(&self, s: usize) -> bool {
        match self.syms[s].parent {
            None => true,
            Some(p) => self.syms[p].kind == Kind::Module,
        }
    }

    /// What files export under `name`: their own top-level symbols, else their own under
    /// another name (`export default Store`), else what they re-export.
    pub(super) fn exported(
        &self,
        code: &Code,
        files: &[usize],
        name: &str,
        depth: u8,
    ) -> Vec<usize> {
        let mut found: Vec<usize> = files
            .iter()
            .flat_map(|&f| self.top(f).filter(|&s| self.syms[s].name == name))
            .collect();
        if found.is_empty() && depth < REEXPORTS {
            for &f in files {
                let Some(file) = code.files.get(&self.files[f].path) else {
                    continue;
                };
                for (_, local) in file.links.exports.iter().filter(|(e, _)| e == name) {
                    found.extend(self.exported(code, &[f], local, depth + 1));
                }
                for imp in &file.links.imports {
                    let passes = imp.all || imp.names.iter().any(|(_, local)| local == name);
                    if !passes {
                        continue;
                    }
                    let imported = imp
                        .names
                        .iter()
                        .find(|(_, l)| l == name)
                        .map_or(name, |(i, _)| i.as_str());
                    if let Target::Files(targets) = self.target(f, &imp.spec) {
                        found.extend(self.exported(code, &targets, imported, depth + 1));
                    }
                }
            }
        }
        found
    }

    fn target(&self, file: usize, spec: &str) -> Target {
        modules::resolve(self, &self.settings, file, spec)
    }

    // ---------------------------------------------------------------- scopes

    fn scopes(&mut self, code: &Code) {
        let mut scopes = Vec::with_capacity(self.files.len());
        for i in 0..self.files.len() {
            let path = self.files[i].path.clone();
            let mut scope = Scope::default();
            if let Some(file) = code.files.get(&path) {
                for imp in &file.links.imports {
                    self.import(code, i, imp, &mut scope);
                }
            }
            scopes.push(scope);
        }
        self.scopes = scopes;
    }

    /// One import into a file's scope, and the file edges it makes.
    fn import(&mut self, code: &Code, file: usize, imp: &Import, scope: &mut Scope) {
        let lang = self.files[file].lang;
        // (Rust's `mod x;` is the module x next to this one)
        if lang == Lang::Rust && imp.spec == "mod" {
            for (name, _) in &imp.names {
                if let Target::Files(f) = self.target(file, &format!("self::{name}")) {
                    self.link(file, &f);
                    scope.modules.insert(name.clone(), f);
                }
            }
            return;
        }
        let files = match self.target(file, &imp.spec) {
            Target::Files(f) => f,
            Target::External(name) => {
                self.externals[file].insert(name);
                scope
                    .outside
                    .extend(imp.names.iter().map(|(_, local)| local.clone()));
                return;
            }
            Target::Nowhere => vec![],
        };
        // (Java's `import a.b.Store` is of Store's own file, not of all its package's)
        if lang == Lang::Java && !imp.all {
            let own: Vec<usize> = imp
                .names
                .iter()
                .flat_map(|(name, _)| self.exported(code, &files, name, 0))
                .map(|s| self.syms[s].file)
                .collect();
            self.link(file, &own);
        } else {
            self.link(file, &files);
        }
        if imp.all {
            scope.wild.extend(&files);
        }
        let alias = imp.alias.clone().or_else(|| match lang {
            // (a Go package goes by its last part, a Python module by its first)
            Lang::Go if imp.names.is_empty() => imp.spec.rsplit('/').next().map(str::to_string),
            Lang::Python if imp.names.is_empty() && !imp.all => {
                imp.spec.split('.').next().map(str::to_string)
            }
            _ => None,
        });
        if let Some(alias) = alias {
            scope.modules.insert(alias, files.clone());
        }
        for (name, local) in &imp.names {
            let found = self.exported(code, &files, name, 0);
            if !found.is_empty() {
                scope.names.insert(local.clone(), found);
                continue;
            }
            // (`use crate::store;`, `from pkg import module`: the name is a module itself)
            let sub = match lang {
                Lang::Rust => format!("{}::{name}", imp.spec),
                Lang::Python if imp.spec.ends_with('.') => format!("{}{name}", imp.spec),
                Lang::Python => format!("{}.{name}", imp.spec),
                _ => continue,
            };
            if let Target::Files(f) = self.target(file, &sub) {
                self.link(file, &f);
                scope.modules.insert(local.clone(), f);
            }
        }
    }

    fn link(&mut self, from: usize, to: &[usize]) {
        for &t in to.iter().filter(|&&t| t != from) {
            self.imports[from].insert(t);
            self.imported_by[t].insert(from);
        }
    }

    // ---------------------------------------------------------------- members and heritage

    /// A C# partial type's parts, each of the others (`partial class DetailViewModel` in
    /// DetailViewModel.cs and DetailViewModel.FilterPopup.cs): one type, whose members and
    /// bases are all of theirs. Its parts share a full name (its namespace's, then its own).
    fn partials(&mut self) {
        let mut by_fqn: HashMap<&str, Vec<usize>> = HashMap::new();
        for (s, sym) in self.syms.iter().enumerate() {
            if self.files[sym.file].lang == Lang::CSharp && self.is_type(s) {
                by_fqn.entry(sym.fqn.as_str()).or_default().push(s);
            }
        }
        let mut partners: HashMap<usize, Vec<usize>> = HashMap::new();
        for parts in by_fqn.into_values().filter(|p| p.len() > 1) {
            for &p in &parts {
                partners.insert(p, parts.iter().copied().filter(|&o| o != p).collect());
            }
        }
        self.partners = partners;
    }

    /// A type's own parts: itself, and its other parts if it's a C# partial type.
    pub(super) fn parts(&self, ty: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::once(ty).chain(self.partners.get(&ty).into_iter().flatten().copied())
    }

    fn owners(&mut self, code: &Code) {
        for s in 0..self.syms.len() {
            let Some(p) = self.syms[s].parent else {
                continue;
            };
            let owner = match self.syms[p].kind {
                // (an impl for a type from outside, `impl Fields for Value`: its methods are its own)
                Kind::Impl => self
                    .resolve_type(self.syms[p].file, &self.syms[p].name.clone())
                    .or(Some(p)),
                k if k.holds_methods() => Some(p),
                _ => None,
            };
            if let Some(o) = owner {
                self.owner[s] = Some(o);
                self.members.entry(o).or_default().push(s);
            }
        }
        // (Go's methods belong to their receiver's type)
        let mut methods = vec![];
        for (i, f) in self.files.iter().enumerate() {
            let Some(file) = code.files.get(&f.path) else {
                continue;
            };
            for r in &file.links.receivers {
                let method = f
                    .syms
                    .clone()
                    .find(|&s| self.syms[s].line == r.line && self.syms[s].kind == Kind::Method);
                if let (Some(m), Some(t)) = (method, self.resolve_path(i, &r.ty)) {
                    methods.push((m, t));
                }
            }
        }
        for (m, t) in methods {
            // (C++'s `void Store::open() {}` defines what `void open();` in Store declares:
            // they're one method, its calls the declaration's)
            if self.files[self.syms[m].file].lang == Lang::Cpp
                && let Some(d) = self.declared_in(t, m)
            {
                self.declaration.insert(m, d);
            }
            self.owner[m] = Some(t);
            self.members.entry(t).or_default().push(m);
        }
        self.free_declarations();
        let mut fields = vec![];
        for (i, f) in self.files.iter().enumerate() {
            let Some(file) = code.files.get(&f.path) else {
                continue;
            };
            for m in &file.links.members {
                // (what a free function returns is its own `()`)
                let holder = if m.holder.is_empty() {
                    let name = m.name.trim_end_matches("()");
                    self.top(i)
                        .find(|&s| self.syms[s].name == name && self.syms[s].kind == Kind::Function)
                        .map(|s| (s, "()".to_string()))
                } else {
                    f.syms
                        .clone()
                        .find(|&s| self.syms[s].name == m.holder && self.is_type(s))
                        .map(|s| (s, m.name.clone()))
                };
                if let Some(at) = holder {
                    fields.push((at, m.ty.clone()));
                }
            }
        }
        self.fields.extend(fields);
    }

    fn heritage(&mut self, code: &Code) {
        for i in 0..self.files.len() {
            let Some(file) = code.files.get(&self.files[i].path) else {
                continue;
            };
            for h in &file.links.heritage {
                // (`impl Fields for Value`, Value from outside: the impl itself is below Fields)
                let impl_here = || {
                    self.files[i]
                        .syms
                        .clone()
                        .find(|&s| self.syms[s].kind == Kind::Impl && self.syms[s].line == h.line)
                };
                let (Some(sub), Some(sup)) = (
                    self.resolve_type(i, &h.sub).or_else(impl_here),
                    self.resolve_type(i, &h.sup),
                ) else {
                    continue;
                };
                if sub != sup && !self.supers[sub].iter().any(|(s, _)| *s == sup) {
                    self.supers[sub].push((sup, h.kind));
                    self.subs[sup].push((sub, h.kind));
                }
            }
        }
    }

    /// The method of type `t` that a definition outside it declares: of its name, with as many
    /// parameters if there are overloads.
    fn declared_in(&self, t: usize, def: usize) -> Option<usize> {
        let named: Vec<usize> = self
            .members_of(t)
            .iter()
            .copied()
            .filter(|&s| self.syms[s].parent == Some(t) && self.syms[s].name == self.syms[def].name)
            .collect();
        self.same_arity(&named, def)
    }

    /// Of these declarations of a function, the one with as many parameters as its definition
    /// `def` (an overload), else the first.
    fn same_arity(&self, decls: &[usize], def: usize) -> Option<usize> {
        let arity = |s: usize| {
            let sig = &self.syms[s].sig;
            let inside = sig.split_once('(').map_or("", |(_, r)| r);
            let inside = inside.rsplit_once(')').map_or(inside, |(l, _)| l).trim();
            if inside.is_empty() || inside == "void" {
                0
            } else {
                inside.matches(',').count() + 1
            }
        };
        decls
            .iter()
            .copied()
            .find(|&s| arity(s) == arity(def))
            .or_else(|| decls.first().copied())
    }

    /// A C++ type by its path as a file names it (`Logger::Scope`, `ce::Store`): the first
    /// part it can find, then each part a member of that; else the last part on its own.
    pub(super) fn resolve_path(&self, file: usize, path: &str) -> Option<usize> {
        let parts: Vec<&str> = path.split("::").filter(|p| !p.is_empty()).collect();
        let (&last, _) = parts.split_last()?;
        for start in 0..parts.len().saturating_sub(1) {
            let space = |s: usize| self.is_type(s) || self.syms[s].kind == Kind::Module;
            let Some(mut at) = self.resolve(file, parts[start], &space) else {
                continue;
            };
            let inside = parts[start + 1..].iter().all(|p| {
                let range = self.files[self.syms[at].file].syms.clone();
                let child = range
                    .into_iter()
                    .find(|&s| self.syms[s].parent == Some(at) && self.syms[s].name == *p);
                child.map(|c| at = c).is_some()
            });
            if inside && self.is_type(at) {
                return Some(at);
            }
        }
        self.resolve_type(file, last)
    }

    /// C++'s free functions defined in a file and declared ahead (`void run();`) in it or in a
    /// header it includes: one function, as its declaration.
    fn free_declarations(&mut self) {
        let declared_ahead = |s: &Sym| s.kind == Kind::Function && s.sig.ends_with(';');
        let mut found = vec![];
        for (s, sym) in self.syms.iter().enumerate() {
            let file = sym.file;
            if self.files[file].lang != Lang::Cpp
                || sym.kind != Kind::Function
                || declared_ahead(sym)
                || self.owner[s].is_some()
            {
                continue;
            }
            let decls: Vec<usize> = self.by_name.get(&sym.name).map_or(vec![], |named| {
                named
                    .iter()
                    .copied()
                    .filter(|&d| {
                        let df = self.syms[d].file;
                        d != s
                            && declared_ahead(&self.syms[d])
                            && self.files[df].lang == Lang::Cpp
                            && (df == file || self.imports[file].contains(&df))
                    })
                    .collect()
            });
            if let Some(d) = self.same_arity(&decls, s) {
                found.push((s, d));
            }
        }
        self.declaration.extend(found);
    }

    /// A symbol as calls know it: a C++ method defined outside its class is its declaration.
    pub(super) fn declared(&self, s: usize) -> usize {
        self.declaration.get(&s).copied().unwrap_or(s)
    }
}

/// A file's module path: its path without the extension, dotted; a module's own file (Rust's
/// mod.rs, Python's __init__.py, an index.ts) is its folder's.
fn module_name(path: &str, lang: Lang) -> String {
    let stem = path.rsplit_once('.').map_or(path, |(m, _)| m);
    let own = match lang {
        Lang::Rust => "mod",
        Lang::Python => "__init__",
        Lang::TypeScript | Lang::Tsx => "index",
        Lang::Go
        | Lang::CSharp
        | Lang::Java
        | Lang::Cpp
        | Lang::Kotlin
        | Lang::Swift
        | Lang::Php
        | Lang::Ruby
        | Lang::Bash
        | Lang::PowerShell
        | Lang::Dart
        | Lang::Zig
        | Lang::Prisma
        | Lang::Proto
        | Lang::Hcl => "",
    };
    let stem = stem
        .strip_suffix(own)
        .and_then(|s| s.strip_suffix('/'))
        .filter(|_| !own.is_empty())
        .unwrap_or(stem);
    stem.replace('/', ".")
}

pub(super) fn common_prefix(a: &str, b: &str) -> usize {
    a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count()
}
