//! The graph's last pass: each call and construction in a definition, resolved by what it
//! goes through. Bare (`load()`): the type it's in first (C#), then the file's own, imported
//! and seen names, then the only one of that name in the language. Through `this`: the type
//! it's in and its supertypes. Through a field: the field's declared type. Through a typed
//! local: that type. Through a name: a type (a static call, `Store::new`), a module imported
//! under that name, a Rust module of that name. Through anything else (`a().b()`): the only
//! method of that name, if the name says enough (`open_store`, never `find` or `as_str`: those
//! are more likely the standard library's). Calling a type makes one (Python's `Store()`, a
//! Rust tuple struct).

use super::*;

/// Compound names that the standard libraries' own methods have.
const STANDARD: &[&str] = &[
    // Rust
    "to_string",
    "as_str",
    "from_str",
    "to_owned",
    "into_iter",
    "iter_mut",
    "as_ref",
    "as_mut",
    "unwrap_or",
    "unwrap_or_default",
    "unwrap_or_else",
    "is_empty",
    "is_some",
    "is_none",
    "is_ok",
    "is_err",
    "map_err",
    "and_then",
    "or_else",
    "ok_or",
    "ok_or_else",
    "to_vec",
    "starts_with",
    "ends_with",
    "to_lowercase",
    "to_uppercase",
    "get_mut",
    "push_str",
    "extend_from_slice",
    "sort_by",
    "sort_by_key",
    "for_each",
    "filter_map",
    "flat_map",
    "find_map",
    "take_while",
    "skip_while",
    "split_once",
    "rsplit_once",
    "trim_start",
    "trim_end",
    "is_some_and",
    "or_default",
    "or_insert",
    "or_insert_with",
    "as_slice",
    "as_bytes",
    "to_path_buf",
    "file_name",
    "with_capacity",
    "contains_key",
    "get_or_insert_with",
    // TypeScript / JavaScript
    "toString",
    "valueOf",
    "forEach",
    "indexOf",
    "lastIndexOf",
    "startsWith",
    "endsWith",
    "toLowerCase",
    "toUpperCase",
    "addEventListener",
    "removeEventListener",
    "appendChild",
    "removeChild",
    "querySelector",
    "querySelectorAll",
    "getElementById",
    "setAttribute",
    "getAttribute",
    "removeAttribute",
    "preventDefault",
    "stopPropagation",
    "hasOwnProperty",
    "toFixed",
    "padStart",
    "padEnd",
    "flatMap",
    "findIndex",
    "replaceAll",
    "trimStart",
    "trimEnd",
    "localeCompare",
    "getBoundingClientRect",
    "insertBefore",
    "replaceChildren",
    "scrollIntoView",
    "toISOString",
    "getTime",
    "setTimeout",
    "toJSON",
    // C#
    "ToString",
    "GetHashCode",
    "GetType",
    "CompareTo",
    "ToList",
    "ToArray",
    "ToDictionary",
    "FirstOrDefault",
    "LastOrDefault",
    "SingleOrDefault",
    "OrderBy",
    "OrderByDescending",
    "ContainsKey",
    "TryGetValue",
    "AddRange",
    "GetValueOrDefault",
    "ConfigureAwait",
    // Go
    "WriteString",
    "ReadString",
    "WriteHeader",
    // Python
    "startswith",
    "endswith",
    "setdefault",
    "__init__",
    "__str__",
    "__repr__",
    "__eq__",
];

/// Whether a method name says enough to pin a call of it on the only method of that name: a
/// compound name (`open_store`, `getUserById`) that isn't a standard library's.
fn distinctive(name: &str) -> bool {
    let bare = name.trim_matches('_');
    let compound = bare.contains('_') || bare.chars().skip(1).any(char::is_uppercase);
    compound && bare.len() >= 6 && !STANDARD.contains(&name)
}

impl Graph {
    pub(super) fn calls(&mut self, code: &Code) {
        let mut edges: Vec<(usize, usize, RefKind, u32)> = vec![];
        for (i, f) in self.files.iter().enumerate() {
            let Some(file) = code.files.get(&f.path) else {
                continue;
            };
            for r in &file.links.refs {
                let Some(caller) = r
                    .within
                    .map(|w| f.syms.start + w as usize)
                    .filter(|c| f.syms.contains(c))
                else {
                    continue; // (code at the top of a file: no one calls from there)
                };
                if let Some((callee, kind)) = self.callee(code, i, caller, r) {
                    let (caller, callee) = (self.declared(caller), self.declared(callee));
                    if callee != caller {
                        edges.push((caller, callee, kind, r.line));
                    }
                }
            }
        }
        for (caller, callee, kind, line) in edges {
            add(&mut self.calls_out[caller], callee, kind, line);
            add(&mut self.calls_in[callee], caller, kind, line);
        }
    }

    /// What a reference in `file`, in `caller`, goes to.
    fn callee(&self, code: &Code, file: usize, caller: usize, r: &Ref) -> Option<(usize, RefKind)> {
        if r.kind == RefKind::New {
            return self.resolve_type(file, &r.name).map(|t| (t, RefKind::New));
        }
        let found = match &r.via {
            Via::Bare => self.bare(file, caller, &r.name, r.line),
            Via::This => self.enclosing(caller).and_then(|t| self.member(t, &r.name)),
            Via::Super => self.enclosing(caller).and_then(|t| {
                self.supers[t]
                    .iter()
                    .find_map(|&(s, _)| self.member(s, &r.name))
            }),
            Via::Field(fields) => self
                .enclosing(caller)
                .and_then(|t| self.through(t, fields.split('#')))
                .and_then(|t| self.member_or_impl(t, &r.name))
                .or_else(|| self.outside_impl(file, &r.name)),
            Via::Typed(path) => {
                let mut parts = path.split('#');
                let first = parts.next().unwrap_or("");
                match self.start(file, first).map(|t| self.through(t, parts)) {
                    // (a hub's member is the function its API holds; a member the type doesn't
                    // show, in another part of a partial class say: as a call through anything
                    // else)
                    Some(Some(t)) => match self.member_or_impl(t, &r.name) {
                        Some(m) if self.callable(m) => Some(m),
                        m => self
                            .api_function(t, &r.name)
                            .or(m)
                            .or_else(|| self.outside_impl(file, &r.name))
                            .or_else(|| self.chained(file, &r.name)),
                    },
                    // (a field whose type isn't the folder's own: but a method the folder gives
                    // what holds it may be called, `embedded_at.locked()` of a Mutex<Option<i64>>)
                    Some(None) => self.outside_impl(file, &r.name),
                    // (a type that isn't the folder's own, a library's: `ILogger<T>`'s LogWarning
                    // is no method here of that name, but an extension method of it may be)
                    // (or a method the folder gives it: `impl Fields for Value`, `c.folder()`)
                    None if !first.ends_with("()") => self
                        .extension(file, &r.name, first)
                        .or_else(|| self.outside_impl_for(file, &r.name, first)),
                    None => self.chained(file, &r.name),
                }
            }
            Via::Name(n) => self.named(code, file, caller, n, &r.name),
            Via::Unknown => self.chained(file, &r.name),
            Via::Command => self.command(&r.name),
        }?;
        let kind = if self.is_type(found) {
            RefKind::New
        } else {
            RefKind::Call
        };
        Some((self.overload(found, r.args), kind))
    }

    /// Of a method's overloads (its type's members of its name), the one taking `args`
    /// arguments, if the call says how many: the first that takes exactly so many.
    fn overload(&self, found: usize, args: Option<u32>) -> usize {
        let (Some(n), Some(owner)) = (args, self.owner[found]) else {
            return found;
        };
        let name = &self.syms[found].name;
        self.members_of(owner)
            .iter()
            .copied()
            .filter(|&m| self.syms[m].name == *name && self.callable(m))
            .find(|&m| params(&self.syms[m].sig) == Some(n))
            .unwrap_or(found)
    }

    /// A call through something of no known type (`a().b()`): the method of the name, if the
    /// name says enough and only one type has one (its overloads, the first: `overload` picks).
    /// Several types having one (an interface and the classes behind it), nearest is a guess.
    fn chained(&self, file: usize, name: &str) -> Option<usize> {
        if !distinctive(name) {
            return None;
        }
        let lang = self.files[file].lang;
        let mut found = self.by_name.get(name)?.iter().copied().filter(|&s| {
            self.owner[s].is_some()
                && self.callable(s)
                && family(lang, self.files[self.syms[s].file].lang)
        });
        let first = found.next()?;
        found
            .all(|s| self.owner[s] == self.owner[first])
            .then_some(first)
    }

    /// A member of a type, else, for an interface or a trait that doesn't declare it (one
    /// that extends a library's: `INavigationService : IMvxNavigationService`), the member of
    /// the name its one implementation in the folder has (`NavigationService.Navigate`).
    fn member_or_impl(&self, ty: usize, name: &str) -> Option<usize> {
        if let Some(m) = self.member(ty, name) {
            return Some(m);
        }
        if !matches!(self.syms[ty].kind, Kind::Interface | Kind::Trait) {
            return None;
        }
        let mut seen = HashSet::new();
        let mut queue: VecDeque<usize> = self.subs[ty].iter().map(|(s, _)| *s).collect();
        let mut found: Vec<usize> = vec![];
        while let Some(t) = queue.pop_front() {
            if !seen.insert(t) {
                continue;
            }
            found.extend(
                self.members_of(t)
                    .iter()
                    .copied()
                    .filter(|&m| self.syms[m].name == name && self.callable(m)),
            );
            queue.extend(self.subs[t].iter().map(|(s, _)| *s));
        }
        let first = *found.first()?;
        found
            .iter()
            .all(|&m| self.owner[m] == self.owner[first])
            .then_some(first)
    }
    /// The same for a type from outside named so (`Value` of `impl Fields for Value`): only an
    /// impl for that type.
    fn outside_impl_for(&self, file: usize, name: &str, ty: &str) -> Option<usize> {
        if self.files[file].lang != Lang::Rust {
            return None;
        }
        let ty = ty.rsplit("::").next().unwrap_or(ty);
        self.by_name.get(name)?.iter().copied().find(|&s| {
            self.callable(s)
                && self.files[self.syms[s].file].lang == Lang::Rust
                && self.owner[s]
                    .is_some_and(|o| self.syms[o].kind == Kind::Impl && self.syms[o].name == ty)
        })
    }

    /// A Rust call through a name that's a module path's start (`super::bare()`,
    /// `self::open()`, `crate::x()`: that module's own), or a `static` or `const` (`CACHED`,
    /// `static CACHED: Mutex<Option<Found>>`: its type's method, else one the folder gives a
    /// type from outside, `locked()`).
    fn rust_named(&self, code: &Code, file: usize, n: &str, name: &str) -> Option<usize> {
        if matches!(n, "super" | "self" | "crate") {
            let modules::Target::Files(files) = modules::resolve(self, &self.settings, file, n)
            else {
                return None;
            };
            return self.exported(code, &files, name, 0).first().copied();
        }
        let constant = self.resolve(file, n, &|s| self.syms[s].kind == Kind::Const)?;
        let sig = &self.syms[constant].sig;
        let declared = sig.split_once(':')?.1;
        let declared = declared.split('=').next().unwrap_or(declared);
        let ty = crate::context::graph::extract::type_name(declared);
        let at = self.syms[constant].file;
        // (`Mutex<Option<Found>>` is Found as calls go; `locked()` is Mutex's, the folder's impl)
        self.resolve_type(at, ty)
            .and_then(|t| self.member_or_impl(t, name))
            .or_else(|| self.outside_impl(file, name))
    }
    /// A Rust method of the name the folder gives a type from outside (`impl<T> Locked<T> for
    /// Mutex<T>`: `self.code.locked()`, where code is a `Mutex<Code>` and Code has no locked),
    /// when one impl alone has one.
    fn outside_impl(&self, file: usize, name: &str) -> Option<usize> {
        if self.files[file].lang != Lang::Rust {
            return None;
        }
        let mut found = self.by_name.get(name)?.iter().copied().filter(|&s| {
            self.callable(s)
                && self.files[self.syms[s].file].lang == Lang::Rust
                && self.owner[s].is_some_and(|o| self.syms[o].kind == Kind::Impl)
        });
        let first = found.next()?;
        found
            .all(|s| self.owner[s] == self.owner[first])
            .then_some(first)
    }

    /// A C# extension method of the name for a receiver of type `ty` (not the folder's own): one
    /// declared `(this ty …)`, else the folder's only extension method of the name (`this
    /// IServiceCollection` for a `ServiceCollection`); in one type only.
    fn extension(&self, file: usize, name: &str, ty: &str) -> Option<usize> {
        let lang = self.files[file].lang;
        let extensions: Vec<usize> = self
            .by_name
            .get(name)?
            .iter()
            .copied()
            .filter(|&s| {
                self.callable(s)
                    && family(lang, self.files[self.syms[s].file].lang)
                    && receiver(&self.syms[s].sig).is_some()
            })
            .collect();
        let exact: Vec<usize> = extensions
            .iter()
            .copied()
            .filter(|&s| receiver(&self.syms[s].sig) == Some(ty))
            .collect();
        let found = if exact.is_empty() { extensions } else { exact };
        let first = *found.first()?;
        found
            .iter()
            .all(|&s| self.owner[s] == self.owner[first])
            .then_some(first)
    }

    /// What a hub's member is: `r.deniedNote()` where r's type has `deniedNote:
    /// CommentaryApi['deniedNote']` (or picks it, `Pick<CommentaryApi, 'deniedNote'>`), and
    /// `CommentaryApi = ReturnType<typeof createCommentary>`, is createCommentary's own
    /// deniedNote: the function of the name inside the one that makes the API.
    fn api_function(&self, t: usize, name: &str) -> Option<usize> {
        let (file, ty) = self.field_type(t, name)?;
        let (api, member) = ty.strip_suffix("']")?.split_once("['")?;
        let api = self.resolve_type(file, api)?;
        let (at, made) = self.field_type(api, "=")?;
        let free = |s: usize| self.callable(s) && self.owner[s].is_none();
        let maker = self.resolve(at, made.strip_suffix("()")?, &free)?;
        self.files[self.syms[maker].file]
            .syms
            .clone()
            .find(|&s| self.syms[s].parent == Some(maker) && self.syms[s].name == member)
    }

    /// The command `invoke('name')` calls: the folder's one Rust free function of the name (none
    /// when there are several, or none: a plugin's).
    fn command(&self, name: &str) -> Option<usize> {
        let mut found = self.by_name.get(name)?.iter().copied().filter(|&s| {
            self.callable(s)
                && self.owner[s].is_none()
                && self.files[self.syms[s].file].lang == Lang::Rust
        });
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    /// Where a typed path starts: a type, what a free function returns (`build()`), or what a
    /// function gives the closure it's handed (CLOSURE_ARG).
    fn start(&self, file: usize, first: &str) -> Option<usize> {
        if let Some(rest) = first.strip_prefix(CLOSURE_ARG) {
            let mut parts = rest.rsplitn(3, ':');
            let param: usize = parts.next()?.parse().ok()?;
            let arg: usize = parts.next()?.parse().ok()?;
            let function = parts.next()?;
            let free = |s: usize| self.callable(s) && self.owner[s].is_none();
            let f = self.resolve(file, function, &free)?;
            let ty = closure_param(&self.syms[f].sig, arg, param)?;
            return self.resolve_type(self.syms[f].file, ty);
        }
        match first.strip_suffix("()") {
            Some(f) => {
                let free = |s: usize| self.callable(s) && self.owner[s].is_none();
                let function = self.resolve(file, f, &free)?;
                self.through(function, ["()"].into_iter())
            }
            None => self.resolve_type(file, first),
        }
    }

    /// The type reached from type `t` through these fields, each by its declared type.
    fn through<'p>(&self, t: usize, fields: impl Iterator<Item = &'p str>) -> Option<usize> {
        let mut at = t;
        for field in fields {
            let (file, ty) = self.field_type(at, field)?;
            at = self.resolve_type(file, &ty)?;
        }
        Some(at)
    }

    /// `name` in the namespace `path` (`Checks`, `Checks.Weight`) as `file` sees it.
    fn in_namespace(&self, file: usize, path: &str, name: &str) -> Option<usize> {
        let mut parts = path.split('.');
        let first = parts.next()?;
        let mut at = self.resolve(file, first, &|s| self.syms[s].kind == Kind::Module)?;
        for part in parts.chain([name]) {
            let range = self.files[self.syms[at].file].syms.clone();
            at = range
                .into_iter()
                .find(|&s| self.syms[s].parent == Some(at) && self.syms[s].name == part)?;
        }
        Some(at)
    }

    fn callable(&self, s: usize) -> bool {
        matches!(
            self.syms[s].kind,
            Kind::Function | Kind::Method | Kind::Constructor
        )
    }

    /// A bare call: a method of the type it's in (C#, Java, C++, Dart, Ruby: through `this`
    /// unsaid; a property holding a delegate isn't one), else a function or type in reach: the
    /// file's own that the call sees first.
    fn bare(&self, file: usize, caller: usize, name: &str, line: u32) -> Option<usize> {
        if matches!(
            self.files[file].lang,
            Lang::CSharp | Lang::Java | Lang::Cpp | Lang::Dart | Lang::Ruby
        ) && let Some(m) = self.enclosing(caller).and_then(|t| self.member(t, name))
        {
            return self.callable(m).then_some(m);
        }
        let free = |s: usize| (self.callable(s) && self.owner[s].is_none()) || self.is_type(s);
        if let Some(s) = self.in_scope(file, caller, name, line, &free) {
            return Some(s);
        }
        // (the file's others of the name are nested in definitions the call isn't in)
        self.resolve(file, name, &|s| free(s) && self.syms[s].file != file)
    }

    /// Of the file's own symbols of that name `keep` takes, the one a call at `line` in `caller`
    /// sees: one nested in a definition around the call (the innermost), else one at the file's
    /// level (or a namespace's). Of several there (a test file defines a helper again in each `describe` block),
    /// the last defined before the call, else the first; a function's overloads are one.
    pub(super) fn in_scope(
        &self,
        file: usize,
        caller: usize,
        name: &str,
        line: u32,
        keep: &dyn Fn(usize) -> bool,
    ) -> Option<usize> {
        let around: Vec<usize> =
            std::iter::successors(Some(caller), |&s| self.syms[s].parent).collect();
        let (mut nested, mut top): (Option<(usize, usize)>, Vec<usize>) = (None, vec![]);
        for s in self.files[file].syms.clone() {
            if self.syms[s].name != name || !keep(s) {
                continue;
            }
            // (a namespace's or an inline module's: as good as the file's level)
            match self.syms[s]
                .parent
                .filter(|&p| self.syms[p].kind != Kind::Module)
            {
                None => top.push(s),
                Some(p) => {
                    if let Some(depth) = around.iter().position(|&a| a == p)
                        && nested.is_none_or(|(best, _)| depth < best)
                    {
                        nested = Some((depth, s));
                    }
                }
            }
        }
        if let Some((_, s)) = nested {
            return Some(s);
        }
        let mut at = top
            .iter()
            .rposition(|&s| self.syms[s].line <= line)
            .unwrap_or(0);
        // (`function f(a: A): X;` and `function f(b: B): Y;` before its body: its first)
        while at > 0 && self.syms[top[at - 1]].end + 1 >= self.syms[top[at]].line {
            at -= 1;
        }
        top.get(at).copied()
    }

    /// A call through a name: a field of the type it's in (C#'s `_store.Open()`), a type's
    /// member, a namespace's (TypeScript's, a class's of the same name too: `Checks.plateValid`,
    /// `Checks.Weight.withinLimit`), an imported module's function, a Rust module's (or what
    /// they re-export).
    fn named(&self, code: &Code, file: usize, caller: usize, n: &str, name: &str) -> Option<usize> {
        if let Some((at, ty)) = self.enclosing(caller).and_then(|t| self.field_type(t, n)) {
            return self
                .resolve_type(at, &ty)
                .and_then(|t| self.member_or_impl(t, name));
        }
        let ty = self.resolve_type(file, n);
        if let Some(m) = ty.and_then(|t| self.member(t, name)) {
            return Some(m);
        }
        if let Some(m) = self.in_namespace(file, n, name) {
            return Some(m);
        }
        // (Rust: a module brought in by name, `use crate::platform::window;`, that's a `mod
        // window;` somewhere, re-exported or not: what its own file has)
        if self.files[file].lang == Lang::Rust
            && let Some(m) = self.resolve(file, n, &|s| self.syms[s].kind == Kind::Module)
            && self.syms[m].line == self.syms[m].end
            && let modules::Target::Files(files) = modules::resolve(
                self,
                &self.settings,
                self.syms[m].file,
                &format!("self::{n}"),
            )
            && let Some(&found) = self.exported(code, &files, name, 0).first()
        {
            return Some(found);
        }
        if ty.is_some() {
            return None;
        }
        if self.files[file].lang == Lang::Rust
            && let Some(found) = self.rust_named(code, file, n, name)
        {
            return Some(found);
        }
        let in_files = |files: &[usize]| self.exported(code, files, name, 0).first().copied();
        if let Some(files) = self.scopes[file].modules.get(n) {
            return in_files(files);
        }
        if self.files[file].lang == Lang::Rust {
            // (`store::open()` without a `use`: a module named store, in a folder this file is
            // in (the deepest), else the nearest)
            let here = &self.files[file].path;
            let mut stems = self.rust_stems.get(n).cloned().unwrap_or_default();
            stems.sort_by_key(|&f| {
                let path = &self.files[f].path;
                let module = path.strip_suffix("/mod.rs").unwrap_or(path);
                let parent = modules::dir_of(module);
                let above = crate::context::search::under_path(here, parent);
                std::cmp::Reverse((above, super::build::common_prefix(here, path)))
            });
            return in_files(&stems);
        }
        // (C#: a local of a type the walk doesn't know, `var dlg = Create()`: as a call through
        // anything else; a capitalised name is a library's type, `Console.WriteLine`)
        if self.files[file].lang == Lang::CSharp && n.starts_with(char::is_lowercase) {
            return self.chained(file, name);
        }
        None
    }
}

/// What a Rust function's signature says its `arg`th parameter, a closure, is given as its
/// `param`th: `State` of `fn with<R>(app: &App, f: impl FnOnce(&mut State) -> R)` for (1, 0);
/// the same when the closure's type is a generic's (`f: F` with `F: FnMut(&Store)`).
fn closure_param(sig: &str, arg: usize, param: usize) -> Option<&str> {
    let open = top_level(sig, '(')?;
    let params = split_top(&sig[open + 1..]);
    let ty = params.get(arg)?.split_once(':')?.1.trim();
    let ty = ty.strip_prefix("impl ").unwrap_or(ty).trim();
    fn fn_args(bound: &str) -> Option<&str> {
        let after = &bound[bound.find("Fn")?..];
        Some(&after[after.find('(')? + 1..])
    }
    let args = match fn_args(ty) {
        Some(a) => a,
        // (`f: F`: F's bound, in the generics or a where clause)
        None => {
            let bound = format!("{ty}: ");
            let at = sig.find(&bound)?;
            fn_args(&sig[at + bound.len()..])?
        }
    };
    let given = split_top(args);
    let ty = given.get(param)?;
    let ty = crate::context::graph::extract::type_name(ty);
    (!ty.is_empty()).then_some(ty)
}

/// Where the first `c` outside angle brackets is (a function's parameters, past its generics).
fn top_level(s: &str, c: char) -> Option<usize> {
    let mut depth = 0i32;
    for (i, ch) in s.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => depth -= 1,
            ch if ch == c && depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

/// What's at the top of a list that a `)` ends, split at its commas: `a: A, f: impl Fn(B, C)`
/// is `a: A` and `f: impl Fn(B, C)`.
fn split_top(s: &str) -> Vec<&str> {
    let mut parts = vec![];
    let (mut depth, mut from) = (0i32, 0);
    for (i, c) in s.char_indices() {
        match c {
            '(' | '<' | '[' => depth += 1,
            ')' | ']' if depth == 0 => {
                parts.push(s[from..i].trim());
                return parts.into_iter().filter(|p| !p.is_empty()).collect();
            }
            '>' if depth > 0 && !s[..i].ends_with('-') => depth -= 1,
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(s[from..i].trim());
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(s[from..].trim());
    parts.into_iter().filter(|p| !p.is_empty()).collect()
}

/// The type a C# extension method extends: its first parameter's, after `this`.
fn receiver(sig: &str) -> Option<&str> {
    // (`AddX(this IServiceCollection s`, or `AddX(` with `this` on the next line)
    let after = sig
        .match_indices('(')
        .find_map(|(i, _)| sig[i + 1..].trim_start().strip_prefix("this "))?;
    let ty = after.split_whitespace().next()?;
    // (`IServiceCollection` of `IServiceCollection services`; `ILogger<T>` is ILogger)
    let bare = ty.split('<').next().unwrap_or(ty);
    Some(bare.rsplit('.').next().unwrap_or(bare))
}

/// How many parameters a signature declares: the commas at the top of its first brackets
/// (after its attributes, C#'s `[Route("x")]`).
fn params(sig: &str) -> Option<u32> {
    let mut sig = sig.trim_start();
    while sig.starts_with('[') {
        let mut depth = 0;
        let end = sig.char_indices().find_map(|(i, c)| {
            match c {
                '[' => depth += 1,
                ']' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(i)
        })?;
        sig = sig[end + 1..].trim_start();
    }
    let inner = &sig[sig.find('(')? + 1..];
    let (mut depth, mut count, mut any, mut before) = (0i32, 0u32, false, ' ');
    for c in inner.chars() {
        match c {
            '(' | '<' | '[' | '{' => depth += 1,
            ')' if depth == 0 => return Some(if any { count + 1 } else { 0 }),
            '>' if before == '=' => {} // (an arrow, `=>`, closes nothing)
            ')' | '>' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => count += 1,
            c if !c.is_whitespace() => any = true,
            _ => {}
        }
        before = c;
    }
    None
}

/// An edge in (one more line on it if it's there already).
fn add(edges: &mut Vec<Edge>, to: usize, kind: RefKind, line: u32) {
    match edges.iter_mut().find(|e| e.to == to && e.kind == kind) {
        Some(e) => {
            if !e.lines.contains(&line) {
                e.lines.push(line);
            }
        }
        None => edges.push(Edge {
            to,
            kind,
            lines: vec![line],
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_compound_names_outside_the_standard_libraries_say_enough() {
        assert!(distinctive("open_store"));
        assert!(distinctive("getUserById"));
        assert!(!distinctive("find"));
        assert!(!distinctive("contains"));
        assert!(!distinctive("as_str"));
        assert!(!distinctive("toLowerCase"));
        assert!(!distinctive("__init__"));
        assert!(!distinctive("is_ok"));
    }

    #[test]
    fn a_signature_says_how_many_parameters_it_takes() {
        assert_eq!(params("write(text: string): void"), Some(1));
        assert_eq!(
            params("write(severity: Severity, text: string): void"),
            Some(2)
        );
        assert_eq!(
            params("f(a: Map<string, number>, b?: (x: number, y: number) => void)"),
            Some(2)
        );
        assert_eq!(params("now(): number"), Some(0));
        assert_eq!(params("Severity"), None);
        assert_eq!(
            params("[HttpGet(\"{id}\")] [Authorize] public Task<Order> Get(int id, string s)"),
            Some(2)
        );
    }

    #[test]
    fn an_extension_method_says_what_it_extends() {
        assert_eq!(
            receiver(
                "public static IServiceCollection AddChat(this IServiceCollection services, string p)"
            ),
            Some("IServiceCollection")
        );
        assert_eq!(
            receiver("static void Log(this Microsoft.Extensions.Logging.ILogger<T> l)"),
            Some("ILogger")
        );
        assert_eq!(receiver("public void Open(Store s)"), None);
        // (its parameters on lines of their own: the signature read as one line)
        assert_eq!(
            receiver(
                "public static IServiceCollection AddMcp( this IServiceCollection services, Action<O> a)"
            ),
            Some("IServiceCollection")
        );
    }
}

/// How many of a real folder's calls the graph follows, language by language: of the calls
/// whose name the folder defines something callable of (in the language's family), those it
/// resolves; and the kinds of call it misses most, with examples. Run on a folder with
/// `CBOT_AUDIT=<folder> cargo test audit -- --ignored --nocapture`.
#[cfg(test)]
mod live_tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::context::{ingest, parse};

    #[test]
    #[ignore]
    fn audit_how_many_calls_resolve() {
        let Ok(dir) = std::env::var("CBOT_AUDIT") else {
            return;
        };
        let root = Path::new(&dir);
        let (found, _) = ingest::find(root);
        let mut code = Code::default();
        for f in found {
            let Some(lang) = f.ty.lang() else {
                continue;
            };
            let Some(text) = ingest::read_code(&root.join(&f.rel)) else {
                continue;
            };
            if let Some(facts) = parse::read(lang, &text) {
                code.put(&f.rel, f.ty, facts);
            }
        }
        let g = Graph::build(&code, root);
        if let Ok(out) = std::env::var("CBOT_AUDIT_DUMP") {
            dump(&g, Path::new(&out));
        } // (lang -> (candidates, resolved)); (lang, how) -> misses, with a few examples
        let mut tally: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        let mut misses: BTreeMap<(String, String), (usize, Vec<String>)> = BTreeMap::new();
        let mut by_name: BTreeMap<(String, String), usize> = BTreeMap::new();
        for (i, f) in g.files.iter().enumerate() {
            let Some(file) = code.files.get(&f.path) else {
                continue;
            };
            for r in &file.links.refs {
                let Some(caller) = r.within.map(|w| f.syms.start + w as usize) else {
                    continue;
                };
                if !f.syms.contains(&caller) || !ours(&g, i, caller, r) {
                    continue;
                }
                let lang = format!("{:?}", f.lang);
                let t = tally.entry(lang.clone()).or_default();
                t.0 += 1;
                if g.callee(&code, i, caller, r).is_some() {
                    t.1 += 1;
                    continue;
                }
                let how = match (&r.kind, &r.via) {
                    (RefKind::New, _) => "new".to_string(),
                    (_, Via::Field(_)) => "field".into(),
                    (_, Via::Typed(_)) => "typed".into(),
                    (_, Via::Name(_)) => "name".into(),
                    (_, v) => format!("{v:?}").to_lowercase(),
                };
                *by_name.entry((lang.clone(), r.name.clone())).or_default() += 1;
                if std::env::var("CBOT_AUDIT_NAMES")
                    .is_ok_and(|n| n.split(',').any(|x| x == r.name || x == "*"))
                {
                    println!("MISS {} {:?} at {}:{}", r.name, r.via, f.path, r.line);
                }
                let m = misses.entry((lang, how)).or_default();
                m.0 += 1;
                if m.1.len() < 6 {
                    m.1.push(format!("{} {:?} at {}:{}", r.name, r.via, f.path, r.line));
                }
            }
        }
        for (lang, (all, resolved)) in &tally {
            let share = 100.0 * *resolved as f64 / (*all).max(1) as f64;
            println!("{lang}: {resolved}/{all} calls resolved ({share:.1}%)");
        }
        lost_imports(&g, &code);
        let mut names: Vec<_> = by_name.into_iter().collect();
        names.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        let top: Vec<String> = names
            .iter()
            .take(40)
            .map(|((l, n), c)| format!("{l}:{n}={c}"))
            .collect();
        println!("most missed names: {}", top.join(", "));
        let mut worst: Vec<_> = misses.into_iter().collect();
        worst.sort_by_key(|(_, (n, _))| std::cmp::Reverse(*n));
        for ((lang, how), (n, examples)) in worst.into_iter().take(16) {
            println!("  {lang} {how}: {n} missed");
            for e in examples {
                println!("      {e}");
            }
        }
    }

    /// The graph as two tables, to hold against another's (a SCIP index's): its symbols (index,
    /// path, first and last line, name, kind) and its call edges (caller, callee, kind, lines).
    fn dump(g: &Graph, dir: &Path) {
        let mut syms = String::new();
        for (i, s) in g.syms.iter().enumerate() {
            let kind = s.kind.word();
            let path = &g.files[s.file].path;
            syms.push_str(&format!(
                "{i}\t{path}\t{}\t{}\t{}\t{kind}\n",
                s.line, s.end, s.name
            ));
        }
        let mut edges = String::new();
        for (caller, out) in g.calls_out.iter().enumerate() {
            for e in out {
                let lines: Vec<String> = e.lines.iter().map(u32::to_string).collect();
                let kind = format!("{:?}", e.kind);
                edges.push_str(&format!(
                    "{caller}\t{}\t{kind}\t{}\n",
                    e.to,
                    lines.join(",")
                ));
            }
        }
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("syms.tsv"), syms);
        let _ = std::fs::write(dir.join("edges.tsv"), edges);
    }
    /// The imports of the folder's own that go nowhere, by language: a module it can't find,
    /// or one taken for a package from outside though the folder has a folder of its name.
    fn lost_imports(g: &Graph, code: &Code) {
        let mut imports: BTreeMap<String, (usize, usize, Vec<String>)> = BTreeMap::new();
        for (i, f) in g.files.iter().enumerate() {
            let Some(file) = code.files.get(&f.path) else {
                continue;
            };
            for imp in &file.links.imports {
                let e = imports.entry(format!("{:?}", f.lang)).or_default();
                e.0 += 1;
                // (nowhere, or "from outside" though the folder has a folder of that name at its
                // top: `src/x` taken for a package)
                let lost = match modules::resolve(g, &g.settings, i, &imp.spec) {
                    modules::Target::Nowhere => true,
                    modules::Target::External(p) => g.by_dir.keys().any(|d| *d == p),
                    modules::Target::Files(_) => false,
                };
                if lost {
                    e.1 += 1;
                    if e.2.len() < 4 {
                        e.2.push(format!("{} in {}", imp.spec, f.path));
                    }
                }
            }
        }
        for (lang, (all, nowhere, examples)) in &imports {
            println!("{lang}: {nowhere}/{all} imports go nowhere {examples:?}");
        }
    }

    /// Whether a call is one the graph should follow: to a name the folder defines something
    /// callable of, through something of the folder's own (a type, a module it imports, a
    /// field or a value of one of its types, `this`), not a library's (`fmt.Errorf`,
    /// `DateTime.ToString`, Go's `len`).
    fn ours(g: &Graph, file: usize, caller: usize, r: &Ref) -> bool {
        let lang = g.files[file].lang;
        let defined = |keep: &dyn Fn(usize) -> bool| {
            g.by_name.get(&r.name).is_some_and(|named| {
                named
                    .iter()
                    .any(|&s| keep(s) && family(lang, g.files[g.syms[s].file].lang))
            })
        };
        let member = |s: usize| g.callable(s) && g.owner[s].is_some();
        if r.kind == RefKind::New {
            return defined(&|s| g.is_type(s));
        }
        // (a method said alone is the type's own only where `this` goes unsaid)
        let unsaid = matches!(
            lang,
            Lang::CSharp | Lang::Java | Lang::Cpp | Lang::Dart | Lang::Ruby
        );
        match &r.via {
            Via::Bare => {
                defined(&|s| (g.callable(s) && (g.owner[s].is_none() || unsaid)) || g.is_type(s))
            }
            Via::This | Via::Super | Via::Unknown => defined(&member),
            Via::Field(fields) => {
                g.enclosing(caller)
                    .and_then(|t| g.through(t, fields.split('#')))
                    .is_some()
                    && defined(&member)
            }
            // (the whole path the folder's own: `helper.OsType.ToString()` through a library's
            // enum isn't)
            Via::Typed(path) => {
                let mut parts = path.split('#');
                let first = parts.next().unwrap_or("");
                g.start(file, first)
                    .and_then(|t| g.through(t, parts))
                    .is_some()
                    && defined(&member)
            }
            Via::Name(n) => {
                let folder_type = g.resolve_type(file, n).is_some();
                let module = g.scopes[file].modules.contains_key(n.as_str());
                let field = g
                    .enclosing(caller)
                    .and_then(|t| g.field_type(t, n))
                    .and_then(|(at, ty)| g.resolve_type(at, &ty))
                    .is_some();
                (folder_type || module || field || n.contains('.'))
                    && defined(&|s| g.callable(s) || g.is_type(s))
            }
            Via::Command => true,
        }
    }
}
