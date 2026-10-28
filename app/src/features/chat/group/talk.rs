//! What the chat knows and each robot's part in it (impl Chat): who's in it, its messages and
//! mentions; each robot's Claude Code (connecting, what it reads, a turn and its end). How the
//! talk goes on: free.rs (the free chat), turns.rs (taking turns), ending.rs, room.rs.

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
            Arc::new(move |session, event| on_session(&app2, &id2, session, event));
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
}
