//! Saved chats: conversations starred to come back to (the ☆ on a tab, Ctrl+S, /save), kept
//! in the robot's `saved` list under the name and emoji you gave them. Saving is a bookmark:
//! opening one resumes its conversation where it left off ("Clear history" leaves it be).

use super::*;
use serde::Deserialize;
use std::collections::HashSet;
use tauri::WebviewWindow;

use crate::robots::{self, sender};
use crate::runtime::Error;

const MAX_SAVED: usize = 50;
const NAME_LEN: usize = 60;

/// A conversation to save (again: a new name or emoji for one already saved): a tab's, or one
/// from "Past chats". No name: the one it has, the tab's own, or its conversation's title.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChat {
    tab_id: Option<String>,
    session_id: Option<String>,
    name: Option<String>,
    emoji: Option<String>,
}

/// The robot's saved chats, most recently saved first, each with how its conversation is now.
#[tauri::command(async)]
pub fn robot_saved(app: AppHandle, window: WebviewWindow) -> Result<Value, Error> {
    Ok(saved_chats(&app, &sender(&window)?))
}

/// Save a conversation, or rename one already saved. The saved chats, as `robot_saved`.
#[tauri::command(async)]
pub fn robot_save(app: AppHandle, window: WebviewWindow, chat: SaveChat) -> Result<Value, Error> {
    let id = sender(&window)?;
    let tab = match &chat.tab_id {
        Some(tab_id) => Some(tab_of(&app, &id, tab_id)?),
        None => None,
    };
    let session_id = match &tab {
        Some(tab) => tab.session_id().unwrap_or("").to_string(),
        None => chat.session_id.clone().unwrap_or_default(),
    };
    if !is_session_id(&session_id) {
        return Err("That chat hasn't started yet: ask something first.".into());
    }
    let name = match chat.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => default_name(&app, &id, tab.as_ref(), &session_id),
    };
    let entry = json!({
        "id": session_id,
        "name": name_of(&name),
        "emoji": chat.emoji.as_deref().map(emoji_of).unwrap_or_default(),
        "savedAt": crate::store::now_ms(),
    });
    let full = with(&app, |st| {
        let list = saved_of(st.store.get(&id)?);
        if list.len() >= MAX_SAVED && !list.iter().any(|s| s["id"] == entry["id"]) {
            return Some(false);
        }
        st.store
            .update(&id, patch(vec![("saved", json!(upsert(list, entry)))]));
        Some(true)
    });
    match full {
        None => return Err("Unknown robot".into()),
        Some(false) => {
            return Err(
                format!("That's {MAX_SAVED} saved chats already: unsave one first.").into(),
            );
        }
        Some(true) => {}
    }
    robots::send_character(&app, &id);
    Ok(saved_chats(&app, &id))
}

/// Unsave a conversation (it stays in "Past chats"). The saved chats, as `robot_saved`.
#[tauri::command(async)]
pub fn robot_unsave(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<Value, Error> {
    let id = sender(&window)?;
    unsave(&app, &id, &[session_id]);
    robots::send_character(&app, &id);
    Ok(saved_chats(&app, &id))
}

/// The tab as it is now (the page may not have heard its conversation's session id yet).
fn tab_of(app: &AppHandle, id: &str, tab_id: &str) -> Result<Value, Error> {
    let Some(tab) = with(app, |st| st.store.tab(id, tab_id).cloned()) else {
        return Err("That tab has closed.".into());
    };
    if tab["temporary"] == true {
        return Err("A temporary chat isn't kept, so it can't be saved.".into());
    }
    Ok(tab)
}

/// A name for one saved without one: the name it has, the name you gave its tab, or the title
/// of its conversation (the tab's own is cut short).
fn default_name(app: &AppHandle, id: &str, tab: Option<&Value>, session_id: &str) -> String {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return String::new();
    };
    let named = |v: &Value| {
        v.as_str()
            .filter(|n| !n.trim().is_empty())
            .map(str::to_string)
    };
    saved_of(&c)
        .iter()
        .find(|s| s["id"] == session_id)
        .and_then(|s| named(&s["name"]))
        .or_else(|| tab.and_then(|t| named(&t["title"])))
        .or_else(|| transcripts::read(c.folder(), session_id, 0).and_then(|t| named(&t["title"])))
        .unwrap_or_default()
}

/// These conversations aren't saved any more (thrown away from "Past chats").
pub(super) fn unsave(app: &AppHandle, id: &str, session_ids: &[String]) {
    with(app, |st| {
        let Some(c) = st.store.get(id) else { return };
        let list = saved_of(c);
        let kept: Vec<Value> = list
            .iter()
            .filter(|s| !session_ids.iter().any(|g| s["id"] == g.as_str()))
            .cloned()
            .collect();
        if kept.len() != list.len() {
            st.store.update(id, patch(vec![("saved", json!(kept))]));
        }
    });
}

/// The saved conversations' ids, which "Clear history" keeps.
pub(super) fn saved_ids(c: &Value) -> HashSet<String> {
    saved_of(c)
        .iter()
        .filter_map(|s| s["id"].as_str().map(str::to_string))
        .collect()
}

fn saved_chats(app: &AppHandle, id: &str) -> Value {
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return json!([]);
    };
    let list = saved_of(&c);
    if list.is_empty() || c.folder().is_empty() {
        return json!(list);
    }
    let open: HashMap<String, Value> = c["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["temporary"] != true)
        .filter_map(|t| Some((t.session_id()?.to_string(), t["id"].clone())))
        .collect();
    let active = c["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"] == c["activeTab"])
        .and_then(|t| t.session_id())
        .map(str::to_string);
    // (every transcript, not the newest few: a saved one can be old. Read once, then cached)
    let rows: HashMap<String, Value> = transcripts::list(c.folder(), &[], usize::MAX)
        .into_iter()
        .filter_map(|r| Some((r["id"].as_str()?.to_string(), r)))
        .collect();
    let out = list.into_iter().map(|mut s| {
        let sid = s["id"].as_str().unwrap_or("").to_string();
        let row = rows.get(&sid);
        s["title"] = row.map_or(Value::Null, |r| r["title"].clone());
        s["updatedAt"] = row.map_or(Value::Null, |r| r["updatedAt"].clone());
        s["messages"] = row.map_or(Value::Null, |r| r["messages"].clone());
        s["gone"] = json!(row.is_none());
        s["tabId"] = open.get(&sid).cloned().unwrap_or(Value::Null);
        s["current"] = json!(active.as_deref() == Some(sid.as_str()));
        s
    });
    Value::Array(out.collect())
}

fn saved_of(c: &Value) -> Vec<Value> {
    c["saved"].as_array().cloned().unwrap_or_default()
}

/// The list with this one first (saved again: its old entry goes, its first `savedAt` stays).
fn upsert(list: Vec<Value>, mut entry: Value) -> Vec<Value> {
    let (old, mut rest): (Vec<Value>, Vec<Value>) =
        list.into_iter().partition(|s| s["id"] == entry["id"]);
    if let Some(old) = old.first() {
        entry["savedAt"] = old["savedAt"].clone();
        // (renamed: it keeps its place, so Alt+1…9 still open the same ones)
        let at = rest
            .iter()
            .position(|s| s["savedAt"].as_f64() < old["savedAt"].as_f64())
            .unwrap_or(rest.len());
        rest.insert(at, entry);
        return rest;
    }
    rest.insert(0, entry);
    rest
}

fn name_of(raw: &str) -> String {
    let name: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NAME_LEN)
        .collect();
    if name.is_empty() {
        "Saved chat".into()
    } else {
        name
    }
}

/// One emoji (a few chars: some are several code points), or none.
fn emoji_of(raw: &str) -> String {
    raw.trim().chars().take(8).collect()
}

fn is_session_id(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaa-0000-0000-0000-000000000000";
    const B: &str = "bbbbbbbb-0000-0000-0000-000000000000";

    fn entry(id: &str, name: &str, at: u64) -> Value {
        json!({ "id": id, "name": name, "emoji": "", "savedAt": at })
    }

    #[test]
    fn a_new_save_goes_first() {
        let list = upsert(vec![entry(A, "a", 1)], entry(B, "b", 2));
        assert_eq!(list, vec![entry(B, "b", 2), entry(A, "a", 1)]);
    }

    #[test]
    fn saving_again_renames_it_in_its_place() {
        let list = vec![entry(B, "b", 2), entry(A, "a", 1)];
        let list = upsert(list, entry(B, "renamed", 9));
        assert_eq!(list, vec![entry(B, "renamed", 2), entry(A, "a", 1)]);
        let list = upsert(list, entry(A, "also", 9));
        assert_eq!(list, vec![entry(B, "renamed", 2), entry(A, "also", 1)]);
    }

    #[test]
    fn names_are_one_tidy_line() {
        assert_eq!(name_of("  Cart\n price   fix "), "Cart price fix");
        assert_eq!(name_of("   "), "Saved chat");
        assert_eq!(name_of(&"x".repeat(80)).chars().count(), NAME_LEN);
    }

    #[test]
    fn only_claude_code_session_ids_are_saved() {
        assert!(is_session_id(A));
        assert!(!is_session_id(""));
        assert!(!is_session_id("../../../../etc/passwd-0000-0000-0000"));
    }

    #[test]
    fn saved_ids_reads_the_robots_list() {
        let c = json!({ "saved": [entry(A, "a", 1), { "name": "no id" }] });
        assert_eq!(saved_ids(&c), HashSet::from([A.to_string()]));
        assert!(saved_ids(&json!({})).is_empty());
    }
}
