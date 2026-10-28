//! How the talk goes (impl Chat): whose turn it is, asking each robot in its personality, what
//! it said (passing, agreeing, mentioning someone), rounds and the free chat, the meeting room's
//! moves, the cost so far, and the end.

use super::*;
use crate::store::Fields;

impl Chat {
    pub(super) fn free(&self) -> bool {
        self.mode == Style::Free
    }

    /// The members still in it: on the desktop, and not dropped out.
    pub(super) fn active(&self, app: &AppHandle) -> Vec<String> {
        self.members
            .iter()
            .filter(|id| {
                !self.out.contains(*id)
                    && with(app, |st| st.store.get(id).is_some())
                    && visible(app, id)
            })
            .cloned()
            .collect()
    }

    pub(super) fn said(&self) -> usize {
        self.log
            .iter()
            .filter(|m| m["who"] == "robot" && !m["text"].as_str().unwrap_or("").is_empty())
            .count()
    }

    pub(super) fn typing(&self, app: &AppHandle) -> Vec<String> {
        self.active(app)
            .into_iter()
            .filter(|id| self.people.get(id).is_some_and(|p| p.turn.is_some()))
            .collect()
    }

    pub(super) fn msg(&mut self, id: u64) -> Option<&mut Value> {
        self.log.iter_mut().rev().find(|m| m["id"] == id)
    }

    pub(super) fn add(&mut self, fields: Value) -> u64 {
        let id = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let mut m = json!({ "id": id, "at": now_ms(), "text": "" });
        for (k, v) in fields.as_object().into_iter().flatten() {
            m[k] = v.clone();
        }
        self.log.push(m);
        id
    }

    pub(super) fn say(&mut self, text: String, nudge: Option<&str>) {
        let mut m = json!({ "who": "system", "text": text });
        if let Some(n) = nudge {
            m["nudge"] = json!(n);
        }
        self.add(m);
    }

    pub(super) fn mentions(&self, app: &AppHandle, text: &str) -> Vec<String> {
        let members: Vec<(String, String)> = self
            .members
            .iter()
            .map(|id| (id.clone(), name(app, id)))
            .collect();
        mentions_in(text, &members)
    }

    // ------------------------------------------------------------ each robot's Claude Code

    /// The robot in this chat: what it has read, its turn, and its Claude Code conversation.
    pub(super) fn person(&mut self, app: &AppHandle, id: &str) -> &mut Person {
        if !self.people.contains_key(id) {
            let session = self.connect(app, id, None);
            self.people.insert(
                id.to_string(),
                Person {
                    session,
                    ..Default::default()
                },
            );
        }
        self.people.entry(id.to_string()).or_default()
    }

    /// Its Claude Code process for the chat: a new one each time the chat starts up again,
    /// on the same conversation (an old one may still be closing, and wouldn't hear the question).
    pub(super) fn connect(
        &self,
        app: &AppHandle,
        id: &str,
        session_id: Option<String>,
    ) -> Option<Arc<Session>> {
        let (c, all, claude_path) = with(app, |st| {
            let c = st.store.get(id)?.clone();
            let all: HashMap<String, Value> = st
                .store
                .list()
                .iter()
                .filter_map(|x| Some((x["id"].as_str()?.to_string(), x.clone())))
                .collect();
            Some((
                c,
                all,
                st.store.settings()["claudePath"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            ))
        })?;
        let others: Vec<String> = self
            .members
            .iter()
            .filter(|o| o.as_str() != id)
            .filter_map(|o| {
                let oc = all.get(o)?;
                let p = personality_of(oc);
                Some(format!(
                    "{} ({}, looks after {})",
                    oc.name(),
                    p["label"].as_str().unwrap_or("robot"),
                    oc.folder()
                ))
            })
            .collect();
        let opts = claude::Opts {
            // (not found: starting fails, and the turn with it)
            claude_path: locate::find(&claude_path).unwrap_or_default(),
            cwd: c.folder().into(),
            system_prompt: format!(
                "{}\n{}",
                personalities::system_prompt_for(&c),
                rules(c.name(), &others, self.mode)
            ),
            permission_mode: "default".into(),
            model: if self.fast {
                "haiku".into()
            } else {
                c.model().into()
            },
            tools: Some(TOOLS.iter().map(|t| t.to_string()).collect()),
            extra_args: vec!["--strict-mcp-config".into()], // (no MCP servers: talk only)
            ..Default::default()
        };
        let (app2, id2) = (app.clone(), id.to_string());
        let handler: claude::Handler =
            Arc::new(move |session, event, data| on_session(&app2, &id2, session, event, data));
        Some(Session::new(opts, session_id, handler))
    }

    // a message the robot gets to see: the others' and yours (and a nudge to keep going)
    pub(super) fn seen_by(m: &Value, id: &str) -> bool {
        (m["who"] == "robot" && m["robot"] != id && !m["text"].as_str().unwrap_or("").is_empty())
            || m["who"] == "user"
            || (m["who"] == "system" && !m["nudge"].as_str().unwrap_or("").is_empty())
    }

    pub(super) fn unseen(&mut self, app: &AppHandle, id: &str) -> bool {
        let seen = self.person(app, id).seen;
        seen == 0
            || self.log[seen.min(self.log.len())..]
                .iter()
                .any(|m| Chat::seen_by(m, id))
    }

    /// What was said since the robot last looked, as it reads it.
    pub(super) fn since(&mut self, app: &AppHandle, id: &str) -> Vec<String> {
        let seen = self.person(app, id).seen.min(self.log.len());
        let lines = self.log[seen..]
            .iter()
            .filter(|m| Chat::seen_by(m, id))
            .map(|m| {
                if m["who"] == "system" {
                    return format!("({})", m["nudge"].as_str().unwrap_or(""));
                }
                let t = quote(m["text"].as_str().unwrap_or(""));
                if m["who"] == "user" {
                    format!("The user: {t}")
                } else {
                    format!("{}: {t}", m["name"].as_str().unwrap_or(""))
                }
            })
            .collect();
        let len = self.log.len();
        self.person(app, id).seen = len;
        lines
    }

    /// One turn of a robot's Claude Code: its words, what it looked at, then on_done.
    pub(super) fn run_turn(
        &mut self,
        env: &mut Env,
        id: &str,
        prompt: String,
        msg: Option<u64>,
        on_done: OnDone,
    ) {
        let turn_id = uuid::Uuid::new_v4().to_string();
        let me = self.person(env.app, id);
        me.turn = Some(Turn {
            turn_id: turn_id.clone(),
            msg,
            text: String::new(),
            looked: vec![],
            on_done,
            timed_out: false,
        });
        if me.session.is_none() {
            let session_id = me.session_id.clone();
            let session = self.connect(env.app, id, session_id);
            self.person(env.app, id).session = session;
        }
        if let Some(s) = self.person(env.app, id).session.clone() {
            env.fx.push(Fx::Ask(s, prompt, turn_id.clone()));
        }
        let (id2, t2) = (id.to_string(), turn_id);
        env.later(TURN_TIMEOUT_MS, move |c, env| c.timeout(env, &id2, &t2));
    }

    pub(super) fn end_turn(&mut self, env: &mut Env, id: &str, r: Value) {
        let Some(t) = self.person(env.app, id).turn.take() else {
            return;
        };
        self.cost += r["costUsd"].as_f64().unwrap_or(0.0);
        match t.on_done {
            OnDone::Posted { asked } => self.posted(env, id, &r, &t, asked),
            OnDone::Spoken { msg } => self.spoken(env, id, msg, &r, &t),
        }
    }

    pub(super) fn timeout(&mut self, env: &mut Env, id: &str, turn_id: &str) {
        let me = self.person(env.app, id);
        let Some(t) = me.turn.as_mut().filter(|t| t.turn_id == turn_id) else {
            return;
        };
        t.timed_out = true;
        if let Some(s) = me.session.clone() {
            env.fx.push(Fx::Interrupt(s)); // (that ends the turn: end_turn comes from its done event)
        }
        // stuck for good: its process goes too (the next turn starts it again)
        let (id2, t2) = (id.to_string(), turn_id.to_string());
        env.later(STUCK_MS, move |c, env| {
            if c.person(env.app, &id2)
                .turn
                .as_ref()
                .is_none_or(|t| t.turn_id != t2)
            {
                return;
            }
            c.rest1(env, &id2);
            c.end_turn(
                env,
                &id2,
                json!({ "turnId": t2, "isError": true, "error": "it took too long" }),
            );
        });
    }

    /// It couldn't answer: twice and it leaves the chat.
    pub(super) fn failed(&mut self, app: &AppHandle, id: &str, error: &str) {
        let fails = self.fails.entry(id.to_string()).or_insert(0);
        *fails += 1;
        if *fails < FAILS_MAX {
            return;
        }
        self.out.insert(id.to_string());
        self.say(format!("{} left the chat ({error}).", name(app, id)), None);
    }

    /// What it said, in its bubble, with the others turning to it (in the meeting room, or at their desks).
    pub(super) fn heard(&mut self, env: &mut Env, id: &str, text: &str, agree: bool) {
        let short = bubble_line(text);
        if self.room_open {
            env.fx.push(Fx::Emit(
                ROOM,
                "meeting:say",
                json!({ "id": id, "text": short, "agree": agree }),
            ));
            return;
        }
        env.tell(id, json!({ "phase": "say", "text": short }));
        for o in self.active(env.app) {
            if o != id {
                env.tell(
                    &o,
                    json!({ "phase": "listen", "side": side_of(env.app, &o, id) }),
                );
            }
        }
    }

    pub(super) fn next(&mut self, env: &mut Env) {
        if self.free() {
            self.pump(env)
        } else {
            self.advance(env)
        }
    }

    // ------------------------------------------------------------ free chat

    /// Everyone who's free and has something new to read takes a look; with nobody busy, it's over.
    pub(super) fn pump(&mut self, env: &mut Env) {
        if self.status != "running" || !self.free() {
            return;
        }
        let app = env.app;
        let active = self.active(app);
        let agreed = self.said() > 0
            && active
                .iter()
                .all(|id| self.people.get(id).is_some_and(|p| p.agree));
        let full = agreed
            || self.wrapping
            || self.cost >= self.cap
            || self.said() as u64 >= self.max_messages;
        if !full {
            for id in &active {
                if self.person(app, id).turn.is_none() && self.unseen(app, id) {
                    self.look(env, id);
                }
            }
        }
        if !self.typing(app).is_empty() {
            env.changed = true;
            return;
        }
        let reason = if self.wrapping {
            "you wrapped it up".to_string()
        } else if agreed {
            "everyone agreed".into()
        } else if self.cost >= self.cap {
            format!("it reached the ${:.2} cost cap", self.cap)
        } else if self.said() as u64 >= self.max_messages {
            format!("it reached {} messages", self.max_messages)
        } else if active.len() < 2 {
            "too few robots are left".into()
        } else if active
            .iter()
            .all(|id| self.people.get(id).is_some_and(|p| p.agree))
        {
            "everyone agreed".into()
        } else {
            "nobody had more to add".into()
        };
        self.summarise(env, &reason);
    }

    pub(super) fn look(&mut self, env: &mut Env, id: &str) {
        let app = env.app;
        let seen = self.person(app, id).seen.min(self.log.len());
        let first = seen == 0;
        let fresh: Vec<Value> = self.log[seen..].to_vec();
        let asked = fresh.iter().any(|m| {
            m["who"] == "user"
                && self
                    .mentions(app, m["text"].as_str().unwrap_or(""))
                    .iter()
                    .any(|x| x == id)
        });
        let mentioned = fresh.iter().any(|m| {
            m["who"] == "robot"
                && m["robot"] != id
                && self
                    .mentions(app, m["text"].as_str().unwrap_or(""))
                    .iter()
                    .any(|x| x == id)
        });
        let user_asked = fresh.iter().any(|m| m["who"] == "user");
        let lines = self.since(app, id);
        let me = name(app, id);
        let mut out: Vec<String> = vec![];
        if first {
            out.extend([format!("[Group chat] Topic: {}", self.topic), String::new()]);
        }
        if !lines.is_empty() {
            out.push(
                if first {
                    "Said so far:"
                } else {
                    "New in the chat:"
                }
                .into(),
            );
            out.extend(lines);
            out.push(String::new());
        } else if first {
            out.extend([
                "Nobody has said anything yet: the user just opened the chat with this topic."
                    .to_string(),
                String::new(),
            ]);
        }
        out.push(if asked {
            format!("The user asked you directly, {me}: answer them.")
        } else if user_asked {
            format!("Your move, {me}: reply (the user spoke), or <pass/> if the others have it covered.")
        } else if mentioned {
            format!("Your move, {me}: you were mentioned. If you were asked something, answer it; otherwise <pass/> (or <agree/>).")
        } else {
            format!("Your move, {me}: something new to add? A short message, or <pass/> (or <agree/> if you agree and have nothing to add).")
        });
        self.run_turn(env, id, out.join("\n"), None, OnDone::Posted { asked });
    }

    /// Its turn's over: a message to the group, or it stayed quiet (asked: you asked it directly).
    pub(super) fn posted(&mut self, env: &mut Env, id: &str, r: &Value, t: &Turn, asked: bool) {
        let app = env.app;
        if self.status == "running" && !self.wrapping {
            let said = text(&r["text"]);
            let raw = if said.is_empty() {
                t.text.clone()
            } else {
                said
            };
            let raw = raw.trim();
            let agree = agree_re().is_match(raw);
            let pass = pass_re().is_match(raw);
            let text = pass_re()
                .replacen(&agree_re().replace_all(raw, ""), 1, "")
                .trim()
                .to_string();
            let failed = t.timed_out || r["isError"].as_bool() == Some(true);
            if failed {
                let error = if t.timed_out {
                    "it took too long".to_string()
                } else {
                    Some(text_of(&r["error"]))
                        .filter(|e| !e.is_empty())
                        .unwrap_or_else(|| "it had nothing to say".into())
                };
                self.failed(app, id, &error);
            } else if r["interrupted"].as_bool() != Some(true) {
                let me = self.person(app, id);
                me.agree = agree || (pass && me.agree); // (quiet keeps what it thought; a message says it again)
                if !text.is_empty() && !pass {
                    self.add(json!({ "who": "robot", "robot": id, "name": name(app, id), "text": text, "agree": agree, "asked": asked, "looked": t.looked }));
                    self.heard(env, id, &text, agree);
                    let active = self.active(app);
                    if let Some(to) = self
                        .mentions(app, &text)
                        .into_iter()
                        .find(|o| o != id && active.contains(o))
                    {
                        self.throw_plane(env, id, &to);
                    }
                    for o in active.iter().filter(|o| o.as_str() != id) {
                        let p = self.person(app, o);
                        p.agree = p.agree && agree; // (something new to consider)
                    }
                }
            }
        }
        env.changed = true;
        env.later(300, |c, env| c.pump(env));
    }

    // ------------------------------------------------------------ taking turns

    pub(super) fn next_speaker(&mut self, app: &AppHandle) -> Option<(String, bool)> {
        let active = self.active(app);
        while !self.next_up.is_empty() {
            let id = self.next_up.remove(0);
            if active.contains(&id) {
                return Some((id, true));
            }
        }
        let left: Vec<String> = active
            .into_iter()
            .filter(|id| !self.spoke.contains(id))
            .collect();
        if left.is_empty() {
            return None;
        }
        let last = self
            .log
            .iter()
            .rev()
            .find(|m| m["who"] == "robot" || m["who"] == "user")
            .cloned();
        let asked: Vec<String> = match &last {
            Some(m) => self
                .mentions(app, m["text"].as_str().unwrap_or(""))
                .into_iter()
                .filter(|id| left.contains(id) && m["robot"] != id.as_str())
                .collect(),
            None => vec![],
        };
        Some((
            asked.first().cloned().unwrap_or_else(|| left[0].clone()),
            false,
        ))
    }

    /// The next turn, or the end.
    pub(super) fn advance(&mut self, env: &mut Env) {
        if self.status != "running" || self.speaker.is_some() {
            return;
        }
        let app = env.app;
        if self.wrapping {
            return self.summarise(env, "you wrapped it up");
        }
        if self.cost >= self.cap {
            return self.summarise(env, &format!("it reached the ${:.2} cost cap", self.cap));
        }
        if self.active(app).len() < 2 {
            return self.summarise(env, "too few robots are left");
        }
        let mut up = self.next_speaker(app);
        if up.is_none() {
            if self.active(app).iter().all(|id| self.agreed.contains(id)) {
                return self.summarise(env, "everyone agreed");
            }
            if self.round >= self.max_rounds {
                return self.summarise(
                    env,
                    &format!("that was the last round ({})", self.max_rounds),
                );
            }
            self.round += 1;
            self.spoke.clear();
            self.agreed.clear();
            up = self.next_speaker(app);
        }
        if let Some((id, asked)) = up {
            self.speak(env, &id, None, asked);
        }
    }

    pub(super) fn prompt(&mut self, app: &AppHandle, id: &str, asked: bool) -> String {
        let first = self.person(app, id).seen == 0;
        let lines = self.since(app, id);
        let last = self.round >= self.max_rounds;
        let mut out: Vec<String> = vec![];
        if first {
            out.extend([format!("[Group chat] Topic: {}", self.topic), String::new()]);
        }
        if !lines.is_empty() {
            out.push(
                if first {
                    "Said so far:"
                } else {
                    "Since you last spoke:"
                }
                .into(),
            );
            out.extend(lines);
            out.push(String::new());
        } else if first {
            out.extend([
                "Nobody has spoken yet: you open the discussion.".to_string(),
                String::new(),
            ]);
        }
        let tail = if asked {
            ": the user asked you directly, so answer them."
        } else if last {
            ": the last round, so help the group land on a conclusion."
        } else {
            "."
        };
        out.push(format!(
            "Your turn, {} (round {} of {}){tail}",
            name(app, id),
            self.round,
            self.max_rounds
        ));
        out.join("\n")
    }

    /// A turn whose words show as they come (taking turns, and the summary).
    pub(super) fn speak(&mut self, env: &mut Env, id: &str, summary: Option<String>, asked: bool) {
        let app = env.app;
        let who = if summary.is_some() {
            "summary"
        } else {
            "robot"
        };
        let msg = self.add(json!({ "who": who, "robot": id, "name": name(app, id), "round": self.round, "live": true, "asked": asked }));
        self.spoke.insert(id.to_string());
        self.speaker = Some(id.to_string());
        let is_summary = summary.is_some();
        let prompt = match summary {
            Some(s) => s,
            None => self.prompt(app, id, asked),
        };
        self.run_turn(env, id, prompt, Some(msg), OnDone::Spoken { msg });
        // on the desks: a paper plane over from whoever spoke last, and the others turn to listen
        if !is_summary {
            let from = self.last_speaker.replace(id.to_string());
            if let Some(from) = from.filter(|f| f != id) {
                self.throw_plane(env, &from, id);
            }
            env.tell(id, json!({ "phase": "listen-end" }));
            for o in self.active(app) {
                if o != id {
                    env.tell(
                        &o,
                        json!({ "phase": "listen", "side": side_of(app, &o, id) }),
                    );
                }
            }
        }
        env.changed = true;
    }

    /// The speaker's turn is over: what it said (or why not), then on to the next.
    pub(super) fn spoken(&mut self, env: &mut Env, id: &str, msg_id: u64, r: &Value, t: &Turn) {
        let app = env.app;
        self.speaker = None;
        let Some(msg) = self.msg(msg_id) else { return };
        let said = text(&r["text"]);
        let raw = if said.is_empty() {
            text(&msg["text"])
        } else {
            said
        };
        let raw = raw.trim();
        let agree = agree_re().is_match(raw);
        let text = agree_re().replace_all(raw, "").trim().to_string();
        let interrupted = r["interrupted"].as_bool() == Some(true);
        msg["live"] = json!(false);
        msg["text"] = json!(text);
        if t.timed_out {
            msg["note"] = json!("took too long: skipped");
        } else if interrupted {
            msg["note"] = json!("cut short");
        }
        let who = text_of(&msg["who"]);
        if self.status == "stopped" {
            env.changed = true;
            return;
        }
        if r["isError"].as_bool() == Some(true) || t.timed_out || (text.is_empty() && !interrupted)
        {
            let error = if t.timed_out {
                "it took too long".to_string()
            } else {
                Some(text_of(&r["error"]))
                    .filter(|e| !e.is_empty())
                    .unwrap_or_else(|| "it had nothing to say".into())
            };
            if let Some(m) = self.msg(msg_id) {
                m["error"] = json!(error);
            }
            if who != "summary" {
                self.failed(app, id, &error);
            }
        } else if who == "robot" {
            if agree && !self.agreed.iter().any(|a| a == id) {
                self.agreed.push(id.to_string());
            }
            if let Some(m) = self.msg(msg_id) {
                m["agree"] = json!(agree);
            }
            self.heard(env, id, &text, agree);
        }
        if who == "summary" {
            return self.summarised(env, msg_id);
        }
        env.changed = true;
        env.later(400, |c, env| c.advance(env));
    }

    // ------------------------------------------------------------ the end

    pub(super) fn summarise(&mut self, env: &mut Env, reason: &str) {
        if self.status == "summarising" {
            return;
        }
        let app = env.app;
        let active = self.active(app);
        let host = if active.contains(&self.host_id) {
            self.host_id.clone()
        } else {
            active
                .first()
                .cloned()
                .unwrap_or_else(|| self.host_id.clone())
        };
        self.status = "summarising";
        self.wrapping = false;
        self.ended = reason.to_string();
        self.say(
            format!(
                "The chat is over: {reason}. {} is writing the summary…",
                name(app, &host)
            ),
            None,
        );
        let lines = self.since(app, &host);
        let mut out = vec![format!("The group chat is over ({reason}).")];
        if !lines.is_empty() {
            out.push("New in the chat since you last looked:".into());
            out.extend(lines);
        }
        out.extend([
            String::new(),
            "Now write the summary for the user, as the chat's host (this is not a chat message):".into(),
            "**Conclusion**: what the group concluded, or, if it did not agree, the options and who backs which.".into(),
            "**Key points**: the main points, saying who made them.".into(),
            "**Next steps**: concrete actions or open questions, if any.".into(),
            "Markdown, under 220 words, in your voice but plain. No <agree/> or <pass/>.".into(),
        ]);
        self.speak(env, &host, Some(out.join("\n")), false);
    }

    pub(super) fn summarised(&mut self, env: &mut Env, msg_id: u64) {
        let app = env.app;
        self.status = "done";
        let (text, robot) = self
            .msg(msg_id)
            .map(|m| (text_of(&m["text"]), text_of(&m["robot"])))
            .unwrap_or_default();
        self.summary = Some(text.clone());
        self.adjourn(env);
        for id in self.active(app) {
            env.tell(&id, json!({ "phase": "listen-end", "wave": true }));
        }
        if !text.is_empty() {
            env.fx.push(Fx::After(
                1400,
                Box::new(move |app: &AppHandle| {
                    hub::send_to_robot(
                        app,
                        &robot,
                        "robot:social",
                        json!({ "phase": "say", "text": "Summary’s ready! 📝" }),
                    )
                }),
            ));
        }
        self.rest(env);
        env.changed = true;
    }

    /// Everyone stops talking: anything being written is cut short (free chat: never posted).
    pub(super) fn hush(&mut self, env: &mut Env) {
        let busy: Vec<String> = self
            .people
            .iter()
            .filter(|(_, p)| p.turn.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in busy {
            let Some(me) = self.people.get_mut(&id) else {
                continue;
            };
            let turn = me.turn.take();
            if let Some(s) = me.session.clone() {
                env.fx.push(Fx::Interrupt(s));
            }
            if let Some(m) = turn.and_then(|t| t.msg).and_then(|m| self.msg(m)) {
                m["live"] = json!(false);
                m["note"] = json!("cut short");
            }
            env.tell(&id, json!({ "phase": "listen-end" }));
        }
        self.speaker = None;
    }

    /// The robots' chat processes go (a later "keep talking" picks the conversations up again).
    pub(super) fn rest(&mut self, env: &mut Env) {
        let ids: Vec<String> = self.people.keys().cloned().collect();
        for id in ids {
            self.rest1(env, &id);
        }
    }

    pub(super) fn rest1(&mut self, env: &mut Env, id: &str) {
        let Some(me) = self.people.get_mut(id) else {
            return;
        };
        let Some(s) = me.session.take() else { return };
        me.session_id = s.session_id().or(me.session_id.take());
        env.fx.push(Fx::Close(s));
    }

    /// Stop now: whoever's talking is cut short, nobody else speaks.
    pub(super) fn stop(&mut self, env: &mut Env) {
        if self.status != "running" && self.status != "summarising" {
            return;
        }
        self.status = "stopped";
        self.ended = "you stopped it".into();
        self.hush(env);
        self.adjourn(env);
        self.say("You stopped the chat.".into(), None);
        for id in self.active(env.app) {
            env.tell(&id, json!({ "phase": "listen-end" }));
        }
        self.rest(env);
        env.changed = true;
    }

    /// Wrap up: whoever's talking is cut short, then the summary.
    pub(super) fn wrap(&mut self, env: &mut Env) {
        if self.status == "stopped" {
            return self.summarise(env, "you stopped it");
        }
        if self.status != "running" {
            return;
        }
        self.wrapping = true;
        if self.free() {
            let typing = self.typing(env.app);
            for id in &typing {
                if let Some(s) = self.people.get(id).and_then(|p| p.session.clone()) {
                    env.fx.push(Fx::Interrupt(s)); // (their turns end, unposted; then pump sums up)
                }
            }
            if typing.is_empty() {
                self.pump(env);
            }
        } else if let Some(s) = self
            .speaker
            .as_ref()
            .and_then(|sp| self.people.get(sp))
            .and_then(|p| p.session.clone())
        {
            env.fx.push(Fx::Interrupt(s));
        } else if self.speaker.is_none() {
            self.advance(env);
        }
        env.changed = true;
    }

    /// More, after it's over (nudge: the robots are asked to carry on; else something new came in).
    pub(super) fn more(&mut self, env: &mut Env, nudge: bool) {
        if self.status != "done" && self.status != "stopped" {
            return;
        }
        self.status = "running";
        self.ended.clear();
        if self.cost >= self.cap {
            self.cap = ((self.cost + 0.5) * 2.0).ceil() / 2.0;
        }
        if self.free() {
            self.max_messages = self.max_messages.max(self.said() as u64 + self.step / 2);
            let text = format!(
                "Keep talking: up to {} messages, ${:.2} at most.",
                self.max_messages, self.cap
            );
            self.say(text, nudge.then_some("The user asks you all to keep talking: pick up anything unresolved, or <pass/> if it is settled."));
            self.meet(env);
            env.changed = true;
            return self.pump(env);
        }
        self.meet(env);
        let active = self.active(env.app);
        let round_done = active.iter().all(|id| self.spoke.contains(id));
        self.max_rounds = self.round + u64::from(round_done);
        self.agreed.clear();
        self.say(
            format!(
                "One more round{}, ${:.2} at most.",
                if round_done {
                    ""
                } else {
                    " (finishing this one)"
                },
                self.cap
            ),
            None,
        );
        env.changed = true;
        self.advance(env);
    }

    /// You say something: it goes into the conversation, and the robots answer it.
    pub(super) fn user_says(&mut self, env: &mut Env, text: &str) {
        let text: String = text.trim().chars().take(4000).collect();
        if text.is_empty() {
            return;
        }
        self.add(json!({ "who": "user", "name": "You", "text": text }));
        self.agreed.clear(); // (something new to consider)
        for me in self.people.values_mut() {
            me.agree = false;
        }
        for id in self.mentions(env.app, &text) {
            if !self.free()
                && !self.next_up.contains(&id)
                && self.speaker.as_deref() != Some(id.as_str())
            {
                self.next_up.push(id.clone());
            }
            env.tell(&id, json!({ "phase": "say", "text": "👀" }));
        }
        if self.status == "done" || self.status == "stopped" {
            return self.more(env, false);
        }
        env.changed = true;
        if self.free() {
            self.pump(env);
        }
    }

    // ------------------------------------------------------------ on the desks

    /// A paper plane from one robot's desk to another's (not while they're in the meeting room).
    pub(super) fn throw_plane(&mut self, env: &mut Env, a: &str, b: &str) {
        let app = env.app;
        if self.room_open || walkers::has(app, a) || walkers::has(app, b) {
            return;
        }
        let side = side_of(app, a, b);
        env.tell(a, json!({ "phase": "throw", "side": side }));
        let (a, b) = (a.to_string(), b.to_string());
        env.fx.push(Fx::After(
            THROW_AT_MS,
            Box::new(move |app: &AppHandle| {
                if let (Some(from), Some(to)) = (
                    hand(app, &a, side, false),
                    hand(app, &b, side_of(app, &b, &a), true),
                ) {
                    planes::fly(app, from, to, None);
                }
            }),
        ));
    }

    // ------------------------------------------------------------ the meeting room

    /// What the room shows of the chat: who's typing, talking, agreeing.
    pub(super) fn meeting_state(&self, app: &AppHandle) -> Value {
        let active = self.active(app);
        let typing = if self.free() {
            self.typing(app)
        } else {
            vec![]
        };
        let agree: Vec<String> = if self.free() {
            active
                .iter()
                .filter(|id| self.people.get(*id).is_some_and(|p| p.agree))
                .cloned()
                .collect()
        } else {
            self.agreed.clone()
        };
        json!({ "ids": active, "mode": self.mode, "phase": self.status, "speaker": self.speaker, "typing": typing, "agree": agree })
    }

    /// Everyone gets up from their desk and rolls into the meeting room.
    pub(super) fn meet(&mut self, env: &mut Env) {
        if !self.room || self.room_open {
            return;
        }
        let app = env.app;
        let ids = self.active(app);
        let people: Vec<Value> = ids
            .iter()
            .filter_map(|id| {
                let c = with(app, |st| st.store.get(id).cloned())?;
                let kit = if c["kit"].is_object() { c["kit"].to_string() } else { "{}".into() };
                Some(json!({
                    "id": id, "name": c["name"], "color": c["color"].as_str().filter(|s| !s.is_empty()).unwrap_or("#5ac8fa"), "kit": kit,
                    "acc": c["accessory"].as_str().filter(|s| !s.is_empty()).unwrap_or("none"), "theme": c["theme"].as_str().filter(|s| !s.is_empty()).unwrap_or("classic"),
                }))
            })
            .collect();
        self.room_open = true;
        self.room_info = Some(
            json!({ "people": people, "topic": self.topic, "state": self.meeting_state(app) }),
        );
        let room_gen = ROOM_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        env.fx.push(Fx::RoomOpen {
            people: json!(people),
            room_gen,
        });
        // (one after another, as they roll in there)
        for (i, id) in ids.into_iter().enumerate() {
            env.later(300 + i as u64 * 550, move |c, env| {
                if c.room_open {
                    env.action(&id, "meeting");
                }
            });
        }
    }

    /// The meeting's over: the room goes, and everyone's straight back at their desk.
    pub(super) fn adjourn(&mut self, env: &mut Env) {
        if !self.room {
            return;
        }
        self.room_open = false;
        self.room_info = None;
        ROOM_GEN.fetch_add(1, Ordering::Relaxed);
        env.fx.push(Fx::RoomClose);
        for id in &self.members {
            env.action(id, "meeting-end");
        }
    }
}
