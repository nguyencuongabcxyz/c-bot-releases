//! The app's end of the MCP server (server.rs): the private local socket each tool call comes
//! over, who may call (the token), and robots asking each other (main robotLink.js). Every
//! robot's Claude Code gets C-Bot's tools (tools/) from the server; mcp_config(id) is what to
//! pass it. ask_robot finds the robot by name and hands it the message (it flies over as a paper
//! plane, and the robot works on it in a tab of its own chat, in its own folder); its answer
//! (robots:answer, from the robot page) goes back as the tool's result. The asking robot's
//! Claude decides whether to follow up (the same tab, so it remembers) or that it has enough.
//! Several at once work: one robot can ask a few others in parallel, a robot can be asked by
//! several (a tab each), and a robot answering one can ask another to find out (a chain), up
//! to CHAIN_MAX robots. Guards: no asking yourself, nor anyone up your own chain (they're
//! waiting on you: that would never end); at most ASKS_MAX asks in ASKS_WINDOW per robot; an
//! answer that doesn't come within ANSWER_TIMEOUT comes back as an error.
//! hand_off_task is the same trip for a piece of work: the robot does it in a tab of its own
//! and its report goes back. It's also tracked as a task (sent, working, done / failed /
//! cancelled) that both robots show on their desks (robot:tasks, tasks_for), waits up to
//! TASK_TIMEOUT, and is cancelled if the robot that handed it off stops waiting (its Claude
//! was stopped: the tool server hangs up the line).
//! The other tools (the user's words and notes, the chat's shells) are tools/'s own. Each
//! conversation's tools server knows which one it serves (its chat tab), so a conversation
//! only ever reaches its own shells.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::tools::{self, err};
use crate::platform::window;
use crate::robots;
use crate::robots::{planes, social, walkers};
use crate::runtime::util::text;
use crate::runtime::{hub, part_or_default, with};
use crate::store::now_ms;
use crate::workbench::shell;

const ANSWER_TIMEOUT_MS: u64 = 10 * 60_000;
const EXCHANGE_KEEP_MS: i64 = 30 * 60_000; // a follow-up within this long goes to the same tab
const ASKS_MAX: usize = 12;
const ASKS_WINDOW_MS: i64 = 10 * 60_000;
const CHAIN_MAX: usize = 4; // robots in one chain of asks (A asks B, who asks C, who asks D)
const TASK_SHOWN: Duration = Duration::from_secs(90); // a finished task stays on the desks this long

/// How long a handed-off task may take (ms): Claude Code's MCP_TOOL_TIMEOUT is set past it.
pub const TASK_TIMEOUT_MS: u64 = 45 * 60 * 1000;

/// What every robot's Claude should know about the user's words and notebook.
const DESK_NOTE: &str = concat!(
    "The user keeps a list of English words they're learning and a notebook of notes in C-Bot. ",
    "When they ask what words they've saved (or to review or quiz them), use list_words; when they ask you to save or remember a word, use save_words. ",
    "When they ask about their notes or to-dos, use list_notes; when they ask you to note something down, use add_note."
);

#[derive(Clone)]
struct Task {
    id: String,
    from: String,
    to: String,
    title: String,
    status: &'static str, // sent | working | done | failed | cancelled
    at: i64,
    done_at: i64,
    report: String,
}

struct Pending {
    from: String,
    to: String,
    chain: HashSet<String>, // robot ids waiting up the line
    conn: u64,              // the socket it came on (hung up: cancelled)
    task: Option<String>,
    reply: Sender<Value>,
}

struct Exchange {
    id: String,
    at: i64,
}

#[derive(Default)]
struct Link {
    token: String,
    port: Option<u16>,
    pending: HashMap<String, Pending>, // request id -> who's waiting for what
    exchanges: HashMap<String, Exchange>, // "from>to" -> the conversation a follow-up goes to
    asked: HashMap<String, Vec<i64>>,  // robot id -> when it asked lately
    tasks: Vec<Task>,                  // (in the order they were handed off)
    task_seq: u64,
}

fn link<R>(app: &AppHandle, f: impl FnOnce(&mut Link) -> R) -> R {
    part_or_default(app, f)
}

// ---------------------------------------------------------------- who's who

fn name(app: &AppHandle, id: &str) -> String {
    with(app, |st| {
        st.store
            .get(id)
            .and_then(|c| c["name"].as_str().map(str::to_string))
    })
    .unwrap_or_else(|| "a robot".into())
}

/// Its window is out on the desktop.
fn visible(app: &AppHandle, id: &str) -> bool {
    robots::hwnd_of(app, id).is_some_and(window::is_visible)
}

/// The robots on the desktop other than this one: (id, name, folder).
pub(super) fn others(app: &AppHandle, from: &str) -> Vec<(String, String, String)> {
    let all: Vec<(String, String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .map(|c| {
                (
                    c["id"].as_str().unwrap_or("").to_string(),
                    c["name"].as_str().unwrap_or("").to_string(),
                    c["folder"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    });
    all.into_iter()
        .filter(|(id, _, _)| id != from && visible(app, id))
        .collect()
}

/// How it is, for list_robots.
pub(super) fn status_of(app: &AppHandle, id: &str) -> &'static str {
    if walkers::has(app, id) {
        "out for a walk"
    } else if hub::robot_busy(app, id) {
        "busy working"
    } else if social::peek(app, id).is_some_and(|r| r["awake"] == false) {
        "asleep"
    } else {
        "awake"
    }
}

/// The robot called that (exactly, else the start of its name, else part of it).
fn find<'a>(
    robots: &'a [(String, String, String)],
    wanted: &str,
) -> Option<&'a (String, String, String)> {
    let w = wanted.trim().to_lowercase();
    robots
        .iter()
        .find(|r| r.1.to_lowercase() == w)
        .or_else(|| robots.iter().find(|r| r.1.to_lowercase().starts_with(&w)))
        .or_else(|| {
            robots
                .iter()
                .find(|r| !w.is_empty() && r.1.to_lowercase().contains(&w))
        })
}

// ---------------------------------------------------------------- what the asked robot reads

fn message_text(from_name: &str, from_folder: &str, message: &str) -> String {
    [
        format!("📨 Message from {from_name}, another C-Bot robot (it looks after {from_folder}), on the user's behalf:"),
        String::new(),
        message.to_string(),
        String::new(),
        format!("Reply to {from_name} directly: your answer goes back to it, so keep it to the point and include what it needs. To look things up in your folder, read and search the files (Read, Grep, Glob): running commands may need a permission you don't have. If you need something from {from_name}, ask it in your reply."),
    ]
    .join("\n")
}

fn task_text(from_name: &str, from_folder: &str, title: &str, details: &str) -> String {
    [
        format!("📋 Task from {from_name}: {title}"),
        String::new(),
        format!("{from_name} is another C-Bot robot (it looks after {from_folder}). It hands you this, on the user's behalf, to do in your own project folder:"),
        String::new(),
        details.to_string(),
        String::new(),
        format!("Do the work here, in your folder. When you're done, reply with a short report for {from_name}: what you did and changed (the files), anything it needs to use your work (names, endpoints, shapes, values), and anything left undone or that it should check. If you can't do it, or not all of it, say what's missing and why. Running some commands or editing may need a permission you don't have: then say so in your report."),
    ]
    .join("\n")
}

/// What every robot's Claude should know: the other robots, and the tools to ask them.
fn note_for(others: &[(String, String, String)]) -> String {
    if others.is_empty() {
        return String::new();
    }
    let list: Vec<String> = others
        .iter()
        .map(|(_, n, f)| format!("{n} (looks after {f})"))
        .collect();
    format!(
        "Other C-Bot robots on this desktop: {}. {}{}{}{}",
        list.join(", "),
        "When the user asks you to ask one of them something (or what you need is in their project), use the ask_robot tool: ask one clear question with the context it needs ",
        "(to ask several robots, call ask_robot for each in the same turn, so they work at the same time), ",
        "follow up with ask_robot as many times as it takes (it remembers the conversation), and once you have what you need, answer the user yourself, saying what you found out from whom. ",
        "When the user asks you to get another robot to do work in its project (build, change, fix or set up something there), hand it over with hand_off_task: a short title and full details; you get its report back when it is done, then carry on and tell the user what was done where."
    )
}

// ---------------------------------------------------------------- a call from a robot's tools

/// One call from server.rs: { token, from, tab, tool, args }, checked, then done (tools/).
fn handle(app: &AppHandle, req: &Value, conn: u64) -> Value {
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

/// Robot `from` asks another (ask_robot) or hands it a task (hand_off_task): the checks, the
/// bookkeeping, the message flying over; then the answer (or report) it waits for.
pub(super) fn ask(app: &AppHandle, from: &str, args: &Value, is_task: bool, conn: u64) -> Value {
    let from = from.to_string();
    let everyone: Vec<(String, String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .map(|c| {
                (
                    c["id"].as_str().unwrap_or("").to_string(),
                    c["name"].as_str().unwrap_or("").to_string(),
                    c["folder"].as_str().unwrap_or("").to_string(),
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
        return err(if is_task {
            "The task has no details."
        } else {
            "The message is empty."
        });
    }
    if is_task && title.is_empty() {
        return err("The task needs a short title.");
    }
    let Some((to, to_name, _)) = target else {
        let names: Vec<String> = others(app, &from).into_iter().map(|o| o.1).collect();
        let there = if names.is_empty() {
            "There are no other robots on the desktop.".to_string()
        } else {
            format!("On the desktop: {}.", names.join(", "))
        };
        return err(format!(
            "There's no robot called \"{}\". {there}",
            text(&args["robot"])
        ));
    };
    if !visible(app, &to) {
        return err(format!(
            "{to_name} is put away (not on the desktop), so it can't answer. The user can bring it out from the tray."
        ));
    }
    let (from_name, from_folder) = everyone
        .iter()
        .find(|c| c.0 == from)
        .map(|c| (c.1.clone(), c.2.clone()))
        .unwrap_or_default();
    let now = now_ms();

    // the checks and the bookkeeping, in one go
    let (tx, rx) = mpsc::channel();
    let started = link(app, |l| {
        // who's waiting on this robot (it's answering them, maybe for others further up)
        let upstream: HashSet<String> = l
            .pending
            .values()
            .filter(|p| p.to == from)
            .flat_map(|p| p.chain.iter().cloned())
            .collect();
        if upstream.contains(&to) {
            return Err(format!(
                "{to_name} is waiting on your answer (it asked you this), so you can't ask it: put what you need to know in your reply to it instead."
            ));
        }
        if upstream.len() + 2 > CHAIN_MAX {
            return Err(format!(
                "That's {CHAIN_MAX} robots in one chain already: answer with what you know instead of asking further."
            ));
        }
        let times = l.asked.entry(from.clone()).or_default();
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
            let key = format!("{from}>{to}");
            let fresh = args["new_conversation"].as_bool() == Some(true);
            let ex = l
                .exchanges
                .get_mut(&key)
                .filter(|ex| !fresh && now - ex.at <= EXCHANGE_KEEP_MS);
            let (id, first) = match ex {
                Some(ex) => {
                    ex.at = now;
                    (ex.id.clone(), false)
                }
                None => (uuid::Uuid::new_v4().to_string(), true),
            };
            l.exchanges.insert(
                key,
                Exchange {
                    id: id.clone(),
                    at: now,
                },
            );
            (id, first)
        };
        let req_id = uuid::Uuid::new_v4().to_string();
        let task = is_task.then(|| {
            l.task_seq += 1;
            let t = Task {
                id: format!("t{}", l.task_seq),
                from: from.clone(),
                to: to.clone(),
                title: title.clone(),
                status: "sent",
                at: now,
                done_at: 0,
                report: String::new(),
            };
            l.tasks.push(t.clone());
            t
        });
        let mut chain = upstream;
        chain.insert(from.clone());
        l.pending.insert(
            req_id.clone(),
            Pending {
                from: from.clone(),
                to: to.clone(),
                chain,
                conn,
                task: task.as_ref().map(|t| t.id.clone()),
                reply: tx,
            },
        );
        Ok((req_id, exchange, first, task))
    });
    let (req_id, exchange, first, task) = match started {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    if let Some(t) = &task {
        task_changed(app, t);
    }
    let text = if is_task {
        task_text(&from_name, &from_folder, &title, &message)
    } else {
        message_text(&from_name, &from_folder, &message)
    };
    let task_info = task
        .as_ref()
        .map(|t| json!({ "id": t.id, "title": t.title }));
    on_ask(
        app,
        &from,
        &to,
        json!({ "phase": "incoming", "reqId": req_id, "exchange": exchange, "first": first, "from": from_name, "text": text, "task": task_info }),
    );

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
            settle(app, &req_id, "", &error, false);
            rx.recv_timeout(Duration::from_secs(1))
                .unwrap_or_else(|_| err(error))
        }
        Err(RecvTimeoutError::Disconnected) => err("Cancelled."),
    }
}

/// The message flies over as a paper plane; the asked robot takes it on in a tab of its own
/// chat (main.js onAsk).
fn on_ask(app: &AppHandle, from: &str, to: &str, incoming: Value) {
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
fn started(app: &AppHandle, req_id: &str) {
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
fn task_changed(app: &AppHandle, t: &Task) {
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

fn on_tasks(app: &AppHandle, ids: &[&str]) {
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(*id) {
            hub::send_to_robot(app, id, "robot:tasks", tasks_for(app, id));
        }
    }
}

/// The answer to a request (or why there is none): to the asking robot's tool, and onto
/// the task's tag. False if nobody was waiting for it any more.
fn settle(app: &AppHandle, req_id: &str, said: &str, error: &str, cancelled: bool) -> bool {
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
fn on_answered(app: &AppHandle, from: &str, to: &str) {
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

// ---------------------------------------------------------------- the socket

fn serve(app: AppHandle, listener: TcpListener) {
    static CONN: AtomicU64 = AtomicU64::new(0);
    for sock in listener.incoming() {
        let Ok(sock) = sock else { continue };
        let conn = CONN.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        thread::spawn(move || connection(&app, sock, conn));
    }
}

/// One call: a line in, a line back.
fn connection(app: &AppHandle, mut sock: TcpStream, conn: u64) {
    let mut line = String::new();
    {
        let mut reader = BufReader::new(&sock);
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
    }
    let answer = match serde_json::from_str::<Value>(line.trim()) {
        Ok(req) => {
            // the asking robot stopped waiting (its Claude was stopped): its request is cancelled
            if let Ok(mut watch) = sock.try_clone() {
                let app = app.clone();
                thread::spawn(move || {
                    let mut buf = [0u8; 64];
                    while matches!(watch.read(&mut buf), Ok(n) if n > 0) {}
                    let mine: Vec<String> = link(&app, |l| {
                        l.pending
                            .iter()
                            .filter(|(_, p)| p.conn == conn)
                            .map(|(k, _)| k.clone())
                            .collect()
                    });
                    for req_id in mine {
                        settle(&app, &req_id, "", "", true);
                    }
                });
            }
            handle(app, &req, conn)
        }
        Err(_) => err("Bad request."),
    };
    let _ = writeln!(sock, "{answer}").and_then(|_| sock.flush());
    let _ = sock.shutdown(Shutdown::Both);
}

// ---------------------------------------------------------------- for the others

/// What this robot's Claude should know about the others, and the user's words and notes
/// (added to its system prompt).
pub fn note(app: &AppHandle, id: &str) -> Option<String> {
    let others = note_for(&others(app, id));
    let desk = format!("{DESK_NOTE}\n{}", shell::NOTE);
    Some(if others.is_empty() {
        desk
    } else {
        format!("{others}\n{desk}")
    })
}

/// The --mcp-config file of one of its conversations.
fn config_file(app: &AppHandle, id: &str, tab: &str) -> PathBuf {
    let safe = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric() || "-_".contains(*c))
            .collect::<String>()
    };
    with(app, |st| st.data_dir.join("robot-link")).join(format!(
        "mcp-{}-{}.json",
        safe(id),
        safe(tab)
    ))
}

/// The --mcp-config file giving this conversation's Claude Code the other-robots tools
/// (written for each conversation: this exe, run as the tools' server, the way back to the
/// app, and which conversation it is).
pub fn mcp_config(app: &AppHandle, id: &str, tab: &str) -> Option<String> {
    let (port, token) = link(app, |l| Some((l.port?, l.token.clone())))?;
    let exe = std::env::current_exe().ok()?;
    let file = config_file(app, id, tab);
    let dir = file.parent()?.to_path_buf();
    let cfg = json!({ "mcpServers": { "cbot": {
        "command": exe.to_string_lossy(),
        "args": [crate::mcp::server::FLAG, id, port.to_string(), tab],
        "env": { "CBOT_TOKEN": token },
    } } });
    let written =
        std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, cfg.to_string()));
    if let Err(e) = written {
        eprintln!("[robots] cannot set up the robot tools: {e}");
        return None;
    }
    Some(file.to_string_lossy().into_owned())
}

/// A conversation closed: its config goes.
pub fn forget_tab(app: &AppHandle, id: &str, tab: &str) {
    let _ = std::fs::remove_file(config_file(app, id, tab));
}

/// The tasks robot id handed off or was handed, as its desk shows them.
pub fn tasks_for(app: &AppHandle, id: &str) -> Value {
    let tasks: Vec<Task> = link(app, |l| {
        l.tasks
            .iter()
            .filter(|t| t.from == id || t.to == id)
            .cloned()
            .collect()
    });
    Value::Array(
        tasks
            .into_iter()
            .map(|t| {
                let mine = t.to == id;
                let other = name(app, if mine { &t.from } else { &t.to });
                let report: String = t.report.chars().take(300).collect();
                json!({ "id": t.id, "mine": mine, "other": other, "title": t.title, "status": t.status, "at": t.at, "doneAt": t.done_at, "report": report })
            })
            .collect(),
    )
}

/// The tasks a robot handed off or was handed, for its desk after a reload.
#[tauri::command(async)]
pub fn robot_tasks(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    Ok(tasks_for(&app, &robots::sender(&window)?))
}

/// A robot's answer to another robot's message (only the robot it went to can answer it).
#[tauri::command(async)]
pub fn robots_answer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    answer: Value,
) -> Result<(), String> {
    let id = robots::sender(&window)?;
    let req_id = text(&answer["reqId"]);
    if link(&app, |l| l.pending.get(&req_id).is_some_and(|p| p.to == id)) {
        let error = if answer["error"].is_null() || answer["error"] == false {
            String::new()
        } else {
            text(&answer["error"])
        };
        settle(&app, &req_id, &text(&answer["text"]), &error, false);
    }
    Ok(())
}

pub fn setup(app: &AppHandle) {
    let mut state = Link {
        token: uuid::Uuid::new_v4().simple().to_string(),
        ..Default::default()
    };
    // a private line for the robots' tools: this machine only, with a password
    match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => {
            state.port = listener.local_addr().ok().map(|a| a.port());
            let app = app.clone();
            thread::spawn(move || serve(app, listener));
        }
        Err(e) => eprintln!("[robots] link socket: {e}"),
    }
    app.manage(Mutex::new(state));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bots() -> Vec<(String, String, String)> {
        [
            ("1", "Captain", "C:\\a"),
            ("2", "Bolt", "C:\\b"),
            ("3", "Robo Bob", "C:\\c"),
        ]
        .iter()
        .map(|(i, n, f)| (i.to_string(), n.to_string(), f.to_string()))
        .collect()
    }

    #[test]
    fn robots_are_found_by_name_its_start_or_part_of_it() {
        let b = bots();
        assert_eq!(find(&b, "bolt").unwrap().0, "2");
        assert_eq!(find(&b, " cap ").unwrap().0, "1");
        assert_eq!(find(&b, "bob").unwrap().0, "3");
        assert!(find(&b, "zed").is_none());
        assert!(find(&b, "").is_some_and(|r| r.0 == "1")); // (as in JS: "" is the start of any name)
    }

    #[test]
    fn the_note_names_the_others_and_the_tools() {
        assert_eq!(note_for(&[]), "");
        let n = note_for(&bots()[1..]);
        assert!(n.starts_with("Other C-Bot robots on this desktop: Bolt (looks after C:\\b), Robo Bob (looks after C:\\c). When the user asks"));
        assert!(n.contains("ask_robot") && n.contains("hand_off_task"));
    }

    #[test]
    fn the_asked_robot_reads_who_asks_and_how_to_answer() {
        let m = message_text("Captain", "C:\\a", "Where's the config?");
        assert!(m.starts_with("📨 Message from Captain, another C-Bot robot (it looks after C:\\a), on the user's behalf:\n\nWhere's the config?\n\nReply to Captain directly"));
        let t = task_text("Captain", "C:\\a", "Add /orders", "A GET endpoint.");
        assert!(
            t.starts_with("📋 Task from Captain: Add /orders\n\nCaptain is another C-Bot robot")
        );
        assert!(t.contains("\n\nA GET endpoint.\n\nDo the work here"));
    }

    #[test]
    fn the_tools_are_the_cbot_ones() {
        assert_eq!(
            tools::allowed(),
            [
                "mcp__cbot__ask_robot",
                "mcp__cbot__list_robots",
                "mcp__cbot__hand_off_task",
                "mcp__cbot__list_words",
                "mcp__cbot__save_words",
                "mcp__cbot__list_notes",
                "mcp__cbot__add_note",
                "mcp__cbot__terminal_read",
                "mcp__cbot__terminal_type",
            ]
        );
    }
}
