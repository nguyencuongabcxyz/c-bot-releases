//! Zig's links: what a file imports (`const std = @import("std")`: the module under a name;
//! `const Store = @import("store.zig").Store`: a name it has), calls (a function, a method
//! through a typed value: `self.store.open()`, `s.open()`; a type's or a module's function:
//! `Store.init()`, `utils.trim()`), constructions (`Store{ … }`), typed parameters and locals
//! (`self: *Order`, `const s: Store`, `var o = try Order.init()`), a struct's fields, and what
//! a function returns (`!Order` is Order).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_declaration" => {
            w.open(node);
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.returns(node, w.text(name), returned_type(w, ty));
            }
        }
        "parameter" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "variable_declaration" => variable(w, node),
        "container_field" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.field(node, w.text(name), w.text(ty));
            }
        }
        "call_expression" => call(w, node),
        "struct_initializer" => {
            let mut c = node.walk();
            let ty = node
                .named_children(&mut c)
                .find(|n| matches!(n.kind(), "identifier" | "field_expression"));
            if let Some(ty) = ty {
                w.made(node, w.text(ty));
            }
        }
        _ => {}
    }
}

/// A declared return type, as calls through what it returns go: `!Order` (an error union) is
/// Order.
fn returned_type<'a>(w: &Walk<'a>, ty: Node) -> &'a str {
    match ty.kind() {
        "error_union_type" => ty
            .child_by_field_name("ok")
            .map_or("", |ok| type_name(w.text(ok))),
        _ => type_name(w.text(ty)),
    }
}

/// The type a call gives: what the function returns (`build()`), or the method
/// (`Store.init()`, `s.open()`).
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        "identifier" if w.local(w.text(callee)).is_none() => Some(format!("{}()", w.text(callee))),
        "field_expression" => {
            let object = callee.child_by_field_name("object")?;
            let method = w.text(callee.child_by_field_name("member")?);
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

/// `const s: Store = …`, `var o = try Order.init()`; at the top of a file, an import.
fn variable(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let kids: Vec<Node> = node.named_children(&mut c).collect();
    let Some(name) = kids.iter().find(|n| n.kind() == "identifier") else {
        return;
    };
    let declared = node.child_by_field_name("type");
    let value = kids
        .iter()
        .rev()
        .find(|n| Some(n.id()) != declared.map(|d| d.id()) && n.id() != name.id());
    if let Some(value) = value
        && let Some(spec) = crate::context::parse::zig_import(*value, w.src)
    {
        // (`@import("x.zig")` alone: the module under this name; `.Store` after it: that name)
        let mut import = Import {
            spec: spec.to_string(),
            line: Walk::line(node),
            ..Import::default()
        };
        match value.child_by_field_name("member") {
            Some(m) if value.kind() == "field_expression" => import
                .names
                .push((w.text(m).to_string(), w.text(*name).to_string())),
            _ => import.alias = Some(w.text(*name).to_string()),
        }
        w.import(import);
        return;
    }
    let ty = match (declared, value) {
        (Some(t), _) => type_name(w.text(t)).to_string(),
        (None, Some(v)) => w.type_of(*v).unwrap_or_default(),
        _ => String::new(),
    };
    w.bind(w.text(*name), &ty);
}

fn call(w: &mut Walk, node: Node) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    match callee.kind() {
        "identifier" => w.call(node, w.text(callee), None),
        "field_expression" => {
            let (Some(object), Some(member)) = (
                callee.child_by_field_name("object"),
                callee.child_by_field_name("member"),
            ) else {
                return;
            };
            w.call(member, w.text(member), Some(object));
        }
        _ => {}
    }
}
