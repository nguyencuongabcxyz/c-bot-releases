//! Files in the chat (src/main/files.js, localFiles.js).
//!
//! @-mentions: the files in a robot's folder. In a git repository that's what git knows
//! about (tracked + untracked, minus .gitignore); otherwise a walk of the folder that
//! skips the usual heavy directories. Kept for a little while so typing stays snappy.
//!
//! Pictures Claude made or points at are shown through cbot-file (img/?path=<absolute
//! path>), only from the folders allowed, and only as pictures: an SVG gets a CSP that
//! keeps any script in it from running. File links open the file in its usual app.

use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};

use crate::find_claude::NO_WINDOW;

const SKIP: [&str; 23] = [
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "target", "bin",
    "obj", ".venv", "venv", "__pycache__", ".idea", ".vs", ".gradle", ".terraform",
];
const MAX_FILES: usize = 40000;
const FRESH: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct Entry {
    rel: String,
    dir: bool,
}

fn git_files(folder: &str) -> Option<Vec<String>> {
    let out = Command::new("git").args(["ls-files", "-co", "--exclude-standard"]).current_dir(folder).creation_flags(NO_WINDOW).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.is_empty()).take(MAX_FILES).map(str::to_string).collect())
}

fn walk_files(folder: &str) -> Vec<String> {
    let mut files = vec![];
    let mut queue = std::collections::VecDeque::from([String::new()]);
    while let Some(rel) = queue.pop_front() {
        if files.len() >= MAX_FILES {
            break;
        }
        let Ok(items) = std::fs::read_dir(Path::new(folder).join(&rel)) else { continue };
        for it in items.filter_map(|e| e.ok()) {
            let name = it.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(ty) = it.file_type() else { continue };
            if ty.is_dir() {
                if !SKIP.contains(&name.as_str()) && child.split('/').count() < 14 {
                    queue.push_back(child);
                }
            } else if ty.is_file() {
                files.push(child);
            }
        }
    }
    files
}

type Index = HashMap<String, (Instant, Vec<Entry>)>; // folder: when it was listed, what's in it

fn entries_of(folder: &str) -> Vec<Entry> {
    static INDEX: Mutex<Option<Index>> = Mutex::new(None);
    if let Some((at, entries)) = INDEX.lock().unwrap().get_or_insert_with(HashMap::new).get(folder)
        && at.elapsed() < FRESH
    {
        return entries.clone();
    }
    let files = git_files(folder).unwrap_or_else(|| walk_files(folder));
    let mut dirs: Vec<String> = vec![];
    let mut seen = HashSet::new();
    for f in &files {
        let parts: Vec<&str> = f.split('/').collect();
        for i in 1..parts.len() {
            let d = parts[..i].join("/");
            if seen.insert(d.clone()) {
                dirs.push(d);
            }
        }
    }
    let entries: Vec<Entry> = dirs.into_iter().map(|rel| Entry { rel, dir: true }).chain(files.into_iter().map(|rel| Entry { rel, dir: false })).collect();
    INDEX.lock().unwrap().get_or_insert_with(HashMap::new).insert(folder.to_string(), (Instant::now(), entries.clone()));
    entries
}

/// How well `rel` matches `q` (lower is better; None = no match): a file name that
/// starts with it, a file name that contains it, a path that contains it, then letters
/// in order (fuzzy).
fn rank(rel: &str, q: &str) -> Option<u8> {
    let r = rel.to_lowercase();
    let base = &r[r.rfind('/').map_or(0, |i| i + 1)..];
    if base.starts_with(q) {
        return Some(0);
    }
    if base.contains(q) {
        return Some(1);
    }
    if r.contains(q) {
        return Some(2);
    }
    let in_order = |hay: &str| {
        let mut want = q.chars().peekable();
        for ch in hay.chars() {
            if want.peek() == Some(&ch) {
                want.next();
            }
        }
        want.peek().is_none()
    };
    if in_order(base) {
        return Some(3);
    }
    in_order(&r).then_some(4)
}

/// Files and folders in `folder` matching `query`, best first: [{ rel, dir }]
pub fn search(folder: &str, query: &str, limit: usize) -> Value {
    let entries = entries_of(folder);
    let q = query.to_lowercase().replace('\\', "/");
    let pick: Vec<Entry> = if q.is_empty() {
        // nothing typed yet: the top of the folder
        let mut top: Vec<Entry> = entries.into_iter().filter(|e| !e.rel.contains('/')).collect();
        top.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase())));
        top.into_iter().take(limit).collect()
    } else {
        let mut scored: Vec<(u8, Entry)> = entries.into_iter().filter_map(|e| Some((rank(&e.rel, &q)?, e))).collect();
        scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.rel.len().cmp(&b.1.rel.len())));
        scored.into_iter().take(limit).map(|(_, e)| e).collect()
    };
    Value::Array(pick.into_iter().map(|e| json!({ "rel": e.rel, "dir": e.dir })).collect())
}

/// The files a message @-mentions (that exist), as absolute paths. "@a/b.ts" and "@\"with space.md\"".
pub fn mentioned(folder: &str, text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?:^|\s)@(?:"([^"]+)"|([^\s"]+))"#).unwrap());
    let mut out: Vec<String> = vec![];
    for c in re.captures_iter(text) {
        let raw = c.get(1).or(c.get(2)).map_or("", |m| m.as_str()).trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
        let p = Path::new(raw);
        let abs = if p.is_absolute() { p.to_path_buf() } else { Path::new(folder).join(raw) };
        if abs.exists() {
            let norm = normalize(&abs);
            if !out.contains(&norm) {
                out.push(norm);
            }
        }
    }
    out.truncate(20);
    out
}

/// A path with its separators made Windows' and its "." and ".." parts worked out.
pub fn normalize(p: &Path) -> String {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().replace('/', "\\")
}

/// Is `child` inside `parent` (or the same folder)?
pub fn is_inside(child: &str, parent: &str) -> bool {
    let (c, p) = (normalize(Path::new(child)).to_lowercase(), normalize(Path::new(parent)).to_lowercase());
    let p = p.trim_end_matches('\\');
    c == p || c.starts_with(&format!("{p}\\"))
}

const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

fn ext_of(p: &str) -> String {
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// A file or folder fed to the robot: { path, name, isDir, size, isImage } (None if it isn't there).
pub fn inspect(p: &str) -> Option<Value> {
    let path = Path::new(p);
    if !path.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string());
    Some(json!({ "path": p, "name": name, "isDir": meta.is_dir(), "size": meta.len(), "isImage": IMAGE_EXT.contains(&ext_of(p).as_str()) }))
}

/// Pasted screenshots have no file yet; keep them next to the app's data, named like
/// "Screenshot 2026-10-22 22.11.48.png" (local time).
pub fn save_paste(dir: &Path, bytes: &[u8], ext: &str) -> Option<Value> {
    let ext = ext.to_lowercase();
    let ext = if ["png", "jpg", "jpeg", "gif", "webp"].contains(&ext.as_str()) { ext } else { "png".into() };
    std::fs::create_dir_all(dir).ok()?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M.%S");
    let mut file = dir.join(format!("Screenshot {stamp}.{ext}"));
    let mut n = 2;
    while file.exists() {
        file = dir.join(format!("Screenshot {stamp} ({n}).{ext}"));
        n += 1;
    }
    std::fs::write(&file, bytes).ok()?;
    inspect(&file.to_string_lossy())
}

// ---------------------------------------------------------------- cbot-file

const MAX_PICTURE: u64 = 30 * 1024 * 1024;

fn image_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// "C%3A%5Cx" -> "C:\x" (as encodeURIComponent wrote it)
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// cbot-file://img/?path=… : a picture from one of the folders it may show pictures from.
pub fn serve_image(uri: &tauri::http::Uri, allowed: &[String]) -> tauri::http::Response<Vec<u8>> {
    let not_found = || tauri::http::Response::builder().status(404).body(b"Not found".to_vec()).unwrap();
    let p = query_param(uri.query().unwrap_or(""), "path").unwrap_or_default();
    let Some(ty) = image_type(&ext_of(&p)) else { return not_found() };
    let strictly_inside = |root: &String| !root.is_empty() && is_inside(&p, root) && !is_inside(root, &p);
    if !Path::new(&p).is_absolute() || !allowed.iter().any(strictly_inside) {
        return not_found();
    }
    let Ok(meta) = std::fs::metadata(&p) else { return not_found() };
    if !meta.is_file() || meta.len() > MAX_PICTURE {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&p) else { return not_found() };
    let mut res = tauri::http::Response::builder()
        .header("Content-Type", ty)
        .header("Cache-Control", "max-age=10") // answers re-render while they stream; previews of edited files add ?v=
        .header("Access-Control-Allow-Origin", "*");
    if ty == "image/svg+xml" {
        res = res.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    }
    res.body(bytes).unwrap()
}

// Files that would run something when "opened" are shown in Explorer instead.
const RUNNABLE: [&str; 24] = [
    "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "scr", "lnk", "url", "reg", "hta", "cpl", "jar", "sh", "appref-ms", "application",
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
