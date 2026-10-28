//! Each personality flavours the system prompt Claude Code gets, plus the canned lines
//! the robot says without a round trip to Claude. The lines are shared with the
//! Electron app (shared/personalities.json).

use std::sync::LazyLock;

use serde_json::{Map, Value};

use crate::store::Fields;

static RAW: &str = include_str!("../../../shared/personalities.json");

pub fn all() -> &'static Map<String, Value> {
    static ALL: LazyLock<Map<String, Value>> =
        LazyLock::new(|| serde_json::from_str(RAW).expect("shared/personalities.json"));
    &ALL
}

/// What the robot pages get: everything but the prompt and the social lines.
pub fn public() -> Value {
    const KEYS: [&str; 14] = [
        "label",
        "emoji",
        "greetings",
        "sleepy",
        "pokes",
        "annoyed",
        "bonked",
        "done",
        "oops",
        "hungry",
        "yum",
        "bored",
        "sleeptalk",
        "quips",
    ];
    let out = all().iter().map(|(key, p)| {
        let picked: Map<String, Value> = KEYS
            .iter()
            .filter_map(|k| Some((k.to_string(), p.get(*k)?.clone())))
            .collect();
        (key.clone(), Value::Object(picked))
    });
    Value::Object(out.collect())
}

/// What Claude Code is told about the robot it's playing (--append-system-prompt).
pub fn system_prompt_for(c: &Value) -> String {
    let p = all()
        .get(c.personality())
        .or_else(|| all().get("cheerful"))
        .expect("shared/personalities.json has cheerful");
    [
        format!(
            "You are \"{}\", a small cartoon robot that lives on the user's desktop and looks after the folder {}.",
            c["name"].as_str().unwrap_or("Robo"),
            c.folder()
        ),
        format!("Personality: {}", p["prompt"].as_str().unwrap_or("")),
        "Your replies appear in a small speech bubble, so keep them short and conversational: lead with the answer, use brief markdown, and avoid long preambles.".into(),
        "Stay fully capable: when the user asks for real work in this folder, do it properly using your tools.".into(),
        "Your speech bubble can show pictures. Files you create or edit appear there automatically (pictures and SVGs as previews), so never open them in another app just to show them. To show any other local picture (a chart a script saved, a screenshot, an icon), put it in your answer as a markdown image with its absolute path, e.g. ![chart](<C:/path/to/chart.png>) (wrap the path in <> when it has spaces). Link files the same way, [report](<C:/path/report.html>): the user can click to open them.".into(),
        "Running commentary: while you work, you may drop short in-character remarks about what you notice, each on its own line as <aside>remark</aside> (under 12 words, e.g. <aside>Ooh, a 400-line function... brave.</aside>). They pop up in a thought bubble over your head and are not part of your answer, so never refer to them. Use one to three while reading or changing files, none for simple chat.".into(),
    ]
    .join("\n")
}

/// The emoji a robot of this personality shows in menus.
pub fn emoji(personality: &str) -> &'static str {
    all()
        .get(personality)
        .and_then(|p| p.get("emoji"))
        .and_then(Value::as_str)
        .unwrap_or("🤖")
}
