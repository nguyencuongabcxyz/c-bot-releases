//! An app in a big window of its own, out of the chat.

use super::*;

/// An MCP tool's view, big, in a window of its own (the view's fullscreen mode). One window
/// per tool call: asking again brings it to the front.
pub(super) fn open_window(app: &AppHandle, robot_id: &str, view: &Value) -> bool {
    if robot_id.is_empty() || text(&view["server"]).is_empty() || text(&view["uri"]).is_empty() {
        return false;
    }
    let id = text(&view["id"]);
    let open = apps(app, |a| {
        a.windows
            .iter()
            .find(|(_, (_, v))| v["id"] == id.as_str())
            .map(|(l, _)| l.clone())
    });
    if let Some(label) = open
        && let Some(w) = app.get_webview_window(&label)
    {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return true;
    }
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let label = format!("appview-{}", COUNT.fetch_add(1, Ordering::Relaxed) + 1);
    let title = text(&view["title"]);
    let kept = json!({ "id": id, "server": text(&view["server"]), "tool": text(&view["tool"]), "uri": text(&view["uri"]), "title": title, "input": view["input"], "result": view["result"] });
    apps(app, |a| {
        a.windows
            .insert(label.clone(), (robot_id.to_string(), kept))
    });
    let app = app.clone();
    // (off this thread: building a window waits on the main thread)
    thread::spawn(move || {
        let p = window::primary_monitor();
        let (w, h) = (
            (p.work.w as f64 / p.scale * 0.85).round().min(1400.0),
            (p.work.h as f64 / p.scale * 0.85).round().min(950.0),
        );
        let built = views::builder(&app, &label, "appview", &[])
            .title(if title.is_empty() {
                "Tool view"
            } else {
                &title
            })
            .inner_size(w, h)
            .center()
            .background_color(tauri::window::Color(0xff, 0xff, 0xff, 0xff))
            .build();
        match built {
            Ok(win) => {
                let (app2, label2) = (app.clone(), label.clone());
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        apps(&app2, |a| a.windows.remove(&label2));
                    }
                });
            }
            Err(err) => {
                log::warn!("couldn't open {label}: {err}");
                apps(&app, |a| a.windows.remove(&label));
            }
        }
    });
    true
}

/// The folder of the robot a window belongs to (its own, or the one a big view came from).
pub(super) fn folder_of(app: &AppHandle, label: &str) -> String {
    let id = robots::id_of(label)
        .map(str::to_string)
        .or_else(|| apps(app, |a| a.windows.get(label).map(|(r, _)| r.clone())));
    let Some(id) = id else { return String::new() };
    with(app, |st| {
        st.store
            .get(&id)
            .and_then(|c| c["folder"].as_str().map(str::to_string))
    })
    .unwrap_or_default()
}
