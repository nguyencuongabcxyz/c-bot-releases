//! Bringing what the store knows of a folder up to date (context/mod.rs drives it): which of
//! its files are new, changed or gone since the store last saw them (size and time first, then
//! what they hold), and reading each changed one once into what the store keeps of it: its
//! chunks and its code facts. Several files are read at once.
//!   files.rs    finding the files, and reading one
//!   chunk.rs    cutting a file into chunks
//!   markup.rs   a config file's structure (XML, YAML, Dockerfile), to cut it along

mod chunk;
mod files;
mod markup;

pub(in crate::context) use chunk::*;
pub(in crate::context) use files::*;

use super::*;

/// What the store had of a file.
#[derive(Clone, Debug, PartialEq)]
pub(in crate::context) struct Stored {
    pub stamp: Stamp,
    pub hash: Vec<u8>,
}

/// A changed file, read.
pub(in crate::context) struct Written {
    pub found: Found,
    pub hash: Vec<u8>,
    pub facts: Facts,
    pub chunks: Vec<Chunk>,
}

/// A file looked at again.
pub(in crate::context) enum Read {
    /// Its time changed but not what it holds: only its stamp moves on.
    Touched(Found),
    /// What it holds now.
    Written(Box<Written>),
}

/// The files to look at again (new, or another size or time), and the ones gone.
pub(in crate::context) fn changes(
    found: Vec<Found>,
    stored: &HashMap<String, Stored>,
) -> (Vec<Found>, Vec<String>) {
    let present: HashSet<&str> = found.iter().map(|f| f.rel.as_str()).collect();
    let mut gone: Vec<String> = stored
        .keys()
        .filter(|k| !present.contains(k.as_str()))
        .cloned()
        .collect();
    gone.sort();
    let check = found
        .into_iter()
        .filter(|f| stored.get(&f.rel).is_none_or(|s| s.stamp != f.stamp))
        .collect();
    (check, gone)
}

/// Read these files, on as many threads as make sense; `progress` hears how many are done.
/// A file that can't be read any more is left out (the next look finds it gone, or back).
pub(in crate::context) fn read_all(
    root: &Path,
    todo: Vec<Found>,
    stored: &HashMap<String, Stored>,
    progress: &(dyn Fn(usize) + Sync),
) -> Vec<Read> {
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let threads = thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(1, 8)
        .min(todo.len().max(1));
    let todo = &todo;
    thread::scope(|s| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = vec![];
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(found) = todo.get(i) else { break };
                        mine.extend(read_one(root, found.clone(), stored.get(&found.rel)));
                        progress(done.fetch_add(1, Ordering::Relaxed) + 1);
                    }
                    mine
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| w.join().unwrap_or_default())
            .collect()
    })
}

/// One file read once: its hash, then (when that changed) its facts and chunks. A file that
/// isn't text goes in with neither, so it isn't read again till it changes.
fn read_one(root: &Path, found: Found, old: Option<&Stored>) -> Option<Read> {
    let content = files::read(&root.join(&found.rel))?;
    if old.is_some_and(|o| o.hash == content.hash) {
        return Some(Read::Touched(found));
    }
    let text = content.text.unwrap_or_default();
    let facts = found
        .ty
        .lang()
        .and_then(|lang| parse::read(lang, &text))
        .unwrap_or_default();
    let chunks = chunk::chunks(found.ty, &text, &facts.defs);
    Some(Read::Written(Box::new(Written {
        found,
        hash: content.hash,
        facts,
        chunks,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(rel: &str, size: i64) -> Found {
        Found {
            rel: rel.into(),
            ty: FileType::Code(Lang::Rust),
            stamp: Stamp { size, mtime: 1 },
        }
    }

    fn stored(size: i64, hash: &[u8]) -> Stored {
        Stored {
            stamp: Stamp { size, mtime: 1 },
            hash: hash.to_vec(),
        }
    }

    #[test]
    fn only_new_restamped_and_gone_files_are_changes() {
        let had: HashMap<String, Stored> = [
            ("a.rs", stored(1, b"x")),
            ("b.rs", stored(1, b"y")),
            ("c.rs", stored(1, b"z")),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let (check, gone) = changes(
            vec![found("a.rs", 1), found("b.rs", 5), found("d.rs", 1)],
            &had,
        );
        let check: Vec<&str> = check.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(check, ["b.rs", "d.rs"]);
        assert_eq!(gone, ["c.rs"]);
    }

    #[test]
    fn a_file_whose_bytes_are_the_same_is_only_touched() {
        let dir =
            std::env::temp_dir().join(format!("cbot-ingest-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(dir.join("b.rs"), "fn b() { a(); }\n").unwrap();
        let had: HashMap<String, Stored> = [(
            "a.rs".to_string(),
            stored(0, blake3::hash(b"fn a() {}\n").as_bytes()),
        )]
        .into_iter()
        .collect();
        let mut read = read_all(
            &dir,
            vec![found("a.rs", 10), found("b.rs", 16), found("gone.rs", 1)],
            &had,
            &|_| {},
        );
        read.sort_by_key(|r| match r {
            Read::Touched(f) => f.rel.clone(),
            Read::Written(w) => w.found.rel.clone(),
        });
        assert_eq!(read.len(), 2);
        assert!(matches!(&read[0], Read::Touched(f) if f.rel == "a.rs"));
        let Read::Written(b) = &read[1] else { panic!() };
        assert_eq!(b.facts.defs[0].name, "b");
        assert_eq!(b.facts.names, [("a".to_string(), 1)]);
        assert_eq!(b.chunks.len(), 1);
        assert_eq!(b.chunks[0].symbol, "b");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
