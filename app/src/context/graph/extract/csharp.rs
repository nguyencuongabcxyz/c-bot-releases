//! C#'s links: `using` directives (a whole namespace), calls (bare, through `this`, a field, a
//! typed parameter or local, a type or a namespace; `a?.B()` and `a!.B()` too) with how many
//! arguments they're given (an overload is picked by that), `new T()`, typed parameters and
//! locals (`var s` too, from `new Store()`, a cast, `as Store`, or a DI container's
//! `GetRequiredService<Store>()`), fields and properties, and the base list (a class's first base
//! is what it extends, unless it's named like an interface, IThing; the rest it implements).

use super::*;

/// The generic methods that give back their type argument (DI containers').
const RESOLVERS: &[&str] = &["GetService", "GetRequiredService", "Resolve", "GetInstance"];

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "method_declaration" | "local_function_statement" => {
            w.open(node);
            if let (Some(name), Some(ty)) = (f("name"), f("returns").or_else(|| f("type"))) {
                w.returns(node, w.text(name), w.text(ty));
            }
        }
        "constructor_declaration" | "lambda_expression" => w.open(node),
        "parameter" => {
            if let (Some(ty), Some(name)) = (f("type"), f("name")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "variable_declaration" => variables(w, node),
        // (`x is Store s`)
        "declaration_pattern" => {
            if let (Some(ty), Some(name)) = (f("type"), f("name").or_else(|| f("designation"))) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "property_declaration" => {
            if let (Some(ty), Some(name)) = (f("type"), f("name")) {
                w.field(node, w.text(name), w.text(ty));
            }
        }
        "invocation_expression" => invocation(w, node),
        "object_creation_expression" => {
            if let Some(ty) = f("type") {
                w.made(node, type_name(w.text(ty)));
                w.given(arguments(node));
            }
        }
        // (`using OrderHelper = Shop.Data.OrderHelper;`: that type under this name)
        "using_directive" if w.text(node).contains('=') => {
            let text = w.text(node).trim_start_matches("global").trim();
            let text = text.trim_start_matches("using").trim_end_matches(';');
            let Some((alias, target)) = text.split_once('=') else {
                return;
            };
            let (alias, target) = (alias.trim(), target.trim());
            let target = target.split('<').next().unwrap_or(target);
            if let Some((space, name)) = target.rsplit_once('.') {
                w.import(Import {
                    spec: space.to_string(),
                    names: vec![(name.to_string(), alias.to_string())],
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "using_directive" => {
            let mut c = node.walk();
            let name = node
                .named_children(&mut c)
                .find(|n| matches!(n.kind(), "qualified_name" | "identifier"));
            if let Some(name) = name {
                w.import(Import {
                    spec: w.text(name).to_string(),
                    all: true,
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "class_declaration"
        | "struct_declaration"
        | "interface_declaration"
        | "record_declaration" => bases(w, node),
        _ => {}
    }
}

/// A call, by what it's called through: a name, a generic one (`Make<T>()`), a member access
/// (`a.B()`), or a conditional one (`a?.B()`).
fn invocation(w: &mut Walk, node: Node) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    match callee.kind() {
        "identifier" | "generic_name" => w.call(node, w.text(named(callee)), None),
        "member_access_expression" => {
            let (Some(object), Some(name)) = (object(callee), callee.child_by_field_name("name"))
            else {
                return;
            };
            w.call(name, w.text(named(name)), Some(object));
        }
        "conditional_access_expression" => {
            // (`a?.B()`: B through a; `a?.b.C()`: C through a's b)
            let mut c = callee.walk();
            let Some(after) = callee
                .named_children(&mut c)
                .filter(|n| Some(n.id()) != callee.child_by_field_name("condition").map(|x| x.id()))
                .last()
            else {
                return;
            };
            let (object, name) = match after.kind() {
                "member_binding_expression" => (
                    callee.child_by_field_name("condition"),
                    after.child_by_field_name("name"),
                ),
                "member_access_expression" => (object(after), after.child_by_field_name("name")),
                _ => return,
            };
            let (Some(object), Some(name)) = (object, name) else {
                return;
            };
            w.call(name, w.text(named(name)), Some(object));
        }
        _ => return,
    }
    w.given(arguments(node));
}

/// A name as it's called: `B<T>` is B.
fn named(n: Node) -> Node {
    n.named_child(0)
        .filter(|_| n.kind() == "generic_name")
        .unwrap_or(n)
}

/// How many arguments a call or `new` is given.
fn arguments(node: Node) -> usize {
    node.child_by_field_name("arguments").map_or(0, |list| {
        let mut c = list.walk();
        list.named_children(&mut c)
            .filter(|a| a.kind() == "argument")
            .count()
    })
}

/// A member access's object: its `expression`, or the `this` or `base` it starts from.
pub(super) fn object(node: Node) -> Option<Node> {
    node.child_by_field_name("expression").or_else(|| {
        let mut c = node.walk();
        node.children(&mut c)
            .find(|n| matches!(n.kind(), "this" | "base"))
    })
}

/// The type a `var` is given by what it's set to: `new Store()`, `(Store)x`, `x as Store`, or a
/// DI container's `GetRequiredService<Store>()`.
fn inferred<'a>(w: &Walk<'a>, value: Node) -> &'a str {
    let text = |n: Option<Node>| n.map_or("", |n| w.text(n));
    match value.kind() {
        "object_creation_expression" | "cast_expression" => text(value.child_by_field_name("type")),
        "as_expression" => text(value.child_by_field_name("right")),
        "invocation_expression" => resolved(w, value).unwrap_or(""),
        "await_expression" | "parenthesized_expression" => {
            value.named_child(0).map_or("", |v| inferred(w, v))
        }
        _ => "",
    }
}

/// What a DI container's `GetRequiredService<Store>()`, `Resolve<IAuth>()` gives: its type
/// argument.
fn resolved<'a>(w: &Walk<'a>, call: Node) -> Option<&'a str> {
    let name = call
        .child_by_field_name("function")
        .and_then(|f| match f.kind() {
            "member_access_expression" => f.child_by_field_name("name"),
            _ => Some(f),
        })
        .filter(|n| n.kind() == "generic_name")?;
    if !name
        .named_child(0)
        .is_some_and(|n| RESOLVERS.contains(&w.text(n)))
    {
        return None;
    }
    match name
        .named_child(1)
        .map(|a| (a.named_child_count(), a.named_child(0)))
    {
        Some((1, Some(ty))) => Some(w.text(ty)),
        _ => None,
    }
}

/// The type a call gives: a DI container's `Resolve<IAuth>()` its type argument; else what the
/// method returns (a method of the type it's in, `Find()`; through a value, `repo.Find()`; a
/// static one, `Store.Make()`), as a path the graph follows.
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    if let Some(ty) = resolved(w, node) {
        return Some(type_name(ty).to_string()).filter(|t| !t.is_empty());
    }
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        "identifier" | "generic_name" => Some(format!("{THIS_FIELD}{}()", w.text(named(callee)))),
        "member_access_expression" => {
            let object = object(callee)?;
            let method = w.text(named(callee.child_by_field_name("name")?));
            let of = match w.type_of(object) {
                Some(t) => t,
                None if object.kind() == "identifier" => w.text(object).to_string(),
                None => return None,
            };
            Some(format!("{of}#{method}()"))
        }
        _ => None,
    }
}

/// `Store s = …;`, `var s = new Store();`: locals in a method, fields in a type.
fn variables(w: &mut Walk, node: Node) {
    let declared = node
        .child_by_field_name("type")
        .map(|t| w.text(t))
        .unwrap_or("");
    let field = node
        .parent()
        .is_some_and(|p| p.kind() == "field_declaration");
    let mut c = node.walk();
    let declarators: Vec<Node> = node
        .named_children(&mut c)
        .filter(|n| n.kind() == "variable_declarator")
        .collect();
    for d in declarators {
        let Some(name) = d.child_by_field_name("name") else {
            continue;
        };
        let ty = if declared == "var" {
            let mut c = d.walk();
            let value = d.named_children(&mut c).find(|n| n.id() != name.id());
            // (`var s = repo.Find()`: what Find returns, when nothing simpler says)
            value.map_or(String::new(), |v| match type_name(inferred(w, v)) {
                "" => w.type_of(v).unwrap_or_default(),
                t => t.to_string(),
            })
        } else {
            type_name(declared).to_string()
        };
        if field {
            w.field(node, w.text(name), &ty);
        } else {
            w.bind(w.text(name), &ty);
        }
    }
}

/// `class K : Base, IThing`: K extends Base and implements IThing.
fn bases(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let mut c = node.walk();
    let Some(list) = node
        .named_children(&mut c)
        .find(|n| n.kind() == "base_list")
    else {
        return;
    };
    let class = node.kind() == "class_declaration" || node.kind() == "record_declaration";
    let mut c = list.walk();
    let bases: Vec<Node> = list.named_children(&mut c).collect();
    for (i, base) in bases.into_iter().enumerate() {
        let sup = type_name(w.text(base)).to_string();
        let interface_like =
            sup.len() > 1 && sup.starts_with('I') && sup[1..].starts_with(char::is_uppercase);
        // (an interface's bases are interfaces it extends)
        let kind = if node.kind() == "interface_declaration" || (class && i == 0 && !interface_like)
        {
            Heir::Extends
        } else {
            Heir::Implements
        };
        w.heritage(kind, w.text(name), &sup, node);
    }
}
