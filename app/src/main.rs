// C-Bot's main process. The pages (gui/, built into dist/) call its Tauri commands, one per
// thing a page asks (each module has its own; they're all listed in generate_handler! below,
// and gui/ipc/commands.ts has a typed function for each), and hear its events. The modules
// share the State below (with()) and each other (hub.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod chat;
mod claude;
mod clipboard;
mod files;
mod find_claude;
mod groupchat;
mod hub;
mod island;
mod maid;
mod mcp_apps;
mod notes;
mod palette;
mod personalities;
mod planes;
mod quick;
mod revive;
mod robot_ipc;
mod robotlink;
mod robots;
mod robots_mcp;
mod screens;
mod shell;
mod snip;
mod social;
mod stage;
mod store;
mod terminal;
mod topmost;
mod transcripts;
mod tray;
mod updater;
mod util;
mod views;
mod vocab;
mod walkers;
mod win;
mod workshop;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, RunEvent};

use store::Store;
use util::patch;

pub struct State {
    pub store: Store,
    pub robots: HashMap<String, robots::Robot>,
    pub chats: HashMap<String, Arc<chat::Chat>>, // "robotId|tabId" -> its live conversation
    pub model_choices: Value, // learned from Claude Code: [{ value, displayName, description, efforts }]
    pub terminals: HashMap<String, String>, // robot id -> its tab open in a terminal (terminal.rs)
    pub data_dir: PathBuf,
}

/// Do something with the app's state, under its lock. Keep it short, and never call
/// into a window from inside (see robots.rs).
pub fn with<R>(app: &AppHandle, f: impl FnOnce(&mut State) -> R) -> R {
    let state = app.state::<Mutex<State>>();
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

// The characters there used to be, as robots built from parts that look like them
// (office3d/kit3d.ts); main.js OLD_LOOKS.
pub fn kit_like(body: &str, color: &str) -> Value {
    let mut kit = match body {
        "loopy" => {
            json!({ "head": "ball", "face": "cute", "top": "ears", "body": "egg", "arms": "mitten", "finish": "glossy", "second": "#f4c7d4", "accent": "#ff8fb1" })
        }
        "cat" => {
            json!({ "head": "ball", "face": "cute", "top": "ears", "body": "egg", "arms": "mitten", "finish": "glossy", "second": "#f4d7b8", "accent": "#ff8fb1" })
        }
        "nerd" => {
            json!({ "face": "visor", "top": "spiky", "body": "slim", "specs": "round", "clothes": "tshirt", "hair": "#3a2a1e" })
        }
        "girl" => {
            json!({ "face": "cute", "top": "pigtails", "body": "slim", "clothes": "dress", "neck": "bow", "hair": "#6b3e26" })
        }
        _ => json!({}),
    };
    let hex = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if kit.get("clothes").is_some() && hex {
        kit["cloth"] = json!(color); // (their hoodie or sweater was the paint colour)
    }
    kit
}

/// Any robot that's still an old character becomes a build like it.
fn migrate_looks(st: &mut State) {
    let old: Vec<(String, Value)> = st
        .store
        .list()
        .iter()
        .filter(|c| !(c["body"] == "kit" && c.get("kit").is_some_and(|k| !k.is_null())))
        .map(|c| {
            let kit = c.get("kit").filter(|k| !k.is_null()).cloned();
            let kit = kit.unwrap_or_else(|| {
                kit_like(
                    c["body"].as_str().unwrap_or(""),
                    c["color"].as_str().unwrap_or(""),
                )
            });
            (c["id"].as_str().unwrap_or("").to_string(), kit)
        })
        .collect();
    for (id, kit) in old {
        st.store
            .update(&id, patch(vec![("body", json!("kit")), ("kit", kit)]));
        st.store.unset(&id, &["glb", "glbName", "glbTurn"]);
    }
}

/// The folders pictures in the chat may come from: the user's home, temp, pasted
/// screenshots and the robots' folders. Not, say, C:\Windows.
fn picture_roots(app: &AppHandle) -> Vec<String> {
    let mut roots = vec![
        std::env::var("USERPROFILE").unwrap_or_default(),
        std::env::temp_dir().to_string_lossy().into_owned(),
    ];
    with(app, |st| {
        roots.push(
            st.data_dir
                .join("attachments")
                .to_string_lossy()
                .into_owned(),
        );
        roots.extend(
            st.store
                .list()
                .iter()
                .filter_map(|c| c["folder"].as_str().map(str::to_string)),
        );
    });
    roots
}

/// Where the Electron app kept its data (%APPDATA%\C-Bot): its files are copied over on
/// this app's first run (store.rs, and the modules that keep files of their own).
pub fn electron_data_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("C-Bot"))
}

fn main() {
    // started by a robot's Claude Code as its "other robots" tools (robots_mcp.rs): serve
    // them and go, before the builder (the single-instance plugin would hand it to the app)
    if let Some(code) = robots_mcp::run_if_asked() {
        std::process::exit(code);
    }
    let mut builder = tauri::Builder::default();
    // a second launch opens the Workshop of the running C-Bot (main.js second-instance); a
    // test copy on data of its own (CBOT_DATA_DIR) runs beside the installed one instead
    if std::env::var_os("CBOT_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            workshop::open(app, None)
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            robot_ipc::robot_init,
            robot_ipc::robot_expand,
            robot_ipc::robot_peek,
            robot_ipc::robot_drag,
            robot_ipc::robot_resize,
            robot_ipc::robot_click_through,
            robot_ipc::robot_poke,
            robot_ipc::robot_open_folder,
            robot_ipc::robot_open_link,
            robot_ipc::robot_tab_new,
            robot_ipc::robot_tab_close,
            robot_ipc::robot_tab_reopen,
            robot_ipc::robot_tab_rename,
            robot_ipc::robot_tab_activate,
            robot_ipc::robot_reset,
            robot_ipc::robot_commands,
            robot_ipc::robot_ask,
            robot_ipc::robot_compact,
            robot_ipc::robot_cancel,
            robot_ipc::robot_unqueue,
            robot_ipc::robot_send_now,
            robot_ipc::robot_brain,
            robot_ipc::robot_set_brain,
            robot_ipc::robot_answer,
            robot_ipc::robot_rewind,
            robot_ipc::robot_pick_files,
            robot_ipc::robot_chat_height,
            robot_ipc::robot_sessions,
            robot_ipc::robot_session,
            robot_ipc::robot_resume,
            robot_ipc::robot_files,
            robot_ipc::robot_inspect_paths,
            robot_ipc::robot_save_paste,
            robot_ipc::robot_open_file,
            revive::robot_alive,
            revive::robot_revive,
            clipboard::robot_paste_clipboard,
            terminal::robot_terminal,
            shell::robot_shell_open,
            shell::robot_shell_write,
            shell::robot_shell_resize,
            shell::robot_shell_close,
            shell::robot_shell_reply,
            shell::robot_shell_kinds,
            tray::robot_menu,
            robotlink::robot_tasks,
            robotlink::robots_answer,
            social::social_report,
            walkers::robot_wander_prep,
            walkers::robot_wander,
            walkers::robot_walker,
            walkers::walker_init,
            walkers::walker_ready,
            walkers::walker_through,
            walkers::walker_drag,
            walkers::walker_click,
            snip::robot_screen_ask,
            snip::snip_init,
            snip::snip_done,
            snip::snip_cancel,
            vocab::robot_vocab_save,
            vocab::robot_vocab_open,
            vocab::robot_vocab_quiz,
            vocab::robot_vocab_quiz_me,
            vocab::robot_vocab_words,
            vocab::robot_vocab_dream,
            vocab::robot_vocab_box,
            vocab::card_init,
            vocab::card_size,
            vocab::card_act,
            vocab::words_list,
            vocab::words_settings,
            vocab::words_export,
            vocab::words_open,
            vocab::words_delete,
            vocab::words_quiz,
            notes::notes_open,
            notes::notes_add,
            notes::notes_act,
            notes::notes_remind_open,
            notes::notebook_init,
            notes::notebook_act,
            quick::quick_open_blank,
            quick::quick_init,
            quick::quick_size,
            quick::quick_run,
            quick::quick_act,
            palette::palette_init,
            palette::palette_size,
            palette::palette_pick,
            palette::palette_close,
            palette::drone::drone_arrived,
            palette::drone::drone_gone,
            mcp_apps::robot_app_view,
            mcp_apps::robot_app_page,
            mcp_apps::robot_app_call,
            mcp_apps::robot_app_window,
            mcp_apps::appview_init,
            workshop::mgr_state,
            workshop::mgr_pick_folder,
            workshop::mgr_create,
            workshop::mgr_update,
            workshop::mgr_delete,
            workshop::mgr_visible,
            workshop::mgr_reset,
            workshop::mgr_settings,
            workshop::mgr_pick_claude,
            workshop::mgr_find_claude,
            groupchat::groupchat_init,
            groupchat::groupchat_act,
            groupchat::meeting_init,
            island::island_init,
            island::island_size,
            island::island_box,
            island::island_drag,
            island::island_act,
            island::robot_island,
            stage::stage_pick,
            stage::stage_tile,
            stage::stage_split,
            stage::stage_swap,
            stage::stage_init,
            stage::stage_act,
            stage::stage_send,
            stage::stage_pick_files,
            stage::stage_add_menu,
        ])
        // local pictures in the chat (cbot-file://img/?path=…), read off the page's thread
        .register_asynchronous_uri_scheme_protocol("cbot-file", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            thread::spawn(move || {
                let allowed = picture_roots(&app);
                responder.respond(files::serve_image(request.uri(), &allowed));
            });
        })
        // MCP tool views (http://cbot-app.localhost/<page>/), each with its own CSP (mcp_apps.rs)
        .register_asynchronous_uri_scheme_protocol("cbot-app", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            thread::spawn(move || responder.respond(mcp_apps::serve_page(&app, request.uri())));
        })
        .on_menu_event(tray::on_menu)
        .setup(|app| {
            // (CBOT_DATA_DIR: somewhere else, to try things without touching your robots)
            let dir = match std::env::var_os("CBOT_DATA_DIR") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            let store = Store::open(&dir, electron_data_dir());
            if let Some(r) = &store.recovered {
                eprintln!(
                    "[store] recovered from {:?}; the damaged file was kept as {}",
                    r.from,
                    r.broken.display()
                );
            }
            let mut st = State {
                store,
                robots: HashMap::new(),
                chats: HashMap::new(),
                model_choices: json!([]),
                terminals: HashMap::new(),
                data_dir: dir,
            };
            migrate_looks(&mut st);
            let visible: Vec<String> = st
                .store
                .list()
                .iter()
                .filter(|c| c["visible"].as_bool().unwrap_or(false))
                .filter_map(|c| c["id"].as_str().map(str::to_string))
                .collect();
            let order: Vec<String> = st
                .store
                .list()
                .iter()
                .filter_map(|c| c["id"].as_str().map(str::to_string))
                .collect();
            let no_robots = order.is_empty();
            app.manage(Mutex::new(st));

            let handle = app.handle().clone();
            chat::sweep_temporary(&handle); // (temporary chats left open when it last quit)
            hub::setup(&handle);
            revive::setup(&handle); // (before the robots: it watches each as it opens)
            tray::setup(&handle)?;
            // the feature modules (each keeps its own state, binds its own hotkeys)
            capture::setup(&handle);
            clipboard::setup(&handle);
            snip::setup(&handle);
            walkers::setup(&handle);
            planes::setup(&handle);
            social::setup(&handle);
            maid::setup(&handle);
            vocab::setup(&handle);
            notes::setup(&handle);
            quick::setup(&handle);
            palette::setup(&handle);
            robotlink::setup(&handle);
            mcp_apps::setup(&handle);
            groupchat::setup(&handle);
            terminal::setup(&handle);
            shell::setup(&handle);
            updater::setup(&handle);
            workshop::setup(&handle);

            for id in &visible {
                let index = order.iter().position(|o| o == id).unwrap_or(0);
                if let Err(err) = robots::open(&handle, id, index) {
                    eprintln!("[robots] couldn't open {id}: {err}");
                }
            }
            if no_robots {
                workshop::open(&handle, Some("new"));
            }
            stage::setup(&handle);
            island::setup(&handle); // (once the robots are out: their faces, at the screen's edge)
            robots::watch_cursor(handle.clone());
            chat::close_idle(handle.clone());
            topmost::setup(&handle); // (robots that lost "always on top" get it back)
            screens::setup(&handle); // (screens changing, a sleep, an unlock)
            // changes are saved a moment after they happen (store.rs save)
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_millis(100));
                    with(&handle, |st| st.store.tick());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting C-Bot")
        .run(|app, event| match event {
            // it lives in the tray: closing every window doesn't quit it
            RunEvent::ExitRequested {
                api, code: None, ..
            } => api.prevent_exit(),
            RunEvent::Exit => {
                chat::close_all(app);
                shell::close_all(app);
                with(app, |st| st.store.flush());
            }
            _ => {}
        });
}
