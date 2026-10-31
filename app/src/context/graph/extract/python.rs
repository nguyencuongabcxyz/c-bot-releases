//! Python's links: `import` and `from … import` (relative too, and `*`), calls (calling a class
//! makes one: the graph tells which), typed parameters, locals made by calling a class
//! (`s = Store()`), fields set on `self` (`self.store = Store()`, `self.store = store` from a
//! typed parameter) and annotated class attributes, and base classes.

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_definition" | "lambda" => w.open(node),
        "typed_parameter" => {
            let name = node.named_child(0).filter(|n| n.kind() == "identifier");
            if let (Some(name), Some(ty)) = (name, f("type")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "typed_default_parameter" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "assignment" => assignment(w, node),
        "call" => {
            let Some(callee) = f("function") else { return };
            match callee.kind() {
                "identifier" => w.call(node, w.text(callee), None),
                "attribute" => {
                    if let (Some(object), Some(attr)) = (
                        callee.child_by_field_name("object"),
                        callee.child_by_field_name("attribute"),
                    ) {
                        w.call(node, w.text(attr), Some(object));
                    }
                }
                _ => {}
            }
        }
        "import_statement" => {
            let mut c = node.walk();
            let names: Vec<Node> = node.children_by_field_name("name", &mut c).collect();
            for name in names {
                let (module, alias) = aliased(w, name);
                w.import(Import {
                    spec: module,
                    alias,
                    line: Walk::line(node),
                    ..Import::default()
                });
            }
        }
        "import_from_statement" => from_import(w, node),
        "class_definition" => {
            if let (Some(name), Some(bases)) = (f("name"), f("superclasses")) {
                let mut c = bases.walk();
                let sups: Vec<Node> = bases
                    .named_children(&mut c)
                    .filter(|b| matches!(b.kind(), "identifier" | "attribute"))
                    .collect();
                for sup in sups {
                    w.heritage(Heir::Extends, w.text(name), w.text(sup), node);
                }
            }
        }
        _ => {}
    }
}

/// `s = Store()`, `x: Store = …` (a local or a class attribute), `self.s = Store()`,
/// `self.s = s` (from a typed parameter).
fn assignment(w: &mut Walk, node: Node) {
    let (Some(left), right) = (
        node.child_by_field_name("left"),
        node.child_by_field_name("right"),
    ) else {
        return;
    };
    let declared = node
        .child_by_field_name("type")
        .map(|t| type_name(w.text(t)).to_string());
    let ty = declared
        .or_else(|| right.map(|r| made_type(w, r)))
        .unwrap_or_default();
    match left.kind() {
        "identifier" => {
            // (in a class's body: one of its attributes)
            let in_class = node
                .parent()
                .and_then(|p| p.parent())
                .and_then(|b| b.parent())
                .is_some_and(|c| c.kind() == "class_definition");
            if in_class {
                w.field(node, w.text(left), &ty);
            } else {
                w.bind(w.text(left), &ty);
            }
        }
        "attribute" => {
            let object = left.child_by_field_name("object");
            if let (Some(object), Some(attr)) = (object, left.child_by_field_name("attribute"))
                && w.is_this(object)
            {
                w.field(node, w.text(attr), &ty);
            }
        }
        _ => {}
    }
}

/// The type a value has as far as the syntax goes: a capitalized call (`Store()`), or a local
/// whose type is known.
fn made_type(w: &Walk, value: Node) -> String {
    match value.kind() {
        "call" => value
            .child_by_field_name("function")
            .map(|f| super::bare(w.text(f)).to_string())
            .filter(|t| t.starts_with(char::is_uppercase))
            .unwrap_or_default(),
        "identifier" => w.local(w.text(value)).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

/// A module name, and the name it's imported under (`import a.b as c`).
fn aliased(w: &Walk, node: Node) -> (String, Option<String>) {
    match node.kind() {
        "aliased_import" => (
            node.child_by_field_name("name")
                .map(|n| w.text(n).to_string())
                .unwrap_or_default(),
            node.child_by_field_name("alias")
                .map(|a| w.text(a).to_string()),
        ),
        _ => (w.text(node).to_string(), None),
    }
}

/// `from .x import a as b, c`, `from y import *`.
fn from_import(w: &mut Walk, node: Node) {
    let Some(module) = node.child_by_field_name("module_name") else {
        return;
    };
    let mut import = Import {
        spec: w.text(module).to_string(),
        line: Walk::line(node),
        ..Import::default()
    };
    let mut c = node.walk();
    import.all = node.children(&mut c).any(|n| n.kind() == "wildcard_import");
    let mut c = node.walk();
    let names: Vec<Node> = node.children_by_field_name("name", &mut c).collect();
    for name in names {
        let (name, alias) = aliased(w, name);
        let local = alias.unwrap_or_else(|| name.clone());
        import.names.push((name, local));
    }
    w.import(import);
}
