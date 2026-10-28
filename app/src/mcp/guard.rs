//! The edit guard: Claude Code's PreToolUse hook, run before one of its tabs changes a file, as
//! `c-bot.exe --tab-guard <that conversation's --mcp-config file>` (link.rs writes the --settings
//! that say so). It asks the running C-Bot, over the tools' socket (with the way there and the
//! token from that config), whether another of the robot's tabs is changing the same file right
//! now (features/chat/tabs.rs guard). If so it says no, with why, so Claude waits for that tab
//! (wait_for_tab) instead of changing the file under it. Anything amiss lets the change go: the
//! guard never holds work up because C-Bot didn't answer.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::{Value, json};

use super::{server, tools};

pub const FLAG: &str = "--tab-guard";

/// The tools that change a file (what the hook is set to run for).
pub const MATCHER: &str = "Edit|MultiEdit|Write|NotebookEdit";

/// `c-bot.exe --tab-guard <config>`: read the hook's input, answer, and go. None when it's an
/// ordinary launch.
pub fn run_if_asked() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == FLAG)?;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    if let Some(out) = args.get(at + 1).and_then(|cfg| answer(cfg, &input)) {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "{out}").and_then(|_| stdout.flush());
    }
    Some(0)
}

/// What the hook says (a "no", as Claude Code reads it), or nothing (go ahead).
fn answer(config: &str, input: &str) -> Option<String> {
    let hook: Value = serde_json::from_str(input.trim().trim_start_matches('\u{feff}')).ok()?;
    let file = file_of(&hook)?;
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()?;
    let request = request_for(&cfg, &file)?;
    let port = cfg["mcpServers"]["cbot"]["args"][2].as_str()?;
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut sock = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let reply = server::exchange(&mut sock, &request);
    let why = reply["text"].as_str().filter(|t| !t.is_empty())?;
    (reply["isError"] != true).then(|| deny(why).to_string())
}

/// The file it's about to change, as the hook's input names it.
fn file_of(hook: &Value) -> Option<String> {
    let input = &hook["tool_input"];
    input["file_path"]
        .as_str()
        .or(input["notebook_path"].as_str())
        .filter(|f| !f.is_empty())
        .map(str::to_string)
}

/// The question for the app, from the conversation's --mcp-config (its tools server's args are
/// [--robots-mcp, robot id, port, tab id]; its token is in that server's env).
fn request_for(cfg: &Value, file: &str) -> Option<Value> {
    let server = &cfg["mcpServers"]["cbot"];
    let arg = |i: usize| server["args"][i].as_str();
    Some(json!({
        "token": server["env"]["CBOT_TOKEN"].as_str()?,
        "from": arg(1)?,
        "tab": arg(3)?,
        "tool": tools::tabs::GUARD,
        "args": { "file": file },
    }))
}

/// "No", with why, as Claude Code's PreToolUse hook says it.
fn deny(why: &str) -> Value {
    json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": why,
    } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_comes_from_the_tools_input() {
        let edit = json!({ "tool_name": "Edit", "tool_input": { "file_path": "C:\\p\\a.rs", "old_string": "x" } });
        assert_eq!(file_of(&edit).as_deref(), Some("C:\\p\\a.rs"));
        let nb = json!({ "tool_name": "NotebookEdit", "tool_input": { "notebook_path": "C:\\p\\n.ipynb" } });
        assert_eq!(file_of(&nb).as_deref(), Some("C:\\p\\n.ipynb"));
        assert_eq!(file_of(&json!({ "tool_input": {} })), None);
    }

    #[test]
    fn it_asks_as_the_conversation_its_config_is_for() {
        let cfg = json!({ "mcpServers": { "cbot": {
            "command": "c-bot.exe",
            "args": [server::FLAG, "robot-1", "5300", "tab-9"],
            "env": { "CBOT_TOKEN": "secret" },
        } } });
        assert_eq!(
            request_for(&cfg, "C:\\p\\a.rs"),
            Some(
                json!({ "token": "secret", "from": "robot-1", "tab": "tab-9", "tool": "edit_guard", "args": { "file": "C:\\p\\a.rs" } })
            )
        );
        assert_eq!(request_for(&json!({}), "a.rs"), None);
    }

    #[test]
    fn no_is_said_the_way_claude_code_reads_it() {
        assert_eq!(
            deny("busy"),
            json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "busy" } })
        );
    }

    #[test]
    fn anything_amiss_lets_the_change_go() {
        assert_eq!(
            answer(
                "no-such-config.json",
                "{\"tool_input\":{\"file_path\":\"a\"}}"
            ),
            None
        );
        assert_eq!(answer("no-such-config.json", "not json"), None);
    }
}
