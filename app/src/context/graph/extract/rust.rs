//! Rust's links: `use` trees (flattened, one import per module) and `mod x;`, calls (a
//! function, a method through its receiver, `Type::f`; in a macro's arguments too), struct
//! literals, an enum's variants (uses of the enum) and what each holds, typed parameters and
//! `let`s (`let s: Store`, `let s = Store::new()`, `let s = load()`, `let Some(s) = …`,
//! `let Ev { session, .. } = e`), what a `match` arm takes out of a variant (`Fx::Ask(s, _)`), a
//! loop's and an iterator closure's items (`for s in list`, `list.iter().map(|s| …)`), what
//! functions return, struct fields, `impl Trait for Type` and supertraits.

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    let f = |name: &str| node.child_by_field_name(name);
    match node.kind() {
        "function_item" => {
            w.open(node);
            // (what it returns, for a call on what it gives back: `chat_for()?.session`)
            if let (Some(name), Some(ty)) = (f("name"), f("return_type")) {
                w.returns(node, w.text(name), w.text(ty));
            }
        }
        "closure_expression" => w.open(node),
        "match_arm" => arm(w, node),
        "for_expression" => for_items(w, node),
        "enum_variant" => variant_fields(w, node),
        "struct_pattern" => variant_use(w, node),
        "let_condition" => {
            if let (Some(p), Some(v)) = (f("pattern"), f("value")) {
                let ty = made_type(w, v);
                bind_pattern(w, p, &ty);
            }
        }
        "macro_invocation" => macro_args(w, node),
        "scoped_identifier" => enum_use(w, node),
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
                // (`AgentEvent::Done { … }`: a variant, so a use of AgentEvent, not of a Done)
                let path = name
                    .child_by_field_name("path")
                    .map(|p| super::bare(w.text(p)));
                match path.filter(|p| type_like(p)) {
                    Some(enum_name) => w.made(node, enum_name),
                    None => w.made(node, w.text(name)),
                }
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
                if CALLBACKS.contains(&w.text(field)) {
                    item_callbacks(w, node, value);
                }
            }
        }
        "scoped_identifier" => {
            let name = callee
                .child_by_field_name("name")
                .map(|n| w.text(n))
                .unwrap_or("");
            match callee.child_by_field_name("path") {
                // (`Event::Usage(3)`: a variant made, so a use of Event)
                Some(path) if type_like(super::bare(w.text(path))) && type_like(name) => {
                    w.made(node, super::bare(w.text(path)));
                }
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

/// `let s: Store = …`, `let s = Store::new()`, `let s = Store { … }`, `let s = load()`, and
/// what a pattern takes out (`let Some(s) = …`, `let Ev { session, .. } = e`).
fn let_type(w: &mut Walk, node: Node) {
    let Some(p) = node.child_by_field_name("pattern") else {
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
    bind_pattern(w, p, &ty);
}

/// The names a pattern binds, each with its type: the value's (`s`, `Some(s)`, `Ok(s)`, as
/// `ty` is already what an Option or a Result holds), or a field's (`Ev { session, .. }`: Ev's
/// session, whatever the value).
fn bind_pattern(w: &mut Walk, p: Node, ty: &str) {
    match p.kind() {
        "identifier" => w.bind(w.text(p), ty),
        "tuple_struct_pattern" => {
            let Some(t) = p.child_by_field_name("type") else {
                return;
            };
            if matches!(w.text(t), "Some" | "Ok") {
                if let Some(inner) = p.named_child(1) {
                    bind_pattern(w, inner, ty);
                }
                return;
            }
            // (`Fx::Ask(s, prompt)`: each what that place of the variant holds, `Fx#Ask.0`…)
            let Some(variant) = variant_of(w, t) else {
                return;
            };
            let mut c = p.walk();
            let held: Vec<Node> = p.named_children(&mut c).skip(1).collect();
            for (i, part) in held.into_iter().enumerate() {
                bind_pattern(w, part, &format!("{variant}.{i}"));
            }
        }
        "struct_pattern" => {
            let Some(t) = p.child_by_field_name("type") else {
                return;
            };
            // (a variant's fields are `Fx#Note.session`; a struct's `Ev#session`)
            let prefix = variant_of(w, t).map_or_else(
                || format!("{}#", super::bare(w.text(t))),
                |v| format!("{v}."),
            );
            let mut c = p.walk();
            let fields: Vec<Node> = p
                .named_children(&mut c)
                .filter(|n| n.kind() == "field_pattern")
                .collect();
            for field in fields {
                let Some(name) = field.child_by_field_name("name") else {
                    continue;
                };
                let field_ty = format!("{prefix}{}", w.text(name));
                match field.child_by_field_name("pattern") {
                    None => w.bind(w.text(name), &field_ty),
                    Some(local) if local.kind() == "identifier" => {
                        w.bind(w.text(local), &field_ty);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// The type a value is made as: `Store::new()` (a capitalized path), `Store { … }`, what a
/// function returns (`load()`, its `()`), a typed local or a field of one, a `match`'s (its
/// first arm's that says).
fn made_type(w: &Walk, value: Node) -> String {
    match value.kind() {
        "call_expression"
            if value
                .child_by_field_name("function")
                .is_some_and(|f| f.kind() == "identifier") =>
        {
            value
                .child_by_field_name("function")
                .map(|f| format!("{}()", w.text(f)))
                .unwrap_or_default()
        }
        "identifier" | "field_expression" | "self" => w.type_of(value).unwrap_or_default(),
        "match_expression" => {
            let Some(body) = value.child_by_field_name("body") else {
                return String::new();
            };
            let mut c = body.walk();
            let arms: Vec<Node> = body.named_children(&mut c).collect();
            arms.into_iter()
                .filter_map(|arm| arm.child_by_field_name("value"))
                .map(|v| made_type(w, v))
                .find(|t| !t.is_empty())
                .unwrap_or_default()
        }
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

/// `Fx::Ask(s, …) =>`: what the arm takes out of the variant, by its fields' types.
fn arm(w: &mut Walk, node: Node) {
    let pattern = node.child_by_field_name("pattern").map(|p| match p.kind() {
        "match_pattern" => p.named_child(0).unwrap_or(p),
        _ => p,
    });
    if let Some(p) = pattern {
        bind_pattern(w, p, "");
    }
}

/// `for s in list.iter()`: each an item of what it goes over.
fn for_items(w: &mut Walk, node: Node) {
    if let (Some(p), Some(v)) = (
        node.child_by_field_name("pattern"),
        node.child_by_field_name("value"),
    ) && let Some(ty) = item_type(w, v)
    {
        bind_pattern(w, p, &ty);
    }
}

/// `Fx::Note { session }` in a pattern: a variant, so a use of Fx.
fn variant_use(w: &mut Walk, node: Node) {
    let path = node
        .child_by_field_name("type")
        .and_then(|t| t.child_by_field_name("path"));
    if let Some(enum_name) = path
        .map(|p| super::bare(w.text(p)))
        .filter(|p| type_like(p))
    {
        w.made(node, enum_name);
    }
}

/// A macro's arguments, read for the calls in them.
fn macro_args(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let args: Vec<Node> = node
        .named_children(&mut c)
        .filter(|n| n.kind() == "token_tree")
        .collect();
    for tree in args {
        macro_calls(w, tree);
    }
}

/// `Fx::Ask` in a pattern: the variant, as a typed path's start (`Fx#Ask`); None for a plain
/// type or `Some`.
fn variant_of(w: &Walk, t: Node) -> Option<String> {
    let path = super::bare(w.text(t.child_by_field_name("path")?));
    let name = w.text(t.child_by_field_name("name")?);
    (type_like(path) && type_like(name)).then(|| format!("{path}#{name}"))
}

/// What an enum's variant holds, as fields of the enum: `Ask(Arc<Session>, String)` its
/// `Ask.0` and `Ask.1`, `Note { session: Arc<Session> }` its `Note.session`.
fn variant_fields(w: &mut Walk, node: Node) {
    let (Some(name), Some(body)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("body"),
    ) else {
        return;
    };
    let variant = w.text(name).to_string();
    let mut c = body.walk();
    let parts: Vec<Node> = body
        .named_children(&mut c)
        .filter(|n| !matches!(n.kind(), "attribute_item" | "visibility_modifier"))
        .collect();
    for (i, part) in parts.into_iter().enumerate() {
        match part.kind() {
            "field_declaration" => {
                if let (Some(f), Some(t)) = (
                    part.child_by_field_name("name"),
                    part.child_by_field_name("type"),
                ) {
                    w.field(part, &format!("{variant}.{}", w.text(f)), w.text(t));
                }
            }
            _ => w.field(part, &format!("{variant}.{i}"), w.text(part)),
        }
    }
}

/// Methods whose closure gets the items of what they're called on (`list.iter().map(|s| …)`,
/// an Option's `opt.map(|s| …)`).
const CALLBACKS: &[&str] = &[
    "map",
    "filter",
    "for_each",
    "find",
    "any",
    "all",
    "filter_map",
    "flat_map",
    "find_map",
    "position",
    "inspect",
    "take_while",
    "skip_while",
    "map_while",
    "max_by_key",
    "min_by_key",
    "partition",
    "retain",
    "sort_by_key",
    "and_then",
    "is_some_and",
    "is_none_or",
    "map_or",
    "map_or_else",
    "then",
    "unwrap_or_else",
];

/// Methods that give back the same items they're called on (`iter()`, `filter(…)`).
const SAME_ITEMS: &[&str] = &[
    "iter",
    "iter_mut",
    "into_iter",
    "filter",
    "rev",
    "skip",
    "take",
    "cloned",
    "copied",
    "chain",
    "peekable",
    "by_ref",
    "skip_while",
    "take_while",
    "as_ref",
    "as_deref",
    "as_slice",
];

/// The type of the items a value has (a Vec's, an Option's: the walk's types already are what
/// they hold), through methods that keep them (`list.iter().filter(…)`).
fn item_type(w: &Walk, value: Node) -> Option<String> {
    match value.kind() {
        "call_expression" => {
            let f = value
                .child_by_field_name("function")
                .filter(|f| f.kind() == "field_expression")?;
            let method = w.text(f.child_by_field_name("field")?);
            SAME_ITEMS
                .contains(&method)
                .then(|| item_type(w, f.child_by_field_name("value")?))
                .flatten()
        }
        "reference_expression" => item_type(w, value.child_by_field_name("value")?),
        _ => w.type_of(value),
    }
}

/// `list.iter().map(|s| s.ask())`: each closure argument's untyped first parameter is one of
/// the items of what the method's called on.
fn item_callbacks(w: &mut Walk, node: Node, on: Node) {
    let Some(ty) = item_type(w, on) else {
        return;
    };
    let Some(args) = node.child_by_field_name("arguments") else {
        return;
    };
    let mut c = args.walk();
    let closures: Vec<Node> = args
        .named_children(&mut c)
        .filter(|a| a.kind() == "closure_expression")
        .collect();
    for closure in closures {
        let first = closure
            .child_by_field_name("parameters")
            .and_then(|p| p.named_child(0))
            .map(|p| match p.kind() {
                "reference_pattern" => p.named_child(0).unwrap_or(p),
                _ => p,
            });
        if let Some(p) = first.filter(|p| p.kind() == "identifier") {
            w.bind_in(closure, w.text(p), &ty);
        }
    }
}

/// Named as a type or a variant is: `Store`, `Done` (not `store`, `crate`).
fn type_like(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
}

/// `Lang::Rust`, `Event::Done(_)` in a pattern: a variant, so a use of its enum. (Not a call's
/// own path, nor in a `use`, nor a longer path's start.)
fn enum_use(w: &mut Walk, node: Node) {
    let (Some(path), Some(name)) = (
        node.child_by_field_name("path"),
        node.child_by_field_name("name"),
    ) else {
        return;
    };
    let in_call = node
        .parent()
        .and_then(|p| p.child_by_field_name("function"))
        .is_some_and(|f| f.id() == node.id());
    // (`use_declaration`, `scoped_use_list`, `use_as_clause`…)
    let elsewhere = node
        .parent()
        .is_some_and(|p| p.kind() == "scoped_identifier" || p.kind().contains("use"));
    let enum_name = super::bare(w.text(path));
    if !in_call && !elsewhere && type_like(enum_name) && type_like(w.text(name)) {
        w.made(node, enum_name);
    }
}

/// Calls in a macro's arguments (`assert!(s.ask())`, `format!("{}", load(x))`): its tokens
/// aren't parsed as code, so `name(…)`, `x.name(…)`, `self.name(…)` and `Type::name(…)` are read
/// from them as they stand.
fn macro_calls(w: &mut Walk, tree: Node) {
    let mut c = tree.walk();
    let tokens: Vec<Node> = tree.children(&mut c).collect();
    for (i, &t) in tokens.iter().enumerate() {
        if t.kind() == "token_tree" {
            macro_calls(w, t);
            continue;
        }
        let called = tokens
            .get(i + 1)
            .is_some_and(|n| n.kind() == "token_tree" && w.text(*n).starts_with('('));
        if t.kind() != "identifier" || !called {
            continue;
        }
        let name = w.text(t);
        let before = |k: usize| i.checked_sub(k).and_then(|j| tokens.get(j)).copied();
        match (before(1).map(|n| n.kind()), before(2)) {
            (Some("."), Some(object)) if matches!(object.kind(), "identifier" | "self") => {
                w.call(t, name, Some(object));
            }
            (Some("."), _) => w.reference(t, RefKind::Call, name, Via::Unknown),
            (Some("::"), Some(path)) if path.kind() == "identifier" => {
                let path = w.text(path);
                if type_like(path) && type_like(name) {
                    w.made(t, path);
                } else {
                    w.reference(t, RefKind::Call, name, Via::Name(path.to_string()));
                }
            }
            (Some("::"), _) => {}
            _ => w.call(t, name, None),
        }
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
