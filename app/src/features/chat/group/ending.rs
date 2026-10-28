//! The end, and after (impl Chat): the summary, stopping, wrapping up, more talk, and you joining in.

use super::*;

impl Chat {
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
}
