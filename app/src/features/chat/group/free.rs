//! The free chat (impl Chat): whoever has something new to read takes a look and may post, till nobody has more to say.

use super::*;

impl Chat {
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
}
