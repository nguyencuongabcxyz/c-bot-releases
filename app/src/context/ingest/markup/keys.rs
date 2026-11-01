//! The files made of keys: a YAML file's, a JSON file's, a TOML file's tables and keys, an
//! INI file's sections and keys (a .properties file's keys, a .conf file's blocks).

use super::*;

// ---------------------------------------------------------------- YAML

/// A YAML file's keys, the first DEPTH levels of them by indentation, each to the last line
/// before the next key at its level or above.
pub(super) fn yaml(text: &str) -> Vec<Def> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<Def> = vec![];
    let mut open: Vec<(usize, usize)> = vec![]; // (indent, definition)
    let mut last_text = 0; // (the last line with something on it, from 0)
    let close = |out: &mut Vec<Def>, open: &mut Vec<(usize, usize)>, keep: usize, last: usize| {
        while open.len() > keep {
            if let Some((_, d)) = open.pop() {
                out[d].end = line_no(last);
            }
        }
    };
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if t == "---" || t == "..." {
            close(&mut out, &mut open, 0, last_text);
        } else if let Some((indent, name)) = yaml_key(line) {
            let keep = open.iter().take_while(|(ind, _)| *ind < indent).count();
            close(&mut out, &mut open, keep, last_text);
            if open.len() < DEPTH {
                out.push(def(name, open.len(), line_no(i), line_no(i)));
                open.push((indent, out.len() - 1));
            }
        }
        last_text = i;
    }
    close(&mut out, &mut open, 0, last_text);
    out
}

/// A line's key and how far it's indented: `  build:` is (2, build); a list item `- name: Test`
/// is named by its name, at the item's indent.
fn yaml_key(line: &str) -> Option<(usize, String)> {
    let mut indent = line.len() - line.trim_start().len();
    let mut t = line.trim_start();
    let item = t.strip_prefix("- ");
    if let Some(rest) = item {
        t = rest.trim_start();
    }
    let (key, value) = t.split_once(':')?;
    // (`http://x` isn't a key: one is followed by a space or nothing)
    if !(value.is_empty() || value.starts_with(' ')) {
        return None;
    }
    let key = key.trim().trim_matches(['"', '\'']);
    if key.is_empty() || key.starts_with(['{', '[', '&', '*', '!', '|', '>']) {
        return None;
    }
    if item.is_some() {
        // (a list item: named by its name when it has one, else it's not a key of its own)
        let value = value.trim().trim_matches(['"', '\'']);
        if !matches!(key, "name" | "id" | "uses" | "task") || value.is_empty() {
            return None;
        }
        indent += 2;
        return Some((indent, parse::cut(value, NAME_CHARS)));
    }
    Some((indent, key.to_string()))
}

// ---------------------------------------------------------------- JSON

/// A JSON file's keys, the first DEPTH levels of them, each to where its value ends (an object
/// or a list at its closing bracket). JSONC's comments are let be.
pub(super) fn json(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    // (the open objects and lists: the key each is the value of, when it's a definition)
    let mut open: Vec<Option<usize>> = vec![];
    let mut key: Option<usize> = None; // (a key read, its value still to come)
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
            b'"' => {
                let end = string_end(text, i);
                let is_key = text[end..].trim_start().starts_with(':');
                if is_key && (1..=DEPTH).contains(&open.len()) {
                    let line = lines.of(i);
                    let name = &text[i + 1..end.saturating_sub(1).max(i + 1)];
                    out.push(def(
                        parse::cut(name, NAME_CHARS),
                        open.len() - 1,
                        line,
                        line,
                    ));
                    key = Some(out.len() - 1);
                }
                i = end;
                continue;
            }
            b'{' | b'[' => open.push(key.take()),
            b'}' | b']' => {
                if let Some(Some(d)) = open.pop() {
                    out[d].end = lines.of(i);
                }
                key = None;
            }
            b',' => key = None,
            b'/' if rest().starts_with("//") => i += rest().find('\n').unwrap_or(rest().len()),
            b'/' if rest().starts_with("/*") => {
                i += rest().find("*/").map_or(rest().len(), |e| e + 1);
            }
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

// ---------------------------------------------------------------- TOML

/// A TOML file's tables (`[package]`, `[[bin]]`) and their keys, each to the last line before
/// the next; keys before any table are at the top.
pub(super) fn toml(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    let (mut table, mut key): (Option<usize>, Option<usize>) = (None, None);
    let mut last_text = 0;
    let mut in_string = false; // (a """ string over several lines)
    let mut brackets = 0i32; // (a list over several lines)
    let close = |out: &mut Vec<Def>, d: &mut Option<usize>, last: usize| {
        if let Some(d) = d.take() {
            out[d].end = line_no(last);
        }
    };
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        let quotes = t.matches("\"\"\"").count() + t.matches("'''").count();
        let was_in_string = in_string;
        in_string ^= quotes % 2 == 1;
        if !was_in_string && (t.is_empty() || t.starts_with('#')) {
            continue;
        }
        if was_in_string {
            // (the string's text: nothing in it counts)
        } else if brackets > 0 {
            brackets += bracket_change(t);
        } else if let Some(name) = t.strip_prefix('[').map(|h| {
            h.trim_start_matches('[')
                .split(']')
                .next()
                .unwrap_or("")
                .trim()
        }) {
            close(&mut out, &mut key, last_text);
            close(&mut out, &mut table, last_text);
            out.push(def(name.to_string(), 0, line_no(i), line_no(i)));
            table = Some(out.len() - 1);
        } else if let Some((name, value)) = t.split_once('=') {
            close(&mut out, &mut key, last_text);
            let name = name.trim().trim_matches(['"', '\'']);
            out.push(def(
                name.to_string(),
                usize::from(table.is_some()),
                line_no(i),
                line_no(i),
            ));
            key = Some(out.len() - 1);
            brackets = bracket_change(value);
        }
        last_text = i;
    }
    close(&mut out, &mut key, last_text);
    close(&mut out, &mut table, last_text);
    out
}

/// How many more lists a line opens than it closes.
fn bracket_change(t: &str) -> i32 {
    let count = |c| i32::try_from(t.matches(c).count()).unwrap_or(0);
    count('[') - count(']')
}

// ---------------------------------------------------------------- INI

/// An INI file's sections (`[database]`) and their keys, a .properties file's keys (a value
/// going on after a `\` with them), and a .conf file's blocks: nginx's (`server {`,
/// `location /api {`, to their `}`) and Apache's (`<VirtualHost *:80>`, to its closing tag),
/// with the directives in them. The first DEPTH levels; a section to the line before the next.
pub(super) fn ini(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    // (the blocks open, nginx's or Apache's: their definitions, when they're one)
    let mut open: Vec<Option<usize>> = vec![];
    let (mut section, mut key): (Option<usize>, Option<usize>) = (None, None);
    let mut last_text = 0;
    let mut continued = false; // (a .properties value going on, after a `\`)
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if continued {
            continued = t.ends_with('\\');
            if let Some(k) = key {
                out[k].end = line_no(i);
            }
            last_text = i;
            continue;
        }
        if t.is_empty() || t.starts_with(['#', ';', '!']) || t.starts_with("//") {
            continue;
        }
        key = None;
        let depth = open.len() + usize::from(section.is_some());
        if t.starts_with('[') && t.ends_with(']') && open.is_empty() {
            if let Some(s) = section.take() {
                out[s].end = line_no(last_text);
            }
            let name = t.trim_matches(['[', ']']).trim();
            out.push(def(name.to_string(), 0, line_no(i), line_no(i)));
            section = Some(out.len() - 1);
        } else if t.starts_with("</") || t.starts_with('}') {
            if let Some(Some(d)) = open.pop() {
                out[d].end = line_no(i);
            }
        } else if (t.starts_with('<') && t.ends_with('>')) || t.ends_with('{') {
            let name = t.trim_start_matches('<').trim_end_matches(['>', '{']);
            let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
            let d = (depth < DEPTH && !name.is_empty()).then(|| {
                out.push(def(
                    parse::cut(&name, NAME_CHARS),
                    depth,
                    line_no(i),
                    line_no(i),
                ));
                out.len() - 1
            });
            open.push(d);
        } else if let Some(name) = ini_key(t)
            && depth < DEPTH
        {
            out.push(def(
                parse::cut(name, NAME_CHARS),
                depth,
                line_no(i),
                line_no(i),
            ));
            key = Some(out.len() - 1);
            continued = t.ends_with('\\');
        }
        last_text = i;
    }
    if let Some(s) = section {
        out[s].end = line_no(last_text);
    }
    let last = line_no(text.lines().count().saturating_sub(1));
    for d in open.into_iter().flatten() {
        out[d].end = last;
    }
    out
}

/// A line's key: before its `=` or `:` (`host = db`, `server.port: 80`), or an nginx
/// directive's name (`listen 80;`, `proxy_pass http://api;`: not `proxy_pass http`).
fn ini_key(t: &str) -> Option<&str> {
    let directive = t.ends_with(';');
    let key = match t.find(['=', ':']) {
        Some(at) if !(directive && t[..at].trim().contains(char::is_whitespace)) => t[..at].trim(),
        _ if directive => t.split_whitespace().next()?.trim_end_matches(';'),
        _ => return None,
    };
    (!key.is_empty() && !key.contains(['<', '>', '"'])).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::super::tests::shown;
    use super::*;

    #[test]
    fn yaml_is_its_keys_by_indent_and_list_items_by_name() {
        let src = "# CI\nname: build\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu\n    steps:\n      - name: Check out\n        uses: actions/checkout@v4\n      - run: |\n          echo url: http://x\n\n---\nkind: Service\n";
        assert_eq!(
            shown(&yaml(src)),
            [
                "name @2-2",
                "on @3-5",
                "  push @4-5",
                "    branches @5-5",
                "jobs @6-13",
                "  test @7-13",
                "    runs-on @8-8",
                "    steps @9-13",
                "kind @16-16",
            ]
        );
    }

    #[test]
    fn json_is_its_keys_each_to_where_its_value_ends() {
        let src = "{\n  // JSONC\n  \"name\": \"c-bot\",\n  \"scripts\": {\n    \"test\": \"vitest\",\n    \"url\": \"http://x/{a}\"\n  },\n  \"files\": [\"a\", { \"deep\": { \"deeper\": 1 } }]\n}\n";
        assert_eq!(
            shown(&json(src)),
            [
                "name @3-3",
                "scripts @4-7",
                "  test @5-5",
                "  url @6-6",
                "files @8-8",
                "    deep @8-8",
            ]
        );
    }

    #[test]
    fn ini_is_its_sections_and_keys() {
        let src = "; settings\n[database]\nhost = db.local\nport=5432\n\n[cache]\nttl: 60\n";
        assert_eq!(
            shown(&ini(src)),
            [
                "database @2-4",
                "  host @3-3",
                "  port @4-4",
                "cache @6-7",
                "  ttl @7-7",
            ]
        );
    }

    #[test]
    fn properties_keys_go_on_after_a_backslash() {
        let src = "# app\nserver.port=8080\nmessage.welcome=Hello \\\n  and welcome\nspring.datasource.url: jdbc:x\n";
        assert_eq!(
            shown(&ini(src)),
            [
                "server.port @2-2",
                "message.welcome @3-4",
                "spring.datasource.url @5-5",
            ]
        );
    }

    #[test]
    fn a_conf_file_is_its_nginx_blocks_or_apache_sections() {
        let nginx = "worker_processes 4;\nhttp {\n  server {\n    listen 80;\n    location /api {\n      proxy_pass http://api;\n    }\n  }\n}\n";
        assert_eq!(
            shown(&ini(nginx)),
            [
                "worker_processes @1-1",
                "http @2-9",
                "  server @3-8",
                "    listen @4-4",
                "    location /api @5-7",
            ]
        );
        let apache = "<VirtualHost *:80>\n  ServerName x.com\n  <Directory /var/www>\n    Require all granted\n  </Directory>\n</VirtualHost>\n";
        assert_eq!(
            shown(&ini(apache)),
            ["VirtualHost *:80 @1-6", "  Directory /var/www @3-5"]
        );
    }

    #[test]
    fn toml_is_its_tables_and_their_keys() {
        let src = "name = \"x\"\n\n[package]\nversion = \"1.0\"\nauthors = [\n  \"a\",\n]\n\n[[bin]]\nname = \"\"\"\ntwo = lines\n\"\"\"\n";
        assert_eq!(
            shown(&toml(src)),
            [
                "name @1-1",
                "package @3-7",
                "  version @4-4",
                "  authors @5-7",
                "bin @9-12",
                "  name @10-12",
            ]
        );
    }
}
