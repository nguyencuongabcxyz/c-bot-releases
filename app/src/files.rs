//! Files in the chat (src/main/files.js, localFiles.js).
//!
//! @-mentions: the files in a robot's folder. In a git repository that's what git knows
//! about (tracked + untracked, minus .gitignore); otherwise a walk of the folder that
//! skips the usual heavy directories. Kept for a little while so typing stays snappy.
//!
//! Pictures Claude made or points at are shown through cbot-file (img/?path=<absolute
//! path>), only from the folders allowed, and only as pictures: an SVG gets a CSP that
//! keeps any script in it from running. File links open the file in its usual app.
//!
//! The chat's file viewer reads a file or folder (read_for_view) from the same folders;
//! PDFs, songs and videos come through cbot-file too (view/?path=…), in pieces on request.

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

/// PDFs, songs and videos the chat's file viewer shows through cbot-file://view/.
fn media_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

/// A file (not the folder itself) inside one of the folders it may show files from.
fn may_serve(p: &str, allowed: &[String]) -> bool {
    Path::new(p).is_absolute() && allowed.iter().any(|root| !root.is_empty() && is_inside(p, root) && !is_inside(root, p))
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(404).body(b"Not found".to_vec()).unwrap()
}

/// cbot-file: a picture (img/?path=…), or a PDF, song or video (view/?path=…).
pub fn serve(request: &tauri::http::Request<Vec<u8>>, allowed: &[String]) -> tauri::http::Response<Vec<u8>> {
    if request.uri().path().starts_with("/view") {
        let range = request.headers().get(tauri::http::header::RANGE).and_then(|v| v.to_str().ok());
        serve_view(request.uri(), range, allowed)
    } else {
        serve_image(request.uri(), allowed)
    }
}

/// cbot-file://img/?path=… : a picture from one of the folders it may show pictures from.
fn serve_image(uri: &tauri::http::Uri, allowed: &[String]) -> tauri::http::Response<Vec<u8>> {
    let p = query_param(uri.query().unwrap_or(""), "path").unwrap_or_default();
    let Some(ty) = image_type(&ext_of(&p)) else { return not_found() };
    if !may_serve(&p, allowed) {
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

const MEDIA_CHUNK: u64 = 4 * 1024 * 1024;
const MEDIA_WHOLE: u64 = 200 * 1024 * 1024;

/// "bytes=10-", "bytes=10-99", "bytes=-500" -> the first and last byte asked for, of `len`.
fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let last = len.checked_sub(1)?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => (len.saturating_sub(n.parse().ok()?), last),
        (s, "") => (s.parse().ok()?, last),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(last)),
    };
    (start <= end).then_some((start, end))
}

/// cbot-file://view/?path=… : a PDF, song or video for the file viewer, a piece at a time
/// when the player asks for one (so a long video can be skipped through).
fn serve_view(uri: &tauri::http::Uri, range: Option<&str>, allowed: &[String]) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let p = query_param(uri.query().unwrap_or(""), "path").unwrap_or_default();
    let Some(ty) = media_type(&ext_of(&p)) else { return not_found() };
    if !may_serve(&p, allowed) {
        return not_found();
    }
    let Ok(meta) = std::fs::metadata(&p) else { return not_found() };
    if !meta.is_file() {
        return not_found();
    }
    let len = meta.len();
    let res = || {
        tauri::http::Response::builder()
            .header("Content-Type", ty)
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
    };
    let Some(range) = range else {
        if len > MEDIA_WHOLE {
            return tauri::http::Response::builder().status(413).body(Vec::new()).unwrap();
        }
        let Ok(bytes) = std::fs::read(&p) else { return not_found() };
        return res().body(bytes).unwrap();
    };
    let Some((start, end)) = byte_range(range, len) else {
        return res().status(416).header("Content-Range", format!("bytes */{len}")).body(Vec::new()).unwrap();
    };
    let end = end.min(start + MEDIA_CHUNK - 1);
    let mut piece = vec![0; (end - start + 1) as usize];
    let read = std::fs::File::open(&p).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut piece)
    });
    if read.is_err() {
        return not_found();
    }
    res().status(206).header("Content-Range", format!("bytes {start}-{end}/{len}")).body(piece).unwrap()
}

// ---------------------------------------------------------------- the file viewer

const VIEW_MAX: u64 = 2 * 1024 * 1024;
const LIST_MAX: usize = 400;

/// The start of a file as text (UTF-8, or UTF-16 with its BOM), and whether there's more;
/// None if it doesn't read as text.
fn read_text(path: &Path, size: u64) -> Option<(String, bool)> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(VIEW_MAX).read_to_end(&mut bytes).ok()?;
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest.as_chunks::<2>().0.iter().map(|c| if le { u16::from_le_bytes(*c) } else { u16::from_be_bytes(*c) }).collect();
        String::from_utf16_lossy(&units)
    };
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        utf16(rest, true)
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        utf16(rest, false)
    } else if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    } else {
        String::from_utf8_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes)).into_owned()
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
    if !allowed.iter().any(|root| !root.is_empty() && is_inside(p, root)) {
        return fail("I can only show files from your folders (your user folder, temp, and the robots' folders). Open it in its app instead.");
    }
    let Ok(meta) = std::fs::metadata(path) else { return fail("That file isn't there anymore.") };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string());
    let ext = ext_of(p);
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
    let mut out = json!({ "ok": true, "name": name, "path": p, "ext": ext, "size": meta.len(), "modified": modified });
    let kind = if meta.is_dir() {
        let mut entries: Vec<(bool, String, u64)> = std::fs::read_dir(path)
            .map(|rd| {
                rd.flatten()
                    .map(|e| {
                        let m = e.metadata().ok();
                        (m.as_ref().is_some_and(|m| m.is_dir()), e.file_name().to_string_lossy().into_owned(), m.map_or(0, |m| m.len()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        out["truncated"] = json!(entries.len() > LIST_MAX);
        out["entries"] = entries.into_iter().take(LIST_MAX).map(|(is_dir, name, size)| json!({ "name": name, "isDir": is_dir, "size": size })).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cbot-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_is_seen_as_text_binary_media_or_a_folder() {
        let dir = scratch("view");
        let roots = [dir.to_string_lossy().into_owned()];
        let at = |name: &str| read_for_view(&dir.join(name).to_string_lossy(), &roots);
        std::fs::write(dir.join("notes.md"), b"\xEF\xBB\xBF# Hi\n").unwrap();
        std::fs::write(dir.join("blob.bin"), [1, 0, 2, 3]).unwrap();
        std::fs::write(dir.join("wide.txt"), [0xFF, 0xFE, b'h', 0, b'i', 0]).unwrap();
        std::fs::write(dir.join("talk.mp3"), b"ID3").unwrap();
        std::fs::write(dir.join("doc.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.join("pic.svg"), b"<svg/>").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();

        let md = at("notes.md");
        assert_eq!((md["kind"].as_str(), md["text"].as_str(), md["truncated"].as_bool()), (Some("text"), Some("# Hi\n"), Some(false)));
        assert_eq!(at("blob.bin")["kind"], "binary");
        assert_eq!(at("wide.txt")["text"], "hi");
        assert_eq!(at("talk.mp3")["kind"], "audio");
        assert_eq!(at("doc.pdf")["kind"], "pdf");
        let svg = at("pic.svg");
        assert_eq!((svg["kind"].as_str(), svg["text"].as_str()), (Some("image"), Some("<svg/>")));

        let list = read_for_view(&dir.to_string_lossy(), &roots);
        assert_eq!(list["kind"], "dir");
        let names: Vec<&str> = list["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["sub", "blob.bin", "doc.pdf", "notes.md", "pic.svg", "talk.mp3", "wide.txt"]);
        assert_eq!(at("gone.txt")["ok"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_from_the_folders_it_may_show() {
        let dir = scratch("roots");
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        let file = dir.join("a.txt").to_string_lossy().into_owned();
        assert_eq!(read_for_view(&file, &["C:\\Nowhere".into()])["ok"], false);
        assert_eq!(read_for_view(&file, &[String::new()])["ok"], false);
        assert_eq!(read_for_view("a.txt", &[dir.to_string_lossy().into_owned()])["ok"], false);
        assert_eq!(read_for_view(&file, &[dir.to_string_lossy().into_owned()])["ok"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_player_gets_the_bytes_it_asks_for() {
        assert_eq!(byte_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(byte_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(byte_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=-30", 100), Some((70, 99)));
        assert_eq!(byte_range("bytes=150-", 100), None);
        assert_eq!(byte_range("bytes=0-", 0), None);
        assert_eq!(byte_range("items=0-1", 100), None);
    }
}
