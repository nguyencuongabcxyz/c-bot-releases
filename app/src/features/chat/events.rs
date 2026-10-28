//! What a tab's conversation does (its session's events: agents/claude/mod.rs lists them):
//! passed on to the robot's page as robot:event, and the answer kept in the tab's history.

use std::sync::MutexGuard;

use super::*;
use crate::agents::{
    AgentEvent, Compact, Diff, Done, Event, Fail, ModelChoice, Remote, RemotePrompt, SlashCommand,
    TaskChange, Tool, ToolOutput, ToolResult, Tools,
};
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
    event: Event,
) {
    let e = Ev {
        app,
        id,
        tab_id,
        book,
        session,
    };
    match event {
        Event::Remote(data) => on_remote(e, data),
        Event::RemoteState(state) => tell(app, id, tab_id, PageEvent::RemoteState { state }),
        Event::RemotePrompt(data) => on_remote_prompt(e, data),
        Event::TurnStart(turn_id) => on_turn_start(e, turn_id),
        Event::Session(sid) => on_session(e, &sid),
        Event::Initialized(data) => on_initialized(e, data),
        Event::Tools(data) => on_tools(e, data),
        Event::Commands(data) => on_commands(e, data),
        Event::Text(delta) => on_text(e, &delta),
        Event::Aside(text) => tell(app, id, tab_id, PageEvent::Aside { text }),
        Event::Thinking => on_thinking(e),
        Event::ThinkingText(delta) => on_thinking_text(e, &delta),
        Event::Usage(tokens) => tell(
            app,
            id,
            tab_id,
            PageEvent::Usage {
                output_tokens: tokens,
            },
        ),
        Event::Status(text) => tell(app, id, tab_id, PageEvent::Status { text }),
        Event::Question(q) => tell(app, id, tab_id, PageEvent::Question(q)),
        Event::RequestCancelled(request_id) => {
            tell(app, id, tab_id, PageEvent::RequestCancelled { request_id })
        }
        Event::Plan(p) => tell(app, id, tab_id, PageEvent::Plan(p)),
        Event::Mode(mode) => on_mode(e, &mode),
        Event::Tool(data) => on_tool(e, data),
        Event::ToolOutput(data) => on_tool_output(e, data),
        Event::ToolResult(data) => on_tool_result(e, data),
        Event::Edit(data) => on_edit(e, data),
        Event::Agent(data) => on_agent(e, data),
        Event::Task(data) => on_task(e, data),
        Event::Compact(data) => on_compact(e, data),
        Event::Done(data) => on_done(e, data),
        Event::Fail(data) => on_fail(e, data),
        Event::Exit => {}
    }
}

/// Remote Control came on (its page on claude.ai), went off, or couldn't
fn on_remote(e: Ev, r: Remote) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    with(app, |st| {
        st.store.update_tab(
            id,
            tab_id,
            patch(vec![
                ("remote", json!(r.on)),
                ("remoteSession", json!(r.remote_session)),
                ("remoteUrl", json!(r.url)),
            ]),
        )
    });
    tell(
        app,
        id,
        tab_id,
        PageEvent::Remote {
            on: r.on,
            url: r.url,
            error: r.error,
        },
    );
}

/// A message typed on claude.ai/code or in the Claude app: into the chat as yours
fn on_remote_prompt(e: Ev, p: RemotePrompt) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let folder = with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["folder"].as_str().map(str::to_string))
    })
    .unwrap_or_default();
    let (sid, uuid) = (p.session_id.as_str(), p.uuid.as_str());
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
        PageEvent::RemotePrompt {
            text,
            tag: tag.into(),
        },
    );
}

fn on_turn_start(e: Ev, turn_id: String) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let kind = {
        let mut b = e.book();
        b.text_len = 0;
        b.media_left = KEEP_MEDIA;
        b.now = tabs::Now::asked(b.turns.get(&turn_id).map_or("", |t| t.prompt.as_str()));
        b.turns.get(&turn_id).map(|t| t.kind)
    };
    tell(app, id, tab_id, PageEvent::TurnStart { turn_id, kind });
}

fn on_session(e: Ev, sid: &str) {
    let Ev {
        app, id, tab_id, ..
    } = e;
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

fn on_initialized(e: Ev, models: Vec<ModelChoice>) {
    let Ev { app, .. } = e;
    if !models.is_empty() {
        with(app, |st| st.model_choices = json!(models));
    }
}

fn on_tools(e: Ev, t: Tools) {
    let Ev { app, session, .. } = e;
    // learn Claude Code's default tools once (per version), so later sessions can add the task tools to them
    if !t.chosen {
        let tools: Vec<String> = t
            .tools
            .into_iter()
            .filter(|t| !t.starts_with("mcp__"))
            .collect();
        with(app, |st| {
            st.store.update_settings(patch(vec![(
                "toolset",
                json!({ "version": t.version, "tools": tools }),
            )]))
        });
        // this conversation started without the task tools: pick them up from its next question
        session.set_tools(tools);
    } else {
        with(app, |st| {
            let cached = &st.store.settings()["toolset"];
            if cached.is_object() && cached["version"] != t.version.as_str() {
                st.store
                    .update_settings(patch(vec![("toolset", Value::Null)]));
            }
        });
    }
}

fn on_commands(e: Ev, commands: Vec<SlashCommand>) {
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
        let merged: Vec<Value> = commands
            .iter()
            .take(200)
            .map(|c| {
                let desc = Some(c.description.as_str())
                    .filter(|d| !d.is_empty())
                    .map(|d| json!(d))
                    .or_else(|| known.get(&c.name).cloned())
                    .unwrap_or(json!(""));
                json!({ "name": c.name, "description": desc })
            })
            .collect();
        st.store
            .update(id, patch(vec![("claudeCommands", Value::Array(merged))]));
    });
}

fn on_text(e: Ev, delta: &str) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mut b = e.book();
    b.text_len += delta.encode_utf16().count();
    b.thinking = None; // (done thinking: it's talking)
    drop(b);
    tell(
        app,
        id,
        tab_id,
        PageEvent::Text {
            delta: delta.into(),
        },
    );
}

/// Its thinking: a step of its own in the answer (where it came), its words streamed into it
fn on_thinking(e: Ev) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    tell(app, id, tab_id, PageEvent::Thinking);
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
        PageEvent::Tool(Tool {
            id: step,
            name: "Thinking".into(),
            detail: String::new(),
            args: Value::Null,
            input: None,
        }),
    );
}

fn on_thinking_text(e: Ev, delta: &str) {
    let Ev {
        app, id, tab_id, ..
    } = e;
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
        PageEvent::ThinkingText {
            id: step,
            delta: delta.into(),
        },
    );
}

/// It went into plan mode by itself (or out of it): the tab keeps the mode it's in
fn on_mode(e: Ev, mode: &str) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    with(app, |st| {
        st.store
            .update_tab(id, tab_id, patch(vec![("permissionMode", json!(mode))]))
    });
    tell(app, id, tab_id, PageEvent::Mode { mode: mode.into() });
}

fn on_tool(e: Ev, t: Tool) {
    let Ev {
        app,
        id,
        tab_id,
        book,
        ..
    } = e;
    e.book().thinking = None; // (done thinking: it's doing)
    // what it was called with (click the step in the chat to see it), and a smaller copy kept with the answer
    let shown = Tool {
        args: clip(&t.args, &LIVE, 0),
        input: None,
        ..t.clone()
    };
    tell(app, id, tab_id, PageEvent::Tool(shown));
    let mut b = e.book();
    b.now.saw(&t.name, &t.detail, &t.args);
    if b.calls.len() < KEEP_CALLS {
        let at = b.text_len;
        b.calls.push(json!({ "id": t.id, "name": t.name, "detail": t.detail, "args": clip(&t.args, &KEEP, 0), "at": at }));
    }
    let Some(input) = t.input else {
        return;
    };
    // an MCP tool: if it comes with its own view (an MCP App), show it in the chat
    let call_id = t.id.clone();
    b.mcp_calls
        .insert(call_id.clone(), json!({ "name": t.name, "input": input }));
    drop(b);
    let (app, id, tab_id, book) = (
        app.clone(),
        id.to_string(),
        tab_id.to_string(),
        book.clone(),
    );
    let tool = t.name;
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
            let mut p = json!({ "id": call_id, "input": call["input"], "result": call["result"] });
            for (k, v) in view.as_object().into_iter().flatten() {
                p[k] = v.clone();
            }
            p
        };
        tell(&app, &id, &tab_id, PageEvent::App(shown));
    });
}

/// What a tool gave back: to the chat (its step shows it), and trimmed with the answer
/// What a tool gave back: to the chat (its step shows it), and trimmed with the answer
fn on_tool_output(e: Ev, o: ToolOutput) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let (live, _) = step_media(&o.media, LIVE_MEDIA);
    tell(
        app,
        id,
        tab_id,
        PageEvent::ToolOutput(ToolOutput {
            id: o.id.clone(),
            text: cut(&o.text, LIVE.output),
            media: live,
            is_error: o.is_error,
        }),
    );
    let mut b = e.book();
    let left = b.media_left;
    let Some(call) = b.calls.iter_mut().find(|c| c["id"] == o.id.as_str()) else {
        return;
    };
    call["output"] = json!(cut(&o.text, KEEP.output));
    if o.is_error {
        call["isError"] = json!(true);
    }
    let (kept, rest) = step_media(&o.media, left);
    if kept.as_array().is_some_and(|k| !k.is_empty()) {
        call["media"] = kept;
    }
    b.media_left = rest;
}

fn on_tool_result(e: Ev, r: ToolResult) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let mut b = e.book();
    let call_id = r.id;
    let Some(call) = b.mcp_calls.get_mut(&call_id) else {
        return;
    };
    call["result"] = r.result.clone();
    if call.get("view").is_some() {
        tell(
            app,
            id,
            tab_id,
            PageEvent::AppResult {
                id: call_id.clone(),
                result: r.result.clone(),
            },
        );
    }
    // pictures the tool returned (a screenshot, a rendered chart): shown in the answer
    let pics: Vec<Value> = r.result["content"]
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
        PageEvent::ToolImages {
            id: call_id,
            images: pics,
        },
    );
}

/// Files it changed: shown as diffs now, and kept (trimmed) with the answer in history
fn on_edit(e: Ev, d: Diff) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    tell(app, id, tab_id, PageEvent::Edit(d.clone()));
    let mut b = e.book();
    if b.edits.len() < 20 {
        let kept = Diff {
            truncated: d.truncated || count_lines(&d.hunks) > 120,
            hunks: trim_hunks(&d.hunks, 120),
            ..d
        };
        b.edits.push(json!(kept));
    }
}

fn on_agent(e: Ev, ev: AgentEvent) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let ev = match ev {
        // a background helper's full report sits in a file; short ones are already in the summary
        AgentEvent::Done {
            id,
            status,
            summary,
            output_file,
            usage,
            ..
        } => {
            let report = output_file
                .filter(|f| !f.is_empty())
                .and_then(|f| std::fs::read_to_string(f).ok())
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty() && r.len() > summary.len())
                .map(|r| {
                    let chars: Vec<char> = r.chars().collect();
                    chars[chars.len().saturating_sub(20000)..].iter().collect()
                });
            AgentEvent::Done {
                id,
                status,
                summary,
                output_file: None,
                report,
                usage,
            }
        }
        ev => ev,
    };
    tell(app, id, tab_id, PageEvent::Agent(ev));
}

fn on_task(e: Ev, change: TaskChange) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let tasks = with(app, |st| {
        let t = st.store.tab(id, tab_id)?;
        let mut tasks: Vec<Value> = t["tasks"].as_array().cloned().unwrap_or_default();
        match &change {
            TaskChange::Replace { tasks: list } => tasks = list.iter().map(|x| json!(x)).collect(),
            TaskChange::Create {
                id: task,
                subject,
                active_form,
                ..
            } => {
                tasks.retain(|x| x["id"] != task.as_str());
                tasks.push(json!({ "id": task, "subject": subject, "activeForm": active_form, "status": "pending" }));
            }
            TaskChange::Update {
                id: task,
                status,
                subject,
                active_form,
            } => {
                for x in tasks.iter_mut().filter(|x| x["id"] == task.as_str()) {
                    let said = [
                        ("status", status),
                        ("subject", subject),
                        ("activeForm", active_form),
                    ];
                    for (k, v) in said {
                        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                            x[k] = json!(v);
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
        tell(app, id, tab_id, PageEvent::Tasks { tasks, change });
    }
}

fn on_compact(e: Ev, c: Compact) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    e.book().last_compact = Some(c.clone());
    tell(app, id, tab_id, PageEvent::Compact(c));
}

fn on_done(e: Ev, d: Done) {
    let Ev {
        app, id, tab_id, ..
    } = e;
    let turn_id = d.turn_id.clone();
    let (kind, last_compact, (edits, apps, images, tools)) = {
        let mut b = e.book();
        let kind = b.turns.remove(&turn_id).map(|t| t.kind);
        (kind, b.last_compact.clone(), b.take())
    };
    let kept = with(app, |st| {
        let c = st.store.get(id)?.clone();
        if kind == Some(AskKind::Compact) {
            let (pre, post) = last_compact.map_or((None, None), |c| (c.pre, c.post));
            let text = match (pre, post) {
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
                    ("text", json!(d.text)),
                    ("asides", json!(d.asides)),
                    ("isError", json!(d.is_error)),
                    ("denials", json!(d.denials)),
                    ("interrupted", json!(d.interrupted)),
                    ("edits", edits),
                    ("apps", apps),
                    ("images", images),
                    ("tools", tools),
                    ("uuid", json!(d.uuid)), // (where an edited question after it rewinds to)
                ]),
            );
        }
        if let Some(sid) = &d.session_id {
            st.store
                .update_tab(id, tab_id, patch(vec![("sessionId", json!(sid))]));
        }
        let mut stats = c["stats"].as_object().cloned().unwrap_or_default();
        let cost = stats.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0) + d.cost_usd;
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
    tell(app, id, tab_id, PageEvent::Done { done: d, at, kind });
    refresh_context(app, id, tab_id);
}

fn on_fail(e: Ev, f: Fail) {
    let Ev {
        app,
        id,
        tab_id,
        session,
        ..
    } = e;
    let turn_id = f.turn_id.clone();
    let retry = {
        let mut b = e.book();
        match b.turns.get_mut(&turn_id) {
            Some(t) if f.session_missing && session.session_id().is_some() && !t.retried => {
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
    if !f.cancelled {
        with(app, |st| {
            st.store.push_history(
                id,
                tab_id,
                entry(vec![
                    ("role", json!("assistant")),
                    ("text", json!(f.message)),
                    ("isError", json!(true)),
                    ("edits", edits),
                    ("apps", apps),
                    ("images", images),
                    ("tools", tools),
                ]),
            )
        });
    }
    tell(app, id, tab_id, PageEvent::Fail(f));
}
