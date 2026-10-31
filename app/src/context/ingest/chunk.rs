//! Cutting a file into chunks: what search finds and returns. Code is cut along its
//! definitions. A function, method or type small enough is one chunk, with the comments and
//! attributes just above it; a big type is its head (signature, fields) and then its members,
//! each in turn; a long body is cut into windows that overlap a little; what lies between
//! definitions (imports, top-level statements) has chunks of its own; and tiny neighbours are
//! packed together. A config file is cut the same way along its structure (markup.rs: XML
//! elements, YAML keys, Dockerfile stages). Markdown is cut by section, other text by
//! paragraph. Every chunk knows its lines and what it's in (`Store › open`), so a result can
//! say where it is.

use super::*;

/// The most lines in a chunk…
const MAX_LINES: u32 = 60;
/// …and characters (a window is cut short at either).
const MAX_CHARS: usize = 3_000;
/// Lines a window shares with the one before it.
const OVERLAP: u32 = 5;
/// Pieces this short are packed with their neighbours, up to PACK_LINES together.
const SMALL: u32 = 12;
const PACK_LINES: u32 = 24;

/// A piece of a file.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::context) struct Chunk {
    pub from: u32, // (its first line, from 1…)
    pub to: u32,   // (…and its last)
    pub symbol: String,
    pub text: String,
    pub code: bool,
}

/// Lines of a file (from 1, both ends in) and what they're in.
#[derive(Clone, Debug, PartialEq)]
struct Span {
    from: u32,
    to: u32,
    symbol: String,
}

/// A file's chunks.
pub(in crate::context) fn chunks(ty: FileType, text: &str, defs: &[Def]) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let spans = match ty {
        FileType::Code(_) => code_spans(&lines, defs),
        FileType::Config(config) => code_spans(&lines, &super::markup::defs(config, text)),
        FileType::Markdown => markdown_spans(&lines),
        FileType::Text => text_spans(&lines),
    };
    spans
        .into_iter()
        .map(|s| Chunk {
            text: lines[s.from as usize - 1..s.to as usize].join("\n"),
            from: s.from,
            to: s.to,
            symbol: s.symbol,
            code: ty.is_code(),
        })
        .collect()
}

fn count(lines: &[&str]) -> u32 {
    u32::try_from(lines.len()).unwrap_or(u32::MAX)
}

// ---------------------------------------------------------------- code

fn code_spans(lines: &[&str], defs: &[Def]) -> Vec<Span> {
    let mut out = vec![];
    cover(lines, defs, (1, count(lines)), None, "", &mut out);
    pack(out)
}

/// The definitions directly inside `parent` (at the top of the file when None), in order.
fn children<'a>(defs: &'a [Def], parent: Option<&'a Def>) -> impl Iterator<Item = &'a Def> {
    defs.iter().filter(move |d| match parent {
        None => d.depth == 0,
        Some(p) => d.depth == p.depth + 1 && d.line >= p.line && d.end <= p.end,
    })
}

/// Lines `from..=to`, along the definitions in them.
fn cover(
    lines: &[&str],
    defs: &[Def],
    (from, to): (u32, u32),
    parent: Option<&Def>,
    path: &str,
    out: &mut Vec<Span>,
) {
    let mut at = from;
    for d in children(defs, parent) {
        if d.line < at || d.end > to {
            continue; // (one that overlaps what's covered already)
        }
        let start = with_comments(lines, d.line, at);
        gap(lines, (at, start - 1), path, out);
        let name = if path.is_empty() {
            d.name.clone()
        } else {
            format!("{path} › {}", d.name)
        };
        let first_member = children(defs, Some(d)).find(|m| m.line > d.line);
        if fits(lines, start, d.end) {
            out.push(Span {
                from: start,
                to: d.end,
                symbol: name,
            });
        } else if let Some(first) = first_member {
            // a big type: its head, then its members, each as small as it goes
            let head_end = with_comments(lines, first.line, start) - 1;
            windows(lines, (start, head_end), &name, out);
            cover(lines, defs, (head_end + 1, d.end), Some(d), &name, out);
        } else {
            windows(lines, (start, d.end), &name, out);
        }
        at = d.end + 1;
    }
    gap(lines, (at, to), path, out);
}

/// Lines between definitions, without the empty ones at either end (blank, or a closing brace).
fn gap(lines: &[&str], (mut from, mut to): (u32, u32), path: &str, out: &mut Vec<Span>) {
    let blank = |l: u32| {
        lines[l as usize - 1]
            .trim()
            .chars()
            .all(|c| "{}()[];,".contains(c))
    };
    while from <= to && blank(from) {
        from += 1;
    }
    while to >= from && blank(to) {
        to -= 1;
    }
    if from <= to {
        windows(lines, (from, to), path, out);
    }
}

/// Where a definition starts with the comments and attributes right above it (not above `floor`).
fn with_comments(lines: &[&str], line: u32, floor: u32) -> u32 {
    let mut start = line;
    while start > floor && start > 1 {
        let above = lines[start as usize - 2].trim_start();
        if !["//", "#", "/*", "*", "@", "["]
            .iter()
            .any(|p| above.starts_with(p))
        {
            break;
        }
        start -= 1;
    }
    start
}

fn chars(lines: &[&str], from: u32, to: u32) -> usize {
    lines[from as usize - 1..to as usize]
        .iter()
        .map(|l| l.len() + 1)
        .sum()
}

fn fits(lines: &[&str], from: u32, to: u32) -> bool {
    to + 1 - from <= MAX_LINES && chars(lines, from, to) <= MAX_CHARS
}

/// Lines in one piece, or in windows that overlap by OVERLAP lines when they don't fit.
fn windows(lines: &[&str], (from, to): (u32, u32), symbol: &str, out: &mut Vec<Span>) {
    if from > to {
        return;
    }
    let mut start = from;
    loop {
        let mut end = start;
        while end < to && fits(lines, start, end + 1) {
            end += 1;
        }
        out.push(Span {
            from: start,
            to: end,
            symbol: symbol.to_string(),
        });
        if end >= to {
            return;
        }
        start = (end + 1).saturating_sub(OVERLAP).max(start + 1);
    }
}

/// What holds the first thing a symbol names ("Store" for "Store › open, Store › save").
fn holder(symbol: &str) -> &str {
    let first = symbol.split(", ").next().unwrap_or("");
    first.rsplit_once(" › ").map_or("", |(h, _)| h)
}

/// Tiny neighbours packed together (a run of constants, small fields, short functions) when
/// they're in the same thing; and a bare heading goes with the section under it.
fn pack(spans: Vec<Span>) -> Vec<Span> {
    let mut out: Vec<Span> = vec![];
    for s in spans {
        if let Some(last) = out.last_mut()
            && last.to < s.from
            && last.to + 1 - last.from <= SMALL
            && s.to + 1 - s.from <= SMALL
            && s.to + 1 - last.from <= PACK_LINES
        {
            let bare_heading = last.to + 1 - last.from <= 3
                && s.symbol.starts_with(&format!("{} › ", last.symbol));
            if bare_heading {
                last.to = s.to;
                last.symbol = s.symbol;
                continue;
            }
            if last.symbol.is_empty()
                || s.symbol.is_empty()
                || holder(&last.symbol) == holder(&s.symbol)
            {
                last.to = s.to;
                if !s.symbol.is_empty() && !last.symbol.split(", ").any(|x| x == s.symbol) {
                    last.symbol = if last.symbol.is_empty() {
                        s.symbol
                    } else {
                        format!("{}, {}", last.symbol, s.symbol)
                    };
                }
                continue;
            }
        }
        out.push(s);
    }
    out
}

// ---------------------------------------------------------------- documents

/// Markdown by section (its headings, nested, as what it's in); code blocks keep their # lines.
fn markdown_spans(lines: &[&str]) -> Vec<Span> {
    let mut sections: Vec<(u32, String)> = vec![]; // (first line, heading path)
    let mut path: Vec<(usize, String)> = vec![]; // (level, title)
    let mut fenced = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        }
        let level = t.chars().take_while(|c| *c == '#').count();
        if fenced || level == 0 || level > 6 || !t[level..].starts_with(' ') {
            if i == 0 {
                sections.push((1, String::new()));
            }
            continue;
        }
        path.retain(|(l, _)| *l < level);
        path.push((level, t[level..].trim().to_string()));
        let titles: Vec<&str> = path.iter().map(|(_, t)| t.as_str()).collect();
        sections.push((u32::try_from(i + 1).unwrap_or(u32::MAX), titles.join(" › ")));
    }
    let mut out = vec![];
    for (k, (from, title)) in sections.iter().enumerate() {
        let to = sections
            .get(k + 1)
            .map_or(count(lines), |(next, _)| next - 1);
        gap(lines, (*from, to), title, &mut out);
    }
    pack(out)
}

/// Plain text by paragraph (blank lines between), packed into windows.
fn text_spans(lines: &[&str]) -> Vec<Span> {
    let mut out = vec![];
    let mut from = 1;
    for (i, line) in lines.iter().enumerate() {
        let n = u32::try_from(i + 1).unwrap_or(u32::MAX);
        if line.trim().is_empty() {
            gap(lines, (from, n - 1), "", &mut out);
            from = n + 1;
        }
    }
    gap(lines, (from, count(lines)), "", &mut out);
    pack(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(ty: FileType, src: &str) -> Vec<(u32, u32, String)> {
        let defs = match ty {
            FileType::Code(lang) => parse::read(lang, src).unwrap().defs,
            _ => vec![],
        };
        chunks(ty, src, &defs)
            .into_iter()
            .map(|c| (c.from, c.to, c.symbol))
            .collect()
    }

    #[test]
    fn code_is_cut_along_its_definitions_with_their_comments() {
        let mut src = String::from("use std::io;\n\n/// Opens it.\n#[inline]\npub fn open() {\n");
        src.push_str(&"    step();\n".repeat(20));
        src.push_str("}\n\nfn main() {\n");
        src.push_str(&"    open();\n".repeat(20));
        src.push_str("}\n");
        assert_eq!(
            spans(FileType::Code(Lang::Rust), &src),
            [
                (1, 1, String::new()),
                (3, 26, "open".into()),
                (28, 49, "main".into()),
            ]
        );
    }

    #[test]
    fn a_big_type_is_its_head_then_its_members() {
        let mut src = String::from(
            "struct Store {\n    a: u32,\n}\n\nimpl Store {\n    const N: u32 = 1;\n\n",
        );
        for name in ["open", "save", "load"] {
            src.push_str(&format!("    fn {name}() {{\n"));
            src.push_str(&"        work();\n".repeat(25));
            src.push_str("    }\n\n");
        }
        src.push_str("}\n");
        assert_eq!(
            spans(FileType::Code(Lang::Rust), &src),
            [
                (1, 5, "Store".into()), // (the struct, and the impl's head)
                (6, 6, "Store › N".into()),
                (8, 34, "Store › open".into()),
                (36, 62, "Store › save".into()),
                (64, 90, "Store › load".into()),
            ]
        );
    }

    #[test]
    fn a_long_body_is_cut_into_overlapping_windows() {
        let mut src = String::from("fn long() {\n");
        src.push_str(&"    x();\n".repeat(150));
        src.push_str("}\n");
        let got = spans(FileType::Code(Lang::Rust), &src);
        assert_eq!(got[0], (1, 60, "long".into()));
        assert_eq!(got[1], (56, 115, "long".into()));
        assert_eq!(got[2], (111, 152, "long".into()));
    }

    #[test]
    fn tiny_neighbours_are_packed() {
        let src = "const A: u32 = 1;\nconst B: u32 = 2;\n\nfn c() {}\n";
        assert_eq!(
            spans(FileType::Code(Lang::Rust), src),
            [(1, 4, "A, B, c".into())]
        );
    }

    #[test]
    fn markdown_is_cut_by_section() {
        let mut src = String::from(
            "Intro line.\n\n# Install\n\n## Windows\n\nRun it.\n```sh\n# not a heading\n```\n\n# Use\n",
        );
        src.push_str(&"Some words.\n".repeat(30));
        assert_eq!(
            spans(FileType::Markdown, &src),
            [(1, 10, "Install › Windows".into()), (12, 42, "Use".into())]
        );
    }

    #[test]
    fn a_config_file_is_cut_along_its_structure_and_searched_as_code() {
        let mut src = String::from("name: ci\non: push\njobs:\n  test:\n    steps:\n");
        src.push_str(&"      - run: make test\n".repeat(70));
        src.push_str("  lint:\n    runs-on: ubuntu\n");
        let ty = FileType::Config(Config::Yaml);
        assert_eq!(
            spans(ty, &src),
            [
                (1, 3, "name, on, jobs".into()),
                (4, 4, "jobs › test".into()),
                (5, 64, "jobs › test › steps".into()),
                (60, 75, "jobs › test › steps".into()),
                (76, 77, "jobs › lint".into()),
            ]
        );
        assert!(chunks(ty, &src, &[]).iter().all(|c| c.code));
    }

    #[test]
    fn text_is_cut_by_paragraph() {
        let src = "One.\nTwo.\n\nThree.\n";
        assert_eq!(spans(FileType::Text, src), [(1, 4, String::new())]);
    }
}
