//! A live Claude Code conversation for one tab (src/main/claude.js ClaudeSession): one
//! `claude -p` process that stays open and takes question after question over
//! stream-json. Questions sent while it works wait their turn.
//!
//! What happens is reported to the session's handler as an agents::Event (agents/event.rs),
//! the same as any agent's; what Claude Code writes is read in protocol.rs.

mod lines;
pub mod locate;
mod login;
mod protocol;
mod session;
mod steps;
mod stream;
pub mod transcripts;

pub use login::*;
pub use steps::*;

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

use super::Event;
use super::reports::*;
use crate::platform::process;
use crate::platform::process::NoWindow;
use crate::runtime::{Error, Locked};

/// When C-Bot itself was started from inside a Claude Code session, it inherits that
/// session's private markers. Passed on, they make every robot's `claude` think it's a
/// helper of that session (e.g. CLAUDE_CODE_CHILD_SESSION turns off transcript saving).
/// Drop them; genuine user settings such as CLAUDE_CODE_GIT_BASH_PATH are kept.
fn host_session_var() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
            "(?i)^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\\w*|CLAUDE_AGENT_SDK_\\w*|MCP_SERVER_CONNECTION_BATCH_SIZE|MCP_CONNECTION_NONBLOCKING",
            "|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|SESSION_ATTENDED|ENTRYPOINT\\w*|EXECPATH|DESKTOP_APP_VERSION",
            "|TERMINAL_MCP_TOOLS|REPORT_FINDINGS|EAGER_FLUSH|DISABLE_TERMINAL_TITLE|DISABLE_CRON|STARTUP_FAILURE_RESULTS|SIMPLE",
            "|OAUTH_SCOPES|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|MESSAGING_\\w*|EMIT_\\w*|SDK_\\w*|ENABLE_SDK_\\w*|ENABLE_ASK_USER_QUESTION_TOOL))$",
        ))
        .expect("a valid regex")
    });
    &RE
}

pub fn clean_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| !host_session_var().is_match(k))
        .collect()
}

/// Ends a child process and everything it started, from any thread, but only while it's still
/// running. The thread waiting on it calls gone() as soon as it has exited, before it drops
/// the Child: the process stays held until then, so its id can't have gone to another program,
/// and a kill that's under way keeps it held until it's done.
#[derive(Clone)]
pub struct Killer {
    pid: u32,
    gone: Arc<Mutex<bool>>,
}

impl Killer {
    pub fn new(pid: u32) -> Killer {
        Killer {
            pid,
            gone: Arc::new(Mutex::new(false)),
        }
    }

    /// End it, unless it has exited already.
    pub fn kill(&self) {
        let gone = self.gone.locked();
        if !*gone {
            process::kill_tree(self.pid);
        }
    }

    /// It has exited (call it before dropping the Child).
    pub fn gone(&self) {
        *self.gone.locked() = true;
    }
}

// ---------------------------------------------------------------- the session

/// Talks to the real Claude Code (it uses your account): `cargo test -- --ignored`.
#[cfg(test)]
mod live_tests {
    use super::*;

    #[test]
    #[ignore]
    fn asks_and_hears_back() {
        let claude = crate::agents::claude::locate::find("").expect("Claude Code installed");
        let dir = std::env::temp_dir().join("cbot-session-test");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let handler: Handler = Arc::new(move |_, event: Event| {
            let _ = tx.locked().send((event.name().to_string(), event.data()));
        });
        let opts = Opts {
            claude_path: claude,
            cwd: dir.to_string_lossy().into(),
            model: "haiku".into(),
            ..Default::default()
        };
        let session = Session::new(opts, None, handler);
        assert!(!session.ask("Reply with exactly the word: pong".into(), "t1".into()));
        let mut seen = vec![];
        let done = loop {
            let (event, data) = rx
                .recv_timeout(Duration::from_secs(120))
                .expect("an answer in time");
            seen.push(event.clone());
            match event.as_str() {
                "done" => break data,
                "fail" => panic!("failed: {data}"),
                _ => {}
            }
        };
        assert_eq!(done["turnId"], "t1");
        assert!(
            done["text"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains("pong"),
            "{done}"
        );
        assert!(
            seen.contains(&"turn-start".to_string())
                && seen.contains(&"text".to_string())
                && seen.contains(&"session".to_string()),
            "{seen:?}"
        );
        let usage = session.context_usage().expect("context usage");
        assert!(
            usage["totalTokens"].as_f64().unwrap_or(0.0) > 0.0,
            "{usage}"
        );
        session.close();
    }

    #[test]
    #[ignore]
    fn a_plan_waits_for_the_go_ahead_then_gets_built() {
        let claude = crate::agents::claude::locate::find("").expect("Claude Code installed");
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("cbot-plan-test"); // (not under a short 8.3 temp path: Claude Code asks before writing there)
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let handler: Handler = Arc::new(move |_, event: Event| {
            let _ = tx.locked().send((event.name().to_string(), event.data()));
        });
        let opts = Opts {
            claude_path: claude,
            cwd: dir.to_string_lossy().into(),
            model: "haiku".into(),
            permission_mode: "plan".into(),
            ..Default::default()
        };
        let session = Session::new(opts, None, handler);
        session.ask("Plan creating hello.txt containing the word hi, in a 1-line plan, and present it with ExitPlanMode.".into(), "t1".into());
        let next = |want: &str| loop {
            let (event, data) = rx
                .recv_timeout(Duration::from_secs(180))
                .unwrap_or_else(|_| panic!("{want} in time"));
            if event == want {
                break data;
            }
            assert!(
                event != "done" && event != "fail",
                "{event} before {want}: {data}"
            );
        };
        // first time round: sent back with notes, nothing written
        let plan = next("plan");
        assert!(!plan["plan"].as_str().unwrap_or("").is_empty(), "{plan}");
        assert!(
            !dir.join("hello.txt").exists(),
            "wrote before the plan was approved"
        );
        assert!(session.decide_plan(
            plan["requestId"].as_str().unwrap(),
            None,
            "Make it say hello instead of hi."
        ));
        // second time: approved, and it builds it
        let plan = next("plan");
        assert!(
            plan["plan"].as_str().unwrap_or("").contains("hello"),
            "{plan}"
        );
        assert!(session.decide_plan(plan["requestId"].as_str().unwrap(), Some("acceptEdits"), ""));
        assert!(
            !session.decide_plan(plan["requestId"].as_str().unwrap(), Some("acceptEdits"), ""),
            "decided twice"
        );
        let done = next("done");
        assert!(
            std::fs::read_to_string(dir.join("hello.txt"))
                .unwrap_or_default()
                .contains("hello"),
            "{done}"
        );
        session.close();
    }

    #[test]
    #[ignore]
    fn the_to_do_list_comes_through() {
        let claude = crate::agents::claude::locate::find("").expect("Claude Code installed");
        let dir = std::env::temp_dir().join("cbot-todo-test");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let handler: Handler = Arc::new(move |_, event: Event| {
            let _ = tx.locked().send((event.name().to_string(), event.data()));
        });
        // (tools known: the session asks for the to-do ones with them, as after a first start)
        let opts = Opts {
            claude_path: claude,
            cwd: dir.to_string_lossy().into(),
            model: "haiku".into(),
            tools: Some(vec!["Read".into()]),
            ..Default::default()
        };
        let session = Session::new(opts, None, handler);
        session.ask("Make a to-do list with your to-do tool: one item, \"Write notes\". Then mark it done. Then reply: ok.".into(), "t1".into());
        let mut tasks = vec![];
        loop {
            let (event, data) = rx
                .recv_timeout(Duration::from_secs(120))
                .expect("an answer in time");
            match event.as_str() {
                "task" => tasks.push(data),
                "done" => break,
                "fail" => panic!("failed: {data}"),
                _ => {}
            }
        }
        assert!(!tasks.is_empty(), "no to-do list came");
        let last = tasks.last().unwrap();
        assert!(
            last["tasks"]
                .as_array()
                .is_some_and(|t| t.iter().any(|x| x["status"] == "completed")),
            "{tasks:?}"
        );
        session.close();
    }

    #[test]
    #[ignore]
    fn remote_control_comes_on_and_survives_a_restart() {
        let claude = crate::agents::claude::locate::find("").expect("Claude Code installed");
        let dir = std::env::temp_dir().join("cbot-session-test");
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let handler: Handler = Arc::new(move |_, event: Event| {
            let _ = tx.locked().send((event.name().to_string(), event.data()));
        });
        let remote = |rx: &mpsc::Receiver<(String, Value)>| loop {
            let (event, data) = rx
                .recv_timeout(Duration::from_secs(60))
                .expect("Remote Control in time");
            if event == "remote" {
                break data;
            }
        };
        let opts = Opts {
            claude_path: claude,
            cwd: dir.to_string_lossy().into(),
            model: "haiku".into(),
            ..Default::default()
        };
        let session = Session::new(opts, None, handler);
        session.set_remote(Some("C-Bot test".into()));
        let first = remote(&rx);
        assert_eq!(first["on"], true, "{first}");
        assert!(
            first["url"]
                .as_str()
                .unwrap_or("")
                .starts_with("https://claude.ai/code/"),
            "{first}"
        );
        // a new process (new system prompt) is the same remote session
        session.set_system_prompt("You are terse.");
        assert!(!session.ask("Reply with exactly the word: pong".into(), "t1".into()));
        let again = remote(&rx);
        assert_eq!(again["url"], first["url"], "{again}");
        session.set_remote(None);
        assert_eq!(remote(&rx)["on"], false);
        session.close();
    }
}

// Claude Code's to-do tools, which a session like ours (print mode, stream-json) leaves out
// unless --tools names them: TodoWrite (what 2.1 has), and the Task* ones some versions have
// instead. A name a version doesn't know is left out quietly, so all of them are asked for.
const TASK_TOOLS: [&str; 5] = [
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
];
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
pub struct Opts {
    pub claude_path: PathBuf,
    pub cwd: String,
    pub system_prompt: String,
    pub permission_mode: String,
    pub model: String,
    pub effort: String,
    pub add_dirs: Vec<String>,
    pub tools: Option<Vec<String>>, // Claude Code's default tools, once known (the task tools go with them)
    pub env: Vec<(String, String)>,
    pub mcp_config: String, // an --mcp-config file to add (the other robots' tools, mcp/link.rs)
    pub allowed_tools: Vec<String>, // tools it may use without asking
    pub extra_args: Vec<String>, // more command-line flags (the group chat's --strict-mcp-config)
    pub resume_at: Option<String>, // the next start picks the conversation up after this message, as a new branch (an edited question)
    pub fork: bool, // the next start picks the whole conversation up as a new branch (a side question, features/chat/side.rs)
    pub remote: Option<String>, // Remote Control: on while set, under this name on claude.ai/code and in the Claude app
    pub remote_session: Option<String>, // and the remote session a new process picks up again (so it stays the same one there)
}

pub type Handler = Arc<dyn Fn(&Arc<Session>, Event) + Send + Sync>;
type Reply = Box<dyn FnOnce(Result<Value, Error>) + Send>;

struct Turn {
    id: String,
    interrupted: bool,
    uuid: String,  // (the message we sent for it; none for a turn nobody here asked for)
    started: bool, // (Claude Code is on it: not still waiting behind a message from Remote Control)
}

struct Proc {
    generation: u64,
    killer: Killer,
    stdin: Option<ChildStdin>,
    stderr: Arc<Mutex<String>>,
}

struct Inner {
    opts: Opts,
    session_id: Option<String>,
    queue: VecDeque<(String, String)>, // turns waiting: (id, prompt)
    turn: Option<Turn>,
    displaced: Option<Turn>, // ours, already sent, waiting behind a message from Remote Control
    own_uuids: HashSet<String>, // the messages we sent (any other one came in through Remote Control)
    pending_questions: HashMap<String, Value>, // request id -> the AskUserQuestion input
    pending_plans: HashMap<String, Value>, // request id -> the ExitPlanMode input (the plan, waiting for your go-ahead)
    controls: HashMap<String, Reply>,
    task_inputs: HashMap<String, Value>, // tool_use id -> TaskCreate input, to learn its number
    agent_tools: HashSet<String>,        // tool_use ids of Agent calls (each one is a helper agent)
    agent_tasks: HashMap<String, String>, // background task id -> the Agent tool_use id
    agent_running: HashSet<String>,      // Agent tool_use ids still at work
    // what the conversation it carries on has cost so far, as Claude Code last said (None: not
    // known). Its total_cost_usd is that, plus what it has cost since: a resumed (or branched)
    // conversation starts again from what it had cost, not from 0.
    cost_so_far: Option<f64>,
    last_used: Instant,
    proc: Option<Proc>,
    generation: u64,
    restart_before_next: bool,
    closing: bool,
    text: String,
    asides: AsideFilter,
    streamed: HashSet<String>,
    mcp_tool_ids: HashSet<String>,
    auto_turns: u64,
    last_uuid: Option<String>, // the turn's last message in the transcript (an edited question goes back to here)
    tokens_done: u64,          // output tokens of the turn's finished messages
    tokens_msg: u64,           // and of the one being written
    events: Sender<Event>,
}

pub struct Session {
    inner: Mutex<Inner>,
    me: Weak<Session>,
}
