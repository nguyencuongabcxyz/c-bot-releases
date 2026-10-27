//! The group chat's windows: the chat itself and the meeting room it plays out in.

use super::*;

// ---------------------------------------------------------------- the windows

/// In the middle of the screen the host robot is on (physical px).
pub(super) fn place(app: &AppHandle, host: Option<&str>) -> Rect {
    let saved = with(app, |st| st.store.settings()["groupChatSize"].clone());
    let near = host
        .and_then(|h| hub::robot_rect(app, h))
        .map(|r| (r.x + r.w / 2, r.y + r.h / 2))
        .unwrap_or_else(window::cursor);
    let m = window::monitor_near(near.0, near.1);
    let s = m.scale;
    let w = MIN_SIZE.0.max(saved["w"].as_f64().unwrap_or(SIZE.0));
    let h = MIN_SIZE
        .1
        .max(saved["h"].as_f64().unwrap_or(SIZE.1))
        .min(m.work.h as f64 / s - 16.0);
    let (pw, ph) = ((w * s).round() as i32, (h * s).round() as i32);
    Rect {
        x: m.work.x + (m.work.w - pw) / 2,
        y: m.work.y + (m.work.h - ph) / 2,
        w: pw,
        h: ph,
    }
}

pub(super) fn build_window(app: &AppHandle) {
    // (two at once: one window)
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    act(app, |g, _| g.shown = false);
    let app2 = app.clone();
    let built = views::builder(app, LABEL, "groupchat", &[])
        .title("Robot group chat")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(true)
        .maximizable(false)
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .visible(false)
        .on_page_load(move |w, p| {
            if !matches!(p.event(), PageLoadEvent::Finished) || act(&app2, |g, _| g.shown) {
                return;
            }
            // (ready to show: placed, then shown)
            let host = act(&app2, |g, _| {
                g.chat
                    .as_ref()
                    .map(|c| c.host_id.clone())
                    .or(g.host.clone())
            });
            if let Ok(hwnd) = w.hwnd() {
                window::set_bounds(hwnd.0 as isize, place(&app2, host.as_deref()));
            }
            let _ = w.show();
            let _ = w.set_focus();
            act(&app2, |g, _| g.shown = true);
        })
        .build();
    let window = match built {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[groupchat] couldn't open: {err}");
            return;
        }
    };
    let (app3, w2) = (app.clone(), window.clone());
    window.on_window_event(move |e| match e {
        // (its size is kept for next time, as you leave it)
        tauri::WindowEvent::Resized(size) => {
            if size.width == 0 || !act(&app3, |g, _| g.shown) || w2.is_minimized().unwrap_or(false) {
                return;
            }
            let s = w2.scale_factor().unwrap_or(1.0);
            let kept = json!({ "w": (size.width as f64 / s).round(), "h": (size.height as f64 / s).round() });
            with(&app3, |st| st.store.update_settings(patch(vec![("groupChatSize", kept)])));
        }
        // closing it ends the chat (the robots' chat processes too)
        tauri::WindowEvent::Destroyed => {
            let app = app3.clone();
            thread::spawn(move || {
                act(&app, |g, env| {
                    g.shown = false;
                    end(g, env);
                });
            });
        }
        _ => {}
    });
}

/// The chat's over and gone (a new one, or the window closed).
pub(super) fn end(g: &mut Group, env: &mut Env) {
    let Some(c) = g.chat.as_mut() else { return };
    c.hush(env);
    c.adjourn(env);
    for id in c.members.clone() {
        env.tell(&id, json!({ "phase": "listen-end" }));
    }
    c.rest(env);
    g.chat = None;
}

/// The meeting room: beside the group chat window (left if there's room, else right, else above).
pub(super) fn room_bounds(near: Rect, n: usize, wa: Rect, s: f64) -> Rect {
    let (w, h) = if n > 4 {
        (640.0, 380.0)
    } else {
        (540.0, 340.0)
    };
    let (w, h, gap) = (
        (w * s).round() as i32,
        (h * s).round() as i32,
        (ROOM_GAP * s).round() as i32,
    );
    let mut x = near.x - w - gap;
    let mut y = near.y + near.h - h;
    if x < wa.x {
        x = near.right() + gap; // (no room on the left: the right)
    }
    if x + w > wa.right() {
        x = near.x + (near.w - w) / 2; // (nor there: above it)
        y = near.y - h - gap;
    }
    Rect {
        x: x.max(wa.x).min(wa.right() - w),
        y: y.max(wa.y).min(wa.bottom() - h),
        w,
        h,
    }
}

pub(super) fn open_room(app: &AppHandle, people: Value, room_gen: u64) {
    // (a room from before goes first)
    if let Some(old) = app.get_webview_window(ROOM) {
        let _ = old.destroy();
        for _ in 0..50 {
            if app.get_webview_window(ROOM).is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    let n = people.as_array().map_or(0, Vec::len);
    let near = app
        .get_webview_window(LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| window::window_rect(h.0 as isize))
        .unwrap_or_else(|| {
            let (x, y) = window::cursor();
            Rect { x, y, w: 0, h: 0 }
        });
    let m = window::monitor_near(near.x + near.w / 2, near.y + near.h / 2);
    let b = room_bounds(near, n, m.work, m.scale);
    let s = m.scale;
    let built = views::builder(app, ROOM, "meeting", &[])
        .title("Meeting room")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .inner_size(b.w as f64 / s, b.h as f64 / s)
        .build();
    match built {
        Ok(w) => {
            if let Ok(h) = w.hwnd() {
                window::set_bounds(h.0 as isize, b);
            }
            // (it ended while the room was being made)
            if ROOM_GEN.load(Ordering::Relaxed) != room_gen {
                let _ = w.destroy();
            }
        }
        Err(err) => eprintln!("[groupchat] couldn't open the meeting room: {err}"),
    }
}
