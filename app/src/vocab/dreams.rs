//! When a robot dreams of one of your words (main reminders.js): now and then during your
//! working hours a sleeping robot dreams of one that's due (words.rs keeps when each comes
//! back). Only while you're at the PC: not while it's locked or you're away, and not while
//! Windows says you're busy (presenting, a full-screen game or video, Focus). A word that's
//! due waits for the next robot that dozes off. At most one dream every 20 minutes, twelve
//! a day; the first a few minutes after C-Bot starts.

use serde_json::Value;

use super::words::MIN;

pub const TICK_MS: u64 = 30_000;
const DREAM_GAP: i64 = 20 * MIN; // at most one dream this often
const DREAMS_A_DAY: u32 = 12;
pub const AWAY_AFTER: u64 = 120; // s without touching mouse or keyboard: you're not there

// (not in windows-sys's features this crate turns on)
#[link(name = "user32")]
unsafe extern "system" {
    fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut core::ffi::c_void;
    fn CloseDesktop(desktop: *mut core::ffi::c_void) -> i32;
}
const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;

/// The desktop is locked (or the secure desktop is up): it doesn't take input.
pub fn locked() -> bool {
    // SAFETY: plain calls; the desktop handle is closed again straight away.
    unsafe {
        let desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desk.is_null() {
            return true;
        }
        CloseDesktop(desk);
        false
    }
}

/// You're at the PC and Windows would let something pop up.
pub fn present() -> bool {
    !locked() && crate::walkers::idle_secs() < AWAY_AFTER && crate::capture::accepts_notifications()
}

/// Within your working hours (settings.vocabHours, [9, 18] unless set)?
pub fn in_hours(settings: &Value, hour: u32, minute: u32) -> bool {
    let hours = settings["vocabHours"].as_array().filter(|h| h.len() == 2);
    let (from, to) = match hours.map(|h| (h[0].as_f64(), h[1].as_f64())) {
        Some((Some(a), Some(b))) => (a, b),
        _ => (9.0, 18.0),
    };
    let h = hour as f64 + minute as f64 / 60.0;
    h >= from && h < to
}

/// Dreams aren't turned off (settings.vocabReminders).
pub fn enabled(settings: &Value) -> bool {
    settings["vocabReminders"] != Value::Bool(false)
}

/// How many dreams today, when the last was and of which word.
pub struct DreamClock {
    last_at: i64,
    last_word: String,
    day: String,
    today: u32,
}

impl DreamClock {
    pub fn new(now: i64, day: &str) -> DreamClock {
        // the first one a few minutes after C-Bot starts
        DreamClock { last_at: now - DREAM_GAP + 3 * MIN, last_word: String::new(), day: day.to_string(), today: 0 }
    }

    /// May a robot dream now? (`ok`: dreams are on, you're in your hours, at the PC, and no
    /// quiz you asked for is up.) If so, the word not to show again (the last one).
    pub fn may_dream(&mut self, now: i64, day: &str, ok: bool) -> Option<String> {
        if self.day != day {
            self.day = day.to_string();
            self.today = 0;
        }
        if !ok || self.today >= DREAMS_A_DAY || now - self.last_at < DREAM_GAP {
            return None;
        }
        Some(self.last_word.clone())
    }

    /// A robot dreamt of this word.
    pub fn dreamt(&mut self, now: i64, word_id: &str) {
        self.last_at = now;
        self.last_word = word_id.to_string();
        self.today += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn working_hours() {
        let s = json!({});
        assert!(!in_hours(&s, 8, 59));
        assert!(in_hours(&s, 9, 0));
        assert!(in_hours(&s, 17, 59));
        assert!(!in_hours(&s, 18, 0));
        let s = json!({ "vocabHours": [0, 24] });
        assert!(in_hours(&s, 0, 0) && in_hours(&s, 23, 59));
        assert!(enabled(&json!({})) && enabled(&json!({ "vocabReminders": true })));
        assert!(!enabled(&json!({ "vocabReminders": false })));
    }

    #[test]
    fn first_dream_a_few_minutes_in_then_every_twenty() {
        let t0 = 1_000_000_000;
        let mut c = DreamClock::new(t0, "d1");
        assert_eq!(c.may_dream(t0 + 2 * MIN, "d1", true), None);
        assert_eq!(c.may_dream(t0 + 3 * MIN, "d1", true), Some(String::new()));
        assert_eq!(c.may_dream(t0 + 3 * MIN, "d1", false), None); // (not now: away, a quiz up…)
        c.dreamt(t0 + 3 * MIN, "w1");
        assert_eq!(c.may_dream(t0 + 22 * MIN, "d1", true), None);
        assert_eq!(c.may_dream(t0 + 23 * MIN, "d1", true), Some("w1".into()));
    }

    #[test]
    fn twelve_a_day() {
        let mut c = DreamClock::new(0, "d1");
        let mut t = 3 * MIN;
        for i in 0..12 {
            assert!(c.may_dream(t, "d1", true).is_some(), "dream {i}");
            c.dreamt(t, "w");
            t += 20 * MIN;
        }
        assert_eq!(c.may_dream(t, "d1", true), None);
        assert!(c.may_dream(t, "d2", true).is_some()); // a new day
    }
}
