//! Deleting what the engine keeps, when the user asks (the Context engine window): one folder's
//! index, every folder's (the downloads stay), or everything in the engine's folder, downloads
//! too. The robots reading what goes have the engine switched off first, so nothing reads it
//! again meanwhile; switching it back on reads (and downloads) it all afresh. What's in use and
//! can't go yet (ONNX Runtime, once loaded, stays till C-Bot quits; a keyword index a reading
//! still holds) is listed, and goes the next time C-Bot starts, before the engine opens anything.

use super::*;

/// The list of what's to go the next time C-Bot starts, in the engine's folder.
const LATER: &str = "delete-later.txt";

/// What goes, besides one folder's index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Wipe {
    /// Every folder's index: the database's data and the keyword indexes (the downloads stay).
    Indexes,
    /// Everything in the engine's folder: the indexes, PostgreSQL, the models, ONNX Runtime.
    Everything,
}

/// What was deleted.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wiped {
    freed: u64,          // (bytes, on disk)
    later: bool,         // (some of it was in use: it goes the next time C-Bot starts)
    robots: Vec<String>, // (the robots the engine was switched off for, by name)
}

/// Delete one folder's index (the robots reading it have the engine switched off). Its files
/// stay as they are.
#[tauri::command(async)]
pub fn context_forget(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
) -> Result<Wiped, Error> {
    util::only(&window, window::LABEL)?;
    let k = key(&root);
    let db = browse::running_store(&app)?;
    let robots = switch_off(&app, |folder| key(folder) == k);
    if let Some(f) = engine(&app, |e| e.folders.remove(&k)) {
        let_go(&f);
    }
    let scope = store::scope_id(&k);
    db.store.forget(&scope)?;
    let dir = engine(&app, |e| e.dir.clone());
    let mut later = vec![];
    let freed = delete(&dir.join("scopes").join(store::hex(&scope)), &mut later);
    note_later(&dir, &later);
    Ok(Wiped {
        freed,
        later: !later.is_empty(),
        robots,
    })
}

/// Delete every folder's index, or everything (the engine is switched off for every robot).
#[tauri::command(async)]
pub fn context_wipe(
    app: AppHandle,
    window: tauri::WebviewWindow,
    what: Wipe,
) -> Result<Wiped, Error> {
    util::only(&window, window::LABEL)?;
    let robots = switch_off(&app, |_| true);
    let (dir, setup, embedder, folders) = engine(&app, |e| {
        let folders = std::mem::take(&mut e.folders);
        (e.dir.clone(), e.setup.clone(), e.embedder.clone(), folders)
    });
    for f in folders.values() {
        let_go(f);
    }
    drop(folders);
    embedder.unload();
    setup.shut(&dir)?;
    let mut later = vec![];
    let freed = targets(&dir, what)
        .iter()
        .map(|t| delete(t, &mut later))
        .sum();
    note_later(&dir, &later);
    Ok(Wiped {
        freed,
        later: !later.is_empty(),
        robots,
    })
}

/// What goes, in the engine's folder.
fn targets(dir: &Path, what: Wipe) -> Vec<PathBuf> {
    match what {
        Wipe::Indexes => vec![dir.join("pg").join("data"), dir.join("scopes")],
        Wipe::Everything => vec![dir.to_path_buf()],
    }
}

/// The engine switched off for the robots whose folder `goes`, their chats told; their names.
fn switch_off(app: &AppHandle, goes: impl Fn(&str) -> bool) -> Vec<String> {
    let robots: Vec<(String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c.context_engine() && goes(c.folder()))
            .map(|c| (c.id().to_string(), c.name().to_string()))
            .collect()
    });
    for (id, _) in &robots {
        let patch = util::patch(vec![("contextEngine", json!(false))]);
        if with(app, |st| st.store.update(id, patch)).is_some() {
            chat::close_robot_idle(app, id);
            hub::send_to_robot(app, id, "robot:context", json!(Status::default()));
        }
    }
    robots.into_iter().map(|(_, name)| name).collect()
}

/// A folder let go: no longer watched, its keyword index closed, its vectors and graph dropped
/// (a reading or a question still under way holds its own, and lets go when it's done).
fn let_go(f: &Folder) {
    *f.watch.locked() = Watch::default();
    *f.keyword.locked() = None;
    *f.vectors.locked() = Vectors::default();
    *f.graph.locked() = None;
}

/// A file, or a folder with all in it, deleted as far as it can be now: the bytes freed. What's
/// in use is added to `later`. A link (the test copy's junctions) goes, never what it points to.
fn delete(path: &Path, later: &mut Vec<PathBuf>) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        if std::fs::remove_file(path)
            .or_else(|_| std::fs::remove_dir(path))
            .is_err()
        {
            later.push(path.to_path_buf());
        }
        return 0;
    }
    if meta.is_dir() {
        let freed = std::fs::read_dir(path).map_or(0, |entries| {
            entries.flatten().map(|e| delete(&e.path(), later)).sum()
        });
        let _ = std::fs::remove_dir(path); // (not empty: what's left is in `later`)
        return freed;
    }
    match std::fs::remove_file(path) {
        Ok(()) => meta.len(),
        Err(_) => {
            later.push(path.to_path_buf());
            0
        }
    }
}

/// What couldn't go, added to the list for the next start.
fn note_later(dir: &Path, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    log::info!(
        "context engine: {} in use, deleted the next time C-Bot starts",
        paths.len()
    );
    let list = dir.join(LATER);
    let mut text = std::fs::read_to_string(&list).unwrap_or_default();
    for p in paths {
        text.push_str(&format!("{}\n", p.display()));
    }
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&list, text)) {
        log::warn!("couldn't write {}: {e}", list.display());
    }
}

/// C-Bot starts: what couldn't go before (nothing holds it now) goes, with the folders it
/// leaves empty. Only ever what's in the engine's folder.
pub(super) fn leftovers(dir: &Path) {
    let list = dir.join(LATER);
    let Ok(text) = std::fs::read_to_string(&list) else {
        return;
    };
    let mut still = vec![];
    for path in later_paths(&text, dir) {
        delete(&path, &mut still);
        prune_up(&path, dir);
    }
    let done = if still.is_empty() {
        std::fs::remove_file(&list)
    } else {
        let text: String = still.iter().map(|p| format!("{}\n", p.display())).collect();
        std::fs::write(&list, text)
    };
    if let Err(e) = done {
        log::warn!("couldn't write {}: {e}", list.display());
    }
}

/// The list's paths, those in the engine's folder (and not the folder itself).
fn later_paths(text: &str, dir: &Path) -> Vec<PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.starts_with(dir) && p != dir)
        .collect()
}

/// The folders `path` was in, deleted while they're empty, up to the engine's folder.
fn prune_up(path: &Path, dir: &Path) {
    let mut at = path.parent();
    while let Some(p) = at.filter(|p| p.starts_with(dir) && *p != dir) {
        if std::fs::remove_dir(p).is_err() {
            break;
        }
        at = p.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cbot-wipe-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn what_goes_is_read_as_the_page_sends_it() {
        let w: Wipe = serde_json::from_value(json!("indexes")).unwrap();
        assert_eq!(w, Wipe::Indexes);
        let w: Wipe = serde_json::from_value(json!("everything")).unwrap();
        assert_eq!(w, Wipe::Everything);
        let v = serde_json::to_value(Wiped {
            freed: 5,
            later: true,
            robots: vec!["Bolt".into()],
        })
        .unwrap();
        assert_eq!(v, json!({ "freed": 5, "later": true, "robots": ["Bolt"] }));
    }

    #[test]
    fn every_index_goes_but_the_downloads_stay() {
        let dir = Path::new("C:\\ctx");
        assert_eq!(
            targets(dir, Wipe::Indexes),
            [dir.join("pg").join("data"), dir.join("scopes")]
        );
        assert_eq!(targets(dir, Wipe::Everything), [dir.to_path_buf()]);
    }

    #[test]
    fn a_folder_goes_with_all_in_it_and_its_bytes_are_counted() {
        let dir = temp();
        let scope = dir.join("scopes").join("ab");
        std::fs::create_dir_all(scope.join("bm25")).unwrap();
        std::fs::write(scope.join("bm25").join("x"), [0u8; 10]).unwrap();
        std::fs::write(scope.join("y"), [0u8; 5]).unwrap();
        let mut later = vec![];
        assert_eq!(delete(&dir.join("scopes"), &mut later), 15);
        assert!(later.is_empty() && !dir.join("scopes").exists());
        assert_eq!(delete(&dir.join("none"), &mut later), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_link_goes_but_never_what_it_points_to() {
        let dir = temp();
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("model.onnx"), [0u8; 7]).unwrap();
        let engine = dir.join("context");
        std::fs::create_dir_all(&engine).unwrap();
        let link = engine.join("models");
        let linked = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .is_ok_and(|o| o.status.success());
        if linked {
            let mut later = vec![];
            assert_eq!(delete(&engine, &mut later), 0);
            assert!(later.is_empty() && !engine.exists());
            assert!(real.join("model.onnx").exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_was_in_use_goes_at_the_next_start_and_nothing_outside() {
        let dir = temp();
        let held = dir.join("runtime").join("1.0").join("onnxruntime.dll");
        std::fs::create_dir_all(held.parent().unwrap()).unwrap();
        std::fs::write(&held, [0u8; 3]).unwrap();
        let outside = temp().join("keep.txt");
        std::fs::write(&outside, "x").unwrap();
        note_later(&dir, std::slice::from_ref(&held));
        note_later(&dir, std::slice::from_ref(&outside));
        leftovers(&dir);
        assert!(!held.exists() && !dir.join("runtime").exists());
        assert!(outside.exists());
        assert!(!dir.join(LATER).exists());
        assert!(dir.exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(outside.parent().unwrap());
    }

    #[test]
    fn the_list_never_names_the_engines_folder_itself() {
        let dir = Path::new("C:\\ctx");
        let text = "C:\\ctx\nC:\\ctx\\scopes\\a\n\nC:\\other\\x\n  C:\\ctx\\runtime\\r.dll  \n";
        assert_eq!(
            later_paths(text, dir),
            [
                PathBuf::from("C:\\ctx\\scopes\\a"),
                PathBuf::from("C:\\ctx\\runtime\\r.dll")
            ]
        );
    }
}
