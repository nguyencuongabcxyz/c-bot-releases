//! What a node defines, and the node naming it, for the languages whose grammars need a closer
//! look than a `name` field: Kotlin, Swift, PowerShell, Dart, Zig, and the schemas (Prisma,
//! Protocol Buffers, Terraform's HCL).

use super::*;

/// A child that's just this word (`init`, `class`): a keyword.
pub(super) fn keyword<'t>(node: Node<'t>, word: &str) -> Option<Node<'t>> {
    let mut c = node.walk();
    node.children(&mut c).find(|n| n.kind() == word)
}

/// The first named child of one of these kinds.
fn child_of<'t>(node: Node<'t>, kinds: &[&str]) -> Option<Node<'t>> {
    let mut c = node.walk();
    node.named_children(&mut c)
        .find(|n| kinds.contains(&n.kind()))
}

/// A property at the top of the file is a constant; in a type, a property.
fn property_or_const(node: Node, root: &str) -> Kind {
    if node.parent().is_some_and(|p| p.kind() == root) {
        Kind::Const
    } else {
        Kind::Property
    }
}

/// What a Kotlin node defines: an interface or enum (`class_declaration`s too), a property
/// (named in its variable), a constructor (named by its keyword), a package.
pub(super) fn kotlin_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let field = |f: &str| node.child_by_field_name(f);
    match node.kind() {
        "class_declaration" => {
            let kind = if keyword(node, "interface").is_some() {
                Kind::Interface
            } else if keyword(node, "enum_class_body").is_some() {
                Kind::Enum
            } else {
                kind
            };
            Some((kind, field("name")?))
        }
        "property_declaration" => {
            let name = keyword(node, "variable_declaration")?.named_child(0)?;
            Some((property_or_const(node, "source_file"), name))
        }
        "secondary_constructor" => Some((kind, keyword(node, "constructor")?)),
        "type_alias" => Some((kind, field("type")?)),
        "package_header" => Some((kind, node.named_child(0)?)),
        _ => Some((kind, field("name")?)),
    }
}

/// What a Swift node defines: a class_declaration is a class, struct, enum or actor, or an
/// extension (of the type it names: its methods go with it, as a Rust impl's do); a property
/// is named in its pattern; an init by its keyword.
pub(super) fn swift_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let field = |f: &str| node.child_by_field_name(f);
    match node.kind() {
        "class_declaration" => {
            let kind = [
                ("struct", Kind::Struct),
                ("enum", Kind::Enum),
                ("extension", Kind::Impl),
            ]
            .into_iter()
            .find(|(word, _)| keyword(node, word).is_some())
            .map_or(kind, |(_, k)| k);
            Some((kind, field("name")?))
        }
        "property_declaration" => {
            let name = field("name")?.child_by_field_name("bound_identifier")?;
            Some((property_or_const(node, "source_file"), name))
        }
        "init_declaration" => Some((kind, keyword(node, "init")?)),
        _ => Some((kind, field("name")?)),
    }
}

/// What a PowerShell node defines, named by its first name (its grammar has no name fields);
/// a property's without its `$`.
pub(super) fn powershell_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let name = match node.kind() {
        "function_statement" => keyword(node, "function_name")?,
        "class_property_definition" => keyword(node, "variable")?,
        _ => keyword(node, "simple_name")?,
    };
    Some((kind, name))
}

// ---------------------------------------------------------------- Dart

/// The signatures a constructor is declared with.
const DART_CONSTRUCTORS: &[&str] = &[
    "constructor_signature",
    "constant_constructor_signature",
    "factory_constructor_signature",
    "redirecting_factory_constructor_signature",
];

/// What a Dart node defines: a function or method named in its signature (a constructor's
/// by its last name: `OrderPage.empty` is empty, `OrderPage()` OrderPage), a class member's
/// declaration (a field, an abstract method, a constructor), a top-level variable, an
/// extension (named by the type it extends), a typedef.
pub(super) fn dart_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let field = |f: &str| node.child_by_field_name(f);
    match node.kind() {
        "function_declaration" => Some((kind, field("signature")?.child_by_field_name("name")?)),
        "method_declaration" => dart_signature(field("signature")?.named_child(0)?),
        "declaration" => {
            let first = node.named_child(0)?;
            match first.kind() {
                "type" | "inferred_type" | "final_builtin" | "const_builtin" => {
                    let list = child_of(
                        node,
                        &[
                            "initialized_identifier_list",
                            "static_final_declaration_list",
                        ],
                    )?;
                    Some((
                        Kind::Property,
                        list.named_child(0)?.child_by_field_name("name")?,
                    ))
                }
                _ => {
                    let signature = child_of(
                        node,
                        &[
                            "function_signature",
                            "getter_signature",
                            "setter_signature",
                            "operator_signature",
                            "constructor_signature",
                            "constant_constructor_signature",
                            "factory_constructor_signature",
                            "redirecting_factory_constructor_signature",
                        ],
                    )?;
                    dart_signature(signature)
                }
            }
        }
        "top_level_variable_declaration" => {
            let list = child_of(
                node,
                &[
                    "static_final_declaration_list",
                    "initialized_identifier_list",
                ],
            )?;
            Some((kind, list.named_child(0)?.child_by_field_name("name")?))
        }
        "extension_declaration" | "extension_type_declaration" => {
            Some((kind, field("class").or_else(|| field("name"))?))
        }
        "type_alias" => Some((kind, child_of(node, &["type_identifier"])?)),
        _ => Some((kind, field("name")?)),
    }
}

/// A method's or a constructor's signature: what it is, and its (last) name.
fn dart_signature(signature: Node<'_>) -> Option<(Kind, Node<'_>)> {
    let kind = if DART_CONSTRUCTORS.contains(&signature.kind()) {
        Kind::Constructor
    } else {
        Kind::Method
    };
    let mut c = signature.walk();
    let name = signature.children_by_field_name("name", &mut c).last()?;
    Some((kind, name))
}

// ---------------------------------------------------------------- Zig

/// What a Zig node defines: a `const` holding a struct, union or opaque type is a struct, one
/// holding an enum or an error set an enum; any other `const` or `var` outside a function is a
/// constant, unless it's an @import (that's what the file uses, not what it defines); a test
/// is named by its string.
pub(super) fn zig_definition<'t>(
    node: Node<'t>,
    kind: Kind,
    src: &str,
) -> Option<(Kind, Node<'t>)> {
    match node.kind() {
        "variable_declaration" => {
            let name = child_of(node, &["identifier"])?;
            let ty = child_of(
                node,
                &[
                    "struct_declaration",
                    "union_declaration",
                    "opaque_declaration",
                    "enum_declaration",
                    "error_set_declaration",
                ],
            );
            if let Some(ty) = ty {
                let kind = match ty.kind() {
                    "enum_declaration" | "error_set_declaration" => Kind::Enum,
                    _ => Kind::Struct,
                };
                return Some((kind, name));
            }
            let imported = child_of(node, &["builtin_function", "field_expression"])
                .and_then(|v| zig_import(v, src))
                .is_some();
            (!imported && top_level(node, "source_file")).then_some((kind, name))
        }
        "test_declaration" => Some((kind, child_of(node, &["string"])?.named_child(0)?)),
        _ => Some((kind, node.child_by_field_name("name")?)),
    }
}

/// What `@import("x.zig")` imports (x.zig), the same through a field of it
/// (`@import("x.zig").Store`).
pub(in crate::context) fn zig_import<'s>(mut value: Node, src: &'s str) -> Option<&'s str> {
    loop {
        match value.kind() {
            "builtin_function" => {
                let name = child_of(value, &["builtin_identifier"])?;
                if src.get(name.byte_range()) != Some("@import") {
                    return None;
                }
                let spec = child_of(value, &["arguments"])?.named_child(0)?;
                let spec = child_of(spec, &["string_content"])?;
                return src.get(spec.byte_range());
            }
            "field_expression" => value = value.child_by_field_name("object")?,
            _ => return None,
        }
    }
}

// ---------------------------------------------------------------- the schemas

/// What a Prisma node defines: a model, view, type, enum, datasource or generator, and a
/// model's columns, each named by its first name.
pub(super) fn prisma_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    Some((kind, child_of(node, &["identifier"])?))
}

/// What a Protocol Buffers node defines: a message, enum or service (named in its
/// message_name, enum_name…), an rpc, a field, a oneof, the package.
pub(super) fn proto_definition(node: Node<'_>, kind: Kind) -> Option<(Kind, Node<'_>)> {
    let name = match node.kind() {
        "message" | "enum" | "service" | "rpc" => {
            let wrapper = format!("{}_name", node.kind());
            child_of(node, &[wrapper.as_str()])?.named_child(0)?
        }
        "package" => child_of(node, &["full_ident"])?,
        _ => child_of(node, &["identifier"])?,
    };
    Some((kind, name))
}

/// What a Terraform block is, by its type: a resource or a data source is a class (its nested
/// blocks, `lifecycle`, are properties), a module, provider or the `terraform` block a module,
/// a variable or an output a constant. Reader names it by its labels (hcl_name).
pub(super) fn hcl_definition<'t>(node: Node<'t>, src: &str) -> Option<(Kind, Node<'t>)> {
    let ty = child_of(node, &["identifier"])?;
    let top = node
        .parent()
        .and_then(|body| body.parent())
        .is_some_and(|f| f.kind() == "config_file");
    let kind = match src.get(ty.byte_range()).unwrap_or("") {
        _ if !top => Kind::Property,
        "module" | "provider" | "terraform" | "locals" => Kind::Module,
        "variable" | "output" => Kind::Const,
        _ => Kind::Class,
    };
    Some((kind, ty))
}

/// A Terraform block's name: its labels, dotted as Terraform says them (`aws_s3_bucket.logs`,
/// `region`), else its type (`locals`, `lifecycle`).
pub(super) fn hcl_name(node: Node, src: &str) -> String {
    let mut c = node.walk();
    let labels: Vec<&str> = node
        .named_children(&mut c)
        .filter(|n| n.kind() == "string_lit" || n.kind() == "identifier")
        .skip(1)
        .filter_map(|n| src.get(n.byte_range()))
        .map(|l| l.trim_matches('"'))
        .collect();
    if labels.is_empty() {
        let ty = child_of(node, &["identifier"]);
        return ty
            .and_then(|t| src.get(t.byte_range()))
            .unwrap_or("")
            .to_string();
    }
    labels.join(".")
}

#[cfg(test)]
mod tests {
    use super::super::tests::defs;
    use super::*;

    #[test]
    fn kotlin_definitions() {
        let src = "package shop.orders\n\nclass Store(val n: Int) : Base() {\n    val size: Int = 0\n    constructor() : this(0)\n    fun open(p: String): Int = go(p)\n}\n\ninterface Api {\n    fun ping()\n}\n\nenum class Mood {\n    HAPPY\n}\n\nobject Registry {\n}\n\ntypealias Id = String\nval MAX = 3\nfun main() {\n    val x = 1\n}\n";
        assert_eq!(
            defs(Lang::Kotlin, src),
            [
                "module shop.orders @1-1: package shop.orders",
                "class Store @3-7: class Store(val n: Int) : Base()",
                "property Store.size @4-4: val size: Int = 0",
                "constructor Store.constructor @5-5: constructor() : this(0)",
                "method Store.open @6-6: fun open(p: String): Int = go(p)",
                "interface Api @9-11: interface Api",
                "method Api.ping @10-10: fun ping()",
                "enum Mood @13-15: enum class Mood",
                "class Registry @17-18: object Registry",
                "type Id @20-20: typealias Id = String",
                "const MAX @21-21: val MAX = 3",
                "function main @22-24: fun main()",
            ]
        );
    }

    #[test]
    fn swift_definitions_and_what_extends_a_type() {
        let src = "class Store: Base {\n    var size: Int = 0\n    init(n: Int) {}\n    func open(p: String) -> Int { return go(p) }\n}\nstruct Point { let x: Int }\nenum Mood { case happy }\nprotocol Api { func ping() }\nextension Store {\n    func more() {}\n}\ntypealias Id = String\nlet MAX = 3\nfunc main() {\n    let x = 1\n}\n";
        assert_eq!(
            defs(Lang::Swift, src),
            [
                "class Store @1-5: class Store: Base",
                "property Store.size @2-2: var size: Int = 0",
                "constructor Store.init @3-3: init(n: Int)",
                "method Store.open @4-4: func open(p: String) -> Int",
                "struct Point @6-6: struct Point",
                "property Point.x @6-6: let x: Int",
                "enum Mood @7-7: enum Mood",
                "interface Api @8-8: protocol Api",
                "method Api.ping @8-8: func ping()",
                "impl Store @9-11: extension Store",
                "method Store.more @10-10: func more()",
                "type Id @12-12: typealias Id = String",
                "const MAX @13-13: let MAX = 3",
                "function main @14-16: func main()",
            ]
        );
    }

    #[test]
    fn powershell_functions_and_classes() {
        let src = "function Get-Store {\n  param($x)\n}\nclass Store : Base {\n  [int]$Size\n  [int] Open([string]$p) { return 1 }\n}\nenum Mood { Happy }\n";
        assert_eq!(
            defs(Lang::PowerShell, src),
            [
                "function Get-Store @1-3: function Get-Store",
                "class Store @4-7: class Store : Base",
                "property Store.Size @5-5: [int]$Size",
                "method Store.Open @6-6: [int] Open([string]$p) { return 1 }",
                "enum Mood @8-8: enum Mood { Happy }",
            ]
        );
    }

    #[test]
    fn dart_and_flutter_definitions() {
        let src = "import 'package:flutter/material.dart';\nconst kMax = 3;\nabstract class Repo<T> {\n  Future<T> load(int id);\n}\nclass OrderPage extends StatefulWidget {\n  final Store store;\n  const OrderPage({super.key, required this.store});\n  @override\n  State<OrderPage> createState() => _OrderPageState();\n  int get count => 1;\n  factory OrderPage.empty() => OrderPage(store: Store());\n}\nmixin Logs on Object { void log() {} }\nenum Color { red, green }\nextension Shout on String { String shout() => toUpperCase(); }\ntypedef Cb = void Function(int);\nvoid main() { runApp(const OrderPage(store: null)); }\n";
        assert_eq!(
            defs(Lang::Dart, src),
            [
                "const kMax @2-2: const kMax = 3;",
                "class Repo @3-5: abstract class Repo<T>",
                "method Repo.load @4-4: Future<T> load(int id)",
                "class OrderPage @6-13: class OrderPage extends StatefulWidget",
                "property OrderPage.store @7-7: final Store store",
                "constructor OrderPage.OrderPage @8-8: const OrderPage({super.key, required this.store})",
                "method OrderPage.createState @9-10: @override State<OrderPage> createState()",
                "method OrderPage.count @11-11: int get count",
                "constructor OrderPage.empty @12-12: factory OrderPage.empty()",
                "trait Logs @14-14: mixin Logs on Object",
                "method Logs.log @14-14: void log()",
                "enum Color @15-15: enum Color",
                "impl String @16-16: extension Shout on String",
                "method String.shout @16-16: String shout()",
                "type Cb @17-17: typedef Cb = void Function(int);",
                "function main @18-18: void main()",
            ]
        );
    }

    #[test]
    fn zig_definitions_its_types_are_constants_holding_them() {
        let src = "const std = @import(\"std\");\nconst Store = @import(\"store.zig\").Store;\nconst MAX: usize = 3;\npub const Order = struct {\n    id: u64,\n    pub fn total(self: *Order) u64 {\n        const x = 1;\n        return x;\n    }\n};\nconst Color = enum { red };\nfn helper(x: u64) u64 {\n    return x;\n}\ntest \"adds\" {\n    _ = helper(1);\n}\n";
        assert_eq!(
            defs(Lang::Zig, src),
            [
                "const MAX @3-3: const MAX: usize = 3;",
                "struct Order @4-10: pub const Order = struct",
                "property Order.id @5-5: id: u64",
                "method Order.total @6-9: pub fn total(self: *Order) u64",
                "enum Color @11-11: const Color = enum { red };",
                "property Color.red @11-11: red",
                "function helper @12-14: fn helper(x: u64) u64",
                "function adds @15-17: test \"adds\"",
            ]
        );
    }

    #[test]
    fn prisma_models_their_columns_and_enums() {
        let src = "datasource db {\n  provider = \"postgresql\"\n}\nmodel User {\n  id    Int    @id\n  posts Post[]\n}\nenum Role {\n  ADMIN\n}\n";
        assert_eq!(
            defs(Lang::Prisma, src),
            [
                "module db @1-3: datasource db",
                "class User @4-7: model User",
                "property User.id @5-5: id Int @id",
                "property User.posts @6-6: posts Post[]",
                "enum Role @8-10: enum Role",
            ]
        );
    }

    #[test]
    fn protocol_buffers_messages_services_and_rpcs() {
        let src = "syntax = \"proto3\";\npackage shop.v1;\nmessage Order {\n  int64 id = 1;\n  message Line { string sku = 1; }\n}\nenum Status { UNKNOWN = 0; }\nservice Orders {\n  rpc Get(GetRequest) returns (Order);\n}\n";
        assert_eq!(
            defs(Lang::Proto, src),
            [
                "module shop.v1 @2-2: package shop.v1;",
                "struct Order @3-6: message Order",
                "property Order.id @4-4: int64 id = 1;",
                "struct Order.Line @5-5: message Line { string sku = 1; }",
                "property Line.sku @5-5: string sku = 1;",
                "enum Status @7-7: enum Status { UNKNOWN = 0; }",
                "interface Orders @8-10: service Orders",
                "method Orders.Get @9-9: rpc Get(GetRequest) returns (Order);",
            ]
        );
    }

    #[test]
    fn terraform_blocks_are_named_by_their_labels() {
        let src = "variable \"region\" {\n  default = \"eu\"\n}\nresource \"aws_s3_bucket\" \"logs\" {\n  bucket = \"x\"\n  lifecycle {\n    prevent_destroy = true\n  }\n}\nmodule \"vpc\" {\n  source = \"./modules/vpc\"\n}\nlocals {\n  name = \"x\"\n}\n";
        assert_eq!(
            defs(Lang::Hcl, src),
            [
                "const region @1-3: variable \"region\"",
                "class aws_s3_bucket.logs @4-9: resource \"aws_s3_bucket\" \"logs\"",
                "property aws_s3_bucket.logs.lifecycle @6-8: lifecycle",
                "module vpc @10-12: module \"vpc\"",
                "module locals @13-15: locals",
            ]
        );
    }
}
