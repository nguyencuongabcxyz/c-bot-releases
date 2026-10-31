//! Reading one file through its syntax tree: what it defines (each with its signature, what
//! holds it and its lines) and the names it uses; and, for find_references, the lines where it
//! uses one name.

use super::*;

/// A definition in a file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Def {
    pub name: String,
    pub kind: Kind,
    pub container: Option<String>, // (what holds it: its class, impl, module…)
    pub line: u32,                 // (its first line, from 1…)
    pub end: u32,                  // (…and its last)
    pub depth: u8,                 // (inside how many other definitions)
    pub sig: String,               // (how it starts, up to its body, on one line)
}

/// What one file says (the store keeps it as JSON, one row per file).
#[derive(Default, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Facts {
    pub defs: Vec<Def>,
    /// Every name it uses (not where it defines it), with how often; by name.
    pub names: Vec<(String, u32)>,
    /// How it hangs together with the rest (graph/): imports, calls, heritage, typed fields.
    #[serde(default, flatten)]
    pub links: graph::Links,
    /// The lines that use the name asked for (read_for), in order.
    #[serde(skip)]
    pub uses: Vec<u32>,
}

const SIG_MAX: usize = 200;

/// Parents a definition's signature starts from when they start on its line (`export`,
/// `const`, Go's `type`).
const WRAPPERS: &[&str] = &[
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "ambient_declaration",
    "type_declaration",
    "expression_statement",
    "template_declaration",
];

thread_local! {
    // (a parser per language on each thread: making one each time costs more than parsing a small file)
    static PARSERS: RefCell<HashMap<Lang, Parser>> = RefCell::new(HashMap::new());
}

fn tree(lang: Lang, src: &str) -> Option<Tree> {
    PARSERS.with(|parsers| {
        let mut parsers = parsers.borrow_mut();
        let parser = match parsers.entry(lang) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let mut parser = Parser::new();
                parser.set_language(&lang.grammar()).ok()?;
                e.insert(parser)
            }
        };
        parser.parse(src, None)
    })
}

/// What a file of this language says.
pub(super) fn read(lang: Lang, src: &str) -> Option<Facts> {
    read_for(lang, src, None)
}

/// The same, noting the lines that use `target` too.
pub(super) fn read_for(lang: Lang, src: &str, target: Option<&str>) -> Option<Facts> {
    let tree = tree(lang, src)?;
    let mut r = Reader {
        lang,
        src,
        target,
        facts: Facts::default(),
        holders: vec![],
        named: HashSet::new(),
        counts: HashMap::new(),
    };
    walk(&tree, |node, entering| {
        if entering {
            r.enter(node);
        } else {
            r.leave(node);
        }
    });
    let mut names: Vec<(String, u32)> = r
        .counts
        .into_iter()
        .map(|(n, c)| (n.to_string(), c))
        .collect();
    names.sort_unstable();
    r.facts.names = names;
    r.facts.uses.dedup();
    r.facts.links = graph::links(lang, &tree, src, &r.facts.defs);
    Some(r.facts)
}

/// Every node in order: once going in (true), once coming out (false).
pub(super) fn walk<'t>(tree: &'t Tree, mut visit: impl FnMut(Node<'t>, bool)) {
    let mut c = tree.walk();
    loop {
        visit(c.node(), true);
        if c.goto_first_child() {
            continue;
        }
        loop {
            visit(c.node(), false);
            if c.goto_next_sibling() {
                break;
            }
            if !c.goto_parent() {
                return;
            }
        }
    }
}

struct Reader<'a> {
    lang: Lang,
    src: &'a str,
    target: Option<&'a str>,
    facts: Facts,
    holders: Vec<(usize, String, Kind)>, // (the definitions we're inside: node id, name, kind)
    named: HashSet<usize>,               // (where defined names start: not uses)
    counts: HashMap<&'a str, u32>,
}

impl<'a> Reader<'a> {
    fn text(&self, node: Node) -> &'a str {
        self.src.get(node.byte_range()).unwrap_or("")
    }

    fn enter(&mut self, node: Node) {
        if let Some((kind, name_node)) = self.definition(node)
            && (kind != Kind::Property || self.in_a_type())
        {
            let name = clean_name(self.text(name_node));
            if !name.is_empty() {
                self.define(node, kind, name_node, name);
                return;
            }
        }
        if node.child_count() == 0
            && self.lang.is_name(node.kind())
            && !self.named.contains(&node.start_byte())
        {
            let name = self.text(node);
            *self.counts.entry(name).or_default() += 1;
            if self.target == Some(name) {
                self.facts.uses.push(row(node.start_position()));
            }
        }
    }

    fn define(&mut self, node: Node, kind: Kind, name_node: Node, name: String) {
        // (an impl names its type: that's a use of it, not a definition)
        if kind != Kind::Impl {
            self.named.insert(name_node.start_byte());
        }
        let holder = self.holders.last();
        let kind = match holder {
            Some((_, _, k)) if kind == Kind::Function && k.holds_methods() => Kind::Method,
            _ => kind,
        };
        // (a node that takes its line's end with it, as a #define does, ends on that line)
        let (line, end) = (row(node.start_position()), node.end_position());
        let end = if end.column == 0 && row(end) > line {
            row(end) - 1
        } else {
            row(end)
        };
        self.facts.defs.push(Def {
            name: name.clone(),
            kind,
            container: holder.map(|(_, n, _)| n.clone()),
            line,
            end,
            depth: u8::try_from(self.holders.len()).unwrap_or(u8::MAX),
            sig: self.signature(node),
        });
        self.holders.push((node.id(), name, kind));
    }

    /// Directly inside a class, interface, struct or type: where a property is a member (not in
    /// a parameter's type or an object literal).
    fn in_a_type(&self) -> bool {
        self.holders
            .last()
            .is_some_and(|(_, _, k)| k.holds_methods() || *k == Kind::Type)
    }

    fn leave(&mut self, node: Node) {
        if self
            .holders
            .last()
            .is_some_and(|(id, _, _)| *id == node.id())
        {
            self.holders.pop();
        }
    }

    /// What a node defines and the node naming it, if it's a definition.
    fn definition<'t>(&self, node: Node<'t>) -> Option<(Kind, Node<'t>)> {
        let kind = self.lang.def(node.kind())?;
        let field = |f: &str| node.child_by_field_name(f);
        match (self.lang, node.kind()) {
            (Lang::Rust, "impl_item") => Some((kind, field("type")?)),
            (Lang::Go, "type_spec") => {
                let kind = match field("type")?.kind() {
                    "struct_type" => Kind::Struct,
                    "interface_type" => Kind::Interface,
                    _ => Kind::Type,
                };
                Some((kind, field("name")?))
            }
            (Lang::Go, "const_spec" | "var_spec") => {
                top_level(node, "source_file").then_some((kind, field("name")?))
            }
            (Lang::Python, "assignment") => {
                let left = field("left").filter(|l| l.kind() == "identifier")?;
                let statement = node
                    .parent()
                    .filter(|p| p.kind() == "expression_statement")?;
                (statement.parent()?.kind() == "module").then_some((kind, left))
            }
            (Lang::TypeScript | Lang::Tsx, "variable_declarator") => ts_variable(node),
            (Lang::Java, "field_declaration" | "constant_declaration") => {
                Some((kind, field("declarator")?.child_by_field_name("name")?))
            }
            (Lang::Java, "package_declaration") => Some((kind, node.named_child(0)?)),
            (Lang::Cpp, _) => cpp_definition(node, kind),
            _ => Some((kind, field("name")?)),
        }
    }

    /// How a definition starts, up to its body (or its first line), on one line.
    fn signature(&self, node: Node) -> String {
        let mut start = node;
        while let Some(p) = start.parent()
            && WRAPPERS.contains(&p.kind())
            && p.start_position().row == node.start_position().row
        {
            start = p;
        }
        let from = start.start_byte();
        let body = node.child_by_field_name("body").or_else(|| {
            node.child_by_field_name("value")
                .and_then(|v| v.child_by_field_name("body"))
        });
        let to = match body {
            Some(b) if b.start_byte() > from => b.start_byte(),
            _ => self.src[from..]
                .find('\n')
                .map_or(start.end_byte(), |n| from + n)
                .min(start.end_byte()),
        };
        let text = self.src.get(from..to).unwrap_or("");
        let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let trimmed = one_line.trim_end_matches(['{', '(', ' ']);
        cut(trimmed, SIG_MAX)
    }
}

fn row(p: tree_sitter::Point) -> u32 {
    u32::try_from(p.row + 1).unwrap_or(u32::MAX)
}

/// A TypeScript/JavaScript variable that's a definition: one holding a function, anywhere, or
/// any at the top of the file.
fn ts_variable(node: Node<'_>) -> Option<(Kind, Node<'_>)> {
    let name = node
        .child_by_field_name("name")
        .filter(|n| n.kind() == "identifier")?;
    let value = node.child_by_field_name("value").map(|v| v.kind());
    if matches!(
        value,
        Some("arrow_function" | "function_expression" | "function" | "generator_function")
    ) {
        return Some((Kind::Function, name));
    }
    top_level(node, "program").then_some((Kind::Const, name))
}

/// What a C++ node defines, and its name: a function (one defined outside its class,
/// `Store::open`, is a method), a member function declared in a class, a field, a type with a
/// body (not a declaration of one ahead, `class Store;`), a namespace, an alias, a macro.
fn cpp_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let field = |f: &str| node.child_by_field_name(f);
    match node.kind() {
        "function_definition" => {
            let name = declared(field("declarator")?)?;
            let kind = if name.kind() == "qualified_identifier" {
                Kind::Method
            } else {
                kind
            };
            Some((kind, unqualified(name)))
        }
        "field_declaration" => {
            let declarator = field("declarator")?;
            let function = function_of(declarator).is_some();
            let name = unqualified(declared(declarator)?);
            Some((if function { Kind::Method } else { kind }, name))
        }
        // (a function declared: a constructor or destructor in its class, `Store();`, or a
        // free function in a header, `void run();`, defined in a .cpp: the graph makes the two
        // one. In a function's body a declaration is a local's.)
        "declaration" => {
            let declarator = field("declarator").filter(|d| function_of(*d).is_some())?;
            let kind = match node.parent()?.kind() {
                "field_declaration_list" => kind,
                "translation_unit" | "declaration_list" | "linkage_specification" => Kind::Function,
                _ => return None,
            };
            Some((kind, unqualified(declared(declarator)?)))
        }
        "class_specifier" | "struct_specifier" | "union_specifier" | "enum_specifier" => {
            field("body")?;
            Some((kind, unqualified(field("name")?)))
        }
        "type_definition" => Some((kind, declared(field("declarator")?)?)),
        _ => Some((kind, field("name")?)),
    }
}

/// The function declarator in a C++ declarator (through `*`, `&` and brackets), if it's one.
fn function_of(mut d: Node<'_>) -> Option<Node<'_>> {
    loop {
        match d.kind() {
            "function_declarator" => return Some(d),
            "pointer_declarator" | "reference_declarator" | "parenthesized_declarator" => {
                d = d
                    .child_by_field_name("declarator")
                    .or_else(|| d.named_children(&mut d.walk()).last())?;
            }
            _ => return None,
        }
    }
}

/// The name a C++ declarator declares: through `*`, `&`, brackets and a function's
/// parameters, to its identifier (or `Store::open`, `~Store`, `operator==`).
fn declared(mut d: Node<'_>) -> Option<Node<'_>> {
    loop {
        match d.kind() {
            "function_declarator"
            | "pointer_declarator"
            | "reference_declarator"
            | "parenthesized_declarator"
            | "array_declarator"
            | "init_declarator" => {
                d = d
                    .child_by_field_name("declarator")
                    .or_else(|| d.named_children(&mut d.walk()).last())?;
            }
            "identifier"
            | "field_identifier"
            | "type_identifier"
            | "qualified_identifier"
            | "destructor_name"
            | "operator_name"
            | "template_function"
            | "namespace_identifier" => {
                return Some(d);
            }
            _ => return None,
        }
    }
}

/// `a::Store::open` is open; `open<T>` is open.
fn unqualified(mut n: Node<'_>) -> Node<'_> {
    while let Some(inner) = match n.kind() {
        "qualified_identifier" | "template_function" | "template_type" => {
            n.child_by_field_name("name")
        }
        _ => None,
    } {
        n = inner;
    }
    n
}

/// Not inside a function or a block, up to the file's root (`root`).
fn top_level(node: Node, root: &str) -> bool {
    let mut at = node.parent();
    while let Some(p) = at {
        let k = p.kind();
        if k == root {
            return true;
        }
        if k.contains("function")
            || k.contains("method")
            || k.ends_with("block")
            || k == "func_literal"
        {
            return false;
        }
        at = p.parent();
    }
    false
}

/// A defined name as people say it: an impl's type without its path or generics.
fn clean_name(text: &str) -> String {
    let text = text.split('<').next().unwrap_or("");
    let text = text.rsplit("::").next().unwrap_or("");
    text.trim().to_string()
}

/// At most `max` characters, with … when cut.
pub(super) fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(lang: Lang, src: &str) -> Vec<String> {
        read(lang, src)
            .unwrap()
            .defs
            .iter()
            .map(|d| {
                let holder = d
                    .container
                    .as_deref()
                    .map(|c| format!("{c}."))
                    .unwrap_or_default();
                format!(
                    "{} {holder}{} @{}-{}: {}",
                    d.kind.word(),
                    d.name,
                    d.line,
                    d.end,
                    d.sig
                )
            })
            .collect()
    }

    #[test]
    fn rust_definitions_and_their_holders() {
        let src = "pub struct Store {\n    a: u32,\n}\n\nimpl<T> Display for crate::x::Store<T> {\n    pub fn open(dir: &Path,\n        x: u8) -> Store {\n        todo()\n    }\n}\n\ntrait Talk { fn say(&self); }\nconst MAX: usize = 3;\nmacro_rules! hi { () => {} }\nmod inner;\n";
        assert_eq!(
            defs(Lang::Rust, src),
            [
                "struct Store @1-3: pub struct Store",
                "impl Store @5-10: impl<T> Display for crate::x::Store<T>",
                "method Store.open @6-9: pub fn open(dir: &Path, x: u8) -> Store",
                "trait Talk @12-12: trait Talk",
                "method Talk.say @12-12: fn say(&self);",
                "const MAX @13-13: const MAX: usize = 3;",
                "macro hi @14-14: macro_rules! hi { () => {} }",
                "module inner @15-15: mod inner;",
            ]
        );
    }

    #[test]
    fn typescript_definitions_and_variables_holding_functions() {
        let src = "export interface Robot { name: string; walk(): void }\nexport type Id = string;\nexport function createChat(r: Needs) {\n  function render() {}\n  const onClick = (e: Event) => render();\n  const n = 1;\n  return { render };\n}\nexport const LIMIT = 5;\nexport class Bot extends Base {\n  speed = 2;\n  constructor(private x: number) { super(); }\n  async go(to: string): Promise<void> {}\n}\nenum Mood { Happy }\n";
        assert_eq!(
            defs(Lang::TypeScript, src),
            [
                "interface Robot @1-1: export interface Robot",
                "property Robot.name @1-1: name: string",
                "method Robot.walk @1-1: walk(): void",
                "type Id @2-2: export type Id = string;",
                "function createChat @3-8: export function createChat(r: Needs)",
                "function createChat.render @4-4: function render()",
                "function createChat.onClick @5-5: const onClick = (e: Event) =>",
                "const LIMIT @9-9: export const LIMIT = 5;",
                "class Bot @10-14: export class Bot extends Base",
                "property Bot.speed @11-11: speed = 2",
                "method Bot.constructor @12-12: constructor(private x: number)",
                "method Bot.go @13-13: async go(to: string): Promise<void>",
                "enum Mood @15-15: enum Mood",
            ]
        );
    }

    #[test]
    fn properties_count_only_as_members_of_a_type() {
        let src = "type Run = { mon: { m: number }; hb: Box };\nfunction ask({ id }: { id: string }) {}\n";
        assert_eq!(
            defs(Lang::TypeScript, src),
            [
                "type Run @1-1: type Run = { mon: { m: number }; hb: Box };",
                "property Run.mon @1-1: mon: { m: number }",
                "property Run.hb @1-1: hb: Box",
                "function ask @2-2: function ask({ id }: { id: string })",
            ]
        );
    }

    #[test]
    fn javascript_reads_with_the_tsx_grammar() {
        let src = "export default function App() { return <div onClick={() => go()} />; }\nconst go = () => 1;\n";
        assert_eq!(
            defs(Lang::Tsx, src),
            [
                "function App @1-1: export default function App()",
                "function go @2-2: const go = () =>",
            ]
        );
    }

    #[test]
    fn csharp_definitions() {
        let src = "namespace Shop.Orders;\n\n[ApiController]\npublic class OrdersController : ControllerBase\n{\n    public OrdersController(IOrders o) { }\n    public string Name { get; set; }\n    [HttpGet]\n    public async Task<IActionResult> Get(int id)\n    {\n        return Ok();\n    }\n}\npublic interface IOrders { Order Find(int id); }\npublic record Order(int Id);\npublic enum State { Open }\n";
        assert_eq!(
            defs(Lang::CSharp, src),
            [
                // (a file-scoped namespace is its own line: what follows isn't inside it)
                "module Shop.Orders @1-1: namespace Shop.Orders;",
                "class OrdersController @3-13: [ApiController] public class OrdersController : ControllerBase",
                "constructor OrdersController.OrdersController @6-6: public OrdersController(IOrders o)",
                "property OrdersController.Name @7-7: public string Name { get; set; }",
                "method OrdersController.Get @8-12: [HttpGet] public async Task<IActionResult> Get(int id)",
                "interface IOrders @14-14: public interface IOrders",
                "method IOrders.Find @14-14: Order Find(int id);",
                "class Order @15-15: public record Order(int Id);",
                "enum State @16-16: public enum State",
            ]
        );
    }

    #[test]
    fn go_definitions() {
        let src = "package shop\n\nconst (\n\tMax = 3\n)\n\ntype Order struct {\n\tID int\n}\n\ntype Store interface {\n\tFind(id int) Order\n}\n\nfunc (s *DB) Find(id int) Order {\n\tconst local = 1\n\treturn Order{}\n}\n\nfunc New() *DB { return nil }\n";
        assert_eq!(
            defs(Lang::Go, src),
            [
                "const Max @4-4: Max = 3",
                "struct Order @7-9: type Order struct",
                "property Order.ID @8-8: ID int",
                "interface Store @11-13: type Store interface",
                "method Store.Find @12-12: Find(id int) Order",
                "method Find @15-18: func (s *DB) Find(id int) Order",
                "function New @20-20: func New() *DB",
            ]
        );
    }

    #[test]
    fn python_definitions() {
        let src = "MAX = 3\n\n@dataclass\nclass Order(Base):\n    def total(self, tax: float) -> float:\n        x = 1\n        return x\n\ndef main():\n    def helper():\n        pass\n";
        assert_eq!(
            defs(Lang::Python, src),
            [
                "const MAX @1-1: MAX = 3",
                "class Order @4-7: class Order(Base):",
                "method Order.total @5-7: def total(self, tax: float) -> float:",
                "function main @9-11: def main():",
                "function main.helper @10-11: def helper():",
            ]
        );
    }

    #[test]
    fn java_definitions() {
        let src = "package shop.orders;\n\nimport java.util.List;\n\n@Service\npublic class OrderService extends Base implements Api {\n    private final Store store;\n    static final int MAX = 3;\n    public OrderService(Store s) { this.store = s; }\n    public List<Order> find(int id) {\n        return store.load(id);\n    }\n}\ninterface Api { void ping(); int LIMIT = 1; }\nenum State { OPEN }\nrecord Point(int x, int y) {}\n";
        assert_eq!(
            defs(Lang::Java, src),
            [
                "module shop.orders @1-1: package shop.orders;",
                "class OrderService @5-13: @Service public class OrderService extends Base implements Api",
                "property OrderService.store @7-7: private final Store store;",
                "property OrderService.MAX @8-8: static final int MAX = 3;",
                "constructor OrderService.OrderService @9-9: public OrderService(Store s)",
                "method OrderService.find @10-12: public List<Order> find(int id)",
                "interface Api @14-14: interface Api",
                "method Api.ping @14-14: void ping();",
                "const Api.LIMIT @14-14: int LIMIT = 1;",
                "enum State @15-15: enum State",
                "class Point @16-16: record Point(int x, int y)",
            ]
        );
    }

    #[test]
    fn cpp_definitions_in_and_out_of_their_class() {
        let src = "#define MAX 3\nnamespace shop {\nclass Store;\nclass Store : public Base {\npublic:\n    Store();\n    ~Store();\n    void open(const Path& p);\n    int size() const { return n; }\nprivate:\n    int n;\n    Cache* cache;\n};\nstruct Point { int x; };\nusing Id = int;\nenum class Mood { Happy };\n}\nvoid shop::Store::open(const Path& p) {\n    cache->load(p);\n}\nstatic int helper(int a) { return a; }\n";
        assert_eq!(
            defs(Lang::Cpp, src),
            [
                "macro MAX @1-1: #define MAX 3",
                "module shop @2-17: namespace shop",
                "class shop.Store @4-13: class Store : public Base",
                "method Store.Store @6-6: Store();",
                "method Store.~Store @7-7: ~Store();",
                "method Store.open @8-8: void open(const Path& p);",
                "method Store.size @9-9: int size() const",
                "property Store.n @11-11: int n;",
                "property Store.cache @12-12: Cache* cache;",
                "struct shop.Point @14-14: struct Point",
                "property Point.x @14-14: int x;",
                "type shop.Id @15-15: using Id = int;",
                "enum shop.Mood @16-16: enum class Mood",
                "method open @18-20: void shop::Store::open(const Path& p)",
                "function helper @21-21: static int helper(int a)",
            ]
        );
    }

    #[test]
    fn names_used_are_counted_but_not_where_they_are_defined() {
        let src = "fn helper() {}\nfn main() {\n    helper();\n    helper();\n    let s = Store::open();\n}\n";
        let f = read_for(Lang::Rust, src, Some("helper")).unwrap();
        let names: Vec<(&str, u32)> = f.names.iter().map(|(n, c)| (n.as_str(), *c)).collect();
        assert_eq!(names, [("Store", 1), ("helper", 2), ("open", 1), ("s", 1)]);
        assert_eq!(f.uses, [3, 4]);
    }

    #[test]
    fn facts_are_kept_as_json_without_the_lines_asked_for() {
        let f = read_for(Lang::Rust, "fn a() { b(); }\n", Some("b")).unwrap();
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(
            json["defs"],
            serde_json::json!([{ "name": "a", "kind": "function", "container": null, "line": 1, "end": 1, "depth": 0, "sig": "fn a()" }])
        );
        assert_eq!(json["names"], serde_json::json!([["b", 1]]));
        assert_eq!(json["refs"][0]["name"], "b"); // (and its links, graph/)
        assert!(json.get("uses").is_none());
        let back: Facts = serde_json::from_value(json).unwrap();
        assert_eq!((back.defs, back.names), (f.defs, f.names));
    }

    #[test]
    fn long_text_is_cut() {
        assert_eq!(cut("abcdef", 3), "abc…");
        assert_eq!(cut("ab", 3), "ab");
        assert_eq!(cut("đăng nhập", 4), "đăng…");
    }
}
