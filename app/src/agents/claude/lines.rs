//! What Claude Code writes, line by line (stream-json, read into protocol.rs's types): each
//! kind of message read by a function of its own, and what it means passed on (stream.rs
//! emits it).

use std::sync::MutexGuard;

use super::protocol::{
    self, Block, ControlResponse, Delta, Finished, Kind, Line, Message, StreamEvent, System,
};
use super::*;

impl Session {
    pub(super) fn line(&self, line: &str) {
        let Some(Line {
            session_id: sid,
            parent_tool_use_id: parent,
            kind,
        }) = protocol::parse(line)
        else {
            return;
        };
        let mut i = self.lock();
        let kind = match kind {
            Kind::ControlResponse { response } => return control_response(i, response),
            kind => kind,
        };
        // A helper agent's own steps and words: shown in its card, not voiced by the robot.
        if !parent.is_empty() {
            if let Kind::Assistant { message, .. } = kind {
                i.agent_chatter(&parent, message.content);
            }
            return;
        }
        // Claude Code carries on by itself when a background helper finishes: a turn nobody asked for
        if i.turn.is_none() && matches!(kind, Kind::Assistant { .. } | Kind::StreamEvent { .. }) {
            i.begin_auto_turn();
        }
        // (only once there's a conversation to go back to: Remote Control says its session id
        // before any message, and resuming that would find nothing)
        if !sid.is_empty() && i.session_id.as_deref() != Some(sid.as_str()) && i.turn.is_some() {
            i.session_id = Some(sid.clone());
            i.opts.fork = false; // (branched: from now on it carries on its own conversation)
            i.emit(Event::Session(sid.clone()));
        }
        match kind {
            Kind::CommandLifecycle {
                state,
                command_uuid,
            } if state == "started" => i.command_started(command_uuid, &sid),
            Kind::ControlRequest {
                request_id,
                request,
            } => i.control_request(request_id, request),
            Kind::ControlCancelRequest { request_id } => i.request_cancelled(request_id),
            Kind::StreamEvent {
                event,
                api_message_id,
            } => i.stream_event(event, api_message_id),
            Kind::Assistant { uuid, message } => i.assistant(uuid, message),
            Kind::User {
                message,
                tool_use_result,
            } => i.tool_results(message.content, &tool_use_result),
            Kind::System(system) => i.system(system),
            Kind::Result(finished) => self.turn_done(i, finished, &sid),
            Kind::CommandLifecycle { .. } | Kind::ControlResponse { .. } | Kind::Other => {}
        }
    }

    /// The answer's end: the turn's done (its words, cost, what was denied), and the next
    /// question goes.
    fn turn_done(&self, mut i: MutexGuard<'_, Inner>, f: Finished, sid: &str) {
        if i.turn.is_none() {
            return;
        }
        let rest = i.asides.flush();
        i.emit_text(&rest); // (while the turn is still on: the last of its text counts)
        let Some(turn) = i.turn.take() else { return };
        let total = f.total_cost_usd.unwrap_or(0.0);
        let cost = (total - i.cost_so_far).max(0.0);
        i.cost_so_far = total;
        let interrupted = turn.interrupted || f.terminal_reason.starts_with("abort");
        let text = match i.text.trim() {
            "" => strip_asides(&f.result).trim().to_string(),
            t => t.to_string(),
        };
        i.last_used = Instant::now();
        let denials = f
            .permission_denials
            .iter()
            .filter_map(|d| d.tool_name.as_str().map(str::to_string))
            .collect();
        let session_id = if sid.is_empty() {
            i.session_id.clone()
        } else {
            Some(sid.to_string())
        };
        let done = Done {
            turn_id: turn.id,
            text,
            asides: i.asides.asides.clone(),
            is_error: f.is_error && !interrupted,
            interrupted,
            cost_usd: cost,
            denials,
            session_id,
            uuid: i.last_uuid.clone(),
            tokens: f.usage.tokens(),
            ms: f.duration_ms,
        };
        i.emit(Event::Done(done));
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
fn control_response(mut i: MutexGuard<'_, Inner>, r: ControlResponse) {
    let Some(reply) = i.controls.remove(&r.request_id) else {
        return;
    };
    drop(i);
    if r.subtype == "success" {
        reply(Ok(r.response.unwrap_or(json!({}))));
    } else {
        reply(Err(if r.error.is_empty() {
            "control request failed".into()
        } else {
            r.error.into()
        }));
    }
}

impl Inner {
    /// A message starts being answered: ours, or one typed on claude.ai/code or in the Claude app.
    fn command_started(&mut self, uuid: String, sid: &str) {
        if self.own_uuids.remove(&uuid) {
            if let Some(t) = self.turn.as_mut().filter(|t| t.uuid == uuid) {
                t.started = true;
            }
        } else if self.opts.remote.is_some() && !uuid.is_empty() {
            // ours was sent but waits behind it: it comes back when this one is done
            if self.turn.as_ref().is_some_and(|t| !t.started) {
                self.displaced = self.turn.take();
            }
            self.emit(Event::RemotePrompt(RemotePrompt {
                uuid,
                session_id: sid.to_string(),
            }));
            if self.turn.is_none() {
                self.begin_auto_turn();
            }
        }
    }

    /// A question it asked is no longer wanted (the answer was stopped).
    fn request_cancelled(&mut self, id: String) {
        if self.pending_questions.remove(&id).is_some() || self.pending_plans.remove(&id).is_some()
        {
            self.emit(Event::RequestCancelled(id));
        }
    }

    /// The answer as it's written: its words and thinking streamed, and how much it has written.
    fn stream_event(&mut self, event: StreamEvent, api_message_id: String) {
        match event {
            // how much it has written: the output tokens of each message as it goes
            StreamEvent::MessageStart {} => self.tokens_msg = 0,
            StreamEvent::MessageDelta { usage } => {
                if let Some(n) = usage.output_tokens {
                    self.tokens_msg = n;
                    let total = self.tokens_done + n;
                    self.emit(Event::Usage(total));
                }
            }
            StreamEvent::MessageStop {} => {
                self.tokens_done += self.tokens_msg;
                self.tokens_msg = 0;
            }
            StreamEvent::ContentBlockStart { content_block } => {
                if content_block.kind == "text" {
                    self.separate();
                }
                if content_block.kind == "thinking" {
                    self.emit(Event::Thinking);
                }
            }
            StreamEvent::ContentBlockDelta { delta } => match delta {
                Delta::Thinking { thinking } if !thinking.is_empty() => {
                    self.emit(Event::ThinkingText(thinking));
                }
                Delta::Text { text } => {
                    if !api_message_id.is_empty() {
                        self.streamed.insert(api_message_id);
                    }
                    self.append_text(&text);
                }
                _ => {}
            },
            StreamEvent::Other => {}
        }
    }

    /// One of its messages whole: the tools it calls, and its words if they weren't streamed.
    fn assistant(&mut self, uuid: String, message: Message) {
        if !uuid.is_empty() {
            self.last_uuid = Some(uuid);
        }
        let Message { id, content } = message;
        for block in content {
            match block {
                Block::ToolUse { id, name, input } => self.tool_use(&id, &name, input),
                // the answer's text when partial messages weren't streamed
                Block::Text { text } if !self.streamed.contains(&id) => {
                    self.separate();
                    self.append_text(&text);
                }
                _ => {}
            }
        }
    }

    fn tool_use(&mut self, id: &str, name: &str, input: Value) {
        let args = if input.is_null() { json!({}) } else { input };
        self.task_tool(id, name, &args);
        self.agent_start(id, name, &args, None);
        // MCP tools also pass their input on: some come with a view that draws from it
        let mcp = name.starts_with("mcp__");
        if mcp {
            self.mcp_tool_ids.insert(id.to_string());
        }
        self.emit(Event::Tool(Tool {
            id: id.to_string(),
            name: name.to_string(),
            detail: describe_tool(name, &args),
            input: mcp.then(|| args.clone()),
            args,
        }));
    }

    /// What its tools gave back (sent to it as the user's message).
    fn tool_results(&mut self, content: Vec<Block>, use_result: &Value) {
        for block in content {
            if let Block::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            {
                self.tool_result(tool_use_id, &content, is_error, use_result);
            }
        }
    }

    fn tool_result(&mut self, id: String, content: &Value, is_error: bool, use_result: &Value) {
        self.task_result(&id, content);
        // what the tool gave back, as Claude read it (the chat shows it when you click the step)
        self.emit(Event::ToolOutput(ToolOutput {
            id: id.clone(),
            text: output_text(content),
            media: output_media(content),
            is_error,
        }));
        // a file it changed: show the diff, like Claude Code's terminal
        if !is_error && let Some(mut diff) = edit_diff(use_result) {
            diff.id = id.clone();
            self.emit(Event::Edit(diff));
        }
        // an MCP tool's result, as the MCP server gave it (for its view)
        if self.mcp_tool_ids.remove(&id) {
            let content = match content {
                Value::String(t) => json!([{ "type": "text", "text": t }]),
                Value::Null => json!([]),
                other => other.clone(),
            };
            let mut result = json!({ "content": content, "isError": is_error });
            let structured = &use_result["structuredContent"];
            if !structured.is_null() {
                result["structuredContent"] = structured.clone();
            }
            self.emit(Event::ToolResult(ToolResult {
                id: id.clone(),
                result,
            }));
        }
        // a helper that ran in the foreground is done when its tool call returns
        if self.agent_tools.contains(&id) && !use_result["isAsync"].as_bool().unwrap_or(false) {
            self.agent_running.remove(&id);
            let status = if is_error { "failed" } else { "completed" };
            self.emit(Event::Agent(AgentEvent::Done {
                id,
                status: status.into(),
                summary: result_text(content),
                output_file: None,
                report: None,
                usage: HelperUsage::default(),
            }));
        }
    }

    /// What Claude Code says about itself: its tools and commands, its mode, helpers, compacting.
    fn system(&mut self, system: System) {
        match system {
            System::Init {
                tools,
                slash_commands,
                claude_code_version,
            } => self.system_init(&tools, &slash_commands, &claude_code_version),
            System::Status {
                permission_mode,
                status,
            } => {
                // its permission mode changed by itself (it went into plan mode, a plan was approved)
                if let Some(mode) = permission_mode.filter(|m| *m != self.opts.permission_mode) {
                    self.opts.permission_mode = mode.clone();
                    self.emit(Event::Mode(mode));
                }
                if status == "compacting" {
                    self.emit(Event::Compact(Compact {
                        phase: CompactPhase::Start,
                        pre: None,
                        post: None,
                    }));
                }
            }
            System::BridgeState { state } => {
                if self.opts.remote.is_some() {
                    self.emit(Event::RemoteState(state));
                }
            }
            System::CommandsChanged { commands } => {
                if let Some(cmds) = commands.as_array() {
                    self.emit(Event::Commands(
                        cmds.iter()
                            .map(|c| SlashCommand {
                                name: s(c, "name").to_string(),
                                description: s(c, "description").to_string(),
                            })
                            .collect(),
                    ));
                }
            }
            System::CompactBoundary { compact_metadata } => {
                let meta = compact_metadata;
                self.emit(Event::Compact(Compact {
                    phase: CompactPhase::Done,
                    pre: meta["pre_tokens"].as_f64(),
                    post: meta["post_tokens"].as_f64(),
                }));
            }
            System::TaskStarted(t) => self.helper_started(*t),
            System::TaskProgress(t) => self.helper_progress(*t),
            System::TaskUpdated(t) => self.helper_updated(*t),
            System::TaskNotification(t) => self.helper_done(*t),
            System::TaskSummary(t) => {
                self.helper_of(&t);
                if let Some(detail) = t.detail.as_str().filter(|d| !d.is_empty()) {
                    self.emit(Event::Status(detail.to_string()));
                }
            }
            System::Other => {}
        }
    }

    /// Its start: the slash commands it offers in this folder (skills, custom commands) and
    /// its tools.
    fn system_init(&mut self, tools: &Value, slash_commands: &Value, version: &Value) {
        if let Some(cmds) = slash_commands.as_array() {
            self.emit(Event::Commands(
                cmds.iter()
                    .filter_map(Value::as_str)
                    .map(|n| SlashCommand {
                        name: n.to_string(),
                        description: String::new(),
                    })
                    .collect(),
            ));
        }
        if tools.is_array() {
            let chosen = self.opts.tools.is_some();
            self.emit(Event::Tools(Tools {
                version: version.as_str().unwrap_or("").to_string(),
                tools: tools
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                chosen,
            }));
        }
    }
}
