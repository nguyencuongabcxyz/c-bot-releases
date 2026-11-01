//! Go's links: imports (with their names), calls (a function, a method through its receiver, a
//! package's function), composite literals (`Store{}`, `&Store{}`), typed parameters and
//! locals (`v := Store{}`, `v, err := load()`, `v := s.Open()`: what they return), a method's
//! receiver (calls through it are `this`), struct fields, what functions and methods return
//! (the first of their results), and embedded types (what a struct or interface embeds, it
//! extends). A type of another package keeps it (`*ast.File` is ast.File), so the graph looks
//! it up there, and a library's (`*testing.T`) is never taken for one of the folder's.

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    match node.kind() {
        "function_declaration" => function(w, node),
        "func_literal" => w.open(node),
        "method_declaration" => method(w, node),
        "parameter_declaration" if !receiver(node) => parameter(w, node),
        "short_var_declaration" => short_var(w, node),
        "range_clause" => range(w, node),
        "var_spec" => var_spec(w, node),
        "call_expression" => call(w, node),
        "composite_literal" => {
            let ty = node
                .child_by_field_name("type")
                .filter(|t| matches!(t.kind(), "type_identifier" | "qualified_type"));
            if let Some(ty) = ty {
                w.made(node, w.text(ty));
            }
        }
        "import_spec" => import(w, node),
        "type_conversion_expression" => generic_call(w, node),
        "field_declaration" => field(w, node),
        _ => {}
    }
}

/// A function, and what it returns (a free function's: holder "", as Walk::returns has it).
fn function(w: &mut Walk, node: Node) {
    w.open(node);
    let f = |name: &str| node.child_by_field_name(name);
    if let (Some(name), Some(result)) = (f("name"), f("result")) {
        let ty = first_result(w, result).to_string();
        if !ty.is_empty() {
            w.out.members.push(Member {
                holder: String::new(),
                name: format!("{}()", w.text(name)),
                ty,
            });
        }
    }
}

/// A method: its receiver (calls through it go to the method's own type, which it belongs to)
/// and what it returns, as that type's.
fn method(w: &mut Walk, node: Node) {
    w.open(node);
    let f = |name: &str| node.child_by_field_name(name);
    let param = f("receiver").and_then(|r| r.named_child(0));
    if let Some(r) = param.and_then(|p| p.child_by_field_name("name")) {
        w.bind(w.text(r), THIS);
    }
    let Some(ty) = param.and_then(|p| p.child_by_field_name("type")) else {
        return;
    };
    let ty = type_name(w.text(ty)).to_string();
    if let (Some(name), Some(result)) = (f("name"), f("result")) {
        let returned = first_result(w, result).to_string();
        if !returned.is_empty() {
            w.out.members.push(Member {
                holder: ty.clone(),
                name: format!("{}()", w.text(name)),
                ty: returned,
            });
        }
    }
    w.out.receivers.push(Receiver {
        line: Walk::line(node),
        ty,
    });
}

/// `a, b *Store`: each of the names, of the type.
fn parameter(w: &mut Walk, node: Node) {
    let Some(ty) = node.child_by_field_name("type") else {
        return;
    };
    let ty = go_type(w.text(ty)).to_string();
    let mut c = node.walk();
    let names: Vec<Node> = node.children_by_field_name("name", &mut c).collect();
    for name in names {
        w.bind(w.text(name), &ty);
    }
}

/// `for _, s := range stmts`: each one of what stmts holds; `for c := range root.Preorder()`,
/// over what a call gives, an iterator's: each its item.
fn range(w: &mut Walk, node: Node) {
    let (Some(left), Some(right)) = (
        node.child_by_field_name("left"),
        node.child_by_field_name("right"),
    ) else {
        return;
    };
    let item = match left.named_child(1) {
        Some(item) => Some(item),
        None if right.kind() == "call_expression" => left.named_child(0),
        None => None,
    };
    if let (Some(item), Some(ty)) = (item, w.type_of(right)) {
        w.bind(w.text(item), &ty);
    }
}

/// `var s Store`, `var s = load()`, `inspect = x.(*inspector.Inspector)` in a block; at the top
/// of the file, the package's.
fn var_spec(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    let Some(name) = f("name") else {
        return;
    };
    let ty = match (f("type"), f("value").and_then(|v| v.named_child(0))) {
        (Some(t), _) => Some(go_type(w.text(t)).to_string()),
        (None, Some(v)) if v.kind() == "call_expression" => returned(w, v),
        (None, Some(v)) => w.type_of(v),
        _ => None,
    };
    if let Some(ty) = ty {
        w.bind(w.text(name), &ty);
    }
}

/// A call: of a function (`info[*ast.ArrayType]("Elt")`, a generic one given its type, too), or
/// a method or a package's function through its selector.
fn call(w: &mut Walk, node: Node) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    let callee = match callee.kind() {
        "index_expression" | "generic_type" => callee
            .child_by_field_name("operand")
            .or_else(|| callee.child_by_field_name("type"))
            .unwrap_or(callee),
        _ => callee,
    };
    match callee.kind() {
        "identifier" => w.call(node, w.text(callee), None),
        "selector_expression" => {
            if let (Some(operand), Some(field)) = (
                callee.child_by_field_name("operand"),
                callee.child_by_field_name("field"),
            ) {
                w.call(field, w.text(field), Some(operand));
            }
        }
        _ => {}
    }
}

/// `import "x"`, `import y "x"`; `. "x/analysistest"` (its names said alone), `_ "x"` (for its
/// side effects).
fn import(w: &mut Walk, node: Node) {
    let Some(path) = node.child_by_field_name("path") else {
        return;
    };
    let spec = w.text(path).trim_matches('"').to_string();
    let alias = node
        .child_by_field_name("name")
        .map(|n| w.text(n).to_string());
    let all = alias.as_deref() == Some(".");
    let alias = alias.filter(|a| a != "." && a != "_");
    w.import(Import {
        spec,
        alias,
        all,
        line: Walk::line(node),
        ..Import::default()
    });
}

/// `info[*ast.ArrayType]("Elt")`, read as a conversion to a generic type: a generic function's
/// call.
fn generic_call(w: &mut Walk, node: Node) {
    let generic = node
        .child_by_field_name("type")
        .filter(|t| t.kind() == "generic_type");
    if let Some(name) = generic.and_then(|t| t.child_by_field_name("type"))
        && matches!(name.kind(), "identifier" | "type_identifier")
    {
        w.call(node, w.text(name), None);
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

/// A Go type as calls through it go: `*Store`, `[]Store` are Store; a type of another package
/// keeps it, `*ast.File` is ast.File.
pub(super) fn go_type(ty: &str) -> &str {
    let mut t = ty.trim().trim_start_matches(['*', '&', '[', ']']).trim();
    // (an iterator, `iter.Seq[Cursor]`, `iter.Seq2[int, Cursor]`: what a range over it gives)
    if let Some(args) = t
        .strip_prefix("iter.Seq2[")
        .or_else(|| t.strip_prefix("iter.Seq["))
        .and_then(|a| a.strip_suffix(']'))
    {
        t = args.rsplit(',').next().unwrap_or(args).trim();
        return go_type(t);
    }
    let qualified = t.split_once('.').is_some_and(|(pkg, name)| {
        !pkg.is_empty()
            && pkg
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && name.starts_with(|c: char| c.is_ascii_uppercase())
            && name.chars().all(|c| c.is_alphanumeric() || c == '_')
    });
    if qualified { t } else { type_name(ty) }
}

/// The first of a function's results: `Store` of `(Store, error)`, `*ast.File` of itself.
fn first_result<'a>(w: &Walk<'a>, result: Node) -> &'a str {
    let ty = if result.kind() == "parameter_list" {
        result
            .named_child(0)
            .and_then(|p| p.child_by_field_name("type"))
    } else {
        Some(result)
    };
    ty.map_or("", |t| go_type(w.text(t)))
}

/// The type a call gives: what the function returns (`load()`, a package's `ast.Parse()`),
/// or the method (`Store#Open()`).
pub(super) fn returned(w: &Walk, node: Node) -> Option<String> {
    let callee = node.child_by_field_name("function")?;
    match callee.kind() {
        // (the builtin `new(intsets.Sparse)`: one of that type)
        "identifier" if w.text(callee) == "new" => {
            let arg = node.child_by_field_name("arguments")?.named_child(0)?;
            Some(go_type(w.text(arg)).to_string()).filter(|t| !t.is_empty())
        }
        "identifier" if w.local(w.text(callee)).is_none() => Some(format!("{}()", w.text(callee))),
        "selector_expression" => {
            let operand = callee.child_by_field_name("operand")?;
            let method = w.text(callee.child_by_field_name("field")?);
            match w.type_of(operand) {
                Some(t) => Some(format!("{t}#{method}()")),
                // (a package's function: `ast.Parse()`)
                None if operand.kind() == "identifier" => {
                    Some(format!("{}.{method}()", w.text(operand)))
                }
                None => None,
            }
        }
        _ => None,
    }
}

/// `s := Store{}`, `s := &Store{}`, `s := NewStore()`, `s, err := load()`, `s := t.Open()`.
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
            .map(|t| go_type(w.text(t)).to_string()),
        "call_expression" => returned(w, value),
        _ => w.type_of(value),
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
    let ty = go_type(w.text(ty)).to_string();
    for name in names {
        if let Some(holder) = w.holder(Walk::line(node)) {
            w.out.members.push(Member {
                holder: holder.to_string(),
                name: w.text(name).to_string(),
                ty: ty.clone(),
            });
        }
    }
}
