//! Shells in the robot's folder, in a drawer of its chat (gui/features/workbench/shell/shells.ts): one
//! per tab there, each in a pseudoconsole (ConPTY, via portable-pty), and each belonging to a
//! conversation (the chat tab it was opened in). What they print goes to the page as
//! robot:shell events, what you type comes back with robot_shell_write. They go with their
//! conversation's tab, when the robot sleeps (the page closes them), its window closes or
//! reloads, or the app quits; a job object takes everything started in one (a dev server,
//! say) down with it, even if C-Bot crashes.
//! The conversation's Claude reaches its own shells too, with the terminal_* tools
//! (mcp/server.rs, mcp/link.rs): tool() hands the call to the robot's page, which has the
//! screens (robot:shell-ask), and waits for its answer (robot_shell_reply).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::agents::claude;
use crate::platform::process::Job;
use crate::robots::{ipc, label_of, sender};
use crate::runtime::{Error, part, with};

const READ_BUF: usize = 16 * 1024;
/// The most shells one robot keeps going at once.
const MOST: usize = 8;

/// One of a robot's shells (a tab in its drawer). Its sid is the page's name for it, and
/// tells its events from those of a shell that was there before.
struct Shell {
    robot: String,
    tab: String, // (the conversation it belongs to: its chat tab)
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    _job: Job,
}

#[derive(Default)]
struct Shells {
    open: HashMap<u64, Shell>, // sid -> the shell
    seq: u64,
    asks: HashMap<u64, (String, Sender<Value>)>, // a terminal_* call waiting on a robot's page
    ask_seq: u64,
}

impl Shells {
    /// This robot's shell, if that's whose it is.
    fn of(&mut self, robot: &str, sid: u64) -> Option<&mut Shell> {
        self.open.get_mut(&sid).filter(|sh| sh.robot == robot)
    }

    /// Out of the list: the shells picked.
    fn take(&mut self, pick: impl Fn(u64, &Shell) -> bool) -> Vec<Shell> {
        let sids: Vec<u64> = self
            .open
            .iter()
            .filter(|(s, sh)| pick(**s, sh))
            .map(|(s, _)| *s)
            .collect();
        sids.iter().filter_map(|s| self.open.remove(s)).collect()
    }
}

fn shells<R>(app: &AppHandle, f: impl FnOnce(&mut Shells) -> R) -> R {
    part(app, f)
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Shells::default()));
}

// ---------------------------------------------------------------- starting one

/// A kind of shell: how it's started, and what its tabs are called.
struct Kind {
    exe: PathBuf,
    args: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
    name: String, // (on its tabs: "pwsh 1", "bash 2")
}

/// PowerShell 7 when it's installed, else the Windows PowerShell every Windows has.
fn powershell() -> PathBuf {
    let on_path = std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join("pwsh.exe"))
            .find(|f| f.is_file())
    });
    on_path.unwrap_or_else(|| {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    })
}

/// Git for Windows' bash, if it's installed: next to the git on the PATH (Git\cmd, or
/// Git\mingw64\bin), else where its installer puts it. (Not System32's bash.exe: that's WSL.)
fn git_bash() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![];
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path).filter(|d| d.join("git.exe").is_file()) {
            roots.extend(
                dir.ancestors()
                    .skip(1)
                    .take(2)
                    .map(std::path::Path::to_path_buf),
            );
        }
    }
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(var) {
            roots.push(PathBuf::from(dir).join("Git"));
        }
    }
    {
        roots.push(crate::runtime::paths::local_data().join(r"Programs\Git"));
    }
    roots
        .into_iter()
        .map(|r| r.join(r"bin\bash.exe"))
        .find(|f| f.is_file())
}

/// The kind of shell asked for ("bash": Git Bash; anything else: PowerShell), if there is one.
fn kind(which: &str) -> Option<Kind> {
    if which == "bash" {
        // (a login shell, as Git Bash opens, that stays in the folder: CHERE_INVOKING)
        return git_bash().map(|exe| Kind {
            exe,
            args: &["--login", "-i"],
            env: &[("CHERE_INVOKING", "1"), ("TERM", "xterm-256color")],
            name: "bash".into(),
        });
    }
    let exe = powershell();
    let name = exe
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shell".into());
    Some(Kind {
        exe,
        args: &["-NoLogo"],
        env: &[],
        name,
    })
}

/// The kinds of shell there are here, for the drawer's menu.
#[tauri::command(async)]
pub fn robot_shell_kinds() -> Value {
    let mut list = vec![json!({ "kind": "powershell", "label": "PowerShell" })];
    if git_bash().is_some() {
        list.push(json!({ "kind": "bash", "label": "Git Bash" }));
    }
    Value::Array(list)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(20, 500),
        rows: rows.clamp(4, 300),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// What has come in so far as text: all of it but a character cut off at the end, which
/// waits for the rest of its bytes.
fn take_text(buf: &mut Vec<u8>) -> String {
    let n = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    };
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    buf.drain(..n);
    text
}

fn start(
    app: &AppHandle,
    id: &str,
    tab: &str,
    which: &str,
    cols: u16,
    rows: u16,
) -> Result<(u64, String), Error> {
    if !with(app, |st| st.store.tab(id, tab).is_some()) {
        return Err("That conversation has closed.".into());
    }
    let folder = ipc::folder_of(app, id);
    if folder.is_empty() || !std::path::Path::new(&folder).is_dir() {
        return Err("My folder isn't there, so there's nowhere to open a shell.".into());
    }
    if shells(app, |s| s.open.values().filter(|sh| sh.robot == id).count()) >= MOST {
        return Err(format!("That's {MOST} shells already: close one first.").into());
    }
    let Kind {
        exe,
        args,
        env,
        name,
    } = kind(which).ok_or("Git Bash isn't installed here (it comes with Git for Windows).")?;

    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| format!("Couldn't make a console: {e}"))?;
    let mut cmd = CommandBuilder::new(&exe);
    cmd.args(args);
    cmd.cwd(&folder);
    cmd.env_clear();
    for (k, v) in claude::clean_env() {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Couldn't start {name}: {e}"))?;
    drop(pair.slave);
    let job = Job::new().ok_or("Couldn't make a job object")?;
    if let Some(pid) = child.process_id() {
        job.take(pid);
    }
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let sid = shells(app, |s| {
        s.seq += 1;
        s.open.insert(
            s.seq,
            Shell {
                robot: id.to_string(),
                tab: tab.to_string(),
                master: pair.master,
                writer,
                killer,
                _job: job,
            },
        );
        s.seq
    });
    let label = label_of(id);
    relay(app, label.clone(), sid, reader);
    // it ending by itself (exit): the page hears, and its console goes
    let app2 = app.clone();
    thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let _ = app2.emit_to(
            &label,
            "robot:shell",
            json!({ "sid": sid, "kind": "exit", "code": code }),
        );
        let gone = shells(&app2, |s| s.open.remove(&sid));
        drop(gone); // (outside the lock: closing the console can take a moment)
    });
    Ok((sid, name))
}

/// What it prints, to its page as it prints it (until its console is closed).
fn relay(app: &AppHandle, label: String, sid: u64, mut reader: Box<dyn Read + Send>) {
    let app = app.clone();
    thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_text(&mut pending);
                    if !data.is_empty() {
                        let _ = app.emit_to(
                            &label,
                            "robot:shell",
                            json!({ "sid": sid, "kind": "data", "data": data }),
                        );
                    }
                }
            }
        }
    });
}

/// These end, and all they started (their consoles and jobs close as they go).
fn end(gone: Vec<Shell>) {
    for mut sh in gone {
        let _ = sh.killer.kill();
    }
}

/// The robot's shells end, and all they started.
pub fn close(app: &AppHandle, id: &str) {
    end(shells(app, |s| s.take(|_, sh| sh.robot == id)));
}

/// A conversation's shells end with it.
pub fn close_tab(app: &AppHandle, id: &str, tab: &str) {
    end(shells(app, |s| {
        s.take(|_, sh| sh.robot == id && sh.tab == tab)
    }));
}

pub fn close_all(app: &AppHandle) {
    end(shells(app, |s| s.open.drain().map(|(_, sh)| sh).collect()));
}

// ---------------------------------------------------------------- what the page asks

/// A new shell in the robot's folder (a new tab in its drawer), for one of its conversations:
/// kind "bash" is Git Bash, else PowerShell.
#[tauri::command(async)]
pub fn robot_shell_open(
    app: AppHandle,
    window: WebviewWindow,
    cols: u16,
    rows: u16,
    tab_id: String,
    kind: Option<String>,
) -> Result<Value, Error> {
    let id = sender(&window)?;
    Ok(
        match start(
            &app,
            &id,
            &tab_id,
            kind.as_deref().unwrap_or(""),
            cols,
            rows,
        ) {
            Ok((sid, name)) => json!({ "ok": true, "sid": sid, "shell": name }),
            Err(error) => json!({ "ok": false, "error": error }),
        },
    )
}

#[tauri::command(async)]
pub fn robot_shell_write(
    app: AppHandle,
    window: WebviewWindow,
    sid: u64,
    data: String,
) -> Result<(), Error> {
    let id = sender(&window)?;
    shells(&app, |s| {
        if let Some(sh) = s.of(&id, sid) {
            let _ = sh.writer.write_all(data.as_bytes());
            let _ = sh.writer.flush();
        }
    });
    Ok(())
}

#[tauri::command(async)]
pub fn robot_shell_resize(
    app: AppHandle,
    window: WebviewWindow,
    sid: u64,
    cols: u16,
    rows: u16,
) -> Result<(), Error> {
    let id = sender(&window)?;
    shells(&app, |s| {
        if let Some(sh) = s.of(&id, sid) {
            let _ = sh.master.resize(size(cols, rows));
        }
    });
    Ok(())
}

/// One of its shells ends (no sid: all of them).
#[tauri::command(async)]
pub fn robot_shell_close(
    app: AppHandle,
    window: WebviewWindow,
    sid: Option<u64>,
) -> Result<(), Error> {
    let id = sender(&window)?;
    end(shells(&app, |s| {
        s.take(|s, sh| sh.robot == id && sid.is_none_or(|x| x == s))
    }));
    Ok(())
}

// ---------------------------------------------------------------- its Claude, in its shells

/// What every robot's Claude should know about the terminal in its chat (system prompt).
pub const NOTE: &str = concat!(
    "The user has a terminal for this conversation in C-Bot: shells (PowerShell, or Git Bash: bash on its tab) in your folder, in a drawer of your chat, which they can see. ",
    "When they ask about something in their terminal (an error, a server's output), read it with terminal_read. ",
    "When they want a command run in their terminal, or something that should keep running where they can see it (a dev server, a watcher), use terminal_run (new_shell for long-running ones); ",
    "to hand them a command to run themselves, type it with terminal_type. ",
    "Write commands for the shell they go to; ask for shell_type bash when the user wants Git Bash or the command is bash."
);

const SLACK: Duration = Duration::from_secs(20); // (the page's own time to answer, beyond the wait asked for)

/// A terminal_* call from robot `robot`'s conversation `tab`: its page does it, with its
/// shells for that conversation, and says how it went ({ text, isError }).
pub fn tool(app: &AppHandle, robot: &str, tab: &str, tool: &str, args: &Value) -> Value {
    let err = |text: &str| json!({ "text": text, "isError": true });
    if tab.is_empty() {
        return err(
            "This conversation started before C-Bot gave it a terminal. Start a new conversation (or ask again after /clear) to use it.",
        );
    }
    if !with(app, |st| st.store.tab(robot, tab).is_some()) {
        return err("This conversation has closed.");
    }
    let label = label_of(robot);
    if app.get_webview_window(&label).is_none() {
        return err("My window is closed, so there's no terminal.");
    }
    let wait = if tool == "terminal_run" {
        args["wait"]
            .as_f64()
            .filter(|w| w.is_finite())
            .unwrap_or(15.0)
            .clamp(1.0, 300.0)
    } else {
        0.0
    };
    let (tx, rx) = mpsc::channel();
    let req = shells(app, |s| {
        s.ask_seq += 1;
        s.asks.insert(s.ask_seq, (robot.to_string(), tx));
        s.ask_seq
    });
    let _ = app.emit_to(
        &label,
        "robot:shell-ask",
        json!({ "req": req, "tool": tool, "tab": tab, "args": args, "wait": wait }),
    );
    let answer = rx
        .recv_timeout(Duration::from_secs_f64(wait) + SLACK)
        .unwrap_or_else(|_| err("The terminal didn't answer in time."));
    shells(app, |s| s.asks.remove(&req));
    answer
}

/// The page's answer to a terminal_* call (only the robot it went to can answer it).
#[tauri::command(async)]
pub fn robot_shell_reply(
    app: AppHandle,
    window: WebviewWindow,
    req: u64,
    answer: Value,
) -> Result<(), Error> {
    let id = sender(&window)?;
    shells(&app, |s| {
        if let Some((_, tx)) = s.asks.get(&req).filter(|(robot, _)| *robot == id) {
            let _ = tx.send(answer);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_cut_in_two_waits_for_the_rest() {
        let mut buf = "ok ✓".as_bytes().to_vec();
        let last = buf.pop().unwrap();
        assert_eq!(take_text(&mut buf), "ok ");
        buf.push(last);
        assert_eq!(take_text(&mut buf), "✓");
        assert!(buf.is_empty());
    }

    #[test]
    fn powershell_runs_in_the_folder_and_ends_with_its_job() {
        // (pieced together, so the echo of the line typed doesn't count as the answer)
        round_trip(
            "powershell",
            b"'cbot-' + 'ok:' + (Split-Path -Leaf (Get-Location))\r",
            "cbot-ok:",
        );
    }

    #[test]
    fn git_bash_does_too_where_there_is_one() {
        if git_bash().is_none() {
            return; // (no Git for Windows here)
        }
        round_trip(
            "bash",
            b"echo cbot-$((40+2)):$(basename \"$PWD\")\r",
            "cbot-42:",
        );
    }

    /// A shell of that kind, started as the drawer starts one, in a folder of its own: what's
    /// typed in it answers `want` followed by the folder's name.
    fn round_trip(which: &str, typed: &[u8], want: &str) {
        let dir =
            std::env::temp_dir().join(format!("cbot-shell-test-{which}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let k = kind(which).unwrap();
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new(&k.exe);
        cmd.args(k.args);
        cmd.cwd(&dir);
        for (key, v) in k.env {
            cmd.env(key, v);
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let job = Job::new().unwrap();
        job.take(child.process_id().unwrap());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut buf, mut all) = (vec![0u8; READ_BUF], Vec::new());
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                all.extend_from_slice(&buf[..n]);
                let _ = tx.send(take_text(&mut all));
            }
        });
        // (the console first asks where the cursor is, as xterm.js answers in the drawer)
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        while !seen.contains("\x1b[6n") {
            assert!(
                std::time::Instant::now() < until,
                "the console never asked: {seen:?}"
            );
            seen.push_str(
                &rx.recv_timeout(std::time::Duration::from_secs(20))
                    .unwrap_or_default(),
            );
        }
        writer.write_all(b"\x1b[1;1R").unwrap();
        writer.write_all(typed).unwrap();
        let want = format!("{want}{}", dir.file_name().unwrap().to_string_lossy());
        while !seen.contains(&want) {
            assert!(
                std::time::Instant::now() < until,
                "no answer from the shell: {seen:?}"
            );
            if let Ok(t) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                seen.push_str(&t);
            }
        }
        drop(job); // (closing the job ends the shell: wait() comes back)
        child.wait().unwrap();
        drop(pair.master);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
