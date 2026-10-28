//! What a robot's page asks of its chats: a question, stopping, answering Claude, the queue,
//! rewinding, the brain (model, effort, permission mode), plans to approve, Remote Control.

use serde::{Deserialize, Serialize};

use super::*;
use crate::runtime::{Error, Locked};
use crate::store::Fields;

// ---------------------------------------------------------------- what the page asks

pub fn is_busy(st: &crate::runtime::State, id: &str, tab_id: &str) -> bool {
    st.chats
        .get(&key_of(id, tab_id))
        .is_some_and(|c| c.session.busy())
}

pub fn close(app: &AppHandle, id: &str, tab_id: &str) {
    if let Some(chat) = with(app, |st| st.chats.remove(&key_of(id, tab_id))) {
        chat.session.close();
    }
    side::close_tab(app, id, tab_id); // (its side questions' too: they pick up again when asked)
}

pub fn close_robot(app: &AppHandle, id: &str) {
    let prefix = format!("{id}|");
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

/// A new permission mode from the Workshop or the robot's menu: its live conversations
/// switch now (the next ones start with it), and its tabs forget the modes picked in them.
pub fn set_permission_mode(app: &AppHandle, id: &str, mode: &str) {
    let tabs: Vec<String> = with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["tabs"].as_array().cloned())
            .unwrap_or_default()
    })
    .iter()
    .filter(|t| !t["permissionMode"].is_null())
    .filter_map(|t| t["id"].as_str().map(str::to_string))
    .collect();
    for tab_id in tabs {
        with(app, |st| {
            st.store
                .update_tab(id, &tab_id, patch(vec![("permissionMode", Value::Null)]))
        });
        tell(app, id, &tab_id, PageEvent::Mode { mode: mode.into() });
    }
    let prefix = format!("{id}|");
    // (side questions stay read-only)
    let live: Vec<Arc<Chat>> = with(app, |st| {
        st.chats
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix) && !side::is_side(k))
            .map(|(_, c)| c.clone())
            .collect()
    });
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
        let at = before
            .iter()
            .rev()
            .find(|h| h["role"] == "assistant")
            .and_then(|h| h["uuid"].as_str())
            .map(str::to_string);
        Some((last, history[last].clone(), talked, at))
    });
    let Some((last, question, talked, at)) = found else {
        return json!({ "ok": false, "error": "There's no question to edit." });
    };
    if talked && at.is_none() {
        return json!({ "ok": false, "error": "That one's too old to edit (it was asked before I could go back in a conversation)." });
    }
    close(app, id, tab_id);
    let dropped = with(app, |st| {
        let tab = st.store.tab(id, tab_id).cloned()?;
        let kept: Vec<Value> = tab["history"]
            .as_array()?
            .iter()
            .take(last)
            .cloned()
            .collect();
        // (side questions about the answers taken out go with them)
        let (sides, dropped) = side::kept_for(&tab, &kept);
        let mut fields = vec![("history", Value::Array(kept)), ("sides", sides)];
        if let Some(at) = &at {
            fields.push(("resumeAt", json!(at)));
        } else {
            fields.extend([("sessionId", Value::Null), ("resumeAt", Value::Null)]); // (it was the first question: start afresh)
        }
        st.store.update_tab(id, tab_id, patch(fields))?;
        Some(dropped)
    })
    .unwrap_or_default();
    side::forget(app, id, dropped);
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
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(60));
            let idle: Vec<Arc<Chat>> = with(&app, |st| {
                let keys: Vec<String> = st
                    .chats
                    .iter()
                    .filter(|(_, c)| {
                        let s = &c.session;
                        !s.busy()
                            && s.helpers_running() == 0
                            && s.alive()
                            && !s.remote()
                            && s.idle_for() > IDLE_CLOSE
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                keys.iter().filter_map(|k| st.chats.remove(k)).collect()
            });
            for chat in idle {
                chat.session.close();
            }
        }
    });
}

/// What a question is (the page hears it back with the turn: "chat", "bonk", "compact").
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    #[default]
    Chat,
    Bonk, // starting over, quicker
    Compact,
}

/// A question for a tab's conversation.
pub struct Ask<'a> {
    pub prompt: &'a str,
    pub attachments: &'a [Value], // (paths of files dropped on it)
    pub turn_id: Option<String>,  // (none: a new one)
    pub kind: AskKind,
    pub tag: Option<&'a str>, // a line kept above your message (sent to everyone on the stage: who got it)
}

pub fn ask(app: &AppHandle, id: &str, tab_id: &str, ask: Ask) -> Value {
    let Ask {
        prompt,
        attachments,
        turn_id,
        kind,
        tag,
    } = ask;
    let c = match ready(app, id, tab_id) {
        Ok(c) => c,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let turn_id = turn_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let fed = with_files(prompt, attachments, c.folder());
    with(app, |st| {
        if kind == AskKind::Bonk {
            st.store.push_history(
                id,
                tab_id,
                json!({ "role": "note", "text": "🔨 Bonked! Starting over, quicker." }),
            );
        }
        if kind == AskKind::Chat {
            let files: Vec<Value> = fed
                .dropped
                .iter()
                .map(|f| json!({ "name": f["name"], "isDir": f["isDir"], "isImage": f["isImage"] }))
                .collect();
            let mut entry = json!({ "role": "user", "text": prompt, "files": files });
            if let Some(tag) = tag.filter(|t| !t.is_empty()) {
                entry["tag"] = json!(tag.chars().take(200).collect::<String>());
            }
            st.store.push_history(id, tab_id, entry);
            let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
            let n = stats.get("questions").and_then(Value::as_i64).unwrap_or(0) + 1;
            stats.insert("questions".into(), json!(n));
            st.store
                .update(id, patch(vec![("stats", Value::Object(stats))]));
        }
    });

    let Some(chat) = chat_for(app, id, tab_id) else {
        return json!({ "ok": false, "error": "I can't find Claude Code anywhere on this computer." });
    };
    chat.session.set_system_prompt(&prompt_for(app, &c)); // personality changes (and who else is out) apply from the next question
    chat.session.allow_dirs(&fed.add_dirs);
    chat.book.locked().turns.insert(
        turn_id.clone(),
        TurnInfo {
            prompt: fed.prompt.clone(),
            kind,
            retried: false,
        },
    );
    let queued = chat.session.ask(fed.prompt, turn_id.clone());
    json!({ "ok": true, "turnId": turn_id, "queued": queued })
}

/// Can the tab be asked: it's there, not open in the terminal, Claude Code is installed, the
/// robot's folder is there. The robot, if so; else what's wrong, for the chat.
fn ready(app: &AppHandle, id: &str, tab_id: &str) -> Result<Value, Error> {
    let Some((c, settings)) = with(app, |st| {
        st.store.tab(id, tab_id)?;
        Some((st.store.get(id)?.clone(), st.store.settings().clone()))
    }) else {
        return Err("That conversation is gone.".into());
    };
    if with(app, |st| st.terminals.get(id).is_some_and(|t| t == tab_id)) {
        return Err(
            "This conversation is open in the terminal. Carry on there, or close it to chat here."
                .into(),
        );
    }
    if locate::find(settings["claudePath"].as_str().unwrap_or("")).is_none() {
        return Err("I can't find Claude Code anywhere on this computer. Install it, then press “Search again” in the Robot Workshop (bottom left), or point me to it there.".into());
    }
    let folder = c.folder();
    if folder.is_empty() || !Path::new(folder).exists() {
        let shown = if folder.is_empty() { "(none)" } else { folder };
        return Err(format!(
            "My folder is missing: {shown}. Point me at a new one in the Robot Workshop."
        )
        .into());
    }
    Ok(c)
}

/// The question with the files that go with it: the ones dropped on the robot, and the ones
/// mentioned with @.
struct Fed {
    prompt: String,        // the question, naming the files
    dropped: Vec<Value>,   // (files::inspect of each)
    add_dirs: Vec<String>, // their folders outside the robot's, for Claude Code to read
}

fn with_files(prompt: &str, attachments: &[Value], folder: &str) -> Fed {
    let dropped: Vec<Value> = attachments
        .iter()
        .filter_map(|a| a.as_str())
        .filter_map(files::inspect)
        .take(20)
        .collect();
    let mut full = prompt.to_string();
    let list = |fs: &[Value]| {
        fs.iter()
            .map(|f| {
                format!(
                    "- {}{}",
                    f["path"].as_str().unwrap_or(""),
                    if f["isDir"] == true { " (folder)" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    if !dropped.is_empty() {
        let (this, it) = if dropped.len() == 1 {
            ("this", "it")
        } else {
            ("these", "them")
        };
        full += &format!(
            "\n\n[The user dropped {this} onto you. Read {it} as needed:]\n{}",
            list(&dropped)
        );
    }
    // files mentioned with @ in the message: spell out exactly which ones
    let dropped_paths: Vec<String> = dropped
        .iter()
        .map(|f| files::normalize(Path::new(f["path"].as_str().unwrap_or(""))))
        .collect();
    let mentioned: Vec<Value> = files::mentioned(folder, prompt)
        .into_iter()
        .filter(|p| !dropped_paths.contains(p))
        .filter_map(|p| files::inspect(&p))
        .collect();
    if !mentioned.is_empty() {
        let it = if mentioned.len() == 1 { "it" } else { "them" };
        full += &format!(
            "\n\n[Files the user mentioned with @. Read {it} as needed:]\n{}",
            list(&mentioned)
        );
    }
    let mut add_dirs: Vec<String> = vec![];
    for f in dropped.iter().chain(&mentioned) {
        let p = f["path"].as_str().unwrap_or("");
        let dir = if f["isDir"] == true {
            p.to_string()
        } else {
            Path::new(p)
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        if !dir.is_empty() && !files::is_inside(&dir, folder) && !add_dirs.contains(&dir) {
            add_dirs.push(dir);
        }
    }
    Fed {
        prompt: full,
        dropped,
        add_dirs,
    }
}

pub(super) fn chat_of(app: &AppHandle, id: &str, tab_id: &str) -> Option<Arc<Chat>> {
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
        with(app, |st| {
            st.store.update_tab(
                id,
                tab_id,
                patch(vec![
                    ("remote", json!(false)),
                    ("remoteSession", Value::Null),
                    ("remoteUrl", Value::Null),
                ]),
            )
        });
        match chat_of(app, id, tab_id) {
            Some(chat) => chat.session.set_remote(None),
            None => tell(
                app,
                id,
                tab_id,
                PageEvent::Remote {
                    on: false,
                    url: None,
                    error: None,
                },
            ),
        }
        return json!({ "ok": true });
    }
    if with(app, |st| st.terminals.get(id).is_some_and(|t| t == tab_id)) {
        return json!({ "ok": false, "error": "This conversation is open in the terminal. Close it first (or type /remote-control there)." });
    }
    let folder = c.folder();
    if folder.is_empty() || !Path::new(folder).exists() {
        return json!({ "ok": false, "error": "My folder is missing. Point me at a new one in the Robot Workshop." });
    }
    let Some(chat) = chat_for(app, id, tab_id) else {
        return json!({ "ok": false, "error": "I can't find Claude Code anywhere on this computer." });
    };
    with(app, |st| {
        st.store
            .update_tab(id, tab_id, patch(vec![("remote", json!(true))]))
    });
    chat.session.set_remote(Some(remote_name(&c)));
    json!({ "ok": true })
}

/// When C-Bot starts: conversations left with Remote Control on are reachable again.
pub fn revive_remote(app: &AppHandle) {
    let tabs: Vec<(String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .flat_map(|c| {
                let id = c.id().to_string();
                c["tabs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|t| t["remote"] == true)
                    .map(move |t| (id.clone(), t.id().to_string()))
            })
            .collect()
    });
    for (id, tab_id) in tabs {
        if let Some(chat) = chat_for(app, &id, &tab_id) {
            chat.session.warm();
        }
    }
}

/// Stop: interrupt the current answer; questions typed ahead come back unsent.
pub fn cancel(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let dropped = chat_of(app, id, tab_id)
        .map(|c| c.session.interrupt())
        .unwrap_or_default();
    if !dropped.is_empty() {
        tell(
            app,
            id,
            tab_id,
            PageEvent::Dropped {
                turn_ids: dropped.clone(),
            },
        );
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
    let Some((models, model, effort, mode, trusted)) = with(app, |st| {
        let c = st.store.get(id)?;
        let tab = st.store.tab(id, tab_id)?;
        let model = tab["model"]
            .as_str()
            .or(c["model"].as_str())
            .unwrap_or("")
            .to_string();
        Some((
            st.model_choices.clone(),
            model,
            tab.effort().to_string(),
            mode_of(c, tab).to_string(),
            allowed_mode(c, "bypassPermissions"),
        ))
    }) else {
        return Value::Null;
    };
    json!({ "models": models, "model": model, "effort": effort, "permissionMode": mode, "canBypass": trusted, "context": refresh_context(app, id, tab_id) })
}

pub fn set_brain(app: &AppHandle, id: &str, tab_id: &str, p: &Value) -> Value {
    if with(app, |st| st.store.tab(id, tab_id).is_none()) {
        return json!({ "ok": false });
    }
    let chat = chat_of(app, id, tab_id);
    let result = (|| -> Result<(), Error> {
        if let Some(model) = p["model"].as_str() {
            with(app, |st| {
                st.store
                    .update_tab(id, tab_id, patch(vec![("model", json!(model))]))
            });
            if let Some(c) = &chat {
                c.session.set_model(model)?;
            }
        }
        if let Some(effort) = p["effort"].as_str() {
            with(app, |st| {
                st.store
                    .update_tab(id, tab_id, patch(vec![("effort", json!(effort))]))
            });
            if let Some(c) = &chat {
                c.session.set_effort(effort)?;
            }
        }
        if let Some(mode) = p["permissionMode"].as_str() {
            if !with(app, |st| {
                st.store.get(id).is_some_and(|c| allowed_mode(c, mode))
            }) {
                return Err("This robot isn't trusted with that. Change its permissions in the Robot Workshop.".into());
            }
            with(app, |st| {
                st.store
                    .update_tab(id, tab_id, patch(vec![("permissionMode", json!(mode))]))
            });
            if let Some(c) = &chat {
                c.session.set_permission_mode(mode);
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
pub fn answer(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    request_id: &str,
    answers: &Value,
    items: &Value,
) -> bool {
    if !answers.is_object() {
        return false;
    }
    let ok =
        chat_of(app, id, tab_id).is_some_and(|c| c.session.answer(request_id, answers.clone()));
    if ok && let Some(items) = items.as_array() {
        let items: Vec<Value> = items.iter().take(8).cloned().collect();
        with(app, |st| {
            st.store
                .push_history(id, tab_id, json!({ "role": "qa", "items": items }))
        });
    }
    ok
}

/// Your call on a plan it made: go ahead (in this permission mode) or keep planning, with notes.
/// The plan and what you said are kept in the history.
pub fn decide_plan(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    request_id: &str,
    plan: &str,
    go_mode: Option<&str>,
    feedback: &str,
) -> Value {
    if let Some(mode) = go_mode
        && !with(app, |st| {
            st.store
                .get(id)
                .is_some_and(|c| allowed_mode(c, mode) && mode != "plan")
        })
    {
        return json!({ "ok": false, "error": "This robot isn't trusted with that." });
    }
    let feedback: String = feedback.chars().take(4000).collect();
    if !chat_of(app, id, tab_id)
        .is_some_and(|c| c.session.decide_plan(request_id, go_mode, &feedback))
    {
        return json!({ "ok": false });
    }
    let plan: String = plan.chars().take(20000).collect();
    with(app, |st| {
        if let Some(mode) = go_mode {
            st.store
                .update_tab(id, tab_id, patch(vec![("permissionMode", json!(mode))]));
        }
        st.store.push_history(id, tab_id, json!({ "role": "plan", "plan": plan, "approved": go_mode.is_some(), "mode": go_mode, "feedback": feedback }));
    });
    if let Some(mode) = go_mode {
        tell(app, id, tab_id, PageEvent::Mode { mode: mode.into() });
    }
    json!({ "ok": true })
}

/// Past conversations in the robot's folder, newest first.
pub fn sessions(app: &AppHandle, id: &str) -> Value {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return json!([]);
    };
    let folder = c.folder();
    if folder.is_empty() {
        return json!([]);
    }
    // sessions open in a tab are always the robot's, even if they predate session tracking
    let tabs = c["tabs"].as_array().cloned().unwrap_or_default();
    // (a temporary chat's aren't listed: they go when it closes)
    let mut temporary: Vec<String> = tabs
        .iter()
        .filter(|t| t["temporary"] == true)
        .flat_map(sessions_of)
        .collect();
    // (nor are side questions: each is a branch of the conversation it's beside)
    temporary.extend(
        tabs.iter()
            .chain(c["closedTabs"].as_array().into_iter().flatten())
            .flat_map(side::sessions_of),
    );
    let tabs: Vec<Value> = tabs
        .into_iter()
        .filter(|t| t["temporary"] != true)
        .collect();
    let open: HashMap<String, Value> = tabs
        .iter()
        .filter_map(|t| Some((t.session_id()?.to_string(), t["id"].clone())))
        .collect();
    let mut mine: Vec<String> = c["sessionIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_string))
        .collect();
    mine.extend(open.keys().cloned());
    let active_session = tabs
        .iter()
        .find(|t| t["id"] == c["activeTab"])
        .and_then(|t| t.session_id())
        .map(str::to_string);
    let rows = transcripts::list(folder, &mine, 60)
        .into_iter()
        .filter(|s| !temporary.iter().any(|t| s["id"] == t.as_str()))
        .map(|mut s| {
            let sid = s["id"].as_str().unwrap_or("").to_string();
            s["current"] = json!(active_session.as_deref() == Some(sid.as_str()));
            s["tabId"] = open.get(&sid).cloned().unwrap_or(Value::Null);
            s
        });
    Value::Array(rows.collect())
}
