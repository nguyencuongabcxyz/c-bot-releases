//! Each tab's conversation in a file of its own, `histories/<tab id>.json`, apart from
//! c-bot.json. c-bot.json had grown to tens of MB of conversations, all rewritten (under the
//! app's lock, so every window waited) whenever anything changed; now a save writes the small
//! c-bot.json and only the conversations that changed. In memory a tab still holds its
//! `history`, as the pages and the rest of the app read it.

use super::*;

const DIR: &str = "histories";

/// Only plain ids name files (a hand-edited c-bot.json may hold anything): a tab with
/// another id keeps its conversation in c-bot.json, as before.
fn has_file(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn file_of(dir: &Path, tab_id: &str) -> PathBuf {
    dir.join(DIR).join(format!("{tab_id}.json"))
}

/// Every tab of every robot of yours, open or closed.
pub(super) fn tabs(data: &Value) -> impl Iterator<Item = &Value> {
    data["characters"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| {
            ["tabs", "closedTabs"]
                .into_iter()
                .filter_map(|k| c.get(k)?.as_array())
                .flatten()
        })
}

fn tabs_mut(data: &mut Value) -> Vec<&mut Value> {
    let Some(list) = data["characters"].as_array_mut() else {
        return vec![];
    };
    list.iter_mut()
        .filter_map(Value::as_object_mut)
        .flat_map(|c| {
            c.iter_mut()
                .filter(|(k, _)| *k == "tabs" || *k == "closedTabs")
                .filter_map(|(_, v)| v.as_array_mut())
                .flatten()
        })
        .collect()
}

/// Read each tab's conversation back into it. The tabs that still carry theirs in c-bot.json
/// (saved before conversations had files): saved to files at the next save.
pub(super) fn attach(data: &mut Value, dir: &Path) -> Vec<String> {
    let mut inline = vec![];
    for tab in tabs_mut(data) {
        let id = str_of(tab, "id").to_string();
        let Some(t) = tab.as_object_mut() else {
            continue;
        };
        if t.get("history").is_some_and(Value::is_array) {
            if has_file(&id) {
                inline.push(id);
            }
            continue;
        }
        let history = if has_file(&id) {
            read(&file_of(dir, &id))
        } else {
            vec![]
        };
        t.insert("history".into(), Value::Array(history));
    }
    inline
}

fn read(file: &Path) -> Vec<Value> {
    let Ok(text) = fs::read_to_string(file) else {
        return vec![]; // (none yet: a tab that never talked)
    };
    match serde_json::from_str(&text) {
        Ok(Value::Array(h)) => h,
        _ => {
            log::warn!(
                "{} couldn't be read; that chat starts empty",
                file.display()
            );
            vec![]
        }
    }
}

/// c-bot.json as it's written: everything but the conversations that have files.
pub(super) fn slim(data: &Value) -> Value {
    let robots = |v: &Value| match v.as_array() {
        Some(list) => Value::Array(list.iter().map(slim_robot).collect()),
        None => v.clone(),
    };
    map_fields(data, |k, v| (k == "characters").then(|| robots(v)))
}

fn slim_robot(c: &Value) -> Value {
    let tabs = |v: &Value| match v.as_array() {
        Some(list) => Value::Array(list.iter().map(slim_tab).collect()),
        None => v.clone(),
    };
    map_fields(c, |k, v| {
        (k == "tabs" || k == "closedTabs").then(|| tabs(v))
    })
}

fn slim_tab(t: &Value) -> Value {
    if !has_file(str_of(t, "id")) {
        return t.clone();
    }
    match t.as_object() {
        Some(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| *k != "history")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        None => t.clone(),
    }
}

/// A copy of an object, with some fields given by `swap` instead (the rest cloned as they are).
fn map_fields(v: &Value, swap: impl Fn(&str, &Value) -> Option<Value>) -> Value {
    match v.as_object() {
        Some(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), swap(k, v).unwrap_or_else(|| v.clone())))
                .collect(),
        ),
        None => v.clone(),
    }
}

/// The conversations of these tabs, as their files will hold them.
pub(super) fn texts(data: &Value, ids: &HashSet<String>) -> Vec<(String, String)> {
    tabs(data)
        .filter(|t| ids.contains(str_of(t, "id")) && has_file(str_of(t, "id")))
        .map(|t| {
            let empty = Value::Array(vec![]);
            let h = t.get("history").unwrap_or(&empty);
            (
                str_of(t, "id").to_string(),
                serde_json::to_string(h).unwrap_or_else(|_| "[]".into()),
            )
        })
        .collect()
}

/// Write the conversations that changed.
pub(super) fn write(dir: &Path, texts: &[(String, String)]) {
    if texts.is_empty() {
        return;
    }
    if let Err(err) = fs::create_dir_all(dir.join(DIR)) {
        log::error!("couldn't save the chats: {err}");
        return;
    }
    for (id, text) in texts {
        if let Err(err) = write_safely(&file_of(dir, id), text) {
            log::error!("couldn't save chat {id}: {err}");
        }
    }
}

/// The files of tabs that are gone (closed for good, their robot deleted), deleted.
pub(super) fn tidy(dir: &Path, live: &HashSet<String>) {
    let Ok(files) = fs::read_dir(dir.join(DIR)) else {
        return;
    };
    for e in files.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_suffix(".json.tmp")
            .or_else(|| name.strip_suffix(".json"));
        if id.is_some_and(|id| !live.contains(id)) {
            let _ = fs::remove_file(e.path());
        }
    }
}
