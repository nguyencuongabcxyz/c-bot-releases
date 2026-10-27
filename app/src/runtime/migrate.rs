//! Robots kept the way an older C-Bot kept them, brought up to date when the app starts.

use serde_json::{json, Value};

use super::State;
use super::util::patch;

// The characters there used to be, as robots built from parts that look like them
// (office3d/kit3d.ts); main.js OLD_LOOKS.
pub fn kit_like(body: &str, color: &str) -> Value {
    let mut kit = match body {
        "loopy" => {
            json!({ "head": "ball", "face": "cute", "top": "ears", "body": "egg", "arms": "mitten", "finish": "glossy", "second": "#f4c7d4", "accent": "#ff8fb1" })
        }
        "cat" => {
            json!({ "head": "ball", "face": "cute", "top": "ears", "body": "egg", "arms": "mitten", "finish": "glossy", "second": "#f4d7b8", "accent": "#ff8fb1" })
        }
        "nerd" => {
            json!({ "face": "visor", "top": "spiky", "body": "slim", "specs": "round", "clothes": "tshirt", "hair": "#3a2a1e" })
        }
        "girl" => {
            json!({ "face": "cute", "top": "pigtails", "body": "slim", "clothes": "dress", "neck": "bow", "hair": "#6b3e26" })
        }
        _ => json!({}),
    };
    let hex = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if kit.get("clothes").is_some() && hex {
        kit["cloth"] = json!(color); // (their hoodie or sweater was the paint colour)
    }
    kit
}

/// Any robot that's still an old character becomes a build like it.
pub fn migrate_looks(st: &mut State) {
    let old: Vec<(String, Value)> = st
        .store
        .list()
        .iter()
        .filter(|c| !(c["body"] == "kit" && c.get("kit").is_some_and(|k| !k.is_null())))
        .map(|c| {
            let kit = c.get("kit").filter(|k| !k.is_null()).cloned();
            let kit = kit.unwrap_or_else(|| {
                kit_like(
                    c["body"].as_str().unwrap_or(""),
                    c["color"].as_str().unwrap_or(""),
                )
            });
            (c["id"].as_str().unwrap_or("").to_string(), kit)
        })
        .collect();
    for (id, kit) in old {
        st.store
            .update(&id, patch(vec![("body", json!("kit")), ("kit", kit)]));
        st.store.unset(&id, &["glb", "glbName", "glbTurn"]);
    }
}
