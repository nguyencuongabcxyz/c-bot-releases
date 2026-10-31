//! Java's links: imports (a class, a package's every class, a static member's class), calls
//! (bare, through `this` or `super`, a field, a typed parameter or local, a class) with how many
//! arguments they're given, `new T()`, typed parameters and locals (`var s` too, from
//! `new Store()` or a cast), fields, and what a class extends and implements (an interface's
//! `extends`, it extends).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "method_declaration" => {
            w.open(node);
            // (what it returns, for a call on what it gives back: `find(id).total()`)
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.returns(node, w.text(name), w.text(ty));
            }
        }
        "constructor_declaration" | "lambda_expression" => w.open(node),
        "formal_parameter" | "catch_formal_parameter" => {
            if let (Some(ty), Some(name)) = (f("type"), f("name")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "local_variable_declaration" | "field_declaration" | "constant_declaration" => {
            variables(w, node);
        }
        "method_invocation" => {
            if let Some(name) = f("name") {
                w.call(node, w.text(name), f("object"));
                w.given(arguments(node));
            }
        }
        "object_creation_expression" => {
            if let Some(ty) = f("type") {
                w.made(node, type_name(w.text(ty)));
                w.given(arguments(node));
            }
        }
        "import_declaration" => import(w, node),
        "class_declaration" | "record_declaration" | "enum_declaration" => {
            heritage(w, node, Heir::Extends, "superclass");
            heritage(w, node, Heir::Implements, "interfaces");
        }
        "interface_declaration" => heritage(w, node, Heir::Extends, "extends_interfaces"),
        _ => {}
    }
}

/// The type a call gives back, as a path the graph follows: `Store#open()`, through a value of
/// type Store or the class itself.
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let object = node.child_by_field_name("object")?;
    let name = w.text(node.child_by_field_name("name")?);
    let of = match w.type_of(object) {
        Some(t) => t,
        None if object.kind() == "identifier" => w.text(object).to_string(),
        None => return None,
    };
    Some(format!("{of}#{name}()"))
}

/// How many arguments a call or `new` is given.
fn arguments(node: Node) -> usize {
    node.child_by_field_name("arguments")
        .map_or(0, |a| a.named_child_count())
}

/// `Store s = …;`, `var s = new Store();`: locals in a method, fields in a class.
fn variables(w: &mut Walk, node: Node) {
    let declared = node.child_by_field_name("type").map_or("", |t| w.text(t));
    let field = node.kind() != "local_variable_declaration";
    let mut c = node.walk();
    let declarators: Vec<Node> = node.children_by_field_name("declarator", &mut c).collect();
    for d in declarators {
        let Some(name) = d.child_by_field_name("name") else {
            continue;
        };
        let ty = if declared == "var" {
            d.child_by_field_name("value")
                .map_or("", |v| match v.kind() {
                    "object_creation_expression" | "cast_expression" => {
                        v.child_by_field_name("type").map_or("", |t| w.text(t))
                    }
                    _ => "",
                })
        } else {
            declared
        };
        if field {
            w.field(node, w.text(name), ty);
        } else {
            w.bind(w.text(name), type_name(ty));
        }
    }
}

/// `import a.b.Store;` brings Store from the package a.b; `import a.b.*;` all of a.b;
/// `import static a.b.Util.max;` (and `.*`) the class Util.
fn import(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let kids: Vec<Node> = node.children(&mut c).collect();
    let Some(path) = kids
        .iter()
        .find(|k| matches!(k.kind(), "scoped_identifier" | "identifier"))
    else {
        return;
    };
    let is_static = kids.iter().any(|k| k.kind() == "static");
    let all = kids.iter().any(|k| k.kind() == "asterisk");
    let path = w.text(*path);
    // (a static import names a member, or with `*` all of a class: the class is what it brings)
    let class_path = if is_static && !all {
        path.rsplit_once('.').map_or(path, |(c, _)| c)
    } else {
        path
    };
    let import = match (all && !is_static, class_path.rsplit_once('.')) {
        (true, _) => Import {
            spec: class_path.to_string(),
            all: true,
            ..Import::default()
        },
        (false, Some((package, class))) => Import {
            spec: package.to_string(),
            names: vec![(class.to_string(), class.to_string())],
            ..Import::default()
        },
        (false, None) => return,
    };
    w.import(Import {
        line: Walk::line(node),
        ..import
    });
}

/// What a type extends or implements: the types in its `field` (a class's superclass, its
/// interfaces), or an interface's extends_interfaces.
fn heritage(w: &mut Walk, node: Node, kind: Heir, field: &str) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let clause = node.child_by_field_name(field).or_else(|| {
        let mut c = node.walk();
        node.named_children(&mut c).find(|n| n.kind() == field)
    });
    let Some(clause) = clause else {
        return;
    };
    // (`implements A, B` holds a type_list; `extends Base` the type itself)
    let mut c = clause.walk();
    let mut types: Vec<Node> = vec![];
    for k in clause.named_children(&mut c) {
        if k.kind() == "type_list" {
            let mut c = k.walk();
            types.extend(k.named_children(&mut c));
        } else {
            types.push(k);
        }
    }
    for ty in types {
        let sup = type_name(w.text(ty)).to_string();
        w.heritage(kind, w.text(name), &sup, node);
    }
}
