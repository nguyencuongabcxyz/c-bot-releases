//! A folder watched from its first look (notify: ReadDirectoryChangesW on Windows), so its index
//! follows the files as they're saved: each burst of changes, once it settles for QUIET, has the
//! files it names read again (look.rs) without waiting for a question; and while it's watched, a
//! question doesn't walk the folder first (look::trusted). Changes where the engine never reads
//! (.git, target, node_modules, hidden folders) or to files of no kind it knows are let be. A
//! folder gone takes the files the engine had in it; a folder made or moved in, or the system
//! losing track of changes, has the folder walked again whole. The watch ends with the folder
//! (the watcher goes with its Folder, and its thread then ends).

use std::sync::Weak;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::*;

/// How long the changes must stop for before the folder is read again (a save is several
/// events, a checkout or a build many).
const QUIET: Duration = Duration::from_millis(500);

/// A folder's watch, while it has one.
#[derive(Default)]
pub(super) struct Watch {
    watcher: Option<RecommendedWatcher>,
}

/// Watch a folder, unless it's watched already.
pub(super) fn start(app: &AppHandle, f: &Arc<Folder>) {
    let mut watch = f.watch.locked();
    if watch.watcher.is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let watcher = notify::recommended_watcher(tx).and_then(|mut w| {
        w.watch(&f.root, RecursiveMode::Recursive)?;
        Ok(w)
    });
    match watcher {
        Ok(w) => watch.watcher = Some(w),
        Err(e) => {
            log::warn!("couldn't watch {}: {e}", f.root.display());
            return;
        }
    }
    drop(watch);
    let (app, folder, root) = (app.clone(), Arc::downgrade(f), f.root.clone());
    thread::spawn(move || follow(&app, &folder, &root, &rx));
}

/// Whether the folder is watched.
pub(super) fn watched(f: &Folder) -> bool {
    f.watch.locked().watcher.is_some()
}

/// The watch's events as they come: each burst that touches what the engine reads, once it
/// settles, has the folder brought up to date (just the files it names, when it can).
fn follow(
    app: &AppHandle,
    folder: &Weak<Folder>,
    root: &Path,
    rx: &Receiver<notify::Result<Event>>,
) {
    while let Ok(first) = rx.recv() {
        let mut burst = Burst::default();
        burst.add(root, &first);
        loop {
            match rx.recv_timeout(QUIET) {
                Ok(e) => burst.add(root, &e),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let Some(f) = folder.upgrade() else {
            return; // (let go meanwhile)
        };
        // (a path gone that may have been a folder: the files the engine had in it)
        if !burst.gone.is_empty() {
            let code = f.code.locked();
            for dir in &burst.gone {
                let inside = code
                    .files
                    .keys()
                    .filter(|p| p.len() > dir.len() && search::under_path(p, dir));
                burst.files.extend(inside.cloned());
            }
        }
        if burst.all {
            look::changed(app, &f, None);
        } else if !burst.files.is_empty() {
            look::changed(app, &f, Some(burst.files));
        }
    }
}

/// What a burst of events touched: files of a kind the engine reads, paths gone that may have
/// been folders, or anything (a folder made or moved in, whose files are found by a walk; the
/// system lost track).
#[derive(Default)]
struct Burst {
    files: BTreeSet<String>,
    gone: BTreeSet<String>,
    all: bool,
}

impl Burst {
    fn add(&mut self, root: &Path, e: &notify::Result<Event>) {
        let Ok(e) = e else {
            self.all = true;
            return;
        };
        if e.need_rescan() {
            self.all = true;
            return;
        }
        if matches!(e.kind, EventKind::Access(_)) {
            return;
        }
        for p in &e.paths {
            let Some(rel) = ingest::rel_path(root, p) else {
                continue;
            };
            if ingest::skipped(&rel) {
                continue;
            }
            if FileType::of(&rel).is_some() {
                self.files.insert(rel);
            } else if p.is_dir() {
                self.all = true;
            } else if !p.exists() {
                // (a folder's name may have a dot too: MyApp.Core)
                self.gone.insert(rel);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind};

    fn event(kind: EventKind, path: &str) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(PathBuf::from(path)))
    }

    fn burst(root: &Path, events: &[notify::Result<Event>]) -> Burst {
        let mut b = Burst::default();
        for e in events {
            b.add(root, e);
        }
        b
    }

    #[test]
    fn a_burst_names_the_files_the_engine_reads() {
        let root = Path::new("C:\\no-such-folder\\shop");
        let saved = EventKind::Modify(ModifyKind::Any);
        let b = burst(
            root,
            &[
                event(saved, "C:\\no-such-folder\\shop\\src\\a.rs"),
                event(saved, "C:\\no-such-folder\\shop\\README.md"),
                event(saved, "C:\\no-such-folder\\shop\\.git\\index"),
                event(saved, "C:\\no-such-folder\\shop\\target\\debug\\b.rs"),
                event(
                    EventKind::Access(AccessKind::Any),
                    "C:\\no-such-folder\\shop\\c.rs",
                ),
                event(saved, "C:\\elsewhere\\d.rs"),
            ],
        );
        assert_eq!(
            b.files.into_iter().collect::<Vec<_>>(),
            ["README.md", "src/a.rs"]
        );
        assert!(!b.all && b.gone.is_empty());
    }

    #[test]
    fn a_folder_gone_or_made_and_a_lost_track_are_told_apart() {
        let dir =
            std::env::temp_dir().join(format!("cbot-watch-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("new.d")).unwrap();
        let removed = EventKind::Remove(notify::event::RemoveKind::Any);
        let b = burst(
            &dir,
            &[event(removed, &dir.join("MyApp.Core").to_string_lossy())],
        );
        assert_eq!(b.gone.into_iter().collect::<Vec<_>>(), ["MyApp.Core"]);
        assert!(!b.all);
        let made = burst(
            &dir,
            &[event(
                EventKind::Create(CreateKind::Any),
                &dir.join("new.d").to_string_lossy(),
            )],
        );
        assert!(made.all);
        assert!(burst(&dir, &[Err(notify::Error::generic("overflow"))]).all);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
