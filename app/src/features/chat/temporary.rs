//! Temporary chats: tabs that keep nothing (their transcripts go when they close, and they're
//! never among the past conversations).

use super::*;

// ---------------------------------------------------------------- temporary chats

/// Every conversation a temporary chat went through (an edited question branches off a new one).
pub(super) fn sessions_of(tab: &Value) -> Vec<String> {
    let mut all: Vec<String> = tab["tempSessions"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
    if let Some(s) = tab["sessionId"].as_str().filter(|s| !all.iter().any(|a| a == s)) {
        all.push(s.to_string());
    }
    all
}

/// A temporary chat closed: Claude Code's transcripts of it go too (once its process, closed
/// with the tab, has let go of them).
pub fn erase_temporary(app: &AppHandle, id: &str, tab: &Value) {
    let mut sessions = sessions_of(tab);
    sessions.extend(side::sessions_of(tab));
    let folder = with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
    if sessions.is_empty() || folder.is_empty() {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        for s in &sessions {
            transcripts::forget(&folder, s);
        }
    });
}

/// At start: temporary chats left from before (C-Bot quit with them open) go, with their transcripts.
pub fn sweep_temporary(app: &AppHandle) {
    let left: Vec<(String, Value)> = with(app, |st| {
        st.store.list().iter().flat_map(|c| {
            let id = c["id"].as_str().unwrap_or("").to_string();
            c["tabs"].as_array().into_iter().flatten().filter(|t| t["temporary"] == true).map(move |t| (id.clone(), t.clone())).collect::<Vec<_>>()
        }).collect()
    });
    for (id, tab) in left {
        erase_temporary(app, &id, &tab);
        with(app, |st| st.store.remove_tab(&id, tab["id"].as_str().unwrap_or("")));
    }
}

pub fn session(app: &AppHandle, id: &str, session_id: &str) -> Value {
    let folder = with(app, |st| st.store.get(id).and_then(|c| c["folder"].as_str().map(str::to_string))).unwrap_or_default();
    if folder.is_empty() {
        return Value::Null;
    }
    transcripts::read(&folder, session_id, 150).unwrap_or(Value::Null)
}

/// The messages of a past conversation as a tab's history.
pub fn history_of(session: &Value) -> Value {
    let now = crate::store::now_ms();
    let msgs = session["messages"].as_array().into_iter().flatten().map(|m| {
        let mut m = m.clone();
        let at = m["at"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map_or(now, |d| d.timestamp_millis());
        m["at"] = json!(at);
        m
    });
    Value::Array(msgs.collect())
}

/// Open an earlier conversation: in its tab if one already has it, in the current tab if
/// that's empty, otherwise in a new tab.
pub fn resume(app: &AppHandle, id: &str, tab_id: &str, session_id: &str) -> Value {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else { return json!({ "ok": false, "error": "Unknown robot" }) };
    if let Some(owner) = c["tabs"].as_array().into_iter().flatten().find(|t| t["sessionId"] == session_id) {
        with(app, |st| st.store.update(id, patch(vec![("activeTab", owner["id"].clone())])));
        return json!({ "ok": true, "tabId": owner["id"], "already": true });
    }
    let Some(session) = transcripts::read(c["folder"].as_str().unwrap_or(""), session_id, 60) else {
        return json!({ "ok": false, "error": "I couldn't find that conversation any more." });
    };
    let history = history_of(&session);
    let busy = with(app, |st| is_busy(st, id, tab_id));
    let target = with(app, |st| {
        let here = st.store.tab(id, tab_id);
        let reuse = here.is_some_and(|t| t["sessionId"].is_null() && t["history"].as_array().is_none_or(Vec::is_empty)) && !busy;
        let fields = patch(vec![("sessionId", json!(session_id)), ("history", history.clone()), ("title", session["title"].clone())]);
        let target = if reuse {
            let t = st.store.update_tab(id, tab_id, fields);
            st.store.update(id, patch(vec![("activeTab", json!(tab_id))]));
            t
        } else {
            st.store.add_tab(id, fields)
        };
        if target.is_some() {
            st.store.remember_session(id, session_id);
        }
        target
    });
    let Some(target) = target else { return json!({ "ok": false, "error": "Too many tabs open. Close one first." }) };
    crate::robots::send_character(app, id);
    json!({ "ok": true, "tabId": target["id"], "title": session["title"], "total": session["total"] })
}
