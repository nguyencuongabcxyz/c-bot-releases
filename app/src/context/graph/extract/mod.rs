//! Reading a file's links (facts.rs) from its syntax tree, in the same parse as its
//! definitions: one walk keeps the local scopes (a parameter's or a local's type, by name) and
//! hands each node to its language's reader, which says what it imports, calls, makes, extends
//! or declares. What a call goes through (its receiver) is told apart here, the same way for
//! every language: `this`/`self`, a field of it, a typed local, a name, or nothing.
//!   rust.rs typescript.rs python.rs go.rs csharp.rs java.rs cpp.rs dart.rs zig.rs php.rs
//!   ruby.rs shell.rs powershell.rs                                 each language's node kinds
//!   types.rs   the types declarations name (a parameter's, a field's…), for every language

mod cpp;
mod csharp;
mod dart;
mod go;
mod java;
mod php;
mod powershell;
mod python;
mod ruby;
mod rust;
mod shell;
mod types;
mod typescript;
mod zig;

use std::collections::HashMap;
use std::ops::Range;

use tree_sitter::{Node, Tree};

use super::facts::{
    CLOSURE_ARG, Heir, Heritage, Import, Links, Member, Receiver, Ref, RefKind, TypeRole, TypeUse,
    Via,
};
use crate::context::langs::{Kind, Lang};
use crate::context::parse::{Def, walk};

/// What a local bound to the receiver of a Go method is: `this`. A type can also be a path of
/// fields from a type or from `this`: `Terminal#log`, `\0this#yard#stacks`.
const THIS: &str = "\0this";
const THIS_FIELD: &str = "\0this#";
/// A local of no type the walk knows (Ruby's, an untyped parameter): it's a local, so said
/// alone it's no call.
const UNTYPED: &str = "\0?";

/// One file's walk.
pub(super) struct Walk<'a> {
    lang: Lang,
    src: &'a str,
    defs: &'a [Def],
    scopes: Vec<(usize, HashMap<String, String>)>, // (the node that opened it, local -> type)
    pending: HashMap<usize, Vec<(String, String)>>, // (a scope about to open -> its typed locals)
    typed: Vec<Range<usize>>, // (the declared types read, still around: types.rs)
    out: Links,
}

/// A file's links, from its tree and its definitions (parse.rs).
pub(in crate::context) fn links(lang: Lang, tree: &Tree, src: &str, defs: &[Def]) -> Links {
    // (one read for what it defines only has none: no walk)
    if !lang.linked() {
        return Links::default();
    }
    let mut w = Walk {
        lang,
        src,
        defs,
        scopes: vec![(usize::MAX, HashMap::new())],
        pending: HashMap::new(),
        typed: vec![],
        out: Links::default(),
    };
    walk(tree, |node, entering| {
        if entering {
            w.enter(node);
        } else if w.scopes.last().is_some_and(|(id, _)| *id == node.id()) {
            w.scopes.pop();
        }
    });
    w.out
}

impl<'a> Walk<'a> {
    fn enter(&mut self, node: Node) {
        self.declared_types(node);
        match self.lang {
            Lang::Rust => rust::visit(self, node),
            Lang::TypeScript | Lang::Tsx => typescript::visit(self, node),
            Lang::Python => python::visit(self, node),
            Lang::Go => go::visit(self, node),
            Lang::CSharp => csharp::visit(self, node),
            Lang::Java => java::visit(self, node),
            Lang::Cpp => cpp::visit(self, node),
            Lang::Dart => dart::visit(self, node),
            Lang::Zig => zig::visit(self, node),
            Lang::Php => php::visit(self, node),
            Lang::Ruby => ruby::visit(self, node),
            Lang::Bash => shell::visit(self, node),
            Lang::PowerShell => powershell::visit(self, node),
            // (only what they define, for now: no imports, calls or heritage)
            Lang::Kotlin | Lang::Swift | Lang::Prisma | Lang::Proto | Lang::Hcl => {}
        }
    }

    fn text(&self, node: Node) -> &'a str {
        self.src.get(node.byte_range()).unwrap_or("")
    }

    fn line(node: Node) -> u32 {
        u32::try_from(node.start_position().row + 1).unwrap_or(u32::MAX)
    }

    /// A new local scope, opened by this node (a function, a method, a lambda), with the locals
    /// already known for it (a callback's parameter).
    fn open(&mut self, node: Node) {
        let known = self.pending.remove(&node.id()).unwrap_or_default();
        self.scopes.push((node.id(), known.into_iter().collect()));
    }

    /// A local of the scope `node` is about to open, and its type.
    fn bind_in(&mut self, node: Node, name: &str, ty: &str) {
        if !name.is_empty() && !ty.is_empty() {
            self.pending
                .entry(node.id())
                .or_default()
                .push((name.to_string(), ty.to_string()));
        }
    }

    /// A local's (or parameter's) type, in the innermost scope.
    fn bind(&mut self, name: &str, ty: &str) {
        if name.is_empty() || ty.is_empty() {
            return;
        }
        if let Some((_, scope)) = self.scopes.last_mut() {
            scope.insert(name.to_string(), ty.to_string());
        }
    }

    fn local(&self, name: &str) -> Option<&str> {
        self.scopes
            .iter()
            .rev()
            .find_map(|(_, s)| s.get(name).map(String::as_str))
    }

    /// The definition a line is in: the innermost one holding it (an index into `defs`).
    fn within(&self, line: u32) -> Option<u32> {
        self.defs
            .iter()
            .enumerate()
            .filter(|(_, d)| d.line <= line && line <= d.end && d.kind != Kind::Module)
            .max_by_key(|(_, d)| d.depth)
            .and_then(|(i, _)| u32::try_from(i).ok())
    }

    /// The type a line is in (a class, struct, interface, impl…), by name.
    fn holder(&self, line: u32) -> Option<&'a str> {
        self.defs
            .iter()
            .filter(|d| d.line <= line && line <= d.end && d.kind.holds_methods())
            .max_by_key(|d| d.depth)
            .map(|d| d.name.as_str())
    }

    /// A call of `name` through `object` (None: called bare) at `node` (its line: the name's,
    /// for a call in a chain over several lines).
    fn call(&mut self, node: Node, name: &str, object: Option<Node>) {
        let via = match object {
            // (`field("name")` where field is a local closure: the closure, no function of the
            // folder's of that name)
            None if self.local(name).is_some() => return,
            None => Via::Bare,
            Some(o) => self.via(o),
        };
        self.reference(node, RefKind::Call, name, via);
    }

    /// The last call or `new` was given `n` arguments.
    fn given(&mut self, n: usize) {
        if let Some(r) = self.out.refs.last_mut() {
            r.args = u32::try_from(n).ok();
        }
    }

    /// A value of type `ty` made at `node`.
    fn made(&mut self, node: Node, ty: &str) {
        self.reference(node, RefKind::New, ty, Via::Bare);
    }

    fn reference(&mut self, node: Node, kind: RefKind, name: &str, via: Via) {
        // (Go's `ast.File{}` keeps its package: the graph looks the type up there)
        let name = if self.lang == Lang::Go && kind == RefKind::New {
            go::go_type(name)
        } else {
            bare(name)
        };
        if name.is_empty() {
            return;
        }
        let line = Self::line(node);
        self.out.refs.push(Ref {
            kind,
            name: name.to_string(),
            via,
            line,
            within: self.within(line),
            args: None,
        });
    }

    /// What a call's object is: this or super, a field of this (or of that field…), a typed
    /// local (or a field of it…), a name, or something else.
    fn via(&self, object: Node) -> Via {
        // (C#'s `a!` is a)
        let mut object = object;
        while object.kind() == "postfix_unary_expression" && self.text(object).ends_with('!') {
            let Some(inner) = object.named_child(0) else {
                break;
            };
            object = inner;
        }
        // (C#'s `base` too)
        if matches!(object.kind(), "super" | "base") {
            return Via::Super;
        }
        // (Ruby's `Store`: a constant)
        let named = matches!(
            object.kind(),
            "identifier"
                | "type_identifier"
                | "package_identifier"
                | "namespace_identifier"
                | "constant"
        );
        if named && !self.is_this(object) && self.local(self.text(object)).is_none() {
            return Via::Name(self.text(object).to_string());
        }
        // (C#'s `Result<Order>.Failure()`: a generic type's static method)
        if self.lang == Lang::CSharp && object.kind() == "generic_name" {
            let name = self.text(object).split('<').next().unwrap_or("").trim();
            return Via::Name(name.to_string());
        }
        match self.type_of(object) {
            Some(t) if t == THIS => Via::This,
            // (an untyped local, or a field of one)
            Some(t) if t.starts_with(UNTYPED) => Via::Unknown,
            Some(t) => match t.strip_prefix(THIS_FIELD) {
                Some(fields) => Via::Field(fields.to_string()),
                None => Via::Typed(t),
            },
            None => self.dotted(object).map_or(Via::Unknown, Via::Name),
        }
    }

    /// A TypeScript name of names none of which is a local (`Checks.Weight`): a namespace's.
    fn dotted(&self, node: Node) -> Option<String> {
        if !matches!(self.lang, Lang::TypeScript | Lang::Tsx) {
            return None;
        }
        if node.kind() == "identifier" {
            let name = self.text(node);
            return self.local(name).is_none().then(|| name.to_string());
        }
        let (base, field) = self.member(node)?;
        Some(format!("{}.{}", self.dotted(base)?, self.text(field)))
    }

    /// The type of a value, as far as the walk knows it: `this`, a typed local, what `new`
    /// makes, or a field of one of those (a path: `Terminal#log`).
    fn type_of(&self, node: Node) -> Option<String> {
        if self.is_this(node) {
            return Some(THIS.to_string());
        }
        match node.kind() {
            "identifier" | "type_identifier" | "package_identifier" => {
                let name = self.text(node);
                // (Dart: a field of the class said without `this`)
                if self.lang == Lang::Dart
                    && self.local(name).is_none()
                    && dart::own_field(self, name, Self::line(node))
                {
                    return Some(format!("{THIS_FIELD}{name}"));
                }
                // (Rust: a `const` or `static` of the file, `const ALL: [FileType; 31]`)
                if self.lang == Lang::Rust && self.local(name).is_none() {
                    return self.constant(name);
                }
                return self.local(name).map(str::to_string);
            }
            "parenthesized_expression" | "non_null_expression" | "await_expression" => {
                return self.type_of(node.named_child(0)?);
            }
            // (Zig's `try x`, `x.?`)
            "try_expression" | "null_coercion_expression" if self.lang == Lang::Zig => {
                return self.type_of(node.named_child(0)?);
            }
            "call_expression" if self.lang == Lang::Go => return go::returned(self, node),
            // (Go's `n.(*ast.CallExpr)`: what it's asserted to be)
            "type_assertion_expression" => {
                let ty = go::go_type(self.text(node.child_by_field_name("type")?));
                return Some(ty.to_string()).filter(|t| !t.is_empty());
            }
            "call" if self.lang == Lang::Python => return python::returned(self, node),
            "invocation_expression" if self.lang == Lang::CSharp => {
                return csharp::returned(self, node);
            }
            "call_expression" if self.lang == Lang::Dart => return dart::returned(self, node),
            "call_expression" if self.lang == Lang::Zig => return zig::returned(self, node),
            // (a PHP `$s`, a PowerShell `$s`: the local `s`; Ruby's `@store`: a field)
            "variable_name" | "variable" => {
                return self
                    .local(self.text(node).trim_start_matches('$'))
                    .map(str::to_string);
            }
            "instance_variable" => {
                let name = self.text(node).trim_start_matches('@');
                return Some(format!("{THIS_FIELD}{name}"));
            }
            "call" if self.lang == Lang::Ruby => return ruby::returned(self, node),
            "object_creation_expression" if self.lang == Lang::Php => {
                return php::created(self, node).map(str::to_string);
            }
            "pipeline" | "invokation_expression" if self.lang == Lang::PowerShell => {
                return powershell::made_by(self, node);
            }
            // (`lanes[i]`: an item, of the type the walk gives the array's)
            "subscript_expression" if matches!(self.lang, Lang::TypeScript | Lang::Tsx) => {
                return self.type_of(node.child_by_field_name("object")?);
            }
            "call_expression" if matches!(self.lang, Lang::TypeScript | Lang::Tsx) => {
                return typescript::returned(self, node);
            }
            "call_expression" if self.lang == Lang::Cpp => return cpp::returned(self, node),
            "method_invocation" => return java::returned(self, node),
            // (C#: `a!`, `(Store)a`, `a as Store`, and `.b` in `a?.b`: a's b)
            "postfix_unary_expression" if self.text(node).ends_with('!') => {
                return self.type_of(node.named_child(0)?);
            }
            "conditional_access_expression" => {
                let base = self.type_of(node.child_by_field_name("condition")?)?;
                let mut c = node.walk();
                let binding = node
                    .named_children(&mut c)
                    .find(|n| n.kind() == "member_binding_expression")?;
                let name = binding.child_by_field_name("name")?;
                return Some(format!("{base}#{}", self.text(name)));
            }
            "member_binding_expression" => {
                let mut at = node.parent();
                while let Some(p) = at.filter(|p| p.kind() != "conditional_access_expression") {
                    at = p.parent();
                }
                let base = self.type_of(at?.child_by_field_name("condition")?)?;
                return Some(format!(
                    "{base}#{}",
                    self.text(node.child_by_field_name("name")?)
                ));
            }
            "cast_expression" => {
                return Some(type_name(self.text(node.child_by_field_name("type")?)).to_string())
                    .filter(|t| !t.is_empty());
            }
            "as_expression" => {
                return Some(type_name(self.text(node.child_by_field_name("right")?)).to_string())
                    .filter(|t| !t.is_empty());
            }
            _ => {}
        }
        if let Some((base, field)) = self.member(node) {
            let of = match self.type_of(base) {
                Some(t) => t,
                // (a type's static member: `MasterViewModel.Instance`)
                None if self.static_holder(base) => self.text(base).to_string(),
                None => return None,
            };
            return Some(format!("{of}#{}", self.text(field)));
        }
        self.constructed(node)
    }

    /// The declared type of a `const` or `static` the file defines (`static CACHED:
    /// Mutex<Option<Found>> = …` is Found, as calls through it go).
    fn constant(&self, name: &str) -> Option<String> {
        let def = self
            .defs
            .iter()
            .find(|d| d.kind == Kind::Const && d.name == name)?;
        let declared = def.sig.split_once(':')?.1;
        let ty = type_name(declared.split('=').next().unwrap_or(declared));
        (!ty.is_empty()).then(|| ty.to_string())
    }

    /// A name that's a type's, its static members reached through it: capitalized, no local's,
    /// in a language that reaches them with a dot (C#, Java, Dart, Python; not TypeScript, whose
    /// `Checks.Weight` is a namespace's).
    fn static_holder(&self, node: Node) -> bool {
        matches!(
            self.lang,
            Lang::CSharp | Lang::Java | Lang::Dart | Lang::Python
        ) && matches!(node.kind(), "identifier" | "type_identifier")
            && self
                .text(node)
                .starts_with(|c: char| c.is_ascii_uppercase())
            && self.local(self.text(node)).is_none()
    }

    /// The type a `new X()` makes, when the object is one (in brackets or not).
    fn constructed(&self, node: Node) -> Option<String> {
        let node = match node.kind() {
            "parenthesized_expression" => node.named_child(0)?,
            _ => node,
        };
        let ty = match node.kind() {
            // (TypeScript's `new X()` names its constructor, C++'s `new X` its type)
            "new_expression" => node
                .child_by_field_name("constructor")
                .or_else(|| node.child_by_field_name("type"))?,
            // (Dart's `const Text('x')` too)
            "object_creation_expression" | "const_object_expression" => {
                node.child_by_field_name("type")?
            }
            _ => return None,
        };
        Some(type_name(self.text(ty)).to_string())
    }

    /// `this`, `self`, or what a Go method calls its receiver.
    fn is_this(&self, node: Node) -> bool {
        match node.kind() {
            "this" | "self" | "this_expression" => true,
            // (PHP's `$this`, PowerShell's)
            "variable_name" | "variable" => self.text(node).eq_ignore_ascii_case("$this"),
            "identifier" => {
                let t = self.text(node);
                (self.lang == Lang::Python && (t == "self" || t == "cls"))
                    || self.local(t) == Some(THIS)
            }
            _ => false,
        }
    }

    /// An object's member access (`a.b`): its base and the member's name node.
    fn member<'t>(&self, node: Node<'t>) -> Option<(Node<'t>, Node<'t>)> {
        let f = |name: &str| node.child_by_field_name(name);
        match (self.lang, node.kind()) {
            (Lang::TypeScript | Lang::Tsx, "member_expression") => {
                Some((f("object")?, f("property")?))
            }
            (Lang::Rust, "field_expression") => Some((f("value")?, f("field")?)),
            (Lang::Python, "attribute") => Some((f("object")?, f("attribute")?)),
            (Lang::Go, "selector_expression") => Some((f("operand")?, f("field")?)),
            (Lang::CSharp, "member_access_expression") => Some((csharp::object(node)?, f("name")?)),
            (Lang::Java, "field_access") => Some((f("object")?, f("field")?)),
            (Lang::Cpp, "field_expression") => Some((f("argument")?, f("field")?)),
            (Lang::Dart, "member_expression") => Some((f("object")?, f("property")?)),
            (Lang::Zig, "field_expression") => Some((f("object")?, f("member")?)),
            (Lang::Php, "member_access_expression" | "nullsafe_member_access_expression") => {
                Some((f("object")?, f("name")?))
            }
            // (`@store.items`: a call of no arguments, as Ruby reads a field)
            (Lang::Ruby, "call") if f("arguments").is_none() => {
                Some((f("receiver")?, f("method")?))
            }
            (Lang::PowerShell, "member_access") => {
                let mut c = node.walk();
                let name = node
                    .named_children(&mut c)
                    .find(|n| n.kind() == "member_name")?;
                Some((node.named_child(0)?, name))
            }
            _ => None,
        }
    }

    fn import(&mut self, import: Import) {
        self.out.imports.push(import);
    }

    /// The file's own `local` exported as `name`.
    fn export(&mut self, name: &str, local: &str) {
        if name != local && !local.is_empty() {
            self.out.exports.push((name.to_string(), local.to_string()));
        }
    }

    fn heritage(&mut self, kind: Heir, sub: &str, sup: &str, node: Node) {
        let (sub, sup) = (bare(sub), bare(sup));
        if !sub.is_empty() && !sup.is_empty() {
            self.out.heritage.push(Heritage {
                kind,
                sub: sub.to_string(),
                sup: sup.to_string(),
                line: Self::line(node),
            });
        }
    }

    /// What the function or method `name` at `node` returns, as its type's member `name()` (a
    /// free function's, as its own `()`: holder ""); `this` is the type it's in.
    fn returns(&mut self, node: Node, name: &str, ty: &str) {
        let holder = self.holder(Self::line(node)).unwrap_or("");
        let ty = match ty.trim().trim_start_matches(':').trim() {
            "this" | "Self" => holder,
            t => type_name(t),
        };
        if !name.is_empty() && !ty.is_empty() && ty != "void" {
            self.out.members.push(Member {
                holder: holder.to_string(),
                name: format!("{name}()"),
                ty: ty.to_string(),
            });
        }
    }

    /// A typed field of the type `node` is in.
    fn field(&mut self, node: Node, name: &str, ty: &str) {
        let ty = type_name(ty);
        if let Some(holder) = self.holder(Self::line(node))
            && !name.is_empty()
            && !ty.is_empty()
        {
            self.out.members.push(Member {
                holder: holder.to_string(),
                name: name.to_string(),
                ty: ty.to_string(),
            });
        }
    }
}

/// A name without its path or generics: `crate::store::Store<T>` is Store.
fn bare(name: &str) -> &str {
    let name = name.split('<').next().unwrap_or("").trim();
    let name = name.rsplit("::").next().unwrap_or(name);
    name.rsplit('.').next().unwrap_or(name).trim()
}

/// The type a declared type names, as far as calls through it go: `&mut Store` and
/// `Option<Arc<Store>>`… are Store when they wrap one type, `Store[]`, `*Store`, C++'s
/// `const Store&` and `std::unique_ptr<Store>` are Store.
pub(super) fn type_name(ty: &str) -> &str {
    const WRAPPERS: &[&str] = &[
        "Promise",
        "Option",
        "Arc",
        "Rc",
        "Box",
        "RefCell",
        "Mutex",
        "Optional",
        "Ref",
        "ReadonlyArray",
        "Array",
        "List",
        "Vec",
        "unique_ptr",
        "shared_ptr",
        "weak_ptr",
        "optional",
        "vector",
    ];
    let mut t = ty.trim().trim_start_matches(':').trim();
    loop {
        t = t.trim_start_matches(['&', '*', '?']).trim();
        // (Rust's lifetime: `&'a Store`)
        if let Some(rest) = t.strip_prefix('\'') {
            t = rest.split_once(' ').map_or("", |(_, r)| r).trim();
        }
        t = t.strip_prefix("mut ").unwrap_or(t).trim();
        t = t.strip_prefix("readonly ").unwrap_or(t).trim();
        t = t.strip_prefix("const ").unwrap_or(t).trim();
        t = t.strip_prefix("final ").unwrap_or(t).trim();
        t = t
            .trim_end_matches(['?', '!', '&', '*'])
            .trim_end_matches("[]")
            .trim();
        t = t.strip_suffix(" const").unwrap_or(t).trim();
        // (Rust's slice and array: `[Store]`, `[Store; 4]`)
        if let Some(inner) = t.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
            t = inner.split(';').next().unwrap_or("").trim();
            continue;
        }
        match t.split_once('<') {
            Some((outer, inner)) if WRAPPERS.contains(&bare(outer)) => {
                t = inner.strip_suffix('>').unwrap_or(inner);
            }
            // (Rust's `Result<Store, Error>`: what it holds when it's Ok)
            Some((outer, inner)) if bare(outer) == "Result" => {
                t = first_argument(inner.strip_suffix('>').unwrap_or(inner));
            }
            _ => break,
        }
    }
    let t = bare(t);
    if t.chars().all(|c| c.is_alphanumeric() || c == '_') {
        t
    } else {
        ""
    }
}

/// A generic's first argument: `Store` of `Store, Error` (`Vec<A, B>, E`'s first is whole).
fn first_argument(args: &str) -> &str {
    let mut depth = 0i32;
    for (i, c) in args.char_indices() {
        match c {
            '<' | '(' | '[' => depth += 1,
            '>' | ')' | ']' => depth -= 1,
            ',' if depth == 0 => return args[..i].trim(),
            _ => {}
        }
    }
    args.trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::parse;

    /// A file's links, in words.
    fn links_of(lang: Lang, src: &str) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
        let facts = parse::read(lang, src).unwrap();
        let l = &facts.links;
        let via = |v: &Via| match v {
            Via::Bare => "bare".to_string(),
            Via::This => "this".to_string(),
            Via::Super => "super".to_string(),
            Via::Field(f) => format!("field:{f}"),
            Via::Typed(t) => format!("typed:{t}"),
            Via::Name(n) => format!("name:{n}"),
            Via::Unknown => "unknown".to_string(),
            Via::Command => "command".to_string(),
        };
        let within =
            |w: Option<u32>| w.map_or("-".to_string(), |i| facts.defs[i as usize].name.clone());
        let refs = l
            .refs
            .iter()
            .map(|r| {
                format!(
                    "{:?} {} {} in {}",
                    r.kind,
                    r.name,
                    via(&r.via),
                    within(r.within)
                )
                .to_lowercase()
            })
            .collect();
        let imports = l
            .imports
            .iter()
            .map(|i| {
                let names: Vec<String> = i
                    .names
                    .iter()
                    .map(|(a, b)| {
                        if a == b {
                            a.clone()
                        } else {
                            format!("{a} as {b}")
                        }
                    })
                    .collect();
                format!(
                    "{} [{}]{}{}",
                    i.spec,
                    names.join(", "),
                    if i.all { " *" } else { "" },
                    i.alias
                        .as_ref()
                        .map(|a| format!(" as {a}"))
                        .unwrap_or_default()
                )
            })
            .collect();
        let heritage = l
            .heritage
            .iter()
            .map(|h| format!("{} {:?} {}", h.sub, h.kind, h.sup).to_lowercase())
            .collect();
        let members = l
            .members
            .iter()
            .map(|m| format!("{}.{}: {}", m.holder, m.name, m.ty))
            .collect();
        (imports, refs, heritage, members)
    }

    #[test]
    fn rust_links() {
        let src = "use crate::store::{Store, fields::Fields as F};\nmod x;\nstruct A { s: Store }\nimpl Talk for A {\n    fn go(&self, b: &Bar) {\n        self.s.open();\n        b.run();\n        let c = Cat::new();\n        c.meow();\n        helper();\n        Store { a: 1 };\n    }\n}\ntrait T: Clone {}\n";
        let (imports, refs, heritage, members) = links_of(Lang::Rust, src);
        assert_eq!(
            imports,
            [
                "crate::store [Store]",
                "crate::store::fields [Fields as F]",
                "mod [x]"
            ]
        );
        assert_eq!(
            refs,
            [
                "call open field:s in go",
                "call run typed:bar in go",
                "call new name:cat in go",
                "call meow typed:cat in go",
                "call helper bare in go",
                "new store bare in go",
            ]
        );
        assert_eq!(heritage, ["a implements talk", "t extends clone"]);
        assert_eq!(members, ["A.s: Store"]);
    }

    #[test]
    fn typescript_links() {
        let src = "import D, { a as b, c } from './x';\nimport * as ns from '@/y';\nexport * from './z';\nclass K extends Base implements I {\n  private n: Num;\n  constructor(private readonly s: Store) { super(); }\n  go(p: P) {\n    this.s.open();\n    p.run();\n    const q = new Q();\n    q.go();\n    this.n.add();\n    f();\n    ns.g();\n  }\n}\ninterface I extends J {}\n";
        let (imports, refs, heritage, members) = links_of(Lang::TypeScript, src);
        assert_eq!(
            imports,
            ["./x [default as D, a as b, c]", "@/y [] as ns", "./z [] *"]
        );
        assert_eq!(
            refs,
            [
                "call constructor super in constructor",
                "call open field:s in go",
                "call run typed:p in go",
                "new q bare in go",
                "call go typed:q in go",
                "call add field:n in go",
                "call f bare in go",
                "call g name:ns in go",
            ]
        );
        assert_eq!(
            heritage,
            ["k extends base", "k implements i", "i extends j"]
        );
        assert_eq!(members, ["K.n: Num", "K.s: Store"]);
    }

    #[test]
    fn python_links() {
        let src = "import os.path as p\nfrom .x import a as b, c\nfrom y import *\nclass K(Base, mod.Mixin):\n    x: Thing\n    def __init__(self, s: Store):\n        self.s = s\n        self.t = Tool()\n    def go(self, p: P):\n        self.s.open()\n        p.run()\n        q = Q()\n        q.go()\n        f()\n";
        let (imports, refs, heritage, members) = links_of(Lang::Python, src);
        assert_eq!(imports, ["os.path [] as p", ".x [a as b, c]", "y [] *"]);
        assert_eq!(
            refs,
            [
                "call tool bare in __init__",
                "call open field:s in go",
                "call run typed:p in go",
                "call q bare in go",
                "call go typed:q in go",
                "call f bare in go",
            ]
        );
        assert_eq!(heritage, ["k extends base", "k extends mixin"]);
        assert_eq!(members, ["K.x: Thing", "K.s: Store", "K.t: Tool"]);
    }

    #[test]
    fn go_links() {
        let src = "package m\nimport (\n  f \"fmt\"\n  \"x/y\"\n)\ntype S struct {\n  Base\n  db *DB\n}\nfunc (s *S) Go(p P) {\n  s.db.Open()\n  s.Close()\n  p.Run()\n  q := &Q{}\n  q.Do()\n  f.Println()\n  helper()\n}\n";
        let (imports, refs, heritage, members) = links_of(Lang::Go, src);
        assert_eq!(imports, ["fmt [] as f", "x/y []"]);
        assert_eq!(
            refs,
            [
                "call open field:db in go",
                "call close this in go",
                "call run typed:p in go",
                "new q bare in go",
                "call do typed:q in go",
                "call println name:f in go",
                "call helper bare in go",
            ]
        );
        assert_eq!(heritage, ["s extends base"]);
        assert_eq!(members, ["S.db: DB"]);
    }

    #[test]
    fn csharp_links() {
        let src = "using System.IO;\nnamespace N {\n  class K : Base, IThing {\n    private Store _s;\n    public Cat C { get; set; }\n    void Go(P p) {\n      this._s.Open();\n      p.Run();\n      var q = new Q();\n      q.Do();\n      Helper();\n      X.Y();\n    }\n  }\n  interface IThing : IOther {}\n}\n";
        let (imports, refs, heritage, members) = links_of(Lang::CSharp, src);
        assert_eq!(imports, ["System.IO [] *"]);
        assert_eq!(
            refs,
            [
                "call open field:_s in go",
                "call run typed:p in go",
                "new q bare in go",
                "call do typed:q in go",
                "call helper bare in go",
                "call y name:x in go",
            ]
        );
        assert_eq!(
            heritage,
            [
                "k extends base",
                "k implements ithing",
                "ithing extends iother"
            ]
        );
        assert_eq!(members, ["K._s: Store", "K.C: Cat"]);
    }

    #[test]
    fn java_links() {
        let src = "package shop;\nimport java.util.List;\nimport shop.data.*;\nimport static shop.util.Text.trim;\nclass K extends Base implements IThing, Other {\n  private Store s;\n  void go(P p) {\n    this.s.open();\n    p.run(1, 2);\n    var q = new Q();\n    q.go();\n    helper();\n    Util.make();\n    super.go();\n  }\n}\ninterface IThing extends IOther {}\n";
        let (imports, refs, heritage, members) = links_of(Lang::Java, src);
        assert_eq!(
            imports,
            ["java.util [List]", "shop.data [] *", "shop.util [Text]"]
        );
        assert_eq!(
            refs,
            [
                "call open field:s in go",
                "call run typed:p in go",
                "new q bare in go",
                "call go typed:q in go",
                "call helper bare in go",
                "call make name:util in go",
                "call go super in go",
            ]
        );
        assert_eq!(
            heritage,
            [
                "k extends base",
                "k implements ithing",
                "k implements other",
                "ithing extends iother"
            ]
        );
        assert_eq!(members, ["K.s: Store"]);
    }

    #[test]
    fn cpp_links() {
        let src = "#include \"store.h\"\n#include <vector>\nclass K : public Base, private Mixin {\n  Store* s;\n  std::unique_ptr<Cache> c;\n  void go(const P& p);\n};\nvoid K::go(const P& p) {\n  s->open();\n  this->c->drop();\n  p.run();\n  auto q = new Q();\n  q->go();\n  auto m = std::make_unique<M>();\n  m->spin();\n  helper();\n  util::make();\n}\n";
        let (imports, refs, heritage, members) = links_of(Lang::Cpp, src);
        assert_eq!(imports, ["store.h [] *", "<vector> [] *"]);
        assert_eq!(
            refs,
            [
                // (a field through `this` unsaid goes by its name, as in C#: the graph finds
                // it among the fields of the type the call is in)
                "call open name:s in go",
                "call drop field:c in go",
                "call run typed:p in go",
                "new q bare in go",
                "call go typed:q in go",
                "call make_unique name:std in go",
                "call spin typed:m in go",
                "call helper bare in go",
                "call make name:util in go",
            ]
        );
        assert_eq!(heritage, ["k extends base", "k extends mixin"]);
        assert_eq!(members, ["K.s: Store", "K.c: Cache"]);
        let receivers = parse::read(Lang::Cpp, src).unwrap().links.receivers;
        assert_eq!(receivers.len(), 1);
        assert_eq!((receivers[0].line, receivers[0].ty.as_str()), (8, "K"));
    }

    #[test]
    fn csharp_calls_through_nullables_casts_and_containers() {
        let src = "class K {\n  private IRepo? _repo;\n  void Go(object o, IServiceProvider sp) {\n    _repo?.Load(1);\n    _repo!.Save(1, 2);\n    var s = (Store)o;\n    s.Open();\n    var t = o as Store;\n    t.Close();\n    var c = sp.GetRequiredService<IConn>();\n    c.Connect();\n    ((Store)o).Flush();\n    var m = new Store(1, 2, 3);\n    if (o is Shelf h) h.Stock();\n    t?.Owner.Sign();\n  }\n}\n";
        let facts = parse::read(Lang::CSharp, src).unwrap();
        let refs: Vec<String> = facts
            .links
            .refs
            .iter()
            .map(|r| format!("{} {:?} {:?}", r.name, r.via, r.args))
            .collect();
        assert_eq!(
            refs,
            [
                "Load Name(\"_repo\") Some(1)",
                "Save Name(\"_repo\") Some(2)",
                "Open Typed(\"Store\") Some(0)",
                "Close Typed(\"Store\") Some(0)",
                "GetRequiredService Typed(\"IServiceProvider\") Some(0)",
                "Connect Typed(\"IConn\") Some(0)",
                "Flush Typed(\"Store\") Some(0)",
                "Store Bare Some(3)",
                "Stock Typed(\"Shelf\") Some(0)",
                "Sign Typed(\"Store#Owner\") Some(0)",
            ]
        );
    }

    #[test]
    fn a_declared_type_is_the_type_calls_go_to() {
        assert_eq!(type_name("&mut Store"), "Store");
        assert_eq!(type_name(": Option<Arc<crate::store::Store>>"), "Store");
        assert_eq!(type_name("Store[]"), "Store");
        assert_eq!(type_name("*db.Conn"), "Conn");
        assert_eq!(type_name("HashMap<String, Store>"), "HashMap");
        assert_eq!(type_name("string | null"), "");
        assert_eq!(type_name("&'a Arc<Session>"), "Session");
        assert_eq!(type_name("Result<Arc<Chat>, Error>"), "Chat");
        assert_eq!(type_name("&[Session]"), "Session");
        assert_eq!(type_name("[u8; 4]"), "u8");
        assert_eq!(type_name("[string, number]"), "");
        assert_eq!(bare("crate::x::Store<T>"), "Store");
        assert_eq!(bare("ns.Thing"), "Thing");
    }
}
