//! A robot's window: opening it, and what its page is sent (how it looks, its character).

use super::*;

/// Which tabs' conversations go with a robot's view (they can run to MBs: sent only when
/// the page doesn't have them yet).
#[derive(Clone, Copy, PartialEq)]
pub enum Histories {
    /// Its page (re)loading: every one, noted as sent.
    All,
    /// Only those that changed since its page was sent them (it keeps the rest).
    Changed,
    /// None (the Workshop doesn't show them).
    Not,
}

/// What the page knows about its robot (main.js robotView).
pub fn view(st: &mut State, id: &str, histories: Histories) -> Option<Value> {
    let sent = histories_to_send(st, id, histories);
    let c = st.store.get(id)?;
    Some(view_of(st, c, &sent))
}

/// The tabs whose conversations go with the view, noted as the robot's page has them.
fn histories_to_send(st: &mut State, id: &str, histories: Histories) -> HashSet<String> {
    if histories == Histories::Not {
        return HashSet::new();
    }
    let revs: HashMap<String, u64> = st
        .store
        .get(id)
        .and_then(|c| c["tabs"].as_array())
        .into_iter()
        .flatten()
        .map(|t| (t.id().to_string(), st.store.history_rev(t.id())))
        .collect();
    let Some(r) = st.robots.get_mut(id) else {
        return revs.into_keys().collect(); // (no window to remember for: all of them)
    };
    let send = unsent(&r.sent, &revs, histories == Histories::All);
    r.sent = revs; // (closed tabs drop out: reopened, theirs is sent again)
    send
}

/// The tabs whose conversation the page hasn't got as it is now (`all`: it has none).
fn unsent(sent: &HashMap<String, u64>, now: &HashMap<String, u64>, all: bool) -> HashSet<String> {
    now.iter()
        .filter(|(t, rev)| all || sent.get(*t) != Some(rev))
        .map(|(t, _)| t.clone())
        .collect()
}

fn view_of(st: &State, c: &Value, sent: &HashSet<String>) -> Value {
    let id = c.id();
    let mut any_busy = false;
    let tabs: Vec<Value> = c["tabs"]
        .as_array()
        .map(|t| {
            t.iter()
                .map(|t| {
                    let mut t = without(t, |k| k == "history" && !sent.contains(t.id()));
                    let busy = chat::is_busy(st, id, t.id());
                    any_busy |= busy;
                    t["custom"] = json!(!t["title"].as_str().unwrap_or("").is_empty());
                    t["title"] = json!(title_for(c_tab(c, t.id())));
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
    let mut v = without(c, |k| k == "tabs" || k == "closedTabs");
    v["tabs"] = json!(tabs);
    v["closedTabs"] = json!(closed);
    v["busy"] = json!(any_busy);
    let term = terminal::tab_of(st, id);
    v["terminalOpen"] = json!(term.is_some());
    v["terminalTab"] = json!(term);
    v
}

/// The tab itself (its title comes from its first question, even when its conversation isn't sent).
fn c_tab<'a>(c: &'a Value, tab_id: &str) -> &'a Value {
    c["tabs"]
        .as_array()
        .and_then(|t| t.iter().find(|t| t.id() == tab_id))
        .unwrap_or(&Value::Null)
}

/// A copy of an object without some of its fields (the big ones: not copied only to be dropped).
fn without(v: &Value, skip: impl Fn(&str) -> bool) -> Value {
    match v.as_object() {
        Some(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| !skip(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        None => v.clone(),
    }
}

pub fn send_character(app: &AppHandle, id: &str) {
    if let Some(c) = with(app, |st| view(st, id, Histories::Changed)) {
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
    let dock = serde_json::from_value(c["dock"].clone()).ok();
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
                dock,
                dock_drag: None,
                kept: None,
                sent: HashMap::new(),
            },
        )
    });
    revive::watch(app, &win, id);
    // (so it can be pinned in place while docked: watched from the UI thread, which made it)
    let _ = app.run_on_main_thread(move || window::watch_moves(hwnd));
    let (app2, id2) = (app.clone(), id.to_string());
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::Destroyed => closed(&app2, &id2, hwnd),
        // (docked, its window came over the island: the island back in front)
        tauri::WindowEvent::Focused(true) if docking::is_docked(&app2, &id2) => {
            island::raise(&app2);
        }
        _ => {}
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
    let gone = with(app, |st| {
        let mine = st.robots.get(id).is_some_and(|r| r.hwnd == hwnd);
        if mine { st.robots.remove(id) } else { None }
    });
    if let Some(r) = gone {
        docking::closed(app, id, &r); // (docked: the others close up)
        revive::forget(app, id);
        walkers::close(app, id); // (put away while out for a walk: the walker goes too)
        shell::close(app, id); // (and the shell in its chat)
        stage::gone(app, id);
        island::gone(app, id);
        crate::features::share::gone(app, id); // (visiting: it leaves; sharing: that stops)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revs(pairs: &[(&str, u64)]) -> HashMap<String, u64> {
        pairs.iter().map(|(t, r)| ((*t).to_string(), *r)).collect()
    }

    fn sorted(set: HashSet<String>) -> Vec<String> {
        let mut v: Vec<String> = set.into_iter().collect();
        v.sort();
        v
    }

    #[test]
    fn only_a_conversation_that_changed_is_sent_again() {
        let sent = revs(&[("a", 0), ("b", 3)]);
        let now = revs(&[("a", 0), ("b", 5)]);
        assert_eq!(sorted(unsent(&sent, &now, false)), ["b"]);
    }

    #[test]
    fn a_tab_the_page_never_had_is_sent() {
        let sent = revs(&[("a", 0)]);
        let now = revs(&[("a", 0), ("new", 0)]);
        assert_eq!(sorted(unsent(&sent, &now, false)), ["new"]);
    }

    #[test]
    fn a_page_loading_afresh_gets_them_all() {
        let sent = revs(&[("a", 0), ("b", 1)]);
        let now = revs(&[("a", 0), ("b", 1)]);
        assert_eq!(sorted(unsent(&sent, &now, true)), ["a", "b"]);
    }
}
