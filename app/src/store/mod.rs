//! The robots and settings: one JSON file, c-bot.json, as the Electron app keeps it
//! (src/main/store.js), so the two read each other's.
//!
//! Saving is power-cut safe: write a temp file, force it to disk, then swap it in.
//! A file that can't be read is never overwritten with an empty store: it's set aside
//! and the robots come back from the temp file or the newest daily backup.
//! Characters stay plain JSON objects: the pages read and write fields this side
//! never needs to know about.

pub mod saved;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

const HISTORY_LIMIT: usize = 60;
pub const MAX_TABS: usize = 8;
const CLOSED_TABS_KEPT: usize = 10; // per robot, for "reopen closed tab"
const BACKUPS_KEPT: usize = 14; // one a day
const SAVE_DELAY: Duration = Duration::from_millis(300); // changes close together are saved once

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn new_tab(fields: Map<String, Value>) -> Value {
    let mut tab = json!({ "id": uuid::Uuid::new_v4().to_string(), "title": "", "sessionId": null, "history": [], "createdAt": now_ms() });
    tab.as_object_mut().unwrap().extend(fields);
    tab
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A tab's name: what the user called it, or its first question.
pub fn title_for(tab: &Value) -> String {
    let title = str_of(tab, "title");
    if !title.is_empty() {
        return title.to_string();
    }
    let first = tab
        .get("history")
        .and_then(Value::as_array)
        .and_then(|h| h.iter().find(|e| str_of(e, "role") == "user"))
        .map(|e| str_of(e, "text"))
        .unwrap_or("");
    let t = first.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        "New chat".into()
    } else if t.chars().count() > 28 {
        format!("{}…", t.chars().take(27).collect::<String>())
    } else {
        t
    }
}

/// Robots used to have a single conversation; it becomes their first tab.
fn migrate(c: &mut Value) {
    let o = c.as_object_mut().unwrap();
    if !o
        .get("tabs")
        .and_then(Value::as_array)
        .is_some_and(|t| !t.is_empty())
    {
        let mut fields = Map::new();
        fields.insert(
            "sessionId".into(),
            o.get("sessionId").cloned().unwrap_or(Value::Null),
        );
        fields.insert(
            "history".into(),
            o.get("history")
                .cloned()
                .filter(Value::is_array)
                .unwrap_or(json!([])),
        );
        o.insert("tabs".into(), json!([new_tab(fields)]));
    }
    let active = o
        .get("activeTab")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tabs = o["tabs"].as_array().unwrap();
    if !tabs.iter().any(|t| str_of(t, "id") == active) {
        let first = tabs[0]["id"].clone();
        o.insert("activeTab".into(), first);
    }
    // (the Electron app also turned Claude Code's old notices in history into notes; a
    // file that reaches this side has been through it)
    o.remove("sessionId");
    o.remove("history");
}

fn read_json(file: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let text = text.trim_start_matches('\u{feff}'); // (saved by an editor that adds a BOM)
    if text.trim().is_empty() {
        return Err("empty file".into());
    }
    let data: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if !data.get("characters").is_some_and(Value::is_array) {
        return Err("not a C-Bot file".into());
    }
    Ok(data)
}

fn write_safely(file: &Path, text: &str) -> std::io::Result<()> {
    let tmp = tmp_of(file);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?; // on disk before it replaces the old file, so a power cut can't leave it empty
    }
    fs::rename(&tmp, file)
}

fn tmp_of(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Copy the old app's robots into `dir`: c-bot.json, the temp file a save cut short may have
/// left, and the daily backups (theirs, and vocab's and notes'), so that a damaged c-bot.json
/// is recovered from them as one of ours would be, instead of starting fresh.
fn bring_over(from: &Path, dir: &Path) {
    let backups = dir.join("backups");
    if fs::create_dir_all(&backups).is_err() {
        return;
    }
    for name in ["c-bot.json", "c-bot.json.tmp"] {
        let src = from.join(name);
        if src.is_file() {
            let _ = fs::copy(&src, dir.join(name));
        }
    }
    let Ok(old) = fs::read_dir(from.join("backups")) else {
        return;
    };
    for e in old.flatten() {
        let to = backups.join(e.file_name());
        if e.path().extension().is_some_and(|x| x == "json") && e.path().is_file() && !to.exists() {
            let _ = fs::copy(e.path(), to);
        }
    }
}

/// Where the robots came back from when c-bot.json couldn't be read.
pub struct Recovered {
    pub from: Option<PathBuf>,
    pub broken: PathBuf,
}

pub struct Store {
    file: PathBuf,
    pub backup_dir: PathBuf,
    data: Value,
    due: Option<Instant>, // when the pending changes get saved
    backup_day: Option<String>,
    pub recovered: Option<Recovered>,
}

impl Store {
    /// The store in `dir`. On a first run (nothing there yet) it starts from a copy of what's
    /// in `import` (the Electron app's data folder, which is left as it is).
    pub fn open(dir: &Path, import: Option<PathBuf>) -> Store {
        let file = dir.join("c-bot.json");
        if !file.exists()
            && !tmp_of(&file).exists()
            && let Some(from) = import.filter(|d| d.is_dir())
        {
            bring_over(&from, dir);
        }
        let mut store = Store {
            backup_dir: dir.join("backups"),
            file,
            data: json!({ "characters": [], "settings": { "muted": false, "claudePath": "" } }),
            due: None,
            backup_day: None,
            recovered: None,
        };
        let raw = store.load();
        if let Some(raw) = &raw {
            let mut settings = store.data["settings"].as_object().unwrap().clone();
            if let Some(s) = raw.get("settings").and_then(Value::as_object) {
                settings.extend(s.clone());
            }
            let mut data = raw.as_object().unwrap().clone();
            data.insert("settings".into(), Value::Object(settings));
            store.data = Value::Object(data);
        }
        for c in store.characters_mut() {
            migrate(c);
        }
        // robot sounds: 'essential' | 'all' | 'off' (it was a mute checkbox: muted is off, else essential)
        let settings = store.data["settings"].as_object_mut().unwrap();
        if !matches!(
            settings.get("sounds").and_then(Value::as_str),
            Some("essential" | "all" | "off")
        ) {
            let muted = settings
                .get("muted")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            settings.insert(
                "sounds".into(),
                json!(if muted { "off" } else { "essential" }),
            );
        }
        if raw.is_some() {
            store.backup();
        }
        store
    }

    fn load(&mut self) -> Option<Value> {
        if !self.file.exists() {
            // first run, or a save was cut off between writing the temp file and swapping it in
            return read_json(&tmp_of(&self.file)).ok();
        }
        let err = match read_json(&self.file) {
            Ok(data) => return Some(data),
            Err(err) => err,
        };
        let broken = self
            .file
            .with_file_name(format!("c-bot.broken-{}.json", now_ms()));
        let _ = fs::rename(&self.file, &broken);
        let mut candidates = vec![tmp_of(&self.file)];
        candidates.extend(self.backups());
        for candidate in candidates {
            if let Ok(data) = read_json(&candidate) {
                eprintln!(
                    "[store] {} was unreadable ({err}); recovered from {}",
                    self.file.display(),
                    candidate.display()
                );
                self.recovered = Some(Recovered {
                    from: Some(candidate),
                    broken,
                });
                return Some(data);
            }
        }
        self.recovered = Some(Recovered { from: None, broken });
        None
    }

    /// newest first
    fn backups(&self) -> Vec<PathBuf> {
        let Ok(dir) = fs::read_dir(&self.backup_dir) else {
            return vec![];
        };
        let mut names: Vec<String> = dir
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| {
                n.len() == "c-bot-2026-01-01.json".len()
                    && n.starts_with("c-bot-")
                    && n.ends_with(".json")
            })
            .collect();
        names.sort();
        names.reverse();
        names.into_iter().map(|n| self.backup_dir.join(n)).collect()
    }

    /// one copy of the robots a day, the last two weeks kept
    fn backup(&mut self) {
        let day = today();
        if self.backup_day.as_deref() == Some(day.as_str()) {
            return;
        }
        self.backup_day = Some(day.clone());
        let result = (|| -> std::io::Result<()> {
            fs::create_dir_all(&self.backup_dir)?;
            let target = self.backup_dir.join(format!("c-bot-{day}.json"));
            if !target.exists() && !self.list().is_empty() {
                write_safely(&target, &self.text())?;
            }
            for old in self.backups().into_iter().skip(BACKUPS_KEPT) {
                let _ = fs::remove_file(old);
            }
            Ok(())
        })();
        if let Err(err) = result {
            eprintln!("[store] backup failed: {err}");
        }
    }

    fn text(&self) -> String {
        serde_json::to_string_pretty(&self.data).unwrap_or_default()
    }

    /// Save soon (changes close together are written once).
    pub fn save(&mut self) {
        self.due = Some(Instant::now() + SAVE_DELAY);
    }

    /// Save now if a save is due (the saver thread calls this every so often).
    pub fn tick(&mut self) {
        if self.due.is_some_and(|t| Instant::now() >= t) {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        self.due = None;
        let result = fs::create_dir_all(self.file.parent().unwrap())
            .and_then(|_| write_safely(&self.file, &self.text()));
        if let Err(err) = result {
            eprintln!("[store] save failed: {err}");
        }
        self.backup(); // a new day while the app kept running
    }

    // ---------------------------------------------------------------- settings

    pub fn settings(&self) -> &Value {
        &self.data["settings"]
    }

    pub fn update_settings(&mut self, patch: Map<String, Value>) -> Value {
        self.data["settings"].as_object_mut().unwrap().extend(patch);
        self.save();
        self.settings().clone()
    }

    // ---------------------------------------------------------------- robots

    pub fn list(&self) -> &Vec<Value> {
        self.data["characters"].as_array().unwrap()
    }

    fn characters_mut(&mut self) -> &mut Vec<Value> {
        self.data["characters"].as_array_mut().unwrap()
    }

    pub fn get(&self, id: &str) -> Option<&Value> {
        self.list().iter().find(|c| str_of(c, "id") == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Map<String, Value>> {
        self.characters_mut()
            .iter_mut()
            .find(|c| str_of(c, "id") == id)
            .and_then(Value::as_object_mut)
    }

    pub fn update(&mut self, id: &str, patch: Map<String, Value>) -> Option<Value> {
        let c = self.get_mut(id)?;
        c.extend(patch);
        let out = Value::Object(c.clone());
        self.save();
        Some(out)
    }

    /// Drop these fields (the Electron app sets them to undefined).
    pub fn unset(&mut self, id: &str, keys: &[&str]) {
        if let Some(c) = self.get_mut(id) {
            for k in keys {
                c.remove(*k);
            }
            self.save();
        }
    }

    /// A new robot (the Workshop's): the defaults, then what was picked for it.
    pub fn create(&mut self, fields: Map<String, Value>) -> Value {
        let first = new_tab(Map::new());
        let mut c = json!({
            "id": uuid::Uuid::new_v4().to_string(), "name": "Robo", "folder": "", "personality": "cheerful", "color": "#5ac8fa",
            "permissionMode": "default", "model": "", "tabs": [first.clone()], "activeTab": first["id"], "visible": true,
            "position": null, "stats": { "questions": 0, "pokes": 0, "costUsd": 0 }, "createdAt": now_ms(),
        });
        c.as_object_mut().unwrap().extend(fields);
        self.characters_mut().push(c.clone());
        self.save();
        c
    }

    pub fn remove(&mut self, id: &str) {
        self.characters_mut().retain(|c| str_of(c, "id") != id);
        self.save();
    }

    // ---------------------------------------------------------------- tabs

    pub fn tab(&self, id: &str, tab_id: &str) -> Option<&Value> {
        self.get(id)?
            .get("tabs")?
            .as_array()?
            .iter()
            .find(|t| str_of(t, "id") == tab_id)
    }

    fn tabs_mut(&mut self, id: &str) -> Option<&mut Vec<Value>> {
        self.get_mut(id)?.get_mut("tabs")?.as_array_mut()
    }

    pub fn add_tab(&mut self, id: &str, fields: Map<String, Value>) -> Option<Value> {
        let c = self.get_mut(id)?;
        if c.get("tabs").and_then(Value::as_array).map_or(0, Vec::len) >= MAX_TABS {
            return None;
        }
        let tab = new_tab(fields);
        c.insert("activeTab".into(), tab["id"].clone());
        c.get_mut("tabs")?.as_array_mut()?.push(tab.clone());
        self.save();
        Some(tab)
    }

    pub fn remove_tab(&mut self, id: &str, tab_id: &str) {
        let Some(c) = self.get_mut(id) else { return };
        let tabs = c.get_mut("tabs").and_then(Value::as_array_mut).unwrap();
        let Some(i) = tabs.iter().position(|t| str_of(t, "id") == tab_id) else {
            return;
        };
        let closed = tabs.remove(i);
        if tabs.is_empty() {
            tabs.push(new_tab(Map::new()));
        }
        let next = tabs[i.min(tabs.len() - 1)]["id"].clone();
        // a tab with a conversation in it can be reopened (Ctrl+Shift+T); a temporary one is gone for good
        let has_talk = (closed
            .get("history")
            .and_then(Value::as_array)
            .is_some_and(|h| !h.is_empty())
            || !closed["sessionId"].is_null())
            && closed["temporary"] != true;
        if has_talk {
            let mut kept: Vec<Value> = c
                .get("closedTabs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            kept.retain(|t| str_of(t, "id") != tab_id);
            let mut closed = closed;
            closed["closedAt"] = json!(now_ms());
            kept.push(closed);
            let skip = kept.len().saturating_sub(CLOSED_TABS_KEPT);
            c.insert(
                "closedTabs".into(),
                Value::Array(kept.into_iter().skip(skip).collect()),
            );
        }
        if c.get("activeTab").and_then(Value::as_str) == Some(tab_id) {
            c.insert("activeTab".into(), next);
        }
        self.save();
    }

    /// Bring back the most recently closed tab (or the one with this id).
    pub fn reopen_tab(&mut self, id: &str, tab_id: Option<&str>) -> Option<Value> {
        let c = self.get_mut(id)?;
        let mut closed: Vec<Value> = c
            .get("closedTabs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let i = match tab_id {
            Some(t) => closed.iter().position(|x| str_of(x, "id") == t)?,
            None => closed.len().checked_sub(1)?,
        };
        let tabs = c.get_mut("tabs").and_then(Value::as_array_mut)?;
        // an empty "New chat" tab makes room for it
        let blank = tabs.iter().position(|t| {
            t.get("history")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
                && t["sessionId"].is_null()
                && str_of(t, "title").is_empty()
        });
        if tabs.len() >= MAX_TABS && blank.is_none() {
            return None;
        }
        let mut tab = closed.remove(i);
        tab.as_object_mut()?.remove("closedAt");
        if let Some(b) = blank {
            // (full: the blank one goes; the lone empty tab left behind by closing the last one goes too)
            if tabs.len() >= MAX_TABS || tabs.len() == 1 {
                tabs.remove(b);
            }
        }
        tabs.push(tab.clone());
        c.insert("activeTab".into(), tab["id"].clone());
        c.insert("closedTabs".into(), Value::Array(closed));
        self.save();
        Some(tab)
    }

    pub fn update_tab(
        &mut self,
        id: &str,
        tab_id: &str,
        patch: Map<String, Value>,
    ) -> Option<Value> {
        let tab = self
            .tabs_mut(id)?
            .iter_mut()
            .find(|t| str_of(t, "id") == tab_id)?;
        tab.as_object_mut()?.extend(patch);
        let out = tab.clone();
        self.save();
        Some(out)
    }

    /// Every session this robot has started, to label them in "past conversations".
    pub fn remember_session(&mut self, id: &str, session_id: &str) {
        let Some(c) = self.get_mut(id) else { return };
        if session_id.is_empty() {
            return;
        }
        let mut ids: Vec<Value> = c
            .get("sessionIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !ids.iter().any(|x| x == session_id) {
            ids.push(json!(session_id));
            let skip = ids.len().saturating_sub(200);
            c.insert(
                "sessionIds".into(),
                Value::Array(ids.into_iter().skip(skip).collect()),
            );
        }
        self.save();
    }

    pub fn push_history(&mut self, id: &str, tab_id: &str, entry: Value) {
        let Some(tab) = self
            .tabs_mut(id)
            .and_then(|t| t.iter_mut().find(|t| str_of(t, "id") == tab_id))
        else {
            return;
        };
        let Some(history) = tab.get_mut("history").and_then(Value::as_array_mut) else {
            return;
        };
        let mut entry = entry;
        entry["at"] = json!(now_ms());
        history.push(entry);
        if history.len() > HISTORY_LIMIT {
            let extra = history.len() - HISTORY_LIMIT;
            history.drain(..extra);
        }
        self.save();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cbot-store-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn robots(names: &[&str]) -> String {
        let list: Vec<Value> = names
            .iter()
            .map(|n| json!({ "id": n, "name": n }))
            .collect();
        json!({ "characters": list, "settings": {} }).to_string()
    }

    fn names(store: &Store) -> Vec<String> {
        store
            .list()
            .iter()
            .map(|c| str_of(c, "name").to_string())
            .collect()
    }

    #[test]
    fn first_run_brings_the_old_apps_robots_over() {
        let (old, new) = (scratch("old"), scratch("new"));
        fs::write(old.join("c-bot.json"), robots(&["Bo", "Sunny"])).unwrap();
        let store = Store::open(&new, Some(old.clone()));
        assert_eq!(names(&store), ["Bo", "Sunny"]);
        assert!(store.recovered.is_none());
        // the next start keeps its own, never the old app's again
        fs::write(old.join("c-bot.json"), robots(&["Other"])).unwrap();
        assert_eq!(
            names(&Store::open(&new, Some(old.clone()))),
            ["Bo", "Sunny"]
        );
        let _ = (fs::remove_dir_all(old), fs::remove_dir_all(new));
    }

    #[test]
    fn a_damaged_old_file_comes_back_from_the_old_apps_backups() {
        let (old, new) = (scratch("old-broken"), scratch("new-broken"));
        fs::write(old.join("c-bot.json"), "{ \"characters\": [ { \"id\": ").unwrap();
        fs::create_dir_all(old.join("backups")).unwrap();
        fs::write(
            old.join("backups").join("c-bot-2026-10-20.json"),
            robots(&["Older"]),
        )
        .unwrap();
        fs::write(
            old.join("backups").join("c-bot-2026-10-25.json"),
            robots(&["Bo", "Sunny"]),
        )
        .unwrap();
        fs::write(
            old.join("backups").join("vocab-2026-10-25.json"),
            "{\"words\":[]}",
        )
        .unwrap();
        let store = Store::open(&new, Some(old.clone()));
        assert_eq!(names(&store), ["Bo", "Sunny"], "the newest backup");
        let r = store.recovered.as_ref().expect("said it was recovered");
        assert!(
            r.from
                .as_ref()
                .is_some_and(|f| f.ends_with("c-bot-2026-10-25.json"))
        );
        assert!(
            new.join("backups").join("vocab-2026-10-25.json").exists(),
            "the other backups came too"
        );
        assert!(
            old.join("c-bot.json").exists(),
            "the old app's files are left as they were"
        );
        let _ = (fs::remove_dir_all(old), fs::remove_dir_all(new));
    }
}
