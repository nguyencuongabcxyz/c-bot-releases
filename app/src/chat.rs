//! The robots' chats (main.js sessionFor, ask and friends). Each robot has tabs; each tab
//! is its own Claude Code conversation, kept open as one live `claude` process (a
//! claude::Session) so it can be interrupted, take questions typed ahead, and switch
//! model or effort mid-chat. What it does is passed on to the robot's page as
//! robot:event, and the finished answer is kept in the tab's history.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use crate::claude::{self, Session};
use crate::robots::label_of;
use crate::{files, find_claude, mcp_apps, personalities, robotlink, transcripts, with};

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

/// Its personality, and the other robots it can ask (robotlink.rs).
fn prompt_for(app: &AppHandle, c: &Value) -> String {
    let id = c["id"].as_str().unwrap_or("");
    let mut prompt = personalities::system_prompt_for(c);
    if let Some(note) = robotlink::note(app, id) {
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
    // the other robots, to ask (robotlink.rs): its tools, usable without asking, and time to wait for an answer
    let mcp_config = robotlink::mcp_config(app, id, tab_id);
    let opts = claude::Opts {
        claude_path: find_claude::find(settings["claudePath"].as_str().unwrap_or(""))?,
        cwd: c["folder"].as_str().unwrap_or("").into(),
        system_prompt: prompt_for(app, &c),
        permission_mode: c["permissionMode"].as_str().unwrap_or("").into(),
        model: model.into(),
        effort: tab["effort"].as_str().unwrap_or("").into(),
        add_dirs: vec![],
        tools: settings["toolset"]["tools"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()),
        env: vec![("MCP_TOOL_TIMEOUT".into(), (robotlink::TASK_TIMEOUT_MS + 60_000).to_string())], // (a handed-off task may take a while)
        allowed_tools: if mcp_config.is_some() { robotlink::allowed_tools() } else { vec![] },
        mcp_config: mcp_config.unwrap_or_default(),
        extra_args: vec![],
        resume_at,
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
        "question" | "request-cancelled" => {
            let mut p = data;
            p["type"] = json!(event);
            tell(app, id, tab_id, p);
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
                let view = mcp_apps::app_for(&app, &tool, &folder);
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
            let gone = with(app, |st| {
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
                Some(())
            });
            if gone.is_none() {
                return;
            }
            let mut p = data;
            p["type"] = json!("done");
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

// ---------------------------------------------------------------- what the page asks

pub fn is_busy(st: &crate::State, id: &str, tab_id: &str) -> bool {
    st.chats.get(&key_of(id, tab_id)).is_some_and(|c| c.session.busy())
}

pub fn close(app: &AppHandle, id: &str, tab_id: &str) {
    if let Some(chat) = with(app, |st| st.chats.remove(&key_of(id, tab_id))) {
        chat.session.close();
    }
}

pub fn close_robot(app: &AppHandle, id: &str) {
    let prefix = format!("{id}|");
    let gone: Vec<Arc<Chat>> = with(app, |st| {
        let keys: Vec<String> = st.chats.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.iter().filter_map(|k| st.chats.remove(k)).collect()
    });
    for chat in gone {
        chat.session.close();
    }
}

/// A new permission mode from the Workshop or the robot's menu: its live conversations
/// switch now (the next ones start with it).
pub fn set_permission_mode(app: &AppHandle, id: &str, mode: &str) {
    let prefix = format!("{id}|");
    let live: Vec<Arc<Chat>> = with(app, |st| st.chats.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, c)| c.clone()).collect());
    for chat in live {
        chat.session.set_permission_mode(mode);
    }
}

/// Edit the last question: the conversation goes back to before it. Its question and what
/// came after are taken out of the history; the next question picks the conversation up from
/// the answer before it (as a branch of its own: --resume-session-at, --fork-session), or
/// starts afresh if it was the first. The question comes back, to edit.
pub fn rewind(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    if with(app, |st| is_busy(st, id, tab_id)) {
        return json!({ "ok": false, "error": "Wait till I'm done (or stop me) first." });
    }
    let found = with(app, |st| {
        let tab = st.store.tab(id, tab_id)?;
        let history = tab["history"].as_array()?;
        let last = history.iter().rposition(|h| h["role"] == "user")?;
        let before = &history[..last];
        let talked = before.iter().any(|h| h["role"] == "assistant");
        // the answer before it, where the conversation picks up again
        let at = before.iter().rev().find(|h| h["role"] == "assistant").and_then(|h| h["uuid"].as_str()).map(str::to_string);
        Some((last, history[last].clone(), talked, at))
    });
    let Some((last, question, talked, at)) = found else {
        return json!({ "ok": false, "error": "There's no question to edit." });
    };
    if talked && at.is_none() {
        return json!({ "ok": false, "error": "That one's too old to edit (it was asked before I could go back in a conversation)." });
    }
    close(app, id, tab_id);
    with(app, |st| {
        let tab = st.store.tab(id, tab_id).cloned()?;
        let kept: Vec<Value> = tab["history"].as_array()?.iter().take(last).cloned().collect();
        let mut fields = vec![("history", Value::Array(kept))];
        if let Some(at) = &at {
            fields.push(("resumeAt", json!(at)));
        } else {
            fields.extend([("sessionId", Value::Null), ("resumeAt", Value::Null)]); // (it was the first question: start afresh)
        }
        st.store.update_tab(id, tab_id, patch(fields))
    });
    crate::robots::send_character(app, id);
    json!({ "ok": true, "text": question["text"], "files": question["files"] })
}

pub fn close_all(app: &AppHandle) {
    let all: Vec<Arc<Chat>> = with(app, |st| st.chats.drain().map(|(_, c)| c).collect());
    for chat in all {
        chat.session.close();
    }
}

/// Close conversations nobody has used for a while; they resume on the next question.
pub fn close_idle(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(60));
        let idle: Vec<Arc<Chat>> = with(&app, |st| {
            let keys: Vec<String> = st.chats.iter().filter(|(_, c)| {
                let s = &c.session;
                !s.busy() && s.helpers_running() == 0 && s.alive() && !s.remote() && s.idle_for() > IDLE_CLOSE
            }).map(|(k, _)| k.clone()).collect();
            keys.iter().filter_map(|k| st.chats.remove(k)).collect()
        });
        for chat in idle {
            chat.session.close();
        }
    });
}

/// tag: a line kept above your message (sent to everyone on the stage: who got it).
pub fn ask(app: &AppHandle, id: &str, tab_id: &str, prompt: &str, attachments: &[Value], turn_id: Option<String>, kind: &str, tag: Option<&str>) -> Value {
    let Some((c, settings)) = with(app, |st| {
        st.store.tab(id, tab_id)?;
        Some((st.store.get(id)?.clone(), st.store.settings().clone()))
    }) else {
        return json!({ "ok": false, "error": "That conversation is gone." });
    };
    if with(app, |st| st.terminals.get(id).is_some_and(|t| t == tab_id)) {
        return json!({ "ok": false, "error": "This conversation is open in the terminal. Carry on there, or close it to chat here." });
    }
    if find_claude::find(settings["claudePath"].as_str().unwrap_or("")).is_none() {
        return json!({ "ok": false, "error": "I can't find Claude Code anywhere on this computer. Install it, then press “Search again” in the Robot Workshop (bottom left), or point me to it there." });
    }
    let folder = c["folder"].as_str().unwrap_or("").to_string();
    if folder.is_empty() || !Path::new(&folder).exists() {
        let shown = if folder.is_empty() { "(none)" } else { &folder };
        return json!({ "ok": false, "error": format!("My folder is missing: {shown}. Point me at a new one in the Robot Workshop.") });
    }
    let turn_id = turn_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Files fed to the robot: name them in the prompt and let Claude Code read their folders.
    let dropped: Vec<Value> = attachments.iter().filter_map(|a| a.as_str()).filter_map(files::inspect).take(20).collect();
    let mut full = prompt.to_string();
    let list = |fs: &[Value]| fs.iter().map(|f| format!("- {}{}", f["path"].as_str().unwrap_or(""), if f["isDir"] == true { " (folder)" } else { "" })).collect::<Vec<_>>().join("\n");
    if !dropped.is_empty() {
        let (this, it) = if dropped.len() == 1 { ("this", "it") } else { ("these", "them") };
        full += &format!("\n\n[The user dropped {this} onto you. Read {it} as needed:]\n{}", list(&dropped));
    }
    // files mentioned with @ in the message: spell out exactly which ones
    let dropped_paths: Vec<String> = dropped.iter().map(|f| files::normalize(Path::new(f["path"].as_str().unwrap_or("")))).collect();
    let mentioned: Vec<Value> = files::mentioned(&folder, prompt).into_iter().filter(|p| !dropped_paths.contains(p)).filter_map(|p| files::inspect(&p)).collect();
    if !mentioned.is_empty() {
        let it = if mentioned.len() == 1 { "it" } else { "them" };
        full += &format!("\n\n[Files the user mentioned with @. Read {it} as needed:]\n{}", list(&mentioned));
    }
    let mut add_dirs: Vec<String> = vec![];
    for f in dropped.iter().chain(&mentioned) {
        let p = f["path"].as_str().unwrap_or("");
        let dir = if f["isDir"] == true { p.to_string() } else { Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default() };
        if !dir.is_empty() && !files::is_inside(&dir, &folder) && !add_dirs.contains(&dir) {
            add_dirs.push(dir);
        }
    }

    with(app, |st| {
        if kind == "bonk" {
            st.store.push_history(id, tab_id, json!({ "role": "note", "text": "🔨 Bonked! Starting over, quicker." }));
        }
        if kind == "chat" {
            let fed: Vec<Value> = dropped.iter().map(|f| json!({ "name": f["name"], "isDir": f["isDir"], "isImage": f["isImage"] })).collect();
            let mut entry = json!({ "role": "user", "text": prompt, "files": fed });
            if let Some(tag) = tag.filter(|t| !t.is_empty()) {
                entry["tag"] = json!(tag.chars().take(200).collect::<String>());
            }
            st.store.push_history(id, tab_id, entry);
            let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
            let n = stats.get("questions").and_then(Value::as_i64).unwrap_or(0) + 1;
            stats.insert("questions".into(), json!(n));
            st.store.update(id, patch(vec![("stats", Value::Object(stats))]));
        }
    });

    let Some(chat) = chat_for(app, id, tab_id) else {
        return json!({ "ok": false, "error": "I can't find Claude Code anywhere on this computer." });
    };
    chat.session.set_system_prompt(&prompt_for(app, &c)); // personality changes (and who else is out) apply from the next question
    chat.session.allow_dirs(&add_dirs);
    chat.book.lock().unwrap().turns.insert(turn_id.clone(), TurnInfo { prompt: full.clone(), kind: kind.into(), retried: false });
    let queued = chat.session.ask(full, turn_id.clone());
    json!({ "ok": true, "turnId": turn_id, "queued": queued })
}

fn chat_of(app: &AppHandle, id: &str, tab_id: &str) -> Option<Arc<Chat>> {
    with(app, |st| st.chats.get(&key_of(id, tab_id)).cloned())
}

/// Remote Control on or off: the conversation carries on from claude.ai/code or the Claude app
/// too (like Claude Code's /remote-control). Its process stays open while it's on, and it's back
/// on when C-Bot starts again. How it went comes as a "remote" event.
pub fn remote(app: &AppHandle, id: &str, tab_id: &str, on: bool) -> Value {
    let Some(c) = with(app, |st| {
        st.store.tab(id, tab_id)?;
        st.store.get(id).cloned()
    }) else {
        return json!({ "ok": false, "error": "That conversation is gone." });
    };
    if !on {
        with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("remote", json!(false)), ("remoteSession", Value::Null), ("remoteUrl", Value::Null)])));
        match chat_of(app, id, tab_id) {
            Some(chat) => chat.session.set_remote(None),
            None => tell(app, id, tab_id, json!({ "type": "remote", "on": false })),
        }
        return json!({ "ok": true });
    }
    if with(app, |st| st.terminals.get(id).is_some_and(|t| t == tab_id)) {
        return json!({ "ok": false, "error": "This conversation is open in the terminal. Close it first (or type /remote-control there)." });
    }
    let folder = c["folder"].as_str().unwrap_or("");
    if folder.is_empty() || !Path::new(folder).exists() {
        return json!({ "ok": false, "error": "My folder is missing. Point me at a new one in the Robot Workshop." });
    }
    let Some(chat) = chat_for(app, id, tab_id) else {
        return json!({ "ok": false, "error": "I can't find Claude Code anywhere on this computer." });
    };
    with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("remote", json!(true))])));
    chat.session.set_remote(Some(remote_name(&c)));
    json!({ "ok": true })
}

/// When C-Bot starts: conversations left with Remote Control on are reachable again.
pub fn revive_remote(app: &AppHandle) {
    let tabs: Vec<(String, String)> = with(app, |st| {
        st.store.list().iter().flat_map(|c| {
            let id = c["id"].as_str().unwrap_or("").to_string();
            c["tabs"].as_array().into_iter().flatten().filter(|t| t["remote"] == true).map(move |t| (id.clone(), t["id"].as_str().unwrap_or("").to_string()))
        }).collect()
    });
    for (id, tab_id) in tabs {
        if let Some(chat) = chat_for(app, &id, &tab_id) {
            chat.session.warm();
        }
    }
}

/// Stop: interrupt the current answer; questions typed ahead come back unsent.
pub fn cancel(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let dropped = chat_of(app, id, tab_id).map(|c| c.session.interrupt()).unwrap_or_default();
    if !dropped.is_empty() {
        tell(app, id, tab_id, json!({ "type": "dropped", "turnIds": dropped }));
    }
    json!(dropped)
}

pub fn unqueue(app: &AppHandle, id: &str, tab_id: &str, turn_id: &str) -> bool {
    chat_of(app, id, tab_id).is_some_and(|c| c.session.unqueue(turn_id))
}

pub fn send_now(app: &AppHandle, id: &str, tab_id: &str, turn_id: &str) -> bool {
    chat_of(app, id, tab_id).is_some_and(|c| c.session.send_now(turn_id))
}

/// The tab's "brain": model, effort and how full its context is.
pub fn brain(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let Some((models, model, effort)) = with(app, |st| {
        let c = st.store.get(id)?;
        let tab = st.store.tab(id, tab_id)?;
        let model = tab["model"].as_str().or(c["model"].as_str()).unwrap_or("").to_string();
        Some((st.model_choices.clone(), model, tab["effort"].as_str().unwrap_or("").to_string()))
    }) else {
        return Value::Null;
    };
    json!({ "models": models, "model": model, "effort": effort, "context": refresh_context(app, id, tab_id) })
}

pub fn set_brain(app: &AppHandle, id: &str, tab_id: &str, p: &Value) -> Value {
    if with(app, |st| st.store.tab(id, tab_id).is_none()) {
        return json!({ "ok": false });
    }
    let chat = chat_of(app, id, tab_id);
    let result = (|| -> Result<(), String> {
        if let Some(model) = p["model"].as_str() {
            with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("model", json!(model))])));
            if let Some(c) = &chat {
                c.session.set_model(model)?;
            }
        }
        if let Some(effort) = p["effort"].as_str() {
            with(app, |st| st.store.update_tab(id, tab_id, patch(vec![("effort", json!(effort))])));
            if let Some(c) = &chat {
                c.session.set_effort(effort)?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

/// The user answered a question Claude Code asked mid-task.
pub fn answer(app: &AppHandle, id: &str, tab_id: &str, request_id: &str, answers: &Value, items: &Value) -> bool {
    if !answers.is_object() {
        return false;
    }
    let ok = chat_of(app, id, tab_id).is_some_and(|c| c.session.answer(request_id, answers.clone()));
    if ok && let Some(items) = items.as_array() {
        let items: Vec<Value> = items.iter().take(8).cloned().collect();
        with(app, |st| st.store.push_history(id, tab_id, json!({ "role": "qa", "items": items })));
    }
    ok
}

/// Past conversations in the robot's folder, newest first.
pub fn sessions(app: &AppHandle, id: &str) -> Value {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else { return json!([]) };
    let folder = c["folder"].as_str().unwrap_or("");
    if folder.is_empty() {
        return json!([]);
    }
    // sessions open in a tab are always the robot's, even if they predate session tracking
    let tabs = c["tabs"].as_array().cloned().unwrap_or_default();
    // (a temporary chat's aren't listed: they go when it closes)
    let temporary: Vec<String> = tabs.iter().filter(|t| t["temporary"] == true).flat_map(sessions_of).collect();
    let tabs: Vec<Value> = tabs.into_iter().filter(|t| t["temporary"] != true).collect();
    let open: HashMap<String, Value> = tabs.iter().filter_map(|t| Some((t["sessionId"].as_str()?.to_string(), t["id"].clone()))).collect();
    let mut mine: Vec<String> = c["sessionIds"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
    mine.extend(open.keys().cloned());
    let active_session = tabs.iter().find(|t| t["id"] == c["activeTab"]).and_then(|t| t["sessionId"].as_str()).map(str::to_string);
    let rows = transcripts::list(folder, &mine, 60).into_iter().filter(|s| !temporary.iter().any(|t| s["id"] == t.as_str())).map(|mut s| {
        let sid = s["id"].as_str().unwrap_or("").to_string();
        s["current"] = json!(active_session.as_deref() == Some(sid.as_str()));
        s["tabId"] = open.get(&sid).cloned().unwrap_or(Value::Null);
        s
    });
    Value::Array(rows.collect())
}

// ---------------------------------------------------------------- temporary chats

/// Every conversation a temporary chat went through (an edited question branches off a new one).
fn sessions_of(tab: &Value) -> Vec<String> {
    let mut all: Vec<String> = tab["tempSessions"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
    if let Some(s) = tab["sessionId"].as_str().filter(|s| !all.iter().any(|a| a == s)) {
        all.push(s.to_string());
    }
    all
}

/// A temporary chat closed: Claude Code's transcripts of it go too (once its process, closed
/// with the tab, has let go of them).
pub fn erase_temporary(app: &AppHandle, id: &str, tab: &Value) {
    let sessions = sessions_of(tab);
    let folder = with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
    if sessions.is_empty() || folder.is_empty() {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        for s in &sessions {
            transcripts::forget(&folder, s);
        }
    });
}

/// At start: temporary chats left from before (C-Bot quit with them open) go, with their transcripts.
pub fn sweep_temporary(app: &AppHandle) {
    let left: Vec<(String, Value)> = with(app, |st| {
        st.store.list().iter().flat_map(|c| {
            let id = c["id"].as_str().unwrap_or("").to_string();
            c["tabs"].as_array().into_iter().flatten().filter(|t| t["temporary"] == true).map(move |t| (id.clone(), t.clone())).collect::<Vec<_>>()
        }).collect()
    });
    for (id, tab) in left {
        erase_temporary(app, &id, &tab);
        with(app, |st| st.store.remove_tab(&id, tab["id"].as_str().unwrap_or("")));
    }
}

pub fn session(app: &AppHandle, id: &str, session_id: &str) -> Value {
    let folder = with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
    if folder.is_empty() {
        return Value::Null;
    }
    transcripts::read(&folder, session_id, 150).unwrap_or(Value::Null)
}

/// The messages of a past conversation as a tab's history.
pub fn history_of(session: &Value) -> Value {
    let now = crate::store::now_ms();
    let msgs = session["messages"].as_array().into_iter().flatten().map(|m| {
        let mut m = m.clone();
        let at = m["at"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map_or(now, |d| d.timestamp_millis());
        m["at"] = json!(at);
        m
    });
    Value::Array(msgs.collect())
}

/// Open an earlier conversation: in its tab if one already has it, in the current tab if
/// that's empty, otherwise in a new tab.
pub fn resume(app: &AppHandle, id: &str, tab_id: &str, session_id: &str) -> Value {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else { return json!({ "ok": false, "error": "Unknown robot" }) };
    if let Some(owner) = c["tabs"].as_array().into_iter().flatten().find(|t| t["sessionId"] == session_id) {
        with(app, |st| st.store.update(id, patch(vec![("activeTab", owner["id"].clone())])));
        return json!({ "ok": true, "tabId": owner["id"], "already": true });
    }
    let Some(session) = transcripts::read(c["folder"].as_str().unwrap_or(""), session_id, 60) else {
        return json!({ "ok": false, "error": "I couldn't find that conversation any more." });
    };
    let history = history_of(&session);
    let busy = with(app, |st| is_busy(st, id, tab_id));
    let target = with(app, |st| {
        let here = st.store.tab(id, tab_id);
        let reuse = here.is_some_and(|t| t["sessionId"].is_null() && t["history"].as_array().is_none_or(Vec::is_empty)) && !busy;
        let fields = patch(vec![("sessionId", json!(session_id)), ("history", history.clone()), ("title", session["title"].clone())]);
        let target = if reuse {
            let t = st.store.update_tab(id, tab_id, fields);
            st.store.update(id, patch(vec![("activeTab", json!(tab_id))]));
            t
        } else {
            st.store.add_tab(id, fields)
        };
        if target.is_some() {
            st.store.remember_session(id, session_id);
        }
        target
    });
    let Some(target) = target else { return json!({ "ok": false, "error": "Too many tabs open. Close one first." }) };
    crate::robots::send_character(app, id);
    json!({ "ok": true, "tabId": target["id"], "title": session["title"], "total": session["total"] })
}
