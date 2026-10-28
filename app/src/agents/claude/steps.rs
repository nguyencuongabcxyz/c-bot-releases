//! What a conversation's stream says about its steps: a few words for each step ("Read main.rs"),
//! the asides it makes in passing, and what a tool gave back.

use super::*;

// ---------------------------------------------------------------- describing steps

/// "anthropic-skills:pptx" -> "pptx (anthropic-skills)"
pub fn skill_label(skill: &str) -> String {
    match skill.rfind(':') {
        Some(i) if i > 0 => format!("{} ({})", &skill[i + 1..], &skill[..i]),
        _ => skill.to_string(),
    }
}

pub(super) fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s
    }
}

pub(super) fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// What a step is about, in a few words ("main.rs", "npm test", a search pattern…).
pub fn describe_tool(name: &str, input: &Value) -> String {
    let base = |p: &str| p.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    match name {
        "Read" | "Write" | "Edit" | "NotebookEdit" => base(if s(input, "file_path").is_empty() {
            s(input, "notebook_path")
        } else {
            s(input, "file_path")
        }),
        "Bash" | "PowerShell" => short(
            if s(input, "description").is_empty() {
                s(input, "command")
            } else {
                s(input, "description")
            },
            48,
        ),
        "Grep" | "Glob" => short(s(input, "pattern"), 32),
        "WebSearch" => short(s(input, "query"), 48),
        "WebFetch" => {
            let url = s(input, "url");
            url.split_once("://")
                .and_then(|(_, rest)| rest.split('/').next())
                .filter(|h| !h.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| short(url, 48))
        }
        "Task" | "Agent" => short(s(input, "description"), 48),
        "TodoWrite" => "updating the to-do list".into(),
        // (the other robots' tools by their short names)
        "ToolSearch" => short(
            &s(input, "query")
                .trim_start_matches("select:")
                .replace("mcp__cbot__", "")
                .split(',')
                .collect::<Vec<_>>()
                .join(", "),
            48,
        ),
        "TaskCreate" => short(s(input, "subject"), 48),
        "TaskUpdate" => {
            let id = input
                .get("taskId")
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_default();
            let status = s(input, "status");
            if status.is_empty() {
                format!("#{id}")
            } else {
                format!("#{id} → {}", status.replacen('_', " ", 1))
            }
        }
        "Skill" => skill_label(if s(input, "skill").is_empty() {
            s(input, "name")
        } else {
            s(input, "skill")
        }),
        "mcp__cbot__ask_robot" => {
            format!("{}: {}", s(input, "robot"), short(s(input, "message"), 48))
        }
        "mcp__cbot__hand_off_task" => {
            format!("{}: {}", s(input, "robot"), short(s(input, "title"), 48))
        }
        "mcp__cbot__list_words" => short(s(input, "query"), 32),
        "mcp__cbot__save_words" => {
            let words: Vec<String> = input
                .get("words")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|w| w.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            short(&words.join(", "), 48)
        }
        "mcp__cbot__add_note" => short(s(input, "text"), 48),
        "mcp__cbot__terminal_type" | "mcp__cbot__terminal_run" => short(s(input, "command"), 48),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- asides

pub(super) const OPEN: &str = "<aside>";
pub(super) const CLOSE: &str = "</aside>";

/// Pulls <aside>…</aside> remarks out of streamed text. Only a tag that starts its own
/// line counts, so an answer that merely mentions `<aside>` is left alone. Tags can
/// arrive split across chunks, so a possible tag start is held back.
#[derive(Default)]
pub struct AsideFilter {
    buf: String,
    pub asides: Vec<String>,
    mid_line: bool, // buf[0] is not at the start of a line
}

impl AsideFilter {
    fn find_open(&self) -> Option<usize> {
        let mut from = 0;
        while let Some(rel) = self.buf[from..].find(OPEN) {
            let i = from + rel;
            let nl = self.buf[..i].rfind('\n');
            let before = &self.buf[nl.map_or(0, |n| n + 1)..i];
            if before.chars().all(|c| c == ' ' || c == '\t') && (nl.is_some() || !self.mid_line) {
                return Some(i);
            }
            from = i + 1;
        }
        None
    }

    fn take(&mut self, n: usize) -> String {
        let out: String = self.buf.drain(..n).collect();
        if !out.is_empty() {
            self.mid_line = !out.ends_with('\n');
        }
        out
    }

    /// The answer text that's safe to show, and the remarks finished in this chunk.
    pub fn push(&mut self, chunk: &str) -> (String, Vec<String>) {
        self.buf.push_str(chunk);
        let mut text = String::new();
        let mut asides = vec![];
        loop {
            let Some(open) = self.find_open() else {
                let keep = partial_suffix(&self.buf, OPEN);
                text.push_str(&self.take(self.buf.len() - keep));
                break;
            };
            let close = self.buf[open + OPEN.len()..]
                .find(CLOSE)
                .map(|c| c + open + OPEN.len());
            text.push_str(self.take(open).trim_end_matches([' ', '\t'])); // drop the remark's indentation
            let Some(close) = close else { break }; // wait for the rest of the remark
            let end = close - open;
            let aside = self.buf[OPEN.len()..end]
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !aside.is_empty() {
                asides.push(aside);
            }
            let rest = &self.buf[end + CLOSE.len()..];
            let rest = rest.trim_start_matches([' ', '\t']);
            self.buf = rest.strip_prefix('\n').unwrap_or(rest).to_string();
            self.mid_line = false;
        }
        self.asides.extend(asides.iter().cloned());
        (text, asides)
    }

    /// End of stream: a remark that was never closed is shown as plain text rather than lost.
    pub fn flush(&mut self) -> String {
        let rest = std::mem::take(&mut self.buf);
        rest.strip_prefix(OPEN).map(str::to_string).unwrap_or(rest)
    }
}

/// How much of the end of `s` could be the start of `tag`.
pub(super) fn partial_suffix(s: &str, tag: &str) -> usize {
    (1..tag.len().min(s.len() + 1))
        .rev()
        .find(|&n| s.is_char_boundary(s.len() - n) && tag.starts_with(&s[s.len() - n..]))
        .unwrap_or(0)
}

pub fn strip_asides(s: &str) -> String {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(^|\n)[ \t]*<aside>(?s:.*?)</aside>[ \t]*(?:\n|$)").unwrap());
    let re = &*RE;
    re.replace_all(s, "$1").into_owned()
}

#[cfg(test)]
mod killer_tests {
    use super::*;

    fn sleeper() -> std::process::Child {
        Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .no_window()
            .spawn()
            .unwrap()
    }

    #[test]
    fn kills_only_while_it_runs() {
        // once it's said to be gone, its id is left alone (it may be another program's by now)
        let mut a = sleeper();
        let k = Killer::new(a.id());
        k.gone();
        k.kill();
        thread::sleep(Duration::from_millis(300));
        assert!(a.try_wait().unwrap().is_none(), "killed after it was gone");
        crate::platform::process::kill_tree(a.id());
        let _ = a.wait();
        // still running: it's ended, with what it started
        let mut b = sleeper();
        Killer::new(b.id()).kill();
        let ended = (0..50).any(|_| {
            thread::sleep(Duration::from_millis(100));
            b.try_wait().unwrap().is_some()
        });
        assert!(ended, "not killed while running");
    }
}

#[cfg(test)]
mod aside_tests {
    use super::*;

    fn run(chunks: &[&str]) -> (String, Vec<String>) {
        let mut f = AsideFilter::default();
        let mut text = String::new();
        for c in chunks {
            text += &f.push(c).0;
        }
        text += &f.flush();
        (text, f.asides)
    }

    #[test]
    fn pulls_out_remarks_on_their_own_line() {
        let (text, asides) = run(&["Hi!\n<aside>a big  file</aside>\nDone."]);
        assert_eq!(text, "Hi!\nDone.");
        assert_eq!(asides, ["a big file"]);
    }

    #[test]
    fn a_tag_split_across_chunks_is_held_back() {
        let (text, asides) = run(&["Hi!\n<as", "ide>wow</asi", "de>\nok"]);
        assert_eq!(text, "Hi!\nok");
        assert_eq!(asides, ["wow"]);
    }

    #[test]
    fn a_tag_mid_line_is_just_text() {
        let (text, asides) = run(&["use `<aside>` here"]);
        assert_eq!(text, "use `<aside>` here");
        assert!(asides.is_empty());
    }

    #[test]
    fn an_unclosed_remark_is_shown_as_text() {
        assert_eq!(run(&["<aside>never closed"]).0, "never closed");
    }

    #[test]
    fn strip_keeps_the_answer() {
        assert_eq!(strip_asides("<aside>x</aside>\nAnswer"), "Answer");
    }
}

// ---------------------------------------------------------------- tool results

pub(super) const MEDIA: [&str; 2] = ["image", "document"];

/// A tool result's content as text: its text parts and the tools it loaded (its
/// pictures and documents are output_media's).
pub(super) fn output_text(content: &Value) -> String {
    if let Some(t) = content.as_str() {
        return t.to_string();
    }
    let part = |x: &Value| -> String {
        let ty = s(x, "type");
        if ty == "text" {
            s(x, "text").to_string()
        } else if MEDIA.contains(&ty) {
            String::new()
        } else if ty == "tool_reference" {
            let name = if s(x, "tool_name").is_empty() {
                s(x, "name")
            } else {
                s(x, "tool_name")
            };
            format!("Loaded the tool {name}").trim().to_string()
        } else if !ty.is_empty() {
            format!("[{ty}]")
        } else {
            String::new()
        }
    };
    content
        .as_array()
        .map(|a| {
            a.iter()
                .map(part)
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The pictures (Read on an image, a screenshot) and documents (Read on a PDF) in a
/// tool result: [{ kind: image, mimeType, data } | { kind: document, mimeType, size }]
pub(super) fn output_media(content: &Value) -> Value {
    let Some(items) = content.as_array() else {
        return json!([]);
    };
    let mut out = vec![];
    for x in items {
        let src = x.get("source").unwrap_or(&Value::Null);
        let mime = if s(src, "media_type").is_empty() {
            s(x, "mimeType")
        } else {
            s(src, "media_type")
        };
        let data = if src.get("data").is_some_and(Value::is_string) {
            s(src, "data")
        } else {
            s(x, "data")
        };
        let ty = s(x, "type");
        if ty == "image" && !data.is_empty() && is_image_mime(mime) {
            out.push(json!({ "kind": "image", "mimeType": mime, "data": data }));
        } else if ty == "document" {
            let pad = data.len() - data.trim_end_matches('=').len();
            let size = (data.len() * 3 / 4).saturating_sub(pad);
            out.push(json!({ "kind": "document", "mimeType": if mime.is_empty() { "application/pdf" } else { mime }, "size": size }));
        }
    }
    Value::Array(out)
}

pub fn is_image_mime(m: &str) -> bool {
    m.strip_prefix("image/").is_some_and(|t| {
        !t.is_empty() && t.chars().all(|c| c.is_alphanumeric() || "_.+-".contains(c))
    })
}

pub(super) fn result_text(content: &Value) -> String {
    match content {
        Value::String(t) => t.clone(),
        Value::Array(a) => a.iter().map(|x| s(x, "text")).collect(),
        _ => String::new(),
    }
}

/// A file change Claude Code made (Edit, MultiEdit, Write), from its tool result: hunks of
/// unified-diff lines (" " kept, "-" removed, "+" added), as its terminal shows them.
pub(super) fn edit_diff(r: &Value) -> Option<Diff> {
    const MAX_LINES: usize = 400;
    let file = r.get("filePath")?.as_str()?;
    let created = s(r, "type") == "create";
    let mut hunks: Vec<Value> = r
        .get("structuredPatch")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if hunks.is_empty()
        && created
        && let Some(content) = r.get("content").and_then(Value::as_str)
    {
        let body = content
            .strip_suffix("\r\n")
            .or_else(|| content.strip_suffix('\n'))
            .unwrap_or(content);
        let lines: Vec<Value> = body
            .split('\n')
            .map(|l| json!(format!("+{}", l.strip_suffix('\r').unwrap_or(l))))
            .collect();
        hunks = vec![json!({ "oldStart": 0, "newStart": 1, "lines": lines })];
    }
    if hunks.is_empty() {
        return None;
    }
    let (mut budget, mut added, mut removed, mut truncated) = (MAX_LINES, 0, 0, false);
    let mut out = vec![];
    for h in &hunks {
        let lines: Vec<String> = h["lines"]
            .as_array()
            .map(|l| {
                l.iter()
                    .map(|x| {
                        x.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| x.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();
        for l in &lines {
            if l.starts_with('+') {
                added += 1;
            } else if l.starts_with('-') {
                removed += 1;
            }
        }
        if budget == 0 {
            truncated = true;
            continue;
        }
        let kept: Vec<String> = lines
            .iter()
            .take(budget)
            .map(|l| {
                if l.chars().count() > 400 {
                    format!("{}…", l.chars().take(400).collect::<String>())
                } else {
                    l.clone()
                }
            })
            .collect();
        if kept.len() < lines.len() {
            truncated = true;
        }
        budget -= kept.len();
        out.push(Hunk {
            old_start: h["oldStart"].as_i64().unwrap_or(0),
            new_start: h["newStart"].as_i64().unwrap_or(0),
            lines: kept,
        });
    }
    Some(Diff {
        id: String::new(),
        file: file.to_string(),
        created,
        added,
        removed,
        hunks: out,
        truncated,
    })
}
