//! What Claude Code writes, line by line (stream-json): each kind of message read by a
//! function of its own, and what it means passed on (stream.rs emits it).

use std::sync::MutexGuard;

use super::*;

impl Session {
    pub(super) fn line(&self, line: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let mut i = self.lock();
        if s(&msg, "type") == "control_response" {
            return control_response(i, &msg["response"]);
        }
        // A helper agent's own steps and words: shown in its card, not voiced by the robot.
        if !s(&msg, "parent_tool_use_id").is_empty() {
            return i.agent_chatter(&msg);
        }
        let ty = match s(&msg, "type") {
            "" if msg.get("total_cost_usd").is_some() => "result",
            t => t,
        };
        // Claude Code carries on by itself when a background helper finishes: a turn nobody asked for
        if i.turn.is_none() && (ty == "assistant" || ty == "stream_event") {
            i.begin_auto_turn();
        }
        // (only once there's a conversation to go back to: Remote Control says its session id
        // before any message, and resuming that would find nothing)
        let sid = s(&msg, "session_id");
        if !sid.is_empty() && i.session_id.as_deref() != Some(sid) && i.turn.is_some() {
            i.session_id = Some(sid.to_string());
            i.opts.fork = false; // (branched: from now on it carries on its own conversation)
            i.emit(Event::Session(sid.to_string()));
        }
        match ty {
            "command_lifecycle" if s(&msg, "state") == "started" => i.command_started(&msg, sid),
            "control_request" => i.control_request(&msg),
            "control_cancel_request" => i.request_cancelled(&msg),
            "stream_event" => i.stream_event(&msg),
            "assistant" => i.assistant(&msg),
            "user" => i.tool_results(&msg),
            "system" => i.system(&msg),
            "result" => self.turn_done(i, &msg, sid),
            _ => {}
        }
    }

    /// The answer's end: the turn's done (its words, cost, what was denied), and the next
    /// question goes.
    fn turn_done(&self, mut i: MutexGuard<'_, Inner>, msg: &Value, sid: &str) {
        let Some(turn) = i.turn.take() else { return };
        let rest = i.asides.flush();
        // (put the turn back for a moment: the last of its text still counts)
        i.turn = Some(turn);
        i.emit_text(&rest);
        let turn = i.turn.take().unwrap();
        let total = msg["total_cost_usd"].as_f64().unwrap_or(0.0);
        let cost = (total - i.cost_so_far).max(0.0);
        i.cost_so_far = total;
        let interrupted = turn.interrupted || s(msg, "terminal_reason").starts_with("abort");
        let text = match i.text.trim() {
            "" => strip_asides(s(msg, "result")).trim().to_string(),
            t => t.to_string(),
        };
        i.last_used = Instant::now();
        let denials: Vec<Value> = msg["permission_denials"]
            .as_array()
            .map(|d| d.iter().map(|x| x["tool_name"].clone()).collect())
            .unwrap_or_default();
        let session_id = if sid.is_empty() {
            json!(i.session_id)
        } else {
            json!(sid)
        };
        i.emit(Event::Done(json!({
            "turnId": turn.id, "text": text, "asides": i.asides.asides, "isError": msg["is_error"].as_bool().unwrap_or(false) && !interrupted,
            "interrupted": interrupted, "costUsd": cost, "denials": denials, "sessionId": session_id, "uuid": i.last_uuid,
            "outputTokens": msg["usage"]["output_tokens"], "ms": msg["duration_ms"],
        })));
        // ours, waiting behind a message from Remote Control, is next
        if let Some(t) = i.displaced.take() {
            i.begin_turn(t.id, Some(t.uuid));
            if let Some(cur) = i.turn.as_mut() {
                cur.started = t.started;
            }
        } else {
            self.next(&mut i);
        }
    }
}

/// The answer to a control request we sent (interrupt, model, effort…): to whoever waits on it.
fn control_response(mut i: MutexGuard<'_, Inner>, r: &Value) {
    let Some(reply) = i.controls.remove(s(r, "request_id")) else {
        return;
    };
    drop(i);
    if s(r, "subtype") == "success" {
        reply(Ok(r.get("response").cloned().unwrap_or(json!({}))));
    } else {
        reply(Err(if s(r, "error").is_empty() {
            "control request failed".into()
        } else {
            s(r, "error").into()
        }));
    }
}

impl Inner {
    /// A message starts being answered: ours, or one typed on claude.ai/code or in the Claude app.
    fn command_started(&mut self, msg: &Value, sid: &str) {
        let uuid = s(msg, "command_uuid").to_string();
        if self.own_uuids.remove(&uuid) {
            if let Some(t) = self.turn.as_mut().filter(|t| t.uuid == uuid) {
                t.started = true;
            }
        } else if self.opts.remote.is_some() && !uuid.is_empty() {
            // ours was sent but waits behind it: it comes back when this one is done
            if self.turn.as_ref().is_some_and(|t| !t.started) {
                self.displaced = self.turn.take();
            }
            self.emit(Event::RemotePrompt(
                json!({ "uuid": uuid, "sessionId": sid }),
            ));
            if self.turn.is_none() {
                self.begin_auto_turn();
            }
        }
    }

    /// A question it asked is no longer wanted (the answer was stopped).
    fn request_cancelled(&mut self, msg: &Value) {
        let id = s(msg, "request_id").to_string();
        if self.pending_questions.remove(&id).is_some() || self.pending_plans.remove(&id).is_some()
        {
            self.emit(Event::RequestCancelled(json!({ "requestId": id })));
        }
    }

    /// The answer as it's written: its words and thinking streamed, and how much it has written.
    fn stream_event(&mut self, msg: &Value) {
        let ev = &msg["event"];
        match s(ev, "type") {
            // how much it has written: the output tokens of each message as it goes
            "message_start" => self.tokens_msg = 0,
            "message_delta" => {
                if let Some(n) = ev["usage"]["output_tokens"].as_u64() {
                    self.tokens_msg = n;
                    let total = self.tokens_done + n;
                    self.emit(Event::Usage(total));
                }
            }
            "message_stop" => {
                self.tokens_done += self.tokens_msg;
                self.tokens_msg = 0;
            }
            "content_block_delta" if s(&ev["delta"], "type") == "thinking_delta" => {
                let t = s(&ev["delta"], "thinking");
                if !t.is_empty() {
                    self.emit(Event::ThinkingText(t.to_string()));
                }
            }
            "content_block_start" => {
                let block = &ev["content_block"];
                if s(block, "type") == "text" {
                    self.separate();
                }
                if s(block, "type") == "thinking" {
                    self.emit(Event::Thinking);
                }
            }
            "content_block_delta" if s(&ev["delta"], "type") == "text_delta" => {
                let mid = s(msg, "api_message_id");
                if !mid.is_empty() {
                    self.streamed.insert(mid.to_string());
                }
                let text = s(&ev["delta"], "text").to_string();
                self.append_text(&text);
            }
            _ => {}
        }
    }

    /// One of its messages whole: the tools it calls, and its words if they weren't streamed.
    fn assistant(&mut self, msg: &Value) {
        if let Some(uuid) = msg["uuid"].as_str() {
            self.last_uuid = Some(uuid.to_string());
        }
        let m = &msg["message"];
        for block in m["content"].as_array().into_iter().flatten() {
            match s(block, "type") {
                "tool_use" => self.tool_use(block),
                // the answer's text when partial messages weren't streamed
                "text" if !self.streamed.contains(s(m, "id")) => {
                    self.separate();
                    self.append_text(s(block, "text"));
                }
                _ => {}
            }
        }
    }

    fn tool_use(&mut self, block: &Value) {
        self.task_tool(block);
        self.agent_start(block, None);
        // MCP tools also pass their input on: some come with a view that draws from it
        let name = s(block, "name");
        let id = s(block, "id");
        let args = block.get("input").cloned().unwrap_or(json!({}));
        let mut ev =
            json!({ "name": name, "detail": describe_tool(name, &args), "id": id, "args": args });
        if name.starts_with("mcp__") {
            self.mcp_tool_ids.insert(id.to_string());
            ev["input"] = ev["args"].clone();
        }
        self.emit(Event::Tool(ev));
    }

    /// What its tools gave back (sent to it as the user's message).
    fn tool_results(&mut self, msg: &Value) {
        let blocks = msg["message"]["content"].as_array().into_iter().flatten();
        for block in blocks.filter(|b| s(b, "type") == "tool_result") {
            self.tool_result(block, &msg["tool_use_result"]);
        }
    }

    fn tool_result(&mut self, block: &Value, use_result: &Value) {
        self.task_result(block);
        let id = s(block, "tool_use_id").to_string();
        let is_error = block["is_error"].as_bool().unwrap_or(false);
        // what the tool gave back, as Claude read it (the chat shows it when you click the step)
        self.emit(Event::ToolOutput(json!({ "id": id, "text": output_text(&block["content"]), "media": output_media(&block["content"]), "isError": is_error })));
        // a file it changed: show the diff, like Claude Code's terminal
        if !is_error && let Some(mut diff) = edit_diff(use_result) {
            diff["id"] = json!(id);
            self.emit(Event::Edit(diff));
        }
        // an MCP tool's result, as the MCP server gave it (for its view)
        if self.mcp_tool_ids.remove(&id) {
            let content = match &block["content"] {
                Value::String(t) => json!([{ "type": "text", "text": t }]),
                Value::Null => json!([]),
                other => other.clone(),
            };
            let mut result = json!({ "content": content, "isError": is_error });
            let structured = &use_result["structuredContent"];
            if !structured.is_null() {
                result["structuredContent"] = structured.clone();
            }
            self.emit(Event::ToolResult(json!({ "id": id, "result": result })));
        }
        // a helper that ran in the foreground is done when its tool call returns
        if self.agent_tools.contains(&id) && !use_result["isAsync"].as_bool().unwrap_or(false) {
            self.agent_running.remove(&id);
            let status = if is_error { "failed" } else { "completed" };
            self.emit(Event::Agent(json!({ "op": "done", "id": id, "status": status, "summary": result_text(&block["content"]) })));
        }
    }

    /// What Claude Code says about itself: its tools and commands, its mode, helpers, compacting.
    fn system(&mut self, msg: &Value) {
        let sub = s(msg, "subtype");
        if sub.starts_with("task_") {
            self.agent_task(msg);
        }
        if sub == "bridge_state" && self.opts.remote.is_some() {
            self.emit(Event::RemoteState(msg["state"].clone()));
        }
        // its permission mode changed by itself (it went into plan mode, a plan was approved)
        if sub == "status"
            && let Some(mode) = msg["permissionMode"]
                .as_str()
                .filter(|m| *m != self.opts.permission_mode)
        {
            self.opts.permission_mode = mode.to_string();
            self.emit(Event::Mode(mode.to_string()));
        }
        if sub == "task_summary" && !s(msg, "detail").is_empty() {
            self.emit(Event::Status(msg["detail"].clone()));
        } else if sub == "init" {
            // the slash commands Claude Code offers in this folder (skills, custom commands)
            if let Some(cmds) = msg["slash_commands"].as_array() {
                self.emit(Event::Commands(Value::Array(
                    cmds.iter().map(|n| json!({ "name": n })).collect(),
                )));
            }
            if msg["tools"].is_array() {
                let chosen = self.opts.tools.is_some();
                self.emit(Event::Tools(json!({ "version": msg["claude_code_version"], "tools": msg["tools"], "chosen": chosen })));
            }
        } else if sub == "commands_changed" {
            if let Some(cmds) = msg["commands"].as_array() {
                self.emit(Event::Commands(Value::Array(
                    cmds.iter()
                        .map(|c| json!({ "name": c["name"], "description": s(c, "description") }))
                        .collect(),
                )));
            }
        } else if sub == "status" && s(msg, "status") == "compacting" {
            self.emit(Event::Compact(json!({ "phase": "start" })));
        } else if sub == "compact_boundary" {
            let meta = &msg["compact_metadata"];
            self.emit(Event::Compact(
                json!({ "phase": "done", "pre": meta["pre_tokens"], "post": meta["post_tokens"] }),
            ));
        }
    }
}
