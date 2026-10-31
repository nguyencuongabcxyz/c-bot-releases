//! Everything about the engine, for the chat's panel (robot_context_details) and the Context
//! engine window (window.rs): a folder (its index, the languages in it, whether it's watched,
//! its git branch and last commit), every folder the store holds and which robots read it, the
//! store itself (its PostgreSQL, size, vectors by model), and the models (downloaded, loaded,
//! size). Nothing is started or downloaded for asking: what isn't up says so.

use super::*;

/// What the panel shows.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub folder: Option<FolderDetails>, // (the robot's own, while it has the engine on)
    pub store: Option<StoreDetails>,   // (while the database is up)
    pub repos: Vec<RepoDetails>,
    pub models: Vec<ModelDetails>,
    pub dir: String, // (where the engine keeps it all)
}

/// The robot's own folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDetails {
    pub root: String,
    pub status: Status,
    pub watched: bool,
    pub read_at: Option<u64>, // (when it was last brought up to date, ms since 1970)
    pub languages: Vec<LanguageCount>, // (and its kinds of config file, XML, YAML…)
    pub docs: usize,          // (Markdown and text files)
    pub keyword_bytes: u64,
    pub vectors_in_memory: usize,
    pub graph_built: bool,
    pub git: Option<history::GitInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCount {
    pub name: String,
    pub files: usize,
}

/// The store.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDetails {
    pub version: String, // (PostgreSQL's)
    pub port: u16,
    pub data_dir: String,
    pub started_here: bool, // (by this C-Bot, which stops it on its way out)
    pub bytes: i64,
    pub vectors: Vec<VectorCount>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCount {
    pub model: String,
    pub count: i64,
}

/// A folder the store holds.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetails {
    pub root: String,
    pub files: i64,
    pub chunks: i64,
    pub embedded: i64,
    pub generation: i64,
    pub robots: Vec<String>, // (the robots with the engine on that read it, by name)
    pub current: bool,       // (this robot's)
    pub open: bool,          // (in memory now)
    pub kinds: Vec<KindCount>, // (its files by language or kind of document, most first)
    pub bytes: i64,          // (its files', as last read)
}

/// Files of one language or kind of document, and their bytes.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub name: String,
    pub files: i64,
    pub bytes: i64,
}

/// A folder's files by type (as the store keeps them) put by the name the chat shows (TypeScript
/// and TSX are one), most first.
fn kinds(types: &[(String, i64, i64)]) -> Vec<KindCount> {
    let mut out: Vec<KindCount> = vec![];
    for (ty, files, bytes) in types {
        let name = FileType::from_id(ty).map_or_else(|| ty.clone(), |t| t.name().to_string());
        match out.iter_mut().find(|k| k.name == name) {
            Some(k) => {
                k.files += files;
                k.bytes += bytes;
            }
            None => out.push(KindCount {
                name,
                files: *files,
                bytes: *bytes,
            }),
        }
    }
    out.sort_by(|a, b| b.files.cmp(&a.files).then_with(|| a.name.cmp(&b.name)));
    out
}

/// What a model is for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelRole {
    #[default]
    Sentence,
    Reranker,
    Runtime,
}

/// A model, or what runs them.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDetails {
    pub role: ModelRole,
    pub name: String,
    pub downloaded: bool,
    pub loaded: bool,
    pub bytes: u64,
}

/// Everything about the engine, as the robot `id` sees it.
#[tauri::command(async)]
pub fn robot_context_details(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Details, Error> {
    let id = robots::sender(&window)?;
    let folder = on(&app, &id).then(|| folder_for(&app, &id).ok()).flatten();
    let current = folder.as_ref().map(|f| f.key.clone());
    Ok(details(&app, current.as_deref(), folder.as_deref()))
}

/// Everything about the engine: `current` the folder (as key()) to mark as this one, `folder`
/// the one in memory to tell about in full.
pub(super) fn details(app: &AppHandle, current: Option<&str>, folder: Option<&Folder>) -> Details {
    let (dir, setup, embedder) = engine(app, |e| {
        (e.dir.clone(), e.setup.clone(), e.embedder.clone())
    });
    let db = setup.running();
    let overview = db.as_ref().and_then(|db| overview_of(db));
    Details {
        folder: folder.map(|f| folder_details(&dir, f, types_of(overview.as_ref(), &f.key))),
        store: db.as_ref().map(|db| store_details(db, overview.as_ref())),
        repos: overview
            .map(|o| repos(app, &o, current))
            .unwrap_or_default(),
        models: models(&dir, &embedder),
        dir: dir.to_string_lossy().into_owned(),
    }
}

/// What the store holds, in a few numbers (none if it can't say).
pub(super) fn overview_of(db: &Database) -> Option<store::Overview> {
    db.store
        .overview(embed::IDENTITY)
        .inspect_err(|e| log::warn!("the context engine's details: {e}"))
        .ok()
}

/// A folder's files by type, as the store counts them.
fn types_of<'a>(
    o: Option<&'a store::Overview>,
    folder_key: &str,
) -> Option<&'a [(String, i64, i64)]> {
    o?.folders
        .iter()
        .find(|s| key(&s.root) == folder_key)
        .map(|s| s.types.as_slice())
}

/// A folder of the store, as the window shows it: in full while it's in memory, else what the
/// store knows of it (its counts, its languages, its git; not read, not watched).
pub(super) fn repo_details(app: &AppHandle, root: &str) -> Result<(FolderDetails, bool), Error> {
    let dir = engine(app, |e| e.dir.clone());
    let db = browse::running_store(app)?;
    let overview = overview_of(&db);
    if let Some(f) = folder_at(app, root) {
        return Ok((
            folder_details(&dir, &f, types_of(overview.as_ref(), &f.key)),
            true,
        ));
    }
    let k = key(root);
    let Some(s) = overview
        .as_ref()
        .and_then(|o| o.folders.iter().find(|s| key(&s.root) == k))
    else {
        return Err(format!("The store holds nothing of {root}.").into());
    };
    let scope = store::scope_id(&k);
    let (languages, docs) = languages_of(&s.types);
    let count = |n: i64| usize::try_from(n).unwrap_or(0);
    let status = Status {
        files: count(s.files),
        chunks: count(s.chunks),
        embedded: count(s.embedded),
        symbols: count(db.store.defs_count(&scope)?),
        ..Status::default()
    };
    let details = FolderDetails {
        root: s.root.clone(),
        status,
        languages,
        docs,
        keyword_bytes: bytes_in(&keyword_dir(&dir, &scope)),
        git: history::info(Path::new(&s.root)),
        ..FolderDetails::default()
    };
    Ok((details, false))
}

/// A folder's languages (and kinds of config file) and its docs, from its files by type.
fn languages_of(types: &[(String, i64, i64)]) -> (Vec<LanguageCount>, usize) {
    let mut docs = 0;
    let mut by: BTreeMap<&'static str, usize> = BTreeMap::new();
    for (ty, files, _) in types {
        let files = usize::try_from(*files).unwrap_or(0);
        match FileType::from_id(ty) {
            Some(FileType::Markdown | FileType::Text) => docs += files,
            Some(t) => *by.entry(t.name()).or_default() += files,
            None => {}
        }
    }
    let mut languages: Vec<LanguageCount> = by
        .into_iter()
        .map(|(name, files)| LanguageCount {
            name: name.to_string(),
            files,
        })
        .collect();
    languages.sort_by_key(|l| std::cmp::Reverse(l.files));
    (languages, docs)
}

/// Where a folder's keyword index is.
fn keyword_dir(dir: &Path, scope: &ScopeId) -> PathBuf {
    dir.join("scopes").join(store::hex(scope)).join("bm25")
}

/// The robot's folder; `types` its files by type as the store counts them (when it's running):
/// its config files go with its languages, and only its Markdown and text are docs.
fn folder_details(dir: &Path, f: &Folder, types: Option<&[(String, i64, i64)]>) -> FolderDetails {
    let status = f.status.locked().clone();
    let read_at = f.gate.locked().when.map(|t| {
        t.duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    });
    let (mut languages, code_files) = {
        let code = f.code.locked();
        let mut by: BTreeMap<&str, usize> = BTreeMap::new();
        for file in code.files.values() {
            *by.entry(file.lang.name()).or_default() += 1;
        }
        let v: Vec<LanguageCount> = by
            .into_iter()
            .map(|(name, files)| LanguageCount {
                name: name.to_string(),
                files,
            })
            .collect();
        (v, code.files.len())
    };
    let mut docs = status.files.saturating_sub(code_files);
    if let Some(types) = types {
        docs = 0;
        for (ty, files, _) in types {
            let files = usize::try_from(*files).unwrap_or(0);
            match FileType::from_id(ty) {
                Some(t @ FileType::Config(_)) => languages.push(LanguageCount {
                    name: t.name().to_string(),
                    files,
                }),
                Some(FileType::Markdown | FileType::Text) => docs += files,
                _ => {}
            }
        }
    }
    languages.sort_by_key(|l| std::cmp::Reverse(l.files));
    FolderDetails {
        root: f.root.to_string_lossy().into_owned(),
        docs,
        status,
        watched: watch::watched(f),
        read_at,
        languages,
        keyword_bytes: bytes_in(&keyword_dir(dir, &f.scope)),
        vectors_in_memory: f.vectors.locked().len(),
        graph_built: f.graph.locked().is_some(),
        git: history::info(&f.root),
    }
}

fn store_details(db: &Database, overview: Option<&store::Overview>) -> StoreDetails {
    let (version, port, data, started_here) = db.cluster.about();
    StoreDetails {
        version,
        port,
        data_dir: data.to_string_lossy().into_owned(),
        started_here,
        bytes: overview.map_or(0, |o| o.bytes),
        vectors: overview
            .map(|o| {
                o.vectors
                    .iter()
                    .map(|(model, count)| VectorCount {
                        model: model.clone(),
                        count: *count,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Every folder in the store, with the robots that read it.
fn repos(app: &AppHandle, o: &store::Overview, current: Option<&str>) -> Vec<RepoDetails> {
    let robots: Vec<(String, String)> = with(app, |st| {
        st.store
            .list()
            .iter()
            .filter(|c| c.context_engine())
            .map(|c| (key(c.folder()), c.name().to_string()))
            .collect()
    });
    let open: HashSet<String> = engine(app, |e| e.folders.keys().cloned().collect());
    o.folders
        .iter()
        .map(|s| {
            let k = key(&s.root);
            RepoDetails {
                root: s.root.clone(),
                files: s.files,
                chunks: s.chunks,
                embedded: s.embedded,
                generation: s.generation,
                robots: robots
                    .iter()
                    .filter(|(rk, _)| *rk == k)
                    .map(|(_, name)| name.clone())
                    .collect(),
                current: current == Some(k.as_str()),
                open: open.contains(&k),
                kinds: kinds(&s.types),
                bytes: s.types.iter().map(|(_, _, b)| b).sum(),
            }
        })
        .collect()
}

fn models(dir: &Path, embedder: &Embedder) -> Vec<ModelDetails> {
    let (sentence, reranker) = embedder.loaded();
    let model = |role, spec: &install::Spec, loaded| {
        let at = install::model_downloaded(dir, spec);
        ModelDetails {
            role,
            name: spec.name().to_string(),
            downloaded: at.is_some(),
            loaded,
            bytes: at.map_or(0, |p| bytes_in(&p)),
        }
    };
    let runtime = install::runtime_downloaded(dir);
    vec![
        model(ModelRole::Sentence, &install::SENTENCE, sentence),
        model(ModelRole::Reranker, &install::RERANKER, reranker),
        ModelDetails {
            role: ModelRole::Runtime,
            name: format!("ONNX Runtime {}", install::RUNTIME_VERSION),
            downloaded: runtime.is_some(),
            loaded: sentence || reranker,
            bytes: runtime
                .and_then(|p| std::fs::metadata(p).ok())
                .map_or(0, |m| m.len()),
        },
    ]
}

/// The bytes of the files in a folder, and in its folders (0 when it isn't there).
fn bytes_in(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => bytes_in(&e.path()),
            Ok(_) => e.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_details_go_to_the_page_as_it_reads_them() {
        let d = Details {
            repos: vec![RepoDetails {
                root: "C:\\work".into(),
                robots: vec!["Bolt".into()],
                current: true,
                ..RepoDetails::default()
            }],
            models: vec![ModelDetails {
                role: ModelRole::Reranker,
                name: "r".into(),
                ..ModelDetails::default()
            }],
            ..Details::default()
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["repos"][0]["robots"][0], "Bolt");
        assert_eq!(v["repos"][0]["current"], true);
        assert_eq!(v["models"][0]["role"], "reranker");
        assert!(v["folder"].is_null() && v["store"].is_null());
        let f = serde_json::to_value(FolderDetails::default()).unwrap();
        for field in [
            "readAt",
            "keywordBytes",
            "vectorsInMemory",
            "graphBuilt",
            "git",
        ] {
            assert!(f.get(field).is_some(), "{field}");
        }
    }

    #[test]
    fn a_folders_files_are_counted_by_the_name_the_chat_shows() {
        let types = [
            ("markdown".to_string(), 2, 100),
            ("typescript".to_string(), 3, 300),
            ("tsx".to_string(), 2, 50),
            ("rust".to_string(), 5, 900),
        ];
        let got: Vec<(String, i64, i64)> = kinds(&types)
            .into_iter()
            .map(|k| (k.name, k.files, k.bytes))
            .collect();
        assert_eq!(
            got,
            [
                ("Rust".to_string(), 5, 900),
                ("TypeScript/JavaScript".to_string(), 5, 350),
                ("Markdown".to_string(), 2, 100),
            ]
        );
    }

    #[test]
    fn a_folder_the_store_holds_has_its_languages_and_docs() {
        let types = [
            ("markdown".to_string(), 2, 100),
            ("text".to_string(), 1, 10),
            ("typescript".to_string(), 3, 300),
            ("tsx".to_string(), 2, 50),
            ("rust".to_string(), 9, 900),
        ];
        let (languages, docs) = languages_of(&types);
        let got: Vec<(&str, usize)> = languages
            .iter()
            .map(|l| (l.name.as_str(), l.files))
            .collect();
        assert_eq!(got, [("Rust", 9), ("TypeScript/JavaScript", 5)]);
        assert_eq!(docs, 3);
    }

    #[test]
    fn a_folders_bytes_count_its_folders_too() {
        let dir =
            std::env::temp_dir().join(format!("cbot-bytes-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("x"), [0u8; 10]).unwrap();
        std::fs::write(dir.join("a").join("y"), [0u8; 5]).unwrap();
        assert_eq!(bytes_in(&dir), 15);
        assert_eq!(bytes_in(&dir.join("none")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
