//! What the chat does outside its lock (Fx): the changes under the lock are noted in an Env, and run() does them after (windows, events, Claude Code asked), as calling out while holding it could wait on itself.

use super::*;

pub(super) type Job = Box<dyn FnOnce(&AppHandle) + Send>;

/// Something to do once the lock is let go.
pub(super) enum Fx {
    Emit(&'static str, &'static str, Value), // (window, channel, payload)
    Robot(String, &'static str, Value),      // to a robot's desk
    Dock(String),
    Ask(Arc<Session>, String, String),
    Interrupt(Arc<Session>),
    Close(Arc<Session>),
    Warm(Arc<Session>),
    After(u64, Job),
    RoomOpen { people: Value, room_gen: u64 },
    RoomClose,
}

pub(super) struct Env<'a> {
    pub(super) app: &'a AppHandle,
    pub(super) fx: Vec<Fx>,
    pub(super) changed: bool,
}

impl Env<'_> {
    pub(super) fn tell(&mut self, id: &str, payload: Value) {
        self.fx
            .push(Fx::Robot(id.to_string(), "robot:social", payload));
    }

    pub(super) fn action(&mut self, id: &str, action: &str) {
        self.fx
            .push(Fx::Robot(id.to_string(), "robot:action", json!(action)));
    }

    /// Do this to the chat in `ms` (if there's still one).
    pub(super) fn later(&mut self, ms: u64, f: impl FnOnce(&mut Chat, &mut Env) + Send + 'static) {
        self.fx.push(Fx::After(
            ms,
            Box::new(move |app: &AppHandle| {
                act(app, |g, env| {
                    if let Some(c) = g.chat.as_mut() {
                        f(c, env);
                    }
                })
            }),
        ));
    }
}

pub(super) static ROOM_GEN: AtomicU64 = AtomicU64::new(0); // goes up as the room opens or closes
pub(super) static SEQ: AtomicU64 = AtomicU64::new(0); // message ids

pub(super) fn run(app: &AppHandle, fx: Vec<Fx>) {
    for f in fx {
        match f {
            Fx::Emit(label, channel, payload) => {
                let _ = app.emit_to(label, channel, payload);
            }
            Fx::Robot(id, channel, payload) => hub::send_to_robot(app, &id, channel, payload),
            Fx::Dock(id) => walkers::dock(app, &id),
            Fx::Ask(s, prompt, turn_id) => {
                s.ask(prompt, turn_id);
            }
            Fx::Interrupt(s) => {
                s.interrupt();
            }
            Fx::Close(s) => s.close(),
            Fx::Warm(s) => s.warm(),
            Fx::After(ms, job) => {
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(ms));
                    job(&app);
                });
            }
            Fx::RoomOpen { people, room_gen } => {
                let app = app.clone();
                thread::spawn(move || open_room(&app, people, room_gen));
            }
            Fx::RoomClose => {
                if let Some(w) = app.get_webview_window(ROOM) {
                    let _ = w.destroy(); // (at once: everyone's back at their desks)
                }
            }
        }
    }
}
