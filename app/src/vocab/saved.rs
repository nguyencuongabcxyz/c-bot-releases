//! A JSON file of yours kept apart from the robots (vocab.json, notes.json: main vocab.js and
//! notes.js), saved the way store.rs saves c-bot.json: a temp file forced to disk, then
//! swapped in, a moment after the changes (several close together are written once); and
//! one copy a day in backups/, the last two weeks kept. Shared by vocab.rs and notes.rs.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

const BACKUPS_KEPT: usize = 14; // one a day
const SAVE_DELAY: Duration = Duration::from_millis(300);

pub struct Saved {
    file: PathBuf,
    backup_dir: PathBuf,
    name: &'static str, // "vocab", "notes": the file's and its backups' names
    list: &'static str, // the list a good file has ("words", "notes")
    local_days: bool,   // backups named by your day (notes.js) or UTC's (vocab.js)
    due: Option<Instant>,
    backup_day: Option<String>,
}

fn tmp_of(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
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

impl Saved {
    /// <dir>/<name>.json, whose data has an array called `list`.
    pub fn new(dir: &Path, name: &'static str, list: &'static str, local_days: bool) -> Saved {
        Saved { file: dir.join(format!("{name}.json")), backup_dir: dir.join("backups"), name, list, local_days, due: None, backup_day: None }
    }

    /// On this app's first run (nothing here yet), a copy of the Electron app's file, which
    /// is left as it is.
    pub fn import(&self, electron_dir: Option<PathBuf>) {
        if self.file.exists() || tmp_of(&self.file).exists() {
            return;
        }
        let Some(src) = electron_dir.map(|d| d.join(format!("{}.json", self.name))).filter(|p| p.is_file()) else { return };
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        match fs::copy(&src, &self.file) {
            Ok(_) => eprintln!("[{}] brought over from {}", self.name, src.display()),
            Err(err) => eprintln!("[{}] couldn't copy {}: {err}", self.name, src.display()),
        }
    }

    fn read(&self, file: &Path) -> Option<Value> {
        let text = fs::read_to_string(file).ok()?;
        let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        data.get(self.list).is_some_and(Value::is_array).then_some(data)
    }

    /// What's saved: the file, or the temp file a save cut short left behind. None if neither
    /// reads (a fresh start, as the Electron app made).
    pub fn load(&self) -> Option<Value> {
        self.read(&self.file).or_else(|| self.read(&tmp_of(&self.file)))
    }

    /// Save soon.
    pub fn save(&mut self) {
        self.due = Some(Instant::now() + SAVE_DELAY);
    }

    /// Save now if a save is due (the module's saver thread calls this every so often).
    pub fn tick(&mut self, data: &Value) {
        if self.due.is_some_and(|t| Instant::now() >= t) {
            self.flush(data);
        }
    }

    /// Save now if anything's waiting (C-Bot is quitting).
    pub fn flush_pending(&mut self, data: &Value) {
        if self.due.is_some() {
            self.flush(data);
        }
    }

    pub fn flush(&mut self, data: &Value) {
        self.due = None;
        let text = serde_json::to_string_pretty(data).unwrap_or_default();
        let result = self.file.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| write_safely(&self.file, &text));
        match result {
            Ok(()) => self.backup(data, &text),
            Err(err) => eprintln!("[{}] save failed: {err}", self.name),
        }
    }

    // one copy a day, the last two weeks kept (next to the robots')
    fn backup(&mut self, data: &Value, text: &str) {
        let day = if self.local_days { chrono::Local::now().format("%Y-%m-%d") } else { chrono::Utc::now().format("%Y-%m-%d") }.to_string();
        let empty = data[self.list].as_array().is_none_or(Vec::is_empty);
        if self.backup_day.as_deref() == Some(day.as_str()) || empty {
            return;
        }
        self.backup_day = Some(day.clone());
        let result = (|| -> std::io::Result<()> {
            fs::create_dir_all(&self.backup_dir)?;
            let target = self.backup_dir.join(format!("{}-{day}.json", self.name));
            if !target.exists() {
                write_safely(&target, text)?;
            }
            let prefix = format!("{}-", self.name);
            let mut names: Vec<String> = fs::read_dir(&self.backup_dir)?
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.len() == prefix.len() + "2026-01-01.json".len() && n.starts_with(&prefix) && n.ends_with(".json"))
                .collect();
            names.sort();
            names.reverse();
            for old in names.into_iter().skip(BACKUPS_KEPT) {
                let _ = fs::remove_file(self.backup_dir.join(old));
            }
            Ok(())
        })();
        if let Err(err) = result {
            eprintln!("[{}] backup failed: {err}", self.name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cbot-saved-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_loads_and_backs_up() {
        let dir = temp_dir("roundtrip");
        let mut s = Saved::new(&dir, "notes", "notes", true);
        assert!(s.load().is_none());
        let data = json!({ "notes": [{ "id": "a" }], "reminded": {} });
        s.flush(&data);
        assert_eq!(s.load(), Some(data.clone()));
        let backups: Vec<_> = fs::read_dir(dir.join("backups")).unwrap().collect();
        assert_eq!(backups.len(), 1);
        // a file that isn't one of ours doesn't load; the temp file a cut-off save left does
        fs::write(dir.join("notes.json"), "{\"other\": 1}").unwrap();
        assert!(s.load().is_none());
        fs::write(dir.join("notes.json.tmp"), "\u{feff}{\"notes\": []}").unwrap();
        assert_eq!(s.load(), Some(json!({ "notes": [] })));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_only_on_a_first_run() {
        let dir = temp_dir("import");
        let old = temp_dir("import-electron");
        fs::write(old.join("vocab.json"), "{\"words\": [1]}").unwrap();
        let s = Saved::new(&dir, "vocab", "words", false);
        s.import(Some(old.clone()));
        assert_eq!(s.load(), Some(json!({ "words": [1] })));
        // already there: left alone
        fs::write(old.join("vocab.json"), "{\"words\": [2]}").unwrap();
        s.import(Some(old.clone()));
        assert_eq!(s.load(), Some(json!({ "words": [1] })));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&old);
    }

    #[test]
    fn keeps_two_weeks_of_backups() {
        let dir = temp_dir("prune");
        let b = dir.join("backups");
        fs::create_dir_all(&b).unwrap();
        for d in 1..=20 {
            fs::write(b.join(format!("vocab-2020-01-{d:02}.json")), "{}").unwrap();
        }
        fs::write(b.join("c-bot-2020-01-01.json"), "{}").unwrap(); // (the robots' own: not ours to prune)
        let mut s = Saved::new(&dir, "vocab", "words", false);
        s.flush(&json!({ "words": [{ "id": "x" }] }));
        let names: Vec<String> = fs::read_dir(&b).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.iter().filter(|n| n.starts_with("vocab-")).count(), BACKUPS_KEPT);
        assert!(names.iter().any(|n| n == "c-bot-2020-01-01.json"));
        assert!(!names.iter().any(|n| n == "vocab-2020-01-01.json"));
        let _ = fs::remove_dir_all(&dir);
    }
}
