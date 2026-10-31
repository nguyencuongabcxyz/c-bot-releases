//! C and C++'s links: `#include` (a file of the folder, or a library's), calls (bare, through
//! `this`, a field, a typed parameter or local, `a.b()` and `a->b()`, a namespace's or a
//! class's `ns::f()`), `new T`, typed parameters and locals (`auto s` too, from `new Store`
//! or `std::make_unique<Store>()`), fields, base classes (each extended), and a member function
//! defined outside its class (`void Store::open() {}`), which belongs to Store.

use super::*;

/// The functions that make a value of their type argument.
const MAKERS: &[&str] = &["make_unique", "make_shared"];

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_definition" => {
            w.open(node);
            returns(w, node);
            // (`Store::open() {}`: a method of Store, and calls through `this` go to it)
            let scope = f("declarator")
                .and_then(qualified)
                .and_then(|q| w.text(q).rsplit_once("::"))
                .map(|(scope, _)| scope);
            if let Some(scope) = scope {
                // (its whole path, `Logger::Scope` for `Logger::Scope::note`, without template
                // arguments: the graph finds a nested class through the one holding it)
                let ty: String = scope
                    .split("::")
                    .map(|p| p.split('<').next().unwrap_or("").trim())
                    .collect::<Vec<_>>()
                    .join("::");
                w.out.receivers.push(Receiver {
                    line: Walk::line(node),
                    ty,
                });
            }
        }
        "lambda_expression" => w.open(node),
        // (what a function returns, for a call on what it gives back: `setup().ok()`)
        "declaration" => {
            returns(w, node);
            locals(w, node);
        }
        "parameter_declaration" | "optional_parameter_declaration" => {
            if let (Some(ty), Some(name)) = (f("type"), f("declarator").and_then(name_of)) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "field_declaration" => {
            returns(w, node);
            let ty = f("type").map_or("", |t| w.text(t));
            let mut c = node.walk();
            let declarators: Vec<Node> =
                node.children_by_field_name("declarator", &mut c).collect();
            for d in declarators
                .into_iter()
                .filter(|d| d.kind() != "function_declarator")
            {
                if let Some(name) = name_of(d) {
                    w.field(node, w.text(name), ty);
                }
            }
        }
        "call_expression" => call(w, node),
        "new_expression" => {
            if let Some(ty) = f("type") {
                w.made(node, type_name(w.text(ty)));
                w.given(arguments(node));
            }
        }
        "preproc_include" => {
            if let Some(path) = f("path") {
                let spec = w.text(path).trim_matches('"').to_string();
                w.import(Import {
                    spec,
                    all: true,
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "class_specifier" | "struct_specifier" => bases(w, node),
        _ => {}
    }
}

/// What a function or member function declared or defined here returns (one defined outside
/// its class, `Store::open`, says it where it's declared).
fn returns(w: &mut Walk, node: Node) {
    let (Some(ty), Some(declarator)) = (
        node.child_by_field_name("type"),
        node.child_by_field_name("declarator"),
    ) else {
        return;
    };
    let Some(function) = function_declarator(declarator) else {
        return;
    };
    let Some(name) = function.child_by_field_name("declarator") else {
        return;
    };
    if matches!(name.kind(), "identifier" | "field_identifier") {
        w.returns(node, w.text(name), w.text(ty));
    }
}

/// The function declarator in a declarator, through `*` and `&` (a function returning a
/// pointer or a reference).
fn function_declarator(mut d: Node) -> Option<Node> {
    loop {
        match d.kind() {
            "function_declarator" => return Some(d),
            "pointer_declarator" | "reference_declarator" => {
                d = d
                    .child_by_field_name("declarator")
                    .or_else(|| d.named_children(&mut d.walk()).last())?;
            }
            _ => return None,
        }
    }
}

/// The type a call gives back, as a path the graph follows: `make()` (a function's), or
/// `Store#open()` (a member function's, through a value of type Store or the class itself).
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        "identifier" if w.local(w.text(callee)).is_none() => Some(format!("{}()", w.text(callee))),
        "field_expression" => {
            let of = w.type_of(callee.child_by_field_name("argument")?)?;
            Some(format!(
                "{of}#{}()",
                w.text(callee.child_by_field_name("field")?)
            ))
        }
        "qualified_identifier" => {
            let scope = callee.child_by_field_name("scope")?;
            let name = callee.child_by_field_name("name")?;
            Some(format!("{}#{}()", type_name(w.text(scope)), w.text(name)))
        }
        _ => None,
    }
}

/// A call, by what it calls: a name, `a.b` / `a->b`, `ns::f` / `Store::make`, `f<T>`.
fn call(w: &mut Walk, node: Node) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    let callee = match callee.kind() {
        "template_function" => callee.child_by_field_name("name").unwrap_or(callee),
        _ => callee,
    };
    match callee.kind() {
        "identifier" => w.call(node, w.text(callee), None),
        "field_expression" => {
            let (Some(object), Some(field)) = (
                callee.child_by_field_name("argument"),
                callee.child_by_field_name("field"),
            ) else {
                return;
            };
            w.call(node, w.text(field), Some(object));
        }
        "qualified_identifier" => {
            let (Some(scope), Some(name)) = (
                callee.child_by_field_name("scope"),
                callee.child_by_field_name("name"),
            ) else {
                return;
            };
            let name = match name.kind() {
                "template_function" => name.child_by_field_name("name").unwrap_or(name),
                _ => name,
            };
            w.call(node, w.text(name), Some(scope));
        }
        _ => return,
    }
    w.given(arguments(node));
}

fn arguments(node: Node) -> usize {
    node.child_by_field_name("arguments")
        .map_or(0, |a| a.named_child_count())
}

/// The qualified name a function's declarator declares (`Store::open`), if it is one.
fn qualified(mut d: Node) -> Option<Node> {
    loop {
        match d.kind() {
            "qualified_identifier" => return Some(d),
            "function_declarator" | "pointer_declarator" | "reference_declarator" => {
                d = d
                    .child_by_field_name("declarator")
                    .or_else(|| d.named_children(&mut d.walk()).last())?;
            }
            _ => return None,
        }
    }
}

/// The identifier a declarator names, through `*`, `&`, `[]` and an initialiser.
fn name_of(mut d: Node) -> Option<Node> {
    loop {
        match d.kind() {
            "identifier" | "field_identifier" => return Some(d),
            "pointer_declarator"
            | "reference_declarator"
            | "array_declarator"
            | "init_declarator"
            | "parenthesized_declarator" => {
                d = d
                    .child_by_field_name("declarator")
                    .or_else(|| d.named_children(&mut d.walk()).last())?;
            }
            _ => return None,
        }
    }
}

/// `Store s;`, `Store* s = new Store();`, `auto s = std::make_unique<Store>();`.
fn locals(w: &mut Walk, node: Node) {
    let declared = node.child_by_field_name("type").map_or("", |t| w.text(t));
    let mut c = node.walk();
    let declarators: Vec<Node> = node.children_by_field_name("declarator", &mut c).collect();
    for d in declarators {
        let Some(name) = name_of(d) else {
            continue;
        };
        let ty = if declared == "auto" {
            d.child_by_field_name("value")
                .map_or(String::new(), |v| made(w, v))
        } else {
            type_name(declared).to_string()
        };
        w.bind(w.text(name), &ty);
    }
}

/// The type a value is made of: `new Store(…)`, `Store(…)`, `std::make_unique<Store>(…)`.
fn made(w: &Walk, value: Node) -> String {
    match value.kind() {
        "new_expression" => value
            .child_by_field_name("type")
            .map_or(String::new(), |t| type_name(w.text(t)).to_string()),
        "call_expression" => {
            let Some(callee) = value.child_by_field_name("function") else {
                return String::new();
            };
            let text = w.text(callee);
            let maker = MAKERS.iter().any(|m| super::bare(text) == *m);
            if maker {
                // (the template argument: make_unique<Store>)
                let args = text
                    .split_once('<')
                    .map_or("", |(_, a)| a.trim_end_matches('>'));
                return type_name(args).to_string();
            }
            let name = super::bare(text);
            if name.starts_with(char::is_uppercase) {
                name.to_string()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// `class K : public Base, private Mixin`: K extends each.
fn bases(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let mut c = node.walk();
    let Some(clause) = node
        .named_children(&mut c)
        .find(|n| n.kind() == "base_class_clause")
    else {
        return;
    };
    let mut c = clause.walk();
    let bases: Vec<Node> = clause
        .named_children(&mut c)
        .filter(|b| {
            matches!(
                b.kind(),
                "type_identifier" | "qualified_identifier" | "template_type"
            )
        })
        .collect();
    for base in bases {
        let sup = type_name(w.text(base)).to_string();
        w.heritage(Heir::Extends, w.text(name), &sup, node);
    }
}
