//! When a routine runs: at set times on some days, every few hours between two times, or
//! once. Times are your local clock's, without a time zone (a slot is "2026-10-29T08:00"),
//! so a routine set for 08:00 stays at 08:00 when you travel or the clocks change.

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, TimeDelta};
use serde::{Deserialize, Serialize};

const SLOT: &str = "%Y-%m-%dT%H:%M";
const LOOK_BACK_DAYS: i64 = 8; // (a week, and a day)
const LOOK_AHEAD_DAYS: i64 = 15;
/// Without catching up, a slot still runs this long after its time (the clock looks once a
/// minute; the PC may be a moment late waking up).
const GRACE: TimeDelta = TimeDelta::minutes(10);

/// When a routine runs. days: 1 = Monday … 7 = Sunday (none: every day).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum When {
    Daily {
        #[serde(default)]
        days: Vec<u8>,
        times: Vec<String>,
    },
    Every {
        hours: u32,
        from: String,
        to: String,
        #[serde(default)]
        days: Vec<u8>,
    },
    Once {
        at: String,
    },
}

/// "08:00" (or "8:00").
pub fn hm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

pub fn slot(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s.trim(), SLOT).ok()
}

pub fn slot_text(t: NaiveDateTime) -> String {
    t.format(SLOT).to_string()
}

/// "Wed 29 Oct 08:00".
pub fn slot_label(t: NaiveDateTime) -> String {
    t.format("%a %-d %b %H:%M").to_string()
}

fn on_day(days: &[u8], d: NaiveDate) -> bool {
    days.is_empty() || days.contains(&(d.weekday().number_from_monday() as u8))
}

fn days_label(days: &[u8]) -> String {
    const NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let mut d: Vec<u8> = days
        .iter()
        .copied()
        .filter(|d| (1..=7).contains(d))
        .collect();
    d.sort_unstable();
    d.dedup();
    match d.as_slice() {
        [] | [1, 2, 3, 4, 5, 6, 7] => "Every day".into(),
        [1, 2, 3, 4, 5] => "Weekdays".into(),
        [6, 7] => "Weekends".into(),
        _ => d
            .iter()
            .map(|d| NAMES[*d as usize - 1])
            .collect::<Vec<_>>()
            .join(", "),
    }
}

impl When {
    /// Its times on this day, in order.
    fn slots_on(&self, d: NaiveDate) -> Vec<NaiveDateTime> {
        let mut out: Vec<NaiveDateTime> = match self {
            When::Daily { days, times } if on_day(days, d) => times
                .iter()
                .filter_map(|t| hm(t))
                .map(|t| d.and_time(t))
                .collect(),
            When::Every {
                hours,
                from,
                to,
                days,
            } if on_day(days, d) && *hours > 0 => {
                let (Some(from), Some(to)) = (hm(from), hm(to)) else {
                    return vec![];
                };
                let (mut t, end) = (d.and_time(from), d.and_time(to));
                let mut v = vec![];
                while t <= end {
                    v.push(t);
                    t += TimeDelta::hours(*hours as i64);
                }
                v
            }
            When::Once { at } => slot(at).filter(|t| t.date() == d).into_iter().collect(),
            _ => vec![],
        };
        out.sort();
        out.dedup();
        out
    }

    /// The last time it was meant to run, up to now.
    pub fn latest(&self, now: NaiveDateTime) -> Option<NaiveDateTime> {
        (0..=LOOK_BACK_DAYS)
            .filter_map(|back| {
                let d = now.date() - TimeDelta::days(back);
                self.slots_on(d).into_iter().filter(|t| *t <= now).max()
            })
            .next()
    }

    /// The next few times it runs, after now.
    pub fn next(&self, now: NaiveDateTime, n: usize) -> Vec<NaiveDateTime> {
        (0..=LOOK_AHEAD_DAYS)
            .flat_map(|ahead| self.slots_on(now.date() + TimeDelta::days(ahead)))
            .filter(|t| *t > now)
            .take(n)
            .collect()
    }

    /// "Weekdays · 08:00, 17:30", "Every 2h · 09:00–18:00", "Once · Thu 30 Oct 14:00".
    pub fn label(&self) -> String {
        match self {
            When::Daily { days, times } => {
                let mut t: Vec<NaiveTime> = times.iter().filter_map(|t| hm(t)).collect();
                t.sort();
                let t: Vec<String> = t.iter().map(|t| t.format("%H:%M").to_string()).collect();
                format!("{} · {}", days_label(days), t.join(", "))
            }
            When::Every {
                hours,
                from,
                to,
                days,
            } => {
                let d = days_label(days);
                let d = if d == "Every day" {
                    String::new()
                } else {
                    format!("{d} · ")
                };
                format!("{d}Every {hours}h · {from}–{to}")
            }
            When::Once { at } => match slot(at) {
                Some(t) => format!("Once · {}", slot_label(t)),
                None => "Once".into(),
            },
        }
    }

    /// What's wrong with it, if anything (a plain sentence for the user or their robot).
    pub fn problem(&self) -> Option<String> {
        let bad_day = |days: &[u8]| days.iter().any(|d| !(1..=7).contains(d));
        match self {
            When::Daily { days, times } => {
                if times.is_empty() {
                    return Some("Give it at least one time of day.".into());
                }
                if let Some(t) = times.iter().find(|t| hm(t).is_none()) {
                    return Some(format!("“{t}” isn't a time like 08:00."));
                }
                bad_day(days).then(|| "Days go from 1 (Monday) to 7 (Sunday).".into())
            }
            When::Every {
                hours,
                from,
                to,
                days,
            } => {
                if !(1..=24).contains(hours) {
                    return Some("Every 1 to 24 hours.".into());
                }
                match (hm(from), hm(to)) {
                    (Some(f), Some(t)) if f <= t => {
                        bad_day(days).then(|| "Days go from 1 (Monday) to 7 (Sunday).".into())
                    }
                    (Some(_), Some(_)) => Some("The start time is after the end time.".into()),
                    _ => Some("Times look like 09:00.".into()),
                }
            }
            When::Once { at } => slot(at)
                .is_none()
                .then(|| format!("“{at}” isn't a date and time like 2026-10-30T14:00.")),
        }
    }
}

/// The slot to run now, if one is due: the last one up to now, made after the routine was
/// (created), not run yet (last). One that was missed (the PC asleep, C-Bot not running)
/// runs when you're back if it may catch up, as long as it's the same day (a one-off, any
/// day); otherwise only just after its time.
pub fn due(
    when: &When,
    created: NaiveDateTime,
    last: Option<NaiveDateTime>,
    now: NaiveDateTime,
    catch_up: bool,
) -> Option<NaiveDateTime> {
    let s = when.latest(now)?;
    if s < created - TimeDelta::minutes(1) || last.is_some_and(|l| l >= s) {
        return None;
    }
    let fresh = now - s <= GRACE;
    let late_ok = catch_up && (matches!(when, When::Once { .. }) || s.date() == now.date());
    (fresh || late_ok).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> NaiveDateTime {
        slot(s).unwrap()
    }

    fn weekdays_8_and_1730() -> When {
        When::Daily {
            days: vec![1, 2, 3, 4, 5],
            times: vec!["17:30".into(), "08:00".into()],
        }
    }

    #[test]
    fn the_json() {
        let w = weekdays_8_and_1730();
        assert_eq!(
            serde_json::to_value(&w).unwrap(),
            serde_json::json!({ "kind": "daily", "days": [1, 2, 3, 4, 5], "times": ["17:30", "08:00"] })
        );
        let e: When = serde_json::from_value(
            serde_json::json!({ "kind": "every", "hours": 2, "from": "09:00", "to": "18:00" }),
        )
        .unwrap();
        assert_eq!(
            e,
            When::Every {
                hours: 2,
                from: "09:00".into(),
                to: "18:00".into(),
                days: vec![]
            }
        );
        let o: When =
            serde_json::from_value(serde_json::json!({ "kind": "once", "at": "2026-10-30T14:00" }))
                .unwrap();
        assert_eq!(o.label(), "Once · Fri 30 Oct 14:00");
    }

    #[test]
    fn latest_and_next() {
        let w = weekdays_8_and_1730();
        // Wed 28 Oct 2026, 12:00
        assert_eq!(w.latest(t("2026-10-28T12:00")), Some(t("2026-10-28T08:00")));
        assert_eq!(w.latest(t("2026-10-28T07:59")), Some(t("2026-10-27T17:30")));
        // Monday morning: Friday's evening one
        assert_eq!(w.latest(t("2026-11-02T07:00")), Some(t("2026-10-30T17:30")));
        assert_eq!(
            w.next(t("2026-10-30T18:00"), 3),
            [
                t("2026-11-02T08:00"),
                t("2026-11-02T17:30"),
                t("2026-11-03T08:00")
            ]
        );
        let e = When::Every {
            hours: 4,
            from: "09:00".into(),
            to: "18:00".into(),
            days: vec![],
        };
        assert_eq!(
            e.next(t("2026-10-28T12:00"), 3),
            [
                t("2026-10-28T13:00"),
                t("2026-10-28T17:00"),
                t("2026-10-29T09:00")
            ]
        );
        let o = When::Once {
            at: "2026-10-30T14:00".into(),
        };
        assert_eq!(o.latest(t("2026-10-30T13:00")), None);
        assert_eq!(o.next(t("2026-10-30T13:00"), 3), [t("2026-10-30T14:00")]);
        assert_eq!(o.next(t("2026-10-30T15:00"), 3), []);
    }

    #[test]
    fn when_its_due() {
        let w = weekdays_8_and_1730();
        let made = t("2026-10-01T09:00");
        // on time, then not again
        assert_eq!(
            due(&w, made, None, t("2026-10-28T08:00"), false),
            Some(t("2026-10-28T08:00"))
        );
        assert_eq!(
            due(
                &w,
                made,
                Some(t("2026-10-28T08:00")),
                t("2026-10-28T08:01"),
                true
            ),
            None
        );
        // missed it: caught up later the same day, or not at all
        let last = Some(t("2026-10-27T17:30"));
        assert_eq!(
            due(&w, made, last, t("2026-10-28T11:00"), true),
            Some(t("2026-10-28T08:00"))
        );
        assert_eq!(due(&w, made, last, t("2026-10-28T11:00"), false), None);
        assert_eq!(
            due(&w, made, last, t("2026-10-28T08:09"), false),
            Some(t("2026-10-28T08:00"))
        );
        // yesterday evening's, this morning: not any more
        assert_eq!(
            due(
                &w,
                made,
                Some(t("2026-10-27T08:00")),
                t("2026-10-28T07:00"),
                true
            ),
            None
        );
        // made after today's time: from the next one on
        assert_eq!(
            due(&w, t("2026-10-28T09:00"), None, t("2026-10-28T10:00"), true),
            None
        );
        // a one-off catches up whenever
        let o = When::Once {
            at: "2026-10-28T14:00".into(),
        };
        assert_eq!(
            due(&o, made, None, t("2026-10-29T09:00"), true),
            Some(t("2026-10-28T14:00"))
        );
    }

    #[test]
    fn labels_and_problems() {
        assert_eq!(weekdays_8_and_1730().label(), "Weekdays · 08:00, 17:30");
        let every = |days: Vec<u8>| When::Every {
            hours: 2,
            from: "09:00".into(),
            to: "18:00".into(),
            days,
        };
        assert_eq!(every(vec![]).label(), "Every 2h · 09:00–18:00");
        assert_eq!(
            every(vec![6, 7]).label(),
            "Weekends · Every 2h · 09:00–18:00"
        );
        let d = When::Daily {
            days: vec![5, 1],
            times: vec!["16:00".into()],
        };
        assert_eq!(d.label(), "Mon, Fri · 16:00");
        assert_eq!(d.problem(), None);
        let d = When::Daily {
            days: vec![],
            times: vec!["8am".into()],
        };
        assert_eq!(d.problem().unwrap(), "“8am” isn't a time like 08:00.");
        let e = When::Every {
            hours: 2,
            from: "18:00".into(),
            to: "09:00".into(),
            days: vec![],
        };
        assert!(e.problem().is_some());
    }
}
