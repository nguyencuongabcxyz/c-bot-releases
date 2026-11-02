//! XML's elements (XAML, project files, an HTML page, a Vue or Svelte component's blocks and
//! template) and a Razor view's HTML, each named by its tag and what names it; and a Razor
//! view's route and C# blocks, with what the C# in them defines.

use super::*;

/// HTML's elements that have no closing tag.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

/// The attributes that name an element, in the order they're looked for.
const NAMING: &[&str] = &["x:Name", "Name", "x:Key", "Key", "Include", "id", "name"];

/// An XML file's elements, the first DEPTH levels of them, each from its `<` to its `>` closing.
pub(super) fn xml(text: &str) -> Vec<Def> {
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
            // (HTML's void elements, `<br>`, `<input …>`, never close)
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

// ---------------------------------------------------------------- Razor

/// A Razor view or component: its route (`@page "/orders"`: `page /orders`), its C# blocks
/// (`@code { }`, `@functions { }`, `@{ }`), each with what the C# in it defines (its methods,
/// properties and fields, read by the C# grammar: `@code › OnInitializedAsync`), and its HTML
/// elements outside them.
pub(super) fn razor(text: &str) -> Vec<Def> {
    let mut out: Vec<Def> = vec![];
    let mut blocks: Vec<(u32, u32)> = vec![];
    for (i, line) in text.lines().enumerate() {
        let t = line.trim();
        if let Some(route) = t.strip_prefix("@page") {
            let route = route.trim().trim_matches('"');
            out.push(def(format!("page {route}"), 0, line_no(i), line_no(i)));
        }
    }
    let mut at = 0;
    while let Some(start) = next_block(text, at) {
        let (word, brace) = start;
        let Some(close) = closing_brace(text, brace) else {
            break;
        };
        let (from, to) = (line_at(text, brace), line_at(text, close));
        out.push(def(word.to_string(), 0, from, to));
        if word != "@{" {
            out.extend(csharp_in(text, brace, close));
        }
        blocks.push((from, to));
        at = close + 1;
    }
    let outside = |d: &Def| !blocks.iter().any(|(f, t)| *f <= d.line && d.end <= *t);
    out.extend(xml(text).into_iter().filter(outside));
    out.sort_by_key(|d| (d.line, d.depth));
    out
}

/// The next C# block from `at`: its word (`@code`, `@functions`, `@{`) and where its `{` is.
fn next_block(text: &str, at: usize) -> Option<(&'static str, usize)> {
    let mut best: Option<(&'static str, usize)> = None;
    for word in ["@code", "@functions", "@{"] {
        let Some(found) = text[at..].find(word).map(|i| at + i) else {
            continue;
        };
        let after = &text[found + word.len()..];
        let brace = if word == "@{" {
            found + 1
        } else {
            // (`@code {`, the brace maybe on the next line; not `@codeBehind`)
            let gap = after.len() - after.trim_start().len();
            if !after.trim_start().starts_with('{') {
                continue;
            }
            found + word.len() + gap
        };
        if best.is_none_or(|(_, b)| brace < b) {
            best = Some((word, brace));
        }
    }
    best
}

/// Where the `}` closing the `{` at `open` is, C#'s strings, characters and comments let be.
fn closing_brace(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        // (only sliced at an ASCII byte: a character's own start)
        let rest = &text[i..];
        match bytes[i] {
            b'"' | b'\'' => {
                i = string_end(text, i);
                continue;
            }
            b'/' if rest.starts_with("//") => i += rest.find('\n').unwrap_or(rest.len()),
            b'/' if rest.starts_with("/*") => i += rest.find("*/").map_or(rest.len(), |e| e + 1),
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The line a place in a text is on.
fn line_at(text: &str, at: usize) -> u32 {
    line_no(text[..at].matches('\n').count())
}

/// What the C# between the braces at `open` and `close` defines, on the lines it's on: read as
/// the body of a class put where the block is (the lines before it left empty), so what's in
/// it is one level deep, as in the block.
fn csharp_in(text: &str, open: usize, close: usize) -> Vec<Def> {
    let before = text[..open].matches('\n').count();
    let source = format!("{}class Razor {}", "\n".repeat(before), &text[open..=close]);
    let Some(facts) = parse::read(Lang::CSharp, &source) else {
        return vec![];
    };
    facts.defs.into_iter().filter(|d| d.depth == 1).collect()
}

#[cfg(test)]
mod tests {
    use super::super::tests::shown;
    use super::*;

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
    fn a_razor_component_is_its_route_its_csharp_blocks_and_their_members() {
        let src = "@page \"/orders\"\n@inject IOrders Orders\n<h1>Orders</h1>\n<ul id=\"list\">\n  @foreach (var o in list) { <li>@o.Id</li> }\n</ul>\n@code {\n    private List<Order> list = new();\n    [Parameter] public int Page { get; set; }\n    protected override async Task OnInitializedAsync()\n    {\n        var s = \"}\";\n        list = await Orders.All();\n    }\n}\n";
        assert_eq!(
            shown(&razor(src)),
            [
                "page /orders @1-1",
                "h1 @3-3",
                "ul list @4-6",
                "  li @5-5",
                "@code @7-15",
                "  list @8-8",
                "  Page @9-9",
                "  OnInitializedAsync @10-14",
            ]
        );
    }
}
