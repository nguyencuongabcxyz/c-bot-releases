//! Bookmarked messages: a question or an answer in a tab's conversation marked to come back to
//! (gui/features/chat/bookmarks). The mark is kept on its history entry (`bookmarked`), found by
//! its `at`, so it goes with the entry: taken out with it when a question is edited, gone when
//! the history is cleared.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::robots;
use crate::runtime::util::patch;
use crate::runtime::with;

/// Bookmark the message at `at` in a tab's history, or take its bookmark off. False: it isn't
/// there (any more).
pub fn set(app: &AppHandle, id: &str, tab_id: &str, at: i64, on: bool) -> bool {
    let done = with(app, |st| {
        let mut history = st.store.tab(id, tab_id)?["history"].as_array()?.clone();
        if !mark(&mut history, at, on) {
            return None;
        }
        st.store
            .update_tab(id, tab_id, patch(vec![("history", Value::Array(history))]))
    });
    if done.is_some() {
        robots::send_character(app, id); // (its other windows' lists follow)
    }
    done.is_some()
}

/// Mark the question or answer at `at` (or unmark it). False: there's none.
fn mark(history: &mut [Value], at: i64, on: bool) -> bool {
    let Some(entry) = history.iter_mut().find(|h| {
        h["at"].as_i64() == Some(at) && matches!(h["role"].as_str(), Some("user" | "assistant"))
    }) else {
        return false;
    };
    let Some(fields) = entry.as_object_mut() else {
        return false;
    };
    if on {
        fields.insert("bookmarked".into(), json!(true));
    } else {
        fields.remove("bookmarked");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> Vec<Value> {
        vec![
            json!({ "role": "user", "text": "why?", "at": 1 }),
            json!({ "role": "assistant", "text": "because", "at": 2 }),
            json!({ "role": "note", "text": "🔨 Bonked!", "at": 3 }),
        ]
    }

    #[test]
    fn a_question_or_an_answer_is_marked_and_unmarked() {
        let mut h = history();
        assert!(mark(&mut h, 2, true));
        assert_eq!(h[1]["bookmarked"], json!(true));
        assert!(mark(&mut h, 1, true));
        assert_eq!(h[0]["bookmarked"], json!(true));
        assert!(mark(&mut h, 2, false));
        assert_eq!(h[1].get("bookmarked"), None);
        assert_eq!(h[0]["bookmarked"], json!(true));
    }

    #[test]
    fn only_messages_that_are_there_are_marked() {
        let mut h = history();
        assert!(!mark(&mut h, 3, true)); // (a note isn't a message)
        assert!(!mark(&mut h, 99, true));
        assert_eq!(h, history());
    }
}
