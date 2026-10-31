//! Rust's links: `use` trees (flattened, one import per module) and `mod x;`, calls (a
//! function, a method through its receiver, `Type::f`), struct literals, typed parameters and
//! `let`s (`let s: Store`, `let s = Store::new()`), struct fields, `impl Trait for Type` and
//! supertraits.

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_item" | "closure_expression" => w.open(node),
        "parameter" => {
            if let (Some(p), Some(t)) = (f("pattern"), f("type"))
                && p.kind() == "identifier"
            {
                w.bind(w.text(p), type_name(w.text(t)));
            }
        }
        "let_declaration" => let_type(w, node),
        "call_expression" => {
            if let Some(callee) = f("function") {
                call(w, node, callee);
            }
        }
        "struct_expression" => {
            if let Some(name) = f("name") {
                w.made(node, w.text(name));
            }
        }
        "use_declaration" => {
            if let Some(arg) = f("argument") {
                use_tree(w, arg, "", Walk::line(node));
            }
        }
        "mod_item" if f("body").is_none() => {
            if let Some(name) = f("name") {
                let name = w.text(name).to_string();
                w.import(Import {
                    spec: "mod".into(),
                    names: vec![(name.clone(), name)],
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "field_declaration" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.field(node, w.text(name), w.text(ty));
            }
        }
        "impl_item" => {
            if let (Some(tr), Some(ty)) = (f("trait"), f("type")) {
                w.heritage(Heir::Implements, w.text(ty), w.text(tr), node);
            }
        }
        "trait_item" => supertraits(w, node),
        _ => {}
    }
}

fn call(w: &mut Walk, node: Node, callee: Node) {
    match callee.kind() {
        "identifier" => w.call(node, w.text(callee), None),
        "field_expression" => {
            if let (Some(value), Some(field)) = (
                callee.child_by_field_name("value"),
                callee.child_by_field_name("field"),
            ) {
                w.call(node, w.text(field), Some(value));
            }
        }
        "scoped_identifier" => {
            let name = callee
                .child_by_field_name("name")
                .map(|n| w.text(n))
                .unwrap_or("");
            match callee.child_by_field_name("path") {
                Some(path) => {
                    // (Store::new, crate::store::open: the path's last part)
                    let via = super::bare(w.text(path));
                    w.reference(node, RefKind::Call, name, Via::Name(via.to_string()));
                }
                None => w.call(node, name, None),
            }
        }
        "generic_function" => {
            if let Some(inner) = callee.child_by_field_name("function") {
                call(w, node, inner);
            }
        }
        _ => {}
    }
}

/// `let s: Store = …`, `let s = Store::new()`, `let s = Store { … }`.
fn let_type(w: &mut Walk, node: Node) {
    let Some(p) = node
        .child_by_field_name("pattern")
        .filter(|p| p.kind() == "identifier")
    else {
        return;
    };
    let ty = match (
        node.child_by_field_name("type"),
        node.child_by_field_name("value"),
    ) {
        (Some(t), _) => type_name(w.text(t)).to_string(),
        (None, Some(v)) => made_type(w, v),
        _ => String::new(),
    };
    w.bind(w.text(p), &ty);
}

/// The type a value is made as: `Store::new()` (a capitalized path), `Store { … }`.
fn made_type(w: &Walk, value: Node) -> String {
    match value.kind() {
        "struct_expression" => value
            .child_by_field_name("name")
            .map(|n| super::bare(w.text(n)).to_string())
            .unwrap_or_default(),
        "call_expression" => value
            .child_by_field_name("function")
            .filter(|f| f.kind() == "scoped_identifier")
            .and_then(|f| f.child_by_field_name("path"))
            .map(|p| super::bare(w.text(p)).to_string())
            .filter(|t| t.starts_with(char::is_uppercase))
            .unwrap_or_default(),
        "try_expression" | "await_expression" => value
            .named_child(0)
            .map(|v| made_type(w, v))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// A `use` tree as imports: each leaf under the module path it's in.
fn use_tree(w: &mut Walk, node: Node, prefix: &str, line: u32) {
    let join = |a: &str, b: &str| {
        if a.is_empty() {
            b.to_string()
        } else {
            format!("{a}::{b}")
        }
    };
    let leaf = |w: &mut Walk, path: &str, alias: Option<&str>| {
        let (module, name) = path.rsplit_once("::").unwrap_or(("", path));
        let local = alias.unwrap_or(name).to_string();
        w.import(Import {
            spec: module.to_string(),
            names: vec![(name.to_string(), local)],
            line,
            ..Import::default()
        });
    };
    match node.kind() {
        "scoped_identifier" | "identifier" | "crate" | "self" | "super" => {
            leaf(w, &join(prefix, w.text(node)), None)
        }
        "use_as_clause" => {
            if let (Some(path), Some(alias)) = (
                node.child_by_field_name("path"),
                node.child_by_field_name("alias"),
            ) {
                leaf(w, &join(prefix, w.text(path)), Some(w.text(alias)));
            }
        }
        "scoped_use_list" => {
            let path = node
                .child_by_field_name("path")
                .map(|p| join(prefix, w.text(p)))
                .unwrap_or_else(|| prefix.to_string());
            if let Some(list) = node.child_by_field_name("list") {
                use_tree(w, list, &path, line);
            }
        }
        "use_list" => {
            let mut c = node.walk();
            let items: Vec<Node> = node.named_children(&mut c).collect();
            for item in items {
                use_tree(w, item, prefix, line);
            }
        }
        "use_wildcard" => {
            let path = node
                .named_child(0)
                .map(|p| join(prefix, w.text(p)))
                .unwrap_or_else(|| prefix.to_string());
            w.import(Import {
                spec: path,
                all: true,
                line,
                ..Import::default()
            });
        }
        _ => {}
    }
}

/// `trait T: A + B`: T extends A and B.
fn supertraits(w: &mut Walk, node: Node) {
    let (Some(name), Some(bounds)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("bounds"),
    ) else {
        return;
    };
    let mut c = bounds.walk();
    let sups: Vec<Node> = bounds
        .named_children(&mut c)
        .filter(|b| b.kind().ends_with("type_identifier"))
        .collect();
    for sup in sups {
        w.heritage(Heir::Extends, w.text(name), w.text(sup), node);
    }
}
