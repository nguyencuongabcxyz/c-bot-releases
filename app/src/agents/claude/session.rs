//! Running a conversation (impl Session): starting `claude -p` and keeping it open, sending
//! questions in turn (and the queue behind them), control requests (interrupt, model, effort,
//! Remote Control), answering Claude's questions, and closing it.

use super::*;

impl Session {
    pub fn new(opts: Opts, session_id: Option<String>, handler: Handler) -> Arc<Session> {
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let session = Arc::new_cyclic(|me| Session {
            me: me.clone(),
            inner: Mutex::new(Inner {
                opts,
                session_id,
                queue: VecDeque::new(),
                turn: None,
                displaced: None,
                own_uuids: HashSet::new(),
                pending_questions: HashMap::new(),
                pending_plans: HashMap::new(),
                controls: HashMap::new(),
                task_inputs: HashMap::new(),
                agent_tools: HashSet::new(),
                agent_tasks: HashMap::new(),
                agent_running: HashSet::new(),
                cost_so_far: 0.0,
                last_used: Instant::now(),
                proc: None,
                generation: 0,
                restart_before_next: false,
                closing: false,
                text: String::new(),
                asides: AsideFilter::default(),
                streamed: HashSet::new(),
                mcp_tool_ids: HashSet::new(),
                auto_turns: 0,
                last_uuid: None,
                tokens_done: 0,
                tokens_msg: 0,
                events: tx,
            }),
        });
        // events are handed to the handler one after another, on this thread
        let me = Arc::downgrade(&session);
        thread::spawn(move || {
            while let Ok((event, data)) = rx.recv() {
                let Some(session) = me.upgrade() else { break };
                handler(&session, &event, data);
            }
        });
        session
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn alive(&self) -> bool {
        self.lock().proc.is_some()
    }
    pub fn busy(&self) -> bool {
        self.lock().turn.is_some()
    }
    /// Helper agents still at work (they can outlive the answer that sent them).
    pub fn helpers_running(&self) -> usize {
        self.lock().agent_running.len()
    }
    pub fn idle_for(&self) -> Duration {
        self.lock().last_used.elapsed()
    }
    pub fn session_id(&self) -> Option<String> {
        self.lock().session_id.clone()
    }
    pub fn forget_session(&self) {
        self.lock().session_id = None;
    }

    /// Start its process now, before the first question (the group chat gets everyone's
    /// Claude Code ready before they speak).
    pub fn warm(&self) {
        let mut i = self.lock();
        if i.proc.is_none() && !i.closing {
            self.start(&mut i);
        }
    }

    pub(super) fn start(&self, i: &mut Inner) {
        let o = i.opts.clone();
        // stdin stays open: questions go in as stream-json messages, and tool permission
        // requests come back to us ("stdio") so questions can be answered
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--input-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
        ]
        .map(String::from)
        .to_vec();
        let mut flag = |k: &str, v: &str| {
            if !v.is_empty() {
                args.push(k.into());
                args.push(v.into());
            }
        };
        flag("--permission-mode", &o.permission_mode);
        flag("--append-system-prompt", &o.system_prompt);
        flag("--resume", i.session_id.as_deref().unwrap_or(""));
        // an edited question: the conversation carries on from before it, as a branch of its own
        let resume_at = i.opts.resume_at.take().filter(|_| i.session_id.is_some());
        // (a branch until it has a conversation of its own: a start that fails first never carries on the one it branches off)
        let fork = i.opts.fork && i.session_id.is_some();
        flag("--resume-session-at", resume_at.as_deref().unwrap_or(""));
        flag("--model", &o.model);
        flag("--effort", &o.effort);
        // the default tools plus the task tools (for the to-do card), once we know the defaults
        if let Some(tools) = o.tools.as_ref().filter(|t| !t.is_empty()) {
            let mut all: Vec<String> = tools.clone();
            for t in TASK_TOOLS {
                if !all.iter().any(|x| x == t) {
                    all.push(t.into());
                }
            }
            flag("--tools", &all.join(","));
        }
        // folders of files fed to the robot, so Claude Code may read them
        for dir in &o.add_dirs {
            flag("--add-dir", dir);
        }
        // the other robots' tools (mcp/link.rs), usable without asking
        flag("--mcp-config", &o.mcp_config);
        flag("--allowedTools", &o.allowed_tools.join(","));
        args.extend(o.extra_args.iter().cloned());
        if resume_at.is_some() || fork {
            args.push("--fork-session".into());
        }

        i.cost_so_far = 0.0;
        i.restart_before_next = false;
        let spawned = Command::new(&o.claude_path)
            .args(&args)
            .current_dir(&o.cwd)
            .env_clear()
            .envs(clean_env())
            .envs(o.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(err) => {
                return i.fail_all(&format!("Couldn't start Claude Code: {err}"), false, false);
            }
        };
        i.generation += 1;
        let generation = i.generation;
        let stderr = Arc::new(Mutex::new(String::new()));
        let (stdout, err_pipe) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let killer = Killer::new(child.id());
        i.proc = Some(Proc {
            generation,
            killer: killer.clone(),
            stdin: child.stdin.take(),
            stderr: stderr.clone(),
        });

        thread::spawn(move || {
            let mut err_pipe = err_pipe;
            let mut buf = String::new();
            let _ = err_pipe.read_to_string(&mut buf);
            stderr.lock().unwrap().push_str(&buf);
        });
        let me = self.me.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some(session) = me.upgrade() else { return };
                session.line(line);
            }
            let code = child.wait().ok().and_then(|s| s.code());
            killer.gone();
            drop(child);
            if let Some(session) = me.upgrade() {
                session.closed(generation, code);
            }
        });
        // learn the available models, effort levels and command descriptions
        let events = i.events.clone();
        i.control(
            json!({ "subtype": "initialize" }),
            Box::new(move |r| {
                if let Ok(info) = r {
                    let _ = events.send(("initialized".into(), info));
                }
            }),
        );
        self.enable_remote(i);
    }

    // Remote Control on, for this process: the same remote session as before, if there was one.
    // The session outlives the process (a restart picks it up again); turning it off ends it.
    pub(super) fn enable_remote(&self, i: &mut Inner) {
        let Some(name) = i.opts.remote.clone() else {
            return;
        };
        if i.proc.is_none() {
            return;
        }
        let mut req = json!({ "subtype": "remote_control", "enabled": true, "name": name, "keep_session_on_exit": true });
        if let Some(s) = &i.opts.remote_session {
            req["reattach_session_id"] = json!(s);
        }
        let me = self.me.clone();
        i.control(req, Box::new(move |r| {
            let Some(session) = me.upgrade() else { return };
            let mut i = session.lock();
            if i.opts.remote.is_none() || i.proc.is_none() {
                return; // (turned off meanwhile, or the process is gone: the next one tries again)
            }
            match r {
                Ok(v) => {
                    i.opts.remote_session = v["bridge_session_id"].as_str().map(str::to_string);
                    i.emit("remote", json!({ "on": true, "url": v["session_url"], "remoteSession": v["bridge_session_id"] }));
                }
                // the old remote session is gone (they expire after a while): start a new one
                Err(_) if i.opts.remote_session.is_some() => {
                    i.opts.remote_session = None;
                    session.enable_remote(&mut i);
                }
                Err(e) => {
                    i.opts.remote = None;
                    i.emit("remote", json!({ "on": false, "error": e }));
                }
            }
        }));
    }

    /// Remote Control (claude.ai/code and the Claude app): on, under this name, or off.
    pub fn set_remote(&self, name: Option<String>) {
        let mut i = self.lock();
        let on = name.is_some();
        i.opts.remote = name;
        if !on {
            i.opts.remote_session = None;
            if i.proc.is_some() {
                i.control(
                    json!({ "subtype": "remote_control", "enabled": false }),
                    Box::new(|_| {}),
                );
            }
            i.emit("remote", json!({ "on": false }));
        } else if i.proc.is_some() {
            self.enable_remote(&mut i);
        } else {
            if !i.closing {
                self.start(&mut i); // (it turns Remote Control on as it starts)
            }
            if i.proc.is_none() {
                i.opts.remote = None;
                i.emit(
                    "remote",
                    json!({ "on": false, "error": "Couldn't start Claude Code." }),
                );
            }
        }
    }

    pub fn remote(&self) -> bool {
        self.lock().opts.remote.is_some()
    }

    pub(super) fn closed(&self, generation: u64, code: Option<i32>) {
        let replies: Vec<Reply> = {
            let mut i = self.lock();
            if i.proc.as_ref().map(|p| p.generation) != Some(generation) {
                return; // an old process we replaced
            }
            let stderr = i
                .proc
                .take()
                .map(|p| p.stderr.lock().unwrap().clone())
                .unwrap_or_default();
            // helpers die with the process: say so, or their cards would spin forever
            for id in i.agent_running.drain().collect::<Vec<_>>() {
                i.emit("agent", json!({ "op": "done", "id": id, "status": "stopped", "summary": "Stopped: Claude Code closed before this helper finished." }));
            }
            if i.turn.is_some() || !i.queue.is_empty() {
                let msg = if i.closing {
                    "Cancelled.".to_string()
                } else if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else {
                    format!(
                        "Claude Code exited with code {}",
                        code.map_or("?".into(), |c| c.to_string())
                    )
                };
                let missing = msg.to_lowercase().contains("no conversation found");
                let closing = i.closing;
                i.fail_all(&msg, closing, missing);
            }
            i.emit("exit", Value::Null);
            i.controls.drain().map(|(_, r)| r).collect()
        };
        for r in replies {
            r(Err("Claude Code closed".into()));
        }
    }

    /// Queue a question; it's sent as soon as the current answer (if any) finishes.
    /// Says whether it has to wait.
    pub fn ask(&self, prompt: String, turn_id: String) -> bool {
        let mut i = self.lock();
        i.last_used = Instant::now();
        i.queue.push_back((turn_id.clone(), prompt));
        if i.turn.is_none() {
            self.next(&mut i);
        }
        i.turn.as_ref().is_some_and(|t| t.id != turn_id)
    }

    pub(super) fn next(&self, i: &mut Inner) {
        if i.turn.is_some() || i.queue.is_empty() {
            return;
        }
        if i.restart_before_next && i.proc.is_some() {
            self.restart(i);
        }
        if i.proc.is_none() {
            self.start(i);
        }
        if i.proc.is_none() {
            return;
        }
        let (id, prompt) = i.queue.pop_front().unwrap();
        let uuid = uuid::Uuid::new_v4().to_string();
        i.own_uuids.insert(uuid.clone());
        i.begin_turn(id, Some(uuid.clone()));
        i.send(&json!({ "type": "user", "uuid": uuid, "message": { "role": "user", "content": prompt }, "parent_tool_use_id": null, "session_id": "" }));
    }

    // Swap the process for a fresh one on the same conversation (new folders, new system prompt).
    pub(super) fn restart(&self, i: &mut Inner) {
        if let Some(mut old) = i.proc.take() {
            old.stdin.take(); // (its input closes: it finishes and goes)
            let killer = old.killer;
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                killer.kill(); // (if it hasn't gone by itself)
            });
        }
        self.start(i);
    }

    /// Stop the current answer. The conversation stays open; waiting questions are returned unsent.
    pub fn interrupt(&self) -> Vec<String> {
        let mut i = self.lock();
        let dropped: Vec<String> = i.queue.drain(..).map(|(id, _)| id).collect();
        if i.proc.is_some()
            && let Some(t) = i.turn.as_mut()
        {
            t.interrupted = true;
            i.control(json!({ "subtype": "interrupt" }), Box::new(|_| {}));
        }
        dropped
    }

    /// Cancel one waiting question.
    pub fn unqueue(&self, turn_id: &str) -> bool {
        let mut i = self.lock();
        let before = i.queue.len();
        i.queue.retain(|(id, _)| id != turn_id);
        i.queue.len() != before
    }

    /// Answer this waiting question right away: stop the current answer and jump the queue.
    pub fn send_now(&self, turn_id: &str) -> bool {
        let mut i = self.lock();
        let Some(pos) = i.queue.iter().position(|(id, _)| id == turn_id) else {
            return false;
        };
        let t = i.queue.remove(pos).unwrap();
        i.queue.push_front(t);
        if i.proc.is_some()
            && let Some(t) = i.turn.as_mut()
        {
            t.interrupted = true;
            i.control(json!({ "subtype": "interrupt" }), Box::new(|_| {}));
        }
        true
    }

    /// Ask the running process something and wait for its answer (not from the handler
    /// of an event that the answer would have to come after).
    pub(super) fn control_wait(&self, request: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.lock().control(
            request,
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        rx.recv_timeout(CONTROL_TIMEOUT)
            .map_err(|_| "Claude Code didn't answer in time".to_string())?
    }

    pub fn set_model(&self, model: &str) -> Result<(), String> {
        let alive = {
            let mut i = self.lock();
            i.opts.model = model.into();
            i.proc.is_some()
        };
        if alive {
            self.control_wait(json!({ "subtype": "set_model", "model": if model.is_empty() { "default" } else { model } }))?;
        }
        Ok(())
    }

    pub fn set_effort(&self, effort: &str) -> Result<(), String> {
        let alive = {
            let mut i = self.lock();
            i.opts.effort = effort.into();
            i.proc.is_some()
        };
        if alive {
            let level = if effort.is_empty() {
                Value::Null
            } else {
                json!(effort)
            };
            self.control_wait(
                json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }),
            )?;
        }
        Ok(())
    }

    pub fn set_permission_mode(&self, mode: &str) {
        let mut i = self.lock();
        i.opts.permission_mode = mode.into();
        if i.proc.is_some() {
            i.control(
                json!({ "subtype": "set_permission_mode", "mode": mode }),
                Box::new(|_| {}),
            );
        }
    }

    /// The default tools, learnt from Claude Code: picked up by a fresh process before the next question.
    pub fn set_tools(&self, tools: Vec<String>) {
        let mut i = self.lock();
        i.opts.tools = Some(tools);
        i.restart_before_next = true;
    }

    // Changes that only a new process can pick up are applied before the next question.
    pub fn set_system_prompt(&self, prompt: &str) {
        let mut i = self.lock();
        if i.opts.system_prompt == prompt {
            return;
        }
        i.opts.system_prompt = prompt.into();
        i.restart_before_next = i.proc.is_some();
    }

    pub fn allow_dirs(&self, dirs: &[String]) {
        let mut i = self.lock();
        let fresh: Vec<String> = dirs
            .iter()
            .filter(|d| !i.opts.add_dirs.contains(d))
            .cloned()
            .collect();
        if fresh.is_empty() {
            return;
        }
        i.opts.add_dirs.extend(fresh);
        i.restart_before_next = i.proc.is_some();
    }

    /// How full its context is (Claude Code's get_context_usage), if it's running.
    pub fn context_usage(&self) -> Option<Value> {
        if !self.alive() {
            return None;
        }
        self.control_wait(json!({ "subtype": "get_context_usage" }))
            .ok()
    }

    /// answers: { [question text]: "Label" | "Label, Other label" | free text }
    pub fn answer(&self, request_id: &str, answers: Value) -> bool {
        let mut i = self.lock();
        if i.proc.is_none() {
            return false;
        }
        let Some(mut input) = i.pending_questions.remove(request_id) else {
            return false;
        };
        input["answers"] = answers;
        i.reply(
            request_id,
            json!({ "behavior": "allow", "updatedInput": input }),
        );
        true
    }

    /// Your call on its plan: go ahead, switching to this permission mode, or keep planning
    /// (with your notes on what to change, if any).
    pub fn decide_plan(&self, request_id: &str, go_mode: Option<&str>, feedback: &str) -> bool {
        let mut i = self.lock();
        if i.proc.is_none() {
            return false;
        }
        let Some(input) = i.pending_plans.remove(request_id) else {
            return false;
        };
        match go_mode {
            Some(mode) => {
                i.opts.permission_mode = mode.into();
                let perms = json!([{ "type": "setMode", "mode": mode, "destination": "session" }]);
                i.reply(request_id, json!({ "behavior": "allow", "updatedInput": input, "updatedPermissions": perms }));
            }
            None => {
                let message = match feedback.trim() {
                    "" => "The user doesn't want to go ahead with this plan yet. Stay in plan mode: don't change anything, and ask them what they'd like changed.".to_string(),
                    notes => format!("The user wants to keep planning. Revise the plan with their notes, then present it again with ExitPlanMode. Their notes:

{notes}"),
                };
                i.reply(
                    request_id,
                    json!({ "behavior": "deny", "message": message }),
                );
            }
        }
        true
    }

    /// End the process. Anything still running or waiting fails as cancelled.
    pub fn close(&self) {
        let mut i = self.lock();
        i.closing = true;
        let busy = i.turn.is_some();
        let Some(p) = i.proc.as_mut() else { return };
        p.stdin.take();
        let killer = p.killer.clone();
        thread::spawn(move || {
            if !busy {
                thread::sleep(Duration::from_secs(3));
            }
            killer.kill(); // (if it hasn't gone by itself)
        });
    }

    pub(super) fn line(&self, line: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let mut i = self.lock();
        if s(&msg, "type") == "control_response" {
            let r = &msg["response"];
            if let Some(reply) = i.controls.remove(s(r, "request_id")) {
                drop(i);
                if s(r, "subtype") == "success" {
                    reply(Ok(r.get("response").cloned().unwrap_or(json!({}))));
                } else {
                    reply(Err(if s(r, "error").is_empty() {
                        "control request failed".into()
                    } else {
                        s(r, "error").to_string()
                    }));
                }
            }
            return;
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
            i.emit("session", json!(sid));
        }
        match ty {
            // a message starts being answered: ours, or one typed on claude.ai/code or in the Claude app
            "command_lifecycle" if s(&msg, "state") == "started" => {
                let uuid = s(&msg, "command_uuid").to_string();
                if i.own_uuids.remove(&uuid) {
                    if let Some(t) = i.turn.as_mut().filter(|t| t.uuid == uuid) {
                        t.started = true;
                    }
                } else if i.opts.remote.is_some() && !uuid.is_empty() {
                    // ours was sent but waits behind it: it comes back when this one is done
                    if i.turn.as_ref().is_some_and(|t| !t.started) {
                        i.displaced = i.turn.take();
                    }
                    i.emit("remote-prompt", json!({ "uuid": uuid, "sessionId": sid }));
                    if i.turn.is_none() {
                        i.begin_auto_turn();
                    }
                }
            }
            "control_request" => i.control_request(&msg),
            // a question it asked is no longer wanted (the answer was stopped)
            "control_cancel_request" => {
                let id = s(&msg, "request_id").to_string();
                if i.pending_questions.remove(&id).is_some()
                    || i.pending_plans.remove(&id).is_some()
                {
                    i.emit("request-cancelled", json!({ "requestId": id }));
                }
            }
            "stream_event" => {
                let ev = &msg["event"];
                match s(ev, "type") {
                    // how much it has written: the output tokens of each message as it goes
                    "message_start" => i.tokens_msg = 0,
                    "message_delta" => {
                        if let Some(n) = ev["usage"]["output_tokens"].as_u64() {
                            i.tokens_msg = n;
                            let total = i.tokens_done + n;
                            i.emit("usage", json!({ "outputTokens": total }));
                        }
                    }
                    "message_stop" => {
                        i.tokens_done += i.tokens_msg;
                        i.tokens_msg = 0;
                    }
                    "content_block_delta" if s(&ev["delta"], "type") == "thinking_delta" => {
                        let t = s(&ev["delta"], "thinking");
                        if !t.is_empty() {
                            i.emit("thinking-text", json!(t));
                        }
                    }
                    "content_block_start" => {
                        let block = &ev["content_block"];
                        if s(block, "type") == "text" {
                            i.separate();
                        }
                        if s(block, "type") == "thinking" {
                            i.emit("thinking", Value::Null);
                        }
                    }
                    "content_block_delta" if s(&ev["delta"], "type") == "text_delta" => {
                        let mid = s(&msg, "api_message_id");
                        if !mid.is_empty() {
                            i.streamed.insert(mid.to_string());
                        }
                        let text = s(&ev["delta"], "text").to_string();
                        i.append_text(&text);
                    }
                    _ => {}
                }
            }
            "assistant" => {
                if let Some(uuid) = msg["uuid"].as_str() {
                    i.last_uuid = Some(uuid.to_string());
                }
                let m = &msg["message"];
                for block in m["content"].as_array().cloned().unwrap_or_default() {
                    match s(&block, "type") {
                        "tool_use" => {
                            i.task_tool(&block);
                            i.agent_start(&block, None);
                            // MCP tools also pass their input on: some come with a view that draws from it
                            let name = s(&block, "name");
                            let id = s(&block, "id");
                            let args = block.get("input").cloned().unwrap_or(json!({}));
                            let mut ev = json!({ "name": name, "detail": describe_tool(name, &args), "id": id, "args": args });
                            if name.starts_with("mcp__") {
                                i.mcp_tool_ids.insert(id.to_string());
                                ev["input"] = ev["args"].clone();
                            }
                            i.emit("tool", ev);
                        }
                        // the answer's text when partial messages weren't streamed
                        "text" if !i.streamed.contains(s(m, "id")) => {
                            i.separate();
                            i.append_text(s(&block, "text"));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                for block in msg["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    if s(&block, "type") != "tool_result" {
                        continue;
                    }
                    i.task_result(&block);
                    let id = s(&block, "tool_use_id").to_string();
                    let is_error = block["is_error"].as_bool().unwrap_or(false);
                    // what the tool gave back, as Claude read it (the chat shows it when you click the step)
                    i.emit("tool-output", json!({ "id": id, "text": output_text(&block["content"]), "media": output_media(&block["content"]), "isError": is_error }));
                    // a file it changed: show the diff, like Claude Code's terminal
                    if !is_error && let Some(mut diff) = edit_diff(&msg["tool_use_result"]) {
                        diff["id"] = json!(id);
                        i.emit("edit", diff);
                    }
                    // an MCP tool's result, as the MCP server gave it (for its view)
                    if i.mcp_tool_ids.remove(&id) {
                        let content = match &block["content"] {
                            Value::String(t) => json!([{ "type": "text", "text": t }]),
                            Value::Null => json!([]),
                            other => other.clone(),
                        };
                        let mut result = json!({ "content": content, "isError": is_error });
                        let structured = &msg["tool_use_result"]["structuredContent"];
                        if !structured.is_null() {
                            result["structuredContent"] = structured.clone();
                        }
                        i.emit("tool-result", json!({ "id": id, "result": result }));
                    }
                    // a helper that ran in the foreground is done when its tool call returns
                    if i.agent_tools.contains(&id)
                        && !msg["tool_use_result"]["isAsync"].as_bool().unwrap_or(false)
                    {
                        i.agent_running.remove(&id);
                        let status = if is_error { "failed" } else { "completed" };
                        i.emit("agent", json!({ "op": "done", "id": id, "status": status, "summary": result_text(&block["content"]) }));
                    }
                }
            }
            "system" => {
                let sub = s(&msg, "subtype");
                if sub.starts_with("task_") {
                    i.agent_task(&msg);
                }
                if sub == "bridge_state" && i.opts.remote.is_some() {
                    i.emit("remote-state", msg["state"].clone());
                }
                // its permission mode changed by itself (it went into plan mode, a plan was approved)
                if sub == "status"
                    && let Some(mode) = msg["permissionMode"]
                        .as_str()
                        .filter(|m| *m != i.opts.permission_mode)
                {
                    i.opts.permission_mode = mode.to_string();
                    i.emit("mode", json!(mode));
                }
                if sub == "task_summary" && !s(&msg, "detail").is_empty() {
                    i.emit("status", msg["detail"].clone());
                } else if sub == "init" {
                    // the slash commands Claude Code offers in this folder (skills, custom commands)
                    if let Some(cmds) = msg["slash_commands"].as_array() {
                        i.emit(
                            "commands",
                            Value::Array(cmds.iter().map(|n| json!({ "name": n })).collect()),
                        );
                    }
                    if msg["tools"].is_array() {
                        let chosen = i.opts.tools.is_some();
                        i.emit("tools", json!({ "version": msg["claude_code_version"], "tools": msg["tools"], "chosen": chosen }));
                    }
                } else if sub == "commands_changed" {
                    if let Some(cmds) = msg["commands"].as_array() {
                        i.emit("commands", Value::Array(cmds.iter().map(|c| json!({ "name": c["name"], "description": s(c, "description") })).collect()));
                    }
                } else if sub == "status" && s(&msg, "status") == "compacting" {
                    i.emit("compact", json!({ "phase": "start" }));
                } else if sub == "compact_boundary" {
                    let meta = &msg["compact_metadata"];
                    i.emit("compact", json!({ "phase": "done", "pre": meta["pre_tokens"], "post": meta["post_tokens"] }));
                }
            }
            "result" => {
                let Some(turn) = i.turn.take() else { return };
                let rest = i.asides.flush();
                // (put the turn back for a moment: the last of its text still counts)
                i.turn = Some(turn);
                i.emit_text(&rest);
                let turn = i.turn.take().unwrap();
                let total = msg["total_cost_usd"].as_f64().unwrap_or(0.0);
                let cost = (total - i.cost_so_far).max(0.0);
                i.cost_so_far = total;
                let interrupted =
                    turn.interrupted || s(&msg, "terminal_reason").starts_with("abort");
                let text = match i.text.trim() {
                    "" => strip_asides(s(&msg, "result")).trim().to_string(),
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
                i.emit("done", json!({
                    "turnId": turn.id, "text": text, "asides": i.asides.asides, "isError": msg["is_error"].as_bool().unwrap_or(false) && !interrupted,
                    "interrupted": interrupted, "costUsd": cost, "denials": denials, "sessionId": session_id, "uuid": i.last_uuid,
                    "outputTokens": msg["usage"]["output_tokens"], "ms": msg["duration_ms"],
                }));
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
            _ => {}
        }
    }
}
