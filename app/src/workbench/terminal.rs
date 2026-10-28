//! Full Claude Code in a real terminal window (main terminal.js, main.js openTerminal /
//! closeTerminal): one tab's conversation, in the robot's folder, resumed; while it's open
//! the robot acts out what Claude does there (Mirror follows its transcript).
//! Which tab is open there is kept in State.terminals (robot id -> tab id).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::claude;
use crate::agents::claude::{locate, transcripts};
use crate::features::chat;
use crate::platform::process;
use crate::robots;
use crate::runtime::util::patch;
use crate::runtime::{Error, State, part_or_default, with};
use crate::store::Fields;
use crate::ui::workshop;

const POLL: Duration = Duration::from_millis(700);
const QUIET: Duration = Duration::from_millis(3500); // a few quiet seconds after Claude spoke = its turn is over
const READ_MAX: u64 = 4 * 1024 * 1024;

/// The tab of this robot's that's open in the terminal, if one is.
pub fn tab_of(st: &State, id: &str) -> Option<String> {
    st.terminals.get(id).cloned()
}

// ---------------------------------------------------------------- the terminal window

/// Characters that would break out of cmd.exe quoting.
/// Claude Code's arguments: the conversation resumed, its model and permission mode.
fn claude_args(session_id: &str, model: &str, permission_mode: &str) -> Vec<String> {
    let mode = if permission_mode == "default" {
        ""
    } else {
        permission_mode
    };
    // ids, model names and aliases (opus[1m]) and modes only: a value with anything else in it
    // is left out together with its flag, so Claude Code still starts (on its own default)
    let fits = |v: &str| {
        !v.is_empty()
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.:-[]".contains(c))
    };
    [
        ("--resume", session_id),
        ("--model", model),
        ("--permission-mode", mode),
    ]
    .into_iter()
    .filter(|(_, v)| fits(v))
    .map(|(flag, v)| format!("{flag} {v}"))
    .collect()
}

/// Full Claude Code in a terminal window of its own (platform::process::in_terminal): its
/// Child ends when that window closes.
fn launch(
    claude_path: &str,
    folder: &str,
    session_id: &str,
    model: &str,
    permission_mode: &str,
    title: &str,
) -> std::io::Result<Child> {
    process::in_terminal(
        title,
        folder,
        claude_path,
        &claude_args(session_id, model, permission_mode),
        claude::clean_env(),
    )
}

// ---------------------------------------------------------------- following its transcript

/// What Claude Code is doing in the terminal, from its transcript.
#[derive(Debug, PartialEq)]
pub enum Seen {
    Session(String),
    Prompt,
    Tool { name: String, input: Value },
    Question,
    Text,
    Idle,
}

/// Follows the transcript Claude Code writes while it runs in the terminal (main
/// terminal.js TranscriptMirror).
pub struct Mirror {
    dir: PathBuf,
    session_id: Option<String>,
    since: SystemTime,
    offset: Option<u64>,
    partial: Vec<u8>,
    last_line: Option<Instant>,
    said_idle: bool,
}

impl Mirror {
    pub fn new(dir: PathBuf, session_id: Option<String>, since: SystemTime) -> Mirror {
        Mirror {
            dir,
            session_id,
            since,
            offset: None,
            partial: vec![],
            last_line: None,
            said_idle: true,
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.jsonl"))
    }

    // The terminal either keeps appending to our session or starts a new one (a fresh
    // robot, or /clear in the terminal): follow whichever appeared since launch.
    fn pick_session(&mut self, out: &mut Vec<Seen>) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let since = self
            .since
            .checked_sub(Duration::from_secs(2))
            .unwrap_or(self.since);
        let mut newest: Option<(String, SystemTime)> = None;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            let Ok(meta) = e.metadata() else { continue };
            let (Ok(born), Ok(modified)) = (meta.created(), meta.modified()) else {
                continue;
            };
            if born >= since && newest.as_ref().is_none_or(|(_, m)| modified > *m) {
                newest = Some((id.to_string(), modified));
            }
        }
        if let Some((id, _)) = newest
            && self.session_id.as_deref() != Some(id.as_str())
        {
            self.session_id = Some(id.clone());
            self.offset = Some(0);
            self.partial.clear();
            out.push(Seen::Session(id));
        }
    }

    /// Look again: what happened since the last look.
    pub fn poll(&mut self) -> Vec<Seen> {
        let mut out = vec![];
        self.pick_session(&mut out);
        let Some(id) = self.session_id.clone() else {
            return out;
        };
        let file = self.file(&id);
        let Ok(size) = fs::metadata(&file).map(|m| m.len()) else {
            return out;
        };
        let offset = *self.offset.get_or_insert(size); // an existing conversation: only what happens from now on
        if size > offset {
            let mut buf = vec![0u8; (size - offset).min(READ_MAX) as usize];
            let read = fs::File::open(&file).and_then(|mut f| {
                f.seek(SeekFrom::Start(offset))?;
                f.read(&mut buf)
            });
            if let Ok(n) = read {
                self.offset = Some(offset + n as u64);
                self.partial.extend_from_slice(&buf[..n]);
                // whole lines only: the last, unfinished one waits for the rest
                while let Some(nl) = self.partial.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = self.partial.drain(..=nl).collect();
                    let seen = line_events(&String::from_utf8_lossy(&line));
                    if let Some(seen) = seen {
                        self.last_line = Some(Instant::now());
                        self.said_idle = false;
                        out.extend(seen);
                    }
                }
            }
        }
        if !self.said_idle && self.last_line.is_some_and(|t| t.elapsed() > QUIET) {
            self.said_idle = true;
            out.push(Seen::Idle);
        }
        out
    }
}

/// What one transcript line shows (None: not a line of the conversation itself).
fn line_events(line: &str) -> Option<Vec<Seen>> {
    let o: Value = serde_json::from_str(line.trim()).ok()?;
    let ty = o["type"].as_str().unwrap_or("");
    if o["isSidechain"].as_bool() == Some(true) || (ty != "user" && ty != "assistant") {
        return None;
    }
    let content = &o["message"]["content"];
    if ty == "user" {
        let typed = content.is_string()
            || content
                .as_array()
                .is_some_and(|a| a.iter().any(|b| b["type"] == "text"));
        return Some(if typed { vec![Seen::Prompt] } else { vec![] });
    }
    let mut out = vec![];
    for b in content.as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("tool_use") if b["name"] == "AskUserQuestion" => out.push(Seen::Question),
            Some("tool_use") => out.push(Seen::Tool {
                name: b["name"].as_str().unwrap_or("").to_string(),
                input: b
                    .get("input")
                    .filter(|i| !i.is_null())
                    .cloned()
                    .unwrap_or(json!({})),
            }),
            Some("text") if !b["text"].as_str().unwrap_or("").trim().is_empty() => {
                out.push(Seen::Text)
            }
            _ => {}
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- open and close

/// The terminals open now: robot id -> its mirror's "keep going".
#[derive(Default)]
struct Open {
    running: HashMap<String, Arc<AtomicBool>>,
}

fn open_state<R>(app: &AppHandle, f: impl FnOnce(&mut Open) -> R) -> R {
    part_or_default(app, f)
}

fn tell(app: &AppHandle, id: &str, tab_id: &str, payload: Value) {
    let mut p = payload;
    p["tabId"] = json!(tab_id);
    let _ = app.emit_to(robots::label_of(id), "robot:event", p);
}

/// Open one tab's conversation in real, full Claude Code in a terminal window. While it's
/// open the robot acts out what Claude does there.
fn open_terminal(app: &AppHandle, id: &str, tab_id: &str) -> Value {
    let Some((c, tab, open, busy, settings)) = with(app, |st| {
        let c = st.store.get(id)?.clone();
        let tab = st.store.tab(id, tab_id)?.clone();
        Some((
            c,
            tab,
            st.terminals.get(id).cloned(),
            chat::is_busy(st, id, tab_id),
            st.store.settings().clone(),
        ))
    }) else {
        return json!({ "ok": false, "error": "Unknown conversation" });
    };
    if let Some(open) = open {
        return if open == tab_id {
            json!({ "ok": true, "already": true })
        } else {
            json!({ "ok": false, "error": "Another tab already has the terminal open. Close it first." })
        };
    }
    if busy {
        return json!({ "ok": false, "error": "I'm still answering here. Stop me first, then we can move to the terminal." });
    }
    chat::close(app, id, tab_id); // the terminal takes over this conversation
    let Some(claude_path) = locate::find(settings["claudePath"].as_str().unwrap_or("")) else {
        return json!({ "ok": false, "error": "I can't find the `claude` command." });
    };
    let folder = c.folder().to_string();
    if folder.is_empty() || !Path::new(&folder).exists() {
        return json!({ "ok": false, "error": format!("My folder is missing: {}.", if folder.is_empty() { "(none)" } else { &folder }) });
    }
    let session_id = tab.session_id().unwrap_or("").to_string();
    let title = format!("C-Bot - {}", c["name"].as_str().unwrap_or("Robo"));
    let since = SystemTime::now();
    let mut child = match launch(
        &claude_path.to_string_lossy(),
        &folder,
        &session_id,
        c.model(),
        chat::mode_of(&c, &tab),
        &title,
    ) {
        Ok(child) => child,
        Err(e) => {
            return json!({ "ok": false, "error": format!("I couldn't open a terminal: {e}") });
        }
    };

    let running = Arc::new(AtomicBool::new(true));
    with(app, |st| {
        st.terminals.insert(id.to_string(), tab_id.to_string())
    });
    open_state(app, |o| o.running.insert(id.to_string(), running.clone()));
    // the robot acts out what Claude does there
    let mut mirror = Mirror::new(
        transcripts::project_dir(&folder),
        Some(session_id).filter(|s| !s.is_empty()),
        since,
    );
    let (app2, id2, tab2) = (app.clone(), id.to_string(), tab_id.to_string());
    thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            thread::sleep(POLL);
            for seen in mirror.poll() {
                let say = |kind: &str, extra: Value| {
                    let mut p = json!({ "type": "mirror", "kind": kind });
                    for (k, v) in extra.as_object().into_iter().flatten() {
                        p[k] = v.clone();
                    }
                    tell(&app2, &id2, &tab2, p);
                };
                match seen {
                    Seen::Session(sid) => with(&app2, |st| {
                        st.store
                            .update_tab(&id2, &tab2, patch(vec![("sessionId", json!(sid))]));
                        st.store.remember_session(&id2, &sid);
                    }),
                    Seen::Prompt => say("prompt", json!({})),
                    Seen::Tool { name, input } => say(
                        "tool",
                        json!({ "name": name, "detail": claude::describe_tool(&name, &input) }),
                    ),
                    Seen::Question => say("question", json!({})),
                    Seen::Text => say("text", json!({})),
                    Seen::Idle => say("idle", json!({})),
                }
            }
        }
    });
    // the launcher lives as long as the terminal window: its end is the terminal closing
    let (app3, id3) = (app.clone(), id.to_string());
    thread::spawn(move || {
        let _ = child.wait();
        close_terminal(&app3, &id3);
    });
    tell(
        app,
        id,
        tab_id,
        json!({ "type": "terminal", "state": "opened" }),
    );
    workshop::notify(app);
    json!({ "ok": true })
}

/// The terminal closed: pick the conversation back up so the tab shows what happened there.
fn close_terminal(app: &AppHandle, id: &str) {
    let Some(tab_id) = with(app, |st| st.terminals.remove(id)) else {
        return;
    };
    if let Some(running) = open_state(app, |o| o.running.remove(id)) {
        running.store(false, Ordering::Relaxed);
    }
    let Some((folder, session_id)) = with(app, |st| {
        let c = st.store.get(id)?;
        let tab = st.store.tab(id, &tab_id)?;
        Some((
            c.folder().to_string(),
            tab.session_id().unwrap_or("").to_string(),
        ))
    }) else {
        return;
    };
    if let Some(session) = Some(session_id)
        .filter(|s| !s.is_empty())
        .and_then(|sid| transcripts::read(&folder, &sid, 60))
    {
        let history = chat::history_of(&session);
        with(app, |st| {
            st.store
                .update_tab(id, &tab_id, patch(vec![("history", history)]))
        });
    }
    robots::send_character(app, id);
    tell(
        app,
        id,
        &tab_id,
        json!({ "type": "terminal", "state": "closed" }),
    );
    workshop::notify(app);
}

/// Open that tab's conversation in full Claude Code, in a terminal.
#[tauri::command(async)]
pub fn robot_terminal(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: String,
) -> Result<Value, Error> {
    Ok(open_terminal(&app, &robots::sender(&window)?, &tab_id))
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Open::default()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn command_line(
        claude: &str,
        folder: &str,
        session_id: &str,
        model: &str,
        mode: &str,
        title: &str,
    ) -> String {
        process::terminal_line(title, folder, claude, &claude_args(session_id, model, mode))
    }

    #[test]
    fn the_command_line_opens_claude_in_its_folder_safely() {
        let line = command_line(
            "C:\\Users\\me\\claude.exe",
            "C:\\work\\my \"app\"",
            "0f1e2d3c-aaaa-bbbb-cccc-123456789012",
            "opus",
            "acceptEdits",
            "C-Bot - Bo & co",
        );
        assert_eq!(
            line,
            "/d /s /c \"start \"C-Bot - Bo  co\" /WAIT /D \"C:\\work\\my app\" \"C:\\Users\\me\\claude.exe\" --resume 0f1e2d3c-aaaa-bbbb-cccc-123456789012 --model opus --permission-mode acceptEdits\""
        );
        // the default mode is left out, and a value with anything odd in it goes with its flag
        let line = command_line("claude", "C:\\w", "", "my model; rm", "default", "t");
        assert_eq!(
            line,
            "/d /s /c \"start \"t\" /WAIT /D \"C:\\w\" \"claude\"\""
        );
        let line = command_line("claude", "C:\\w", "s1", "x&y", "plan", "t");
        assert_eq!(
            line,
            "/d /s /c \"start \"t\" /WAIT /D \"C:\\w\" \"claude\" --resume s1 --permission-mode plan\""
        );
        // a model alias with a context size, as Claude Code takes it
        let line = command_line("claude", "C:\\w", "", "opus[1m]", "", "t");
        assert_eq!(
            line,
            "/d /s /c \"start \"t\" /WAIT /D \"C:\\w\" \"claude\" --model opus[1m]\""
        );
    }

    #[test]
    fn transcript_lines_become_what_the_robot_acts_out() {
        assert_eq!(
            line_events(r#"{"type":"user","message":{"content":"hi"}}"#),
            Some(vec![Seen::Prompt])
        );
        assert_eq!(
            line_events(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#
            ),
            Some(vec![])
        );
        let a = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look"},{"type":"tool_use","name":"Read","input":{"file_path":"C:/a/b.rs"}},{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}"#;
        assert_eq!(
            line_events(a),
            Some(vec![
                Seen::Text,
                Seen::Tool {
                    name: "Read".into(),
                    input: json!({ "file_path": "C:/a/b.rs" })
                },
                Seen::Question
            ])
        );
        assert_eq!(
            line_events(
                r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"x"}]}}"#
            ),
            None
        );
        assert_eq!(line_events(r#"{"type":"summary"}"#), None);
        assert_eq!(line_events("not json"), None);
    }

    #[test]
    fn the_mirror_follows_a_new_session_and_says_when_its_quiet() {
        let dir = std::env::temp_dir().join(format!("cbot-mirror-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut m = Mirror::new(dir.clone(), None, SystemTime::now());
        assert!(m.poll().is_empty());
        let sid = "11111111-2222-3333-4444-555555555555";
        let mut f = fs::File::create(dir.join(format!("{sid}.jsonl"))).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":"hello"}}}}"#).unwrap();
        write!(
            f,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","#
        )
        .unwrap(); // (half a line)
        f.flush().unwrap();
        assert_eq!(m.poll(), vec![Seen::Session(sid.into()), Seen::Prompt]);
        writeln!(f, r#""text":"Hi!"}}]}}}}"#).unwrap();
        f.flush().unwrap();
        assert_eq!(m.poll(), vec![Seen::Text]);
        m.last_line = Some(Instant::now() - QUIET - Duration::from_millis(10));
        assert_eq!(m.poll(), vec![Seen::Idle]);
        assert!(m.poll().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
