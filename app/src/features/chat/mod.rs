//! The robots' chats (main.js sessionFor, ask and friends). Each robot has tabs; each tab
//! is its own Claude Code conversation, kept open as one live `claude` process (a
//! claude::Session) so it can be interrupted, take questions typed ahead, and switch
//! model or effort mid-chat. What it does is passed on to the robot's page as
//! robot:event, and the finished answer is kept in the tab's history.

pub mod awake;
mod events;
pub mod group;
mod page;
pub mod side;
mod temporary;

pub use page::*;
pub use temporary::*;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};

use crate::agents::claude::{Session, locate, transcripts};
use crate::agents::{claude, personalities};
use crate::mcp::{apps, link, tools};
use crate::robots::label_of;
use crate::runtime::{Locked, with};
use crate::store::Fields;
use crate::workbench::files;

const IDLE_CLOSE: Duration = Duration::from_secs(15 * 60); // an idle conversation's process is closed; it resumes on the next question

// Each step's input and output: shown when you click it in the chat. Live they're cut at
// LIVE, kept with the answer in history smaller (KEEP), so the store file stays light.
struct Limits {
    text: usize,
    output: usize,
}
const LIVE: Limits = Limits {
    text: 20000,
    output: 40000,
};
const KEEP: Limits = Limits {
    text: 1500,
    output: 2500,
};
const KEEP_CALLS: usize = 60;
const KEEP_TOTAL: usize = 40000;
// A step's pictures and documents: the chat gets them whole up to LIVE_MEDIA, the saved
// answer keeps pictures only while they fit KEEP_MEDIA (one that doesn't is marked notKept).
const MEDIA_COUNT: usize = 8;
const LIVE_MEDIA: usize = 12_000_000;
const KEEP_MEDIA: usize = 400_000;

struct TurnInfo {
    prompt: String,
    kind: AskKind,
    retried: bool,
}

/// What a tab's chat keeps of the answer in progress, for its history.
#[derive(Default)]
struct Book {
    turns: HashMap<String, TurnInfo>,
    text_len: usize, // how much of the answer it has said so far, in JS string units (where each step goes in it)
    media_left: usize,
    calls: Vec<Value>,
    mcp_calls: Map<String, Value>, // tool call id -> { name, input, result, view, noView } (in the order they came)
    images: Vec<Value>,
    edits: Vec<Value>,
    last_compact: Value,
    thinking: Option<String>, // the step its thinking is going into, while it thinks
    thoughts: usize,          // (to name them)
}

pub struct Chat {
    pub session: Arc<Session>,
    book: Arc<Mutex<Book>>,
}

impl Chat {
    /// A conversation kept with the others, whose answers go elsewhere (a side question, features/chat/side.rs).
    pub fn bare(session: Arc<Session>) -> Arc<Chat> {
        Arc::new(Chat {
            session,
            book: Arc::default(),
        })
    }
}

pub fn key_of(id: &str, tab_id: &str) -> String {
    format!("{id}|{tab_id}")
}

fn tell(app: &AppHandle, id: &str, tab_id: &str, payload: Value) {
    let mut p = payload;
    p["tabId"] = json!(tab_id);
    let _ = app.emit_to(label_of(id), "robot:event", p);
}

fn cut(s: &str, n: usize) -> String {
    let len = s.encode_utf16().count();
    if len <= n {
        return s.to_string();
    }
    let kept: String = String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<_>>());
    format!("{kept}\n… ({} more characters)", thousands(len - n))
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A tool's arguments with every long string cut.
fn clip(v: &Value, l: &Limits, depth: usize) -> Value {
    match v {
        Value::String(s) => json!(cut(s, l.text)),
        _ if depth > 6 => v.clone(),
        Value::Array(a) => {
            Value::Array(a.iter().take(200).map(|x| clip(x, l, depth + 1)).collect())
        }
        Value::Object(o) => Value::Object(
            o.iter()
                .take(100)
                .map(|(k, x)| (k.clone(), clip(x, l, depth + 1)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// A step's pictures within a byte budget; returns them and what's left of it.
fn step_media(media: &Value, budget: usize) -> (Value, usize) {
    let mut left = budget;
    let out = media
        .as_array()
        .into_iter()
        .flatten()
        .take(MEDIA_COUNT)
        .map(|m| {
            if m["kind"] != "image" {
                return m.clone();
            }
            let len = m["data"].as_str().map_or(0, str::len);
            if len > left {
                return json!({ "kind": "image", "mimeType": m["mimeType"], "notKept": true });
            }
            left -= len;
            m.clone()
        });
    (Value::Array(out.collect()), left)
}

fn count_lines(hunks: &Value) -> usize {
    hunks
        .as_array()
        .into_iter()
        .flatten()
        .map(|h| h["lines"].as_array().map_or(0, Vec::len))
        .sum()
}

// Diffs kept in history are cut down so the store file stays small.
fn trim_hunks(hunks: &Value, max: usize) -> Value {
    let mut left = max as i64;
    let mut out = vec![];
    for h in hunks.as_array().into_iter().flatten() {
        if left <= 0 {
            break;
        }
        let lines = h["lines"].as_array().cloned().unwrap_or_default();
        let mut h = h.clone();
        h["lines"] = Value::Array(lines.iter().take(left as usize).cloned().collect());
        left -= lines.len() as i64;
        out.push(h);
    }
    Value::Array(out)
}

impl Book {
    /// The steps kept with the answer: over the budget, the latest lose their output
    /// first, then their input (their pictures have a budget of their own).
    fn take_calls(&mut self) -> Value {
        let mut calls = std::mem::take(&mut self.calls);
        let size_of = |v: &Value| -> usize {
            let mut v = v.clone();
            strip_media(&mut v);
            v.to_string().len()
        };
        let mut size = size_of(&Value::Array(calls.clone()));
        for c in calls.iter_mut().rev() {
            if size <= KEEP_TOTAL {
                break;
            }
            for k in ["output", "args"] {
                if size <= KEEP_TOTAL || c.get(k).is_none() {
                    continue;
                }
                size = size.saturating_sub(size_of(&c[k]));
                c.as_object_mut().unwrap().remove(k);
                c["trimmed"] = json!(true);
            }
        }
        if calls.is_empty() {
            Value::Null
        } else {
            Value::Array(calls)
        }
    }

    /// The finished turn's MCP tool calls that have (or may have) a view, kept with the
    /// answer so the chat can show the view again. Their pages are fetched when shown.
    fn take_apps(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.mcp_calls)
            .into_iter()
            .filter(|(_, c)| c["noView"] != true)
            .map(|(id, c)| {
                entry(vec![
                    ("id", json!(id)),
                    ("name", c["name"].clone()),
                    ("input", c["input"].clone()),
                    ("result", c["result"].clone()),
                ])
            })
            .filter(|a| a.to_string().len() < 300_000)
            .take(10)
            .collect()
    }

    fn take(&mut self) -> (Value, Value, Value, Value) {
        let edits = std::mem::take(&mut self.edits);
        let images = std::mem::take(&mut self.images);
        let apps = self.take_apps();
        let calls = self.take_calls();
        let some = |v: Vec<Value>| {
            if v.is_empty() {
                Value::Null
            } else {
                Value::Array(v)
            }
        };
        (some(edits), some(apps), some(images), calls)
    }
}

fn strip_media(v: &mut Value) {
    match v {
        Value::Object(o) => {
            o.remove("media");
            o.values_mut().for_each(strip_media);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_media),
        _ => {}
    }
}

/// A history entry without its empty parts (as JSON.stringify drops undefined).
fn entry(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn patch(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

// ---------------------------------------------------------------- one tab's conversation

/// Its personality, and the other robots it can ask (mcp/link.rs).
pub fn prompt_for(app: &AppHandle, c: &Value) -> String {
    let id = c.id();
    let mut prompt = personalities::system_prompt_for(c);
    if let Some(note) = link::note(app, id) {
        prompt.push('\n');
        prompt.push_str(&note);
    }
    prompt
}

/// The tab's live Claude Code process (started on its first question).
fn chat_for(app: &AppHandle, id: &str, tab_id: &str) -> Option<Arc<Chat>> {
    let key = key_of(id, tab_id);
    if let Some(chat) = with(app, |st| st.chats.get(&key).cloned()) {
        return Some(chat);
    }
    let (c, tab, settings) = with(app, |st| {
        Some((
            st.store.get(id)?.clone(),
            st.store.tab(id, tab_id)?.clone(),
            st.store.settings().clone(),
        ))
    })?;
    let model = tab["model"].as_str().or(c["model"].as_str()).unwrap_or(""); // '' = Claude Code's default; a tab's choice beats the robot's
    // an edited question: once, the process picks the conversation up from before it (rewind)
    let resume_at = tab["resumeAt"].as_str().map(str::to_string);
    if resume_at.is_some() {
        with(app, |st| {
            st.store
                .update_tab(id, tab_id, patch(vec![("resumeAt", Value::Null)]))
        });
    }
    // the other robots, to ask (mcp/link.rs): its tools, usable without asking, and time to wait for an answer
    let mcp_config = link::mcp_config(app, id, tab_id);
    let opts = claude::Opts {
        claude_path: locate::find(settings["claudePath"].as_str().unwrap_or(""))?,
        cwd: c.folder().into(),
        system_prompt: prompt_for(app, &c),
        permission_mode: mode_of(&c, &tab).into(),
        model: model.into(),
        effort: tab.effort().into(),
        add_dirs: vec![],
        tools: settings["toolset"]["tools"].as_array().map(|t| {
            t.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        }),
        env: vec![(
            "MCP_TOOL_TIMEOUT".into(),
            (link::TASK_TIMEOUT_MS + 60_000).to_string(),
        )], // (a handed-off task may take a while)
        allowed_tools: if mcp_config.is_some() {
            tools::allowed()
        } else {
            vec![]
        },
        mcp_config: mcp_config.unwrap_or_default(),
        extra_args: vec![],
        resume_at,
        fork: false,
        remote: (tab["remote"] == true).then(|| remote_name(&c)),
        remote_session: tab["remoteSession"].as_str().map(str::to_string),
    };
    let book = Arc::new(Mutex::new(Book::default()));
    let (app2, id2, tab2, book2) = (
        app.clone(),
        id.to_string(),
        tab_id.to_string(),
        book.clone(),
    );
    let handler: claude::Handler = Arc::new(move |session, event, data| {
        events::on_event(&app2, &id2, &tab2, &book2, session, event, data)
    });
    let session = Session::new(opts, tab.session_id().map(str::to_string), handler);
    let chat = Arc::new(Chat { session, book });
    with(app, |st| st.chats.insert(key, chat.clone()));
    Some(chat)
}

/// The tab's permission mode: its own (picked in the chat, or plan mode come and gone), else the robot's.
pub fn mode_of<'a>(c: &'a Value, tab: &'a Value) -> &'a str {
    tab["permissionMode"]
        .as_str()
        .filter(|m| allowed_mode(c, m))
        .or(c["permissionMode"].as_str())
        .unwrap_or("default")
}

/// What a chat may switch itself to: anything up to editing files, and planning. Doing anything
/// at all only where the robot itself is trusted with it (the Workshop's choice).
fn allowed_mode(c: &Value, mode: &str) -> bool {
    match mode {
        "default" | "acceptEdits" | "plan" => true,
        "bypassPermissions" => c["permissionMode"] == "bypassPermissions",
        _ => false,
    }
}

// What it's called on claude.ai/code and in the Claude app.
fn remote_name(c: &Value) -> String {
    format!("{} · C-Bot", c["name"].as_str().unwrap_or("Robot"))
}

/// How full the tab's context is ("brain battery"), after each answer.
fn refresh_context(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let stored = || {
        with(app, |st| {
            st.store
                .tab(id, tab_id)
                .map(|t| t["context"].clone())
                .unwrap_or(Value::Null)
        })
    };
    let Some(chat) = with(app, |st| st.chats.get(&key_of(id, tab_id)).cloned()) else {
        return stored();
    };
    let Some(u) = chat.session.context_usage() else {
        return stored();
    };
    let context = json!({ "percentage": u["percentage"], "totalTokens": u["totalTokens"], "maxTokens": u["maxTokens"], "autoCompactAt": u["autoCompactThreshold"], "autoCompact": u["isAutoCompactEnabled"] });
    with(app, |st| {
        st.store
            .update_tab(id, tab_id, patch(vec![("context", context.clone())]))
    });
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "context", "context": context }),
    );
    context
}
