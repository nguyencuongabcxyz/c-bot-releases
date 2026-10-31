//! The Context engine window ("context"): every folder the store holds, and one looked at in
//! full (its overview, every file with its definitions and chunks, the store and the models).
//! A normal window, to make as big as you like; one at a time, and opening it again brings it
//! round on the folder asked for (a robot's, from its menu or its chat). It hears each folder's
//! status as it changes (context:status) and is told which to show (context:focus).

use super::*;

pub const LABEL: &str = "context";

/// The folder it was last opened on (its root, as the robot's folder is written).
#[derive(Default)]
struct Shown {
    root: Option<String>,
}

fn shown<R>(app: &AppHandle, f: impl FnOnce(&mut Shown) -> R) -> R {
    part_or_default(app, f)
}

/// Open it (or bring it round), on robot `robot_id`'s folder if it has one.
pub fn open_window(app: &AppHandle, robot_id: Option<String>) {
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.locked();
    let root = robot_id.and_then(|id| {
        with(app, |st| {
            st.store
                .get(&id)
                .map(|c| c.folder().to_string())
                .filter(|f| !f.is_empty())
        })
    });
    shown(app, |s| s.root.clone_from(&root));
    if let Some(w) = app.get_webview_window(LABEL) {
        if root.is_some() {
            let _ = w.emit("context:focus", json!(root));
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = views::builder(app, LABEL, "context", &[])
        .title("Context engine — C-Bot")
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .build();
    if let Err(err) = built {
        log::warn!("couldn't open the Context engine window: {err}");
    }
}

/// A robot's chat opens the window on its folder.
#[tauri::command(async)]
pub fn robot_context_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), Error> {
    let id = robots::sender(&window)?;
    open_window(&app, Some(id));
    Ok(())
}

/// A folder's status changed: the window, if it's up, hears it.
pub(super) fn tell(app: &AppHandle, root: &Path, status: &Status) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.emit(
            "context:status",
            json!({ "root": root.to_string_lossy(), "status": status }),
        );
    }
}

/// What the window opens on: the folder asked for, as the store names it if it holds it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInit {
    focus: Option<String>,
}

#[tauri::command(async)]
pub fn context_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<ContextInit, Error> {
    util::only(&window, LABEL)?;
    let asked = shown(&app, |s| s.root.clone());
    // (the store's name for it, so the page finds it in its list)
    let focus = asked.map(|root| {
        browse::running_store(&app)
            .ok()
            .and_then(|db| details::overview_of(&db))
            .and_then(|o| {
                o.folders
                    .into_iter()
                    .find(|s| key(&s.root) == key(&root))
                    .map(|s| s.root)
            })
            .unwrap_or(root)
    });
    Ok(ContextInit { focus })
}

/// Everything about the engine: the store, every folder in it, the models.
#[tauri::command(async)]
pub fn context_details(app: AppHandle, window: tauri::WebviewWindow) -> Result<Details, Error> {
    util::only(&window, LABEL)?;
    let current = shown(&app, |s| s.root.as_deref().map(key));
    Ok(details::details(&app, current.as_deref(), None))
}

/// One folder of the store, as the window shows it; loaded: a robot reads it now (so it's in
/// memory, watched, with its code graph).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    folder: FolderDetails,
    loaded: bool,
}

#[tauri::command(async)]
pub fn context_repo(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
) -> Result<RepoView, Error> {
    util::only(&window, LABEL)?;
    let (folder, loaded) = details::repo_details(&app, &root)?;
    Ok(RepoView { folder, loaded })
}

/// Read a folder again from scratch (one a robot reads now).
#[tauri::command(async)]
pub fn context_reindex(
    app: AppHandle,
    window: tauri::WebviewWindow,
    root: String,
) -> Result<(), Error> {
    util::only(&window, LABEL)?;
    let Some(f) = folder_at(&app, &root) else {
        return Err("No robot with the context engine on reads this folder now.".into());
    };
    set_status(
        &app,
        &f,
        Status {
            phase: Phase::Indexing,
            ..Status::default()
        },
    );
    thread::spawn(move || look::look(&app, &f, true));
    Ok(())
}

/// Open a file of a folder in its app, or show it in its folder.
#[tauri::command(async)]
pub fn context_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    reveal: bool,
) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    util::only(&window, LABEL)?;
    let opener = app.opener();
    let done = if reveal {
        opener.reveal_item_in_dir(&path)
    } else {
        opener.open_path(&path, None::<&str>)
    };
    done.map_err(|e| format!("Couldn't open {path}: {e}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_window_hears_goes_as_it_reads_it() {
        let v = serde_json::to_value(ContextInit {
            focus: Some("C:\\w".into()),
        })
        .unwrap();
        assert_eq!(v, json!({ "focus": "C:\\w" }));
        let r = serde_json::to_value(RepoView {
            folder: FolderDetails::default(),
            loaded: true,
        })
        .unwrap();
        assert_eq!(r["loaded"], true);
        assert!(r["folder"]["status"]["graph"].is_boolean());
    }
}
