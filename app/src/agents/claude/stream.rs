//! Reading a conversation's stream (impl Inner): each line Claude Code writes, turned into what
//! the robot's page hears (words, steps and what they gave back, helpers, questions, the turn's
//! end), and the permission prompts it sends over stdio answered.

use super::*;

impl Inner {
    pub(super) fn emit(&self, event: &str, data: Value) {
        let _ = self.events.send((event.to_string(), data));
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
            self.emit("aside", json!(a));
        }
        self.emit_text(&text);
    }

    pub(super) fn emit_text(&mut self, t: &str) {
        let t = if self.text.is_empty() { t.trim_start() } else { t }; // an aside at the very start leaves blank lines
        if t.is_empty() {
            return;
        }
        self.text.push_str(t);
        self.emit("text", json!(t));
    }

    pub(super) fn separate(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with("\n\n") {
            let gap = if self.text.ends_with('\n') { "\n" } else { "\n\n" };
            self.append_text(gap);
        }
    }

    pub(super) fn begin_turn(&mut self, id: String, uuid: Option<String>) {
        let started = uuid.is_none();
        self.turn = Some(Turn { id: id.clone(), interrupted: false, uuid: uuid.unwrap_or_default(), started });
        self.text.clear();
        self.asides = AsideFilter::default();
        self.streamed.clear();
        self.last_used = Instant::now();
        self.last_uuid = None;
        (self.tokens_done, self.tokens_msg) = (0, 0);
        self.emit("turn-start", json!(id));
    }

    // Claude Code carries on by itself (a background helper finished, a message came in through Remote Control)
    pub(super) fn begin_auto_turn(&mut self) {
        self.auto_turns += 1;
        let id = format!("auto-{}-{}", crate::store::now_ms(), self.auto_turns);
        self.begin_turn(id, None);
    }

    pub(super) fn fail_all(&mut self, message: &str, cancelled: bool, session_missing: bool) {
        let mut ids: Vec<String> = self.turn.take().into_iter().chain(self.displaced.take()).map(|t| t.id).collect();
        ids.extend(self.queue.drain(..).map(|(id, _)| id));
        for id in ids {
            self.emit("fail", json!({ "turnId": id, "message": message, "cancelled": cancelled, "sessionMissing": session_missing }));
        }
    }

    // The to-do card follows Claude Code's task tools (and the older TodoWrite).
    pub(super) fn task_tool(&mut self, block: &Value) {
        let input = block.get("input").cloned().unwrap_or(json!({}));
        match s(block, "name") {
            "TaskCreate" => {
                self.task_inputs.insert(s(block, "id").to_string(), input);
            }
            "TaskUpdate" if !input["taskId"].is_null() => {
                let id = input["taskId"].as_str().map(str::to_string).unwrap_or_else(|| input["taskId"].to_string());
                self.emit("task", json!({ "op": "update", "id": id, "status": input["status"], "subject": input["subject"], "activeForm": input["activeForm"] }));
            }
            "TodoWrite" => {
                if let Some(todos) = input["todos"].as_array() {
                    let tasks: Vec<Value> = todos.iter().enumerate().map(|(i, t)| json!({ "id": (i + 1).to_string(), "subject": t["content"], "activeForm": t["activeForm"], "status": t["status"] })).collect();
                    self.emit("task", json!({ "op": "replace", "tasks": tasks }));
                }
            }
            _ => {}
        }
    }

    pub(super) fn task_result(&mut self, block: &Value) {
        let Some(input) = self.task_inputs.remove(s(block, "tool_use_id")) else { return };
        let text = result_text(&block["content"]);
        let id = text.find('#').map(|i| text[i + 1..].chars().take_while(char::is_ascii_digit).collect::<String>()).filter(|d| !d.is_empty());
        if let Some(id) = id {
            self.emit("task", json!({ "op": "create", "id": id, "subject": input["subject"], "activeForm": input["activeForm"], "status": "pending" }));
        }
    }

    pub(super) fn agent_start(&mut self, block: &Value, parent: Option<&str>) {
        let name = s(block, "name");
        if name != "Agent" && name != "Task" {
            return;
        }
        let input = &block["input"];
        let id = s(block, "id").to_string();
        self.agent_tools.insert(id.clone());
        self.agent_running.insert(id.clone());
        let description = if s(input, "description").is_empty() { "Helper" } else { s(input, "description") };
        self.emit("agent", json!({
            "op": "start", "id": id, "parent": parent, "description": description, "kind": s(input, "subagent_type"),
            "prompt": s(input, "prompt"), "background": input["run_in_background"].as_bool().unwrap_or(false),
        }));
    }

    // A helper agent's own steps and words: shown in its card, not voiced by the robot.
    pub(super) fn agent_chatter(&mut self, msg: &Value) {
        let id = s(msg, "parent_tool_use_id").to_string();
        if s(msg, "type") != "assistant" {
            return;
        }
        for block in msg["message"]["content"].as_array().cloned().unwrap_or_default() {
            match s(&block, "type") {
                "tool_use" => {
                    self.agent_start(&block, Some(&id)); // a helper sending its own helper
                    self.emit("agent", json!({ "op": "step", "id": id, "tool": block["name"], "detail": describe_tool(s(&block, "name"), &block["input"]) }));
                }
                "text" if !s(&block, "text").trim().is_empty() => {
                    self.emit("agent", json!({ "op": "text", "id": id, "text": block["text"] }));
                }
                _ => {}
            }
        }
    }

    // Claude Code's task events for helpers: started, progress, finished
    pub(super) fn agent_task(&mut self, msg: &Value) {
        let task_id = s(msg, "task_id").to_string();
        let id = if !s(msg, "tool_use_id").is_empty() { s(msg, "tool_use_id").to_string() } else if let Some(id) = self.agent_tasks.get(&task_id) { id.clone() } else { return };
        if !task_id.is_empty() {
            self.agent_tasks.insert(task_id, id.clone());
        }
        let u = &msg["usage"];
        let usage = |mut v: Value| {
            if u.is_object() {
                v["tokens"] = u["total_tokens"].clone();
                v["tools"] = u["tool_uses"].clone();
                v["ms"] = u["duration_ms"].clone();
            }
            v
        };
        self.last_used = Instant::now(); // a helper at work keeps the conversation alive
        match s(msg, "subtype") {
            "task_started" => {
                self.agent_tools.insert(id.clone());
                self.agent_running.insert(id.clone());
                self.emit("agent", json!({ "op": "start", "id": id, "description": msg["description"], "kind": s(msg, "subagent_type"), "prompt": s(msg, "prompt"), "background": msg["is_backgrounded"].as_bool().unwrap_or(false) }));
            }
            "task_progress" => self.emit("agent", usage(json!({ "op": "progress", "id": id, "activity": s(msg, "description") }))),
            "task_updated" if !msg["patch"]["status"].is_null() => self.emit("agent", json!({ "op": "status", "id": id, "status": msg["patch"]["status"] })),
            "task_notification" => {
                self.agent_running.remove(&id);
                let status = if s(msg, "status").is_empty() { "completed" } else { s(msg, "status") };
                self.emit("agent", usage(json!({ "op": "done", "id": id, "status": status, "summary": s(msg, "summary"), "outputFile": s(msg, "output_file") })));
            }
            _ => {}
        }
    }

    // Claude Code asks before using a tool its permission mode doesn't cover. Questions
    // for the user are passed on; everything else is refused, as in plain print mode.
    pub(super) fn control_request(&mut self, msg: &Value) {
        let req = &msg["request"];
        let request_id = s(msg, "request_id").to_string();
        if s(req, "subtype") != "can_use_tool" {
            let error = format!("Unsupported request: {}", s(req, "subtype"));
            self.send(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } }));
            return;
        }
        if s(req, "tool_name") == "AskUserQuestion" && req["input"]["questions"].is_array() {
            self.pending_questions.insert(request_id.clone(), req["input"].clone());
            self.emit("question", json!({ "requestId": request_id, "questions": req["input"]["questions"] }));
            return;
        }
        let mode = if self.opts.permission_mode.is_empty() { "default" } else { &self.opts.permission_mode };
        let message = format!("{} needs permission this robot doesn't have (mode: {mode}).", s(req, "tool_name"));
        self.reply(&request_id, json!({ "behavior": "deny", "message": message }));
    }
}
