//! Which files of a folder the engine reads: its code in the languages it knows and its
//! documents, the way git sees the folder (.gitignore), less what's built, downloaded or
//! generated; how each was when last seen (so only the ones that changed are read again); and
//! reading one, with the hash of what it holds.

use super::*;

/// At most this many files in one folder (a bigger one is read in part, and says so)…
pub(in crate::context) const MAX_FILES: usize = 30_000;
/// …and at most this many files and folders looked through to find them (a robot's folder
/// can be a whole drive or a home folder).
const MAX_SEEN: usize = 300_000;
/// Bigger files are data or generated, not code to read.
const MAX_BYTES: u64 = 1024 * 1024;

/// Folders never read, even without a .gitignore saying so.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "bin",
    "obj",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "coverage",
];

/// A path in the folder that's somewhere the engine never reads: in a folder it skips, or a
/// hidden one (as the walk skips them).
pub(in crate::context) fn skipped(rel: &str) -> bool {
    let mut dirs: Vec<&str> = rel.split('/').collect();
    dirs.pop();
    dirs.iter()
        .any(|d| d.starts_with('.') || SKIP_DIRS.contains(d))
}

/// Generated files that only get in the way (lock files too: thousands of versions).
const SKIP_ENDINGS: &[&str] = &[
    ".min.js",
    ".bundle.js",
    ".min.css",
    ".designer.cs",
    ".g.cs",
    ".g.i.cs",
    "package-lock.json",
    "pnpm-lock.yaml",
];

/// How a file was when it was read: changed (perhaps) when either is different.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::context) struct Stamp {
    pub size: i64,
    pub mtime: i64, // (ms since 1970)
}

/// A file found in the folder.
#[derive(Clone, Debug)]
pub(in crate::context) struct Found {
    pub rel: String, // (its path in the folder, with /)
    pub ty: FileType,
    pub stamp: Stamp,
}

/// What a file holds: the hash of its bytes, and its text unless it isn't text or looks
/// minified (a few very long lines).
pub(in crate::context) struct Content {
    pub hash: Vec<u8>,
    pub text: Option<String>,
}

/// The files the engine reads in a folder, by path; and whether there were more than it looks at.
pub(in crate::context) fn find(root: &Path) -> (Vec<Found>, bool) {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false) // (a .gitignore counts in a folder that isn't a repository too)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
        })
        .build();
    let mut found = vec![];
    let mut capped = false;
    for (seen, entry) in walker.flatten().enumerate() {
        if seen == MAX_SEEN {
            capped = true;
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(rel) = rel_path(root, entry.path()) else {
            continue;
        };
        let Some(ty) = FileType::of(&rel) else {
            continue;
        };
        let lower = rel.to_ascii_lowercase();
        if SKIP_ENDINGS.iter().any(|e| lower.ends_with(e)) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.len() > MAX_BYTES {
            continue;
        }
        if found.len() == MAX_FILES {
            capped = true;
            break;
        }
        let stamp = Stamp {
            size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
            mtime: meta.modified().map_or(0, ms_since_1970),
        };
        found.push(Found { rel, ty, stamp });
    }
    found.sort_by(|a, b| a.rel.cmp(&b.rel));
    (found, capped)
}

/// Of these files of the folder (by path), the ones `find` would find: there, of a kind the
/// engine reads, not hidden, skipped, generated, too big or ignored by git.
pub(in crate::context) fn find_these(root: &Path, paths: &[String]) -> Vec<Found> {
    let mut found: Vec<Found> = paths
        .iter()
        .filter_map(|rel| {
            let ty = FileType::of(rel)?;
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let lower = rel.to_ascii_lowercase();
            if name.starts_with('.')
                || skipped(rel)
                || SKIP_ENDINGS.iter().any(|e| lower.ends_with(e))
            {
                return None;
            }
            let meta = std::fs::metadata(root.join(rel)).ok()?;
            if !meta.is_file() || meta.len() > MAX_BYTES || git_ignores(root, rel) {
                return None;
            }
            let stamp = Stamp {
                size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
                mtime: meta.modified().map_or(0, ms_since_1970),
            };
            Some(Found {
                rel: rel.clone(),
                ty,
                stamp,
            })
        })
        .collect();
    found.sort_by(|a, b| a.rel.cmp(&b.rel));
    found
}

/// Whether git ignores a file of the folder, as `find`'s walk sees it: .git/info/exclude, then
/// the .gitignore of the folder and of each folder down to the file's, a deeper one having the
/// last word (a `!` in it lets a file back in, unless a folder it's in is ignored: git's rule).
fn git_ignores(root: &Path, rel: &str) -> bool {
    let dirs: Vec<&str> = rel.split('/').collect();
    let dirs = &dirs[..dirs.len().saturating_sub(1)];
    // (the rules of each list, by the folder they're for: the list at i is for what's below
    // dirs[..i - 1])
    let mut base = root.to_path_buf();
    let mut lists = vec![(root.join(".git").join("info").join("exclude"), base.clone())];
    lists.push((base.join(".gitignore"), base.clone()));
    for d in dirs {
        base = base.join(d);
        lists.push((base.join(".gitignore"), base.clone()));
    }
    let rules: Vec<Option<ignore::gitignore::Gitignore>> = lists
        .iter()
        .map(|(list, base)| {
            if !list.is_file() {
                return None;
            }
            let mut b = ignore::gitignore::GitignoreBuilder::new(base);
            if b.add(list).is_some() {
                return None;
            }
            b.build().ok()
        })
        .collect();
    let verdict = |path: &Path, is_dir: bool, lists: usize| {
        let mut ignored = false;
        for r in rules[..lists].iter().flatten() {
            match r.matched(path, is_dir) {
                ignore::Match::Ignore(_) => ignored = true,
                ignore::Match::Whitelist(_) => ignored = false,
                ignore::Match::None => {}
            }
        }
        ignored
    };
    let mut path = root.to_path_buf();
    for (i, d) in dirs.iter().enumerate() {
        path = path.join(d);
        if verdict(&path, true, i + 2) {
            return true;
        }
    }
    verdict(&root.join(rel), false, rules.len())
}

fn ms_since_1970(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A path inside root as the engine names it (forward slashes), or None outside it.
pub(in crate::context) fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// A path Claude gave (relative to root or absolute, either slash) as the engine names it:
/// '' for root itself, None outside it.
pub(in crate::context) fn asked_path(root: &Path, path: &str) -> Option<String> {
    let p = path.trim().replace('\\', "/");
    let absolute = p.starts_with('/') || p.as_bytes().get(1) == Some(&b':');
    let rel = if absolute {
        let root = root.to_string_lossy().replace('\\', "/");
        let root = root.trim_end_matches('/');
        let head = p.get(..root.len())?;
        if !head.eq_ignore_ascii_case(root) {
            return None;
        }
        let rest = &p[root.len()..];
        if !(rest.is_empty() || rest.starts_with('/')) {
            return None;
        }
        rest.to_string()
    } else {
        p
    };
    let rel = rel.trim_start_matches("./").trim_matches('/');
    Some(if rel == "." {
        String::new()
    } else {
        rel.to_string()
    })
}

/// What a file holds (None: it couldn't be read).
pub(in crate::context) fn read(path: &Path) -> Option<Content> {
    let bytes = std::fs::read(path).ok()?;
    let hash = blake3::hash(&bytes).as_bytes().to_vec();
    let text = String::from_utf8(bytes).ok().filter(|t| !minified(t));
    Some(Content { hash, text })
}

/// A file's text, unless it's not text or looks minified.
pub(in crate::context) fn read_code(path: &Path) -> Option<String> {
    read(path)?.text
}

fn minified(text: &str) -> bool {
    let lines = text.lines().count().max(1);
    text.len() > 20_000 && text.len() / lines > 400
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_finds_the_code_but_not_what_is_ignored_built_or_generated() {
        let dir =
            std::env::temp_dir().join(format!("cbot-ctx-files-{}", uuid::Uuid::new_v4().simple()));
        let write = |p: &str, text: &str| {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("src/main.rs", "fn main() {}");
        write("src/app.ts", "export {}");
        write("src/notes.md", "# notes");
        write("node_modules/x/index.js", "x");
        write("ignored/a.py", "x = 1");
        write("web/app.min.js", "x");
        write(".gitignore", "ignored/\n");
        write("logo.png", "x");
        let (found, capped) = find(&dir);
        let rels: Vec<&str> = found.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, ["src/app.ts", "src/main.rs", "src/notes.md"]);
        assert!(!capped);
        assert_eq!(found[1].ty, FileType::Code(Lang::Rust));
        assert_eq!(found[2].ty, FileType::Markdown);
        assert_eq!(found[1].stamp.size, 12);
        assert!(found[1].stamp.mtime > 1_700_000_000_000);
        let content = read(&dir.join("src/main.rs")).unwrap();
        assert_eq!(
            content.hash,
            blake3::hash(b"fn main() {}").as_bytes().to_vec()
        );
        assert_eq!(content.text.as_deref(), Some("fn main() {}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn of_files_named_it_keeps_those_the_walk_would_find() {
        let dir =
            std::env::temp_dir().join(format!("cbot-ctx-these-{}", uuid::Uuid::new_v4().simple()));
        let write = |p: &str, text: &str| {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("src/main.rs", "fn main() {}");
        write("src/.hidden.ts", "x");
        write("ignored/a.py", "x = 1");
        write("web/gen/b.ts", "x");
        write("web/gen/keep.ts", "x");
        write("web/app.min.js", "x");
        write("target/c.rs", "x");
        write(".gitignore", "ignored/\n");
        write("web/.gitignore", "gen/\n!gen/keep.ts\n");
        let asked: Vec<String> = [
            "src/main.rs",
            "src/.hidden.ts",
            "ignored/a.py",
            "web/gen/b.ts",
            "web/gen/keep.ts",
            "web/app.min.js",
            "target/c.rs",
            "gone.rs",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        let rels: Vec<String> = find_these(&dir, &asked)
            .into_iter()
            .map(|f| f.rel)
            .collect();
        let (walked, _) = find(&dir);
        let walked: Vec<String> = walked.into_iter().map(|f| f.rel).collect();
        // (keep.ts too: a `!` can't let a file back in from a folder that's ignored)
        assert_eq!(rels, walked);
        assert_eq!(rels, ["src/main.rs"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn minified_or_binary_files_have_no_text() {
        assert!(minified(&"x".repeat(30_000)));
        assert!(!minified(&"let x = 1;\n".repeat(3_000)));
        let dir =
            std::env::temp_dir().join(format!("cbot-ctx-bin-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), [0xff, 0xfe, 0x00]).unwrap();
        let c = read(&dir.join("a.ts")).unwrap();
        assert!(c.text.is_none() && c.hash.len() == 32);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paths_are_named_with_forward_slashes() {
        let root = Path::new("C:\\w\\shop");
        assert_eq!(
            rel_path(root, Path::new("C:\\w\\shop\\src\\a.ts")).as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(rel_path(root, Path::new("C:\\w\\other\\a.ts")), None);
        assert_eq!(rel_path(root, root), None);
    }

    #[test]
    fn paths_claude_gives_are_read_inside_the_folder() {
        let root = Path::new("C:\\w\\shop");
        let asked = |p: &str| asked_path(root, p);
        assert_eq!(asked("src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(asked("./src\\a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(asked("c:/W/Shop/src/").as_deref(), Some("src"));
        assert_eq!(asked("C:\\w\\shop").as_deref(), Some(""));
        assert_eq!(asked(".").as_deref(), Some(""));
        assert_eq!(asked("").as_deref(), Some(""));
        assert_eq!(asked("C:\\w\\shopping\\a.ts"), None);
        assert_eq!(asked("D:\\elsewhere"), None);
    }
}
