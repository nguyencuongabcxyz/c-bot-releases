//! Named reads of what the store keeps (a robot, one of its tabs, a tab's side thread), over
//! the JSON as it is. The pages own its shape: a field that's missing, or of another type,
//! reads as empty, the way they take it, and nothing about c-bot.json changes.

use serde_json::Value;

pub trait Fields {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// A robot's project folder (where its Claude Code works).
    fn folder(&self) -> &str;
    /// The model picked for it ("": Claude Code's default).
    fn model(&self) -> &str;
    fn effort(&self) -> &str;
    fn personality(&self) -> &str;
    /// A robot out on the desktop (not put away).
    fn visible(&self) -> bool;
    /// The Claude Code conversation it carries on, once it has one.
    fn session_id(&self) -> Option<&str>;
    /// The context engine switched on for a robot (off unless the user turned it on).
    fn context_engine(&self) -> bool;
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

impl Fields for Value {
    fn id(&self) -> &str {
        text(self, "id")
    }
    fn name(&self) -> &str {
        text(self, "name")
    }
    fn folder(&self) -> &str {
        text(self, "folder")
    }
    fn model(&self) -> &str {
        text(self, "model")
    }
    fn effort(&self) -> &str {
        text(self, "effort")
    }
    fn personality(&self) -> &str {
        text(self, "personality")
    }
    fn visible(&self) -> bool {
        self["visible"].as_bool().unwrap_or(false)
    }
    fn session_id(&self) -> Option<&str> {
        self["sessionId"].as_str()
    }
    fn context_engine(&self) -> bool {
        self["contextEngine"].as_bool().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn missing_or_odd_fields_read_as_empty() {
        let c = json!({ "id": "r1", "name": "Bolt", "folder": "C:\\w", "visible": true, "model": null, "sessionId": "s1" });
        assert_eq!((c.id(), c.name(), c.folder()), ("r1", "Bolt", "C:\\w"));
        assert!(c.visible());
        assert_eq!(c.model(), "");
        assert_eq!(c.session_id(), Some("s1"));
        let odd = json!({ "id": 7, "visible": "yes", "contextEngine": "on" });
        assert_eq!(
            (odd.id(), odd.effort(), odd.visible(), odd.session_id()),
            ("", "", false, None)
        );
        assert!(!odd.context_engine() && json!({ "contextEngine": true }).context_engine());
    }
}
