//! Go's links: imports (with their names), calls (a function, a method through its receiver, a
//! package's function), composite literals (`Store{}`, `&Store{}`), typed parameters and
//! locals, a method's receiver (calls through it are `this`), struct fields, and embedded
//! types (what a struct or interface embeds, it extends).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_declaration" | "func_literal" => w.open(node),
        "method_declaration" => {
            w.open(node);
            // (the receiver: calls through it go to the method's own type, which it belongs to)
            let param = f("receiver").and_then(|r| r.named_child(0));
            if let Some(r) = param.and_then(|p| p.child_by_field_name("name")) {
                w.bind(w.text(r), THIS);
            }
            if let Some(ty) = param.and_then(|p| p.child_by_field_name("type")) {
                let ty = type_name(w.text(ty)).to_string();
                w.out.receivers.push(Receiver {
                    line: Walk::line(node),
                    ty,
                });
            }
        }
        "parameter_declaration" if !receiver(node) => {
            if let Some(ty) = f("type") {
                let ty = type_name(w.text(ty)).to_string();
                let mut c = node.walk();
                let names: Vec<Node> = node.children_by_field_name("name", &mut c).collect();
                for name in names {
                    w.bind(w.text(name), &ty);
                }
            }
        }
        "short_var_declaration" => short_var(w, node),
        "var_spec" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "call_expression" => {
            let Some(callee) = f("function") else { return };
            match callee.kind() {
                "identifier" => w.call(node, w.text(callee), None),
                "selector_expression" => {
                    if let (Some(operand), Some(field)) = (
                        callee.child_by_field_name("operand"),
                        callee.child_by_field_name("field"),
                    ) {
                        w.call(node, w.text(field), Some(operand));
                    }
                }
                _ => {}
            }
        }
        "composite_literal" => {
            if let Some(ty) =
                f("type").filter(|t| matches!(t.kind(), "type_identifier" | "qualified_type"))
            {
                w.made(node, w.text(ty));
            }
        }
        "import_spec" => {
            if let Some(path) = f("path") {
                let spec = w.text(path).trim_matches('"').to_string();
                let alias = f("name").map(|n| w.text(n).to_string());
                w.import(Import {
                    spec,
                    alias,
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "field_declaration" => field(w, node),
        _ => {}
    }
}

/// A method's receiver (bound as `this` already, not by its type).
fn receiver(param: Node) -> bool {
    param
        .parent()
        .and_then(|list| {
            list.parent()
                .map(|m| m.child_by_field_name("receiver") == Some(list))
        })
        .unwrap_or(false)
}

/// `s := Store{}`, `s := &Store{}`, `s := NewStore()`.
fn short_var(w: &mut Walk, node: Node) {
    let (Some(left), Some(right)) = (
        node.child_by_field_name("left"),
        node.child_by_field_name("right"),
    ) else {
        return;
    };
    let (Some(name), Some(value)) = (left.named_child(0), right.named_child(0)) else {
        return;
    };
    let value = if value.kind() == "unary_expression" {
        value.child_by_field_name("operand").unwrap_or(value)
    } else {
        value
    };
    let ty = match value.kind() {
        "composite_literal" => value
            .child_by_field_name("type")
            .map(|t| type_name(w.text(t)).to_string()),
        "call_expression" => value
            .child_by_field_name("function")
            .map(|f| super::bare(w.text(f)))
            .and_then(|f| f.strip_prefix("New"))
            .filter(|t| t.starts_with(char::is_uppercase))
            .map(str::to_string),
        _ => None,
    };
    if let Some(ty) = ty {
        w.bind(w.text(name), &ty);
    }
}

/// A struct's field (`db *DB`), or a type it embeds (`Base`): that it extends.
fn field(w: &mut Walk, node: Node) {
    let Some(ty) = node.child_by_field_name("type") else {
        return;
    };
    let mut c = node.walk();
    let names: Vec<Node> = node.children_by_field_name("name", &mut c).collect();
    if names.is_empty() {
        if let Some(holder) = w.holder(Walk::line(node)) {
            let holder = holder.to_string();
            w.heritage(Heir::Extends, &holder, type_name(w.text(ty)), node);
        }
        return;
    }
    for name in names {
        w.field(node, w.text(name), w.text(ty));
    }
}
