//! The group chat's and the meeting room's commands (only their own pages may ask).

use super::*;

// ---------------------------------------------------------------- commands (only its own pages')

#[tauri::command(async)]
pub fn groupchat_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, LABEL)?;
    Ok(act(&app, |g, _| view(&app, g)))
}

/// A button or the box in the chat window: start, chime in, wrap up, stop, copy…
#[tauri::command(async)]
pub fn groupchat_act(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    p: Option<Value>,
) -> Result<Value, String> {
    only(&window, LABEL)?;
    Ok(act_on(&app, &action, &p.unwrap_or_default()))
}

/// Who's in the meeting room and where they sit.
#[tauri::command(async)]
pub fn meeting_init(app: AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    only(&window, ROOM)?;
    Ok(act(&app, |g, _| {
        g.chat
            .as_ref()
            .filter(|c| c.room_open)
            .and_then(|c| c.room_info.clone())
            .unwrap_or(Value::Null)
    }))
}

pub(super) fn act_on(app: &AppHandle, action: &str, p: &Value) -> Value {
    match action {
        "start" => act(app, |g, env| start(g, env, p)),
        "say" => act(app, |g, env| {
            if let Some(c) = g.chat.as_mut() {
                c.user_says(env, &text(&p["text"]));
            }
            Value::Null
        }),
        "wrap" | "stop" | "more" => act(app, |g, env| {
            if let Some(c) = g.chat.as_mut() {
                match action {
                    "wrap" => c.wrap(env),
                    "stop" => c.stop(env),
                    _ => c.more(env, true),
                }
            }
            Value::Null
        }),
        "new" => act(app, |g, env| {
            end(g, env);
            env.changed = true;
            json!(true)
        }),
        "copy" => {
            let t = act(app, |g, _| {
                g.chat.as_ref().and_then(|c| {
                    Some(format!(
                        "{}\n\n{}",
                        c.topic,
                        c.summary.as_ref().filter(|s| !s.is_empty())?
                    ))
                })
            });
            json!(t.is_some_and(|t| clipboard::set_text(&t)))
        }
        "copy-all" => {
            let t = act(app, |g, _| {
                let c = g.chat.as_ref()?;
                let mut lines = vec![format!("Group chat: {}", c.topic), String::new()];
                for m in c.log.iter().filter(|m| {
                    !m["text"].as_str().unwrap_or("").is_empty() && m["who"] != "system"
                }) {
                    let who = if m["who"] == "summary" {
                        format!("Summary ({})", text(&m["name"]))
                    } else {
                        text(&m["name"])
                    };
                    lines.push(format!("{who}: {}", text(&m["text"])));
                }
                Some(lines.join("\n\n"))
            });
            json!(t.is_some_and(|t| clipboard::set_text(&t)))
        }
        "save-note" => {
            let t = act(app, |g, _| {
                g.chat.as_ref().and_then(|c| {
                    Some(format!(
                        "👥 {}\n\n{}",
                        c.topic,
                        c.summary.as_ref().filter(|s| !s.is_empty())?
                    ))
                })
            });
            let Some(t) = t else { return json!(false) };
            let note = notes::add(app, &t, "Robot group chat");
            json!(!note.is_null() && note != false)
        }
        "minimize" => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.minimize();
            }
            Value::Null
        }
        "close" => {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.close();
            }
            Value::Null
        }
        _ => Value::Null,
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(Mutex::new(Group::default()));
    // (CBOT_TEST_GROUPCHAT: it opens by itself a moment after the start, so a test can drive
    // it without the tray menu, as groupChat.js's CBOT_TEST hook let the tests do)
    if std::env::var_os("CBOT_TEST_GROUPCHAT").is_some() {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            let host = hub::nearest_robot(&app);
            open(&app, host);
        });
    }
}
