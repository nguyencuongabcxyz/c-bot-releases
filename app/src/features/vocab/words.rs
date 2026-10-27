//! Your words as vocab.json keeps them (main vocab.js Vocab): each one as the Electron app
//! wrote it (a plain JSON object: the card page reads fields this side never needs to know),
//! with when you see it again (review: step, due, seen, right). A sleeping robot dreams of
//! it, and the gap grows each time (GAP). Nothing here touches a window or a file: the
//! module saves when `dirty` says so.

use std::collections::HashSet;
use std::sync::OnceLock;

use chrono::{Local, NaiveDate, TimeZone};
use regex::Regex;
use serde_json::{Map, Value, json};

pub const MIN: i64 = 60_000;
pub const HOUR: i64 = 60 * MIN;
pub const DAY: i64 = 24 * HOUR;
// Seeing it again, and again, further apart each time: the first dream 30 minutes after you
// save a word, then 2 h, 6 h, a day, 2 days, 4 days, a week, 2 weeks, and a month from then on.
// review.step is how many times you've seen it; review.due when it's next.
const GAP: [i64; 9] = [
    30 * MIN,
    2 * HOUR,
    6 * HOUR,
    DAY,
    2 * DAY,
    4 * DAY,
    7 * DAY,
    14 * DAY,
    30 * DAY,
];
pub const LEARNT_STEP: i64 = 6; // seen six times, over most of a week: learnt
// words saved before (a quiz box): the step they start from
const BOX_TO_STEP: [i64; 7] = [0, 2, 3, 4, 6, 7, 8];
const DAYS_KEPT: usize = 400;

pub fn gap_after(step: i64) -> i64 {
    GAP[step.clamp(0, GAP.len() as i64 - 1) as usize]
}

/// A calendar day where you are (the streak goes by your days, not UTC's).
pub fn local_day(ms: i64) -> String {
    local_date(ms).format("%Y-%m-%d").to_string()
}

fn local_date(ms: i64) -> NaiveDate {
    Local
        .timestamp_millis_opt(ms)
        .earliest()
        .map_or_else(|| Local::now().date_naive(), |d| d.date_naive())
}

/// How a word or phrase is compared: lower case, letters, digits, apostrophes, spaces and
/// hyphens only, single-spaced.
pub fn norm(w: &str) -> String {
    static ODD: OnceLock<Regex> = OnceLock::new();
    let odd = ODD.get_or_init(|| Regex::new(r"[^\p{L}\p{N}' -]").unwrap());
    let kept = odd.replace_all(&w.to_lowercase(), "").into_owned();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

/// When it was saved.
fn added_at(w: &Value) -> i64 {
    int(&w["addedAt"]).unwrap_or(0)
}

/// review.step (times seen), 0 if none.
pub fn step_of(w: &Value) -> i64 {
    int(&w["review"]["step"]).unwrap_or(0)
}

/// review.due, 0 if none (due already).
pub fn due_of(w: &Value) -> i64 {
    int(&w["review"]["due"]).unwrap_or(0)
}

fn is_ready(w: &Value) -> bool {
    str_of(w, "status") == "ready" && w["senses"].as_array().is_some_and(|s| !s.is_empty())
}

/// The meanings' parts of speech, each once ("noun, verb").
fn parts_of_speech(w: &Value) -> String {
    let mut seen: Vec<String> = vec![];
    for s in w["senses"].as_array().into_iter().flatten() {
        let pos = crate::runtime::util::text(&s["pos"]);
        if !seen.contains(&pos) {
            seen.push(pos);
        }
    }
    seen.join(", ")
}

fn meanings_vi(w: &Value) -> String {
    w["senses"]
        .as_array()
        .map(|s| {
            s.iter()
                .map(|x| crate::runtime::util::text(&x["vi"]))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default()
}

pub struct Vocab {
    pub data: Value, // { words: [...], days: [...] }
    pub dirty: bool, // changed since it was last saved
}

impl Vocab {
    /// From what was saved (None: no words yet).
    pub fn from(data: Option<Value>) -> Vocab {
        let mut data = data.unwrap_or_else(|| json!({ "words": [] }));
        for w in data["words"].as_array_mut().into_iter().flatten() {
            let Some(w) = w.as_object_mut() else { continue };
            // a lookup that never finished (C-Bot quit): try it again when it's next shown
            if w.get("status").and_then(Value::as_str) == Some("looking") {
                w.insert("status".into(), json!("failed"));
            }
            // saved with a quiz box: the matching step
            if let Some(r) = w.get_mut("review").and_then(Value::as_object_mut)
                && !r.contains_key("step")
            {
                let b = r.get("box").and_then(int).unwrap_or(0);
                let step = usize::try_from(b)
                    .ok()
                    .and_then(|b| BOX_TO_STEP.get(b))
                    .copied()
                    .unwrap_or(0);
                r.insert("step".into(), json!(step));
            }
        }
        Vocab { data, dirty: false }
    }

    fn words(&self) -> &[Value] {
        self.data["words"].as_array().map_or(&[], Vec::as_slice)
    }

    fn words_mut(&mut self) -> &mut Vec<Value> {
        if !self.data["words"].is_array() {
            self.data["words"] = json!([]);
        }
        self.data["words"]
            .as_array_mut()
            .expect("just made an array")
    }

    /// Every word, newest first.
    pub fn list(&self) -> Vec<Value> {
        let mut all = self.words().to_vec();
        all.sort_by_key(|w| std::cmp::Reverse(added_at(w)));
        all
    }

    pub fn count(&self) -> usize {
        self.words().len()
    }

    pub fn get(&self, id: &str) -> Option<&Value> {
        self.words().iter().find(|w| str_of(w, "id") == id)
    }

    /// The word you have that's this text (as captured, or its dictionary form).
    pub fn find(&self, text: &str) -> Option<&Value> {
        let n = norm(text);
        if n.is_empty() {
            return None;
        }
        self.words()
            .iter()
            .find(|w| norm(str_of(w, "word")) == n || norm(str_of(w, "text")) == n)
    }

    pub fn add(&mut self, text: &str, context: &str, source: &str, now: i64) -> Value {
        let word = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "word": text,
            "text": text, // as captured
            "ipa": "",
            "senses": [],
            "examples": [],
            "tip": "",
            "context": context,
            "source": source,
            "status": "looking",
            "addedAt": now,
            "review": { "step": 0, "due": now + GAP[0], "seen": 0, "right": 0 },
        });
        self.words_mut().push(word.clone());
        self.mark_day(&local_day(now));
        self.dirty = true;
        word
    }

    /// Its fields replaced by these; the word as it is now.
    pub fn update(&mut self, id: &str, patch: Map<String, Value>) -> Option<Value> {
        let w = self
            .words_mut()
            .iter_mut()
            .find(|w| str_of(w, "id") == id)?
            .as_object_mut()?;
        w.extend(patch);
        let out = Value::Object(w.clone());
        self.dirty = true;
        Some(out)
    }

    /// These fields gone (what the Electron app set to undefined).
    pub fn unset(&mut self, id: &str, keys: &[&str]) -> Option<Value> {
        let w = self
            .words_mut()
            .iter_mut()
            .find(|w| str_of(w, "id") == id)?
            .as_object_mut()?;
        for k in keys {
            w.shift_remove(*k);
        }
        let out = Value::Object(w.clone());
        self.dirty = true;
        Some(out)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let words = self.words_mut();
        let before = words.len();
        words.retain(|w| str_of(w, "id") != id);
        let gone = words.len() != before;
        self.dirty |= gone;
        gone
    }

    // ------------------------------------------------ seeing them again

    /// Looked up and ready (for dreams and quizzes).
    pub fn ready(&self) -> Vec<&Value> {
        self.words().iter().filter(|w| is_ready(w)).collect()
    }

    /// The word to dream of now: the most overdue one (a tie: the newer word), never `not`
    /// (the last one shown). None when none is due yet.
    pub fn next_dream(&self, now: i64, not: &str) -> Option<Value> {
        let mut due: Vec<&Value> = self
            .ready()
            .into_iter()
            .filter(|w| due_of(w) <= now && str_of(w, "id") != not)
            .collect();
        due.sort_by(|a, b| {
            due_of(a)
                .cmp(&due_of(b))
                .then(added_at(b).cmp(&added_at(a)))
        });
        due.first().map(|w| (*w).clone())
    }

    /// (a quiz you asked for: the most overdue word, whatever was last)
    pub fn next_due(&self, now: i64) -> Option<Value> {
        self.next_dream(now, "")
    }

    // a new review state from `step`: when it's next, from now
    fn step_to(
        &mut self,
        id: &str,
        step: i64,
        extra: Map<String, Value>,
        now: i64,
    ) -> Option<Value> {
        let old = self.get(id)?["review"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut r: Map<String, Value> = json!({ "step": 0, "seen": 0, "right": 0 })
            .as_object()
            .cloned()
            .unwrap_or_default();
        r.extend(old);
        r.extend(extra);
        let step = step.max(0);
        r.insert("step".into(), json!(step));
        r.insert("last".into(), json!(now));
        r.insert("due".into(), json!(now + gap_after(step)));
        self.mark_day(&local_day(now));
        self.update(
            id,
            crate::runtime::util::patch(vec![("review", Value::Object(r))]),
        )
    }

    /// It was just shown in a dream: one more time seen, and the next one further off.
    pub fn dreamt(&mut self, id: &str, now: i64) -> Option<Value> {
        let step = step_of(self.get(id)?);
        self.step_to(
            id,
            step + 1,
            crate::runtime::util::patch(vec![("dreamtAt", json!(now))]),
            now,
        )
    }

    /// "I know this one": it skips two steps ahead (so it comes back much later).
    pub fn know_it(&mut self, id: &str, now: i64) -> Option<Value> {
        let w = self.get(id)?;
        let (step, right) = (step_of(w), int(&w["review"]["right"]).unwrap_or(0));
        self.step_to(
            id,
            step + 2,
            crate::runtime::util::patch(vec![("right", json!(right + 1))]),
            now,
        )
    }

    /// A quiz you asked for: knew it, a step ahead; forgot, back to the start (30 minutes).
    pub fn answer(&mut self, id: &str, knew: bool, now: i64) -> Option<Value> {
        let r = &self.get(id)?["review"];
        let (step, seen, right) = (
            int(&r["step"]).unwrap_or(0),
            int(&r["seen"]).unwrap_or(0),
            int(&r["right"]).unwrap_or(0),
        );
        let extra = crate::runtime::util::patch(vec![
            ("seen", json!(seen + 1)),
            ("right", json!(right + i64::from(knew))),
        ]);
        self.step_to(id, if knew { step + 1 } else { 0 }, extra, now)
    }

    /// Not now (a quiz put off or left): it comes back after `wait`, its step unchanged.
    pub fn later(&mut self, id: &str, wait: i64, now: i64) -> Option<Value> {
        let mut r = self.get(id)?["review"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        r.insert("due".into(), json!(now + wait));
        self.update(
            id,
            crate::runtime::util::patch(vec![("review", Value::Object(r))]),
        )
    }

    /// You met it again (caught it once more): it clearly still matters, back to "2 hours".
    pub fn seen_again(&mut self, id: &str, now: i64) -> Option<Value> {
        let w = self.get(id)?;
        let due = int(&w["review"]["due"])
            .unwrap_or(i64::MAX)
            .min(now + gap_after(1));
        let step = int(&w["review"]["step"]).unwrap_or(1).min(1);
        let mut r = w["review"].as_object().cloned().unwrap_or_default();
        r.insert("step".into(), json!(step));
        r.insert("due".into(), json!(due));
        self.update(
            id,
            crate::runtime::util::patch(vec![
                ("review", Value::Object(r)),
                ("lastSeenAt", json!(now)),
            ]),
        )
    }

    /// The words to keep in sight (sticky notes, the monitor, sleep talk): the ones seen least
    /// first, newest first.
    pub fn in_sight(&self, n: usize) -> Vec<Value> {
        let mut ready = self.ready();
        ready.sort_by(|a, b| {
            step_of(a)
                .cmp(&step_of(b))
                .then(added_at(b).cmp(&added_at(a)))
        });
        ready.into_iter().take(n).cloned().collect()
    }

    /// The days you caught or reviewed a word (for the streak), the last few months.
    pub fn mark_day(&mut self, day: &str) {
        if !self.data["days"].is_array() {
            self.data["days"] = json!([]);
        }
        let Some(days) = self.data["days"].as_array_mut() else {
            return;
        };
        if days.last().and_then(Value::as_str) != Some(day) {
            days.push(json!(day));
        }
        if days.len() > DAYS_KEPT {
            let extra = days.len() - DAYS_KEPT;
            days.drain(..extra);
        }
        self.dirty = true;
    }

    /// How it's going: words, learnt (seen LEARNT_STEP times), due now, the streak of days in a row.
    pub fn stats(&self, now: i64) -> Value {
        let ready = self.ready();
        let days: HashSet<&str> = self.data["days"]
            .as_array()
            .map(|d| d.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let has = |d: NaiveDate| days.contains(d.format("%Y-%m-%d").to_string().as_str());
        let today = local_date(now);
        let mut d = today;
        if !has(d) {
            d = d.pred_opt().unwrap_or(d); // today not done yet: the streak still counts to yesterday
        }
        let mut streak = 0;
        while has(d) {
            streak += 1;
            match d.pred_opt() {
                Some(p) => d = p,
                None => break,
            }
        }
        json!({
            "total": self.count(),
            "learnt": ready.iter().filter(|w| step_of(w) >= LEARNT_STEP).count(),
            "learning": ready.iter().filter(|w| step_of(w) < LEARNT_STEP).count(),
            "due": ready.iter().filter(|w| due_of(w) <= now).count(),
            "reviewed": ready.iter().map(|w| int(&w["review"]["seen"]).unwrap_or(0)).sum::<i64>(),
            "streak": streak,
            "today": has(today),
        })
    }

    // ------------------------------------------------ what the windows show

    /// The words each robot keeps in sight: on sticky notes on its monitor, on its screen when
    /// it's idle, in its sleep talk (main.js sightWords).
    pub fn sight_words(&self) -> Value {
        Value::Array(
            self.in_sight(6)
                .iter()
                .map(|w| {
                    json!({
                        "id": w["id"], "word": w["word"],
                        "vi": w["senses"][0]["vi"].as_str().unwrap_or(""),
                        "phrase": w["phrases"][0]["phrase"].as_str().unwrap_or(""),
                        "box": step_of(w),
                    })
                })
                .collect(),
        )
    }
}

/// A row of the My words window: the card's main points and how well you know the word
/// (main.js wordRow; box: times seen).
pub fn word_row(w: &Value) -> Value {
    json!({
        "id": w["id"], "word": w["word"], "ipa": w["ipa"],
        "vi": meanings_vi(w),
        "pos": parts_of_speech(w),
        "status": w["status"],
        "addedAt": w["addedAt"],
        "box": step_of(w),
        "seen": int(&w["review"]["seen"]).unwrap_or(0),
        "right": int(&w["review"]["right"]).unwrap_or(0),
        "due": due_of(w),
    })
}

/// It, for a query a robot's chat asked with (list_words): in the word, or in a meaning.
pub fn matches(w: &Value, query: &str) -> bool {
    let q = norm(query);
    if q.is_empty() {
        return true;
    }
    let english = w["senses"]
        .as_array()
        .map(|s| {
            s.iter()
                .map(|x| crate::runtime::util::text(&x["en"]))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    [
        str_of(w, "word"),
        str_of(w, "text"),
        &meanings_vi(w),
        &english,
    ]
    .iter()
    .any(|t| norm(t).contains(&q))
}

/// One line about it for a robot's chat (list_words): the word, how it sounds, what it
/// means, and how far along you are with it.
pub fn chat_line(w: &Value) -> String {
    let word = if str_of(w, "word").is_empty() {
        str_of(w, "text")
    } else {
        str_of(w, "word")
    };
    let mut line = format!("- **{word}**");
    if !str_of(w, "ipa").is_empty() {
        line.push_str(&format!(" /{}/", str_of(w, "ipa").trim_matches('/')));
    }
    let pos = parts_of_speech(w);
    if !pos.is_empty() {
        line.push_str(&format!(" ({pos})"));
    }
    let english = crate::runtime::util::text(&w["senses"][0]["en"]);
    match (meanings_vi(w), english.is_empty()) {
        (vi, _) if !vi.is_empty() => line.push_str(&format!(
            ": {vi}{}",
            if english.is_empty() {
                String::new()
            } else {
                format!(" — {english}")
            }
        )),
        (_, false) => line.push_str(&format!(": {english}")),
        _ => {}
    }
    line.push_str(match str_of(w, "status") {
        "ready" if step_of(w) >= LEARNT_STEP => " · learnt",
        "ready" => "",
        "failed" => " · couldn't be looked up",
        _ => " · still being looked up",
    });
    line
}

/// The words looked up, as a CSV for Anki or Quizlet: word, meaning, pronunciation, a phrase
/// and its example (main.js words:export). With a BOM, so Excel reads the Vietnamese right.
pub fn csv(words: &[Value]) -> String {
    let cell = |v: &str| format!("\"{}\"", v.replace('"', "\"\""));
    let mut rows: Vec<Vec<String>> = vec![
        [
            "Word",
            "Meaning (Vietnamese)",
            "IPA",
            "Part of speech",
            "Phrase",
            "Example",
            "Example (Vietnamese)",
            "Synonyms",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    ];
    for w in words.iter().filter(|w| str_of(w, "status") == "ready") {
        let p = &w["phrases"][0];
        let t = crate::runtime::util::text;
        let (en, vi) = if !str_of(p, "example").is_empty() {
            (t(&p["example"]), t(&p["exampleVi"]))
        } else {
            (t(&w["examples"][0]["en"]), t(&w["examples"][0]["vi"]))
        };
        let synonyms = w["synonyms"]
            .as_array()
            .map(|s| {
                s.iter()
                    .map(|x| t(&x["word"]))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        rows.push(vec![
            t(&w["word"]),
            meanings_vi(w),
            t(&w["ipa"]),
            parts_of_speech(w),
            t(&p["phrase"]),
            en,
            vi,
            synonyms,
        ]);
    }
    let body = rows
        .iter()
        .map(|r| r.iter().map(|c| cell(c)).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\r\n");
    format!("\u{feff}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_790_000_000_000; // (a moment in 2026)

    fn ready_word(v: &mut Vocab, text: &str, now: i64) -> String {
        let w = v.add(text, "", "", now);
        let id = w["id"].as_str().unwrap().to_string();
        v.update(
            &id,
            crate::runtime::util::patch(vec![
                ("status", json!("ready")),
                (
                    "senses",
                    json!([{ "pos": "adj", "vi": "tỉ mỉ", "en": "careful" }]),
                ),
            ]),
        );
        id
    }

    #[test]
    fn the_gaps_grow() {
        assert_eq!(gap_after(-3), 30 * MIN);
        assert_eq!(gap_after(0), 30 * MIN);
        assert_eq!(gap_after(1), 2 * HOUR);
        assert_eq!(gap_after(3), DAY);
        assert_eq!(gap_after(8), 30 * DAY);
        assert_eq!(gap_after(50), 30 * DAY);
    }

    #[test]
    fn a_new_word_comes_back_in_half_an_hour() {
        let mut v = Vocab::from(None);
        let w = v.add("meticulous", "be meticulous", "Word", T0);
        assert_eq!(w["status"], "looking");
        assert_eq!(
            w["review"],
            json!({ "step": 0, "due": T0 + 30 * MIN, "seen": 0, "right": 0 })
        );
        assert!(v.dirty);
        assert_eq!(
            v.find("  Meticulous! ").map(|w| w["id"].clone()),
            Some(w["id"].clone())
        );
        assert!(v.find("...").is_none());
    }

    #[test]
    fn dreams_quizzes_and_later() {
        let mut v = Vocab::from(None);
        let id = ready_word(&mut v, "meticulous", T0);
        // dreamt: a step on, the next one 2 h later
        let w = v.dreamt(&id, T0 + MIN).unwrap();
        assert_eq!(step_of(&w), 1);
        assert_eq!(due_of(&w), T0 + MIN + 2 * HOUR);
        assert_eq!(w["review"]["dreamtAt"], T0 + MIN);
        // "I know this one": two steps on
        let w = v.know_it(&id, T0 + 2 * MIN).unwrap();
        assert_eq!(step_of(&w), 3);
        assert_eq!(w["review"]["right"], 1);
        assert_eq!(due_of(&w), T0 + 2 * MIN + DAY);
        // a quiz: knew it, one on; forgot, back to the start
        let w = v.answer(&id, true, T0 + 3 * MIN).unwrap();
        assert_eq!(
            (
                step_of(&w),
                w["review"]["seen"].clone(),
                w["review"]["right"].clone()
            ),
            (4, json!(1), json!(2))
        );
        let w = v.answer(&id, false, T0 + 4 * MIN).unwrap();
        assert_eq!(
            (
                step_of(&w),
                w["review"]["seen"].clone(),
                w["review"]["right"].clone()
            ),
            (0, json!(2), json!(2))
        );
        assert_eq!(due_of(&w), T0 + 4 * MIN + 30 * MIN);
        // put off: same step, later
        let w = v.later(&id, 2 * HOUR, T0 + 5 * MIN).unwrap();
        assert_eq!((step_of(&w), due_of(&w)), (0, T0 + 5 * MIN + 2 * HOUR));
    }

    #[test]
    fn met_again_comes_back_sooner() {
        let mut v = Vocab::from(None);
        let id = ready_word(&mut v, "diligent", T0);
        v.know_it(&id, T0); // step 2, due in 6 h
        let w = v.seen_again(&id, T0 + HOUR).unwrap();
        assert_eq!(step_of(&w), 1);
        assert_eq!(due_of(&w), T0 + HOUR + 2 * HOUR);
        assert_eq!(w["lastSeenAt"], T0 + HOUR);
        // already due sooner: stays sooner
        let w = v.seen_again(&id, T0 + HOUR + 1).unwrap();
        assert_eq!(due_of(&w), T0 + 3 * HOUR);
    }

    #[test]
    fn the_most_overdue_is_dreamt_first() {
        let mut v = Vocab::from(None);
        let a = ready_word(&mut v, "alpha", T0);
        let b = ready_word(&mut v, "beta", T0 + 1);
        let c = ready_word(&mut v, "gamma", T0 - HOUR); // due an hour earlier
        assert!(v.next_dream(T0 - HOUR, "").is_none()); // none due yet
        let now = T0 + 31 * MIN;
        assert_eq!(v.next_dream(now, "").unwrap()["id"], c.as_str());
        assert_eq!(v.next_dream(now, &c).unwrap()["id"], a.as_str()); // (the last one shown is skipped)
        v.later(&a, DAY, now);
        assert_eq!(v.next_dream(now, &c).unwrap()["id"], b.as_str());
        // due at the same moment: the newer word first
        v.later(&a, -MIN, now);
        v.later(&b, -MIN, now);
        assert_eq!(v.next_dream(now, &c).unwrap()["id"], b.as_str());
        // words still being looked up aren't dreamt of
        v.add("delta", "", "", T0 - DAY);
        assert_eq!(v.next_due(now).unwrap()["id"], c.as_str());
    }

    #[test]
    fn in_sight_least_seen_first() {
        let mut v = Vocab::from(None);
        let a = ready_word(&mut v, "alpha", T0);
        let b = ready_word(&mut v, "beta", T0 + 1);
        v.dreamt(&b, T0);
        v.dreamt(&b, T0);
        let c = ready_word(&mut v, "gamma", T0 + 2);
        let ids: Vec<Value> = v.in_sight(6).iter().map(|w| w["id"].clone()).collect();
        assert_eq!(ids, vec![json!(c), json!(a), json!(b)]);
        assert_eq!(v.in_sight(1).len(), 1);
        let sight = v.sight_words();
        assert_eq!(
            sight[0],
            json!({ "id": c, "word": "gamma", "vi": "tỉ mỉ", "phrase": "", "box": 0 })
        );
    }

    #[test]
    fn the_streak_counts_days_in_a_row() {
        let now = Local::now().timestamp_millis();
        let today = local_date(now);
        let day = |back: u64| {
            (today - chrono::Days::new(back))
                .format("%Y-%m-%d")
                .to_string()
        };
        let mut v = Vocab::from(Some(
            json!({ "words": [], "days": [day(5), day(3), day(2), day(1)] }),
        ));
        // today not done yet: still counts to yesterday
        assert_eq!(v.stats(now)["streak"], 3);
        assert_eq!(v.stats(now)["today"], false);
        v.mark_day(&day(0));
        v.mark_day(&day(0)); // (once a day)
        assert_eq!(v.data["days"].as_array().unwrap().len(), 5);
        assert_eq!(v.stats(now)["streak"], 4);
        assert_eq!(v.stats(now)["today"], true);
        // a gap breaks it
        let v = Vocab::from(Some(json!({ "words": [], "days": [day(3), day(2)] })));
        assert_eq!(v.stats(now)["streak"], 0);
    }

    #[test]
    fn stats_count_learnt_and_due() {
        let mut v = Vocab::from(None);
        let a = ready_word(&mut v, "alpha", T0);
        ready_word(&mut v, "beta", T0);
        v.add("gamma", "", "", T0); // (still looking: not counted as learning)
        for _ in 0..6 {
            v.dreamt(&a, T0);
        }
        v.answer(&a, true, T0);
        let s = v.stats(T0 + 31 * MIN);
        assert_eq!(
            (
                s["total"].clone(),
                s["learnt"].clone(),
                s["learning"].clone(),
                s["due"].clone(),
                s["reviewed"].clone()
            ),
            (json!(3), json!(1), json!(1), json!(1), json!(1))
        );
    }

    #[test]
    fn old_files_come_back_right() {
        let v = Vocab::from(Some(json!({ "words": [
            { "id": "a", "status": "looking", "review": { "box": 3, "due": 5 } },
            { "id": "b", "status": "ready", "review": { "box": 9 } },
            { "id": "c", "status": "ready", "review": { "step": 4 } },
        ] })));
        assert_eq!(v.get("a").unwrap()["status"], "failed");
        assert_eq!(step_of(v.get("a").unwrap()), 4);
        assert_eq!(step_of(v.get("b").unwrap()), 0);
        assert_eq!(step_of(v.get("c").unwrap()), 4);
    }

    #[test]
    fn lists_newest_first_and_removes() {
        let mut v = Vocab::from(None);
        let a = v.add("one", "", "", T0)["id"].as_str().unwrap().to_string();
        v.add("two", "", "", T0 + 5);
        assert_eq!(v.list()[0]["word"], "two");
        assert!(v.remove(&a));
        assert!(!v.remove(&a));
        assert_eq!(v.count(), 1);
    }

    #[test]
    fn normalising() {
        assert_eq!(norm("  Don't   GIVE-up!! "), "don't give-up");
        assert_eq!(norm("“meticulous,”"), "meticulous");
        assert_eq!(norm("Việt\tNam"), "việtnam"); // (a tab isn't a space)
    }

    #[test]
    fn rows_and_csv() {
        let w = json!({
            "id": "x", "word": "run", "ipa": "/rʌn/", "status": "ready", "addedAt": 1,
            "senses": [{ "pos": "verb", "vi": "chạy", "en": "move fast" }, { "pos": "noun", "vi": "cuộc chạy", "en": "a run" }, { "pos": "verb", "vi": "điều hành", "en": "manage" }],
            "phrases": [{ "phrase": "run a \"business\"", "vi": "điều hành", "example": "She runs a shop.", "exampleVi": "Cô ấy mở cửa hàng." }],
            "synonyms": [{ "word": "sprint" }, { "word": "dash" }],
            "review": { "step": 2, "due": 9, "seen": 1, "right": 1 },
        });
        let row = word_row(&w);
        assert_eq!(row["vi"], "chạy; cuộc chạy; điều hành");
        assert_eq!(row["pos"], "verb, noun");
        assert_eq!(
            (row["box"].clone(), row["due"].clone()),
            (json!(2), json!(9))
        );
        let old = json!({ "word": "go", "status": "ready", "senses": [], "examples": [{ "en": "Go!", "vi": "Đi!" }] });
        let looking = json!({ "word": "skip", "status": "looking" });
        let out = csv(&[w, old, looking]);
        assert!(out.starts_with('\u{feff}'));
        let lines: Vec<&str> = out.trim_start_matches('\u{feff}').split("\r\n").collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[0],
            "\"Word\",\"Meaning (Vietnamese)\",\"IPA\",\"Part of speech\",\"Phrase\",\"Example\",\"Example (Vietnamese)\",\"Synonyms\""
        );
        assert_eq!(
            lines[1],
            "\"run\",\"chạy; cuộc chạy; điều hành\",\"/rʌn/\",\"verb, noun\",\"run a \"\"business\"\"\",\"She runs a shop.\",\"Cô ấy mở cửa hàng.\",\"sprint, dash\""
        );
        assert_eq!(lines[2], "\"go\",\"\",\"\",\"\",\"\",\"Go!\",\"Đi!\",\"\"");
    }

    #[test]
    fn a_chat_reads_and_searches_your_words() {
        let mut v = Vocab::from(None);
        let id = ready_word(&mut v, "meticulous", T0);
        v.update(
            &id,
            crate::runtime::util::patch(vec![("ipa", json!("/məˈtɪkjələs/"))]),
        );
        let w = v.get(&id).unwrap().clone();
        assert_eq!(
            chat_line(&w),
            "- **meticulous** /məˈtɪkjələs/ (adj): tỉ mỉ — careful"
        );
        assert!(
            matches(&w, "")
                && matches(&w, "METIC")
                && matches(&w, "tỉ mỉ")
                && matches(&w, "careful")
        );
        assert!(!matches(&w, "run"));
        let looking = v.add("serendipity", "", "", T0);
        assert_eq!(
            chat_line(&looking),
            "- **serendipity** · still being looked up"
        );
    }
}
