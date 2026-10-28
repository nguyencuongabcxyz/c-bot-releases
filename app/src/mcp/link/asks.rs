//! A call from a robot's tools, and robots asking each other (ask_robot) or handing off work (hand_off_task): the checks, the trip over, the answer or report back, the tasks on the desks.

use super::*;

/// One call from server.rs: { token, from, tab, tool, args }, checked, then done (tools/).
pub(super) fn handle(app: &AppHandle, req: &Value, conn: u64) -> Value {
    let from = req["from"].as_str().unwrap_or("").to_string();
    let token = link(app, |l| l.token.clone());
    let known = with(app, |st| st.store.get(&from).is_some());
    if req["token"].as_str() != Some(token.as_str()) || token.is_empty() || !known {
        return err("Not allowed.");
    }
    let tool = req["tool"].as_str().unwrap_or("");
    let args = if req["args"].is_object() {
        req["args"].clone()
    } else {
        json!({})
    };
    tools::call(
        app,
        &from,
        req["tab"].as_str().unwrap_or(""),
        tool,
        &args,
        conn,
    )
}

/// What a robot asked for (ask_robot or hand_off_task), checked: who it goes to, and what.
pub(super) struct Asked {
    pub(super) to: String,
    pub(super) to_name: String,
    pub(super) from_name: String,
    pub(super) from_folder: String,
    pub(super) title: String, // (a task's)
    pub(super) message: String,
}

/// Robot `from` asks another (ask_robot) or hands it a task (hand_off_task): the checks, the
/// bookkeeping, the message flying over; then the answer (or report) it waits for.
pub(in crate::mcp) fn ask(
    app: &AppHandle,
    from: &str,
    args: &Value,
    is_task: bool,
    conn: u64,
) -> Value {
    let asked = match read_ask(app, from, args, is_task) {
        Ok(a) => a,
        Err(e) => return err(e),
    };
    let (tx, rx) = mpsc::channel();
    let started = link(app, |l| l.open(from, &asked, args, is_task, conn, tx));
    let (req_id, exchange, first, task) = match started {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    if let Some(t) = &task {
        task_changed(app, t);
    }
    let text = if is_task {
        task_text(
            &asked.from_name,
            &asked.from_folder,
            &asked.title,
            &asked.message,
        )
    } else {
        message_text(&asked.from_name, &asked.from_folder, &asked.message)
    };
    let task_info = task
        .as_ref()
        .map(|t| json!({ "id": t.id, "title": t.title }));
    on_ask(
        app,
        from,
        &asked.to,
        json!({ "phase": "incoming", "reqId": req_id, "exchange": exchange, "first": first, "from": asked.from_name, "text": text, "task": task_info }),
    );
    wait_for(app, &rx, &req_id, is_task, &asked.to_name)
}

/// The request, checked: a message (a task: a title and details), and a robot on the desktop.
pub(super) fn read_ask(
    app: &AppHandle,
    from: &str,
    args: &Value,
    is_task: bool,
) -> Result<Asked, String> {
    let everyone: Vec<(String, String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .map(|c| {
                (
                    c.id().to_string(),
                    c.name().to_string(),
                    c.folder().to_string(),
                )
            })
            .collect()
    });
    let candidates: Vec<(String, String, String)> =
        everyone.iter().filter(|c| c.0 != from).cloned().collect();
    let target = find(&candidates, &text(&args["robot"])).cloned();
    let title: String = if is_task {
        text(&args["title"])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(80)
            .collect()
    } else {
        String::new()
    };
    let message = text(if is_task {
        &args["details"]
    } else {
        &args["message"]
    })
    .trim()
    .to_string();
    if message.is_empty() {
        return Err(if is_task {
            "The task has no details."
        } else {
            "The message is empty."
        }
        .into());
    }
    if is_task && title.is_empty() {
        return Err("The task needs a short title.".into());
    }
    let Some((to, to_name, _)) = target else {
        let names: Vec<String> = others(app, from).into_iter().map(|o| o.1).collect();
        let there = if names.is_empty() {
            "There are no other robots on the desktop.".to_string()
        } else {
            format!("On the desktop: {}.", names.join(", "))
        };
        return Err(format!(
            "There's no robot called \"{}\". {there}",
            text(&args["robot"])
        ));
    };
    if !visible(app, &to) {
        return Err(format!(
            "{to_name} is put away (not on the desktop), so it can't answer. The user can bring it out from the tray."
        ));
    }
    let (from_name, from_folder) = everyone
        .iter()
        .find(|c| c.0 == from)
        .map(|c| (c.1.clone(), c.2.clone()))
        .unwrap_or_default();
    Ok(Asked {
        to,
        to_name,
        from_name,
        from_folder,
        title,
        message,
    })
}

/// A started ask: its request id, the conversation it goes to (and whether that's new), its task.
pub(super) type Opened = (String, String, bool, Option<Task>);

impl Link {
    /// The checks and the bookkeeping, in one go (under the lock): not up its own chain, not
    /// too long a chain, not too often; then the conversation, the task, and who waits.
    pub(super) fn open(
        &mut self,
        from: &str,
        asked: &Asked,
        args: &Value,
        is_task: bool,
        conn: u64,
        reply: Sender<Value>,
    ) -> Result<Opened, String> {
        let (to, to_name) = (&asked.to, &asked.to_name);
        let now = now_ms();
        // who's waiting on this robot (it's answering them, maybe for others further up)
        let upstream: HashSet<String> = self
            .pending
            .values()
            .filter(|p| p.to == from)
            .flat_map(|p| p.chain.iter().cloned())
            .collect();
        if upstream.contains(to) {
            return Err(format!(
                "{to_name} is waiting on your answer (it asked you this), so you can't ask it: put what you need to know in your reply to it instead."
            ));
        }
        if upstream.len() + 2 > CHAIN_MAX {
            return Err(format!(
                "That's {CHAIN_MAX} robots in one chain already: answer with what you know instead of asking further."
            ));
        }
        let times = self.asked.entry(from.to_string()).or_default();
        times.retain(|t| now - t < ASKS_WINDOW_MS);
        if times.len() >= ASKS_MAX {
            return Err(format!(
                "That's {ASKS_MAX} messages in a few minutes: stop asking, and answer the user with what you have."
            ));
        }
        times.push(now);

        // the same conversation for a follow-up (unless it's a new question); a task gets a tab of its own
        let (exchange, first) = if is_task {
            (uuid::Uuid::new_v4().to_string(), true)
        } else {
            let fresh = args["new_conversation"].as_bool() == Some(true);
            self.exchange(&format!("{from}>{to}"), fresh, now)
        };
        let req_id = uuid::Uuid::new_v4().to_string();
        let task = is_task.then(|| self.new_task(from, to, &asked.title, now));
        let mut chain = upstream;
        chain.insert(from.to_string());
        self.pending.insert(
            req_id.clone(),
            Pending {
                from: from.to_string(),
                to: to.clone(),
                chain,
                conn,
                task: task.as_ref().map(|t| t.id.clone()),
                reply,
            },
        );
        Ok((req_id, exchange, first, task))
    }

    /// The conversation between two robots a message goes to: the last one, if it's recent
    /// (and not asked to start afresh), else a new one. Says whether it's new.
    pub(super) fn exchange(&mut self, key: &str, fresh: bool, now: i64) -> (String, bool) {
        let ex = self
            .exchanges
            .get_mut(key)
            .filter(|ex| !fresh && now - ex.at <= EXCHANGE_KEEP_MS);
        let (id, first) = match ex {
            Some(ex) => {
                ex.at = now;
                (ex.id.clone(), false)
            }
            None => (uuid::Uuid::new_v4().to_string(), true),
        };
        self.exchanges.insert(
            key.to_string(),
            Exchange {
                id: id.clone(),
                at: now,
            },
        );
        (id, first)
    }

    pub(super) fn new_task(&mut self, from: &str, to: &str, title: &str, now: i64) -> Task {
        self.task_seq += 1;
        let t = Task {
            id: format!("t{}", self.task_seq),
            from: from.to_string(),
            to: to.to_string(),
            title: title.to_string(),
            status: "sent",
            at: now,
            done_at: 0,
            report: String::new(),
        };
        self.tasks.push(t.clone());
        t
    }
}

/// The answer (or report), as long as it may take; after that, an error saying it didn't come.
pub(super) fn wait_for(
    app: &AppHandle,
    rx: &mpsc::Receiver<Value>,
    req_id: &str,
    is_task: bool,
    to_name: &str,
) -> Value {
    let wait = if is_task {
        TASK_TIMEOUT_MS
    } else {
        ANSWER_TIMEOUT_MS
    };
    match rx.recv_timeout(Duration::from_millis(wait)) {
        Ok(v) => v,
        Err(RecvTimeoutError::Timeout) => {
            let what = if is_task { "report" } else { "answer" };
            let error = format!(
                "No {what} from {to_name} after {} minutes (it may be waiting on the user in its chat).",
                wait / 60_000
            );
            settle(app, req_id, "", &error, false);
            rx.recv_timeout(Duration::from_secs(1))
                .unwrap_or_else(|_| err(error))
        }
        Err(RecvTimeoutError::Disconnected) => err("Cancelled."),
    }
}

/// The message flies over as a paper plane; the asked robot takes it on in a tab of its own
/// chat (main.js onAsk).
pub(super) fn on_ask(app: &AppHandle, from: &str, to: &str, incoming: Value) {
    let hand = |id: &str, up: bool| {
        hub::robot_rect(app, id).map(|r| {
            (
                r.x as f64 + r.w as f64 / 2.0,
                r.y as f64 + r.h as f64 * if up { 0.3 } else { 0.42 },
            )
        })
    };
    let req_id = text(&incoming["reqId"]);
    let to2 = to.to_string();
    let deliver = move |app: &AppHandle| {
        hub::send_to_robot(app, &to2, "robot:link", incoming);
        started(app, &req_id); // (a task: it's being worked on now)
    };
    if walkers::has(app, to) {
        walkers::dock(app, to); // (out walking: back to its desk first)
    }
    match (hand(from, false), hand(to, true)) {
        (Some(a), Some(b)) => planes::fly(app, a, b, Some(Box::new(deliver))),
        _ => deliver(app),
    }
}

/// The asked robot has taken the task on (it's in its chat now).
pub(super) fn started(app: &AppHandle, req_id: &str) {
    let changed = link(app, |l| {
        let task_id = l.pending.get(req_id)?.task.clone()?;
        let t = l
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id && t.status == "sent")?;
        t.status = "working";
        Some(t.clone())
    });
    if let Some(t) = changed {
        task_changed(app, &t);
    }
}

/// The robots on both ends of a task hear about every change to it; a finished one goes
/// from the desks a little later.
pub(super) fn task_changed(app: &AppHandle, t: &Task) {
    on_tasks(app, &[&t.from, &t.to]);
    if t.status != "sent" && t.status != "working" {
        let (app, id, ends) = (app.clone(), t.id.clone(), [t.from.clone(), t.to.clone()]);
        thread::spawn(move || {
            thread::sleep(TASK_SHOWN);
            link(&app, |l| l.tasks.retain(|x| x.id != id));
            on_tasks(&app, &[&ends[0], &ends[1]]);
        });
    }
}

pub(super) fn on_tasks(app: &AppHandle, ids: &[&str]) {
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(*id) {
            hub::send_to_robot(app, id, "robot:tasks", tasks_for(app, id));
        }
    }
}

/// The answer to a request (or why there is none): to the asking robot's tool, and onto
/// the task's tag. False if nobody was waiting for it any more.
pub(super) fn settle(
    app: &AppHandle,
    req_id: &str,
    said: &str,
    error: &str,
    cancelled: bool,
) -> bool {
    let Some(p) = link(app, |l| l.pending.remove(req_id)) else {
        return false;
    };
    let said = said.trim();
    let to_name = name(app, &p.to);
    if let Some(task_id) = &p.task {
        let status = if cancelled {
            "cancelled"
        } else if !error.is_empty() {
            "failed"
        } else {
            "done"
        };
        let report = if error.is_empty() { said } else { error };
        let changed = link(app, |l| {
            let t = l.tasks.iter_mut().find(|t| &t.id == task_id)?;
            t.status = status;
            t.done_at = now_ms();
            t.report = report.to_string();
            Some(t.clone())
        });
        if let Some(t) = changed {
            task_changed(app, &t);
        }
    }
    if cancelled {
        let _ = p.reply.send(err("Cancelled.")); // (nobody's listening any more)
        return true;
    }
    let answer = if !error.is_empty() {
        err(format!(
            "{to_name} couldn't {}: {error}",
            if p.task.is_some() {
                "do the task"
            } else {
                "answer"
            }
        ))
    } else {
        let lead = if p.task.is_some() {
            "finished the task. Its report"
        } else {
            "says"
        };
        json!({ "text": format!("{to_name} {lead}:\n{}", if said.is_empty() { "(an empty answer)" } else { said }) })
    };
    let _ = p.reply.send(answer);
    if error.is_empty() {
        on_answered(app, &p.from, &p.to);
    }
    true
}

/// The answer flies back as a paper plane.
pub(super) fn on_answered(app: &AppHandle, from: &str, to: &str) {
    if let (Some(r1), Some(r2)) = (hub::robot_rect(app, to), hub::robot_rect(app, from)) {
        let a = (
            r1.x as f64 + r1.w as f64 / 2.0,
            r1.y as f64 + r1.h as f64 * 0.42,
        );
        let b = (
            r2.x as f64 + r2.w as f64 / 2.0,
            r2.y as f64 + r2.h as f64 * 0.3,
        );
        planes::fly(app, a, b, None);
    }
}
