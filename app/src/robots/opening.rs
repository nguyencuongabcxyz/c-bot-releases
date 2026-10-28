//! A robot's window: opening it, and what its page is sent (how it looks, its character).

use super::*;

/// What the page knows about its robot (main.js robotView).
pub fn view(st: &State, c: &Value) -> Value {
    let id = c.id();
    let mut v = c.clone();
    let mut any_busy = false;
    let tabs: Vec<Value> = c["tabs"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| {
                    let mut t = t.clone();
                    let busy = chat::is_busy(st, id, t.id());
                    any_busy |= busy;
                    t["custom"] = json!(!t["title"].as_str().unwrap_or("").is_empty());
                    t["title"] = json!(title_for(&t));
                    t["busy"] = json!(busy);
                    t
                })
                .collect()
        })
        .unwrap_or_default();
    let closed: Vec<Value> = c["closedTabs"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| json!({ "id": t["id"], "title": title_for(t), "closedAt": t["closedAt"] }))
                .collect()
        })
        .unwrap_or_default();
    v["tabs"] = json!(tabs);
    v["closedTabs"] = json!(closed);
    v["busy"] = json!(any_busy);
    let term = terminal::tab_of(st, id);
    v["terminalOpen"] = json!(term.is_some());
    v["terminalTab"] = json!(term);
    v
}

pub fn send_character(app: &AppHandle, id: &str) {
    if let Some(c) = with(app, |st| st.store.get(id).map(|c| view(st, c))) {
        let _ = app.emit_to(label_of(id), "robot:character", c);
    }
    island::changed(app); // (a new name or paint)
}

pub fn open(app: &AppHandle, id: &str, index: usize) -> tauri::Result<()> {
    let label = label_of(id);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let Some(c) = with(app, |st| st.store.get(id).cloned()) else {
        return Ok(());
    };
    let dims = dims_of(c["size"].as_str().unwrap_or("normal"));
    let anchor = clamp_anchor(
        from_dip(&c["position"]).unwrap_or_else(|| default_anchor(index)),
        dims,
    );
    let win = views::builder(app, &label, "robot", &[("id", id)])
        .title(c["name"].as_str().unwrap_or("Robo"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(dims.0, dims.1)
        .build()?;
    let hwnd = win.hwnd()?.0 as isize;
    let (_, w, h) = place(anchor, dims);
    window::set_bounds(
        hwnd,
        Rect {
            x: anchor.0,
            y: anchor.1,
            w,
            h,
        },
    );
    let chat_w = c["chatWidth"].as_f64().unwrap_or(CHAT_W);
    let peek = away_on_island(app, id, &c);
    if peek {
        walkers::veil(app, hwnd, true);
    }
    with(app, |st| {
        st.robots.insert(
            id.to_string(),
            Robot {
                hwnd,
                anchor,
                dims,
                expanded: false,
                tucked: false,
                peek,
                veiled: peek,
                chat_w,
                side_w: 0.0,
                drag: None,
                resize_from: None,
                layout: None,
                seq: 0,
                through: false,
                forwarded: None,
                eyes: None,
                stage: None,
            },
        )
    });
    revive::watch(app, &win, id);
    let (app2, id2) = (app.clone(), id.to_string());
    win.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            closed(&app2, &id2, hwnd);
        }
    });
    island::changed(app);
    Ok(())
}

/// Away on the island: veiled from the start. With the island turned off it's out on its
/// desk instead (and saved so).
fn away_on_island(app: &AppHandle, id: &str, c: &Value) -> bool {
    let peek = c["peek"].as_bool().unwrap_or(false) && island::on(app);
    if !peek && c["peek"].as_bool() == Some(true) {
        with(app, |st| {
            st.store.update(
                id,
                crate::runtime::util::patch(vec![("peek", json!(false))]),
            )
        });
    }
    peek
}

/// Its window's gone: it's forgotten, and what went with it closes too.
fn closed(app: &AppHandle, id: &str, hwnd: isize) {
    // (only if it's still this window: built again, a new one may be there already)
    let mine = with(app, |st| {
        let mine = st.robots.get(id).is_some_and(|r| r.hwnd == hwnd);
        if mine {
            st.robots.remove(id);
        }
        mine
    });
    if mine {
        revive::forget(app, id);
        walkers::close(app, id); // (put away while out for a walk: the walker goes too)
        shell::close(app, id); // (and the shell in its chat)
        stage::gone(app, id);
        island::gone(app, id);
    }
}
