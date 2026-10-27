//! Looking a word up, and reading one off a picture, with Claude Code's small, quick model
//! (main vocab.js lookup / readPicture): Vietnamese meanings, phrases with examples, verb
//! forms, synonyms, the word family. Each question is one `claude -p` with a JSON schema,
//! streamed in and out, so the answer is read the moment it's ready (waiting for the process
//! to exit instead costs a few seconds of shutdown every time).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::agents::claude::{clean_env, Killer};
use crate::platform::process::NoWindow;
use super::words::norm;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(60);

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "word": { "type": "string", "description": "the dictionary form (lemma) of the word or phrase" },
            "ipa": { "type": "string", "description": "US IPA, e.g. /məˈtɪkjələs/" },
            "senses": {
                "type": "array",
                "description": "meanings, the one that fits the context first; at most 3",
                "items": {
                    "type": "object",
                    "properties": {
                        "pos": { "type": "string", "description": "noun, verb, adj, adv, phrase, idiom…" },
                        "vi": { "type": "string", "description": "the Vietnamese meaning" },
                        "en": { "type": "string", "description": "a short English definition" },
                    },
                    "required": ["pos", "vi", "en"],
                },
            },
            "phrases": {
                "type": "array",
                "description": "the 4-5 most common phrases / collocations the word is used in (the meaning used first), each with a natural everyday example sentence",
                "items": {
                    "type": "object",
                    "properties": {
                        "phrase": { "type": "string", "description": "e.g. \"meticulous attention to detail\", \"be meticulous about something\"" },
                        "vi": { "type": "string", "description": "its Vietnamese meaning" },
                        "example": { "type": "string", "description": "an English sentence using exactly this phrase" },
                        "exampleVi": { "type": "string", "description": "the Vietnamese translation of that sentence" },
                    },
                    "required": ["phrase", "vi", "example", "exampleVi"],
                },
            },
            "verbForms": {
                "type": "object",
                "description": "if the word is (or can be) a verb, including a phrasal verb: all its forms; otherwise every field empty and irregular false",
                "properties": {
                    "base": { "type": "string", "description": "go, tackle, give up" },
                    "third": { "type": "string", "description": "he/she/it form: goes, tackles, gives up" },
                    "past": { "type": "string", "description": "past simple: went, tackled, gave up (both if two are common: dreamed / dreamt)" },
                    "participle": { "type": "string", "description": "past participle: gone, tackled, given up" },
                    "ing": { "type": "string", "description": "present participle: going, tackling, giving up" },
                    "irregular": { "type": "boolean", "description": "true if the past or past participle is not just -ed" },
                },
                "required": ["base", "third", "past", "participle", "ing", "irregular"],
            },
            "tip": { "type": "string", "description": "one short usage tip in Vietnamese (a common mistake, a confusable word), or empty" },
            "synonyms": {
                "type": "array",
                "description": "up to 5 words with the same meaning (the sense used), closest first",
                "items": {
                    "type": "object",
                    "properties": {
                        "word": { "type": "string" },
                        "vi": { "type": "string", "description": "its Vietnamese meaning" },
                        "note": { "type": "string", "description": "in Vietnamese, short: how it differs (stronger, more formal, only for people…) and when to prefer it" },
                    },
                    "required": ["word", "vi", "note"],
                },
            },
            "antonyms": {
                "type": "array",
                "description": "up to 4 words with the opposite meaning (the sense used); empty if there are none",
                "items": {
                    "type": "object",
                    "properties": { "word": { "type": "string" }, "vi": { "type": "string" }, "note": { "type": "string", "description": "in Vietnamese, short: when it is used" } },
                    "required": ["word", "vi", "note"],
                },
            },
            "family": {
                "type": "array",
                "description": "the other words built on the same stem (noun, verb, adjective, adverb, un-/in-/dis- forms of it), not the word itself; empty if none",
                "items": {
                    "type": "object",
                    "properties": {
                        "word": { "type": "string" },
                        "pos": { "type": "string", "description": "noun, verb, adj, adv…" },
                        "vi": { "type": "string" },
                        "example": { "type": "string", "description": "a short English example using it" },
                    },
                    "required": ["word", "pos", "vi", "example"],
                },
            },
        },
        "required": ["word", "ipa", "senses", "phrases", "verbForms", "tip", "synonyms", "antonyms", "family"],
    })
}

const SYSTEM: &str = concat!(
    "You are an English–Vietnamese learner's dictionary. The user is a Vietnamese speaker learning English and wants to use words the way native speakers do. ",
    "For the word or phrase given, reply with its dictionary form, US IPA, its meanings (Vietnamese meaning and a short English definition; ",
    "when a context sentence is given, the meaning used there comes first), all its verb forms if it can be a verb, and one short usage tip in Vietnamese. ",
    "Focus on how the word is really used: give the most common phrases and collocations it appears in, each with a natural, everyday example sentence using that phrase and its Vietnamese translation. ",
    "Synonyms and antonyms must fit the meaning used (the first meaning), each with a short Vietnamese note on how it differs in nuance, strength or register. ",
    "The word family lists only the other forms built on the same English stem (diligent: diligence, diligently; happy: happiness, happily, unhappy), each with a short example; ",
    "no words from a different stem, even if related in meaning (those belong in synonyms or antonyms). ",
    "Only real, common English words. If the text is not English, still explain it as best you can.",
);

const CORE_SYSTEM: &str = concat!(
    "You are an English–Vietnamese learner's dictionary for a Vietnamese speaker learning English. ",
    "For the word or phrase given, reply with its dictionary form, US IPA and its meanings (Vietnamese meaning and a short English definition); ",
    "when a context sentence is given, the meaning used there comes first. Only real, common English words. If the text is not English, still explain it as best you can.",
);

// The lookup comes in two parts, asked at the same time: the meaning (small, so it's back in
// a couple of seconds and the card can show it) and the extras (phrases, verb forms,
// synonyms, word family: most of the writing, so slower).
fn part(keys: &[&str]) -> Value {
    let all = schema();
    let props: Map<String, Value> = keys.iter().map(|k| (k.to_string(), all["properties"][*k].clone())).collect();
    json!({ "type": "object", "properties": props, "required": keys })
}

fn read_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string", "description": "the English word or short phrase they boxed, as written (empty if there is none)" },
            "sentence": { "type": "string", "description": "the sentence it is in, if one is visible; else empty" },
        },
        "required": ["text", "sentence"],
    })
}

const READ_SYSTEM: &str = concat!(
    "You read text in pictures. The user boxed a bit of their screen round an English word or short phrase they want to learn. ",
    "Reply with that word or phrase (the main one, the one most in the middle if there are several) and the sentence it is in when one is visible.",
);

/// A value as text, at most `max` characters (vocab.js str: '' for nothing).
fn s(v: &Value, max: usize) -> String {
    let t = match v {
        Value::Bool(false) | Value::Null => String::new(),
        other => crate::runtime::util::text(other),
    };
    t.chars().take(max).collect()
}

fn list(v: &Value, n: usize) -> Vec<Value> {
    v.as_array().map(|a| a.iter().take(n).cloned().collect()).unwrap_or_default()
}

/// A verb's five forms, or null when it isn't a verb.
fn verb_forms(v: &Value) -> Value {
    let f = |k: &str| s(&v[k], 60);
    let (base, past) = (f("base"), f("past"));
    if base.is_empty() || past.is_empty() {
        return Value::Null;
    }
    json!({ "base": base, "third": f("third"), "past": past, "participle": f("participle"), "ing": f("ing"), "irregular": v["irregular"].as_bool().unwrap_or(false) })
}

/// What a `claude -p --output-format stream-json` line says, if it's the answer: its
/// structured output, or why there's none.
pub fn result_of(line: &str) -> Option<Result<Value, String>> {
    let m: Value = serde_json::from_str(line).ok()?;
    if m["type"] != "result" {
        return None;
    }
    let out = &m["structured_output"];
    if m["is_error"].as_bool().unwrap_or(false) || out.is_null() || out == &Value::Bool(false) {
        let why = match &m["result"] {
            Value::Null => "nothing came back".to_string(),
            r => crate::runtime::util::text(r),
        };
        let why = if why.is_empty() { "nothing came back".to_string() } else { why };
        return Some(Err(why.chars().take(200).collect()));
    }
    Some(Ok(out.clone()))
}

/// Ask Claude Code's quick model one question and get its structured answer. content: the
/// user message (a string, or content blocks such as an image).
fn ask_haiku(exe: &Path, schema: &Value, system: &str, content: Value) -> Result<Value, String> {
    let args = [
        "-p", "--model", "haiku", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--json-schema", &schema.to_string(), "--system-prompt", system,
        "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "",
    ];
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(std::env::temp_dir())
        .env_clear()
        .envs(clean_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    let killer = Killer::new(child.id());
    let mut stdin = child.stdin.take();
    let message = json!({ "type": "user", "message": { "role": "user", "content": content } });
    if let Some(i) = stdin.as_mut() {
        let _ = writeln!(i, "{message}"); // (it may already be gone: its close says why)
        let _ = i.flush();
    }
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let err_reader = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut buf);
        }
        buf
    });
    let (tx, rx) = mpsc::channel();
    let waiter = killer.clone();
    thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if let Some(answer) = result_of(line.trim()) {
                    let _ = tx.send(answer);
                }
            }
        }
        let code = child.wait().ok().and_then(|s| s.code()).map_or("null".to_string(), |c| c.to_string());
        waiter.gone();
        drop(child);
        let err = err_reader.join().unwrap_or_default();
        let err: String = err.chars().take(200).collect();
        let _ = tx.send(Err(format!("Claude Code stopped ({code}): {}", if err.is_empty() { "no answer" } else { &err })));
    });
    let answer = match rx.recv_timeout(LOOKUP_TIMEOUT) {
        Ok(a) => a,
        Err(_) => {
            killer.kill();
            Err("Claude Code took too long".into())
        }
    };
    drop(stdin); // it's answered: let it go (it shuts down by itself)
    answer
}

fn claude_exe(claude_path: &str) -> Result<std::path::PathBuf, String> {
    crate::agents::claude::locate::find(claude_path).ok_or_else(|| "Claude Code isn't installed".to_string())
}

/// The question: the word, and the sentence it was found in.
fn prompt_for(text: &str, context: &str) -> String {
    let mut p = format!("Word or phrase: \"{text}\"");
    if !context.is_empty() && context != text {
        p.push_str(&format!("\nFound in: \"{}\"", context.chars().take(400).collect::<String>()));
    }
    p
}

/// The meaning, as the card shows it first: { word, ipa, senses }.
fn meaning_of(r: &Value, text: &str) -> Result<Value, String> {
    if r["senses"].as_array().is_none_or(Vec::is_empty) {
        return Err("no meaning came back".into());
    }
    let word = if s(&r["word"], 80).is_empty() { text.chars().take(80).collect() } else { s(&r["word"], 80) };
    let senses: Vec<Value> = list(&r["senses"], 3).iter().map(|x| json!({ "pos": s(&x["pos"], 30), "vi": s(&x["vi"], 400), "en": s(&x["en"], 400) })).collect();
    Ok(json!({ "word": word, "ipa": s(&r["ipa"], 80), "senses": senses }))
}

/// The whole entry: the meaning and the extras (empty, with extrasError, if they failed).
fn entry_of(meaning: Value, extras: Result<Value, String>) -> Value {
    let (r, error) = match extras {
        Ok(r) => (r, None),
        Err(e) => (json!({}), Some(e)),
    };
    let like = |x: &Value| json!({ "word": s(&x["word"], 80), "vi": s(&x["vi"], 400), "note": s(&x["note"], 400) });
    let has_word = |x: &Value| !x["word"].as_str().unwrap_or("").is_empty();
    let itself = norm(meaning["word"].as_str().unwrap_or("")); // the family sometimes lists the word itself
    let mut out = meaning.as_object().cloned().unwrap_or_default();
    let phrases: Vec<Value> = list(&r["phrases"], 6)
        .iter()
        .map(|p| json!({ "phrase": s(&p["phrase"], 80), "vi": s(&p["vi"], 200), "example": s(&p["example"], 400), "exampleVi": s(&p["exampleVi"], 400) }))
        .filter(|p| !p["phrase"].as_str().unwrap_or("").is_empty())
        .collect();
    out.insert("phrases".into(), json!(phrases));
    out.insert("verbForms".into(), verb_forms(&r["verbForms"]));
    out.insert("examples".into(), json!([])); // (older words had separate examples; the phrases' examples take their place)
    out.insert("tip".into(), json!(s(&r["tip"], 400)));
    // (none at all if the extras failed: the card then offers to look it up again, as for older words)
    if error.is_none() {
        out.insert("synonyms".into(), Value::Array(list(&r["synonyms"], 6).iter().map(like).filter(has_word).collect()));
    }
    out.insert("antonyms".into(), Value::Array(list(&r["antonyms"], 5).iter().map(like).filter(has_word).collect()));
    let family: Vec<Value> = list(&r["family"], 8)
        .iter()
        .map(|f| json!({ "word": s(&f["word"], 80), "pos": s(&f["pos"], 30), "vi": s(&f["vi"], 400), "example": s(&f["example"], 400) }))
        .filter(|f| has_word(f) && norm(f["word"].as_str().unwrap_or("")) != itself)
        .collect();
    out.insert("family".into(), json!(family));
    if let Some(e) = error {
        out.insert("extrasError".into(), json!(e));
    }
    Value::Object(out)
}

/// Look a word up. on_core(meaning) is called as soon as the meaning is in ({ word, ipa,
/// senses }), before the rest. If only the extras fail, it's still an entry, with the meaning
/// and empty extras (and extrasError).
pub fn lookup(text: &str, context: &str, claude_path: &str, on_core: impl FnOnce(&Value)) -> Result<Value, String> {
    let exe = claude_exe(claude_path)?;
    let prompt = prompt_for(text, context);
    let extras = {
        let (exe, prompt) = (exe.clone(), prompt.clone());
        thread::spawn(move || ask_haiku(&exe, &part(&["phrases", "verbForms", "tip", "synonyms", "antonyms", "family"]), SYSTEM, json!(prompt)))
    };
    // (the meaning failing is the lookup failing; the extras, still on their way, are dropped)
    let meaning = ask_haiku(&exe, &part(&["word", "ipa", "senses"]), CORE_SYSTEM, json!(prompt)).and_then(|r| meaning_of(&r, text))?;
    on_core(&meaning);
    let extras = extras.join().unwrap_or_else(|_| Err("the lookup broke".into()));
    Ok(entry_of(meaning, extras))
}

/// The word in a cut-out of the screen (a PNG): (text, sentence).
pub fn read_picture(png: &[u8], claude_path: &str) -> Result<(String, String), String> {
    let exe = claude_exe(claude_path)?;
    // the picture goes in as an image in the first message
    let content = json!([
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png) } },
        { "type": "text", "text": "Which word or phrase did I box?" },
    ]);
    let r = ask_haiku(&exe, &read_schema(), READ_SYSTEM, content)?;
    Ok((s(&r["text"], 80).trim().to_string(), s(&r["sentence"], 400).trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_line() {
        assert_eq!(result_of(r#"{"type":"assistant"}"#), None);
        assert_eq!(result_of("not json"), None);
        assert_eq!(result_of(r#"{"type":"result","structured_output":{"word":"run"}}"#), Some(Ok(json!({ "word": "run" }))));
        assert_eq!(result_of(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#), Some(Err("Not logged in".into())));
        assert_eq!(result_of(r#"{"type":"result","result":"plain text"}"#), Some(Err("plain text".into())));
        assert_eq!(result_of(r#"{"type":"result"}"#), Some(Err("nothing came back".into())));
    }

    #[test]
    fn the_question() {
        assert_eq!(prompt_for("run", ""), "Word or phrase: \"run\"");
        assert_eq!(prompt_for("run", "run"), "Word or phrase: \"run\"");
        assert_eq!(prompt_for("ran", "I ran home."), "Word or phrase: \"ran\"\nFound in: \"I ran home.\"");
    }

    #[test]
    fn the_schemas_split() {
        let core = part(&["word", "ipa", "senses"]);
        assert_eq!(core["required"], json!(["word", "ipa", "senses"]));
        assert_eq!(core["properties"].as_object().unwrap().len(), 3);
        assert!(core["properties"]["senses"]["items"]["required"].is_array());
        assert_eq!(schema()["required"].as_array().unwrap().len(), schema()["properties"].as_object().unwrap().len());
    }

    #[test]
    fn an_entry_is_tidied() {
        assert!(meaning_of(&json!({ "word": "x", "senses": [] }), "x").is_err());
        let m = meaning_of(&json!({ "word": "", "ipa": "/x/", "senses": [{ "pos": "verb", "vi": "chạy", "en": "go fast" }, {}, {}, {}] }), "ran").unwrap();
        assert_eq!(m["word"], "ran"); // (none came back: as captured)
        assert_eq!(m["senses"].as_array().unwrap().len(), 3);
        let extras = json!({
            "phrases": [{ "phrase": "run a shop", "vi": "mở cửa hàng", "example": "She runs a shop.", "exampleVi": "…" }, { "phrase": "" }],
            "verbForms": { "base": "run", "third": "runs", "past": "ran", "participle": "run", "ing": "running", "irregular": true },
            "tip": "", "synonyms": [{ "word": "sprint", "vi": "chạy nước rút", "note": "" }, { "word": "" }],
            "antonyms": [], "family": [{ "word": "Ran", "pos": "verb" }, { "word": "runner", "pos": "noun", "vi": "người chạy", "example": "" }],
        });
        let e = entry_of(json!({ "word": "ran", "ipa": "", "senses": [] }), Ok(extras));
        assert_eq!(e["phrases"].as_array().unwrap().len(), 1);
        assert_eq!(e["verbForms"]["irregular"], true);
        assert_eq!(e["synonyms"], json!([{ "word": "sprint", "vi": "chạy nước rút", "note": "" }]));
        assert_eq!(e["family"].as_array().unwrap().len(), 1); // (not the word itself)
        assert!(e.get("extrasError").is_none());
        // not a verb: no forms
        let e = entry_of(json!({ "word": "happy" }), Ok(json!({ "verbForms": { "base": "", "past": "" } })));
        assert_eq!(e["verbForms"], Value::Null);
        // the extras failed: no synonyms at all (the card offers to look it up again), and why
        let e = entry_of(json!({ "word": "happy" }), Err("Claude Code took too long".into()));
        assert!(e.get("synonyms").is_none());
        assert_eq!(e["extrasError"], "Claude Code took too long");
        assert_eq!(e["antonyms"], json!([]));
    }

    // A real lookup, with Claude Code (the user's account): cargo test -- --ignored real_lookup
    #[test]
    #[ignore]
    fn real_lookup() {
        let mut core = None;
        let e = lookup("meticulous", "", "", |m| core = Some(m.clone())).expect("looked up");
        assert!(core.is_some());
        assert!(!e["senses"].as_array().unwrap().is_empty());
        println!("{}", serde_json::to_string_pretty(&e).unwrap());
    }
}
