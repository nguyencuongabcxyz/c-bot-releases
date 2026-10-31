//! Running a conversation (impl Session): starting `claude -p` and keeping it open, sending
//! questions in turn (and the queue behind them), control requests (interrupt, model, effort,
//! Remote Control), answering Claude's questions, and closing it.

use std::sync::MutexGuard;

use super::*;
use crate::runtime::{Error, Locked};

impl Session {
    pub fn new(opts: Opts, session_id: Option<String>, handler: Handler) -> Arc<Session> {
        let (tx, rx) = mpsc::channel::<Event>();
        let session = Arc::new_cyclic(|me| Session {
            me: me.clone(),
            inner: Mutex::new(Inner {
                opts,
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
                cost_so_far: session_id.is_none().then_some(0.0), // (a new one costs nothing yet)
                session_id,
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
            while let Ok(event) = rx.recv() {
                let Some(session) = me.upgrade() else { break };
                handler(&session, event);
            }
        });
        session
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.locked()
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
    /// What its conversation has cost so far, as Claude Code last said (kept with the tab, so
    /// the next process, which starts from it, isn't taken for this turn's cost).
    pub fn cost_so_far(&self) -> Option<f64> {
        self.lock().cost_so_far
    }
    /// What the conversation it resumes had cost (as cost_so_far said, before).
    pub fn set_cost_so_far(&self, cost: f64) {
        self.lock().cost_so_far = Some(cost);
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
        let args = i.command_line();
        // (a new conversation starts from nothing; a resumed one from what it had cost)
        if i.session_id.is_none() {
            i.cost_so_far = Some(0.0);
        }
        i.restart_before_next = false;
        let o = &i.opts;
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
        let (stdout, err_pipe) = (
            child.stdout.take().expect("stdout is piped"),
            child.stderr.take().expect("stderr is piped"),
        );
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
            stderr.locked().push_str(&buf);
        });
        // what it writes, line by line (lines.rs), till it's gone
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
                    let _ = events.send(Event::Initialized(protocol::model_choices(&info)));
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
        i.control(
            req,
            Box::new(move |r| {
                let Some(session) = me.upgrade() else { return };
                let mut i = session.lock();
                if i.opts.remote.is_none() || i.proc.is_none() {
                    return; // (turned off meanwhile, or the process is gone: the next one tries again)
                }
                match r {
                    Ok(v) => {
                        i.opts.remote_session = v["bridge_session_id"].as_str().map(str::to_string);
                        i.emit(Event::Remote(Remote {
                            on: true,
                            url: v["session_url"].as_str().map(str::to_string),
                            remote_session: i.opts.remote_session.clone(),
                            error: None,
                        }));
                    }
                    // the old remote session is gone (they expire after a while): start a new one
                    Err(_) if i.opts.remote_session.is_some() => {
                        i.opts.remote_session = None;
                        session.enable_remote(&mut i);
                    }
                    Err(e) => {
                        i.opts.remote = None;
                        i.emit(Event::Remote(Remote {
                            error: Some(e.to_string()),
                            ..Remote::default()
                        }));
                    }
                }
            }),
        );
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
            i.emit(Event::Remote(Remote::default()));
        } else if i.proc.is_some() {
            self.enable_remote(&mut i);
        } else {
            if !i.closing {
                self.start(&mut i); // (it turns Remote Control on as it starts)
            }
            if i.proc.is_none() {
                i.opts.remote = None;
                i.emit(Event::Remote(Remote {
                    error: Some("Couldn't start Claude Code.".into()),
                    ..Remote::default()
                }));
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
                .map(|p| p.stderr.locked().clone())
                .unwrap_or_default();
            // helpers die with the process: say so, or their cards would spin forever
            for id in i.agent_running.drain().collect::<Vec<_>>() {
                i.emit(Event::Agent(AgentEvent::Done {
                    id,
                    status: "stopped".into(),
                    summary: "Stopped: Claude Code closed before this helper finished.".into(),
                    output_file: None,
                    report: None,
                    usage: HelperUsage::default(),
                }));
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
            i.emit(Event::Exit);
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
        let Some((id, prompt)) = i.queue.pop_front() else {
            return;
        };
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
        let Some(t) = i
            .queue
            .iter()
            .position(|(id, _)| id == turn_id)
            .and_then(|pos| i.queue.remove(pos))
        else {
            return false;
        };
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
    pub(super) fn control_wait(&self, request: Value) -> Result<Value, Error> {
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

    pub fn set_model(&self, model: &str) -> Result<(), Error> {
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

    pub fn set_effort(&self, effort: &str) -> Result<(), Error> {
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
}

impl Inner {
    /// `claude`'s arguments for the next start, from the options. stdin stays open: questions
    /// go in as stream-json messages, and tool permission requests come back to us ("stdio")
    /// so questions can be answered. (An edited question's resume point is used up here.)
    fn command_line(&mut self) -> Vec<String> {
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
        // an edited question: the conversation carries on from before it, as a branch of its own
        let resume_at = self
            .opts
            .resume_at
            .take()
            .filter(|_| self.session_id.is_some());
        // (a branch until it has a conversation of its own: a start that fails first never carries on the one it branches off)
        let fork = self.opts.fork && self.session_id.is_some();
        let o = &self.opts;
        let mut flag = |k: &str, v: &str| {
            if !v.is_empty() {
                args.push(k.into());
                args.push(v.into());
            }
        };
        flag("--permission-mode", &o.permission_mode);
        flag("--append-system-prompt", &o.system_prompt);
        flag("--resume", self.session_id.as_deref().unwrap_or(""));
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
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_to_do_tools_go_with_the_default_ones() {
        let opts = Opts {
            tools: Some(vec!["Read".into(), "TodoWrite".into()]),
            ..Default::default()
        };
        let handler: Handler = Arc::new(|_, _| {});
        let session = Session::new(opts, None, handler);
        let args = session.lock().command_line();
        let at = args.iter().position(|a| a == "--tools").expect("--tools");
        let tools: Vec<&str> = args[at + 1].split(',').collect();
        // (TodoWrite once, though the defaults had it already)
        assert_eq!(
            tools,
            [
                "Read",
                "TodoWrite",
                "TaskCreate",
                "TaskUpdate",
                "TaskList",
                "TaskGet"
            ]
        );
    }
}
