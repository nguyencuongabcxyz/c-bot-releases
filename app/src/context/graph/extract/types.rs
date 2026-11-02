//! The types a file's declarations name, the same way for every language: what's at a node's
//! `type`, `return_type`, `result` or `returns` field (each grammar's names for them), and
//! what that node is (a parameter, a function, a field) says what the type is there for. A
//! type inside another's (`Vec<Store>`, a function type's parameters) counts as the outer one.

use super::*;

/// The fields a declaration's type is at.
const FIELDS: &[&str] = &["type", "return_type", "result", "returns"];

/// Nodes whose `type` is a parameter's.
const PARAMS: &[&str] = &[
    "parameter",
    "formal_parameter",
    "required_parameter",
    "optional_parameter",
    "parameter_declaration",
    "optional_parameter_declaration",
    "variadic_parameter_declaration",
    "variadic_parameter",
    "spread_parameter",
    "typed_parameter",
    "typed_default_parameter",
    "simple_parameter",
    "property_promotion_parameter",
];

/// Nodes whose `type` is a field's or a property's.
const MEMBERS: &[&str] = &[
    "field_declaration",
    "public_field_definition",
    "property_signature",
    "property_declaration",
    "ordered_field_declaration_list",
];

/// Nodes whose `type` is what they return (Java's, C#'s and C++'s functions say it first).
const FUNCTIONS: &[&str] = &[
    "method_declaration",
    "function_definition",
    "local_function_statement",
    "delegate_declaration",
];

/// Nodes whose `type` is no use of one here: what they define (Go's `type Store struct`), the
/// type a Rust impl is for, or one they make (a construction: the calls have it already).
const NOT_USES: &[&str] = &[
    "type_spec",
    "impl_item",
    "object_creation_expression",
    "new_expression",
    "composite_literal",
];

/// A name with a path before it, the name last: Rust's `a::Store`, Go's `pkg.Store`, C#'s
/// `System.IO.Stream`, TypeScript's `ns.Store`, C++'s `ns::Store`, Java's `java.util.List`,
/// Python's `models.Store`, PHP's `\App\Store`.
const QUALIFIED: &[&str] = &[
    "scoped_type_identifier",
    "qualified_type",
    "qualified_name",
    "nested_type_identifier",
    "qualified_identifier",
    "attribute",
];

/// A C++ type that's defined where it's named (`struct { int a; } s;`): its fields are read as
/// they come.
const DEFINED: &[&str] = &[
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
];

impl Walk<'_> {
    /// The types `node` names at its type fields, unless it's inside one already read.
    pub(super) fn declared_types(&mut self, node: Node) {
        let at = node.start_byte();
        self.typed.retain(|r| r.end > at);
        if self.typed.iter().any(|r| r.contains(&at)) || NOT_USES.contains(&node.kind()) {
            return;
        }
        for field in FIELDS {
            // (a Rust tuple struct's fields are each a `type` of one node)
            let mut c = node.walk();
            let all: Vec<Node> = node.children_by_field_name(field, &mut c).collect();
            for ty in all {
                if !DEFINED.contains(&ty.kind()) {
                    self.typed.push(ty.byte_range());
                    if let Some(role) = self.role(node, field) {
                        self.named_in(ty, role);
                    }
                }
            }
        }
    }

    /// The types named inside `ty`, a declared type, all there for `role`.
    fn named_in(&mut self, ty: Node, role: TypeRole) {
        let mut stack = vec![ty];
        while let Some(n) = stack.pop() {
            if self.names_a_type(n.kind())
                && let Some(name) = self.path_of(n)
            {
                let line = Self::line(n);
                self.out.types.push(TypeUse {
                    name,
                    role,
                    line,
                    within: self.within(line),
                });
            }
            let mut c = n.walk();
            stack.extend(n.named_children(&mut c));
        }
    }

    /// The name a type's name node gives, with the path before it (`a::b::Store`, Go's
    /// `pkg::Store`, C#'s `System::IO::Stream`: always with `::`), so a type from outside isn't
    /// taken for the folder's of its name. None for a part of a path (`System`, `IO`).
    fn path_of(&self, n: Node) -> Option<String> {
        let mut top = n;
        while let Some(p) = top.parent()
            && QUALIFIED.contains(&p.kind())
        {
            let last = u32::try_from(p.named_child_count().checked_sub(1)?).ok();
            let last = p.named_child(last?)?;
            if last.id() != top.id() {
                return None;
            }
            top = p;
        }
        let text = self.text(top).replace(['.', '\\'], "::");
        let path = text.trim_start_matches("::");
        // (a name alone, or with its path: nothing else, no generics, no spaces)
        let plain = path
            .split("::")
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric() || c == '_'));
        plain.then(|| path.to_string())
    }

    /// What the type at `node`'s `field` is there for (None: no use of one).
    fn role(&self, node: Node, field: &str) -> Option<TypeRole> {
        let kind = node.kind();
        let declares_function = || {
            node.child_by_field_name("declarator")
                .is_some_and(|d| d.kind() == "function_declarator")
        };
        if field != "type" || FUNCTIONS.contains(&kind) {
            return Some(TypeRole::Returns);
        }
        if PARAMS.contains(&kind) {
            // (Go's receiver: the type the method is of, not one it's given)
            let list = node.parent()?;
            let receiver = list
                .parent()
                .and_then(|m| m.child_by_field_name("receiver"))
                .is_some_and(|r| r.id() == list.id());
            return (!receiver).then_some(TypeRole::Param);
        }
        // (C#'s field: its variables' declaration is the field's)
        let field_variables = kind == "variable_declaration"
            && node.parent().is_some_and(|p| {
                matches!(p.kind(), "field_declaration" | "event_field_declaration")
            });
        if MEMBERS.contains(&kind) || field_variables || kind == "declaration" {
            // (C++'s `Store open();`: a function declared, its type is what it returns)
            if declares_function() {
                return Some(TypeRole::Returns);
            }
            if kind != "declaration" {
                return Some(TypeRole::Field);
            }
        }
        // (Python's class attribute `store: Store`, said in the class itself)
        let line = Self::line(node);
        let in_type = self
            .within(line)
            .and_then(|d| self.defs.get(d as usize))
            .is_some_and(|d| d.kind.holds_methods());
        Some(if in_type {
            TypeRole::Field
        } else {
            TypeRole::Other
        })
    }

    /// A node that names a type, inside a declared type.
    fn names_a_type(&self, kind: &str) -> bool {
        match self.lang {
            Lang::CSharp | Lang::Python | Lang::Zig => kind == "identifier",
            Lang::Php => kind == "name",
            _ => kind == "type_identifier",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::parse;

    /// Each type named: `role name @line in definition`.
    fn types(lang: Lang, src: &str) -> Vec<String> {
        let facts = parse::read(lang, src).unwrap();
        facts
            .links
            .types
            .iter()
            .map(|t| {
                let within = t
                    .within
                    .and_then(|w| facts.defs.get(w as usize))
                    .map_or("-", |d| d.name.as_str());
                format!("{:?} {} @{} in {within}", t.role, t.name, t.line)
            })
            .collect()
    }

    #[test]
    fn typescript_parameters_returns_fields_and_locals_but_not_what_it_makes() {
        let src = "class Shop {\n  cache: Map<string, Order>;\n  constructor(private store: Store) {}\n  open(o: Order, f: (s: Store) => Cart): Cart {\n    const c: Cart = new Cart();\n    return c;\n  }\n}\nfunction make(): Shop { return new Shop(null); }\n";
        assert_eq!(
            types(Lang::TypeScript, src),
            [
                "Field Order @2 in cache",
                "Field Map @2 in cache",
                "Param Store @3 in constructor",
                "Returns Cart @4 in open",
                "Param Order @4 in open",
                // (a function type's parameter and return: what the parameter is)
                "Param Cart @4 in open",
                "Param Store @4 in open",
                "Other Cart @5 in open",
                "Returns Shop @9 in make",
            ]
        );
    }

    #[test]
    fn rust_fields_of_a_struct_and_a_tuple_struct_but_not_an_impls_type() {
        let src = "struct Shop {\n    store: Arc<Store>,\n}\nstruct Pair(Order, Cart);\nimpl Shop {\n    fn open(&self, o: &Order) -> Result<Cart, Error> {\n        let c: Cart = Cart::new();\n        c\n    }\n}\nimpl Show for Shop {}\n";
        assert_eq!(
            types(Lang::Rust, src),
            [
                "Field Store @2 in Shop",
                "Field Arc @2 in Shop",
                "Field Order @4 in Pair",
                "Field Cart @4 in Pair",
                "Returns Error @6 in open",
                "Returns Cart @6 in open",
                "Returns Result @6 in open",
                "Param Order @6 in open",
                "Other Cart @7 in open",
            ]
        );
    }

    #[test]
    fn a_type_named_with_its_path_keeps_it_and_its_parts_are_no_types() {
        let rust =
            "fn open(e: tungstenite::Error, s: crate::store::Store) -> std::io::Result<()> {}\n";
        assert_eq!(
            types(Lang::Rust, rust),
            [
                "Returns std::io::Result @1 in open",
                "Param tungstenite::Error @1 in open",
                "Param crate::store::Store @1 in open",
            ]
        );
        let csharp = "class Shop {\n  void Open(System.IO.Stream s, Shop.Orders.Order o) {}\n}\n";
        assert_eq!(
            types(Lang::CSharp, csharp),
            [
                "Param System::IO::Stream @2 in Open",
                "Param Shop::Orders::Order @2 in Open",
            ]
        );
    }

    #[test]
    fn a_python_class_attribute_is_a_field() {
        let src = "class Shop:\n    store: Store\n    def open(self, o: Order) -> Optional[Cart]:\n        c: Cart = Cart()\n        return c\n";
        assert_eq!(
            types(Lang::Python, src),
            [
                "Field Store @2 in Shop",
                "Returns Cart @3 in open",
                "Returns Optional @3 in open",
                "Param Order @3 in open",
                "Other Cart @4 in open",
            ]
        );
    }

    #[test]
    fn a_go_methods_receiver_is_no_parameter() {
        let src = "package shop\n\ntype Shop struct {\n\tstore *Store\n}\n\nfunc (s *Shop) Open(o Order) (Cart, error) {\n\tvar c Cart\n\treturn c, nil\n}\n";
        assert_eq!(
            types(Lang::Go, src),
            [
                "Field Store @4 in store",
                "Returns error @7 in Open",
                "Returns Cart @7 in Open",
                "Param Order @7 in Open",
                "Other Cart @8 in Open",
            ]
        );
    }

    #[test]
    fn csharp_fields_and_properties_but_not_what_it_makes() {
        let src = "class Shop {\n  private IStore _store;\n  public Order Last { get; set; }\n  public Cart Open(Order o) {\n    Cart c = new Cart();\n    return c;\n  }\n}\n";
        assert_eq!(
            types(Lang::CSharp, src),
            [
                "Field IStore @2 in _store",
                "Field Order @3 in Last",
                "Returns Cart @4 in Open",
                "Param Order @4 in Open",
                "Other Cart @5 in Open",
            ]
        );
    }

    #[test]
    fn a_cpp_method_declared_in_its_class_returns_its_type() {
        let src = "class Shop {\n  Store* store;\n  Cart open(const Order& o);\n};\nCart Shop::open(const Order& o) {\n  Cart c;\n  return c;\n}\n";
        assert_eq!(
            types(Lang::Cpp, src),
            [
                "Field Store @2 in store",
                "Returns Cart @3 in open",
                "Param Order @3 in open",
                "Returns Cart @5 in open",
                "Param Order @5 in open",
                "Other Cart @6 in open",
            ]
        );
    }

    #[test]
    fn java_and_php_say_their_types_too() {
        let java = "class Shop {\n  private Store store;\n  Cart open(Order o) {\n    Cart c = new Cart();\n    return c;\n  }\n}\n";
        assert_eq!(
            types(Lang::Java, java),
            [
                "Field Store @2 in store",
                "Returns Cart @3 in open",
                "Param Order @3 in open",
                "Other Cart @4 in open",
            ]
        );
        let php = "<?php\nclass Shop {\n  private Store $store;\n  public function open(Order $o): Cart { return new Cart(); }\n}\n";
        assert_eq!(
            types(Lang::Php, php),
            [
                "Field Store @3 in store",
                "Returns Cart @4 in open",
                "Param Order @4 in open",
            ]
        );
    }
}
