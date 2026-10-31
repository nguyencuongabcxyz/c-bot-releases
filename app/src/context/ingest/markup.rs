//! The structure of a config file, as definitions the chunker cuts along (chunk.rs), the way it
//! cuts code: an XML or XAML file's elements, and a Razor view's HTML ones (named by their tag
//! and what names them: `Grid Main` for x:Name="Main", `PackageReference Serilog` for
//! Include="Serilog", `form order` for id="order"; its C# and comments let be), a YAML file's
//! keys (`jobs â€º build â€º steps`; a list item by its name), a Dockerfile's stages (`stage build`
//! from `FROM node:20 AS build`), a JSON file's keys, a TOML file's tables and keys, what SQL
//! creates (`table orders`), CSS's rules (`.card:hover`, `@media (max-width: 600px)`); an HTML
//! page, Vue or Svelte component as XML. Only the first DEPTH levels: deeper is what's in a
//! chunk.

use super::*;

use std::sync::LazyLock;

use regex::Regex;

/// How many levels of nesting are definitions.
const DEPTH: usize = 3;
/// A name taken from a value (a list item's, an attribute's) is cut at this many characters.
const NAME_CHARS: usize = 60;

/// A config file's structure, as definitions.
pub(super) fn defs(config: Config, text: &str) -> Vec<Def> {
    match config {
        // (an HTML page, and a Vue or Svelte component's template, script and style, too)
        Config::Xml | Config::Razor | Config::Html => xml(text),
        Config::Yaml => yaml(text),
        Config::Docker => docker(text),
        Config::Json => json(text),
        Config::Toml => toml(text),
        Config::Sql => sql(text),
        Config::Css => css(text),
    }
}

fn def(name: String, depth: usize, line: u32, end: u32) -> Def {
    Def {
        name,
        kind: Kind::Property,
        container: None,
        line,
        end,
        depth: u8::try_from(depth).unwrap_or(u8::MAX),
        sig: String::new(),
    }
}

fn line_no(i: usize) -> u32 {
    u32::try_from(i + 1).unwrap_or(u32::MAX)
}

// ---------------------------------------------------------------- XML

/// HTML's elements that have no closing tag.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

/// The attributes that name an element, in the order they're looked for.
const NAMING: &[&str] = &["x:Name", "Name", "x:Key", "Key", "Include", "id", "name"];

/// The line of a place in a text, counted on from the last place asked about (they only go
/// forward), so a big file isn't counted from its start each time.
struct Lines<'a> {
    text: &'a str,
    at: usize,
    line: usize,
}

impl Lines<'_> {
    fn of(&mut self, at: usize) -> u32 {
        if at < self.at {
            (self.at, self.line) = (0, 0);
        }
        self.line += self.text[self.at..at].matches('\n').count();
        self.at = at;
        line_no(self.line)
    }
}

/// An XML file's elements, the first DEPTH levels of them, each from its `<` to its `>` closing.
fn xml(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    // (the open elements: tag name, and its definition when it's one)
    let mut open: Vec<(String, Option<usize>)> = vec![];
    let mut lines = Lines {
        text,
        at: 0,
        line: 0,
    };
    let mut at = 0;
    while let Some(lt) = text[at..].find('<').map(|i| at + i) {
        // (a Razor comment, `@* <div> *@`, holds no elements)
        if let Some(c) = text[at..lt].find("@*").map(|i| at + i) {
            at = text[c..].find("*@").map_or(text.len(), |e| c + e + 2);
            continue;
        }
        let rest = &text[lt..];
        // (`List<Order>` in Razor's C#, `a < b`: not a tag; `Few</p>` closes one)
        let glued = !rest.starts_with("</")
            && text[..lt]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        let skip_to = |end: &str| rest.find(end).map_or(text.len(), |e| lt + e + end.len());
        if glued || !rest[1..].starts_with(|c: char| c.is_alphabetic() || "/!?_".contains(c)) {
            at = lt + 1;
        } else if rest.starts_with("<!--") {
            at = skip_to("-->");
        } else if rest.starts_with("<![CDATA[") {
            at = skip_to("]]>");
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            at = skip_to(">");
        } else if let Some(closing) = rest.strip_prefix("</") {
            at = skip_to(">");
            let name = closing
                .split(|c: char| c == '>' || c.is_whitespace())
                .next()
                .unwrap_or("");
            // (an element left open, as HTML allows, closes with the one holding it)
            if let Some(k) = open.iter().rposition(|(n, _)| n == name) {
                let end = lines.of(at.saturating_sub(1));
                for d in open.drain(k..).filter_map(|(_, d)| d) {
                    out[d].end = end;
                }
            }
        } else {
            let end = tag_end(text, lt);
            let tag = &text[lt + 1..end.saturating_sub(1).max(lt + 1)];
            at = end;
            let name: String = tag
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '/' && *c != '>')
                .collect();
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_alphanumeric() || ":.-_".contains(c))
            {
                at = lt + 1;
                continue;
            }
            // (HTML's void elements, `<br>`, `<input â€¦>`, never close)
            let shut = tag.ends_with('/') || VOID.contains(&name.to_ascii_lowercase().as_str());
            // (a script's or a style's text holds no elements: on to where it closes)
            if !shut && matches!(name.to_ascii_lowercase().as_str(), "script" | "style") {
                at = text[at..]
                    .find(&format!("</{name}"))
                    .map_or(text.len(), |e| at + e);
            }
            let d = (open.len() < DEPTH).then(|| {
                let label = match naming(tag) {
                    Some(n) => format!("{name} {n}"),
                    None => name.clone(),
                };
                let (from, to) = (lines.of(lt), lines.of(end.saturating_sub(1)));
                out.push(def(label, open.len(), from, to));
                out.len() - 1
            });
            if !shut {
                open.push((name, d));
            }
        }
    }
    // (left open at the end: to the last line)
    let last = line_no(text.lines().count().saturating_sub(1));
    for d in open.into_iter().filter_map(|(_, d)| d) {
        out[d].end = last;
    }
    out
}

/// Where a tag that starts at `lt` ends (past its `>`), its attributes' quotes respected.
fn tag_end(text: &str, lt: usize) -> usize {
    let mut quote = None;
    for (i, c) in text[lt..].char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return lt + i + 1,
            _ => {}
        }
    }
    text.len()
}

/// What names an element: the first of its NAMING attributes it has.
fn naming(tag: &str) -> Option<String> {
    NAMING.iter().find_map(|a| {
        let at = tag.find(&format!(" {a}="))?;
        let value = &tag[at + a.len() + 2..];
        let q = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let value = value[1..].split(q).next()?;
        (!value.is_empty()).then(|| parse::cut(value, NAME_CHARS))
    })
}

// ---------------------------------------------------------------- YAML

/// A YAML file's keys, the first DEPTH levels of them by indentation, each to the last line
/// before the next key at its level or above.
fn yaml(text: &str) -> Vec<Def> {
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

// ---------------------------------------------------------------- Dockerfile

/// A Dockerfile's stages: each `FROM` to the line before the next.
fn docker(text: &str) -> Vec<Def> {
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

// ---------------------------------------------------------------- JSON

/// A JSON file's keys, the first DEPTH levels of them, each to where its value ends (an object
/// or a list at its closing bracket). JSONC's comments are let be.
fn json(text: &str) -> Vec<Def> {
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

/// Where a string that starts at `at` (its quote) ends: past its closing quote, escapes let be.
fn string_end(text: &str, at: usize) -> usize {
    let quote = text.as_bytes()[at];
    let mut escaped = false;
    for (i, b) in text.as_bytes()[at + 1..].iter().enumerate() {
        match b {
            _ if escaped => escaped = false,
            b'\\' => escaped = true,
            b if *b == quote => return at + i + 2,
            _ => {}
        }
    }
    text.len()
}

// ---------------------------------------------------------------- TOML

/// A TOML file's tables (`[package]`, `[[bin]]`) and their keys, each to the last line before
/// the next; keys before any table are at the top.
fn toml(text: &str) -> Vec<Def> {
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
fn sql(text: &str) -> Vec<Def> {
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
fn css(text: &str) -> Vec<Def> {
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
    use super::*;

    fn shown(defs: &[Def]) -> Vec<String> {
        defs.iter()
            .map(|d| {
                format!(
                    "{}{} @{}-{}",
                    "  ".repeat(d.depth.into()),
                    d.name,
                    d.line,
                    d.end
                )
            })
            .collect()
    }

    #[test]
    fn xaml_is_its_elements_named_by_what_names_them() {
        let src = "<?xml version=\"1.0\"?>\n<Window x:Class=\"App.Main\"\n        Title=\"a > b\">\n  <!-- <Ignored/> -->\n  <Grid x:Name=\"Root\">\n    <Button Content=\"Go\" Click=\"OnGo\"/>\n    <TextBox Name=\"Query\">\n      <TextBox.Text>x</TextBox.Text>\n    </TextBox>\n  </Grid>\n  <StackPanel/>\n</Window>\n";
        assert_eq!(
            shown(&xml(src)),
            [
                "Window @2-12",
                "  Grid Root @5-10",
                "    Button @6-6",
                "    TextBox Query @7-9",
                "  StackPanel @11-11",
            ]
        );
    }

    #[test]
    fn a_project_file_names_its_references() {
        let src = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <ItemGroup>\n    <PackageReference Include=\"Serilog\" Version=\"3.1.1\" />\n  </ItemGroup>\n</Project>\n";
        assert_eq!(
            shown(&xml(src)),
            [
                "Project @1-5",
                "  ItemGroup @2-4",
                "    PackageReference Serilog @3-3"
            ]
        );
    }

    #[test]
    fn a_razor_view_is_its_html_elements_its_csharp_let_be() {
        let src = "@model IEnumerable<Order>\n@* <div>old</div> *@\n<div class=\"orders\">\n  @if (Model.Count() < 3) {\n    <p>Few</p>\n  }\n  <form id=\"order\">\n    <input name=\"qty\">\n    <br>\n  </form>\n  <script>if (a<b && c > d) { x = '<div>'; }</script>\n</div>\n@section Scripts { <script src=\"x.js\"></script> }\n";
        assert_eq!(
            shown(&xml(src)),
            [
                "div @3-12",
                "  p @5-5",
                "  form order @7-10",
                "    input qty @8-8",
                "    br @9-9",
                "  script @11-11",
                "script @13-13",
            ]
        );
    }

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
    fn a_dockerfile_is_its_stages() {
        let src = "ARG V=20\nFROM --platform=linux/amd64 node:20 AS build\nRUN npm ci\n\nFROM nginx:alpine\nCOPY --from=build /app /usr/share/nginx/html\n";
        assert_eq!(
            shown(&docker(src)),
            ["stage build @2-4", "stage nginx:alpine @5-6"]
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

    #[test]
    fn text_in_any_script_is_read_without_breaking_it() {
        // (bytes past ASCII: never cut inside a character)
        let src = "{ \"tên\": \"đăng nhập\", /* chú thích */ \"x\": 1 }\n.thẻ::after { content: \"→\"; }\n";
        assert_eq!(shown(&json(src)), ["tên @1-1", "x @1-1"]);
        assert_eq!(shown(&css(src)), [".thẻ::after @2-2"]); // (the JSON's { has no selector)
    }

    #[test]
    fn a_vue_component_is_its_blocks_and_template() {
        let src = "<template>\n  <div id=\"app\">\n    <Card v-if=\"a < b\" />\n  </div>\n</template>\n<script setup lang=\"ts\">\nconst a = 1 < 2;\n</script>\n<style scoped>\n.a { }\n</style>\n";
        assert_eq!(
            shown(&defs(Config::Html, src)),
            [
                "template @1-5",
                "  div app @2-4",
                "    Card @3-3",
                "script @6-8",
                "style @9-11",
            ]
        );
    }
}
