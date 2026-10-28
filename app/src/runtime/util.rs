//! Small helpers every module uses to read what a page sent and to answer it.

use super::Error;
use serde_json::{Map, Value};

/// A command only one window may send (the palette's, the snip screen's…).
pub fn only(window: &tauri::WebviewWindow, label: &str) -> Result<(), Error> {
    if window.label() == label {
        Ok(())
    } else {
        Err(format!("only {label} may ask that, not {}", window.label()).into())
    }
}

/// A value as text, as JS's String() would make it ('' for null).
pub fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A JSON object from key/value pairs.
pub fn patch(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// Percent-encodes a query value (what encodeURIComponent does).
pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
