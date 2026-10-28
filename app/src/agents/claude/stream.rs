//! Reading a conversation's stream (impl Inner): each line Claude Code writes, turned into what
//! the robot's page hears (words, steps and what they gave back, helpers, questions, the turn's
//! end), and the permission prompts it sends over stdio answered.

use super::protocol::{Block, ControlRequest, HelperTask};
use super::*;

impl Inner {
    pub(super) fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    pub(super) fn send(&mut self, msg: &Value) {
        if let Some(stdin) = self.proc.as_mut().and_then(|p| p.stdin.as_mut()) {
            let _ = writeln!(stdin, "{msg}").and_then(|_| stdin.flush());
        }
    }

    pub(super) fn reply(&mut self, request_id: &str, response: Value) {
        self.send(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }));
    }

    pub(super) fn control(&mut self, request: Value, done: Reply) {
        if self.proc.is_none() {
            return done(Err("Claude Code is not running".into()));
        }
        let id = format!("cbot-{}", uuid::Uuid::new_v4());
        self.controls.insert(id.clone(), done);
        self.send(&json!({ "type": "control_request", "request_id": id, "request": request }));
    }

    pub(super) fn append_text(&mut self, t: &str) {
        if t.is_empty() || self.turn.is_none() {
            return;
        }
        let (text, asides) = self.asides.push(t);
        for a in asides {
            self.emit(Event::Aside(a.to_string()));
        }
        self.emit_text(&text);
    }

    pub(super) fn emit_text(&mut self, t: &str) {
        let t = if self.text.is_empty() {
            t.trim_start()
        } else {
            t
        }; // an aside at the very start leaves blank lines
        if t.is_empty() {
            return;
        }
        self.text.push_str(t);
        self.emit(Event::Text(t.to_string()));
    }

    pub(super) fn separate(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with("\n\n") {
            let gap = if self.text.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            self.append_text(gap);
        }
    }

    pub(super) fn begin_turn(&mut self, id: String, uuid: Option<String>) {
        let started = uuid.is_none();
        self.turn = Some(Turn {
            id: id.clone(),
            interrupted: false,
            uuid: uuid.unwrap_or_default(),
            started,
        });
        self.text.clear();
        self.asides = AsideFilter::default();
        self.streamed.clear();
        self.last_used = Instant::now();
        self.last_uuid = None;
        (self.tokens_done, self.tokens_msg) = (0, 0);
        self.emit(Event::TurnStart(id.to_string()));
    }

    // Claude Code carries on by itself (a background helper finished, a message came in through Remote Control)
    pub(super) fn begin_auto_turn(&mut self) {
        self.auto_turns += 1;
        let id = format!("auto-{}-{}", crate::store::now_ms(), self.auto_turns);
        self.begin_turn(id, None);
    }

    pub(super) fn fail_all(&mut self, message: &str, cancelled: bool, session_missing: bool) {
        let mut ids: Vec<String> = self
            .turn
            .take()
            .into_iter()
            .chain(self.displaced.take())
            .map(|t| t.id)
            .collect();
        ids.extend(self.queue.drain(..).map(|(id, _)| id));
        for id in ids {
            self.emit(Event::Fail(json!({ "turnId": id, "message": message, "cancelled": cancelled, "sessionMissing": session_missing })));
        }
    }

    // The to-do card follows Claude Code's to-do tools: TodoWrite (the whole list each time),
    // or the Task* ones (one task at a time) in the versions that have them.
    pub(super) fn task_tool(&mut self, id: &str, name: &str, input: &Value) {
        match name {
            "TaskCreate" => {
                self.task_inputs.insert(id.to_string(), input.clone());
            }
            "TaskUpdate" if !input["taskId"].is_null() => {
                let id = input["taskId"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| input["taskId"].to_string());
                self.emit(Event::Task(json!({ "op": "update", "id": id, "status": input["status"], "subject": input["subject"], "activeForm": input["activeForm"] })));
            }
            "TodoWrite" => {
                if let Some(todos) = input["todos"].as_array() {
                    let tasks: Vec<Value> = todos.iter().enumerate().map(|(i, t)| json!({ "id": (i + 1).to_string(), "subject": t["content"], "activeForm": t["activeForm"], "status": t["status"] })).collect();
                    self.emit(Event::Task(json!({ "op": "replace", "tasks": tasks })));
                }
            }
            _ => {}
        }
    }

    /// TaskCreate's result says the task's number: the card gets it.
    pub(super) fn task_result(&mut self, tool_use_id: &str, content: &Value) {
        let Some(input) = self.task_inputs.remove(tool_use_id) else {
            return;
        };
        let text = result_text(content);
        let id = text
            .find('#')
            .map(|i| {
                text[i + 1..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .filter(|d| !d.is_empty());
        if let Some(id) = id {
            self.emit(Event::Task(json!({ "op": "create", "id": id, "subject": input["subject"], "activeForm": input["activeForm"], "status": "pending" })));
        }
    }

    /// An Agent (or Task) tool call: a helper agent starts (parent: the helper that sent it).
    pub(super) fn agent_start(
        &mut self,
        id: &str,
        name: &str,
        input: &Value,
        parent: Option<&str>,
    ) {
        if name != "Agent" && name != "Task" {
            return;
        }
        self.agent_tools.insert(id.to_string());
        self.agent_running.insert(id.to_string());
        let description = if s(input, "description").is_empty() {
            "Helper"
        } else {
            s(input, "description")
        };
        self.emit(Event::Agent(json!({
            "op": "start", "id": id, "parent": parent, "description": description, "kind": s(input, "subagent_type"),
            "prompt": s(input, "prompt"), "background": input["run_in_background"].as_bool().unwrap_or(false),
        })));
    }

    // A helper agent's own steps and words: shown in its card, not voiced by the robot.
    pub(super) fn agent_chatter(&mut self, parent: &str, content: Vec<Block>) {
        for block in content {
            match block {
                Block::ToolUse { id, name, input } => {
                    self.agent_start(&id, &name, &input, Some(parent)); // a helper sending its own helper
                    self.emit(Event::Agent(json!({ "op": "step", "id": parent, "tool": name, "detail": describe_tool(&name, &input) })));
                }
                Block::Text { text } if !text.trim().is_empty() => {
                    self.emit(Event::Agent(
                        json!({ "op": "text", "id": parent, "text": text }),
                    ));
                }
                _ => {}
            }
        }
    }

    // Claude Code's task events for helpers: started, progress, finished

    /// The helper (its Agent tool call's id) a task event is about, if it's one we know; it
    /// keeps the conversation alive.
    pub(super) fn helper_of(&mut self, t: &HelperTask) -> Option<String> {
        let id = if !t.tool_use_id.is_empty() {
            t.tool_use_id.clone()
        } else {
            self.agent_tasks.get(&t.task_id)?.clone()
        };
        if !t.task_id.is_empty() {
            self.agent_tasks.insert(t.task_id.clone(), id.clone());
        }
        self.last_used = Instant::now(); // a helper at work keeps the conversation alive
        Some(id)
    }

    pub(super) fn helper_started(&mut self, t: HelperTask) {
        let Some(id) = self.helper_of(&t) else { return };
        self.agent_tools.insert(id.clone());
        self.agent_running.insert(id.clone());
        self.emit(Event::Agent(json!({ "op": "start", "id": id, "description": t.description, "kind": t.subagent_type, "prompt": t.prompt, "background": t.is_backgrounded })));
    }

    pub(super) fn helper_progress(&mut self, t: HelperTask) {
        let Some(id) = self.helper_of(&t) else { return };
        let activity = t.description.as_str().unwrap_or("").to_string();
        self.emit(Event::Agent(with_usage(
            &t,
            json!({ "op": "progress", "id": id, "activity": activity }),
        )));
    }

    pub(super) fn helper_updated(&mut self, t: HelperTask) {
        let Some(id) = self.helper_of(&t) else { return };
        if !t.patch["status"].is_null() {
            self.emit(Event::Agent(
                json!({ "op": "status", "id": id, "status": t.patch["status"] }),
            ));
        }
    }

    pub(super) fn helper_done(&mut self, t: HelperTask) {
        let Some(id) = self.helper_of(&t) else { return };
        self.agent_running.remove(&id);
        let status = if t.status.is_empty() {
            "completed"
        } else {
            &t.status
        };
        self.emit(Event::Agent(with_usage(&t, json!({ "op": "done", "id": id, "status": status, "summary": t.summary, "outputFile": t.output_file }))));
    }

    // Claude Code asks before using a tool its permission mode doesn't cover. Questions
    // for the user are passed on; everything else is refused, as in plain print mode.
    pub(super) fn control_request(&mut self, request_id: String, req: ControlRequest) {
        if req.subtype != "can_use_tool" {
            let error = format!("Unsupported request: {}", req.subtype);
            self.send(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } }));
            return;
        }
        if req.tool_name == "AskUserQuestion" && req.input["questions"].is_array() {
            self.emit(Event::Question(
                json!({ "requestId": request_id, "questions": req.input["questions"] }),
            ));
            self.pending_questions.insert(request_id, req.input);
            return;
        }
        // a plan, finished: it waits for your go-ahead (or your notes) before anything changes
        if req.tool_name == "ExitPlanMode" {
            self.emit(Event::Plan(json!({ "requestId": request_id, "plan": s(&req.input, "plan"), "file": s(&req.input, "planFilePath") })));
            self.pending_plans.insert(request_id, req.input);
            return;
        }
        let mode = if self.opts.permission_mode.is_empty() {
            "default"
        } else {
            &self.opts.permission_mode
        };
        let message = format!(
            "{} needs permission this robot doesn't have (mode: {mode}).",
            req.tool_name
        );
        self.reply(
            &request_id,
            json!({ "behavior": "deny", "message": message }),
        );
    }
}

/// A helper's usage so far, added to what's said about it: tokens, tool calls, time.
fn with_usage(t: &HelperTask, mut v: Value) -> Value {
    let u = &t.usage;
    if u.is_object() {
        v["tokens"] = u["total_tokens"].clone();
        v["tools"] = u["tool_uses"].clone();
        v["ms"] = u["duration_ms"].clone();
    }
    v
}
