//! Taking turns (impl Chat): who speaks next, what they read, their words as they come.

use super::*;

impl Chat {
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
}
