//! The files made of blocks: a Dockerfile's stages, what SQL creates, CSS's rules.

use super::*;

use std::sync::LazyLock;

use regex::Regex;

// ---------------------------------------------------------------- Dockerfile

/// A Dockerfile's stages: each `FROM` to the line before the next.
pub(super) fn docker(text: &str) -> Vec<Def> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<Def> = vec![];
    for (i, line) in lines.iter().enumerate() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if !words
            .first()
            .is_some_and(|w| w.eq_ignore_ascii_case("FROM"))
        {
            continue;
        }
        if let Some(last) = out.last_mut() {
            last.end = line_no(i.saturating_sub(1));
        }
        // (`FROM --platform=x node:20 AS build`: named build, else by its image)
        let image = words[1..].iter().find(|w| !w.starts_with("--")).copied();
        let alias = words
            .iter()
            .position(|w| w.eq_ignore_ascii_case("AS"))
            .and_then(|k| words.get(k + 1))
            .copied();
        let Some(name) = alias.or(image) else {
            continue;
        };
        out.push(def(format!("stage {name}"), 0, line_no(i), line_no(i)));
    }
    if let Some(last) = out.last_mut() {
        last.end = line_no(lines.len().saturating_sub(1));
    }
    out
}

// ---------------------------------------------------------------- SQL

/// `CREATE [OR REPLACE] [TEMP…] TABLE [IF NOT EXISTS] name`, and views, functions, procedures,
/// indexes, triggers, types, sequences, schemas.
fn create_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
            r"(?i)^\s*create\s+(?:or\s+(?:replace|alter)\s+)?",
            r"(?:(?:temp|temporary|unique|materialized|global|local|unlogged|clustered|nonclustered|definer\s*=\s*\S+)\s+)*",
            r"(table|view|function|procedure|proc|index|trigger|type|sequence|schema)\s+",
            r"(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([^\s(;]+)",
        ))
        .expect("a constant regex")
    });
    &RE
}

/// What an SQL file creates, each to the last line before the next (`table orders`).
pub(super) fn sql(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    let mut last_text = 0;
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("--") {
            continue;
        }
        if let Some(c) = create_re().captures(line) {
            if let Some(last) = out.last_mut() {
                last.end = line_no(last_text);
            }
            let what = match c[1].to_ascii_lowercase().as_str() {
                "proc" => "procedure".to_string(),
                w => w.to_string(),
            };
            let name = c[2].trim_matches(['"', '`', '[', ']']).replace("].[", ".");
            out.push(def(format!("{what} {name}"), 0, line_no(i), line_no(i)));
        }
        last_text = i;
    }
    if let Some(last) = out.last_mut() {
        last.end = line_no(last_text);
    }
    out
}

// ---------------------------------------------------------------- CSS

/// CSS's rules and at-rules (SCSS's and Less's nested ones too), the first DEPTH levels, each
/// named by its selector, from it to its closing brace.
pub(super) fn css(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    let mut open: Vec<Option<usize>> = vec![];
    let mut start = 0; // (where the selector being read starts: after the last { } or ;)
    let mut lines = Lines {
        text,
        at: 0,
        line: 0,
    };
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // (only sliced at an ASCII byte: a character's own start)
        let rest = || &text[i..];
        match bytes[i] {
            b'"' | b'\'' => {
                i = string_end(text, i);
                continue;
            }
            b'/' if rest().starts_with("/*") => {
                i += rest().find("*/").map_or(rest().len(), |e| e + 2);
                start = i;
                continue;
            }
            b'{' => {
                let prelude = &text[start..i];
                let name = prelude.split_whitespace().collect::<Vec<_>>().join(" ");
                let d = (open.len() < DEPTH && !name.is_empty()).then(|| {
                    let from = start + (prelude.len() - prelude.trim_start().len());
                    let line = lines.of(from);
                    out.push(def(
                        parse::cut(&name, NAME_CHARS),
                        open.len(),
                        line,
                        lines.of(i),
                    ));
                    out.len() - 1
                });
                open.push(d);
                start = i + 1;
            }
            b'}' => {
                if let Some(Some(d)) = open.pop() {
                    out[d].end = lines.of(i);
                }
                start = i + 1;
            }
            b';' => start = i + 1,
            _ => {}
        }
        i += 1;
    }
    let last = line_no(text.lines().count().saturating_sub(1));
    for d in open.into_iter().flatten() {
        out[d].end = last;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests::shown;
    use super::*;

    #[test]
    fn a_dockerfile_is_its_stages() {
        let src = "ARG V=20\nFROM --platform=linux/amd64 node:20 AS build\nRUN npm ci\n\nFROM nginx:alpine\nCOPY --from=build /app /usr/share/nginx/html\n";
        assert_eq!(
            shown(&docker(src)),
            ["stage build @2-4", "stage nginx:alpine @5-6"]
        );
    }

    #[test]
    fn sql_is_what_it_creates() {
        let src = "-- schema\nCREATE TABLE IF NOT EXISTS \"orders\" (\n  id int\n);\nINSERT INTO orders VALUES (1);\n\ncreate or replace view open_orders as select 1;\nCREATE UNIQUE INDEX idx_orders ON orders(id);\nCREATE PROC [dbo].[GetOrders] AS SELECT 1;\n";
        assert_eq!(
            shown(&sql(src)),
            [
                "table orders @2-5",
                "view open_orders @7-7",
                "index idx_orders @8-8",
                "procedure dbo.GetOrders @9-9",
            ]
        );
    }

    #[test]
    fn css_is_its_rules_nested_too() {
        let src = "/* card { */\n.card,\n.panel {\n  content: \"}\";\n  &:hover { color: red; }\n}\n@media (max-width: 600px) {\n  .card { padding: 0; }\n}\n@import 'x.css';\n";
        assert_eq!(
            shown(&css(src)),
            [
                ".card, .panel @2-6",
                "  &:hover @5-5",
                "@media (max-width: 600px) @7-9",
                "  .card @8-8",
            ]
        );
    }
}
