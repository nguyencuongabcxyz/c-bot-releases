//! What's in a folder's index, file by file, for the Context engine window (window.rs): every
//! file the store holds of a folder (its kind, size, chunks, how many have their vector, its
//! definitions), and one file opened up (its definitions as the tools read them, its chunks as
//! search finds them, and its text as it is on disk now). It's all read from the store, so any folder it holds can be looked
//! at, whether a robot reads it now or not. Like details.rs, nothing is started for asking:
//! while the database is down it says so.

use super::*;

/// A folder's files (context_files).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFiles {
    root: String,
    files: Vec<IndexedFile>,
}

/// A file of the index.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    path: String, // (in the folder, as the store keeps it)
    kind: String, // (its language or kind of document, as the chat names it)
    code: bool,   // (search counts it as code, not a document)
    bytes: i64,
    chunks: i64,
    embedded: i64, // (its chunks with their vector)
    defs: i64,
}

/// One file opened up (context_file).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    path: String,
    full: String, // (on disk, to open it)
    defs: Vec<DefView>,
    chunks: Vec<ChunkView>,
}

/// A definition, as the tools read it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefView {
    name: String,
    kind: Kind,
    container: Option<String>,
    line: u32,
    end: u32,
    depth: u8,
    sig: String,
}

/// A chunk, as search finds it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkView {
    idx: i32,
    code: bool,
    from: i32,
    to: i32,
    symbol: String,
    text: String,
    embedded: bool,
}

/// The store, as it is (nothing started for asking).
pub(super) fn running_store(app: &AppHandle) -> Result<Arc<Database>, Error> {
    Ok(engine(app, |e| e.setup.clone()).running().ok_or(
        "The index's database isn't running: switch the context engine on for a robot first.",
    )?)
}

/// Every file the store holds of the folder at `root`, by path.
#[tauri::command(async)]
pub fn context_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
) -> Result<IndexedFiles, Error> {
    util::only(&window, window::LABEL)?;
    let db = running_store(&app)?;
    let stored = db
        .store
        .files(&store::scope_id(&key(&root)), embed::IDENTITY)?;
    let files = stored
        .into_iter()
        .map(|s| {
            let ty = FileType::from_id(&s.ty);
            IndexedFile {
                kind: ty.map_or_else(|| s.ty.clone(), |t| t.name().to_string()),
                code: ty.is_some_and(FileType::is_code),
                path: s.path,
                bytes: s.bytes,
                chunks: s.chunks,
                embedded: s.embedded,
                defs: s.defs,
            }
        })
        .collect();
    Ok(IndexedFiles { root, files })
}

/// One file of the folder at `root`: its definitions and its chunks.
#[tauri::command(async)]
pub fn context_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
    path: String,
) -> Result<FileIndex, Error> {
    util::only(&window, window::LABEL)?;
    let db = running_store(&app)?;
    let scope = store::scope_id(&key(&root));
    let Some(facts) = db.store.facts_of(&scope, &path)? else {
        return Err(format!("{path} isn't in the index (any more).").into());
    };
    let facts: Facts = serde_json::from_str(&facts).unwrap_or_default();
    let chunks = db
        .store
        .chunks_of(&scope, &path, embed::IDENTITY)?
        .into_iter()
        .map(|(c, embedded)| ChunkView {
            idx: c.idx,
            code: c.code,
            from: c.line_from,
            to: c.line_to,
            symbol: c.symbol,
            text: c.text,
            embedded,
        })
        .collect();
    Ok(FileIndex {
        full: on_disk(Path::new(&root), &path)
            .to_string_lossy()
            .into_owned(),
        path,
        defs: facts.defs.iter().map(def_view).collect(),
        chunks,
    })
}

/// The most of a file the window shows (a bigger one says so).
const SOURCE_MAX: u64 = 2 * 1024 * 1024;

/// A file of the index as it is on disk now, to read beside its definitions and chunks.
#[tauri::command(async)]
pub fn context_source(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
    path: String,
) -> Result<String, Error> {
    util::only(&window, window::LABEL)?;
    let db = running_store(&app)?;
    if db
        .store
        .facts_of(&store::scope_id(&key(&root)), &path)?
        .is_none()
    {
        return Err(format!("{path} isn't in the index (any more).").into());
    }
    let at = on_disk(Path::new(&root), &path);
    let size = std::fs::metadata(&at)
        .map_err(|e| format!("Couldn't read {}: {e}", at.display()))?
        .len();
    if size > SOURCE_MAX {
        return Err(format!(
            "{path} is too big to show here ({} MB).",
            size / (1024 * 1024)
        )
        .into());
    }
    let bytes = std::fs::read(&at).map_err(|e| format!("Couldn't read {}: {e}", at.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn def_view(d: &Def) -> DefView {
    DefView {
        name: d.name.clone(),
        kind: d.kind,
        container: d.container.clone(),
        line: d.line,
        end: d.end,
        depth: d.depth,
        sig: d.sig.clone(),
    }
}

/// Where a file of the folder is on disk (the store keeps its path with `/`).
fn on_disk(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .filter(|p| !p.is_empty())
        .fold(root.to_path_buf(), |at, part| at.join(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_files_index_goes_to_the_page_as_it_reads_it() {
        let f = FileIndex {
            path: "src/a.rs".into(),
            full: "C:\\w\\src\\a.rs".into(),
            defs: vec![DefView {
                name: "open".into(),
                kind: Kind::Function,
                container: None,
                line: 3,
                end: 9,
                depth: 0,
                sig: "fn open()".into(),
            }],
            chunks: vec![ChunkView {
                idx: 0,
                code: true,
                from: 1,
                to: 9,
                symbol: "open".into(),
                text: "fn open() {}".into(),
                embedded: true,
            }],
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["defs"][0]["kind"], "function");
        assert!(v["defs"][0]["container"].is_null());
        assert_eq!(v["chunks"][0]["from"], 1);
        assert_eq!(v["chunks"][0]["embedded"], true);
        let file = serde_json::to_value(IndexedFile::default()).unwrap();
        for field in [
            "path", "kind", "code", "bytes", "chunks", "embedded", "defs",
        ] {
            assert!(file.get(field).is_some(), "{field}");
        }
    }

    #[test]
    fn a_file_of_the_folder_is_found_on_disk() {
        let root = Path::new("C:\\work");
        assert_eq!(on_disk(root, "src/a.rs"), root.join("src").join("a.rs"));
        assert_eq!(on_disk(root, "a.rs"), root.join("a.rs"));
    }
}
