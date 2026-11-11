//! Claude in Chrome (Claude Code's browser extension). Claude Code turns it on by itself only in
//! its own terminal, when you've set it on by default there (/chrome); run as `claude -p`, as the
//! robots' chats are, it needs --chrome. So their chats get it when your Claude Code has it on.

use std::path::Path;

use serde_json::Value;

/// The flag that turns it on for a conversation.
pub const FLAG: &str = "--chrome";

/// Has the user turned Claude in Chrome on by default in their Claude Code (~/.claude.json)?
pub fn on(home: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else {
        return false;
    };
    serde_json::from_str::<Value>(&text).is_ok_and(|v| on_in(&v))
}

fn on_in(user: &Value) -> bool {
    user["claudeInChromeDefaultEnabled"] == true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn it_follows_the_users_own_claude_code() {
        assert!(on_in(&json!({ "claudeInChromeDefaultEnabled": true })));
        assert!(!on_in(&json!({ "claudeInChromeDefaultEnabled": false })));
        assert!(!on_in(&json!({ "numStartups": 3 })));
    }

    #[test]
    fn no_settings_file_is_off() {
        assert!(!on(Path::new("C:\\no\\such\\home")));
    }
}
