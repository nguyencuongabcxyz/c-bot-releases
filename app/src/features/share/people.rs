//! What the people in a shared chat say to each other, beside the chat with Claude: talk, a
//! comment on a piece of the chat, a recommendation on a plan or a question waiting for the
//! host. All of it raw text, kept short, with what can't be seen shown as codes; none of it
//! ever reaches Claude unless the host puts it in a message. And what guests see of a decision
//! (only what it asks), checked at both ends. Pure, so it's tested here.

use serde_json::{Value, json};

use super::wire;

pub(super) const TALK_MAX: usize = 1000;
pub(super) const QUOTE_MAX: usize = 300;
pub(super) const WHY_MAX: usize = 500;
pub(super) const CHOICE_MAX: usize = 300;
/// What one person may say a minute (talk, comments and recommendations together).
pub(super) const PER_MINUTE: usize = 20;

const PLAN_MAX: usize = 20_000;
const QUESTIONS_MAX: usize = 4;
const OPTIONS_MAX: usize = 8;
const LINE_MAX: usize = 500;

/// Something said, ready to show: no control characters but line breaks, cut at `max`
/// characters, what can't be seen shown as its code. None when there's nothing to it.
pub(super) fn said(text: &str, max: usize) -> Option<String> {
    let t: String = text
        .trim()
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect();
    let t = wire::shown(t.trim());
    (!t.is_empty()).then_some(t)
}

/// Optional words (a why): the same, or empty.
pub(super) fn maybe(text: &str, max: usize) -> String {
    said(text, max).unwrap_or_default()
}

fn line(v: &Value, max: usize) -> String {
    maybe(v.as_str().unwrap_or(""), max)
}

fn request_id(v: &Value) -> Option<String> {
    let id = v.as_str()?;
    (!id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| id.to_string())
}

/// A plan or a question waiting for the host, as guests see it: what it asks and the choices,
/// nothing else (from a chat event, or as the other end sent it).
pub(super) fn decision_for_guests(ev: &Value) -> Option<Value> {
    let id = request_id(&ev["requestId"])?;
    match ev["type"].as_str().or(ev["kind"].as_str())? {
        "plan" => {
            let plan: String = ev["plan"].as_str()?.chars().take(PLAN_MAX).collect();
            Some(json!({ "requestId": id, "kind": "plan", "plan": plan }))
        }
        "question" => {
            let questions: Vec<Value> = ev["questions"]
                .as_array()?
                .iter()
                .take(QUESTIONS_MAX)
                .map(question_for_guests)
                .collect();
            (!questions.is_empty())
                .then(|| json!({ "requestId": id, "kind": "question", "questions": questions }))
        }
        _ => None,
    }
}

fn question_for_guests(q: &Value) -> Value {
    let options: Vec<Value> = q["options"]
        .as_array()
        .map(|o| {
            o.iter()
                .take(OPTIONS_MAX)
                .map(|o| json!({ "label": line(&o["label"], 120), "description": line(&o["description"], LINE_MAX) }))
                .collect()
        })
        .unwrap_or_default();
    json!({
        "question": line(&q["question"], LINE_MAX),
        "header": line(&q["header"], 40),
        "multiSelect": q["multiSelect"] == true,
        "options": options,
    })
}

/// A guest's name, told apart from the host's when it's the same (so nobody passes for the
/// host in the people's talk).
pub(super) fn guest_name(name: &str, host: &str) -> String {
    let name = if name.trim().is_empty() {
        "Guest"
    } else {
        name.trim()
    };
    if name.eq_ignore_ascii_case(host.trim()) {
        format!("{name} (guest)")
    } else {
        name.to_string()
    }
}

/// Text as it reads, for finding a quote in it: no markdown marks, spaces as one, any case
/// (what's selected in the chat is the rendered text, not the markdown behind it).
fn plain(s: &str) -> String {
    let marks: String = s
        .chars()
        .map(|c| if "*_`#>~|[]()".contains(c) { ' ' } else { c })
        .collect();
    marks
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Is the quote really in the chat (one of these texts: the tab's messages and answers)?
pub(super) fn quote_in<'a>(texts: impl IntoIterator<Item = &'a str>, quote: &str) -> bool {
    let q = plain(quote);
    !q.is_empty() && texts.into_iter().any(|t| plain(t).contains(&q))
}

/// What the host did about a question, in words for the guests ("answered: Yes").
pub(super) fn answered(answers: &Value) -> String {
    let picked: Vec<&str> = answers
        .as_object()
        .map(|m| m.values().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let picked = picked.join(", ");
    if picked.is_empty() {
        "answered".into()
    } else {
        format!("answered: {}", maybe(&picked, CHOICE_MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_people_say_is_trimmed_cut_and_shown_plainly() {
        assert_eq!(said("  hi\u{7}  there ", 100).as_deref(), Some("hi  there"));
        assert_eq!(said("a\nb", 100).as_deref(), Some("a\nb"));
        assert_eq!(said("   ", 100), None);
        assert_eq!(said("abcdef", 3).as_deref(), Some("abc"));
        assert_eq!(said("x\u{200B}y", 100).as_deref(), Some("x⟨U+200B⟩y"));
        assert_eq!(maybe("", 10), "");
    }

    #[test]
    fn a_plan_keeps_only_what_it_asks() {
        let ev = json!({ "type": "plan", "requestId": "r-1", "plan": "1. Do it", "file": "C:\\secret\\plan.md", "tabId": "t" });
        assert_eq!(
            decision_for_guests(&ev),
            Some(json!({ "requestId": "r-1", "kind": "plan", "plan": "1. Do it" }))
        );
        // (as the host sent it on: the same again)
        let again = decision_for_guests(&ev).unwrap();
        assert_eq!(decision_for_guests(&again), Some(again));
    }

    #[test]
    fn a_question_keeps_its_choices_and_nothing_else() {
        let ev = json!({ "type": "question", "requestId": "q1", "questions": [{
            "question": "Which DB?", "header": "DB", "multiSelect": false, "extra": 1,
            "options": [{ "label": "Postgres", "description": "Safe", "preview": "<b>x</b>" }, { "label": "SQLite" }],
        }] });
        let d = decision_for_guests(&ev).unwrap();
        assert_eq!(d["kind"], "question");
        assert_eq!(d["questions"][0]["question"], "Which DB?");
        assert_eq!(d["questions"][0].get("extra"), None);
        assert_eq!(
            d["questions"][0]["options"][0],
            json!({ "label": "Postgres", "description": "Safe" })
        );
        assert_eq!(d["questions"][0]["options"][1]["description"], "");
    }

    #[test]
    fn odd_decisions_are_dropped() {
        assert_eq!(
            decision_for_guests(&json!({ "type": "plan", "requestId": "a b", "plan": "x" })),
            None
        );
        assert_eq!(
            decision_for_guests(&json!({ "type": "plan", "requestId": "r" })),
            None
        );
        assert_eq!(
            decision_for_guests(&json!({ "type": "question", "requestId": "r", "questions": [] })),
            None
        );
        assert_eq!(
            decision_for_guests(&json!({ "type": "tool", "requestId": "r" })),
            None
        );
    }

    #[test]
    fn a_guest_named_like_the_host_is_told_apart() {
        assert_eq!(guest_name("Cuong", "cuong"), "Cuong (guest)");
        assert_eq!(guest_name("Minh", "Cuong"), "Minh");
        assert_eq!(guest_name("  ", "Cuong"), "Guest");
    }

    #[test]
    fn a_quote_is_found_as_it_reads_not_as_its_markdown() {
        let chat = ["Fixed! `formatPrice` in **src/cart.js** now uses\n`toFixed(2)`."];
        assert!(quote_in(
            chat,
            "formatPrice in src/cart.js now uses toFixed(2)"
        ));
        assert!(quote_in(chat, "FORMATPRICE"));
        assert!(!quote_in(chat, "it's safe to drop the table"));
        assert!(!quote_in(chat, "  "));
    }

    #[test]
    fn an_answer_is_said_in_words() {
        assert_eq!(
            answered(&json!({ "Which DB?": "Postgres" })),
            "answered: Postgres"
        );
        assert_eq!(answered(&json!({})), "answered");
    }
}
