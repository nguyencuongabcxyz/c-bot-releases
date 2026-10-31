//! The code graph: who calls what, what imports what, what extends what, across a folder.
//! Each file keeps only its own links (facts.rs), read with its definitions (extract/); the
//! graph is put together from every file's at once when it's first asked about (build.rs,
//! modules.rs), kept till the folder's generation moves on, and walked to answer
//! (queries.rs). A symbol's full name is its file's module path, then the names holding it:
//! `app.src.store.Store.open` (store/mod.rs: a module's own file is its folder's).
//!   facts.rs     what a file says: imports, calls and constructions, heritage, typed fields
//!   extract/     reading them from its syntax tree, language by language
//!   modules.rs   where an import goes: files of the folder, or a package from outside
//!   build.rs     putting the graph together: symbols, scopes, members and heritage, calls
//!   queries.rs   walking it: callers, call chains, dependencies, hierarchies, impact

mod build;
mod calls;
mod extract;
mod facts;
mod modules;
mod queries;

pub(in crate::context) use extract::links;
pub(in crate::context) use facts::*;

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::ops::Range;
use std::path::Path;

use super::code::Code;
use super::langs::{Kind, Lang};
use modules::{Settings, Target};

/// A file of the graph.
pub(in crate::context) struct GFile {
    pub path: String,
    pub lang: Lang,
    pub syms: Range<usize>, // (its symbols, in the order it defines them)
}

/// A definition, as the graph knows it.
pub(in crate::context) struct Sym {
    pub file: usize,
    pub name: String,
    pub kind: Kind,
    pub fqn: String,
    pub parent: Option<usize>,
    pub line: u32,
    pub end: u32,
    pub sig: String,
}

/// An edge to another symbol (a callee from a caller, or a caller from a callee), with the
/// lines of each call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::context) struct Edge {
    pub to: usize,
    pub kind: RefKind,
    pub lines: Vec<u32>,
}

/// The names a file can reach besides its own: what it imported by name, the modules it
/// imported whole (under a name), and the files whose top level it sees all of.
#[derive(Default)]
struct Scope {
    names: HashMap<String, Vec<usize>>,
    modules: HashMap<String, Vec<usize>>,
    wild: Vec<usize>,
}

#[derive(Default)]
pub(in crate::context) struct Graph {
    pub generation: i64,
    settings: Settings,
    pub files: Vec<GFile>,
    by_path: HashMap<String, usize>,
    pub syms: Vec<Sym>,
    by_name: HashMap<String, Vec<usize>>,
    namespaces: HashMap<String, Vec<usize>>, // (C#: a namespace -> the files declaring it)
    by_dir: HashMap<String, Vec<usize>>,     // (a folder -> the files right in it)
    py_ends: HashMap<String, usize>, // (the end of a Python file's path -> the shortest such file)
    cpp_ends: HashMap<String, usize>, // (the same for C++: where an #include goes)
    rust_stems: HashMap<String, Vec<usize>>, // (store -> the files a/store.rs, a/store/mod.rs)
    scopes: Vec<Scope>,
    owner: Vec<Option<usize>>, // (a member -> the type it's a member of)
    members: HashMap<usize, Vec<usize>>, // (a type -> its members)
    declaration: HashMap<usize, usize>, // (C++: a method defined outside its class -> its declaration)
    fields: HashMap<(usize, String), String>, // ((a type, a field) -> the field's declared type)
    pub supers: Vec<Vec<(usize, Heir)>>,
    pub subs: Vec<Vec<(usize, Heir)>>,
    pub calls_out: Vec<Vec<Edge>>,
    pub calls_in: Vec<Vec<Edge>>,
    pub imports: Vec<BTreeSet<usize>>,
    pub imported_by: Vec<BTreeSet<usize>>,
    pub externals: Vec<BTreeSet<String>>,
}

impl Graph {
    pub(in crate::context) fn file_of(&self, path: &str) -> Option<usize> {
        self.by_path.get(path).copied().or_else(|| {
            self.files
                .iter()
                .position(|f| f.path.eq_ignore_ascii_case(path))
        })
    }

    pub(in crate::context) fn path(&self, sym: usize) -> &str {
        &self.files[self.syms[sym].file].path
    }

    /// The type a symbol is a member of, if it is one.
    pub(in crate::context) fn owner_of(&self, sym: usize) -> Option<usize> {
        self.owner[sym]
    }

    pub(in crate::context) fn members_of(&self, ty: usize) -> &[usize] {
        self.members.get(&ty).map_or(&[], Vec::as_slice)
    }

    /// Whether each symbol is a test: all of a test file, what a Rust `mod tests` holds.
    pub(in crate::context) fn tests(&self) -> Vec<bool> {
        let test_files: Vec<bool> = self.files.iter().map(|f| test_file(&f.path)).collect();
        let mut out: Vec<bool> = Vec::with_capacity(self.syms.len());
        for sym in &self.syms {
            let own = sym.kind == Kind::Module && sym.name == "tests";
            // (a parent comes before what it holds)
            let held = sym.parent.is_some_and(|p| out[p]);
            out.push(test_files[sym.file] || own || held);
        }
        out
    }

    /// How many calls it knows (each caller and callee once).
    pub(in crate::context) fn edge_count(&self) -> usize {
        self.calls_out.iter().map(Vec::len).sum()
    }

    /// The symbols a file imported by name.
    pub(in crate::context) fn imported(&self, file: usize) -> impl Iterator<Item = usize> + '_ {
        self.scopes[file].names.values().flatten().copied()
    }
}

fn test_file(rel: &str) -> bool {
    let path = rel.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or("");
    path.contains("/tests/")
        || path.starts_with("tests/")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("_test.go")
        || name.ends_with("tests.cs")
        || name.starts_with("test_")
}

/// TypeScript and JavaScript are one family: a name in one can be defined in the other.
fn family(a: Lang, b: Lang) -> bool {
    a == b
        || (matches!(a, Lang::TypeScript | Lang::Tsx) && matches!(b, Lang::TypeScript | Lang::Tsx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::langs::FileType;
    use crate::context::parse;

    pub(super) fn graph(files: &[(&str, &str)]) -> Graph {
        let mut code = Code::default();
        for (path, src) in files {
            let ty = FileType::of(path).unwrap();
            code.put(path, ty, parse::read(ty.lang().unwrap(), src).unwrap());
        }
        Graph::build(&code, Path::new("no such folder"))
    }

    /// Every call edge, as "caller -> callee:the line it's defined on".
    fn calls_at(g: &Graph) -> Vec<String> {
        let mut out = vec![];
        for (s, edges) in g.calls_out.iter().enumerate() {
            for e in edges {
                out.push(format!(
                    "{} -> {}:{}",
                    g.syms[s].fqn, g.syms[e.to].fqn, g.syms[e.to].line
                ));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn typescript_follows_destructuring_items_returns_super_and_overloads() {
        let g = graph(&[
            (
                "src/log.ts",
                "export class Log {\n  write(text: string): void;\n  write(level: number, text: string): void;\n  write(a: any, b?: any): void {}\n  count(): number { return 0; }\n}\n",
            ),
            (
                "src/base.ts",
                "import { Log } from './log';\nexport class Base {\n  constructor(protected log: Log) {}\n  describe(): string { return ''; }\n}\nexport class Child extends Base {\n  constructor(log: Log) {\n    super(log);\n  }\n  describe(): string {\n    return super.describe();\n  }\n  again(): this { return this; }\n}\n",
            ),
            (
                "src/main.ts",
                "import { Log as Journal } from './log';\nimport { Child } from './base';\ninterface World {\n  readonly log: Journal;\n  readonly kids: Child[];\n}\nfunction build(): World {\n  return { log: new Journal(), kids: [] };\n}\nfunction run() {\n  const world = build();\n  const { log, kids } = world;\n  log.write('a');\n  log.write(1, 'b');\n  for (const kid of kids) {\n    kid.describe();\n  }\n  kids.filter((k) => k.again());\n  world.log.count();\n  new Child(log)\n    .again()\n    .describe();\n}\n",
            ),
        ]);
        assert_eq!(
            calls_at(&g),
            [
                "src.base.Child.constructor -> src.base.Base.constructor:3",
                "src.base.Child.describe -> src.base.Base.describe:4",
                "src.main.build -> src.log.Log:1",
                "src.main.run -> src.base.Child.again:13",
                "src.main.run -> src.base.Child.describe:10",
                "src.main.run -> src.base.Child:6",
                "src.main.run -> src.log.Log.count:5",
                "src.main.run -> src.log.Log.write:2",
                "src.main.run -> src.log.Log.write:3",
                "src.main.run -> src.main.build:7",
            ]
        );
        // (each call on its own line, in a chain over several)
        let run = g.resolve_name("run", "")[0];
        let lines = |name: &str| -> Vec<u32> {
            g.calls_out[run]
                .iter()
                .filter(|e| g.syms[e.to].name == name)
                .flat_map(|e| e.lines.clone())
                .collect()
        };
        assert_eq!(lines("again"), [18, 21]);
        assert_eq!(lines("describe"), [16, 22]);
    }

    #[test]
    fn typescript_calls_into_namespaces_and_a_class_namesake() {
        let g = graph(&[(
            "src/gate.ts",
            "export class Lane {\n  admit(): void {}\n}\nexport namespace Lane {\n  export function open(): Lane[] { return []; }\n}\nnamespace Checks {\n  export namespace Weight {\n    export function ok(): boolean { return true; }\n  }\n}\nfunction run() {\n  Lane.open();\n  Checks.Weight.ok();\n}\n",
        )]);
        assert_eq!(
            calls(&g),
            [
                "src.gate.run -> src.gate.Checks.Weight.ok",
                "src.gate.run -> src.gate.Lane.open"
            ]
        );
    }

    #[test]
    fn a_method_overrides_the_nearest_of_its_name_and_a_constructor_none() {
        let g = graph(&[(
            "src/a.ts",
            "interface Shape {\n  area(): number;\n}\nclass A implements Shape {\n  constructor() {}\n  area(): number { return 1; }\n}\nclass B extends A {\n  constructor() { super(); }\n  area(): number { return 2; }\n}\nclass C extends B {\n  area(): number { return 3; }\n}\n",
        )]);
        let named = |v: Vec<usize>| -> Vec<String> {
            v.into_iter().map(|s| g.syms[s].fqn.clone()).collect()
        };
        let at = |fqn: &str| g.resolve_name(fqn, "")[0];
        assert_eq!(named(g.overrides(at("src.a.C.area")).1), ["src.a.B.area"]);
        assert_eq!(
            named(g.overrides(at("src.a.A.area")).1),
            ["src.a.Shape.area"]
        );
        assert_eq!(named(g.overrides(at("src.a.A.area")).0), ["src.a.B.area"]);
        assert!(g.overrides(at("src.a.B.constructor")).1.is_empty());
    }

    #[test]
    fn a_call_through_a_module_follows_what_it_re_exports() {
        let g = graph(&[
            (
                "src/chat/mod.rs",
                "mod page;\npub use page::*;\npub fn note() {}\n",
            ),
            ("src/chat/page.rs", "pub fn ask() {}\n"),
            (
                "src/ipc.rs",
                "use crate::chat;\nfn robot_ask() {\n    chat::ask();\n    chat::note();\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.ipc.robot_ask -> src.chat.note",
                "src.ipc.robot_ask -> src.chat.page.ask"
            ]
        );
    }

    #[test]
    fn tests_are_what_a_test_file_or_mod_tests_holds() {
        let g = graph(&[
            (
                "src/a.rs",
                "pub fn real() {}\nmod tests {\n    fn checks() {}\n}\n",
            ),
            ("tests/b.rs", "fn other() {}\n"),
        ]);
        let named: Vec<(&str, bool)> = g
            .syms
            .iter()
            .zip(g.tests())
            .map(|(s, t)| (s.name.as_str(), t))
            .collect();
        assert_eq!(
            named,
            [
                ("real", false),
                ("tests", true),
                ("checks", true),
                ("other", true)
            ]
        );
    }

    /// Every call edge, as "caller -> callee".
    fn calls(g: &Graph) -> Vec<String> {
        let mut out = vec![];
        for (s, edges) in g.calls_out.iter().enumerate() {
            for e in edges {
                let new = if e.kind == RefKind::New { " (new)" } else { "" };
                out.push(format!("{} -> {}{new}", g.syms[s].fqn, g.syms[e.to].fqn));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn java_calls_across_a_package_and_its_imports() {
        let g = graph(&[
            (
                "src/main/java/shop/data/Store.java",
                "package shop.data;\npublic class Store {\n  public void open() { check(); }\n  void check() {}\n}\n",
            ),
            (
                "src/main/java/shop/data/Cache.java",
                "package shop.data;\npublic class Cache extends Store {\n  public void warm() { new Store().open(); }\n}\n",
            ),
            (
                "src/main/java/shop/Api.java",
                "package shop;\nimport shop.data.Store;\npublic class Api {\n  private Store store;\n  public void get() {\n    store.open();\n    this.store.open();\n  }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "Api.get -> Store.open",
                "Cache.warm -> Store (new)",
                "Cache.warm -> Store.open",
                "Store.open -> Store.check",
            ]
        );
        let api = g.file_of("src/main/java/shop/Api.java").unwrap();
        assert_eq!(g.imports[api].len(), 1);
    }

    #[test]
    fn cpp_calls_through_includes_and_methods_defined_outside_their_class() {
        let g = graph(&[
            (
                "include/store.h",
                "#pragma once\nclass Store {\npublic:\n  void open();\n  void check();\n};\n",
            ),
            (
                "src/store.cpp",
                "#include \"store.h\"\nvoid Store::open() {\n  check();\n}\nvoid Store::check() {}\n",
            ),
            (
                "src/api.cpp",
                "#include \"store.h\"\nclass Api {\n  Store* store;\n  void get() {\n    store->open();\n    Store local;\n    local.check();\n  }\n};\n",
            ),
        ]);
        // (Store::open in store.cpp is the open Store declares: its calls are that one's)
        assert_eq!(
            calls(&g),
            [
                "include.store.Store.open -> include.store.Store.check",
                "src.api.Api.get -> include.store.Store.check",
                "src.api.Api.get -> include.store.Store.open",
            ]
        );
    }

    #[test]
    fn a_csharp_call_through_an_interface_is_a_caller_of_its_implementation() {
        let g = graph(&[
            (
                "src/IStore.cs",
                "namespace App {\n  public interface IStore {\n    void Open();\n  }\n}\n",
            ),
            (
                "src/Store.cs",
                "namespace App {\n  public class Store : IStore {\n    public void Open() {}\n  }\n}\n",
            ),
            (
                "src/Api.cs",
                "namespace App {\n  public class Api {\n    private readonly IStore _store;\n    public void Get() {\n      _store.Open();\n    }\n  }\n}\n",
            ),
        ]);
        let open = g.resolve_name("Store.Open", "")[0];
        let callers: Vec<(String, String)> = g
            .callers(open, 1, &|_| false)
            .into_iter()
            .map(|r| (g.syms[r.sym].fqn.clone(), g.syms[r.via].fqn.clone()))
            .collect();
        assert_eq!(
            callers,
            [("App.Api.Get".to_string(), "App.IStore.Open".to_string())]
        );
    }

    #[test]
    fn a_rust_module_named_without_a_use_is_the_nearest_of_its_name() {
        let g = graph(&[
            ("app/src/store/mod.rs", "pub fn open() {}\n"),
            ("app/src/context/store/mod.rs", "pub fn open() {}\n"),
            (
                "app/src/context/look.rs",
                "fn refresh() {\n    store::open();\n}\n",
            ),
            ("app/src/main.rs", "fn main() {\n    store::open();\n}\n"),
        ]);
        assert_eq!(
            calls(&g),
            [
                "app.src.context.look.refresh -> app.src.context.store.open",
                "app.src.main.main -> app.src.store.open",
            ]
        );
    }

    #[test]
    fn a_python_import_and_a_go_package_are_found_by_their_path() {
        let g = graph(&[
            ("lib/pkg/util.py", "def helper():\n    pass\n"),
            (
                "app/main.py",
                "from pkg.util import helper\n\ndef run():\n    helper()\n",
            ),
        ]);
        assert_eq!(calls(&g), ["app.main.run -> lib.pkg.util.helper"]);
    }

    #[test]
    fn typescript_follows_a_default_export_and_names_exported_as_others() {
        let g = graph(&[
            (
                "src/button.ts",
                "export default class Button {\n  click() {}\n}\n",
            ),
            // (a namesake elsewhere: the name alone can't say which)
            ("src/other.ts", "export class Button {\n  click() {}\n}\n"),
            (
                "src/util.ts",
                "function open() {}\nfunction shut() {}\nexport { shut as close };\nexport default open;\n",
            ),
            ("src/index.ts", "export { close as stop } from './util';\n"),
            (
                "src/main.ts",
                "import Btn from './button';\nimport run from './util';\nimport { stop } from './index';\nfunction main() {\n  new Btn().click();\n  run();\n  stop();\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.main.main -> src.button.Button (new)",
                "src.main.main -> src.button.Button.click",
                "src.main.main -> src.util.open",
                "src.main.main -> src.util.shut",
            ]
        );
    }

    #[test]
    fn typescript_calls_through_imports_fields_locals_and_namespaces() {
        let g = graph(&[
            (
                "src/store.ts",
                "export class Store {\n  open(id: string) { return load(id); }\n}\nexport function load(id: string) { return id; }\n",
            ),
            (
                "src/api.ts",
                "import { Store } from './store';\nimport * as s from './store';\nexport class Api {\n  constructor(private store: Store) {}\n  get(id: string) {\n    this.store.open(id);\n    s.load(id);\n    const t = new Store();\n    t.open(id);\n  }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.api.Api.get -> src.store.Store (new)",
                "src.api.Api.get -> src.store.Store.open",
                "src.api.Api.get -> src.store.load",
                "src.store.Store.open -> src.store.load",
            ]
        );
        let api = g.file_of("src/api.ts").unwrap();
        assert_eq!(
            g.imports[api]
                .iter()
                .map(|&f| g.files[f].path.as_str())
                .collect::<Vec<_>>(),
            ["src/store.ts"]
        );
    }

    #[test]
    fn rust_calls_through_use_mod_paths_fields_and_typed_locals() {
        let g = graph(&[
            (
                "src/main.rs",
                "mod store;\nuse crate::store::Store;\nfn main() {\n    let s = Store::new();\n    s.open();\n    store::helper();\n}\n",
            ),
            (
                "src/store.rs",
                "pub struct Store {\n    db: Db,\n}\nimpl Store {\n    pub fn new() -> Store {\n        Store { db: Db::new() }\n    }\n    pub fn open(&self) {\n        self.db.query();\n        helper();\n    }\n}\npub fn helper() {}\npub struct Db;\nimpl Db {\n    pub fn new() -> Db { Db }\n    pub fn query(&self) {}\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.main.main -> src.store.Store.new",
                "src.main.main -> src.store.Store.open",
                "src.main.main -> src.store.helper",
                "src.store.Store.new -> src.store.Db.new",
                "src.store.Store.new -> src.store.Store (new)",
                "src.store.Store.open -> src.store.Db.query",
                "src.store.Store.open -> src.store.helper",
            ]
        );
    }

    #[test]
    fn python_calls_through_relative_and_aliased_imports() {
        let g = graph(&[
            (
                "pkg/store.py",
                "class Store:\n    def open(self):\n        return helper()\n\ndef helper():\n    pass\n",
            ),
            (
                "pkg/api.py",
                "from .store import Store\nimport pkg.store as st\n\nclass Api:\n    def __init__(self, s: Store):\n        self.s = s\n\n    def get(self):\n        self.s.open()\n        st.helper()\n        x = Store()\n        x.open()\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "pkg.api.Api.get -> pkg.store.Store (new)",
                "pkg.api.Api.get -> pkg.store.Store.open",
                "pkg.api.Api.get -> pkg.store.helper",
                "pkg.store.Store.open -> pkg.store.helper",
            ]
        );
    }

    #[test]
    fn go_methods_belong_to_their_receivers_type_across_the_package() {
        let g = graph(&[
            (
                "a/s.go",
                "package a\n\ntype S struct {\n\tdb *DB\n}\n\nfunc (s *S) Go() {\n\ts.db.Open()\n\ts.help()\n}\n\nfunc (s *S) help() {}\n",
            ),
            (
                "a/db.go",
                "package a\n\ntype DB struct{}\n\nfunc (d *DB) Open() {}\n\nfunc New() *S { return &S{} }\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "a.db.New -> a.s.S (new)",
                "a.s.S.Go -> a.db.DB.Open",
                "a.s.S.Go -> a.s.S.help"
            ]
        );
    }

    #[test]
    fn csharp_calls_through_fields_without_this_and_its_own_members() {
        let g = graph(&[
            (
                "N/Store.cs",
                "namespace N {\n  public class Store {\n    public void Open() { Load(); }\n    void Load() {}\n  }\n}\n",
            ),
            (
                "N/Api.cs",
                "namespace N {\n  public class Api : Base {\n    private Store _s;\n    public void Get() {\n      _s.Open();\n      var x = new Store();\n      x.Open();\n      Helper();\n    }\n  }\n  public class Base { protected void Helper() {} }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "N.Api.Get -> N.Base.Helper",
                "N.Api.Get -> N.Store (new)",
                "N.Api.Get -> N.Store.Open",
                "N.Store.Open -> N.Store.Load",
            ]
        );
        let api = g.resolve_name("Api", "")[0];
        assert_eq!(
            g.lineage(api, true)
                .iter()
                .map(|(t, _, _)| g.syms[*t].fqn.as_str())
                .collect::<Vec<_>>(),
            ["N.Base"]
        );
    }
}
