//! The robots' chats (main.js sessionFor, ask and friends). Each robot has tabs; each tab
//! is its own Claude Code conversation, kept open as one live `claude` process (a
//! claude::Session) so it can be interrupted, take questions typed ahead, and switch
//! model or effort mid-chat. What it does is passed on to the robot's page as
//! robot:event, and the finished answer is kept in the tab's history.

pub mod awake;
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

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::agents::{claude, personalities};
use crate::agents::claude::{locate, Session, transcripts};
use crate::mcp::{apps, link, tools};
use crate::robots::label_of;
use crate::runtime::with;
use crate::workbench::files;

const IDLE_CLOSE: Duration = Duration::from_secs(15 * 60); // an idle conversation's process is closed; it resumes on the next question

// Each step's input and output: shown when you click it in the chat. Live they're cut at
// LIVE, kept with the answer in history smaller (KEEP), so the store file stays light.
struct Limits {
    text: usize,
    output: usize,
}
const LIVE: Limits = Limits { text: 20000, output: 40000 };
const KEEP: Limits = Limits { text: 1500, output: 2500 };
const KEEP_CALLS: usize = 60;
const KEEP_TOTAL: usize = 40000;
// A step's pictures and documents: the chat gets them whole up to LIVE_MEDIA, the saved
// answer keeps pictures only while they fit KEEP_MEDIA (one that doesn't is marked notKept).
const MEDIA_COUNT: usize = 8;
const LIVE_MEDIA: usize = 12_000_000;
const KEEP_MEDIA: usize = 400_000;

struct TurnInfo {
    prompt: String,
    kind: String,
    retried: bool,
}

/// What a tab's chat keeps of the answer in progress, for its history.
#[derive(Default)]
struct Book {
    turns: HashMap<String, TurnInfo>,
    text_len: usize,  // how much of the answer it has said so far, in JS string units (where each step goes in it)
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
        Arc::new(Chat { session, book: Arc::default() })
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
        Value::Array(a) => Value::Array(a.iter().take(200).map(|x| clip(x, l, depth + 1)).collect()),
        Value::Object(o) => Value::Object(o.iter().take(100).map(|(k, x)| (k.clone(), clip(x, l, depth + 1))).collect()),
        _ => v.clone(),
    }
}

/// A step's pictures within a byte budget; returns them and what's left of it.
fn step_media(media: &Value, budget: usize) -> (Value, usize) {
    let mut left = budget;
    let out = media.as_array().into_iter().flatten().take(MEDIA_COUNT).map(|m| {
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
    hunks.as_array().into_iter().flatten().map(|h| h["lines"].as_array().map_or(0, Vec::len)).sum()
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
        if calls.is_empty() { Value::Null } else { Value::Array(calls) }
    }

    /// The finished turn's MCP tool calls that have (or may have) a view, kept with the
    /// answer so the chat can show the view again. Their pages are fetched when shown.
    fn take_apps(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.mcp_calls)
            .into_iter()
            .filter(|(_, c)| c["noView"] != true)
            .map(|(id, c)| entry(vec![("id", json!(id)), ("name", c["name"].clone()), ("input", c["input"].clone()), ("result", c["result"].clone())]))
            .filter(|a| a.to_string().len() < 300_000)
            .take(10)
            .collect()
    }

    fn take(&mut self) -> (Value, Value, Value, Value) {
        let edits = std::mem::take(&mut self.edits);
        let images = std::mem::take(&mut self.images);
        let apps = self.take_apps();
        let calls = self.take_calls();
        let some = |v: Vec<Value>| if v.is_empty() { Value::Null } else { Value::Array(v) };
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
    Value::Object(pairs.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.to_string(), v)).collect())
}

fn patch(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

// ---------------------------------------------------------------- one tab's conversation

/// Its personality, and the other robots it can ask (mcp/link.rs).
pub fn prompt_for(app: &AppHandle, c: &Value) -> String {
    let id = c["id"].as_str().unwrap_or("");
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
    let (c, tab, settings) = with(app, |st| Some((st.store.get(id)?.clone(), st.store.tab(id, tab_id)?.clone(), st.store.settings().clone())))?;
    let model = tab["model"].as_str().or(c["model"].as_str()).unwrap_or(""); // '' = Claude Code's default; a tab's choice beats the robot's
    // an edited question: once, the process picks the conversation up from before it (rewind)
    let resume_at = tab["resumeAt"].as_str().map(str::to_string);
    if resume_at.is_some() {
        with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("resumeAt", Value::Null)])));
    }
    // the other robots, to ask (mcp/link.rs): its tools, usable without asking, and time to wait for an answer
    let mcp_config = link::mcp_config(app, id, tab_id);
    let opts = claude::Opts {
        claude_path: locate::find(settings["claudePath"].as_str().unwrap_or(""))?,
        cwd: c["folder"].as_str().unwrap_or("").into(),
        system_prompt: prompt_for(app, &c),
        permission_mode: mode_of(&c, &tab).into(),
        model: model.into(),
        effort: tab["effort"].as_str().unwrap_or("").into(),
        add_dirs: vec![],
        tools: settings["toolset"]["tools"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()),
        env: vec![("MCP_TOOL_TIMEOUT".into(), (link::TASK_TIMEOUT_MS + 60_000).to_string())], // (a handed-off task may take a while)
        allowed_tools: if mcp_config.is_some() { tools::allowed() } else { vec![] },
        mcp_config: mcp_config.unwrap_or_default(),
        extra_args: vec![],
        resume_at,
        fork: false,
        remote: (tab["remote"] == true).then(|| remote_name(&c)),
        remote_session: tab["remoteSession"].as_str().map(str::to_string),
    };
    let book = Arc::new(Mutex::new(Book::default()));
    let (app2, id2, tab2, book2) = (app.clone(), id.to_string(), tab_id.to_string(), book.clone());
    let handler: claude::Handler = Arc::new(move |session, event, data| on_event(&app2, &id2, &tab2, &book2, session, event, data));
    let session = Session::new(opts, tab["sessionId"].as_str().map(str::to_string), handler);
    let chat = Arc::new(Chat { session, book });
    with(app, |st| st.chats.insert(key, chat.clone()));
    Some(chat)
}

/// The tab's permission mode: its own (picked in the chat, or plan mode come and gone), else the robot's.
pub fn mode_of<'a>(c: &'a Value, tab: &'a Value) -> &'a str {
    tab["permissionMode"].as_str().filter(|m| allowed_mode(c, m)).or(c["permissionMode"].as_str()).unwrap_or("default")
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

fn on_event(app: &AppHandle, id: &str, tab_id: &str, book: &Arc<Mutex<Book>>, session: &Arc<Session>, event: &str, data: Value) {
    let book_of = || book.lock().unwrap_or_else(|e| e.into_inner());
    match event {
        // Remote Control came on (its page on claude.ai), went off, or couldn't
        "remote" => {
            let on = data["on"] == true;
            with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("remote", json!(on)), ("remoteSession", data["remoteSession"].clone()), ("remoteUrl", data["url"].clone())])));
            tell(app, id, tab_id, json!({ "type": "remote", "on": on, "url": data["url"], "error": data["error"] }));
        }
        "remote-state" => tell(app, id, tab_id, json!({ "type": "remote-state", "state": data })),
        // a message typed on claude.ai/code or in the Claude app: into the chat as yours
        "remote-prompt" => {
            let folder = with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
            let (sid, uuid) = (data["sessionId"].as_str().unwrap_or(""), data["uuid"].as_str().unwrap_or(""));
            // (it's written to the transcript about when it starts: give it a moment)
            let mut text = None;
            for _ in 0..30 {
                text = transcripts::user_message(&folder, sid, uuid);
                if text.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let text = text.unwrap_or_else(|| "(a message from the Claude app)".into());
            if text.is_empty() {
                return; // (not the user's words: Claude Code's own)
            }
            let tag = "📱 From the Claude app";
            with(app, |st| st.store.push_history(id, tab_id, json!({ "role": "user", "text": text, "tag": tag })));
            tell(app, id, tab_id, json!({ "type": "remote-prompt", "text": text, "tag": tag }));
        }
        "turn-start" => {
            let turn_id = data.as_str().unwrap_or("").to_string();
            let kind = {
                let mut b = book_of();
                b.text_len = 0;
                b.media_left = KEEP_MEDIA;
                b.turns.get(&turn_id).map(|t| t.kind.clone())
            };
            tell(app, id, tab_id, json!({ "type": "turn-start", "turnId": turn_id, "kind": kind }));
        }
        "session" => {
            let sid = data.as_str().unwrap_or("");
            with(app, |st| {
                let tab = st.store.tab(id, tab_id).cloned().unwrap_or_default();
                st.store.update_tab(id, tab_id, patch(vec![("sessionId", json!(sid))]));
                if tab["temporary"] == true {
                    // (not one of the robot's past conversations: kept to throw away when the chat closes)
                    let mut seen = sessions_of(&tab);
                    if !seen.iter().any(|s| s == sid) {
                        seen.push(sid.to_string());
                    }
                    st.store.update_tab(id, tab_id, patch(vec![("tempSessions", json!(seen))]));
                } else {
                    st.store.remember_session(id, sid);
                }
            });
        }
        "initialized" => {
            let models: Vec<Value> = data["models"].as_array().into_iter().flatten().filter(|m| !m["value"].as_str().unwrap_or("").starts_with("claude-")).map(|m| {
                let value = if m["value"] == "default" { json!("") } else { m["value"].clone() };
                json!({ "value": value, "displayName": m["displayName"], "description": m["description"], "efforts": m.get("supportedEffortLevels").cloned().unwrap_or(json!([])) })
            }).collect();
            if !models.is_empty() {
                with(app, |st| st.model_choices = Value::Array(models));
            }
        }
        "tools" => {
            // learn Claude Code's default tools once (per version), so later sessions can add the task tools to them
            if data["chosen"].as_bool() != Some(true) {
                let tools: Vec<String> = data["tools"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).filter(|t| !t.starts_with("mcp__")).map(str::to_string).collect();
                with(app, |st| st.store.update_settings(patch(vec![("toolset", json!({ "version": data["version"], "tools": tools }))])));
                // this conversation started without the task tools: pick them up from its next question
                session.set_tools(tools);
            } else {
                with(app, |st| {
                    let cached = &st.store.settings()["toolset"];
                    if cached.is_object() && cached["version"] != data["version"] {
                        st.store.update_settings(patch(vec![("toolset", Value::Null)]));
                    }
                });
            }
        }
        "commands" => with(app, |st| {
            // keep descriptions we already know when init only gives us names
            let known: HashMap<String, Value> = st.store.get(id).and_then(|c| c["claudeCommands"].as_array().cloned()).unwrap_or_default().into_iter()
                .map(|c| (c["name"].as_str().unwrap_or("").to_string(), c["description"].clone())).collect();
            let merged: Vec<Value> = data.as_array().into_iter().flatten().take(200).map(|c| {
                let name = c["name"].as_str().unwrap_or("");
                let desc = c["description"].as_str().filter(|d| !d.is_empty()).map(|d| json!(d)).or_else(|| known.get(name).cloned()).unwrap_or(json!(""));
                json!({ "name": name, "description": desc })
            }).collect();
            st.store.update(id, patch(vec![("claudeCommands", Value::Array(merged))]));
        }),
        "text" => {
            let delta = data.as_str().unwrap_or("");
            let mut b = book_of();
            b.text_len += delta.encode_utf16().count();
            b.thinking = None; // (done thinking: it's talking)
            drop(b);
            tell(app, id, tab_id, json!({ "type": "text", "delta": delta }));
        }
        "aside" => tell(app, id, tab_id, json!({ "type": "aside", "text": data })),
        // its thinking: a step of its own in the answer (where it came), its words streamed into it
        "thinking" => {
            tell(app, id, tab_id, json!({ "type": "thinking" }));
            let mut b = book_of();
            b.thoughts += 1;
            let step = format!("think-{}", b.thoughts);
            b.thinking = Some(step.clone());
            if b.calls.len() < KEEP_CALLS {
                let at = b.text_len;
                b.calls.push(json!({ "id": step, "name": "Thinking", "detail": "", "at": at, "output": "" }));
            }
            drop(b);
            tell(app, id, tab_id, json!({ "type": "tool", "id": step, "name": "Thinking", "detail": "", "args": null }));
        }
        "thinking-text" => {
            let delta = data.as_str().unwrap_or("");
            let mut b = book_of();
            let Some(step) = b.thinking.clone() else { return };
            if let Some(call) = b.calls.iter_mut().find(|c| c["id"] == step.as_str()) {
                let so_far = call["output"].as_str().unwrap_or("");
                if so_far.len() < KEEP.output * 2 {
                    call["output"] = json!(format!("{so_far}{delta}"));
                }
            }
            drop(b);
            tell(app, id, tab_id, json!({ "type": "thinking-text", "id": step, "delta": delta }));
        }
        "usage" => tell(app, id, tab_id, json!({ "type": "usage", "outputTokens": data["outputTokens"] })),
        "status" => tell(app, id, tab_id, json!({ "type": "status", "text": data })),
        "question" | "request-cancelled" | "plan" => {
            let mut p = data;
            p["type"] = json!(event);
            tell(app, id, tab_id, p);
        }
        // it went into plan mode by itself (or out of it): the tab keeps the mode it's in
        "mode" => {
            let mode = data.as_str().unwrap_or("default");
            with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("permissionMode", json!(mode))])));
            tell(app, id, tab_id, json!({ "type": "mode", "mode": mode }));
        }
        "tool" => {
            book_of().thinking = None; // (done thinking: it's doing)
            // what it was called with (click the step in the chat to see it), and a smaller copy kept with the answer
            let args = data["args"].clone();
            let mut p = data.clone();
            let o = p.as_object_mut().unwrap();
            o.remove("input");
            o.insert("type".into(), json!("tool"));
            o.insert("args".into(), clip(&args, &LIVE, 0));
            tell(app, id, tab_id, p);
            let mut b = book_of();
            if b.calls.len() < KEEP_CALLS {
                let at = b.text_len;
                b.calls.push(json!({ "id": data["id"], "name": data["name"], "detail": data["detail"], "args": clip(&args, &KEEP, 0), "at": at }));
            }
            if data.get("input").is_none() {
                return;
            }
            // an MCP tool: if it comes with its own view (an MCP App), show it in the chat
            let call_id = data["id"].as_str().unwrap_or("").to_string();
            b.mcp_calls.insert(call_id.clone(), json!({ "name": data["name"], "input": data["input"] }));
            drop(b);
            let (app, id, tab_id, book) = (app.clone(), id.to_string(), tab_id.to_string(), book.clone());
            let tool = data["name"].as_str().unwrap_or("").to_string();
            // (looked up off this thread: it may ask the tool's server, which takes a moment)
            thread::spawn(move || {
                let folder = with(&app, |st| st.store.get(&id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
                let view = apps::app_for(&app, &tool, &folder);
                let shown = {
                    let mut b = book.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(call) = b.mcp_calls.get_mut(&call_id) else { return }; // (its answer is already done with it)
                    call["noView"] = json!(view.is_none());
                    let Some(view) = view else { return };
                    call["view"] = view.clone();
                    let mut p = json!({ "type": "app", "id": call_id, "input": call["input"], "result": call["result"] });
                    for (k, v) in view.as_object().into_iter().flatten() {
                        p[k] = v.clone();
                    }
                    p
                };
                tell(&app, &id, &tab_id, shown);
            });
        }
        // what a tool gave back: to the chat (its step shows it), and trimmed with the answer
        "tool-output" => {
            let text = data["text"].as_str().unwrap_or("");
            let (live, _) = step_media(&data["media"], LIVE_MEDIA);
            tell(app, id, tab_id, json!({ "type": "tool-output", "id": data["id"], "text": cut(text, LIVE.output), "media": live, "isError": data["isError"] }));
            let mut b = book_of();
            let left = b.media_left;
            let Some(call) = b.calls.iter_mut().find(|c| c["id"] == data["id"]) else { return };
            call["output"] = json!(cut(text, KEEP.output));
            if data["isError"].as_bool() == Some(true) {
                call["isError"] = json!(true);
            }
            let (kept, rest) = step_media(&data["media"], left);
            if kept.as_array().is_some_and(|k| !k.is_empty()) {
                call["media"] = kept;
            }
            b.media_left = rest;
        }
        "tool-result" => {
            let mut b = book_of();
            let call_id = data["id"].as_str().unwrap_or("").to_string();
            let Some(call) = b.mcp_calls.get_mut(&call_id) else { return };
            call["result"] = data["result"].clone();
            if call.get("view").is_some() {
                tell(app, id, tab_id, json!({ "type": "app-result", "id": call_id, "result": data["result"] }));
            }
            // pictures the tool returned (a screenshot, a rendered chart): shown in the answer
            let pics: Vec<Value> = data["result"]["content"].as_array().into_iter().flatten()
                .filter(|c| c["type"] == "image" && claude::is_image_mime(c["mimeType"].as_str().unwrap_or("")) && c["data"].is_string())
                .take(6)
                .map(|c| json!({ "id": call_id, "mimeType": c["mimeType"], "data": c["data"] }))
                .collect();
            if pics.is_empty() {
                return;
            }
            // kept with the answer while they're small, so the store file stays light
            for pic in &pics {
                let used: usize = b.images.iter().map(|k| k["data"].as_str().map_or(0, str::len)).sum();
                if used + pic["data"].as_str().map_or(0, str::len) < 800_000 {
                    b.images.push(pic.clone());
                }
            }
            drop(b);
            tell(app, id, tab_id, json!({ "type": "tool-images", "id": call_id, "images": pics }));
        }
        // files it changed: shown as diffs now, and kept (trimmed) with the answer in history
        "edit" => {
            let mut p = data.clone();
            p["type"] = json!("edit");
            tell(app, id, tab_id, p);
            let mut b = book_of();
            if b.edits.len() < 20 {
                let mut kept = data.clone();
                let truncated = data["truncated"].as_bool().unwrap_or(false) || count_lines(&data["hunks"]) > 120;
                kept["hunks"] = trim_hunks(&data["hunks"], 120);
                kept["truncated"] = json!(truncated);
                b.edits.push(kept);
            }
        }
        "agent" => {
            let mut ev = data;
            // a background helper's full report sits in a file; short ones are already in the summary
            if ev["op"] == "done" && !ev["outputFile"].as_str().unwrap_or("").is_empty()
                && let Ok(report) = std::fs::read_to_string(ev["outputFile"].as_str().unwrap())
            {
                let report = report.trim();
                if !report.is_empty() && report.len() > ev["summary"].as_str().map_or(0, str::len) {
                    let chars: Vec<char> = report.chars().collect();
                    ev["report"] = json!(chars[chars.len().saturating_sub(20000)..].iter().collect::<String>());
                }
            }
            if let Some(o) = ev.as_object_mut() {
                o.remove("outputFile");
            }
            ev["type"] = json!("agent");
            tell(app, id, tab_id, ev);
        }
        "task" => {
            let tasks = with(app, |st| {
                let t = st.store.tab(id, tab_id)?;
                let mut tasks: Vec<Value> = t["tasks"].as_array().cloned().unwrap_or_default();
                match data["op"].as_str() {
                    Some("replace") => tasks = data["tasks"].as_array().cloned().unwrap_or_default(),
                    Some("create") => {
                        tasks.retain(|x| x["id"] != data["id"]);
                        tasks.push(json!({ "id": data["id"], "subject": data["subject"], "activeForm": data["activeForm"], "status": "pending" }));
                    }
                    _ => {
                        for x in tasks.iter_mut().filter(|x| x["id"] == data["id"]) {
                            for (k, v) in data.as_object().unwrap() {
                                let set = !matches!(v, Value::Null | Value::Bool(false)) && v != "" && v != 0 && k != "op";
                                if set {
                                    x[k] = v.clone();
                                }
                            }
                        }
                    }
                }
                tasks.retain(|x| x["status"] != "deleted");
                st.store.update_tab(id, tab_id, patch(vec![("tasks", json!(tasks))]))?;
                Some(tasks)
            });
            if let Some(tasks) = tasks {
                tell(app, id, tab_id, json!({ "type": "tasks", "tasks": tasks, "change": data }));
            }
        }
        "compact" => {
            book_of().last_compact = data.clone();
            let mut p = data;
            p["type"] = json!("compact");
            tell(app, id, tab_id, p);
        }
        "done" => {
            let turn_id = data["turnId"].as_str().unwrap_or("").to_string();
            let (kind, last_compact, (edits, apps, images, tools)) = {
                let mut b = book_of();
                let kind = b.turns.remove(&turn_id).map(|t| t.kind).unwrap_or_default();
                (kind, b.last_compact.clone(), b.take())
            };
            let kept = with(app, |st| {
                let c = st.store.get(id)?.clone();
                if kind == "compact" {
                    let text = match (last_compact["pre"].as_f64(), last_compact["post"].as_f64()) {
                        (Some(pre), Some(post)) if pre > 0.0 => format!("🗜️ Compacted my memory: {}k → {}k tokens", (pre / 1000.0).round(), (post / 1000.0).round()),
                        _ => "🗜️ Compacted my memory".into(),
                    };
                    st.store.push_history(id, tab_id, json!({ "role": "note", "text": text }));
                } else {
                    st.store.push_history(id, tab_id, entry(vec![
                        ("role", json!("assistant")), ("text", data["text"].clone()), ("asides", data["asides"].clone()), ("isError", data["isError"].clone()),
                        ("denials", data["denials"].clone()), ("interrupted", data["interrupted"].clone()), ("edits", edits), ("apps", apps), ("images", images), ("tools", tools),
                        ("uuid", data["uuid"].clone()), // (where an edited question after it rewinds to)
                    ]));
                }
                if let Some(sid) = data["sessionId"].as_str() {
                    st.store.update_tab(id, tab_id, patch(vec![("sessionId", json!(sid))]));
                }
                let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
                let cost = stats.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0) + data["costUsd"].as_f64().unwrap_or(0.0);
                stats.insert("costUsd".into(), json!(cost));
                st.store.update(id, patch(vec![("stats", Value::Object(stats))]));
                // (when the answer went in: what its side questions hang from, features/chat/side.rs)
                Some(st.store.tab(id, tab_id).and_then(|t| t["history"].as_array()?.last()?.get("at").cloned()).unwrap_or(Value::Null))
            });
            let Some(at) = kept else { return };
            let mut p = data;
            p["type"] = json!("done");
            p["at"] = at;
            p["kind"] = if kind.is_empty() { Value::Null } else { json!(kind) };
            tell(app, id, tab_id, p);
            refresh_context(app, id, tab_id);
        }
        "fail" => {
            let turn_id = data["turnId"].as_str().unwrap_or("").to_string();
            let retry = {
                let mut b = book_of();
                match b.turns.get_mut(&turn_id) {
                    Some(t) if data["sessionMissing"].as_bool() == Some(true) && session.session_id().is_some() && !t.retried => {
                        t.retried = true;
                        Some(t.prompt.clone())
                    }
                    _ => None,
                }
            };
            if let Some(prompt) = retry {
                // The old conversation is gone (e.g. folder moved): quietly start fresh.
                session.forget_session();
                with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("sessionId", Value::Null)])));
                session.ask(prompt, turn_id);
                return;
            }
            let (edits, apps, images, tools) = {
                let mut b = book_of();
                b.turns.remove(&turn_id);
                b.take()
            };
            if data["cancelled"].as_bool() != Some(true) {
                with(app, |st| st.store.push_history(id, tab_id, entry(vec![
                    ("role", json!("assistant")), ("text", data["message"].clone()), ("isError", json!(true)), ("edits", edits), ("apps", apps), ("images", images), ("tools", tools),
                ])));
            }
            let mut p = data;
            p["type"] = json!("fail");
            tell(app, id, tab_id, p);
        }
        _ => {}
    }
}

/// How full the tab's context is ("brain battery"), after each answer.
fn refresh_context(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let stored = || with(app, |st| st.store.tab(id, tab_id).map(|t| t["context"].clone()).unwrap_or(Value::Null));
    let Some(chat) = with(app, |st| st.chats.get(&key_of(id, tab_id)).cloned()) else { return stored() };
    let Some(u) = chat.session.context_usage() else { return stored() };
    let context = json!({ "percentage": u["percentage"], "totalTokens": u["totalTokens"], "maxTokens": u["maxTokens"], "autoCompactAt": u["autoCompactThreshold"], "autoCompact": u["isAutoCompactEnabled"] });
    with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("context", context.clone())])));
    tell(app, id, tab_id, json!({ "type": "context", "context": context }));
    context
}
