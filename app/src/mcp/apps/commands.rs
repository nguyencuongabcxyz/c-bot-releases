//! What an app's page (in the chat or its window) asks: its page, its tools called, its size, links opened.

use super::*;

// (from a robot's chat, or a view's own window: folder_of knows whose folder either is in)

/// The view a tool comes with, if it has one.
#[tauri::command(async)]
pub fn robot_app_view(app: AppHandle, window: tauri::WebviewWindow, tool_name: String) -> Value {
    app_for(&app, &tool_name, &folder_of(&app, window.label())).unwrap_or(Value::Null)
}

/// A view's page, from its server.
#[tauri::command(async)]
pub fn robot_app_page(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server: String,
    uri: String,
) -> Value {
    match page_for(&app, &server, &uri, &folder_of(&app, window.label())) {
        Ok(mut page) => {
            page["ok"] = json!(true);
            page
        }
        Err(e) => json!({ "ok": false, "error": e.message }),
    }
}

/// A view's own request to its server (tools/call, resources/read…).
#[tauri::command(async)]
pub fn robot_app_call(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server: String,
    method: String,
    params: Option<Value>,
) -> Value {
    match call_from_app(
        &app,
        &server,
        &method,
        &params.unwrap_or_default(),
        &folder_of(&app, window.label()),
    ) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(e) => json!({ "ok": false, "error": e.message, "code": e.code }),
    }
}

/// A view, big in a window of its own.
#[tauri::command(async)]
pub fn robot_app_window(app: AppHandle, window: tauri::WebviewWindow, view: Value) -> bool {
    robots::id_of(window.label()).is_some_and(|id| open_window(&app, id, &view))
}

/// What a view window shows.
#[tauri::command(async)]
pub fn appview_init(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    apps(&app, |a| {
        a.windows.get(window.label()).map(|(_, v)| v.clone())
    })
    .unwrap_or(Value::Null)
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Apps::default()));
}
