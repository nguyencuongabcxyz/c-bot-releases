//! The English for something in Vietnamese (Find the English: find.rs), from Claude's quick
//! model in two quick steps: the words first (a line each: the word, how it comes across and a
//! few Vietnamese words for it), then each one's details (its IPA, its nuance, an example) a
//! line at a time as they're written, and a tip on which to pick. Plain text, not a JSON
//! schema: a schema costs the model a second turn, and the words are what you're waiting for.

use super::*;

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::lookup::Warm;
use super::words::norm;

/// What you typed, as the question (cut to this many characters).
pub(super) const MAX_ASKED: usize = 300;
const MAX_CHOICES: usize = 5;

/// How an English choice comes across (its tag's colour on the window).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Feel {
    Positive,
    #[default]
    Neutral,
    Negative,
    Formal,
    Casual,
}

/// One English word or phrase for what you typed: from the first step, the word, how it comes
/// across and a few Vietnamese words for it (gloss); once its details are in (ready), its IPA,
/// part of speech, nuance (vi) and an example. saved: its id in My words, if it's there.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Choice {
    pub word: String,
    pub feel: Feel,
    pub tone: String,
    pub gloss: String,
    pub ipa: String,
    pub pos: String,
    pub vi: String,
    pub example: String,
    pub ready: bool,
    pub saved: Option<String>,
}

/// The English for what you typed. id: which search it is (the details that follow say so);
/// complete: the details are in too (a search made before).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct English {
    pub id: u64,
    pub choices: Vec<Choice>,
    pub tip: String,
    pub complete: bool,
}

pub(super) const WORDS_SYSTEM: &str = concat!(
    "You help a Vietnamese speaker who is learning English find the English for what they want to say. ",
    "Given Vietnamese (a word, a phrase, an idiom or a sentence), reply with the 3 to 5 English words or phrases a native speaker would really use for it, the most natural and common first; ",
    "for an idiom or a saying, English idioms or phrases with the same meaning, never word for word; for a sentence, the English for its key word or phrase. ",
    "Reply with one line per choice and nothing else, each exactly: word | feel | tone | nghĩa. ",
    "feel is one of: positive, neutral, negative, formal, casual. tone is 1 or 2 English words (praise, at work, slang, too picky…). ",
    "nghĩa is its meaning in 2 to 6 Vietnamese words (tiếng Việt, never English). ",
    "For example, for \"ngại\": reluctant | neutral | everyday | ngần ngại, không muốn",
);

pub(super) const DETAILS_SYSTEM: &str = concat!(
    "You explain English words to a Vietnamese speaker who is learning English. ",
    "For each English word or phrase given, in the same order, reply with one line of JSON and nothing else: ",
    "{\"word\": the word, \"ipa\": its US IPA, \"pos\": adj, verb, noun, phrase, idiom…, ",
    "\"vi\": one short Vietnamese sentence on its meaning and the nuance that sets it apart from the others, ",
    "\"example\": a natural everyday English sentence using exactly it}. ",
    "Then one last line: {\"tip\": one or two short Vietnamese sentences on which to use when}.",
);

fn asked(text: &str) -> String {
    text.trim().chars().take(MAX_ASKED).collect()
}

/// The first question: what you typed.
pub(super) fn words_prompt(text: &str) -> String {
    format!("Vietnamese: \"{}\"", asked(text))
}

/// The second: what you typed and the words that came back.
pub(super) fn details_prompt(text: &str, choices: &[Choice]) -> String {
    let words: Vec<&str> = choices.iter().map(|c| c.word.as_str()).collect();
    format!(
        "Vietnamese: \"{}\"\nEnglish: {}",
        asked(text),
        words.join("; ")
    )
}

fn cut(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// A list's marker at the start of a line ("1. ", "- ", "• "), and bold's stars.
fn marker_re() -> &'static Regex {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*(?:[-*•]|\d+[.)])\s+").expect("a valid regex"));
    &RE
}

/// The words in the first answer (a line each: word | feel | tone | meaning); lines that
/// aren't one are skipped, and so is a word twice.
pub(super) fn words_of(answer: &str) -> Vec<Choice> {
    let mut out: Vec<Choice> = vec![];
    for line in answer.lines() {
        let line = marker_re().replace(line, "").replace("**", "");
        let parts: Vec<&str> = line.split('|').map(str::trim).collect();
        let word = cut(parts[0], 80);
        if parts.len() < 2 || word.is_empty() || out.iter().any(|c| norm(&c.word) == norm(&word)) {
            continue;
        }
        out.push(Choice {
            word,
            feel: serde_json::from_value(json!(parts[1].to_lowercase())).unwrap_or_default(),
            tone: cut(parts.get(2).unwrap_or(&""), 40),
            gloss: cut(parts.get(3).unwrap_or(&""), 120),
            ..Choice::default()
        });
        if out.len() == MAX_CHOICES {
            break;
        }
    }
    out
}

/// A line of the second answer: one word's details (merged into its choice, at its index), or
/// the tip.
#[derive(Debug, PartialEq)]
pub(super) enum Detail {
    Choice(usize, Choice),
    Tip(String),
}

/// What a line of the second answer says: the details of the choice it names (else of the
/// next one still without them), or the tip. None for anything else (a code fence, chatter).
pub(super) fn detail_of(line: &str, choices: &[Choice]) -> Option<Detail> {
    let line = line.trim().trim_end_matches(',');
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if let Some(tip) = v.get("tip") {
        return Some(Detail::Tip(cut(&text(tip), 600)));
    }
    let named = norm(&text(&v["word"]));
    let at = choices
        .iter()
        .position(|c| !c.ready && norm(&c.word) == named)
        .or_else(|| choices.iter().position(|c| !c.ready))?;
    let mut c = choices[at].clone();
    c.ipa = cut(&text(&v["ipa"]), 80);
    c.pos = cut(&text(&v["pos"]), 30);
    c.vi = cut(&text(&v["vi"]), 400);
    c.example = cut(&text(&v["example"]), 400);
    c.ready = true;
    Some(Detail::Choice(at, c))
}

/// The first step, on a quick model started for it (WORDS_SYSTEM).
pub(super) fn ask_words(warm: Warm, text: &str) -> Result<Vec<Choice>, String> {
    let answer = warm.ask(json!(words_prompt(text)), |_| {})?;
    let words = words_of(&answer);
    if words.is_empty() {
        return Err("No English came back. Try it another way?".into());
    }
    Ok(words)
}

/// The second, on one started for it (DETAILS_SYSTEM): each choice's details into it, and to
/// on_choice, as soon as they're written. The tip (empty if none came).
pub(super) fn ask_details(
    warm: Warm,
    text: &str,
    choices: &mut [Choice],
    mut on_choice: impl FnMut(usize, &Choice),
) -> Result<String, String> {
    let prompt = details_prompt(text, choices);
    let mut tip = String::new();
    warm.ask(json!(prompt), |line| match detail_of(line, choices) {
        Some(Detail::Choice(at, c)) => {
            choices[at] = c;
            on_choice(at, &choices[at]);
        }
        Some(Detail::Tip(t)) => tip = t,
        None => {}
    })?;
    Ok(tip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(word: &str) -> Choice {
        Choice {
            word: word.into(),
            ..Choice::default()
        }
    }

    #[test]
    fn the_questions() {
        assert_eq!(words_prompt("  tỉ mỉ "), "Vietnamese: \"tỉ mỉ\"");
        let long = "a".repeat(MAX_ASKED + 50);
        assert_eq!(words_prompt(&long).chars().count(), MAX_ASKED + 14);
        assert_eq!(
            details_prompt("tỉ mỉ", &[choice("meticulous"), choice("thorough")]),
            "Vietnamese: \"tỉ mỉ\"\nEnglish: meticulous; thorough"
        );
    }

    #[test]
    fn the_words_from_their_lines() {
        let w = words_of(
            "meticulous | positive | praise | cẩn thận, kỹ lưỡng\nthorough|neutral|at work|kỹ càng",
        );
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].word, "meticulous");
        assert_eq!(w[0].feel, Feel::Positive);
        assert_eq!(w[0].tone, "praise");
        assert_eq!(w[0].gloss, "cẩn thận, kỹ lưỡng");
        assert!(!w[0].ready);
        assert_eq!(w[1].tone, "at work");
    }

    #[test]
    fn the_words_tidied() {
        let w = words_of(
            "Here you go:\n1. **meticulous** | Positive | praise | tỉ mỉ\n- fussy | grumpy\n\n• meticulous | neutral | x | y\n| neutral |",
        );
        let words: Vec<&str> = w.iter().map(|c| c.word.as_str()).collect();
        assert_eq!(words, ["meticulous", "fussy"]); // (no chatter, no twice, none empty)
        assert_eq!(w[0].feel, Feel::Positive);
        assert_eq!(w[1].feel, Feel::Neutral); // (one it doesn't know)
        assert_eq!(w[1].gloss, "");
    }

    #[test]
    fn at_most_five_words() {
        let lines: Vec<String> = (0..8).map(|i| format!("w{i} | neutral | t | m")).collect();
        assert_eq!(words_of(&lines.join("\n")).len(), MAX_CHOICES);
    }

    #[test]
    fn a_line_of_details() {
        let choices = [choice("meticulous"), choice("thorough")];
        let line = r#"{"word": "Thorough", "ipa": "/ˈθɝːoʊ/", "pos": "adj", "vi": "kỹ lưỡng", "example": "A thorough check."},"#;
        let Some(Detail::Choice(at, c)) = detail_of(line, &choices) else {
            panic!("a choice's details");
        };
        assert_eq!(at, 1); // (the one it names)
        assert!(c.ready);
        assert_eq!(c.word, "thorough");
        assert_eq!(c.ipa, "/ˈθɝːoʊ/");
        assert_eq!(c.example, "A thorough check.");
    }

    #[test]
    fn details_for_a_word_it_renamed_go_to_the_next() {
        let mut choices = [choice("meticulous"), choice("thorough")];
        choices[0].ready = true;
        let Some(Detail::Choice(at, _)) = detail_of(r#"{"word": "careful"}"#, &choices) else {
            panic!("a choice's details");
        };
        assert_eq!(at, 1);
        choices[1].ready = true;
        assert_eq!(detail_of(r#"{"word": "careful"}"#, &choices), None); // (all have theirs)
    }

    #[test]
    fn the_tip_and_the_rest() {
        let choices = [choice("meticulous")];
        assert_eq!(
            detail_of(r#"{"tip": "Khen: meticulous."}"#, &choices),
            Some(Detail::Tip("Khen: meticulous.".into()))
        );
        assert_eq!(detail_of("```json", &choices), None);
        assert_eq!(detail_of("Sure! Here they are:", &choices), None);
        assert_eq!(detail_of("{not json", &choices), None);
    }

    #[test]
    fn as_the_page_reads_it() {
        let e = English {
            id: 3,
            choices: vec![Choice {
                word: "fussy".into(),
                feel: Feel::Negative,
                saved: Some("id1".into()),
                ..Choice::default()
            }],
            tip: String::new(),
            complete: false,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "id": 3, "choices": [{ "word": "fussy", "feel": "negative", "tone": "", "gloss": "", "ipa": "", "pos": "", "vi": "", "example": "", "ready": false, "saved": "id1" }], "tip": "", "complete": false })
        );
    }

    // Both steps for real, with Claude Code (the user's account), timed:
    // cargo test -- --ignored real_english --nocapture
    #[test]
    #[ignore]
    fn real_english() {
        let t = std::time::Instant::now();
        let warm = Warm::start("", WORDS_SYSTEM, false).expect("started");
        let mut words = ask_words(warm, "tỉ mỉ").expect("the words");
        println!("words in {:?}: {words:?}", t.elapsed());
        let warm = Warm::start("", DETAILS_SYSTEM, true).expect("started");
        let tip = ask_details(warm, "tỉ mỉ", &mut words, |at, c| {
            println!("{:?}: {at} {} {}", t.elapsed(), c.word, c.example);
        })
        .expect("the details");
        println!("tip in {:?}: {tip}", t.elapsed());
        assert!(words.iter().all(|c| c.ready));
    }
}
