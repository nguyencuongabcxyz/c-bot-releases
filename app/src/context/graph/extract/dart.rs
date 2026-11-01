//! Dart's links, Flutter's widgets with them: imports and exports (`show` names, `as` a
//! prefix, `part` files), calls (bare, which may be a method of the class it's in: Dart's
//! `this` goes unsaid; through `this`, `super`, a field, a typed parameter or local, a class),
//! constructions (`Store()`, `new Store()`, `const Text('x')`, `Store.named()`), typed
//! parameters and locals (`Store s`, `var s = Store()`, `for (final o in orders)`), fields,
//! what a method returns, and heritage (`extends`, `with` a mixin, `implements`). A State's
//! `widget` is its widget (`class _PageState extends State<Page>`: `widget.store` is Page's
//! store).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_declaration" | "method_declaration" => {
            w.open(node);
            returns(w, node);
        }
        "function_expression" => w.open(node),
        "formal_parameter" => {
            let mut c = node.walk();
            let ty = node.named_children(&mut c).find(|n| n.kind() == "type");
            if let (Some(ty), Some(name)) = (ty, f("name")) {
                w.bind(w.text(name), type_name(w.text(ty)));
            }
        }
        "initialized_variable_declaration" => local(w, node),
        "for_statement" => {
            if let (Some(name), Some(value)) = (f("name"), f("value"))
                && let Some(ty) = w.type_of(value)
            {
                w.bind(w.text(name), &ty);
            }
        }
        "declaration" => field(w, node),
        "call_expression" => call(w, node),
        "new_expression" | "const_object_expression" => {
            if let Some(ty) = f("type") {
                w.made(node, type_name(w.text(ty)));
            }
        }
        "library_import" | "library_export" | "part_directive" => import(w, node),
        "class_declaration" => heritage(w, node),
        _ => {}
    }
}

/// The type a call gives: what `Store()` makes (a capitalised name: a class), else what the
/// function returns (`build()`), or the method (`Store.named()`, `repo.load()`).
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        "identifier" if w.local(w.text(callee)).is_none() => {
            let name = w.text(callee);
            Some(if name.starts_with(|c: char| c.is_ascii_uppercase()) {
                name.to_string()
            } else {
                format!("{name}()")
            })
        }
        "member_expression" => {
            let object = callee.child_by_field_name("object")?;
            let method = w.text(callee.child_by_field_name("property")?);
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

/// A name in a method that's a field of the class it's in, said without `this`: one it
/// declares, or a State's `widget`.
pub(super) fn own_field(w: &Walk, name: &str, line: u32) -> bool {
    let Some(holder) = w.holder(line) else {
        return false;
    };
    let declared = w.defs.iter().any(|d| {
        d.kind == Kind::Property && d.name == name && d.container.as_deref() == Some(holder)
    });
    declared
        || w.out
            .members
            .iter()
            .any(|m| m.holder == holder && m.name == name)
}

/// What a function or method returns, as its member `name()`.
fn returns(w: &mut Walk, node: Node) {
    let signature = node.child_by_field_name("signature");
    // (a method's signature holds the function's)
    let signature = match signature {
        Some(s) if s.kind() == "method_signature" => s.named_child(0),
        s => s,
    };
    let Some(signature) = signature else {
        return;
    };
    if let (Some(name), Some(ty)) = (
        signature.child_by_field_name("name"),
        signature.child_by_field_name("return_type"),
    ) {
        w.returns(node, w.text(name), w.text(ty));
    }
}

/// `Store s = …`, `var s = Store()`, `final s = this.store`.
fn local(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let mut c = node.walk();
    let declared = node.named_children(&mut c).find(|n| n.kind() == "type");
    let ty = match (declared, node.child_by_field_name("value")) {
        (Some(t), _) => type_name(w.text(t)).to_string(),
        (None, Some(v)) => w.type_of(v).unwrap_or_default(),
        _ => String::new(),
    };
    w.bind(w.text(name), &ty);
}

/// A class's typed field: `final Store store;`, `late Api api = Api();`.
fn field(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let kids: Vec<Node> = node.named_children(&mut c).collect();
    let Some(ty) = kids.iter().find(|n| n.kind() == "type") else {
        return;
    };
    let list = kids
        .iter()
        .find(|n| n.kind() == "initialized_identifier_list");
    let Some(list) = list else {
        return;
    };
    let mut c = list.walk();
    for item in list.named_children(&mut c) {
        if let Some(name) = item.child_by_field_name("name") {
            w.field(node, w.text(name), w.text(*ty));
        }
    }
}

fn call(w: &mut Walk, node: Node) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    let args = node.child_by_field_name("arguments").map_or(0, |a| {
        let mut c = a.walk();
        a.named_children(&mut c)
            .filter(|n| n.kind() != "comment")
            .count()
    });
    match callee.kind() {
        "identifier" => w.call(node, w.text(callee), None),
        "member_expression" => {
            let (Some(object), Some(property)) = (
                callee.child_by_field_name("object"),
                callee.child_by_field_name("property"),
            ) else {
                return;
            };
            w.call(property, w.text(property), Some(object));
        }
        _ => return,
    }
    w.given(args);
}

/// `import 'x.dart' as p show A, B;`, `export 'src/x.dart';` (a re-export of all it has),
/// `part 'x.g.dart';` (the same library: all of it seen).
fn import(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let spec_node = node
        .named_children(&mut c)
        .find(|n| n.kind() == "import_specification")
        .unwrap_or(node);
    let Some(uri) = spec_node.child_by_field_name("uri") else {
        return;
    };
    let spec = w
        .text(uri)
        .trim()
        .trim_matches(|c| c == '\'' || c == '"')
        .to_string();
    let alias = spec_node
        .child_by_field_name("alias")
        .map(|a| w.text(a).to_string());
    let mut names = vec![];
    let mut c = spec_node.walk();
    for combinator in spec_node
        .named_children(&mut c)
        .filter(|n| n.kind() == "combinator")
    {
        // (`show A, B`: only those; `hide` keeps the rest, so everything as far as calls go)
        if w.text(combinator).trim_start().starts_with("show") {
            let mut cc = combinator.walk();
            names.extend(
                combinator
                    .named_children(&mut cc)
                    .map(|n| (w.text(n).to_string(), w.text(n).to_string())),
            );
        }
    }
    w.import(Import {
        spec,
        all: alias.is_none() && names.is_empty(),
        names,
        alias,
        line: Walk::line(node),
    });
}

/// `class K extends B with M implements I, J`; a State's widget (`extends State<Page>`) is a
/// field of it, of the widget's type.
fn heritage(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let sub = w.text(name).to_string();
    if let Some(superclass) = node.child_by_field_name("superclass") {
        if let Some(ty) = superclass.child_by_field_name("type") {
            let text = w.text(ty);
            w.heritage(Heir::Extends, &sub, text, node);
            if let Some(widget) = text
                .strip_prefix("State<")
                .and_then(|r| r.strip_suffix('>'))
            {
                w.out.members.push(Member {
                    holder: sub.clone(),
                    name: "widget".into(),
                    ty: type_name(widget).to_string(),
                });
            }
        }
        let mut c = superclass.walk();
        let mixins = superclass
            .named_children(&mut c)
            .find(|n| n.kind() == "mixins");
        for mixin in mixins.map(types).unwrap_or_default() {
            w.heritage(Heir::Extends, &sub, w.text(mixin), node);
        }
    }
    if let Some(interfaces) = node.child_by_field_name("interfaces") {
        for i in types(interfaces) {
            w.heritage(Heir::Implements, &sub, w.text(i), node);
        }
    }
}

/// The types a clause names (`with A, B`, `implements I, J`).
fn types(clause: Node<'_>) -> Vec<Node<'_>> {
    let mut c = clause.walk();
    clause
        .named_children(&mut c)
        .filter(|n| n.kind() == "type")
        .collect()
}
