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
//!   lookup.rs    finding a type or a member by name, as a file sees it
//!   queries.rs   walking it: callers, call chains, dependencies, hierarchies, impact

mod build;
mod calls;
mod extract;
mod facts;
mod lookup;
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
    /// Names it brought in from outside the folder (`use std::path::Path`): never the folder's.
    outside: HashSet<String>,
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
    partners: HashMap<usize, Vec<usize>>, // (a C# partial type -> its other parts)
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
    fn dart_calls_through_fields_unsaid_this_a_states_widget_and_what_returns() {
        let g = graph(&[
            (
                "lib/data/store.dart",
                "class Store {\n  void open() { check(); }\n  void check() {}\n  static Store named() => Store();\n}\n",
            ),
            (
                "lib/page.dart",
                "import 'data/store.dart';\nimport 'package:flutter/material.dart';\nclass Page extends StatefulWidget {\n  final Store store;\n  const Page({required this.store});\n  @override\n  State<Page> createState() => _PageState();\n}\nclass _PageState extends State<Page> {\n  late final Store cache = Store();\n  void refresh() {\n    widget.store.open();\n    cache.open();\n    final s = Store.named();\n    s.check();\n    helper();\n  }\n  void helper() {}\n  Widget build(BuildContext context) {\n    refresh();\n    return Text('x');\n  }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "lib.data.store.Store.named -> lib.data.store.Store (new)",
                "lib.data.store.Store.open -> lib.data.store.Store.check",
                "lib.page.Page.createState -> lib.page._PageState (new)",
                "lib.page._PageState.build -> lib.page._PageState.refresh",
                "lib.page._PageState.cache -> lib.data.store.Store (new)",
                "lib.page._PageState.refresh -> lib.data.store.Store.check",
                "lib.page._PageState.refresh -> lib.data.store.Store.named",
                "lib.page._PageState.refresh -> lib.data.store.Store.open",
                "lib.page._PageState.refresh -> lib.page._PageState.helper",
            ]
        );
        let page = g.file_of("lib/page.dart").unwrap();
        assert_eq!(g.imports[page].len(), 1);
        assert!(g.externals[page].contains("flutter"));
    }

    #[test]
    fn zig_calls_through_imports_typed_selves_and_what_returns() {
        let g = graph(&[
            (
                "src/store.zig",
                "pub const Store = struct {\n    n: u32,\n    pub fn init() Store {\n        return Store{ .n = 0 };\n    }\n    pub fn open(self: *Store) void {\n        _ = self;\n    }\n};\n",
            ),
            ("src/util.zig", "pub fn trim() void {}\n"),
            (
                "src/main.zig",
                "const std = @import(\"std\");\nconst Store = @import(\"store.zig\").Store;\nconst util = @import(\"util.zig\");\nconst Order = struct {\n    store: *Store,\n    fn total(self: *Order) void {\n        self.store.open();\n        util.trim();\n    }\n};\nfn run() !void {\n    var s = Store.init();\n    s.open();\n    var o = try make();\n    o.total();\n    std.debug.print(\"x\", .{});\n}\nfn make() !Order {\n    return undefined;\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.main.Order.total -> src.store.Store.open",
                "src.main.Order.total -> src.util.trim",
                "src.main.run -> src.main.Order.total",
                "src.main.run -> src.main.make",
                "src.main.run -> src.store.Store.init",
                "src.main.run -> src.store.Store.open",
                "src.store.Store.init -> src.store.Store (new)",
            ]
        );
        let main = g.file_of("src/main.zig").unwrap();
        assert_eq!(g.imports[main].len(), 2);
        assert!(g.externals[main].contains("std"));
    }
    #[test]
    fn php_calls_through_namespaces_this_typed_parameters_and_scopes() {
        let g = graph(&[
            (
                "src/Models/Store.php",
                "<?php\nnamespace App\\Models;\nclass Store {\n    public function open(): void { $this->check(); }\n    public function check(): void {}\n    public static function make(): Store { return new Store(); }\n}\n",
            ),
            (
                "src/Http/Base.php",
                "<?php\nnamespace App\\Http;\nclass Base {\n    public function boot(): void {}\n}\n",
            ),
            (
                "src/Http/Mailer.php",
                "<?php\nnamespace App\\Http;\nclass Mailer {\n    public function send(): void {}\n}\n",
            ),
            ("src/Http/helpers.php", "<?php\nfunction helper() {}\n"),
            (
                "src/Http/Api.php",
                "<?php\nnamespace App\\Http;\nuse App\\Models\\Store;\nrequire_once __DIR__ . '/helpers.php';\nclass Api extends Base {\n    private Store $store;\n    public function __construct(private Mailer $mailer) {}\n    public function get(Store $s): void {\n        $this->store->open();\n        $s->check();\n        Store::make();\n        $o = new Store();\n        $o->open();\n        $this->mailer->send();\n        self::ping();\n        parent::boot();\n        helper();\n    }\n    public static function ping(): void {}\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "Api.get -> Api.ping",
                "Api.get -> Base.boot",
                "Api.get -> Mailer.send",
                "Api.get -> Store (new)",
                "Api.get -> Store.check",
                "Api.get -> Store.make",
                "Api.get -> Store.open",
                "Api.get -> helper",
                "Store.make -> Store (new)",
                "Store.open -> Store.check",
            ]
        );
    }

    #[test]
    fn ruby_calls_through_unsaid_self_instance_variables_mixins_and_super() {
        let g = graph(&[
            (
                "app/models/store.rb",
                "class Store\n  def open\n    check\n  end\n  def check; end\n  def self.make\n    Store.new\n  end\nend\n",
            ),
            (
                "app/services/api.rb",
                "require_relative '../models/store'\nmodule Logs\n  def log; end\nend\nclass Base\n  def get(id); end\nend\nclass Api < Base\n  include Logs\n  def initialize\n    @store = Store.new\n  end\n  def get(id)\n    @store.open\n    Store.make\n    local = Store.new\n    local.check\n    helper\n    log\n    super\n  end\n  def helper; end\nend\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "app.models.store.Store.make -> app.models.store.Store (new)",
                "app.models.store.Store.open -> app.models.store.Store.check",
                "app.services.api.Api.get -> app.models.store.Store (new)",
                "app.services.api.Api.get -> app.models.store.Store.check",
                "app.services.api.Api.get -> app.models.store.Store.make",
                "app.services.api.Api.get -> app.models.store.Store.open",
                "app.services.api.Api.get -> app.services.api.Api.helper",
                "app.services.api.Api.get -> app.services.api.Base.get",
                "app.services.api.Api.get -> app.services.api.Logs.log",
                "app.services.api.Api.initialize -> app.models.store.Store (new)",
            ]
        );
        let api = g.file_of("app/services/api.rb").unwrap();
        assert_eq!(g.imports[api].len(), 1);
    }

    #[test]
    fn a_shell_script_calls_the_functions_it_defines_and_sources() {
        let g = graph(&[
            ("scripts/lib.sh", "log_info() {\n  echo \"$1\"\n}\n"),
            (
                "scripts/deploy.sh",
                "source ./lib.sh\nbuild() {\n  make all\n}\ndeploy() {\n  build\n  log_info done\n  ./other.sh\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "scripts.deploy.deploy -> scripts.deploy.build",
                "scripts.deploy.deploy -> scripts.lib.log_info",
            ]
        );
    }

    #[test]
    fn powershell_calls_commands_methods_and_static_members() {
        let g = graph(&[
            (
                "tools/Store.psm1",
                "class Store {\n  [void] Open() { $this.Check() }\n  [void] Check() {}\n  static [Store] Make() { return [Store]::new() }\n}\nfunction Get-Thing { }\n",
            ),
            (
                "tools/deploy.ps1",
                "Import-Module ./Store.psm1\nfunction Invoke-Deploy {\n  param([Store]$s)\n  Get-Thing -Name x\n  $s.Open()\n  $o = [Store]::new()\n  [Store]::Make()\n  $o.Check()\n}\nclass Api {\n  [Store]$Store\n  [void] Run() { $this.Store.Open() }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "tools.Store.Store.Make -> tools.Store.Store (new)",
                "tools.Store.Store.Open -> tools.Store.Store.Check",
                "tools.deploy.Api.Run -> tools.Store.Store.Open",
                "tools.deploy.Invoke-Deploy -> tools.Store.Get-Thing",
                "tools.deploy.Invoke-Deploy -> tools.Store.Store (new)",
                "tools.deploy.Invoke-Deploy -> tools.Store.Store.Check",
                "tools.deploy.Invoke-Deploy -> tools.Store.Store.Make",
                "tools.deploy.Invoke-Deploy -> tools.Store.Store.Open",
            ]
        );
    }
    #[test]
    fn go_keeps_a_types_package_and_follows_what_calls_return() {
        let dir = std::env::temp_dir().join(format!("cbot-go-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("go.mod"), "module example.com/app\n").unwrap();
        let mut code = Code::default();
        let files = [
            (
                "pkg/store/store.go",
                "package store\ntype Store struct{}\nfunc New() (*Store, error) { return &Store{}, nil }\nfunc (s *Store) Open() *Tx { return nil }\ntype Tx struct{}\nfunc (t *Tx) Commit() {}\n",
            ),
            (
                "cmd/main.go",
                "package main\nimport (\n\t\"testing\"\n\t\"example.com/app/pkg/store\"\n)\ntype T struct{}\nfunc (T) Errorf() {}\nfunc run(t *testing.T) {\n\ts, err := store.New()\n\t_ = err\n\ttx := s.Open()\n\ttx.Commit()\n\tt.Errorf()\n\tvar f *store.Store\n\tf.Open()\n\tx := store.Store{}\n\tx.Open()\n}\n",
            ),
        ];
        for (path, src) in files {
            let ty = FileType::of(path).unwrap();
            code.put(path, ty, parse::read(Lang::Go, src).unwrap());
        }
        let g = Graph::build(&code, &dir);
        let _ = std::fs::remove_dir_all(&dir);
        // (and none to main's own T: t is a testing.T)
        assert_eq!(
            calls(&g),
            [
                "cmd.main.run -> pkg.store.store.New",
                "cmd.main.run -> pkg.store.store.Store (new)",
                "cmd.main.run -> pkg.store.store.Store.Open",
                "cmd.main.run -> pkg.store.store.Tx.Commit",
                "pkg.store.store.New -> pkg.store.store.Store (new)",
            ]
        );
    }

    #[test]
    fn csharp_partial_types_are_one_and_calls_follow_what_methods_return() {
        let g = graph(&[
            (
                "Shop/Page.cs",
                "namespace Shop;\npublic partial class Page\n{\n    public void Load()\n    {\n        Refresh();\n        var s = Repo().Find();\n        s.Open();\n        Ioc.Resolve<IAuth>().Check();\n    }\n    public Repo Repo() { return new Repo(); }\n}\n",
            ),
            (
                "Shop/Page.Refresh.cs",
                "namespace Shop;\npublic partial class Page\n{\n    void Refresh() { }\n}\npublic class Repo { public Store Find() { return null; } }\npublic class Store { public void Open() { } }\npublic interface IAuth { void Check(); }\npublic static class Ioc { public static T Resolve<T>() { return default; } }\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "Page.Load -> IAuth.Check",
                "Page.Load -> Ioc.Resolve",
                "Page.Load -> Page.Refresh",
                "Page.Load -> Page.Repo",
                "Page.Load -> Repo.Find",
                "Page.Load -> Store.Open",
                "Page.Repo -> Repo (new)",
            ]
        );
    }

    #[test]
    fn a_rust_method_given_to_a_type_from_outside_is_found_through_what_holds_it() {
        let g = graph(&[
            (
                "src/state.rs",
                "pub trait Locked<T> { fn locked(&self) -> T; }\nimpl<T> Locked<T> for std::sync::Mutex<T> {\n    fn locked(&self) -> T { todo!() }\n}\n",
            ),
            (
                "src/folder.rs",
                "use crate::state::Locked;\nuse std::sync::Mutex;\npub struct Code;\npub struct Folder {\n    code: Mutex<Code>,\n    at: Mutex<Option<i64>>,\n}\nimpl Folder {\n    fn go(&self) {\n        self.code.locked();\n        self.at.locked();\n    }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            ["src.folder.Folder.go -> src.state.Mutex.locked"]
        );
    }

    #[test]
    fn a_python_folder_without_an_init_is_a_package_of_its_modules() {
        let g = graph(&[
            ("pkg/sub/mod_a.py", "def helper():\n    pass\n"),
            (
                "app.py",
                "import pkg.sub\nfrom pkg.sub import mod_a\ndef run():\n    mod_a.helper()\n",
            ),
        ]);
        assert_eq!(calls(&g), ["app.run -> pkg.sub.mod_a.helper"]);
        let app = g.file_of("app.py").unwrap();
        assert!(g.externals[app].is_empty());
        assert_eq!(g.imports[app].len(), 1);
    }
    #[test]
    fn a_rust_closure_is_given_what_the_functions_signature_says() {
        let g = graph(&[
            (
                "src/state.rs",
                "pub struct App;\npub struct Store;\nimpl Store {\n    pub fn list(&self) {}\n}\npub struct State {\n    pub store: Store,\n}\npub fn with<R>(app: &App, f: impl FnOnce(&mut State) -> R) -> R {\n    todo!()\n}\npub fn each<F: FnMut(&Store)>(f: F) {}\n",
            ),
            (
                "src/details.rs",
                "use crate::state::{each, with, App};\nfn repos(app: &App) {\n    with(app, |st| {\n        st.store.list();\n    });\n    each(|s| s.list());\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.details.repos -> src.state.Store.list",
                "src.details.repos -> src.state.each",
                "src.details.repos -> src.state.with",
            ]
        );
    }

    #[test]
    fn a_rust_module_re_exported_through_an_alias_is_followed_to_its_file() {
        let g = graph(&[
            (
                "src/platform/mod.rs",
                "mod windows;\nuse windows as os;\npub use os::{window};\n",
            ),
            ("src/platform/windows/mod.rs", "pub mod window;\n"),
            ("src/platform/windows/window.rs", "pub fn set_bounds() {}\n"),
            (
                "src/notes.rs",
                "use crate::platform::window;\nfn place() {\n    window::set_bounds();\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            ["src.notes.place -> src.platform.windows.window.set_bounds"]
        );
    }

    #[test]
    fn csharp_follows_base_statics_aliases_and_an_interfaces_one_implementation() {
        let g = graph(&[
            (
                "Core/Base.cs",
                "namespace Core;\npublic class BaseViewModel\n{\n    public virtual void OnActive() { }\n    protected INavigationService NavigationService { get; }\n}\npublic interface INavigationService : IMvxNavigationService { }\npublic class NavigationService : MvxNavigationService, INavigationService\n{\n    public override Task Navigate<T>() { return null; }\n}\npublic class MasterViewModel\n{\n    public static MasterViewModel Instance { get; }\n    public void ShowMessage(string m) { }\n}\npublic class Result<T>\n{\n    public static Result<T> Failure(string code) { return null; }\n}\n",
            ),
            (
                "Data/OrderHelper.cs",
                "namespace Data.Helpers;\npublic static class OrderHelper\n{\n    public static void GetCreator() { }\n}\n",
            ),
            (
                "Web/OrderHelper.cs",
                "namespace Web.Helper;\npublic static class OrderHelper\n{\n    public static void Other() { }\n}\n",
            ),
            (
                "Core/AboutViewModel.cs",
                "using Core;\nusing OrderHelper = Data.Helpers.OrderHelper;\nnamespace Core;\npublic class AboutViewModel : BaseViewModel\n{\n    public override void OnActive()\n    {\n        base.OnActive();\n        MasterViewModel.Instance.ShowMessage(\"x\");\n        NavigationService.Navigate<AboutViewModel>();\n        Result<int>.Failure(\"e\");\n        OrderHelper.GetCreator();\n    }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "AboutViewModel.OnActive -> BaseViewModel.OnActive",
                "AboutViewModel.OnActive -> MasterViewModel.ShowMessage",
                "AboutViewModel.OnActive -> NavigationService.Navigate",
                "AboutViewModel.OnActive -> OrderHelper.GetCreator",
                "AboutViewModel.OnActive -> Result.Failure",
            ]
        );
    }
    #[test]
    fn typescript_knows_a_value_after_instanceof() {
        let g = graph(&[
            (
                "src/errors.ts",
                "export class ServiceError extends Error {\n  errorPayload() { return {}; }\n}\nexport class NotFound extends ServiceError {}\n",
            ),
            (
                "src/guard.ts",
                "import { NotFound } from './errors';\nexport function canActivate() {\n  try {\n    run();\n  } catch (error) {\n    if (error instanceof NotFound && error.message) {\n      throw new Error(error.errorPayload());\n    }\n  }\n}\nfunction run() {}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.guard.canActivate -> src.errors.ServiceError.errorPayload",
                "src.guard.canActivate -> src.guard.run",
            ]
        );
    }

    #[test]
    fn a_typescript_parameter_of_any_type_is_no_function_of_its_name() {
        let g = graph(&[(
            "src/mail.ts",
            "export function send() {}\nexport function walk() {}\nexport function later(f: (g: () => void) => void) {}\nexport function retry(send: () => Promise<void>, walk) {\n  send();\n  walk();\n}\nexport function each() {\n  later(walk => walk());\n  send();\n}\n",
        )]);
        assert_eq!(
            calls(&g),
            [
                "src.mail.each -> src.mail.later",
                "src.mail.each -> src.mail.send"
            ]
        );
    }

    #[test]
    fn a_bare_call_reaches_the_function_of_its_name_in_its_scope() {
        let g = graph(&[(
            "src/run.spec.ts",
            "describe('a', () => {\n  const row = () => 1;\n  function check() { row(); }\n});\ndescribe('b', () => {\n  const row = () => 2;\n  function check() { row(); }\n});\nfunction outer() {\n  function walk() {}\n  walk();\n}\nfunction other() { walk(); }\nfunction pad(a: string): string;\nfunction pad(a: number): string;\nfunction pad(a: any): string { return ''; }\nfunction use() { pad(1); }\n",
        )]);
        assert_eq!(
            calls_at(&g),
            [
                "src.run.spec.check -> src.run.spec.row:2",
                "src.run.spec.check -> src.run.spec.row:6",
                "src.run.spec.outer -> src.run.spec.outer.walk:10",
                "src.run.spec.use -> src.run.spec.pad:14",
            ]
        );
    }

    #[test]
    fn rust_locals_and_what_comes_from_outside_are_never_the_folders_functions() {
        let g = graph(&[
            (
                "src/robots/planes.rs",
                "struct Path;\nimpl Path {\n    fn new() -> Path { Path }\n}\n",
            ),
            (
                "src/other.rs",
                "pub fn field() {}\npub fn say() {}\npub fn t() {}\n",
            ),
            (
                "src/locate.rs",
                "use std::path::Path;\nfn locate(say: &dyn Fn(&str)) {\n    let field = |f: &str| f.len();\n    field(\"name\");\n    say(\"hi\");\n    let t = crate::util::text;\n    t(1);\n    Path::new(\"x\");\n}\n",
            ),
        ]);
        assert!(calls(&g).is_empty(), "{:?}", calls(&g));
    }

    #[test]
    fn rust_follows_a_parents_uses_statics_module_paths_and_impls_for_outside_types() {
        let g = graph(&[
            ("src/util.rs", "pub fn text() {}\npub fn bare() {}\n"),
            (
                "src/state.rs",
                "pub trait Locked<T> { fn locked(&self) -> T; }\nimpl<T> Locked<T> for std::sync::Mutex<T> {\n    fn locked(&self) -> T { todo!() }\n}\npub trait Fields { fn folder(&self) -> &str; }\nimpl Fields for serde_json::Value {\n    fn folder(&self) -> &str { \"\" }\n}\n",
            ),
            (
                "src/group/mod.rs",
                "mod commands;\nuse crate::util::text;\nfn helper() {}\n",
            ),
            (
                "src/group/commands.rs",
                "use super::*;\nuse std::sync::Mutex;\nuse serde_json::Value;\nstatic CACHED: Mutex<Option<u8>> = Mutex::new(None);\nfn act(c: &Value) {\n    text();\n    super::helper();\n    CACHED.locked();\n    c.folder();\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.group.commands.act -> src.group.helper",
                "src.group.commands.act -> src.state.Mutex.locked",
                "src.group.commands.act -> src.state.Value.folder",
                "src.group.commands.act -> src.util.text",
            ]
        );
    }
    #[test]
    fn python_follows_what_functions_and_methods_return() {
        let g = graph(&[
            (
                "src/store.py",
                "from typing import Optional\nclass Store:\n    def close(self) -> None:\n        pass\n    def child(self) -> \"Store\":\n        return self\nclass Repo:\n    def find(self) -> Optional[Store]:\n        return None\ndef build_store(settings) -> Store:\n    return Store()\n",
            ),
            (
                "src/app.py",
                "from src.store import build_store, Repo\ndef run(settings, repo: Repo):\n    store = build_store(settings)\n    store.close()\n    found = repo.find()\n    found.child().close()\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.app.run -> src.store.Repo.find",
                "src.app.run -> src.store.Store.child",
                "src.app.run -> src.store.Store.close",
                "src.app.run -> src.store.build_store",
                "src.store.build_store -> src.store.Store (new)",
            ]
        );
    }
    #[test]
    fn go_follows_assertions_ranges_iterators_generics_dot_imports_and_new() {
        let dir = std::env::temp_dir().join(format!("cbot-go2-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("go.mod"), "module example.com/app\n").unwrap();
        let mut code = Code::default();
        let files = [
            (
                "inspector/inspector.go",
                "package inspector\nimport \"iter\"\ntype Inspector struct{}\ntype Cursor struct{}\nfunc (i *Inspector) Root() Cursor { return Cursor{} }\nfunc (c Cursor) Preorder() iter.Seq[Cursor] { return nil }\nfunc (c Cursor) Node() int { return 0 }\nfunc Check() {}\n",
            ),
            ("inspector/other.go", "package inspector\nfunc copy() {}\n"),
            (
                "pass/pass.go",
                "package pass\nimport (\n\t. \"example.com/app/inspector\"\n)\ntype Sparse struct{}\nfunc (s *Sparse) Len() int { return 0 }\nfunc info[T any](name string) int { return 0 }\nvar fields = []int{info[*Sparse](\"x\")}\nfunc run(p any, all []*Sparse) {\n\tvar (\n\t\tins = p.(*Inspector)\n\t)\n\tfor c := range ins.Root().Preorder() {\n\t\tc.Node()\n\t}\n\tfor _, s := range all {\n\t\ts.Len()\n\t}\n\tn := new(Sparse)\n\tn.Len()\n\tCheck()\n\tcopy(nil, nil)\n}\n",
            ),
        ];
        for (path, src) in files {
            let ty = FileType::of(path).unwrap();
            code.put(path, ty, parse::read(Lang::Go, src).unwrap());
        }
        let g = Graph::build(&code, &dir);
        let _ = std::fs::remove_dir_all(&dir);
        // (and none to inspector's copy: a name said alone is the builtin, not another package's)
        assert_eq!(
            calls(&g),
            [
                "inspector.inspector.Inspector.Root -> inspector.inspector.Cursor (new)",
                "pass.pass.fields -> pass.pass.info",
                "pass.pass.run -> inspector.inspector.Check",
                "pass.pass.run -> inspector.inspector.Cursor.Node",
                "pass.pass.run -> inspector.inspector.Cursor.Preorder",
                "pass.pass.run -> inspector.inspector.Inspector.Root",
                "pass.pass.run -> pass.pass.Sparse.Len",
            ]
        );
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
    fn rust_calls_through_destructured_fields_what_functions_return_and_macros() {
        let g = graph(&[
            (
                "src/session.rs",
                "pub struct Session;\nimpl Session {\n    pub fn new() -> Self { Session }\n    pub fn ask(&self) -> bool { true }\n}\n",
            ),
            (
                "src/chat.rs",
                "use crate::session::Session;\npub struct Chat {\n    pub session: Arc<Session>,\n}\nstruct Ev<'a> {\n    session: &'a Arc<Session>,\n}\npub fn chat_for() -> Option<Arc<Chat>> { None }\nfn start() -> Result<Arc<Chat>, Error> { todo() }\nfn on_fail(e: Ev) {\n    let Ev { session, .. } = e;\n    session.ask();\n}\nfn page() {\n    let Some(chat) = chat_for() else { return };\n    chat.session.ask();\n}\nfn side(c: Option<Arc<Chat>>) {\n    let chat = match c {\n        Some(chat) => chat,\n        None => start()?,\n    };\n    chat.session.ask();\n}\nfn live() {\n    let s = Session::new();\n    assert!(!s.ask());\n    if let Some(chat) = chat_for() {\n        log(format!(\"{}\", chat.session.ask()));\n    }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.chat.live -> src.chat.chat_for",
                "src.chat.live -> src.session.Session.ask",
                "src.chat.live -> src.session.Session.new",
                "src.chat.on_fail -> src.session.Session.ask",
                "src.chat.page -> src.chat.chat_for",
                "src.chat.page -> src.session.Session.ask",
                "src.chat.side -> src.chat.start",
                "src.chat.side -> src.session.Session.ask",
            ]
        );
    }

    #[test]
    fn rust_calls_through_what_enum_variants_and_collections_hold() {
        let g = graph(&[
            (
                "src/session.rs",
                "pub struct Session;\nimpl Session {\n    pub fn ask(&self) {}\n}\n",
            ),
            (
                "src/fx.rs",
                "use crate::session::Session;\npub enum Fx {\n    Ask(Arc<Session>, String),\n    Note { session: Arc<Session> },\n}\nfn run_ask(f: Fx) {\n    match f {\n        Fx::Ask(s, prompt) => s.ask(),\n        _ => {}\n    }\n}\nfn run_note(f: Fx) {\n    if let Fx::Note { session } = f {\n        session.ask();\n    }\n}\nfn each_closure(list: Vec<Arc<Session>>) {\n    list.iter().filter(|s| true).for_each(|s| s.ask());\n}\nfn each_loop(list: &[Session]) {\n    for s in list.iter() {\n        s.ask();\n    }\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.fx.each_closure -> src.session.Session.ask",
                "src.fx.each_loop -> src.session.Session.ask",
                "src.fx.run_ask -> src.fx.Fx (new)",
                "src.fx.run_ask -> src.session.Session.ask",
                "src.fx.run_note -> src.fx.Fx (new)",
                "src.fx.run_note -> src.session.Session.ask",
            ]
        );
    }

    #[test]
    fn a_tauri_invoke_is_a_call_of_the_rust_command_of_its_name() {
        let g = graph(&[
            (
                "gui/ipc/commands.ts",
                "import { invoke } from '@tauri-apps/api/core';\nexport const robotAsk = (tabId: string) => invoke<string>('robot_ask', { tabId });\nexport const robotGone = () => invoke('no_such_command');\n",
            ),
            (
                "app/src/robots/ipc.rs",
                "#[tauri::command]\npub fn robot_ask(tab_id: String) -> String {\n    tab_id\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            ["gui.ipc.commands.robotAsk -> app.src.robots.ipc.robot_ask"]
        );
    }

    #[test]
    fn a_rust_enum_variant_is_a_use_of_its_enum_not_a_type_of_its_name() {
        let g = graph(&[(
            "src/a.rs",
            "pub struct Done { pub text: String }\npub enum AgentEvent { Done { id: u32 }, Start }\npub enum Event { Usage(u64) }\nfn make() -> AgentEvent { AgentEvent::Done { id: 1 } }\nfn tell() { send(Event::Usage(3)); }\nfn pick(e: AgentEvent) -> bool { e == AgentEvent::Start }\nfn real() -> Done { Done { text: String::new() } }\n",
        )]);
        assert_eq!(
            calls(&g),
            [
                "src.a.make -> src.a.AgentEvent (new)",
                "src.a.pick -> src.a.AgentEvent (new)",
                "src.a.real -> src.a.Done (new)",
                "src.a.tell -> src.a.Event (new)",
            ]
        );
    }

    #[test]
    fn a_trait_implemented_for_an_outside_type_has_that_impl_below_it() {
        let g = graph(&[(
            "src/fields.rs",
            "pub trait Fields {\n    fn id(&self) -> &str;\n}\nimpl Fields for Value {\n    fn id(&self) -> &str { \"\" }\n}\n",
        )]);
        let fields = g.resolve_name("Fields", "").first().copied().unwrap();
        let below: Vec<String> = g
            .lineage(fields, false)
            .iter()
            .map(|&(s, _, _)| format!("{} {}", g.syms[s].kind.word(), g.syms[s].name))
            .collect();
        assert_eq!(below, ["impl Value"]);
    }

    #[test]
    fn typescript_calls_through_a_hub_reach_the_function_its_api_returns() {
        let g = graph(&[
            (
                "src/commentary.ts",
                "export function createCommentary(r: CommentaryNeeds) {\n  function deniedNote(d: string[]) { return d; }\n  return { deniedNote };\n}\nexport type CommentaryApi = ReturnType<typeof createCommentary>;\nexport type CommentaryNeeds = { readonly n: number };\n",
            ),
            (
                "src/log.ts",
                "import type { CommentaryApi } from './commentary';\nexport type ChatLogNeeds = {\n  readonly deniedNote: CommentaryApi['deniedNote'];\n};\nexport function createChatLog(r: ChatLogNeeds) {\n  function addBot() {\n    r.deniedNote([]);\n  }\n  return { addBot };\n}\n",
            ),
            (
                "src/events.ts",
                "import type { CommentaryApi } from './commentary';\nexport type EventsNeeds = Pick<CommentaryApi, 'deniedNote' | 'other'> & { readonly n: number };\nexport function createEvents(r: EventsNeeds) {\n  function onDone() {\n    r.deniedNote([]);\n  }\n  return { onDone };\n}\n",
            ),
        ]);
        assert_eq!(
            calls(&g),
            [
                "src.events.createEvents.onDone -> src.commentary.createCommentary.deniedNote",
                "src.log.createChatLog.addBot -> src.commentary.createCommentary.deniedNote",
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
