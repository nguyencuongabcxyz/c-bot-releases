//! A shell script's links: what it sources (`source ./lib.sh`, `. "$DIR/common.sh"`: a file
//! from the one it's in, the variables before its path left out), and the commands it runs,
//! each a call of the function of that name when there is one in reach (`build`,
//! `log_info`); a program's (`ls`, `git`) reaches nothing.

use super::*;

pub(super) fn visit(w: &mut Walk, node: Node) {
    match node.kind() {
        "function_definition" => w.open(node),
        "command" => command(w, node),
        _ => {}
    }
}

fn command(w: &mut Walk, node: Node) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let name_text = w.text(name);
    if matches!(name_text, "source" | ".") {
        let Some(arg) = node.child_by_field_name("argument") else {
            return;
        };
        if let Some(path) = sourced(w.text(arg)) {
            w.import(Import {
                spec: path,
                all: true,
                line: Walk::line(node),
                ..Import::default()
            });
        }
        return;
    }
    // (`./build.sh`, `$EDITOR`, `X=1`: not a function's name)
    if !name_text.contains(['/', '$', '=']) {
        w.call(name, name_text, None);
    }
}

/// The file a `source` names, from the script: `./lib.sh`, `"$DIR/common.sh"` is common.sh,
/// `${ROOT}/lib/x.sh` lib/x.sh; None for one only a variable names.
pub(super) fn sourced(arg: &str) -> Option<String> {
    let arg = arg.trim().trim_matches(['"', '\'']);
    let path = match arg.strip_prefix('$') {
        Some(rest) => {
            let rest = rest
                .strip_prefix('{')
                .map_or(rest, |r| r.split_once('}').map_or("", |(_, after)| after));
            let at = rest.find('/')?;
            rest[at + 1..].to_string()
        }
        None => arg.to_string(),
    };
    (!path.is_empty() && !path.contains('$')).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sourced_path_loses_the_variable_it_starts_from() {
        assert_eq!(sourced("./lib/util.sh").as_deref(), Some("./lib/util.sh"));
        assert_eq!(sourced("\"$DIR/common.sh\"").as_deref(), Some("common.sh"));
        assert_eq!(sourced("${ROOT}/lib/x.sh").as_deref(), Some("lib/x.sh"));
        assert_eq!(sourced("$CONFIG"), None);
    }
}
