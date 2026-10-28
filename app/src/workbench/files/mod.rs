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

mod protocol;
mod viewer;

pub use protocol::*;
pub use viewer::*;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

use crate::platform::process::NoWindow;
use crate::runtime::Locked;

const SKIP: [&str; 23] = [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "target",
    "bin",
    "obj",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vs",
    ".gradle",
    ".terraform",
];
const MAX_FILES: usize = 40000;
const FRESH: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct Entry {
    rel: String,
    dir: bool,
}

fn git_files(folder: &str) -> Option<Vec<String>> {
    let out = Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard"])
        .current_dir(folder)
        .no_window()
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .take(MAX_FILES)
            .map(str::to_string)
            .collect(),
    )
}

fn walk_files(folder: &str) -> Vec<String> {
    let mut files = vec![];
    let mut queue = std::collections::VecDeque::from([String::new()]);
    while let Some(rel) = queue.pop_front() {
        if files.len() >= MAX_FILES {
            break;
        }
        let Ok(items) = std::fs::read_dir(Path::new(folder).join(&rel)) else {
            continue;
        };
        for it in items.filter_map(|e| e.ok()) {
            let name = it.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
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
    static INDEX: LazyLock<Mutex<Index>> = LazyLock::new(Mutex::default);
    if let Some((at, entries)) = INDEX.locked().get(folder)
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
    let entries: Vec<Entry> = dirs
        .into_iter()
        .map(|rel| Entry { rel, dir: true })
        .chain(files.into_iter().map(|rel| Entry { rel, dir: false }))
        .collect();
    INDEX
        .locked()
        .insert(folder.to_string(), (Instant::now(), entries.clone()));
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
        let mut top: Vec<Entry> = entries
            .into_iter()
            .filter(|e| !e.rel.contains('/'))
            .collect();
        top.sort_by(|a, b| {
            b.dir
                .cmp(&a.dir)
                .then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()))
        });
        top.into_iter().take(limit).collect()
    } else {
        let mut scored: Vec<(u8, Entry)> = entries
            .into_iter()
            .filter_map(|e| Some((rank(&e.rel, &q)?, e)))
            .collect();
        scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.rel.len().cmp(&b.1.rel.len())));
        scored.into_iter().take(limit).map(|(_, e)| e).collect()
    };
    Value::Array(
        pick.into_iter()
            .map(|e| json!({ "rel": e.rel, "dir": e.dir }))
            .collect(),
    )
}

/// The files a message @-mentions (that exist), as absolute paths. "@a/b.ts" and "@\"with space.md\"".
pub fn mentioned(folder: &str, text: &str) -> Vec<String> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?:^|\s)@(?:"([^"]+)"|([^\s"]+))"#).unwrap());
    let re = &*RE;
    let mut out: Vec<String> = vec![];
    for c in re.captures_iter(text) {
        let raw = c
            .get(1)
            .or(c.get(2))
            .map_or("", |m| m.as_str())
            .trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
        let p = Path::new(raw);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            Path::new(folder).join(raw)
        };
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
    let (c, p) = (
        normalize(Path::new(child)).to_lowercase(),
        normalize(Path::new(parent)).to_lowercase(),
    );
    let p = p.trim_end_matches('\\');
    c == p || c.starts_with(&format!("{p}\\"))
}

const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

fn ext_of(p: &str) -> String {
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// A file or folder fed to the robot: { path, name, isDir, size, isImage } (None if it isn't there).
pub fn inspect(p: &str) -> Option<Value> {
    let path = Path::new(p);
    if !path.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string());
    Some(
        json!({ "path": p, "name": name, "isDir": meta.is_dir(), "size": meta.len(), "isImage": IMAGE_EXT.contains(&ext_of(p).as_str()) }),
    )
}

/// Pasted screenshots have no file yet; keep them next to the app's data, named like
/// "Screenshot 2026-10-22 22.11.48.png" (local time).
pub fn save_paste(dir: &Path, bytes: &[u8], ext: &str) -> Option<Value> {
    let ext = ext.to_lowercase();
    let ext = if ["png", "jpg", "jpeg", "gif", "webp"].contains(&ext.as_str()) {
        ext
    } else {
        "png".into()
    };
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
        assert_eq!(
            (
                md["kind"].as_str(),
                md["text"].as_str(),
                md["truncated"].as_bool()
            ),
            (Some("text"), Some("# Hi\n"), Some(false))
        );
        assert_eq!(at("blob.bin")["kind"], "binary");
        assert_eq!(at("wide.txt")["text"], "hi");
        assert_eq!(at("talk.mp3")["kind"], "audio");
        assert_eq!(at("doc.pdf")["kind"], "pdf");
        let svg = at("pic.svg");
        assert_eq!(
            (svg["kind"].as_str(), svg["text"].as_str()),
            (Some("image"), Some("<svg/>"))
        );

        let list = read_for_view(&dir.to_string_lossy(), &roots);
        assert_eq!(list["kind"], "dir");
        let names: Vec<&str> = list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "sub", "blob.bin", "doc.pdf", "notes.md", "pic.svg", "talk.mp3", "wide.txt"
            ]
        );
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
        assert_eq!(
            read_for_view("a.txt", &[dir.to_string_lossy().into_owned()])["ok"],
            false
        );
        assert_eq!(
            read_for_view(&file, &[dir.to_string_lossy().into_owned()])["ok"],
            true
        );
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
