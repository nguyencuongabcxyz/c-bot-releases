//! Side questions (like Claude Code's /btw): a question about an answer, asked beside the
//! conversation so it doesn't get in its way. Each thread is a conversation of its own, branched
//! off the tab's when it's first asked (--fork-session: it knows everything said up to then, and
//! the tab's conversation never hears about it), and read-only. Threads are kept with the tab
//! (tab.sides), each under the answer it's about (that answer's `at` in the tab's history).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::agents::claude::{self, Event, Session, locate, transcripts};
use crate::features::chat::{self, Chat};
use crate::robots::label_of;
use crate::runtime::util::patch;
use crate::runtime::{Locked, with};
use crate::store;
use crate::store::Fields;

// (looking, not changing: the web ones without asking)
const TOOLS: [&str; 5] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
const QUOTE_MAX: usize = 2000;
const THREADS_MAX: usize = 100; // (per tab)
const NOTE: &str = "This is a side question: the user is asking about something in your conversation, beside it, so the conversation itself stays on track (it won't see this). Answer briefly and plainly. Explain, don't do: you may look at files, but change nothing.";

// A question's words, to ask it again in a fresh conversation if the one it carries on is gone.
static TURNS: LazyLock<Mutex<HashMap<String, (String, bool)>>> = LazyLock::new(Mutex::default);

fn turns<R>(f: impl FnOnce(&mut HashMap<String, (String, bool)>) -> R) -> R {
    f(&mut TURNS.locked())
}

pub fn is_side(key: &str) -> bool {
    key.contains("|side|")
}

fn key_of(id: &str, tab_id: &str, thread_id: &str) -> String {
    format!("{}|side|{thread_id}", chat::key_of(id, tab_id))
}

fn tell(app: &AppHandle, id: &str, tab_id: &str, thread_id: &str, op: &str, payload: Value) {
    let mut p = payload;
    p["type"] = json!("side");
    p["op"] = json!(op);
    p["tabId"] = json!(tab_id);
    p["threadId"] = json!(thread_id);
    let _ = app.emit_to(label_of(id), "robot:event", p);
}

fn fail(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

/// The tab's threads, changed by `f` and kept.
fn edit_threads<R>(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    f: impl FnOnce(&mut Vec<Value>) -> R,
) -> Option<R> {
    with(app, |st| {
        let mut threads = st.store.tab(id, tab_id)?["sides"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let r = f(&mut threads);
        st.store
            .update_tab(id, tab_id, patch(vec![("sides", Value::Array(threads))]))?;
        Some(r)
    })
}

fn edit_thread(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    thread_id: &str,
    f: impl FnOnce(&mut Value),
) {
    edit_threads(app, id, tab_id, |ts| {
        if let Some(t) = ts.iter_mut().find(|t| t["id"] == thread_id) {
            f(t);
        }
    });
}

fn push(app: &AppHandle, id: &str, tab_id: &str, thread_id: &str, entry: Value) {
    edit_thread(app, id, tab_id, thread_id, |t| {
        let mut entry = entry;
        entry["at"] = json!(store::now_ms());
        match t["history"].as_array_mut() {
            Some(h) => h.push(entry),
            None => t["history"] = json!([entry]),
        }
    });
}

/// Ask in a thread: one asked before (thread_id), or a new one under the answer at `at`,
/// about `quote` (what you picked out of it; may be empty).
pub fn ask(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    thread_id: Option<&str>,
    at: Option<i64>,
    quote: &str,
    text: &str,
) -> Value {
    let text = text.trim();
    if text.is_empty() {
        return fail("Ask me something first.");
    }
    let Some((c, tab, settings)) = with(app, |st| {
        Some((
            st.store.get(id)?.clone(),
            st.store.tab(id, tab_id)?.clone(),
            st.store.settings().clone(),
        ))
    }) else {
        return fail("That conversation is gone.");
    };
    let folder = c.folder();
    if folder.is_empty() || !Path::new(folder).exists() {
        return fail("My folder is missing. Point me at a new one in the Robot Workshop.");
    }
    let Some(claude_path) = locate::find(settings["claudePath"].as_str().unwrap_or("")) else {
        return fail("I can't find Claude Code anywhere on this computer.");
    };
    let threads = tab["sides"].as_array().cloned().unwrap_or_default();
    let thread = match thread_id {
        Some(t) => match threads.iter().find(|x| x["id"] == t) {
            Some(x) => x.clone(),
            None => return fail("That side question is gone."),
        },
        None => {
            let Some(at) = at else {
                return fail("Which answer is it about?");
            };
            if threads.len() >= THREADS_MAX {
                return fail("This chat has too many side questions. Delete a few first.");
            }
            let quote: String = quote.trim().chars().take(QUOTE_MAX).collect();
            let t = json!({ "id": uuid::Uuid::new_v4().to_string(), "at": at, "quote": quote, "sessionId": null, "history": [], "createdAt": store::now_ms() });
            if edit_threads(app, id, tab_id, |ts| ts.push(t.clone())).is_none() {
                return fail("That conversation is gone.");
            }
            t
        }
    };
    let thread_id = thread.id().to_string();
    let key = key_of(id, tab_id, &thread_id);
    if with(app, |st| {
        st.chats.get(&key).is_some_and(|c| c.session.busy())
    }) {
        return fail("Wait till I've answered that one (or stop me) first.");
    }
    // its first question says what it's about
    let quote = thread["quote"].as_str().unwrap_or("");
    let prompt = if thread["history"].as_array().is_none_or(Vec::is_empty) && !quote.is_empty() {
        let quoted: Vec<String> = quote.lines().map(|l| format!("> {l}")).collect();
        format!(
            "[My side question is about this part of the conversation:]\n{}\n\n{text}",
            quoted.join("\n")
        )
    } else {
        text.to_string()
    };
    push(
        app,
        id,
        tab_id,
        &thread_id,
        json!({ "role": "user", "text": text }),
    );
    let chat = match with(app, |st| st.chats.get(&key).cloned()) {
        Some(chat) => chat,
        None => start(app, id, tab_id, &thread, &c, &tab, claude_path),
    };
    let turn_id = uuid::Uuid::new_v4().to_string();
    turns(|t| t.insert(turn_id.clone(), (prompt.clone(), false)));
    chat.session.ask(prompt, turn_id.clone());
    json!({ "ok": true, "threadId": thread_id, "turnId": turn_id })
}

/// A thread's own Claude Code process: its own conversation once it has one, else a branch of the
/// tab's as it is now (or, while the tab is still answering, as it was after its last answer).
fn start(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    thread: &Value,
    c: &Value,
    tab: &Value,
    claude_path: PathBuf,
) -> Arc<Chat> {
    let thread_id = thread.id().to_string();
    let busy = with(app, |st| chat::is_busy(st, id, tab_id));
    let last_answer = || {
        tab["history"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|h| h["role"] == "assistant")
            .and_then(|h| h["uuid"].as_str())
            .map(str::to_string)
    };
    let (session_id, fork, resume_at) = match (thread.session_id(), tab.session_id()) {
        (Some(own), _) => (Some(own.to_string()), false, None),
        (None, Some(main)) => (
            Some(main.to_string()),
            true,
            if busy { last_answer() } else { None },
        ),
        (None, None) => (None, false, None),
    };
    let opts = claude::Opts {
        claude_path,
        cwd: c.folder().into(),
        system_prompt: format!("{}\n{NOTE}", chat::prompt_for(app, c)),
        permission_mode: "default".into(),
        model: tab["model"]
            .as_str()
            .or(c["model"].as_str())
            .unwrap_or("")
            .into(), // (the tab's brain)
        effort: tab.effort().into(),
        tools: Some(TOOLS.iter().map(|t| t.to_string()).collect()),
        allowed_tools: vec!["WebSearch".into(), "WebFetch".into()],
        extra_args: vec!["--strict-mcp-config".into()], // (none of the robot's MCP tools)
        resume_at,
        fork,
        ..Default::default()
    };
    let (app2, id2, tab2, thread2) = (
        app.clone(),
        id.to_string(),
        tab_id.to_string(),
        thread_id.clone(),
    );
    let handler: claude::Handler =
        Arc::new(move |session, event| on_event(&app2, &id2, &tab2, &thread2, session, event));
    let chat = Chat::bare(Session::new(opts, session_id, handler));
    with(app, |st| {
        st.chats
            .insert(key_of(id, tab_id, &thread_id), chat.clone())
    });
    chat
}

fn on_event(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    thread_id: &str,
    session: &Arc<Session>,
    event: Event,
) {
    match event {
        // (its own conversation now: the next process carries that on)
        Event::Session(sid) => {
            edit_thread(app, id, tab_id, thread_id, |t| t["sessionId"] = json!(sid));
        }
        Event::TurnStart(turn_id) => tell(
            app,
            id,
            tab_id,
            thread_id,
            "start",
            json!({ "turnId": turn_id }),
        ),
        Event::Text(delta) => tell(
            app,
            id,
            tab_id,
            thread_id,
            "text",
            json!({ "delta": delta }),
        ),
        Event::Tool(data) => tell(
            app,
            id,
            tab_id,
            thread_id,
            "step",
            json!({ "name": data["name"], "detail": data["detail"] }),
        ),
        Event::Done(data) => {
            turns(|t| t.remove(data["turnId"].as_str().unwrap_or("")));
            push(
                app,
                id,
                tab_id,
                thread_id,
                json!({ "role": "assistant", "text": data["text"], "isError": data["isError"], "interrupted": data["interrupted"] }),
            );
            tell(
                app,
                id,
                tab_id,
                thread_id,
                "done",
                json!({ "text": data["text"], "isError": data["isError"], "interrupted": data["interrupted"] }),
            );
        }
        Event::Fail(data) => {
            let turn_id = data["turnId"].as_str().unwrap_or("").to_string();
            let retry = turns(|t| match t.get_mut(&turn_id) {
                Some((prompt, retried))
                    if data["sessionMissing"] == true
                        && session.session_id().is_some()
                        && !*retried =>
                {
                    *retried = true;
                    Some(prompt.clone())
                }
                _ => {
                    t.remove(&turn_id);
                    None
                }
            });
            if let Some(prompt) = retry {
                // the conversation it carries on is gone (its folder moved): quietly start fresh
                session.forget_session();
                edit_thread(app, id, tab_id, thread_id, |t| t["sessionId"] = Value::Null);
                session.ask(prompt, turn_id);
                return;
            }
            let cancelled = data["cancelled"] == true;
            let entry = if cancelled {
                json!({ "role": "assistant", "text": "", "interrupted": true })
            } else {
                json!({ "role": "assistant", "text": data["message"], "isError": true })
            };
            push(app, id, tab_id, thread_id, entry);
            tell(
                app,
                id,
                tab_id,
                thread_id,
                "fail",
                json!({ "message": data["message"], "cancelled": cancelled }),
            );
        }
        _ => {}
    }
}

/// Stop the thread's answer.
pub fn cancel(app: &AppHandle, id: &str, tab_id: &str, thread_id: &str) -> bool {
    let Some(chat) = with(app, |st| {
        st.chats.get(&key_of(id, tab_id, thread_id)).cloned()
    }) else {
        return false;
    };
    chat.session.interrupt();
    true
}

/// Delete a thread, and Claude Code's transcript of it.
pub fn remove(app: &AppHandle, id: &str, tab_id: &str, thread_id: &str) -> bool {
    if let Some(chat) = with(app, |st| st.chats.remove(&key_of(id, tab_id, thread_id))) {
        chat.session.close();
    }
    let gone = edit_threads(app, id, tab_id, |ts| {
        ts.iter()
            .position(|t| t["id"] == thread_id)
            .map(|i| ts.remove(i))
    })
    .flatten();
    let Some(gone) = gone else { return false };
    forget(
        app,
        id,
        gone["sessionId"]
            .as_str()
            .map(str::to_string)
            .into_iter()
            .collect(),
    );
    true
}

/// The tab's conversation closed: its threads' processes go too (they pick up again when asked).
pub fn close_tab(app: &AppHandle, id: &str, tab_id: &str) {
    let prefix = format!("{}|side|", chat::key_of(id, tab_id));
    let gone: Vec<Arc<Chat>> = with(app, |st| {
        let keys: Vec<String> = st
            .chats
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        keys.iter().filter_map(|k| st.chats.remove(k)).collect()
    });
    for chat in gone {
        chat.session.close();
    }
}

/// The tab's history cut back to `history` (an edited question): the threads still about one of
/// its answers, and the conversations of those that go.
pub fn kept_for(tab: &Value, history: &[Value]) -> (Value, Vec<String>) {
    let ats: Vec<i64> = history.iter().filter_map(|h| h["at"].as_i64()).collect();
    let (kept, gone): (Vec<Value>, Vec<Value>) = tab["sides"]
        .as_array()
        .into_iter()
        .flatten()
        .cloned()
        .partition(|t| t["at"].as_i64().is_some_and(|at| ats.contains(&at)));
    (
        Value::Array(kept),
        gone.iter()
            .filter_map(|t| t.session_id().map(str::to_string))
            .collect(),
    )
}

/// Every conversation a tab's threads have.
pub fn sessions_of(tab: &Value) -> Vec<String> {
    tab["sides"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.session_id().map(str::to_string))
        .collect()
}

/// Claude Code's transcripts of threads that are gone (once their processes have let go of them).
pub fn forget(app: &AppHandle, id: &str, sessions: Vec<String>) {
    let folder = with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["folder"].as_str().map(str::to_string))
    })
    .unwrap_or_default();
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
