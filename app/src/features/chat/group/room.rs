//! Where they talk (impl Chat): paper planes between the desks, or the meeting room they roll into.

use super::*;

impl Chat {
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
