//! Ruby's links: `require` and `require_relative`, calls (a method said alone, `helper` or
//! `helper(1)`, which may be the class's own: Ruby's `self` goes unsaid; through `self`, an
//! instance variable, a local, a class: `Store.make`; `super`), constructions (`Store.new`),
//! what an instance variable holds (`@store = Store.new`) and a local, and heritage (`<` a
//! superclass, `include` and `extend` a module).

use super::*;

/// Where a name said alone is a call (of a method of no arguments) unless it's a local.
const STATEMENTS: &[&str] = &[
    "body_statement",
    "block_body",
    "then",
    "else",
    "begin",
    "ensure",
    "do",
    "program",
];

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "method" | "singleton_method" => {
            w.open(node);
            let mut c = node.walk();
            let params = f("parameters").map_or_else(Vec::new, |p| {
                p.named_children(&mut c)
                    .filter(|n| n.kind() == "identifier")
                    .collect::<Vec<_>>()
            });
            // (a parameter is a local: said alone, it's no call)
            for p in params {
                w.bind(w.text(p), UNTYPED);
            }
        }
        "block" | "do_block" | "lambda" => w.open(node),
        "assignment" => assignment(w, node),
        "call" => call(w, node),
        "identifier" => {
            let alone = node
                .parent()
                .is_some_and(|p| STATEMENTS.contains(&p.kind()));
            if alone && w.local(w.text(node)).is_none() {
                w.call(node, w.text(node), None);
            }
        }
        "super" => {
            // (a call of the method it's in, in the superclass)
            let line = Walk::line(node);
            if let Some(method) = w.within(line).map(|i| w.defs[i as usize].name.clone()) {
                w.reference(node, RefKind::Call, &method, Via::Super);
            }
        }
        "class" => {
            let (Some(name), Some(sup)) = (f("name"), f("superclass")) else {
                return;
            };
            if let Some(sup) = sup.named_child(0) {
                w.heritage(Heir::Extends, w.text(name), w.text(sup), node);
            }
        }
        _ => {}
    }
}

/// The type a call gives: what `Store.new` makes.
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let receiver = node.child_by_field_name("receiver")?;
    let method = node.child_by_field_name("method")?;
    (w.text(method) == "new" && matches!(receiver.kind(), "constant" | "scope_resolution"))
        .then(|| w.text(receiver).to_string())
}

/// `store = Store.new` (a local of that type); `@store = Store.new` (an instance variable of
/// the class it's in).
fn assignment(w: &mut Walk, node: Node) {
    let (Some(left), Some(right)) = (
        node.child_by_field_name("left"),
        node.child_by_field_name("right"),
    ) else {
        return;
    };
    let ty = w.type_of(right).unwrap_or_else(|| UNTYPED.into());
    match left.kind() {
        "identifier" => w.bind(w.text(left), &ty),
        "instance_variable" if ty != UNTYPED => {
            w.field(node, w.text(left).trim_start_matches('@'), &ty);
        }
        _ => {}
    }
}

fn call(w: &mut Walk, node: Node) {
    let Some(method) = node.child_by_field_name("method") else {
        return;
    };
    let name = w.text(method);
    match node.child_by_field_name("receiver") {
        None => match name {
            "require" | "require_relative" | "load" => required(w, node, name),
            "include" | "extend" | "prepend" => mixin(w, node),
            _ => w.call(method, name, None),
        },
        Some(receiver) if name == "new" => {
            if matches!(receiver.kind(), "constant" | "scope_resolution") {
                w.made(node, w.text(receiver));
            }
        }
        Some(receiver) => w.call(method, name, Some(receiver)),
    }
}

/// `require 'json'`, `require_relative 'models/store'` (a file from the one it's in).
fn required(w: &mut Walk, node: Node, how: &str) {
    let arg = node
        .child_by_field_name("arguments")
        .and_then(|a| a.named_child(0))
        .filter(|a| a.kind() == "string");
    let Some(arg) = arg else {
        return;
    };
    let path = w.text(arg).trim_matches(['\'', '"']);
    let spec = if how == "require_relative" && !path.starts_with('.') {
        format!("./{path}")
    } else {
        path.to_string()
    };
    w.import(Import {
        spec,
        all: true,
        line: Walk::line(node),
        ..Import::default()
    });
}

/// `include Logs`, `extend Helpers`: the module's methods are the class's.
fn mixin(w: &mut Walk, node: Node) {
    let Some(class) = w.holder(Walk::line(node)) else {
        return;
    };
    let Some(args) = node.child_by_field_name("arguments") else {
        return;
    };
    let mut c = args.walk();
    for m in args
        .named_children(&mut c)
        .filter(|n| matches!(n.kind(), "constant" | "scope_resolution"))
    {
        w.heritage(Heir::Extends, class, w.text(m), node);
    }
}
