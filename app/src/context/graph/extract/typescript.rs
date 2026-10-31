//! TypeScript's and JavaScript's links: imports in every form (`import … from`, `export … from`,
//! `require()`, `import()`), calls and `new`, `super`, typed parameters and locals
//! (`p: Store`, `const s = new Store()`, `const { log } = terminal`, `const y = this.yard`,
//! `for (const s of this.stacks)`, an array callback's `(s) =>`), class fields, interface
//! properties and constructor parameter properties (`constructor(private store: Store)`),
//! `extends` and `implements`.

use super::*;

/// Array methods whose callback's first parameter is one of the array's items…
const ITEM_CALLBACKS: &[&str] = &[
    "find",
    "findLast",
    "filter",
    "map",
    "flatMap",
    "forEach",
    "some",
    "every",
    "findIndex",
    "findLastIndex",
];
/// …and those that give one of its items, or items of the same type.
const ITEM_RETURNS: &[&str] = &["find", "findLast", "at", "pop", "shift", "filter", "slice"];

/// The type a call gives, as a path the graph resolves: an array's item for `find`; else what
/// the method or function returns (`Fleet#ofType()`, `buildTerminal()`).
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        "identifier" if w.local(w.text(callee)).is_none() => Some(format!("{}()", w.text(callee))),
        "member_expression" => {
            let object = callee.child_by_field_name("object")?;
            let method = w.text(callee.child_by_field_name("property")?);
            if ITEM_RETURNS.contains(&method) {
                return w.type_of(object);
            }
            // (a static method, through its class's name)
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

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_declaration"
        | "generator_function_declaration"
        | "method_definition"
        | "arrow_function"
        | "function_expression"
        | "function" => {
            w.open(node);
            if let (Some(name), Some(ty)) = (f("name"), f("return_type")) {
                w.returns(node, w.text(name), w.text(ty));
            }
        }
        "required_parameter" | "optional_parameter" => parameter(w, node),
        "variable_declarator" => declared(w, node),
        "for_in_statement" => {
            // (`for (const s of stacks)`: an item has the type the walk gives the array's)
            let of = (0..node.child_count())
                .filter_map(|i| node.child(i))
                .any(|c| c.kind() == "of");
            if let (true, Some(left), Some(right)) = (of, f("left"), f("right"))
                && left.kind() == "identifier"
                && let Some(ty) = w.type_of(right)
            {
                w.bind(w.text(left), &ty);
            }
        }
        "call_expression" => call(w, node),
        "new_expression" => {
            let ty = made(w, node);
            if !ty.is_empty() {
                w.made(node, &ty);
            }
        }
        "import_statement" => import(w, node),
        "export_statement" => export(w, node),
        "public_field_definition" | "property_signature" => {
            if let (Some(name), Some(ty)) = (f("name"), f("type")) {
                w.field(node, w.text(name), w.text(ty));
            }
        }
        "class_declaration" | "abstract_class_declaration" | "interface_declaration" => {
            heritage(w, node)
        }
        _ => {}
    }
}

/// `const s: Store`, `const s = new Store()`, `const y = this.yard`, `const { log } = t`.
fn declared(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    let Some(name) = f("name") else {
        return;
    };
    let ty = match (f("type"), f("value")) {
        (Some(t), _) => type_name(w.text(t)).to_string(),
        (None, Some(v)) => w.type_of(v).unwrap_or_default(),
        _ => String::new(),
    };
    match name.kind() {
        "identifier" => w.bind(w.text(name), &ty),
        // (each name taken out of a typed value is that value's field of the name)
        "object_pattern" if !ty.is_empty() => {
            let mut c = name.walk();
            let parts: Vec<Node> = name.named_children(&mut c).collect();
            for part in parts {
                let (field, local) = match part.kind() {
                    "shorthand_property_identifier_pattern" => (part, part),
                    "pair_pattern" => match (
                        part.child_by_field_name("key"),
                        part.child_by_field_name("value"),
                    ) {
                        (Some(k), Some(v)) if v.kind() == "identifier" => (k, v),
                        _ => continue,
                    },
                    _ => continue,
                };
                let field_ty = format!("{ty}#{}", w.text(field));
                w.bind(w.text(local), &field_ty);
            }
        }
        _ => {}
    }
}

/// `p: Store`; inside a constructor, `private store: Store` is a field of the class too.
fn parameter(w: &mut Walk, node: Node) {
    let (Some(p), Some(t)) = (
        node.child_by_field_name("pattern"),
        node.child_by_field_name("type"),
    ) else {
        return;
    };
    if p.kind() != "identifier" {
        return;
    }
    let ty = type_name(w.text(t)).to_string();
    w.bind(w.text(p), &ty);
    let mut c = node.walk();
    let property = node
        .children(&mut c)
        .any(|n| matches!(n.kind(), "accessibility_modifier" | "readonly"));
    if property {
        w.field(node, w.text(p), &ty);
    }
}

/// The type `new X()` makes.
fn made(w: &Walk, node: Node) -> String {
    let Some(c) = node.child_by_field_name("constructor") else {
        return String::new();
    };
    match c.kind() {
        "identifier" | "type_identifier" => w.text(c).to_string(),
        "member_expression" => c
            .child_by_field_name("property")
            .map(|p| w.text(p).to_string())
            .unwrap_or_default(),
        _ => String::new(),
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
        "identifier" if w.text(callee) == "require" => return required(w, node),
        "import" => return required(w, node),
        "identifier" => w.call(node, w.text(callee), None),
        // (`super(…)`: the supertype's constructor)
        "super" => w.call(node, "constructor", Some(callee)),
        "member_expression" => {
            let (Some(object), Some(property)) = (
                callee.child_by_field_name("object"),
                callee.child_by_field_name("property"),
            ) else {
                return;
            };
            w.call(property, w.text(property), Some(object));
            if ITEM_CALLBACKS.contains(&w.text(property)) {
                item_callback(w, node, object);
            }
        }
        // (`await this.load<T>()` reads as a call of `await this.load`: what's awaited is the callee)
        "await_expression" => {
            let Some(inner) = callee
                .named_child(0)
                .filter(|n| n.kind() == "member_expression")
            else {
                return;
            };
            let (Some(object), Some(property)) = (
                inner.child_by_field_name("object"),
                inner.child_by_field_name("property"),
            ) else {
                return;
            };
            w.call(property, w.text(property), Some(object));
        }
        _ => return,
    }
    w.given(args);
}

/// `items.find((item) => …)`: the callback's untyped first parameter is one of the items, of
/// the type the walk gives the array.
fn item_callback(w: &mut Walk, node: Node, array: Node) {
    let Some(ty) = w.type_of(array) else {
        return;
    };
    let callback = node
        .child_by_field_name("arguments")
        .and_then(|a| a.named_child(0))
        .filter(|c| matches!(c.kind(), "arrow_function" | "function_expression"));
    let Some(callback) = callback else {
        return;
    };
    let param = callback.child_by_field_name("parameter").or_else(|| {
        let params = callback.child_by_field_name("parameters")?;
        let first = params.named_child(0)?;
        let untyped = first.child_by_field_name("type").is_none();
        first
            .child_by_field_name("pattern")
            .filter(|p| untyped && p.kind() == "identifier")
    });
    if let Some(p) = param.filter(|p| p.kind() == "identifier") {
        w.bind_in(callback, w.text(p), &ty);
    }
}

/// `require('x')`, `import('x')`.
fn required(w: &mut Walk, node: Node) {
    let arg = node
        .child_by_field_name("arguments")
        .and_then(|a| a.named_child(0));
    if let Some(arg) = arg.filter(|a| a.kind() == "string") {
        let spec = unquote(w.text(arg));
        w.import(Import {
            spec,
            all: true,
            line: Walk::line(node),
            ..Import::default()
        });
    }
}

fn import(w: &mut Walk, node: Node) {
    let Some(source) = node.child_by_field_name("source") else {
        return;
    };
    let mut import = Import {
        spec: unquote(w.text(source)),
        line: Walk::line(node),
        ..Import::default()
    };
    let mut c = node.walk();
    let clause = node.children(&mut c).find(|n| n.kind() == "import_clause");
    if let Some(clause) = clause {
        let mut c = clause.walk();
        let parts: Vec<Node> = clause.named_children(&mut c).collect();
        for part in parts {
            match part.kind() {
                // (a default import: the module's default, under this name)
                "identifier" => import
                    .names
                    .push(("default".into(), w.text(part).to_string())),
                "namespace_import" => {
                    import.alias = part.named_child(0).map(|n| w.text(n).to_string())
                }
                "named_imports" => named(w, part, &mut import),
                _ => {}
            }
        }
    }
    w.import(import);
}

/// `export * from './x'` and `export { a as b } from './x'`: a re-export, of everything or of
/// the names it gives under theirs. `export default Store`, `export default class Store {}`
/// and `export { open as load }`: the file's own names under others.
fn export(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let clause = node.children(&mut c).find(|n| n.kind() == "export_clause");
    let exported: Vec<(String, String)> = clause.map_or_else(Vec::new, |list| {
        let mut c = list.walk();
        list.named_children(&mut c)
            .filter(|s| s.kind() == "export_specifier")
            .filter_map(|s| {
                let name = s.child_by_field_name("name")?;
                let alias = s.child_by_field_name("alias").unwrap_or(name);
                Some((w.text(name).to_string(), w.text(alias).to_string()))
            })
            .collect()
    });
    if let Some(source) = node.child_by_field_name("source") {
        w.import(Import {
            spec: unquote(w.text(source)),
            all: clause.is_none(),
            names: exported,
            line: Walk::line(node),
            ..Import::default()
        });
        return;
    }
    for (name, alias) in &exported {
        w.export(alias, name);
    }
    let default = (0..node.child_count())
        .filter_map(|i| node.child(i))
        .any(|n| n.kind() == "default");
    if default {
        let local = node
            .child_by_field_name("declaration")
            .and_then(|d| d.child_by_field_name("name"))
            .or_else(|| node.child_by_field_name("value"))
            .filter(|n| matches!(n.kind(), "identifier" | "type_identifier"));
        if let Some(local) = local {
            w.export("default", w.text(local));
        }
    }
}

fn named(w: &Walk, list: Node, import: &mut Import) {
    let mut c = list.walk();
    for spec in list
        .named_children(&mut c)
        .filter(|s| s.kind() == "import_specifier")
    {
        let Some(name) = spec.child_by_field_name("name") else {
            continue;
        };
        let local = spec.child_by_field_name("alias").unwrap_or(name);
        import
            .names
            .push((w.text(name).to_string(), w.text(local).to_string()));
    }
}

/// `class K extends B implements I, J`, `interface I extends J`.
fn heritage(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let sub = w.text(name);
    let mut c = node.walk();
    let clauses: Vec<Node> = node.named_children(&mut c).collect();
    for clause in clauses {
        let mut found = vec![];
        let mut inner = clause.walk();
        let kids: Vec<Node> = clause.named_children(&mut inner).collect();
        for kid in kids {
            match (clause.kind(), kid.kind()) {
                ("class_heritage", "extends_clause") => {
                    found.extend(kid.child_by_field_name("value").map(|v| (Heir::Extends, v)))
                }
                ("class_heritage", "implements_clause") => {
                    found.extend(types(kid).into_iter().map(|t| (Heir::Implements, t)))
                }
                ("extends_type_clause", _) => found.push((Heir::Extends, kid)),
                _ => {}
            }
        }
        for (kind, sup) in found {
            let sup = w.text(sup).split('<').next().unwrap_or("").to_string();
            w.heritage(kind, sub, &sup, node);
        }
    }
}

fn types(clause: Node) -> Vec<Node> {
    let mut c = clause.walk();
    clause.named_children(&mut c).collect()
}

fn unquote(s: &str) -> String {
    s.trim_matches(|c| c == '\'' || c == '"' || c == '`')
        .to_string()
}
