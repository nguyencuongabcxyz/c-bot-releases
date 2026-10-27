//! Your notes as notes.json keeps them (main notes.js Notes): one notebook shared by all your
//! robots. Each note is { id, text, important, createdAt, doneAt, source, working }:
//! unfinished ones carry over from day to day until you tick them off; done ones are kept a
//! month, then cleared. And when the daily reminders are due (createNoteReminders): at the
//! end of your workday about today's notes, and the first time you're at the PC on a workday
//! about what you noted since your last one; each once a day, and they can be put off.
//! Nothing here touches a window or a file: the module saves when `dirty` says so.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike};
use serde_json::{json, Value};

pub const MIN: i64 = 60_000;
const DAY: i64 = 24 * 60 * MIN;
const DONE_KEPT_DAYS: i64 = 30;
const MAX_LEN: usize = 2000;
const MORNING_FROM: u32 = 6; // a "start of day" reminder only from 6 am…
const EVENING_UNTIL: u32 = 22; // …and the end-of-day one no later than 10 pm (missed it: the morning covers it)

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn ms(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn created(n: &Value) -> i64 {
    ms(&n["createdAt"]).unwrap_or(0)
}

/// When it was ticked off (None: still to do).
fn done_at(n: &Value) -> Option<i64> {
    ms(&n["doneAt"]).filter(|&d| d != 0)
}

fn important(n: &Value) -> bool {
    n["important"].as_bool().unwrap_or(false)
}

/// A moment as your local time.
pub fn local(ms: i64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms).earliest().unwrap_or_else(Local::now)
}

/// The start of that date where you are (ms).
fn midnight(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).unwrap_or_default();
    Local.from_local_datetime(&naive).earliest().map_or(0, |d| d.timestamp_millis())
}

pub fn start_of_day(d: DateTime<Local>) -> i64 {
    midnight(d.date_naive())
}

pub fn local_day(d: DateTime<Local>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// The text as a note keeps it: Windows line ends made plain, trimmed.
fn tidy(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub struct Notes {
    pub data: Value, // { notes: [...], reminded: { morning, evening } }
    pub dirty: bool,
}

impl Notes {
    /// From what was saved (None: no notes yet).
    pub fn from(data: Option<Value>, now: i64) -> Notes {
        let mut data = data.unwrap_or_else(|| json!({ "notes": [] }));
        if !data["reminded"].is_object() {
            data["reminded"] = json!({});
        }
        // Claude can't still be on a note after a restart
        for n in data["notes"].as_array_mut().into_iter().flatten() {
            if let Some(o) = n.as_object_mut() {
                o.shift_remove("working");
            }
        }
        let mut notes = Notes { data, dirty: false };
        notes.purge(now);
        notes
    }

    fn all(&self) -> &[Value] {
        self.data["notes"].as_array().map_or(&[], Vec::as_slice)
    }

    fn all_mut(&mut self) -> &mut Vec<Value> {
        if !self.data["notes"].is_array() {
            self.data["notes"] = json!([]);
        }
        self.data["notes"].as_array_mut().expect("just made an array")
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut serde_json::Map<String, Value>> {
        self.all_mut().iter_mut().find(|n| str_of(n, "id") == id)?.as_object_mut()
    }

    /// Every note, newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut all = self.all().to_vec();
        all.sort_by_key(|n| std::cmp::Reverse(created(n)));
        all
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.all().iter().find(|n| str_of(n, "id") == id).cloned()
    }

    /// The ones still to do: important first, then oldest first (they've waited longest).
    pub fn open(&self) -> Vec<Value> {
        let mut open: Vec<Value> = self.all().iter().filter(|n| done_at(n).is_none()).cloned().collect();
        open.sort_by(|a, b| important(b).cmp(&important(a)).then(created(a).cmp(&created(b))));
        open
    }

    /// A new note. A leading "!" marks it important. None if it's empty.
    pub fn add(&mut self, text: &str, important: bool, source: &str, now: i64) -> Option<Value> {
        let mut t = tidy(text);
        let mut important = important;
        if t.starts_with('!') {
            important = true;
            t = t.trim_start_matches('!').trim_start().to_string();
        }
        if t.is_empty() {
            return None;
        }
        let note = json!({
            "id": uuid::Uuid::new_v4().to_string(), "text": cut(&t, MAX_LEN), "important": important,
            "createdAt": now, "doneAt": null, "source": cut(source, 120),
        });
        self.all_mut().push(note.clone());
        self.dirty = true;
        Some(note)
    }

    /// Its text (if it's not empty), important or not, Claude working on it or not.
    pub fn update(&mut self, id: &str, patch: &Value) -> Option<Value> {
        let n = self.find_mut(id)?;
        if let Some(t) = patch["text"].as_str().map(tidy).filter(|t| !t.is_empty()) {
            n.insert("text".into(), json!(cut(&t, MAX_LEN)));
        }
        if let Some(i) = patch["important"].as_bool() {
            n.insert("important".into(), json!(i));
        }
        match patch["working"].as_bool() {
            Some(true) => {
                n.insert("working".into(), json!(true));
            }
            Some(false) => {
                n.shift_remove("working");
            }
            None => {}
        }
        let out = Value::Object(n.clone());
        self.dirty = true;
        Some(out)
    }

    /// Ticked off (or back to do): the note, and whether that changed anything.
    pub fn set_done(&mut self, id: &str, done: bool, now: i64) -> (Option<Value>, bool) {
        let Some(n) = self.find_mut(id) else { return (None, false) };
        let was = n.get("doneAt").and_then(ms).is_some_and(|d| d != 0);
        if was == done {
            return (Some(Value::Object(n.clone())), false);
        }
        n.insert("doneAt".into(), if done { json!(now) } else { Value::Null });
        n.shift_remove("working");
        let out = Value::Object(n.clone());
        self.dirty = true;
        (Some(out), true)
    }

    /// Gone (the notebook offers Undo: restore() puts it back as it was).
    pub fn remove(&mut self, id: &str) -> Option<Value> {
        let all = self.all_mut();
        let i = all.iter().position(|n| str_of(n, "id") == id)?;
        let n = all.remove(i);
        self.dirty = true;
        Some(n)
    }

    pub fn restore(&mut self, note: Value) -> Option<Value> {
        let id = str_of(&note, "id");
        if id.is_empty() || self.get(id).is_some() {
            return None;
        }
        self.all_mut().push(note.clone());
        self.dirty = true;
        Some(note)
    }

    /// The done ones cleared away; whether there were any.
    pub fn clear_done(&mut self) -> bool {
        let all = self.all_mut();
        let before = all.len();
        all.retain(|n| done_at(n).is_none());
        let gone = all.len() != before;
        self.dirty |= gone;
        gone
    }

    /// Done notes older than a month go (quietly, on start).
    pub fn purge(&mut self, now: i64) {
        let all = self.all_mut();
        let before = all.len();
        all.retain(|n| done_at(n).is_none_or(|d| now - d < DONE_KEPT_DAYS * DAY));
        if all.len() != before {
            self.dirty = true;
        }
    }

    /// What the desk's corkboard shows: up to `max` open notes and how many in all.
    pub fn board(&self, max: usize, now: i64) -> Value {
        let open = self.open();
        // important first, then the newest (what you just jotted down is what you want to see)
        let mut shown = open.clone();
        shown.sort_by(|a, b| important(b).cmp(&important(a)).then(created(b).cmp(&created(a))));
        let items: Vec<Value> = shown
            .iter()
            .take(max)
            .map(|n| json!({ "id": n["id"], "text": n["text"], "important": important(n), "age": age(n, now), "working": n["working"].as_bool().unwrap_or(false) }))
            .collect();
        json!({ "items": items, "total": open.len() })
    }

    /// Taken on or after `since` (ms).
    pub fn taken_since(&self, since: i64) -> Vec<Value> {
        self.all().iter().filter(|n| created(n) >= since).cloned().collect()
    }

    /// Which day each reminder last went off, saved with the notes.
    pub fn reminded(&self, kind: &str) -> String {
        str_of(&self.data["reminded"], kind).to_string()
    }

    pub fn mark_reminded(&mut self, kind: &str, day: &str) {
        if !self.data["reminded"].is_object() {
            self.data["reminded"] = json!({});
        }
        self.data["reminded"][kind] = json!(day);
        self.dirty = true;
    }
}

/// Days a note has been open (calendar days, where you are).
pub fn age(n: &Value, now: i64) -> i64 {
    let (today, then) = (start_of_day(local(now)), start_of_day(local(created(n))));
    (((today - then) as f64 / DAY as f64).round() as i64).max(0)
}

// ---------------------------------------------------------------- the daily reminders

/// The reminders' settings, each as set or its default (notes.js DEFAULTS). carry: the
/// morning one lists every note still open, not just the ones from last workday.
pub struct Cfg {
    pub on: bool,
    pub evening: u32, // minutes after midnight
    pub morning: bool,
    pub workdays: Vec<u32>, // 0 Sunday … 6 Saturday
    pub carry: bool,
}

/// "17:30" → minutes after midnight (bad input: 17:30).
pub fn minutes_of(hm: &str) -> u32 {
    let parsed = hm.split_once(':').and_then(|(h, m)| {
        let ok = (1..=2).contains(&h.len()) && m.len() == 2 && h.chars().chain(m.chars()).all(|c| c.is_ascii_digit());
        if !ok {
            return None;
        }
        let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
        (h <= 23 && m <= 59).then_some(h * 60 + m)
    });
    parsed.unwrap_or(17 * 60 + 30)
}

pub fn cfg(settings: &Value) -> Cfg {
    let flag = |k: &str| settings[k].as_bool().unwrap_or(true);
    Cfg {
        on: flag("notesReminders"),
        evening: minutes_of(settings["notesEvening"].as_str().unwrap_or("17:30")),
        morning: flag("notesMorning"),
        workdays: crate::robots::social::workdays(settings),
        carry: flag("notesCarry"),
    }
}

/// Your last workday before `d` (yesterday, or Friday on a Monday), as the time it started.
fn last_workday_start(d: DateTime<Local>, days: &[u32]) -> i64 {
    let date = d.date_naive();
    for i in 1..=7 {
        let p = date - Duration::days(i);
        if days.contains(&p.weekday().num_days_from_sunday()) {
            return midnight(p);
        }
    }
    start_of_day(d) - DAY
}

/// What a reminder of this kind would list, at time d: { kind, notes, open, today, taken, since }.
pub fn gather(notes: &Notes, kind: &str, d: DateTime<Local>, c: &Cfg) -> Value {
    let open = notes.open();
    let morning = kind == "morning";
    let today = start_of_day(d);
    let since = if morning { last_workday_start(d, &c.workdays) } else { today };
    let taken: Vec<Value> = notes.taken_since(since).into_iter().filter(|n| !morning || created(n) < today).collect();
    let carried: &[Value] = if morning && !c.carry { &[] } else { &open };
    let ids: Vec<&str> = carried.iter().chain(taken.iter()).map(|n| str_of(n, "id")).collect();
    let list: Vec<Value> = notes.list().into_iter().filter(|n| ids.contains(&str_of(n, "id"))).collect();
    json!({ "kind": kind, "notes": list, "open": open.len(), "today": notes.taken_since(today).len(), "taken": taken.len(), "since": since })
}

/// A reminder that's due: its kind, and whether it's one you put off.
#[derive(Debug, PartialEq)]
pub struct Due {
    pub kind: String,
    pub snoozed: bool,
}

/// When the reminders go off. Checked once a minute (and whenever you come back to the PC).
#[derive(Default)]
pub struct NoteClock {
    pending: Option<(String, i64)>, // put off: which, and till when
}

impl NoteClock {
    /// Which reminder is due at time d, if any (a put-off one that's due is taken). Once it's
    /// been shown (or there was nothing to show), `shown` books it.
    pub fn due(&mut self, notes: &Notes, c: &Cfg, d: DateTime<Local>, present: bool) -> Option<Due> {
        if !c.on || !present {
            return None;
        }
        // put off with "remind me later"
        if let Some((kind, at)) = &self.pending {
            if d.timestamp_millis() < *at {
                return None;
            }
            let kind = kind.clone();
            self.pending = None;
            return Some(Due { kind, snoozed: true });
        }
        if !c.workdays.contains(&d.weekday().num_days_from_sunday()) {
            return None;
        }
        let day = local_day(d);
        let mins = d.hour() * 60 + d.minute();
        // end of the day first: if it's already past it, the morning one has had its chance
        if mins >= c.evening && d.hour() < EVENING_UNTIL && notes.reminded("evening") != day {
            return Some(Due { kind: "evening".into(), snoozed: false });
        }
        if c.morning && d.hour() >= MORNING_FROM && mins < c.evening && notes.reminded("morning") != day {
            return Some(Due { kind: "morning".into(), snoozed: false });
        }
        None
    }

    /// It went off: not again today (the end of the day covers the morning too).
    pub fn shown(notes: &mut Notes, due: &Due, d: DateTime<Local>) {
        if due.snoozed {
            return;
        }
        let day = local_day(d);
        notes.mark_reminded(&due.kind, &day);
        if due.kind == "evening" {
            notes.mark_reminded("morning", &day);
        }
    }

    /// "Remind me in N minutes".
    pub fn snooze(&mut self, kind: &str, minutes: i64, now: i64) {
        self.pending = Some((kind.to_string(), now + minutes * MIN));
    }

    /// "Done for today": nothing more today (the snooze too).
    pub fn done_for_today(&mut self, notes: &mut Notes, d: DateTime<Local>) {
        self.pending = None;
        let day = local_day(d);
        notes.mark_reminded("evening", &day);
        notes.mark_reminded("morning", &day);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A local time on a date (2026-10-26 is a Monday).
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
    }

    fn note(n: &mut Notes, text: &str, when: DateTime<Local>) -> String {
        n.add(text, false, "", when.timestamp_millis()).unwrap()["id"].as_str().unwrap().to_string()
    }

    /// One check as notes.js check() makes it: what went off (fire: could it be shown).
    fn check(clock: &mut NoteClock, notes: &mut Notes, c: &Cfg, d: DateTime<Local>, present: bool, fire: bool) -> Option<String> {
        let due = clock.due(notes, c, d, present)?;
        let info = gather(notes, &due.kind, d, c);
        let shown = info["notes"].as_array().unwrap().is_empty() || fire;
        if !shown {
            return None;
        }
        NoteClock::shown(notes, &due, d);
        Some(due.kind)
    }

    #[test]
    fn adding_and_editing() {
        let mut n = Notes::from(None, 0);
        assert!(n.add("   ", false, "", 1).is_none());
        assert!(n.add("!!", false, "", 1).is_none());
        let a = n.add("!! call Bob\r\nabout lunch ", false, "x".repeat(200).as_str(), 5).unwrap();
        assert_eq!(a["text"], "call Bob\nabout lunch");
        assert_eq!(a["important"], true);
        assert_eq!(a["source"].as_str().unwrap().len(), 120);
        assert_eq!(a["doneAt"], Value::Null);
        let id = a["id"].as_str().unwrap();
        let b = n.update(id, &json!({ "text": "  ", "important": false, "working": true })).unwrap();
        assert_eq!((b["text"].clone(), b["important"].clone(), b["working"].clone()), (json!("call Bob\nabout lunch"), json!(false), json!(true)));
        assert!(n.update(id, &json!({ "working": false })).unwrap().get("working").is_none());
        assert_eq!(n.add(&"y".repeat(3000), false, "", 6).unwrap()["text"].as_str().unwrap().len(), MAX_LEN);
    }

    #[test]
    fn done_undone_removed_restored() {
        let mut n = Notes::from(None, 0);
        let id = n.add("a", false, "", 1).unwrap()["id"].as_str().unwrap().to_string();
        n.update(&id, &json!({ "working": true }));
        let (note, changed) = n.set_done(&id, true, 100);
        assert!(changed);
        assert_eq!(note.as_ref().unwrap()["doneAt"], 100);
        assert!(note.unwrap().get("working").is_none());
        assert!(!n.set_done(&id, true, 200).1); // (already done)
        assert_eq!(n.set_done(&id, false, 300).0.unwrap()["doneAt"], Value::Null);
        assert_eq!(n.set_done("nope", true, 1), (None, false));
        let gone = n.remove(&id).unwrap();
        assert!(n.get(&id).is_none());
        assert!(n.restore(gone.clone()).is_some());
        assert!(n.restore(gone).is_none()); // (it's back already)
        n.set_done(&id, true, 1);
        assert!(n.clear_done());
        assert!(!n.clear_done());
    }

    #[test]
    fn important_first_then_oldest_and_the_board_newest() {
        let mut n = Notes::from(None, 0);
        let t = at(2026, 10, 26, 9, 0).timestamp_millis();
        for (i, text) in ["one", "two", "!three", "four", "five", "six", "seven"].iter().enumerate() {
            n.add(text, false, "", t + i as i64);
        }
        let done = n.list()[0]["id"].as_str().unwrap().to_string(); // seven
        n.set_done(&done, true, t + 100);
        let open: Vec<Value> = n.open().iter().map(|x| x["text"].clone()).collect();
        assert_eq!(open, vec![json!("three"), json!("one"), json!("two"), json!("four"), json!("five"), json!("six")]);
        let board = n.board(5, t + DAY);
        assert_eq!(board["total"], 6);
        let shown: Vec<Value> = board["items"].as_array().unwrap().iter().map(|x| x["text"].clone()).collect();
        assert_eq!(shown, vec![json!("three"), json!("six"), json!("five"), json!("four"), json!("two")]);
        assert_eq!(board["items"][0]["age"], 1);
        assert_eq!(board["items"][0]["working"], false);
    }

    #[test]
    fn ages_in_calendar_days() {
        let n = json!({ "createdAt": at(2026, 10, 26, 23, 50).timestamp_millis() });
        assert_eq!(age(&n, at(2026, 10, 27, 0, 10).timestamp_millis()), 1);
        assert_eq!(age(&n, at(2026, 10, 26, 23, 59).timestamp_millis()), 0);
        assert_eq!(age(&n, at(2026, 11, 2, 8, 0).timestamp_millis()), 7);
        assert_eq!(age(&n, at(2026, 10, 1, 8, 0).timestamp_millis()), 0); // (a clock gone back)
    }

    #[test]
    fn done_notes_go_after_a_month() {
        let now = at(2026, 10, 26, 9, 0).timestamp_millis();
        let n = Notes::from(Some(json!({ "notes": [
            { "id": "old", "text": "a", "createdAt": 1, "doneAt": now - 31 * DAY },
            { "id": "recent", "text": "b", "createdAt": 1, "doneAt": now - 29 * DAY },
            { "id": "open", "text": "c", "createdAt": 1, "doneAt": null, "working": true },
        ] })), now);
        let ids: Vec<Value> = n.list().iter().map(|x| x["id"].clone()).collect();
        assert_eq!(ids.len(), 2);
        assert!(n.get("old").is_none());
        assert!(n.get("open").unwrap().get("working").is_none()); // (nobody's on it after a restart)
        assert!(n.dirty);
        assert_eq!(n.reminded("evening"), "");
    }

    #[test]
    fn times() {
        assert_eq!(minutes_of("17:30"), 1050);
        assert_eq!(minutes_of("9:05"), 545);
        assert_eq!(minutes_of("00:00"), 0);
        for bad in ["24:00", "12:60", "noon", "", "1730", "12:5", "123:00"] {
            assert_eq!(minutes_of(bad), 1050, "{bad}");
        }
        let c = cfg(&json!({ "notesEvening": "18:15", "notesMorning": false, "notesWorkdays": [1, 3] }));
        assert_eq!((c.on, c.evening, c.morning, c.workdays.clone(), c.carry), (true, 1095, false, vec![1, 3], true));
    }

    #[test]
    fn the_last_workday() {
        let wd = [1, 2, 3, 4, 5];
        // Monday: back to Friday
        assert_eq!(last_workday_start(at(2026, 10, 26, 9, 0), &wd), at(2026, 10, 23, 0, 0).timestamp_millis());
        // Wednesday: Tuesday
        assert_eq!(last_workday_start(at(2026, 10, 28, 9, 0), &wd), at(2026, 10, 27, 0, 0).timestamp_millis());
        // no workdays at all: yesterday
        assert_eq!(last_workday_start(at(2026, 10, 28, 9, 0), &[]), at(2026, 10, 27, 0, 0).timestamp_millis());
    }

    #[test]
    fn what_a_reminder_lists() {
        let c = cfg(&json!({}));
        let mut n = Notes::from(None, 0);
        let thu = note(&mut n, "thursday", at(2026, 10, 22, 10, 0));
        let fri = note(&mut n, "friday", at(2026, 10, 23, 10, 0));
        let fri_done = note(&mut n, "friday done", at(2026, 10, 23, 11, 0));
        n.set_done(&fri_done, true, at(2026, 10, 23, 12, 0).timestamp_millis());
        let mon = note(&mut n, "monday", at(2026, 10, 26, 8, 0));
        let mon_morning = at(2026, 10, 26, 9, 0);
        let info = gather(&n, "morning", mon_morning, &c);
        // taken since Friday (before today), plus every open one (carried over)
        let ids: Vec<Value> = info["notes"].as_array().unwrap().iter().map(|x| x["id"].clone()).collect();
        assert_eq!(ids, vec![json!(mon), json!(fri_done), json!(fri), json!(thu)]);
        assert_eq!((info["open"].clone(), info["today"].clone(), info["taken"].clone()), (json!(3), json!(1), json!(2)));
        // without carrying: only what was taken since the last workday
        let c2 = cfg(&json!({ "notesCarry": false }));
        let info = gather(&n, "morning", mon_morning, &c2);
        assert_eq!(info["notes"].as_array().unwrap().len(), 2);
        // the evening: today's, plus every open one
        let info = gather(&n, "evening", at(2026, 10, 26, 18, 0), &c2);
        let ids: Vec<Value> = info["notes"].as_array().unwrap().iter().map(|x| x["id"].clone()).collect();
        assert_eq!(ids, vec![json!(mon), json!(fri), json!(thu)]);
    }

    #[test]
    fn morning_then_evening_once_a_day() {
        let c = cfg(&json!({}));
        let mut n = Notes::from(None, 0);
        note(&mut n, "left over", at(2026, 10, 23, 10, 0));
        let mut clock = NoteClock::default();
        // too early, away, a weekend: nothing
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 5, 59), true, true), None);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 9, 0), false, true), None);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 25, 9, 0), true, true), None);
        // couldn't be shown (the robot's busy): tried again on the next check
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 9, 0), true, false), None);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 9, 1), true, true), Some("morning".into()));
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 9, 2), true, true), None);
        // the end of the day
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 17, 29), true, true), None);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 17, 30), true, true), Some("evening".into()));
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 17, 31), true, true), None);
        // first at the PC after the evening: the evening one (and no morning one after it)
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 27, 19, 0), true, true), Some("evening".into()));
        assert_eq!(n.reminded("morning"), "2026-10-27");
        // too late in the evening: the next morning covers it
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 28, 22, 0), true, true), None);
    }

    #[test]
    fn nothing_to_say_counts_as_done() {
        let c = cfg(&json!({}));
        let mut n = Notes::from(None, 0);
        let mut clock = NoteClock::default();
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 9, 0), true, false), Some("morning".into()));
        assert_eq!(n.reminded("morning"), "2026-10-26");
    }

    #[test]
    fn put_off_and_done_for_today() {
        let c = cfg(&json!({}));
        let mut n = Notes::from(None, 0);
        note(&mut n, "a", at(2026, 10, 26, 8, 0));
        let mut clock = NoteClock::default();
        let six = at(2026, 10, 26, 18, 0);
        assert_eq!(check(&mut clock, &mut n, &c, six, true, true), Some("evening".into()));
        clock.snooze("evening", 15, six.timestamp_millis());
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 18, 14), true, true), None);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 18, 15), true, true), Some("evening".into()));
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 18, 30), true, true), None);
        // put off, then done for today: nothing more
        clock.snooze("evening", 15, six.timestamp_millis());
        clock.done_for_today(&mut n, six);
        assert_eq!(check(&mut clock, &mut n, &c, at(2026, 10, 26, 19, 0), true, true), None);
        // turned off
        let off = cfg(&json!({ "notesReminders": false }));
        assert_eq!(check(&mut clock, &mut n, &off, at(2026, 10, 27, 9, 0), true, true), None);
        // no morning ones
        let no_morning = cfg(&json!({ "notesMorning": false }));
        assert_eq!(check(&mut clock, &mut n, &no_morning, at(2026, 10, 27, 9, 0), true, true), None);
    }
}
