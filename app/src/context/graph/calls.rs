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
            Via::Bare => self.bare(file, caller, &r.name),
            Via::This => self.enclosing(caller).and_then(|t| self.member(t, &r.name)),
            Via::Super => self.enclosing(caller).and_then(|t| {
                self.supers[t]
                    .iter()
                    .find_map(|&(s, _)| self.member(s, &r.name))
            }),
            Via::Field(fields) => self
                .enclosing(caller)
                .and_then(|t| self.through(t, fields.split('#')))
                .and_then(|t| self.member(t, &r.name)),
            Via::Typed(path) => {
                let mut parts = path.split('#');
                let first = parts.next().unwrap_or("");
                match self.start(file, first).map(|t| self.through(t, parts)) {
                    // (a member the type doesn't show, in another part of a partial class say:
                    // as a call through anything else)
                    Some(Some(t)) => self
                        .member(t, &r.name)
                        .or_else(|| self.chained(file, &r.name)),
                    // (a field whose type isn't the folder's own)
                    Some(None) => None,
                    // (a type that isn't the folder's own, a library's: `ILogger<T>`'s LogWarning
                    // is no method here of that name, but an extension method of it may be)
                    None if !first.ends_with("()") => self.extension(file, &r.name, first),
                    None => self.chained(file, &r.name),
                }
            }
            Via::Name(n) => self.named(code, file, caller, n, &r.name),
            Via::Unknown => self.chained(file, &r.name),
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

    /// Where a typed path starts: a type, or what a free function returns (`build()`).
    fn start(&self, file: usize, first: &str) -> Option<usize> {
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

    /// A bare call: a method of the type it's in (C#, Java, C++: through `this` unsaid; a
    /// property holding a delegate isn't one), else a function or type in reach.
    fn bare(&self, file: usize, caller: usize, name: &str) -> Option<usize> {
        if matches!(self.files[file].lang, Lang::CSharp | Lang::Java | Lang::Cpp)
            && let Some(m) = self.enclosing(caller).and_then(|t| self.member(t, name))
        {
            return self.callable(m).then_some(m);
        }
        let free = |s: usize| (self.callable(s) && self.owner[s].is_none()) || self.is_type(s);
        self.resolve(file, name, &free)
    }

    /// A call through a name: a field of the type it's in (C#'s `_store.Open()`), a type's
    /// member, a namespace's (TypeScript's, a class's of the same name too: `Checks.plateValid`,
    /// `Checks.Weight.withinLimit`), an imported module's function, a Rust module's (or what
    /// they re-export).
    fn named(&self, code: &Code, file: usize, caller: usize, n: &str, name: &str) -> Option<usize> {
        if let Some((at, ty)) = self.enclosing(caller).and_then(|t| self.field_type(t, n)) {
            return self
                .resolve_type(at, &ty)
                .and_then(|t| self.member(t, name));
        }
        let ty = self.resolve_type(file, n);
        if let Some(m) = ty.and_then(|t| self.member(t, name)) {
            return Some(m);
        }
        if let Some(m) = self.in_namespace(file, n, name) {
            return Some(m);
        }
        if ty.is_some() {
            return None;
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

/// The type a C# extension method extends: its first parameter's, after `this`.
fn receiver(sig: &str) -> Option<&str> {
    let after = sig.split_once("(this ")?.1;
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
    }
}
