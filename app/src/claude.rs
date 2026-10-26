//! A live Claude Code conversation for one tab (src/main/claude.js ClaudeSession): one
//! `claude -p` process that stays open and takes question after question over
//! stream-json. Questions sent while it works wait their turn.
//!
//! What happens is reported to the session's handler as (event, data), the events and
//! data claude.js emits: turn-start · session · initialized · text · aside · thinking ·
//! tool · tool-output · tool-result · edit · agent · status · task · question · compact ·
//! commands · tools · done · fail · exit. They're handed over on a thread of their own,
//! so a handler may wait on the session (context_usage) without holding up its output.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};

use crate::find_claude::NO_WINDOW;

/// When C-Bot itself was started from inside a Claude Code session, it inherits that
/// session's private markers. Passed on, they make every robot's `claude` think it's a
/// helper of that session (e.g. CLAUDE_CODE_CHILD_SESSION turns off transcript saving).
/// Drop them; genuine user settings such as CLAUDE_CODE_GIT_BASH_PATH are kept.
fn host_session_var() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            "(?i)^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\\w*|CLAUDE_AGENT_SDK_\\w*|MCP_SERVER_CONNECTION_BATCH_SIZE|MCP_CONNECTION_NONBLOCKING",
            "|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|SESSION_ATTENDED|ENTRYPOINT\\w*|EXECPATH|DESKTOP_APP_VERSION",
            "|TERMINAL_MCP_TOOLS|REPORT_FINDINGS|EAGER_FLUSH|DISABLE_TERMINAL_TITLE|DISABLE_CRON|STARTUP_FAILURE_RESULTS|SIMPLE",
            "|OAUTH_SCOPES|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|MESSAGING_\\w*|EMIT_\\w*|SDK_\\w*|ENABLE_SDK_\\w*|ENABLE_ASK_USER_QUESTION_TOOL))$",
        ))
        .unwrap()
    })
}

pub fn clean_env() -> Vec<(String, String)> {
    std::env::vars().filter(|(k, _)| !host_session_var().is_match(k)).collect()
}

/// Ends a process and everything it started. Only while its Child is still held: once that's
/// dropped, Windows may give the id to another program. From another thread, use a Killer.
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).creation_flags(NO_WINDOW).output();
}

/// Ends a child process and everything it started, from any thread, but only while it's still
/// running. The thread waiting on it calls gone() as soon as it has exited, before it drops
/// the Child: the process stays held until then, so its id can't have gone to another program,
/// and a kill that's under way keeps it held until it's done.
#[derive(Clone)]
pub struct Killer {
    pid: u32,
    gone: Arc<Mutex<bool>>,
}

impl Killer {
    pub fn new(pid: u32) -> Killer {
        Killer { pid, gone: Arc::new(Mutex::new(false)) }
    }

    /// End it, unless it has exited already.
    pub fn kill(&self) {
        let gone = self.gone.lock().unwrap_or_else(|e| e.into_inner());
        if !*gone {
            kill_tree(self.pid);
        }
    }

    /// It has exited (call it before dropping the Child).
    pub fn gone(&self) {
        *self.gone.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }
}

// ---------------------------------------------------------------- describing steps

/// "anthropic-skills:pptx" -> "pptx (anthropic-skills)"
pub fn skill_label(skill: &str) -> String {
    match skill.rfind(':') {
        Some(i) if i > 0 => format!("{} ({})", &skill[i + 1..], &skill[..i]),
        _ => skill.to_string(),
    }
}

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    } else {
        s
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// What a step is about, in a few words ("main.rs", "npm test", a search pattern…).
pub fn describe_tool(name: &str, input: &Value) -> String {
    let base = |p: &str| p.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    match name {
        "Read" | "Write" | "Edit" | "NotebookEdit" => base(if s(input, "file_path").is_empty() { s(input, "notebook_path") } else { s(input, "file_path") }),
        "Bash" | "PowerShell" => short(if s(input, "description").is_empty() { s(input, "command") } else { s(input, "description") }, 48),
        "Grep" | "Glob" => short(s(input, "pattern"), 32),
        "WebSearch" => short(s(input, "query"), 48),
        "WebFetch" => {
            let url = s(input, "url");
            url.split_once("://").and_then(|(_, rest)| rest.split('/').next()).filter(|h| !h.is_empty()).map(str::to_string).unwrap_or_else(|| short(url, 48))
        }
        "Task" | "Agent" => short(s(input, "description"), 48),
        "TodoWrite" => "updating the to-do list".into(),
        // (the other robots' tools by their short names)
        "ToolSearch" => short(&s(input, "query").trim_start_matches("select:").replace("mcp__cbot__", "").split(',').collect::<Vec<_>>().join(", "), 48),
        "TaskCreate" => short(s(input, "subject"), 48),
        "TaskUpdate" => {
            let id = input.get("taskId").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
            let status = s(input, "status");
            if status.is_empty() { format!("#{id}") } else { format!("#{id} → {}", status.replacen('_', " ", 1)) }
        }
        "Skill" => skill_label(if s(input, "skill").is_empty() { s(input, "name") } else { s(input, "skill") }),
        "mcp__cbot__ask_robot" => format!("{}: {}", s(input, "robot"), short(s(input, "message"), 48)),
        "mcp__cbot__hand_off_task" => format!("{}: {}", s(input, "robot"), short(s(input, "title"), 48)),
        "mcp__cbot__list_words" => short(s(input, "query"), 32),
        "mcp__cbot__save_words" => {
            let words: Vec<String> = input.get("words").and_then(Value::as_array).map(|a| a.iter().filter_map(|w| w.as_str().map(str::to_string)).collect()).unwrap_or_default();
            short(&words.join(", "), 48)
        }
        "mcp__cbot__add_note" => short(s(input, "text"), 48),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- asides

const OPEN: &str = "<aside>";
const CLOSE: &str = "</aside>";

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
            let close = self.buf[open + OPEN.len()..].find(CLOSE).map(|c| c + open + OPEN.len());
            text.push_str(self.take(open).trim_end_matches([' ', '\t'])); // drop the remark's indentation
            let Some(close) = close else { break }; // wait for the rest of the remark
            let end = close - open;
            let aside = self.buf[OPEN.len()..end].split_whitespace().collect::<Vec<_>>().join(" ");
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
fn partial_suffix(s: &str, tag: &str) -> usize {
    (1..tag.len().min(s.len() + 1)).rev().find(|&n| s.is_char_boundary(s.len() - n) && tag.starts_with(&s[s.len() - n..])).unwrap_or(0)
}

pub fn strip_asides(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(^|\n)[ \t]*<aside>(?s:.*?)</aside>[ \t]*(?:\n|$)").unwrap());
    re.replace_all(s, "$1").into_owned()
}

#[cfg(test)]
mod killer_tests {
    use super::*;

    fn sleeper() -> std::process::Child {
        Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 >nul"]).creation_flags(NO_WINDOW).spawn().unwrap()
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
        kill_tree(a.id());
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

const MEDIA: [&str; 2] = ["image", "document"];

/// A tool result's content as text: its text parts and the tools it loaded (its
/// pictures and documents are output_media's).
fn output_text(content: &Value) -> String {
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
            let name = if s(x, "tool_name").is_empty() { s(x, "name") } else { s(x, "tool_name") };
            format!("Loaded the tool {name}").trim().to_string()
        } else if !ty.is_empty() {
            format!("[{ty}]")
        } else {
            String::new()
        }
    };
    content.as_array().map(|a| a.iter().map(part).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

/// The pictures (Read on an image, a screenshot) and documents (Read on a PDF) in a
/// tool result: [{ kind: image, mimeType, data } | { kind: document, mimeType, size }]
fn output_media(content: &Value) -> Value {
    let Some(items) = content.as_array() else { return json!([]) };
    let mut out = vec![];
    for x in items {
        let src = x.get("source").unwrap_or(&Value::Null);
        let mime = if s(src, "media_type").is_empty() { s(x, "mimeType") } else { s(src, "media_type") };
        let data = if src.get("data").is_some_and(Value::is_string) { s(src, "data") } else { s(x, "data") };
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
    m.strip_prefix("image/").is_some_and(|t| !t.is_empty() && t.chars().all(|c| c.is_alphanumeric() || "_.+-".contains(c)))
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(t) => t.clone(),
        Value::Array(a) => a.iter().map(|x| s(x, "text")).collect(),
        _ => String::new(),
    }
}

/// A file change Claude Code made (Edit, MultiEdit, Write), from its tool result: hunks of
/// unified-diff lines (" " kept, "-" removed, "+" added), as its terminal shows them.
fn edit_diff(r: &Value) -> Option<Value> {
    const MAX_LINES: usize = 400;
    let file = r.get("filePath")?.as_str()?;
    let created = s(r, "type") == "create";
    let mut hunks: Vec<Value> = r.get("structuredPatch").and_then(Value::as_array).cloned().unwrap_or_default();
    if hunks.is_empty() && created && let Some(content) = r.get("content").and_then(Value::as_str) {
        let body = content.strip_suffix("\r\n").or_else(|| content.strip_suffix('\n')).unwrap_or(content);
        let lines: Vec<Value> = body.split('\n').map(|l| json!(format!("+{}", l.strip_suffix('\r').unwrap_or(l)))).collect();
        hunks = vec![json!({ "oldStart": 0, "newStart": 1, "lines": lines })];
    }
    if hunks.is_empty() {
        return None;
    }
    let (mut budget, mut added, mut removed, mut truncated) = (MAX_LINES, 0, 0, false);
    let mut out = vec![];
    for h in &hunks {
        let lines: Vec<String> = h["lines"].as_array().map(|l| l.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
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
        let kept: Vec<String> = lines.iter().take(budget).map(|l| if l.chars().count() > 400 { format!("{}…", l.chars().take(400).collect::<String>()) } else { l.clone() }).collect();
        if kept.len() < lines.len() {
            truncated = true;
        }
        budget -= kept.len();
        out.push(json!({ "oldStart": h["oldStart"].as_i64().unwrap_or(0), "newStart": h["newStart"].as_i64().unwrap_or(0), "lines": kept }));
    }
    Some(json!({ "file": file, "created": created, "added": added, "removed": removed, "hunks": out, "truncated": truncated }))
}

// ---------------------------------------------------------------- the session

/// Talks to the real Claude Code (it uses your account): `cargo test -- --ignored`.
#[cfg(test)]
mod live_tests {
    use super::*;

    #[test]
    #[ignore]
    fn asks_and_hears_back() {
        let claude = crate::find_claude::find("").expect("Claude Code installed");
        let dir = std::env::temp_dir().join("cbot-session-test");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let handler: Handler = Arc::new(move |_, event, data| {
            let _ = tx.lock().unwrap().send((event.to_string(), data));
        });
        let opts = Opts { claude_path: claude, cwd: dir.to_string_lossy().into(), model: "haiku".into(), ..Default::default() };
        let session = Session::new(opts, None, handler);
        assert!(!session.ask("Reply with exactly the word: pong".into(), "t1".into()));
        let mut seen = vec![];
        let done = loop {
            let (event, data) = rx.recv_timeout(Duration::from_secs(120)).expect("an answer in time");
            seen.push(event.clone());
            match event.as_str() {
                "done" => break data,
                "fail" => panic!("failed: {data}"),
                _ => {}
            }
        };
        assert_eq!(done["turnId"], "t1");
        assert!(done["text"].as_str().unwrap().to_lowercase().contains("pong"), "{done}");
        assert!(seen.contains(&"turn-start".to_string()) && seen.contains(&"text".to_string()) && seen.contains(&"session".to_string()), "{seen:?}");
        let usage = session.context_usage().expect("context usage");
        assert!(usage["totalTokens"].as_f64().unwrap_or(0.0) > 0.0, "{usage}");
        session.close();
    }
}

// Claude Code's task tools, which print mode leaves out unless asked for.
const TASK_TOOLS: [&str; 4] = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
pub struct Opts {
    pub claude_path: PathBuf,
    pub cwd: String,
    pub system_prompt: String,
    pub permission_mode: String,
    pub model: String,
    pub effort: String,
    pub add_dirs: Vec<String>,
    pub tools: Option<Vec<String>>, // Claude Code's default tools, once known (the task tools go with them)
    pub env: Vec<(String, String)>,
    pub mcp_config: String,         // an --mcp-config file to add (the other robots' tools, robotlink.rs)
    pub allowed_tools: Vec<String>, // tools it may use without asking
    pub extra_args: Vec<String>,    // more command-line flags (the group chat's --strict-mcp-config)
}

pub type Handler = Arc<dyn Fn(&Arc<Session>, &str, Value) + Send + Sync>;
type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;

struct Turn {
    id: String,
    interrupted: bool,
}

struct Proc {
    generation: u64,
    killer: Killer,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<String>>,
}

struct Inner {
    opts: Opts,
    session_id: Option<String>,
    queue: VecDeque<(String, String)>, // turns waiting: (id, prompt)
    turn: Option<Turn>,
    pending_questions: HashMap<String, Value>, // request id -> the AskUserQuestion input
    controls: HashMap<String, Reply>,
    task_inputs: HashMap<String, Value>, // tool_use id -> TaskCreate input, to learn its number
    agent_tools: HashSet<String>,       // tool_use ids of Agent calls (each one is a helper agent)
    agent_tasks: HashMap<String, String>, // background task id -> the Agent tool_use id
    agent_running: HashSet<String>,     // Agent tool_use ids still at work
    cost_so_far: f64,                   // total_cost_usd is cumulative per process
    last_used: Instant,
    proc: Option<Proc>,
    generation: u64,
    restart_before_next: bool,
    closing: bool,
    text: String,
    asides: AsideFilter,
    streamed: HashSet<String>,
    mcp_tool_ids: HashSet<String>,
    auto_turns: u64,
    events: Sender<(String, Value)>,
}

impl Inner {
    fn emit(&self, event: &str, data: Value) {
        let _ = self.events.send((event.to_string(), data));
    }

    fn send(&mut self, msg: &Value) {
        if let Some(stdin) = self.proc.as_mut().and_then(|p| p.stdin.as_mut()) {
            let _ = writeln!(stdin, "{msg}").and_then(|_| stdin.flush());
        }
    }

    fn reply(&mut self, request_id: &str, response: Value) {
        self.send(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }));
    }

    fn control(&mut self, request: Value, done: Reply) {
        if self.proc.is_none() {
            return done(Err("Claude Code is not running".into()));
        }
        let id = format!("cbot-{}", uuid::Uuid::new_v4());
        self.controls.insert(id.clone(), done);
        self.send(&json!({ "type": "control_request", "request_id": id, "request": request }));
    }

    fn append_text(&mut self, t: &str) {
        if t.is_empty() || self.turn.is_none() {
            return;
        }
        let (text, asides) = self.asides.push(t);
        for a in asides {
            self.emit("aside", json!(a));
        }
        self.emit_text(&text);
    }

    fn emit_text(&mut self, t: &str) {
        let t = if self.text.is_empty() { t.trim_start() } else { t }; // an aside at the very start leaves blank lines
        if t.is_empty() {
            return;
        }
        self.text.push_str(t);
        self.emit("text", json!(t));
    }

    fn separate(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with("\n\n") {
            let gap = if self.text.ends_with('\n') { "\n" } else { "\n\n" };
            self.append_text(gap);
        }
    }

    fn begin_turn(&mut self, id: String) {
        self.turn = Some(Turn { id: id.clone(), interrupted: false });
        self.text.clear();
        self.asides = AsideFilter::default();
        self.streamed.clear();
        self.last_used = Instant::now();
        self.emit("turn-start", json!(id));
    }

    fn fail_all(&mut self, message: &str, cancelled: bool, session_missing: bool) {
        let mut ids: Vec<String> = self.turn.take().map(|t| t.id).into_iter().collect();
        ids.extend(self.queue.drain(..).map(|(id, _)| id));
        for id in ids {
            self.emit("fail", json!({ "turnId": id, "message": message, "cancelled": cancelled, "sessionMissing": session_missing }));
        }
    }

    // The to-do card follows Claude Code's task tools (and the older TodoWrite).
    fn task_tool(&mut self, block: &Value) {
        let input = block.get("input").cloned().unwrap_or(json!({}));
        match s(block, "name") {
            "TaskCreate" => {
                self.task_inputs.insert(s(block, "id").to_string(), input);
            }
            "TaskUpdate" if !input["taskId"].is_null() => {
                let id = input["taskId"].as_str().map(str::to_string).unwrap_or_else(|| input["taskId"].to_string());
                self.emit("task", json!({ "op": "update", "id": id, "status": input["status"], "subject": input["subject"], "activeForm": input["activeForm"] }));
            }
            "TodoWrite" => {
                if let Some(todos) = input["todos"].as_array() {
                    let tasks: Vec<Value> = todos.iter().enumerate().map(|(i, t)| json!({ "id": (i + 1).to_string(), "subject": t["content"], "activeForm": t["activeForm"], "status": t["status"] })).collect();
                    self.emit("task", json!({ "op": "replace", "tasks": tasks }));
                }
            }
            _ => {}
        }
    }

    fn task_result(&mut self, block: &Value) {
        let Some(input) = self.task_inputs.remove(s(block, "tool_use_id")) else { return };
        let text = result_text(&block["content"]);
        let id = text.find('#').map(|i| text[i + 1..].chars().take_while(char::is_ascii_digit).collect::<String>()).filter(|d| !d.is_empty());
        if let Some(id) = id {
            self.emit("task", json!({ "op": "create", "id": id, "subject": input["subject"], "activeForm": input["activeForm"], "status": "pending" }));
        }
    }

    fn agent_start(&mut self, block: &Value, parent: Option<&str>) {
        let name = s(block, "name");
        if name != "Agent" && name != "Task" {
            return;
        }
        let input = &block["input"];
        let id = s(block, "id").to_string();
        self.agent_tools.insert(id.clone());
        self.agent_running.insert(id.clone());
        let description = if s(input, "description").is_empty() { "Helper" } else { s(input, "description") };
        self.emit("agent", json!({
            "op": "start", "id": id, "parent": parent, "description": description, "kind": s(input, "subagent_type"),
            "prompt": s(input, "prompt"), "background": input["run_in_background"].as_bool().unwrap_or(false),
        }));
    }

    // A helper agent's own steps and words: shown in its card, not voiced by the robot.
    fn agent_chatter(&mut self, msg: &Value) {
        let id = s(msg, "parent_tool_use_id").to_string();
        if s(msg, "type") != "assistant" {
            return;
        }
        for block in msg["message"]["content"].as_array().cloned().unwrap_or_default() {
            match s(&block, "type") {
                "tool_use" => {
                    self.agent_start(&block, Some(&id)); // a helper sending its own helper
                    self.emit("agent", json!({ "op": "step", "id": id, "tool": block["name"], "detail": describe_tool(s(&block, "name"), &block["input"]) }));
                }
                "text" if !s(&block, "text").trim().is_empty() => {
                    self.emit("agent", json!({ "op": "text", "id": id, "text": block["text"] }));
                }
                _ => {}
            }
        }
    }

    // Claude Code's task events for helpers: started, progress, finished
    fn agent_task(&mut self, msg: &Value) {
        let task_id = s(msg, "task_id").to_string();
        let id = if !s(msg, "tool_use_id").is_empty() { s(msg, "tool_use_id").to_string() } else if let Some(id) = self.agent_tasks.get(&task_id) { id.clone() } else { return };
        if !task_id.is_empty() {
            self.agent_tasks.insert(task_id, id.clone());
        }
        let u = &msg["usage"];
        let usage = |mut v: Value| {
            if u.is_object() {
                v["tokens"] = u["total_tokens"].clone();
                v["tools"] = u["tool_uses"].clone();
                v["ms"] = u["duration_ms"].clone();
            }
            v
        };
        self.last_used = Instant::now(); // a helper at work keeps the conversation alive
        match s(msg, "subtype") {
            "task_started" => {
                self.agent_tools.insert(id.clone());
                self.agent_running.insert(id.clone());
                self.emit("agent", json!({ "op": "start", "id": id, "description": msg["description"], "kind": s(msg, "subagent_type"), "prompt": s(msg, "prompt"), "background": msg["is_backgrounded"].as_bool().unwrap_or(false) }));
            }
            "task_progress" => self.emit("agent", usage(json!({ "op": "progress", "id": id, "activity": s(msg, "description") }))),
            "task_updated" if !msg["patch"]["status"].is_null() => self.emit("agent", json!({ "op": "status", "id": id, "status": msg["patch"]["status"] })),
            "task_notification" => {
                self.agent_running.remove(&id);
                let status = if s(msg, "status").is_empty() { "completed" } else { s(msg, "status") };
                self.emit("agent", usage(json!({ "op": "done", "id": id, "status": status, "summary": s(msg, "summary"), "outputFile": s(msg, "output_file") })));
            }
            _ => {}
        }
    }

    // Claude Code asks before using a tool its permission mode doesn't cover. Questions
    // for the user are passed on; everything else is refused, as in plain print mode.
    fn control_request(&mut self, msg: &Value) {
        let req = &msg["request"];
        let request_id = s(msg, "request_id").to_string();
        if s(req, "subtype") != "can_use_tool" {
            let error = format!("Unsupported request: {}", s(req, "subtype"));
            self.send(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } }));
            return;
        }
        if s(req, "tool_name") == "AskUserQuestion" && req["input"]["questions"].is_array() {
            self.pending_questions.insert(request_id.clone(), req["input"].clone());
            self.emit("question", json!({ "requestId": request_id, "questions": req["input"]["questions"] }));
            return;
        }
        let mode = if self.opts.permission_mode.is_empty() { "default" } else { &self.opts.permission_mode };
        let message = format!("{} needs permission this robot doesn't have (mode: {mode}).", s(req, "tool_name"));
        self.reply(&request_id, json!({ "behavior": "deny", "message": message }));
    }
}

pub struct Session {
    inner: Mutex<Inner>,
    me: Weak<Session>,
}

impl Session {
    pub fn new(opts: Opts, session_id: Option<String>, handler: Handler) -> Arc<Session> {
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let session = Arc::new_cyclic(|me| Session {
            me: me.clone(),
            inner: Mutex::new(Inner {
                opts, session_id, queue: VecDeque::new(), turn: None, pending_questions: HashMap::new(), controls: HashMap::new(),
                task_inputs: HashMap::new(), agent_tools: HashSet::new(), agent_tasks: HashMap::new(), agent_running: HashSet::new(),
                cost_so_far: 0.0, last_used: Instant::now(), proc: None, generation: 0, restart_before_next: false, closing: false,
                text: String::new(), asides: AsideFilter::default(), streamed: HashSet::new(), mcp_tool_ids: HashSet::new(), auto_turns: 0,
                events: tx,
            }),
        });
        // events are handed to the handler one after another, on this thread
        let me = Arc::downgrade(&session);
        thread::spawn(move || {
            while let Ok((event, data)) = rx.recv() {
                let Some(session) = me.upgrade() else { break };
                handler(&session, &event, data);
            }
        });
        session
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn alive(&self) -> bool {
        self.lock().proc.is_some()
    }
    pub fn busy(&self) -> bool {
        self.lock().turn.is_some()
    }
    /// Helper agents still at work (they can outlive the answer that sent them).
    pub fn helpers_running(&self) -> usize {
        self.lock().agent_running.len()
    }
    pub fn idle_for(&self) -> Duration {
        self.lock().last_used.elapsed()
    }
    pub fn session_id(&self) -> Option<String> {
        self.lock().session_id.clone()
    }
    pub fn forget_session(&self) {
        self.lock().session_id = None;
    }

    /// Start its process now, before the first question (the group chat gets everyone's
    /// Claude Code ready before they speak).
    pub fn warm(&self) {
        let mut i = self.lock();
        if i.proc.is_none() && !i.closing {
            self.start(&mut i);
        }
    }

    fn start(&self, i: &mut Inner) {
        let o = i.opts.clone();
        // stdin stays open: questions go in as stream-json messages, and tool permission
        // requests come back to us ("stdio") so questions can be answered
        let mut args: Vec<String> = [
            "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--input-format", "stream-json", "--permission-prompt-tool", "stdio",
        ]
        .map(String::from)
        .to_vec();
        let mut flag = |k: &str, v: &str| {
            if !v.is_empty() {
                args.push(k.into());
                args.push(v.into());
            }
        };
        flag("--permission-mode", &o.permission_mode);
        flag("--append-system-prompt", &o.system_prompt);
        flag("--resume", i.session_id.as_deref().unwrap_or(""));
        flag("--model", &o.model);
        flag("--effort", &o.effort);
        // the default tools plus the task tools (for the to-do card), once we know the defaults
        if let Some(tools) = o.tools.as_ref().filter(|t| !t.is_empty()) {
            let mut all: Vec<String> = tools.clone();
            for t in TASK_TOOLS {
                if !all.iter().any(|x| x == t) {
                    all.push(t.into());
                }
            }
            flag("--tools", &all.join(","));
        }
        // folders of files fed to the robot, so Claude Code may read them
        for dir in &o.add_dirs {
            flag("--add-dir", dir);
        }
        // the other robots' tools (robotlink.rs), usable without asking
        flag("--mcp-config", &o.mcp_config);
        flag("--allowedTools", &o.allowed_tools.join(","));
        args.extend(o.extra_args.iter().cloned());

        i.cost_so_far = 0.0;
        i.restart_before_next = false;
        let spawned = Command::new(&o.claude_path)
            .args(&args)
            .current_dir(&o.cwd)
            .env_clear()
            .envs(clean_env())
            .envs(o.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(NO_WINDOW)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(err) => return i.fail_all(&format!("Couldn't start Claude Code: {err}"), false, false),
        };
        i.generation += 1;
        let generation = i.generation;
        let stderr = Arc::new(Mutex::new(String::new()));
        let (stdout, err_pipe) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let killer = Killer::new(child.id());
        i.proc = Some(Proc { generation, killer: killer.clone(), stdin: child.stdin.take(), stderr: stderr.clone() });

        thread::spawn(move || {
            let mut err_pipe = err_pipe;
            let mut buf = String::new();
            let _ = err_pipe.read_to_string(&mut buf);
            stderr.lock().unwrap().push_str(&buf);
        });
        let me = self.me.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some(session) = me.upgrade() else { return };
                session.line(line);
            }
            let code = child.wait().ok().and_then(|s| s.code());
            killer.gone();
            drop(child);
            if let Some(session) = me.upgrade() {
                session.closed(generation, code);
            }
        });
        // learn the available models, effort levels and command descriptions
        let events = i.events.clone();
        i.control(json!({ "subtype": "initialize" }), Box::new(move |r| {
            if let Ok(info) = r {
                let _ = events.send(("initialized".into(), info));
            }
        }));
    }

    fn closed(&self, generation: u64, code: Option<i32>) {
        let replies: Vec<Reply> = {
            let mut i = self.lock();
            if i.proc.as_ref().map(|p| p.generation) != Some(generation) {
                return; // an old process we replaced
            }
            let stderr = i.proc.take().map(|p| p.stderr.lock().unwrap().clone()).unwrap_or_default();
            // helpers die with the process: say so, or their cards would spin forever
            for id in i.agent_running.drain().collect::<Vec<_>>() {
                i.emit("agent", json!({ "op": "done", "id": id, "status": "stopped", "summary": "Stopped: Claude Code closed before this helper finished." }));
            }
            if i.turn.is_some() || !i.queue.is_empty() {
                let msg = if i.closing {
                    "Cancelled.".to_string()
                } else if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else {
                    format!("Claude Code exited with code {}", code.map_or("?".into(), |c| c.to_string()))
                };
                let missing = msg.to_lowercase().contains("no conversation found");
                let closing = i.closing;
                i.fail_all(&msg, closing, missing);
            }
            i.emit("exit", Value::Null);
            i.controls.drain().map(|(_, r)| r).collect()
        };
        for r in replies {
            r(Err("Claude Code closed".into()));
        }
    }

    /// Queue a question; it's sent as soon as the current answer (if any) finishes.
    /// Says whether it has to wait.
    pub fn ask(&self, prompt: String, turn_id: String) -> bool {
        let mut i = self.lock();
        i.last_used = Instant::now();
        i.queue.push_back((turn_id.clone(), prompt));
        if i.turn.is_none() {
            self.next(&mut i);
        }
        i.turn.as_ref().is_some_and(|t| t.id != turn_id)
    }

    fn next(&self, i: &mut Inner) {
        if i.turn.is_some() || i.queue.is_empty() {
            return;
        }
        if i.restart_before_next && i.proc.is_some() {
            self.restart(i);
        }
        if i.proc.is_none() {
            self.start(i);
        }
        if i.proc.is_none() {
            return;
        }
        let (id, prompt) = i.queue.pop_front().unwrap();
        i.begin_turn(id);
        i.send(&json!({ "type": "user", "message": { "role": "user", "content": prompt }, "parent_tool_use_id": null, "session_id": "" }));
    }

    // Swap the process for a fresh one on the same conversation (new folders, new system prompt).
    fn restart(&self, i: &mut Inner) {
        if let Some(mut old) = i.proc.take() {
            old.stdin.take(); // (its input closes: it finishes and goes)
            let killer = old.killer;
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                killer.kill(); // (if it hasn't gone by itself)
            });
        }
        self.start(i);
    }

    /// Stop the current answer. The conversation stays open; waiting questions are returned unsent.
    pub fn interrupt(&self) -> Vec<String> {
        let mut i = self.lock();
        let dropped: Vec<String> = i.queue.drain(..).map(|(id, _)| id).collect();
        if i.proc.is_some() && let Some(t) = i.turn.as_mut() {
            t.interrupted = true;
            i.control(json!({ "subtype": "interrupt" }), Box::new(|_| {}));
        }
        dropped
    }

    /// Cancel one waiting question.
    pub fn unqueue(&self, turn_id: &str) -> bool {
        let mut i = self.lock();
        let before = i.queue.len();
        i.queue.retain(|(id, _)| id != turn_id);
        i.queue.len() != before
    }

    /// Answer this waiting question right away: stop the current answer and jump the queue.
    pub fn send_now(&self, turn_id: &str) -> bool {
        let mut i = self.lock();
        let Some(pos) = i.queue.iter().position(|(id, _)| id == turn_id) else { return false };
        let t = i.queue.remove(pos).unwrap();
        i.queue.push_front(t);
        if i.proc.is_some() && let Some(t) = i.turn.as_mut() {
            t.interrupted = true;
            i.control(json!({ "subtype": "interrupt" }), Box::new(|_| {}));
        }
        true
    }

    /// Ask the running process something and wait for its answer (not from the handler
    /// of an event that the answer would have to come after).
    fn control_wait(&self, request: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.lock().control(request, Box::new(move |r| {
            let _ = tx.send(r);
        }));
        rx.recv_timeout(CONTROL_TIMEOUT).map_err(|_| "Claude Code didn't answer in time".to_string())?
    }

    pub fn set_model(&self, model: &str) -> Result<(), String> {
        let alive = {
            let mut i = self.lock();
            i.opts.model = model.into();
            i.proc.is_some()
        };
        if alive {
            self.control_wait(json!({ "subtype": "set_model", "model": if model.is_empty() { "default" } else { model } }))?;
        }
        Ok(())
    }

    pub fn set_effort(&self, effort: &str) -> Result<(), String> {
        let alive = {
            let mut i = self.lock();
            i.opts.effort = effort.into();
            i.proc.is_some()
        };
        if alive {
            let level = if effort.is_empty() { Value::Null } else { json!(effort) };
            self.control_wait(json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }))?;
        }
        Ok(())
    }

    pub fn set_permission_mode(&self, mode: &str) {
        let mut i = self.lock();
        i.opts.permission_mode = mode.into();
        if i.proc.is_some() {
            i.control(json!({ "subtype": "set_permission_mode", "mode": mode }), Box::new(|_| {}));
        }
    }

    /// The default tools, learnt from Claude Code: picked up by a fresh process before the next question.
    pub fn set_tools(&self, tools: Vec<String>) {
        let mut i = self.lock();
        i.opts.tools = Some(tools);
        i.restart_before_next = true;
    }

    // Changes that only a new process can pick up are applied before the next question.
    pub fn set_system_prompt(&self, prompt: &str) {
        let mut i = self.lock();
        if i.opts.system_prompt == prompt {
            return;
        }
        i.opts.system_prompt = prompt.into();
        i.restart_before_next = i.proc.is_some();
    }

    pub fn allow_dirs(&self, dirs: &[String]) {
        let mut i = self.lock();
        let fresh: Vec<String> = dirs.iter().filter(|d| !i.opts.add_dirs.contains(d)).cloned().collect();
        if fresh.is_empty() {
            return;
        }
        i.opts.add_dirs.extend(fresh);
        i.restart_before_next = i.proc.is_some();
    }

    /// How full its context is (Claude Code's get_context_usage), if it's running.
    pub fn context_usage(&self) -> Option<Value> {
        if !self.alive() {
            return None;
        }
        self.control_wait(json!({ "subtype": "get_context_usage" })).ok()
    }

    /// answers: { [question text]: "Label" | "Label, Other label" | free text }
    pub fn answer(&self, request_id: &str, answers: Value) -> bool {
        let mut i = self.lock();
        if i.proc.is_none() {
            return false;
        }
        let Some(mut input) = i.pending_questions.remove(request_id) else { return false };
        input["answers"] = answers;
        i.reply(request_id, json!({ "behavior": "allow", "updatedInput": input }));
        true
    }

    /// End the process. Anything still running or waiting fails as cancelled.
    pub fn close(&self) {
        let mut i = self.lock();
        i.closing = true;
        let busy = i.turn.is_some();
        let Some(p) = i.proc.as_mut() else { return };
        p.stdin.take();
        let killer = p.killer.clone();
        thread::spawn(move || {
            if !busy {
                thread::sleep(Duration::from_secs(3));
            }
            killer.kill(); // (if it hasn't gone by itself)
        });
    }

    fn line(&self, line: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else { return };
        let mut i = self.lock();
        if s(&msg, "type") == "control_response" {
            let r = &msg["response"];
            if let Some(reply) = i.controls.remove(s(r, "request_id")) {
                drop(i);
                if s(r, "subtype") == "success" {
                    reply(Ok(r.get("response").cloned().unwrap_or(json!({}))));
                } else {
                    reply(Err(if s(r, "error").is_empty() { "control request failed".into() } else { s(r, "error").to_string() }));
                }
            }
            return;
        }
        // A helper agent's own steps and words: shown in its card, not voiced by the robot.
        if !s(&msg, "parent_tool_use_id").is_empty() {
            return i.agent_chatter(&msg);
        }
        let sid = s(&msg, "session_id");
        if !sid.is_empty() && i.session_id.as_deref() != Some(sid) {
            i.session_id = Some(sid.to_string());
            i.emit("session", json!(sid));
        }
        let ty = match s(&msg, "type") {
            "" if msg.get("total_cost_usd").is_some() => "result",
            t => t,
        };
        // Claude Code carries on by itself when a background helper finishes: a turn nobody asked for
        if i.turn.is_none() && (ty == "assistant" || ty == "stream_event") {
            i.auto_turns += 1;
            let id = format!("auto-{}-{}", crate::store::now_ms(), i.auto_turns);
            i.begin_turn(id);
        }
        match ty {
            "control_request" => i.control_request(&msg),
            "stream_event" => {
                let ev = &msg["event"];
                match s(ev, "type") {
                    "content_block_start" => {
                        let block = &ev["content_block"];
                        if s(block, "type") == "text" {
                            i.separate();
                        }
                        if s(block, "type") == "thinking" {
                            i.emit("thinking", Value::Null);
                        }
                    }
                    "content_block_delta" if s(&ev["delta"], "type") == "text_delta" => {
                        let mid = s(&msg, "api_message_id");
                        if !mid.is_empty() {
                            i.streamed.insert(mid.to_string());
                        }
                        let text = s(&ev["delta"], "text").to_string();
                        i.append_text(&text);
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let m = &msg["message"];
                for block in m["content"].as_array().cloned().unwrap_or_default() {
                    match s(&block, "type") {
                        "tool_use" => {
                            i.task_tool(&block);
                            i.agent_start(&block, None);
                            // MCP tools also pass their input on: some come with a view that draws from it
                            let name = s(&block, "name");
                            let id = s(&block, "id");
                            let args = block.get("input").cloned().unwrap_or(json!({}));
                            let mut ev = json!({ "name": name, "detail": describe_tool(name, &args), "id": id, "args": args });
                            if name.starts_with("mcp__") {
                                i.mcp_tool_ids.insert(id.to_string());
                                ev["input"] = ev["args"].clone();
                            }
                            i.emit("tool", ev);
                        }
                        // the answer's text when partial messages weren't streamed
                        "text" if !i.streamed.contains(s(m, "id")) => {
                            i.separate();
                            i.append_text(s(&block, "text"));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                for block in msg["message"]["content"].as_array().cloned().unwrap_or_default() {
                    if s(&block, "type") != "tool_result" {
                        continue;
                    }
                    i.task_result(&block);
                    let id = s(&block, "tool_use_id").to_string();
                    let is_error = block["is_error"].as_bool().unwrap_or(false);
                    // what the tool gave back, as Claude read it (the chat shows it when you click the step)
                    i.emit("tool-output", json!({ "id": id, "text": output_text(&block["content"]), "media": output_media(&block["content"]), "isError": is_error }));
                    // a file it changed: show the diff, like Claude Code's terminal
                    if !is_error && let Some(mut diff) = edit_diff(&msg["tool_use_result"]) {
                        diff["id"] = json!(id);
                        i.emit("edit", diff);
                    }
                    // an MCP tool's result, as the MCP server gave it (for its view)
                    if i.mcp_tool_ids.remove(&id) {
                        let content = match &block["content"] {
                            Value::String(t) => json!([{ "type": "text", "text": t }]),
                            Value::Null => json!([]),
                            other => other.clone(),
                        };
                        let mut result = json!({ "content": content, "isError": is_error });
                        let structured = &msg["tool_use_result"]["structuredContent"];
                        if !structured.is_null() {
                            result["structuredContent"] = structured.clone();
                        }
                        i.emit("tool-result", json!({ "id": id, "result": result }));
                    }
                    // a helper that ran in the foreground is done when its tool call returns
                    if i.agent_tools.contains(&id) && !msg["tool_use_result"]["isAsync"].as_bool().unwrap_or(false) {
                        i.agent_running.remove(&id);
                        let status = if is_error { "failed" } else { "completed" };
                        i.emit("agent", json!({ "op": "done", "id": id, "status": status, "summary": result_text(&block["content"]) }));
                    }
                }
            }
            "system" => {
                let sub = s(&msg, "subtype");
                if sub.starts_with("task_") {
                    i.agent_task(&msg);
                }
                if sub == "task_summary" && !s(&msg, "detail").is_empty() {
                    i.emit("status", msg["detail"].clone());
                } else if sub == "init" {
                    // the slash commands Claude Code offers in this folder (skills, custom commands)
                    if let Some(cmds) = msg["slash_commands"].as_array() {
                        i.emit("commands", Value::Array(cmds.iter().map(|n| json!({ "name": n })).collect()));
                    }
                    if msg["tools"].is_array() {
                        let chosen = i.opts.tools.is_some();
                        i.emit("tools", json!({ "version": msg["claude_code_version"], "tools": msg["tools"], "chosen": chosen }));
                    }
                } else if sub == "commands_changed" {
                    if let Some(cmds) = msg["commands"].as_array() {
                        i.emit("commands", Value::Array(cmds.iter().map(|c| json!({ "name": c["name"], "description": s(c, "description") })).collect()));
                    }
                } else if sub == "status" && s(&msg, "status") == "compacting" {
                    i.emit("compact", json!({ "phase": "start" }));
                } else if sub == "compact_boundary" {
                    let meta = &msg["compact_metadata"];
                    i.emit("compact", json!({ "phase": "done", "pre": meta["pre_tokens"], "post": meta["post_tokens"] }));
                }
            }
            "result" => {
                let Some(turn) = i.turn.take() else { return };
                let rest = i.asides.flush();
                // (put the turn back for a moment: the last of its text still counts)
                i.turn = Some(Turn { id: turn.id.clone(), interrupted: turn.interrupted });
                i.emit_text(&rest);
                i.turn = None;
                let total = msg["total_cost_usd"].as_f64().unwrap_or(0.0);
                let cost = (total - i.cost_so_far).max(0.0);
                i.cost_so_far = total;
                let interrupted = turn.interrupted || s(&msg, "terminal_reason").starts_with("abort");
                let text = match i.text.trim() {
                    "" => strip_asides(s(&msg, "result")).trim().to_string(),
                    t => t.to_string(),
                };
                i.last_used = Instant::now();
                let denials: Vec<Value> = msg["permission_denials"].as_array().map(|d| d.iter().map(|x| x["tool_name"].clone()).collect()).unwrap_or_default();
                let session_id = if sid.is_empty() { json!(i.session_id) } else { json!(sid) };
                i.emit("done", json!({
                    "turnId": turn.id, "text": text, "asides": i.asides.asides, "isError": msg["is_error"].as_bool().unwrap_or(false) && !interrupted,
                    "interrupted": interrupted, "costUsd": cost, "denials": denials, "sessionId": session_id,
                }));
                self.next(&mut i);
            }
            _ => {}
        }
    }
}
