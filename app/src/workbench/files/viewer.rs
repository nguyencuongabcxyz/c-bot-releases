//! The file viewer: a file the chat links to, shown in a window of its own (text with its highlighting, a picture, a PDF).

use super::*;

pub(super) const VIEW_MAX: u64 = 2 * 1024 * 1024;
pub(super) const LIST_MAX: usize = 400;

/// The start of a file as text (UTF-8, or UTF-16 with its BOM), and whether there's more;
/// None if it doesn't read as text.
pub(super) fn read_text(path: &Path, size: u64) -> Option<(String, bool)> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(VIEW_MAX)
        .read_to_end(&mut bytes)
        .ok()?;
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| {
                if le {
                    u16::from_le_bytes(*c)
                } else {
                    u16::from_be_bytes(*c)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        utf16(rest, true)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        utf16(rest, false)
    } else if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    } else {
        String::from_utf8_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes))
            .into_owned()
    };
    Some((text, size > VIEW_MAX))
}

/// A file or folder opened in the chat (robot.ts openFileView): a folder's list, a picture,
/// PDF, song or video (shown through cbot-file), the text of anything that reads as text
/// (its first 2 MB), or just what it is. Only from the folders pictures may come from.
pub fn read_for_view(p: &str, allowed: &[String]) -> Value {
    let fail = |error: &str| json!({ "ok": false, "error": error });
    let path = Path::new(p);
    if !path.is_absolute() {
        return fail("That isn't a path to a file.");
    }
    if !allowed
        .iter()
        .any(|root| !root.is_empty() && is_inside(p, root))
    {
        return fail(
            "I can only show files from your folders (your user folder, temp, and the robots' folders). Open it in its app instead.",
        );
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return fail("That file isn't there anymore.");
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string());
    let ext = ext_of(p);
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let mut out = json!({ "ok": true, "name": name, "path": p, "ext": ext, "size": meta.len(), "modified": modified });
    let kind = if meta.is_dir() {
        let mut entries: Vec<(bool, String, u64)> = std::fs::read_dir(path)
            .map(|rd| {
                rd.flatten()
                    .map(|e| {
                        let m = e.metadata().ok();
                        (
                            m.as_ref().is_some_and(|m| m.is_dir()),
                            e.file_name().to_string_lossy().into_owned(),
                            m.map_or(0, |m| m.len()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        entries.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
        });
        out["truncated"] = json!(entries.len() > LIST_MAX);
        out["entries"] = entries
            .into_iter()
            .take(LIST_MAX)
            .map(|(is_dir, name, size)| json!({ "name": name, "isDir": is_dir, "size": size }))
            .collect();
        "dir"
    } else if image_type(&ext).is_some() {
        // an SVG is a picture and text both: its source on the side
        if ext == "svg"
            && let Some((text, truncated)) = read_text(path, meta.len())
        {
            out["text"] = json!(text);
            out["truncated"] = json!(truncated);
        }
        "image"
    } else if let Some(ty) = media_type(&ext) {
        match ty.split('/').next() {
            Some("audio") => "audio",
            Some("video") => "video",
            _ => "pdf",
        }
    } else if let Some((text, truncated)) = read_text(path, meta.len()) {
        out["text"] = json!(text);
        out["truncated"] = json!(truncated);
        "text"
    } else {
        "binary"
    };
    out["kind"] = json!(kind);
    out
}

// Files that would run something when "opened" are shown in Explorer instead.
pub(super) const RUNNABLE: [&str; 24] = [
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "scr",
    "lnk",
    "url",
    "reg",
    "hta",
    "cpl",
    "jar",
    "sh",
    "appref-ms",
    "application",
];

/// A file shown or linked in the chat: open it, or show it in its folder.
pub fn open_file(p: &str, reveal: bool) -> Value {
    let path = Path::new(p);
    if !path.is_absolute() || !path.exists() {
        return json!({ "ok": false, "error": "That file isn't there anymore." });
    }
    if reveal || RUNNABLE.contains(&ext_of(p).as_str()) {
        let _ = tauri_plugin_opener::reveal_item_in_dir(path);
        return json!({ "ok": true, "revealed": true });
    }
    match tauri_plugin_opener::open_path(path, None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}
