//! PowerShell's links: dot-sourced scripts (`. $PSScriptRoot\lib\util.ps1`) and imported
//! modules (`Import-Module ./Store.psm1`), commands (`Get-Thing -Name x`: a call of the
//! function of that name, when there's one in reach), method calls (through `$this`, a
//! property of it, a typed parameter or variable: `[Store]$s`, `$o = [Order]::new()`; a
//! class's static `[Order]::Make()`), constructions (`[Order]::new()`, `New-Object Order`), a
//! class's typed properties, what a method returns, and heritage (`class Api : Base, IApi`).

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    match node.kind() {
        "function_statement" | "class_method_definition" | "script_block_expression" => {
            w.open(node);
            if node.kind() == "class_method_definition"
                && let (Some(ty), Some(name)) =
                    (child(node, "type_literal"), child(node, "simple_name"))
            {
                w.returns(node, w.text(name), w.text(ty).trim_matches(['[', ']']));
            }
        }
        "script_parameter" | "class_method_parameter" => parameter(w, node),
        "class_property_definition" => {
            if let (Some(ty), Some(name)) = (child(node, "type_literal"), child(node, "variable")) {
                let ty = w.text(ty).trim_matches(['[', ']']);
                w.field(node, w.text(name).trim_start_matches('$'), ty);
            }
        }
        "assignment_expression" => assignment(w, node),
        "invokation_expression" => invocation(w, node),
        "command" => command(w, node),
        "class_statement" => heritage(w, node),
        _ => {}
    }
}

fn child<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    let mut c = node.walk();
    node.named_children(&mut c).find(|n| n.kind() == kind)
}

/// The node an expression comes down to through the grammar's one-child wrappers
/// (`pipeline`, `logical_expression`… `unary_expression`).
fn innermost(mut node: Node) -> Node {
    while node.named_child_count() == 1
        && let Some(only) = node.named_child(0)
    {
        node = only;
    }
    node
}

/// The type a `[Store]` names.
fn type_literal<'a>(w: &Walk<'a>, node: Node) -> Option<&'a str> {
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.kind() == "type_identifier" {
            return Some(w.text(n));
        }
        let mut c = n.walk();
        stack.extend(n.named_children(&mut c));
    }
    None
}

/// `[Store]$s`: a typed parameter.
fn parameter(w: &mut Walk, node: Node) {
    let Some(name) = child(node, "variable") else {
        return;
    };
    if let Some(ty) = type_literal(w, node) {
        w.bind(w.text(name).trim_start_matches('$'), ty);
    }
}

/// The type an invocation gives: what `[Order]::new()` makes.
pub(super) fn made_by(w: &Walk, node: Node) -> Option<String> {
    let node = innermost(node);
    if node.kind() != "invokation_expression" {
        return None;
    }
    let ty = child(node, "type_literal")?;
    let member = child(node, "member_name")?;
    if !w.text(member).eq_ignore_ascii_case("new") {
        return None;
    }
    type_literal(w, ty).map(str::to_string)
}

/// `$o = [Order]::new()`: a variable of that type.
fn assignment(w: &mut Walk, node: Node) {
    let Some(left) = child(node, "left_assignment_expression") else {
        return;
    };
    let target = innermost(left);
    let Some(value) = node.child_by_field_name("value") else {
        return;
    };
    if target.kind() == "variable"
        && let Some(ty) = made_by(w, value)
    {
        w.bind(w.text(target).trim_start_matches('$'), &ty);
    }
}

/// `$s.Open()`, `$this.Store.Open()`, `[Order]::Make()`, `[Order]::new()`.
fn invocation(w: &mut Walk, node: Node) {
    let Some(member) = child(node, "member_name") else {
        return;
    };
    let Some(object) = node.named_child(0) else {
        return;
    };
    let name = w.text(member);
    if object.kind() == "type_literal" {
        let Some(ty) = type_literal(w, object) else {
            return;
        };
        if name.eq_ignore_ascii_case("new") {
            w.made(node, ty);
        } else {
            w.reference(member, RefKind::Call, name, Via::Name(ty.to_string()));
        }
        return;
    }
    w.call(member, name, Some(object));
}

/// `Get-Thing -Name x` (a call of the function), `Import-Module ./Store.psm1`, `. ./lib.ps1`,
/// `New-Object Order`.
fn command(w: &mut Walk, node: Node) {
    let line = Walk::line(node);
    let dot = child(node, "command_invokation_operator").is_some_and(|o| w.text(o) == ".");
    let Some(name) = node.child_by_field_name("command_name") else {
        return;
    };
    let first_arg = || {
        let elements = node.child_by_field_name("command_elements")?;
        let mut c = elements.walk();
        elements
            .named_children(&mut c)
            .find(|n| matches!(n.kind(), "generic_token" | "string_literal" | "variable"))
    };
    if dot {
        if let Some(path) = script_path(w.text(name)) {
            w.import(Import {
                spec: path,
                all: true,
                line,
                ..Import::default()
            });
        }
        return;
    }
    let name_text = w.text(name);
    if name_text.eq_ignore_ascii_case("Import-Module") {
        if let Some(path) = first_arg().and_then(|a| script_path(w.text(a))) {
            w.import(Import {
                spec: path,
                all: true,
                line,
                ..Import::default()
            });
        }
    } else if name_text.eq_ignore_ascii_case("New-Object") {
        if let Some(ty) = first_arg() {
            w.made(node, w.text(ty).trim_matches(['"', '\'']));
        }
    } else {
        w.call(name, name_text, None);
    }
}

/// The script or module a path names, from the one it's in, with `/`: `.\lib\x.ps1`,
/// `$PSScriptRoot\lib\x.ps1` is lib/x.ps1; a module by its name alone (`Pester`) as it's
/// written, None for one only a variable names.
pub(super) fn script_path(text: &str) -> Option<String> {
    let text = text.trim().trim_matches(['"', '\'']).replace('\\', "/");
    let path = match text.strip_prefix('$') {
        Some(rest) => {
            let at = rest.find('/')?;
            rest[at + 1..].to_string()
        }
        None => text,
    };
    (!path.is_empty() && !path.contains('$')).then_some(path)
}

/// `class Api : Base, IApi`: the first base is what it extends, unless it's named like an
/// interface (IApi); the rest it implements.
fn heritage(w: &mut Walk, node: Node) {
    let mut c = node.walk();
    let names: Vec<Node> = node
        .named_children(&mut c)
        .filter(|n| n.kind() == "simple_name")
        .collect();
    let Some((class, bases)) = names.split_first() else {
        return;
    };
    let sub = w.text(*class).to_string();
    for (i, base) in bases.iter().enumerate() {
        let sup = w.text(*base);
        let interface = sup.len() > 1
            && sup.starts_with('I')
            && sup[1..].starts_with(|c: char| c.is_ascii_uppercase());
        let kind = if i == 0 && !interface {
            Heir::Extends
        } else {
            Heir::Implements
        };
        w.heritage(kind, &sub, sup, node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_path_is_from_the_script_with_slashes() {
        assert_eq!(script_path(".\\lib\\x.ps1").as_deref(), Some("./lib/x.ps1"));
        assert_eq!(
            script_path("$PSScriptRoot\\lib\\x.ps1").as_deref(),
            Some("lib/x.ps1")
        );
        assert_eq!(
            script_path("'./Store.psm1'").as_deref(),
            Some("./Store.psm1")
        );
        assert_eq!(script_path("Pester").as_deref(), Some("Pester"));
        assert_eq!(script_path("$path"), None);
    }
}
