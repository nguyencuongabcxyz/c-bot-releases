//! Opening a window on one of the pages (gui/, which Vite builds into dist/): every window
//! loads index.html?view=<view>, with the theme it opens in (?theme=, read by gui/ipc/host.ts
//! before the page draws).

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::runtime::util::encode;
use crate::runtime::with;

/// The look picked in Settings > Theme, as gui/ui/theme.ts reads it.
pub fn theme_of(settings: &Value) -> Value {
    let theme = settings["theme"].as_str().unwrap_or("future");
    let mode = settings["themeMode"].as_str().unwrap_or("auto");
    json!({ "theme": theme, "mode": mode })
}

/// A window on `view`, with `query` passed along (?view=robot&id=…); set its look and
/// size on the builder, then build() it.
pub fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    view: &str,
    query: &[(&str, &str)],
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let theme = with(app, |st| theme_of(st.store.settings())).to_string();
    let mut url = format!("index.html?view={}&theme={}", encode(view), encode(&theme));
    for (k, v) in query {
        url.push_str(&format!("&{}={}", encode(k), encode(v)));
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
}

/// The theme changed: every open window follows (gui/ui/theme.ts listens).
pub fn theme_changed(app: &AppHandle) {
    let pick = with(app, |st| theme_of(st.store.settings()));
    let _ = app.emit("theme:changed", pick);
}
