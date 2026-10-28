//! What a tab's conversation does (its session's events: agents/claude/mod.rs lists them):
//! passed on to the robot's page as robot:event, and the answer kept in the tab's history.

use std::sync::MutexGuard;

use super::*;
use crate::store::Fields;

/// The tab an event is for.
#[derive(Clone, Copy)]
struct Ev<'a> {
    app: &'a AppHandle,
    id: &'a str,
    tab_id: &'a str,
    book: &'a Arc<Mutex<Book>>,
    session: &'a Arc<Session>,
}

impl Ev<'_> {
    fn book(&self) -> MutexGuard<'_, Book> {
        self.book.locked()
    }
}

pub(super) fn on_event(
    app: &AppHandle,
    id: &str,
    tab_id: &str,
    book: &Arc<Mutex<Book>>,
    session: &Arc<Session>,
    event: &str,
    data: Value,
) {
    let e = Ev {
        app,
        id,
        tab_id,
        book,
        session,
    };
    match event {
        "remote" => on_remote(e, data),
        "remote-state" => tell(
            app,
            id,
            tab_id,
            json!({ "type": "remote-state", "state": data }),
        ),
        "remote-prompt" => on_remote_prompt(e, data),
        "turn-start" => on_turn_start(e, data),
        "session" => on_session(e, data),
        "initialized" => on_initialized(e, data),
        "tools" => on_tools(e, data),
        "commands" => on_commands(e, data),
        "text" => on_text(e, data),
        "aside" => tell(app, id, tab_id, json!({ "type": "aside", "text": data })),
        "thinking" => on_thinking(e),
        "thinking-text" => on_thinking_text(e, data),
        "usage" => tell(
            app,
            id,
            tab_id,
            json!({ "type": "usage", "outputTokens": data["outputTokens"] }),
        ),
        "status" => tell(app, id, tab_id, json!({ "type": "status", "text": data })),
        "question" | "request-cancelled" | "plan" => {
            let mut p = data;
            p["type"] = json!(event);
            tell(app, id, tab_id, p);
        }
        "mode" => on_mode(e, data),
        "tool" => on_tool(e, data),
        "tool-output" => on_tool_output(e, data),
        "tool-result" => on_tool_result(e, data),
        "edit" => on_edit(e, data),
        "agent" => on_agent(e, data),
        "task" => on_task(e, data),
        "compact" => on_compact(e, data),
        "done" => on_done(e, data),
        "fail" => on_fail(e, data),
        _ => {}
    }
}

/// Remote Control came on (its page on claude.ai), went off, or couldn't
fn on_remote(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let on = data["on"] == true;
    with(app, |st| {
        st.store.update_tab(
            id,
            tab_id,
            patch(vec![
                ("remote", json!(on)),
                ("remoteSession", data["remoteSession"].clone()),
                ("remoteUrl", data["url"].clone()),
            ]),
        )
    });
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "remote", "on": on, "url": data["url"], "error": data["error"] }),
    );
}

/// A message typed on claude.ai/code or in the Claude app: into the chat as yours
fn on_remote_prompt(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let folder = with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["folder"].as_str().map(str::to_string))
    })
    .unwrap_or_default();
    let (sid, uuid) = (
        data["sessionId"].as_str().unwrap_or(""),
        data["uuid"].as_str().unwrap_or(""),
    );
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
    with(app, |st| {
        st.store.push_history(
            id,
            tab_id,
            json!({ "role": "user", "text": text, "tag": tag }),
        )
    });
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "remote-prompt", "text": text, "tag": tag }),
    );
}

fn on_turn_start(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let turn_id = data.as_str().unwrap_or("").to_string();
    let kind = {
        let mut b = e.book();
        b.text_len = 0;
        b.media_left = KEEP_MEDIA;
        b.turns.get(&turn_id).map(|t| t.kind)
    };
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "turn-start", "turnId": turn_id, "kind": kind }),
    );
}

fn on_session(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let sid = data.as_str().unwrap_or("");
    with(app, |st| {
        let tab = st.store.tab(id, tab_id).cloned().unwrap_or_default();
        st.store
            .update_tab(id, tab_id, patch(vec![("sessionId", json!(sid))]));
        if tab["temporary"] == true {
            // (not one of the robot's past conversations: kept to throw away when the chat closes)
            let mut seen = sessions_of(&tab);
            if !seen.iter().any(|s| s == sid) {
                seen.push(sid.to_string());
            }
            st.store
                .update_tab(id, tab_id, patch(vec![("tempSessions", json!(seen))]));
        } else {
            st.store.remember_session(id, sid);
        }
    });
}

fn on_initialized(e: Ev, data: Value) {
    let Ev { app, .. } = e;
    let models: Vec<Value> = data["models"].as_array().into_iter().flatten().filter(|m| !m["value"].as_str().unwrap_or("").starts_with("claude-")).map(|m| {
        let value = if m["value"] == "default" { json!("") } else { m["value"].clone() };
        json!({ "value": value, "displayName": m["displayName"], "description": m["description"], "efforts": m.get("supportedEffortLevels").cloned().unwrap_or(json!([])) })
    }).collect();
    if !models.is_empty() {
        with(app, |st| st.model_choices = Value::Array(models));
    }
}

fn on_tools(e: Ev, data: Value) {
    let Ev { app, session, .. } = e;
    // learn Claude Code's default tools once (per version), so later sessions can add the task tools to them
    if data["chosen"].as_bool() != Some(true) {
        let tools: Vec<String> = data["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str())
            .filter(|t| !t.starts_with("mcp__"))
            .map(str::to_string)
            .collect();
        with(app, |st| {
            st.store.update_settings(patch(vec![(
                "toolset",
                json!({ "version": data["version"], "tools": tools }),
            )]))
        });
        // this conversation started without the task tools: pick them up from its next question
        session.set_tools(tools);
    } else {
        with(app, |st| {
            let cached = &st.store.settings()["toolset"];
            if cached.is_object() && cached["version"] != data["version"] {
                st.store
                    .update_settings(patch(vec![("toolset", Value::Null)]));
            }
        });
    }
}

fn on_commands(e: Ev, data: Value) {
    let Ev { app, id, .. } = e;
    with(app, |st| {
        // keep descriptions we already know when init only gives us names
        let known: HashMap<String, Value> = st
            .store
            .get(id)
            .and_then(|c| c["claudeCommands"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .map(|c| (c.name().to_string(), c["description"].clone()))
            .collect();
        let merged: Vec<Value> = data
            .as_array()
            .into_iter()
            .flatten()
            .take(200)
            .map(|c| {
                let name = c.name();
                let desc = c["description"]
                    .as_str()
                    .filter(|d| !d.is_empty())
                    .map(|d| json!(d))
                    .or_else(|| known.get(name).cloned())
                    .unwrap_or(json!(""));
                json!({ "name": name, "description": desc })
            })
            .collect();
        st.store
            .update(id, patch(vec![("claudeCommands", Value::Array(merged))]));
    });
}

fn on_text(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let delta = data.as_str().unwrap_or("");
    let mut b = e.book();
    b.text_len += delta.encode_utf16().count();
    b.thinking = None; // (done thinking: it's talking)
    drop(b);
    tell(app, id, tab_id, json!({ "type": "text", "delta": delta }));
}

/// Its thinking: a step of its own in the answer (where it came), its words streamed into it
fn on_thinking(e: Ev) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    tell(app, id, tab_id, json!({ "type": "thinking" }));
    let mut b = e.book();
    b.thoughts += 1;
    let step = format!("think-{}", b.thoughts);
    b.thinking = Some(step.clone());
    if b.calls.len() < KEEP_CALLS {
        let at = b.text_len;
        b.calls
            .push(json!({ "id": step, "name": "Thinking", "detail": "", "at": at, "output": "" }));
    }
    drop(b);
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "tool", "id": step, "name": "Thinking", "detail": "", "args": null }),
    );
}

fn on_thinking_text(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let delta = data.as_str().unwrap_or("");
    let mut b = e.book();
    let Some(step) = b.thinking.clone() else {
        return;
    };
    if let Some(call) = b.calls.iter_mut().find(|c| c["id"] == step.as_str()) {
        let so_far = call["output"].as_str().unwrap_or("");
        if so_far.len() < KEEP.output * 2 {
            call["output"] = json!(format!("{so_far}{delta}"));
        }
    }
    drop(b);
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "thinking-text", "id": step, "delta": delta }),
    );
}

/// It went into plan mode by itself (or out of it): the tab keeps the mode it's in
fn on_mode(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mode = data.as_str().unwrap_or("default");
    with(app, |st| {
        st.store
            .update_tab(id, tab_id, patch(vec![("permissionMode", json!(mode))]))
    });
    tell(app, id, tab_id, json!({ "type": "mode", "mode": mode }));
}

fn on_tool(e: Ev, data: Value) {
    let Ev {
        app,
        id,
        tab_id,
        book,
        ..
    } = e;
    e.book().thinking = None; // (done thinking: it's doing)
    // what it was called with (click the step in the chat to see it), and a smaller copy kept with the answer
    let args = data["args"].clone();
    let mut p = data.clone();
    let o = p.as_object_mut().unwrap();
    o.remove("input");
    o.insert("type".into(), json!("tool"));
    o.insert("args".into(), clip(&args, &LIVE, 0));
    tell(app, id, tab_id, p);
    let mut b = e.book();
    if b.calls.len() < KEEP_CALLS {
        let at = b.text_len;
        b.calls.push(json!({ "id": data["id"], "name": data["name"], "detail": data["detail"], "args": clip(&args, &KEEP, 0), "at": at }));
    }
    if data.get("input").is_none() {
        return;
    }
    // an MCP tool: if it comes with its own view (an MCP App), show it in the chat
    let call_id = data["id"].as_str().unwrap_or("").to_string();
    b.mcp_calls.insert(
        call_id.clone(),
        json!({ "name": data["name"], "input": data["input"] }),
    );
    drop(b);
    let (app, id, tab_id, book) = (
        app.clone(),
        id.to_string(),
        tab_id.to_string(),
        book.clone(),
    );
    let tool = data["name"].as_str().unwrap_or("").to_string();
    // (looked up off this thread: it may ask the tool's server, which takes a moment)
    thread::spawn(move || {
        let folder = with(&app, |st| {
            st.store
                .get(&id)
                .and_then(|c| c["folder"].as_str().map(str::to_string))
        })
        .unwrap_or_default();
        let view = apps::app_for(&app, &tool, &folder);
        let shown = {
            let mut b = book.locked();
            let Some(call) = b.mcp_calls.get_mut(&call_id) else {
                return;
            }; // (its answer is already done with it)
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

/// What a tool gave back: to the chat (its step shows it), and trimmed with the answer
fn on_tool_output(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let text = data["text"].as_str().unwrap_or("");
    let (live, _) = step_media(&data["media"], LIVE_MEDIA);
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "tool-output", "id": data["id"], "text": cut(text, LIVE.output), "media": live, "isError": data["isError"] }),
    );
    let mut b = e.book();
    let left = b.media_left;
    let Some(call) = b.calls.iter_mut().find(|c| c["id"] == data["id"]) else {
        return;
    };
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

fn on_tool_result(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mut b = e.book();
    let call_id = data["id"].as_str().unwrap_or("").to_string();
    let Some(call) = b.mcp_calls.get_mut(&call_id) else {
        return;
    };
    call["result"] = data["result"].clone();
    if call.get("view").is_some() {
        tell(
            app,
            id,
            tab_id,
            json!({ "type": "app-result", "id": call_id, "result": data["result"] }),
        );
    }
    // pictures the tool returned (a screenshot, a rendered chart): shown in the answer
    let pics: Vec<Value> = data["result"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["type"] == "image"
                && claude::is_image_mime(c["mimeType"].as_str().unwrap_or(""))
                && c["data"].is_string()
        })
        .take(6)
        .map(|c| json!({ "id": call_id, "mimeType": c["mimeType"], "data": c["data"] }))
        .collect();
    if pics.is_empty() {
        return;
    }
    // kept with the answer while they're small, so the store file stays light
    for pic in &pics {
        let used: usize = b
            .images
            .iter()
            .map(|k| k["data"].as_str().map_or(0, str::len))
            .sum();
        if used + pic["data"].as_str().map_or(0, str::len) < 800_000 {
            b.images.push(pic.clone());
        }
    }
    drop(b);
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "tool-images", "id": call_id, "images": pics }),
    );
}

/// Files it changed: shown as diffs now, and kept (trimmed) with the answer in history
fn on_edit(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mut p = data.clone();
    p["type"] = json!("edit");
    tell(app, id, tab_id, p);
    let mut b = e.book();
    if b.edits.len() < 20 {
        let mut kept = data.clone();
        let truncated =
            data["truncated"].as_bool().unwrap_or(false) || count_lines(&data["hunks"]) > 120;
        kept["hunks"] = trim_hunks(&data["hunks"], 120);
        kept["truncated"] = json!(truncated);
        b.edits.push(kept);
    }
}

fn on_agent(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mut ev = data;
    // a background helper's full report sits in a file; short ones are already in the summary
    if ev["op"] == "done"
        && !ev["outputFile"].as_str().unwrap_or("").is_empty()
        && let Ok(report) = std::fs::read_to_string(ev["outputFile"].as_str().unwrap())
    {
        let report = report.trim();
        if !report.is_empty() && report.len() > ev["summary"].as_str().map_or(0, str::len) {
            let chars: Vec<char> = report.chars().collect();
            ev["report"] = json!(
                chars[chars.len().saturating_sub(20000)..]
                    .iter()
                    .collect::<String>()
            );
        }
    }
    if let Some(o) = ev.as_object_mut() {
        o.remove("outputFile");
    }
    ev["type"] = json!("agent");
    tell(app, id, tab_id, ev);
}

fn on_task(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
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
                        let set = !matches!(v, Value::Null | Value::Bool(false))
                            && v != ""
                            && v != 0
                            && k != "op";
                        if set {
                            x[k] = v.clone();
                        }
                    }
                }
            }
        }
        tasks.retain(|x| x["status"] != "deleted");
        st.store
            .update_tab(id, tab_id, patch(vec![("tasks", json!(tasks))]))?;
        Some(tasks)
    });
    if let Some(tasks) = tasks {
        tell(
            app,
            id,
            tab_id,
            json!({ "type": "tasks", "tasks": tasks, "change": data }),
        );
    }
}

fn on_compact(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    e.book().last_compact = data.clone();
    let mut p = data;
    p["type"] = json!("compact");
    tell(app, id, tab_id, p);
}

fn on_done(e: Ev, data: Value) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let turn_id = data["turnId"].as_str().unwrap_or("").to_string();
    let (kind, last_compact, (edits, apps, images, tools)) = {
        let mut b = e.book();
        let kind = b.turns.remove(&turn_id).map(|t| t.kind);
        (kind, b.last_compact.clone(), b.take())
    };
    let kept = with(app, |st| {
        let c = st.store.get(id)?.clone();
        if kind == Some(AskKind::Compact) {
            let text = match (last_compact["pre"].as_f64(), last_compact["post"].as_f64()) {
                (Some(pre), Some(post)) if pre > 0.0 => format!(
                    "🗜️ Compacted my memory: {}k → {}k tokens",
                    (pre / 1000.0).round(),
                    (post / 1000.0).round()
                ),
                _ => "🗜️ Compacted my memory".into(),
            };
            st.store
                .push_history(id, tab_id, json!({ "role": "note", "text": text }));
        } else {
            st.store.push_history(
                id,
                tab_id,
                entry(vec![
                    ("role", json!("assistant")),
                    ("text", data["text"].clone()),
                    ("asides", data["asides"].clone()),
                    ("isError", data["isError"].clone()),
                    ("denials", data["denials"].clone()),
                    ("interrupted", data["interrupted"].clone()),
                    ("edits", edits),
                    ("apps", apps),
                    ("images", images),
                    ("tools", tools),
                    ("uuid", data["uuid"].clone()), // (where an edited question after it rewinds to)
                ]),
            );
        }
        if let Some(sid) = data["sessionId"].as_str() {
            st.store
                .update_tab(id, tab_id, patch(vec![("sessionId", json!(sid))]));
        }
        let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
        let cost = stats.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0)
            + data["costUsd"].as_f64().unwrap_or(0.0);
        stats.insert("costUsd".into(), json!(cost));
        st.store
            .update(id, patch(vec![("stats", Value::Object(stats))]));
        // (when the answer went in: what its side questions hang from, features/chat/side.rs)
        Some(
            st.store
                .tab(id, tab_id)
                .and_then(|t| t["history"].as_array()?.last()?.get("at").cloned())
                .unwrap_or(Value::Null),
        )
    });
    let Some(at) = kept else { return };
    let mut p = data;
    p["type"] = json!("done");
    p["at"] = at;
    p["kind"] = json!(kind);
    tell(app, id, tab_id, p);
    refresh_context(app, id, tab_id);
}

fn on_fail(e: Ev, data: Value) {
    let Ev {
        app,
        id,
        tab_id,
        session,
        ..
    } = e;
    let turn_id = data["turnId"].as_str().unwrap_or("").to_string();
    let retry = {
        let mut b = e.book();
        match b.turns.get_mut(&turn_id) {
            Some(t)
                if data["sessionMissing"].as_bool() == Some(true)
                    && session.session_id().is_some()
                    && !t.retried =>
            {
                t.retried = true;
                Some(t.prompt.clone())
            }
            _ => None,
        }
    };
    if let Some(prompt) = retry {
        // The old conversation is gone (e.g. folder moved): quietly start fresh.
        session.forget_session();
        with(app, |st| {
            st.store
                .update_tab(id, tab_id, patch(vec![("sessionId", Value::Null)]))
        });
        session.ask(prompt, turn_id);
        return;
    }
    let (edits, apps, images, tools) = {
        let mut b = e.book();
        b.turns.remove(&turn_id);
        b.take()
    };
    if data["cancelled"].as_bool() != Some(true) {
        with(app, |st| {
            st.store.push_history(
                id,
                tab_id,
                entry(vec![
                    ("role", json!("assistant")),
                    ("text", data["message"].clone()),
                    ("isError", json!(true)),
                    ("edits", edits),
                    ("apps", apps),
                    ("images", images),
                    ("tools", tools),
                ]),
            )
        });
    }
    let mut p = data;
    p["type"] = json!("fail");
    tell(app, id, tab_id, p);
}
