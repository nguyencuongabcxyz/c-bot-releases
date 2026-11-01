//! The files the engine reads that aren't the text they hold: a Jupyter notebook, read as the
//! Python its cells hold (jupytext's "percent" format: each cell after a `# %%` line, its
//! Markdown as comments, its outputs left out), so its definitions, calls and words are found
//! as a .py file's are; and a Word document, read as Markdown (its headings as `#`, its lists'
//! items as `-`), so it's searched by section as Markdown is. Each one's lines are those of
//! that text, which is what the tools show of it.

use super::*;

use std::io::Read as _;

/// The most a Word document's text may take, unpacked (a document bigger than that is
/// something else, or a zip bomb).
const WORD_MAX: u64 = 20 * 1024 * 1024;

/// The text the engine reads in a file, by its kind: a notebook's Python, a Word document's
/// Markdown, else the file itself (None when it isn't text).
pub(super) fn text_of(path: &Path, bytes: Vec<u8>) -> Option<String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    match ext.as_deref() {
        Some("ipynb") => notebook(std::str::from_utf8(&bytes).ok()?),
        Some("docx") => word(&bytes),
        _ => String::from_utf8(bytes).ok(),
    }
}

// ---------------------------------------------------------------- notebooks

/// A notebook's cells as Python: `# %%` before each code cell, `# %% [markdown]` before each
/// Markdown one (its lines as comments), and so on for raw ones.
fn notebook(json: &str) -> Option<String> {
    let nb: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut out = String::new();
    for cell in nb["cells"].as_array()? {
        let source = match &cell["source"] {
            serde_json::Value::Array(lines) => lines
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<String>(),
            v => v.as_str().unwrap_or("").to_string(),
        };
        if !out.is_empty() {
            out.push('\n');
        }
        match cell["cell_type"].as_str() {
            Some("code") => {
                out.push_str("# %%\n");
                out.push_str(source.trim_end());
            }
            kind => {
                out.push_str(&format!("# %% [{}]\n", kind.unwrap_or("raw")));
                let lines: Vec<String> = source
                    .trim_end()
                    .lines()
                    .map(|l| {
                        if l.is_empty() {
                            "#".into()
                        } else {
                            format!("# {l}")
                        }
                    })
                    .collect();
                out.push_str(&lines.join("\n"));
            }
        }
        out.push('\n');
    }
    Some(out)
}

// ---------------------------------------------------------------- Word

/// A Word document's paragraphs as Markdown lines: a heading (its style Heading1…, Title) as
/// `#`s, a list's item as `- `, tabs and line breaks kept; a table's cells, a paragraph each.
fn word(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .ok()?
        .take(WORD_MAX)
        .read_to_string(&mut xml)
        .ok()?;
    let mut out: Vec<String> = vec![];
    let mut at = 0;
    while let Some(start) = paragraph_at(&xml, at) {
        let end = xml[start..]
            .find("</w:p>")
            .map_or(xml.len(), |e| start + e + "</w:p>".len());
        out.push(paragraph(&xml[start..end]));
        at = end;
    }
    // (no more than one empty line in a row)
    out.dedup_by(|a, b| a.is_empty() && b.is_empty());
    Some(out.join("\n").trim().to_string() + "\n")
}

/// Where the next paragraph starts (`<w:p>` or `<w:p …>`, not `<w:pPr>`).
fn paragraph_at(xml: &str, from: usize) -> Option<usize> {
    let mut at = from;
    loop {
        let found = at + xml[at..].find("<w:p")?;
        let next = xml.as_bytes().get(found + 4).copied();
        if matches!(next, Some(b'>' | b' ' | b'/')) {
            return Some(found);
        }
        at = found + 4;
    }
}

/// One paragraph's text, as a Markdown line.
fn paragraph(p: &str) -> String {
    let mut text = String::new();
    let mut at = 0;
    while let Some(lt) = p[at..].find('<').map(|i| at + i) {
        let Some(gt) = p[lt..].find('>').map(|i| lt + i) else {
            break;
        };
        let tag = &p[lt + 1..gt];
        let name = tag.split([' ', '/']).next().unwrap_or("");
        match name {
            "w:t" if !tag.ends_with('/') => {
                let close = p[gt..].find("</w:t>").map_or(p.len(), |e| gt + e);
                text.push_str(&unescape(&p[gt + 1..close]));
                at = close;
                continue;
            }
            "w:tab" => text.push('\t'),
            "w:br" | "w:cr" => text.push(' '),
            _ => {}
        }
        at = gt + 1;
    }
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    match heading_level(p) {
        Some(n) => format!("{} {text}", "#".repeat(n)),
        None if p.contains("<w:numPr>") || p.contains("<w:numPr ") => format!("- {text}"),
        None => text.to_string(),
    }
}

/// A heading's level, from its paragraph style: Title 1, Heading1 1, Heading 2 2… (at most 6).
fn heading_level(p: &str) -> Option<usize> {
    let at = p.find("<w:pStyle ")?;
    let val = &p[at..];
    let val = val[val.find("w:val=\"")? + 7..].split('"').next()?;
    let lower = val.to_ascii_lowercase().replace(' ', "");
    if lower == "title" {
        return Some(1);
    }
    let n: usize = lower.strip_prefix("heading")?.parse().ok()?;
    Some(n.clamp(1, 6))
}

/// XML's escapes undone.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notebook_is_the_python_its_cells_hold() {
        let nb = r##"{"cells": [
            {"cell_type": "markdown", "source": ["# Train\n", "\n", "Fit the model."]},
            {"cell_type": "code", "source": ["import torch\n", "def train(x):\n", "    return x\n"], "outputs": [{"text": "noise"}]},
            {"cell_type": "code", "source": "train(1)"}
        ], "metadata": {}}"##;
        assert_eq!(
            notebook(nb).unwrap(),
            "# %% [markdown]\n# # Train\n#\n# Fit the model.\n\n# %%\nimport torch\ndef train(x):\n    return x\n\n# %%\ntrain(1)\n"
        );
        let facts = parse::read(Lang::Python, &notebook(nb).unwrap()).unwrap();
        assert_eq!(facts.defs[0].name, "train");
        assert_eq!(facts.defs[0].line, 8);
    }

    fn docx(document: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut buf);
        w.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        std::io::Write::write_all(&mut w, document.as_bytes()).unwrap();
        w.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn a_word_document_is_read_as_markdown() {
        let body = concat!(
            r#"<w:document><w:body>"#,
            r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Leave policy</w:t></w:r></w:p>"#,
            r#"<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Carry </w:t></w:r><w:r><w:t>over</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>Days &amp; rules</w:t><w:tab/><w:t>apply.</w:t></w:r></w:p>"#,
            r#"<w:p/><w:p></w:p>"#,
            r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Ask HR</w:t></w:r></w:p>"#,
            r#"</w:body></w:document>"#,
        );
        assert_eq!(
            word(&docx(body)).unwrap(),
            "# Leave policy\n## Carry over\nDays & rules\tapply.\n\n- Ask HR\n"
        );
    }

    #[test]
    fn a_file_is_its_own_text_unless_it_is_a_notebook_or_a_document() {
        assert_eq!(
            text_of(Path::new("a.py"), b"x = 1\n".to_vec()).as_deref(),
            Some("x = 1\n")
        );
        assert_eq!(text_of(Path::new("a.bin"), vec![0xff, 0xfe]), None);
        assert_eq!(
            text_of(Path::new("broken.docx"), b"not a zip".to_vec()),
            None
        );
    }
}
