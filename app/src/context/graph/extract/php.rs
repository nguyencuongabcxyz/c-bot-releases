//! PHP's links: `use` (a class or a function of a namespace, a group of them, a namespace under
//! a name), `require` and `include` (a file of the folder), calls (a function; a method
//! through `$this`, a field, a typed parameter or local; `self::`, `static::`, `parent::`, a
//! class's static `Store::make()`), `new Store()`, typed properties (promoted constructor
//! parameters too) and parameters, what a method returns, and heritage (`extends`,
//! `implements`, a trait's `use`).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "method_declaration" | "function_definition" => {
            w.open(node);
            if let (Some(name), Some(ty)) = (f("name"), f("return_type")) {
                w.returns(node, w.text(name), w.text(ty));
            }
        }
        "anonymous_function" | "arrow_function" => w.open(node),
        "simple_parameter" | "property_promotion_parameter" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                let name = variable(w, name);
                w.bind(name, type_name(w.text(ty)));
                if node.kind() == "property_promotion_parameter" {
                    w.field(node, name, w.text(ty));
                }
            }
        }
        "property_declaration" => {
            let Some(ty) = f("type") else {
                return;
            };
            let mut c = node.walk();
            for element in node
                .named_children(&mut c)
                .filter(|n| n.kind() == "property_element")
            {
                if let Some(name) = element.child_by_field_name("name") {
                    w.field(node, variable(w, name), w.text(ty));
                }
            }
        }
        "assignment_expression" => {
            if let (Some(left), Some(right)) = (f("left"), f("right"))
                && left.kind() == "variable_name"
                && let Some(ty) = w.type_of(right)
            {
                w.bind(variable(w, left), &ty);
            }
        }
        "member_call_expression" | "nullsafe_member_call_expression" => {
            if let (Some(object), Some(name)) = (f("object"), f("name")) {
                w.call(name, w.text(name), Some(object));
            }
        }
        "scoped_call_expression" => scoped(w, node),
        "function_call_expression" => {
            if let Some(function) = f("function")
                && matches!(function.kind(), "name" | "qualified_name")
            {
                let name = w.text(function).rsplit('\\').next().unwrap_or("");
                w.call(node, name, None);
            }
        }
        "object_creation_expression" => {
            if let Some(ty) = created(w, node) {
                w.made(node, ty);
            }
        }
        "namespace_use_declaration" => uses(w, node),
        "require_expression"
        | "require_once_expression"
        | "include_expression"
        | "include_once_expression" => required(w, node),
        "class_declaration" | "interface_declaration" => heritage(w, node),
        "use_declaration" => {
            // (a trait used in a class: its methods are the class's, as a supertype's are)
            if let Some(class) = w.holder(Walk::line(node)) {
                let mut c = node.walk();
                for t in node.named_children(&mut c).filter(|n| n.kind() == "name") {
                    w.heritage(Heir::Extends, class, w.text(t), node);
                }
            }
        }
        _ => {}
    }
}

/// A variable's name without its `$`.
fn variable<'a>(w: &Walk<'a>, node: Node) -> &'a str {
    w.text(node).trim_start_matches('$')
}

/// The class `new X()` makes.
pub(super) fn created<'a>(w: &Walk<'a>, node: Node) -> Option<&'a str> {
    let mut c = node.walk();
    let ty = node
        .named_children(&mut c)
        .find(|n| matches!(n.kind(), "name" | "qualified_name"))?;
    Some(w.text(ty).rsplit('\\').next().unwrap_or(""))
}

/// `self::f()`, `static::f()` (the class it's in), `parent::f()` (its parent), `Store::f()`.
fn scoped(w: &mut Walk, node: Node) {
    let (Some(scope), Some(name)) = (
        node.child_by_field_name("scope"),
        node.child_by_field_name("name"),
    ) else {
        return;
    };
    let via = match w.text(scope) {
        "self" | "static" => Via::This,
        "parent" => Via::Super,
        class => Via::Name(class.rsplit('\\').next().unwrap_or("").to_string()),
    };
    w.reference(name, RefKind::Call, w.text(name), via);
}

/// `use App\Models\Store;`, `use App\Services\{Mailer, Cache as C};`, `use App\Models;` (the
/// namespace under its last name), `use function App\fmt;`.
fn uses(w: &mut Walk, node: Node) {
    let line = Walk::line(node);
    let mut c = node.walk();
    let kids: Vec<Node> = node.named_children(&mut c).collect();
    let group = node.child_by_field_name("body");
    let prefix = kids
        .iter()
        .find(|n| n.kind() == "namespace_name")
        .map(|n| w.text(*n).trim_start_matches('\\').to_string());
    let clauses: Vec<Node> = match group {
        Some(g) => {
            let mut c = g.walk();
            g.named_children(&mut c)
                .filter(|n| n.kind() == "namespace_use_clause")
                .collect()
        }
        None => kids
            .into_iter()
            .filter(|n| n.kind() == "namespace_use_clause")
            .collect(),
    };
    for clause in clauses {
        let mut c = clause.walk();
        let path = clause
            .named_children(&mut c)
            .find(|n| matches!(n.kind(), "qualified_name" | "name"))
            .map(|n| w.text(n).trim_start_matches('\\'));
        let Some(path) = path else {
            continue;
        };
        let full = match &prefix {
            Some(p) => format!("{p}\\{path}"),
            None => path.to_string(),
        };
        let (space, name) = full.rsplit_once('\\').unwrap_or(("", full.as_str()));
        let local = clause
            .child_by_field_name("alias")
            .map_or(name, |a| w.text(a));
        w.import(Import {
            spec: space.to_string(),
            names: vec![(name.to_string(), local.to_string())],
            line,
            ..Import::default()
        });
    }
}

/// `require __DIR__ . '/helpers.php';`, `include 'x.php';`: a file, from the one it's in.
fn required(w: &mut Walk, node: Node) {
    let mut strings = vec![];
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.kind() == "string_content" {
            strings.push(n);
        }
        let mut c = n.walk();
        stack.extend(n.named_children(&mut c));
    }
    let Some(last) = strings.into_iter().max_by_key(Node::start_byte) else {
        return;
    };
    let path = w.text(last);
    w.import(Import {
        spec: format!("./{}", path.trim_start_matches(['/', '\\'])),
        all: true,
        line: Walk::line(node),
        ..Import::default()
    });
}

/// `class K extends B implements I, J`, `interface I extends J, K`.
fn heritage(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let sub = w.text(name).to_string();
    let mut c = node.walk();
    let clauses: Vec<Node> = node.named_children(&mut c).collect();
    for clause in clauses {
        let kind = match clause.kind() {
            "base_clause" => Heir::Extends,
            "class_interface_clause" => Heir::Implements,
            _ => continue,
        };
        let mut c = clause.walk();
        for sup in clause
            .named_children(&mut c)
            .filter(|n| matches!(n.kind(), "name" | "qualified_name"))
        {
            let sup = w.text(sup).rsplit('\\').next().unwrap_or("");
            w.heritage(kind, &sub, sup, node);
        }
    }
}
