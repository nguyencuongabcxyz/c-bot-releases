//! Past conversations (src/main/sessions.js). Claude Code keeps every conversation as
//! a JSONL transcript under ~/.claude/projects/<folder with every non-alphanumeric char
//! turned into "-">/<sessionId>.jsonl. That includes the robot's own sessions and
//! anything run in a terminal in the same folder.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde_json::{json, Value};

const BIG_FILE: u64 = 2 * 1024 * 1024; // only skim the head and tail of transcripts larger than this

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

pub fn project_dir(folder: &str) -> PathBuf {
    let name: String = folder.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".claude").join("projects").join(name)
}

/// Throw a conversation's transcript away (a temporary chat closed): its JSONL, and the
/// folder of its helpers' transcripts beside it.
pub fn forget(folder: &str, session_id: &str) {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return; // (a session id, nothing that could point elsewhere)
    }
    let dir = project_dir(folder);
    let _ = fs::remove_file(dir.join(format!("{session_id}.jsonl")));
    let _ = fs::remove_dir_all(dir.join(session_id));
}

fn read_slice(file: &Path, size: u64) -> String {
    if size <= BIG_FILE {
        return fs::read_to_string(file).unwrap_or_default();
    }
    let half = (BIG_FILE / 2) as usize;
    let Ok(mut f) = fs::File::open(file) else { return String::new() };
    let (mut head, mut tail) = (vec![0u8; half], vec![0u8; half]);
    let _ = f.read_exact(&mut head);
    let _ = f.seek(SeekFrom::Start(size - half as u64)).and_then(|_| f.read_exact(&mut tail));
    // drop the partial lines at the cut
    let h = String::from_utf8_lossy(&head);
    let t = String::from_utf8_lossy(&tail);
    format!("{}\n{}", &h[..h.rfind('\n').unwrap_or(0)], &t[t.find('\n').map_or(t.len(), |i| i + 1)..])
}

fn without_reminders(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    re(&RE, r"(?s)<system-reminder>.*?</system-reminder>").replace_all(s, "").into_owned()
}

/// Claude Code also writes messages *as the user* that the user never typed: notices
/// about background tasks (origin "task-notification") and messages from other Claude
/// sessions (origin "peer"). Only origin "human" is really the user. Older transcripts
/// have no origin, so they're also recognised by their tags. Returns a short note to
/// show instead, Some("") to show nothing, or None when it's the user's own words.
pub fn automatic_note(entry: &Value, raw: &str) -> Option<String> {
    static SUMMARY: OnceLock<Regex> = OnceLock::new();
    let kind = entry["origin"]["kind"].as_str().unwrap_or("");
    let text = without_reminders(raw); // look past hidden reminders
    let lead = text.trim_start();
    // (a message from another session can arrive marked "human": its tags win)
    if kind == "human" && !(lead.starts_with("<task-notification>") || lead.starts_with("<cross-session-message")) {
        return None;
    }
    if kind == "task-notification" || lead.starts_with("<task-notification>") {
        let summary = re(&SUMMARY, r"(?s)<summary>(.*?)</summary>").captures(&text).map(|c| c[1].split_whitespace().collect::<Vec<_>>().join(" "));
        return Some(summary.filter(|s| !s.is_empty()).map(|s| format!("🔔 {s}")).unwrap_or_default());
    }
    if kind == "peer" || lead.starts_with("Another Claude session sent a message") || lead.starts_with("<cross-session-message") {
        return Some("📨 A message from another Claude session".into());
    }
    if !kind.is_empty() {
        return Some(String::new()); // some other automatic kind: not the user's words
    }
    None
}

/// What the user actually typed, minus the scaffolding Claude Code wraps around it.
fn clean_user_text(text: &str) -> String {
    static CMD: OnceLock<Regex> = OnceLock::new();
    static PASTED: OnceLock<Regex> = OnceLock::new();
    if text.is_empty() || text.trim_start().starts_with("<task-notification>") {
        return String::new();
    }
    // (its args count only right after the name, as sessions.js reads them)
    if let Some(c) = re(&CMD, r"(?s)<command-name>\s*([^<]+)</command-name>(?:<command-args>(.*?)</command-args>)?").captures(text) {
        let args = c.get(2).map(|a| a.as_str().trim()).unwrap_or("");
        return if args.is_empty() { c[1].trim().to_string() } else { format!("{} {args}", c[1].trim()) };
    }
    let lead = text.trim_start();
    if ["<local-command-stdout", "<local-command-stderr", "<bash-stdout", "<bash-stderr"].iter().any(|t| lead.starts_with(t)) {
        return String::new();
    }
    let text = without_reminders(text);
    re(&PASTED, r"(?s)<pasted_content[^>]*>.*?</pasted_content[^>]*>").replace_all(&text, "[pasted text]").trim().to_string()
}

struct Parsed {
    title: Option<String>,
    messages: Vec<Value>,
}

fn parse_transcript(text: &str) -> Parsed {
    static ASIDE: OnceLock<Regex> = OnceLock::new();
    static ANSWER: OnceLock<Regex> = OnceLock::new();
    let aside = re(&ASIDE, r"(^|\n)[ \t]*<aside>((?s:.*?))</aside>[ \t]*(?:\n|$)");
    let mut messages: Vec<Value> = vec![];
    let (mut title, mut summary): (Option<String>, Option<String>) = (None, None);
    let mut cur: Option<usize> = None; // the assistant message being added to
    let mut asked: HashMap<String, Value> = HashMap::new(); // tool_use id -> questions, to pair with the answers
    for line in text.split('\n') {
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        let ty = o["type"].as_str().unwrap_or("");
        if ty == "custom-title" && o["customTitle"].is_string() {
            title = o["customTitle"].as_str().map(str::to_string);
        } else if ty == "summary" && o["summary"].is_string() {
            summary = o["summary"].as_str().map(str::to_string);
        }
        if (ty != "user" && ty != "assistant") || o["isSidechain"].as_bool() == Some(true) || o["isMeta"].as_bool() == Some(true) {
            continue;
        }
        let content = &o["message"]["content"];
        if ty == "user" {
            if let Some(blocks) = content.as_array().filter(|b| !b.is_empty() && b.iter().all(|x| x["type"] == "tool_result")) {
                for b in blocks {
                    let Some(questions) = asked.get(b["tool_use_id"].as_str().unwrap_or("")) else { continue };
                    let result = match &b["content"] {
                        Value::String(t) => t.clone(),
                        Value::Array(a) => a.iter().map(|x| x["text"].as_str().unwrap_or("")).collect(),
                        _ => String::new(),
                    };
                    let picked: HashMap<String, String> = re(&ANSWER, r#""([^"]+)"="([^"]*)""#).captures_iter(&result).map(|c| (c[1].to_string(), c[2].to_string())).collect();
                    let items: Vec<Value> = questions.as_array().into_iter().flatten().map(|q| {
                        let answer = picked.get(q["question"].as_str().unwrap_or("")).cloned().unwrap_or_else(|| "(no answer)".into());
                        json!({ "question": q["question"], "header": q["header"], "answer": answer })
                    }).collect();
                    messages.push(json!({ "role": "qa", "items": items }));
                    cur = None;
                }
                continue;
            }
            let raw = match content {
                Value::String(t) => t.clone(),
                Value::Array(a) => a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            };
            if let Some(note) = automatic_note(&o, &raw) {
                if !note.is_empty() {
                    messages.push(json!({ "role": "note", "text": note, "at": o["timestamp"] }));
                }
                cur = None;
                continue;
            }
            let clean = clean_user_text(&raw);
            if clean.is_empty() {
                continue;
            }
            cur = None;
            messages.push(json!({ "role": "user", "text": clean, "at": o["timestamp"] }));
        } else {
            let idx = *cur.get_or_insert_with(|| {
                messages.push(json!({ "role": "assistant", "text": "", "tools": [], "asides": [], "at": o["timestamp"] }));
                messages.len() - 1
            });
            for b in content.as_array().into_iter().flatten() {
                let m = &mut messages[idx];
                match b["type"].as_str() {
                    Some("text") if !b["text"].as_str().unwrap_or("").trim().is_empty() => {
                        // the robot's running commentary lives in <aside> tags on their own lines; keep it apart from the answer
                        let raw = b["text"].as_str().unwrap_or("");
                        for c in aside.captures_iter(raw) {
                            let a = c[2].split_whitespace().collect::<Vec<_>>().join(" ");
                            m["asides"].as_array_mut().unwrap().push(json!(a));
                        }
                        let text = aside.replace_all(raw, "$1").trim().to_string();
                        if !text.is_empty() {
                            let joined = match m["text"].as_str().unwrap_or("") {
                                "" => text,
                                before => format!("{before}\n\n{text}"),
                            };
                            m["text"] = json!(joined);
                        }
                    }
                    Some("tool_use") => {
                        let name = b["name"].as_str().unwrap_or("");
                        let label = match b["input"]["skill"].as_str() {
                            Some(skill) if name == "Skill" => format!("Skill({skill})"),
                            _ => name.to_string(),
                        };
                        m["tools"].as_array_mut().unwrap().push(json!(label));
                        if name == "AskUserQuestion" && b["input"]["questions"].is_array() {
                            asked.insert(b["id"].as_str().unwrap_or("").to_string(), b["input"]["questions"].clone());
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    messages.retain(|m| m["role"] != "assistant" || !m["text"].as_str().unwrap_or("").is_empty() || m["tools"].as_array().is_some_and(|t| !t.is_empty()));
    let first_prompt = messages.iter().find(|m| m["role"] == "user").and_then(|m| m["text"].as_str()).map(str::to_string);
    Parsed { title: title.or(summary).or(first_prompt), messages }
}

fn one_line(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Past conversations for a folder, newest first.
pub fn list(folder: &str, robot_session_ids: &[String], limit: usize) -> Vec<Value> {
    static CACHE: Mutex<Option<HashMap<PathBuf, (String, Value)>>> = Mutex::new(None);
    let Ok(dir) = fs::read_dir(project_dir(folder)) else { return vec![] };
    let mine: HashSet<&String> = robot_session_ids.iter().collect();
    let now = crate::store::now_ms() as f64;
    let mut out = vec![];
    for entry in dir.filter_map(|e| e.ok()) {
        let file = entry.path();
        let Some(id) = file.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let (size, mtime) = (meta.len(), mtime_ms(&meta));
        let key = format!("{size}:{mtime}");
        let cached = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&file).filter(|(k, _)| *k == key).map(|(_, v)| v.clone());
        let info = cached.unwrap_or_else(|| {
            let parsed = parse_transcript(&read_slice(&file, size));
            let last_prompt = parsed.messages.iter().rev().find(|m| m["role"] == "user").and_then(|m| m["text"].as_str()).unwrap_or("");
            let info = json!({
                "title": one_line(parsed.title.as_deref().unwrap_or("Untitled conversation"), 80),
                "preview": one_line(last_prompt, 120),
                "messages": if size > BIG_FILE { Value::Null } else { json!(parsed.messages.len()) },
            });
            CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(file.clone(), (key, info.clone()));
            info
        });
        if info["messages"] == 0 {
            continue; // nothing anyone said
        }
        let mut row = info;
        row["id"] = json!(id);
        row["updatedAt"] = json!(mtime);
        row["size"] = json!(size);
        row["byRobot"] = json!(mine.contains(&id));
        row["active"] = json!(now - mtime < 90_000.0);
        out.push(row);
    }
    out.sort_by(|a, b| b["updatedAt"].as_f64().partial_cmp(&a["updatedAt"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    out
}

/// The readable part of one conversation (its most recent `limit` messages).
pub fn read(folder: &str, session_id: &str, limit: usize) -> Option<Value> {
    if session_id.len() != 36 || !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let text = fs::read_to_string(project_dir(folder).join(format!("{session_id}.jsonl"))).ok()?;
    let parsed = parse_transcript(&text);
    let total = parsed.messages.len();
    let messages: Vec<Value> = parsed.messages.into_iter().skip(total.saturating_sub(limit)).map(|mut m| {
        // (question/answer entries have no text)
        if let Some(t) = m["text"].as_str().filter(|t| t.chars().count() > 20000) {
            m["text"] = json!(format!("{}\n\n…", t.chars().take(20000).collect::<String>()));
        }
        m
    }).collect();
    Some(json!({ "id": session_id, "title": one_line(parsed.title.as_deref().unwrap_or("Untitled conversation"), 80), "total": total, "messages": messages }))
}
