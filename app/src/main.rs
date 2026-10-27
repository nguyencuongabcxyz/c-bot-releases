// C-Bot's main process. The pages (gui/, built into dist/) call its Tauri commands (each
// module has its own; runtime/commands.rs lists them all, and gui/ipc/commands.ts has a typed
// function for each) and hear its events. The modules share the runtime's State (with()) and
// each other (runtime/hub.rs).
//
//   runtime/    the app's own life: state, starting up, commands, URL schemes, updates
//   store/      the robots and settings (c-bot.json), and the other JSON files kept
//   agents/     the coding agents that do the work: Claude Code (claude/); personalities
//   robots/     the robot windows and what they do on the desktop
//   mcp/        what Claude itself calls: the MCP server, its tools, MCP Apps
//   workbench/  what you use in and around the chat
//   features/   what the robots do for you: chat (a tab each, the group chat), words, notes
//   ui/         the app's own windows and menus: tray, Robot Workshop
//   platform/   what needs the operating system: windows/, and common/ for what's shared
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod features;
mod mcp;
mod platform;
mod robots;
mod runtime;
mod store;
mod ui;
mod workbench;

fn main() {
    // started by a robot's Claude Code as its "other robots" tools (mcp/server.rs): serve
    // them and go, before the builder (the single-instance plugin would hand it to the app)
    if let Some(code) = mcp::server::run_if_asked() {
        std::process::exit(code);
    }
    let mut builder = tauri::Builder::default();
    // a second launch opens the Workshop of the running C-Bot (main.js second-instance); a
    // test copy on data of its own (CBOT_DATA_DIR) runs beside the installed one instead
    if std::env::var_os("CBOT_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            ui::workshop::open(app, None)
        }));
    }
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(runtime::commands::handler());
    runtime::protocols::register(builder)
        .on_menu_event(ui::tray::on_menu)
        .setup(runtime::setup::setup)
        .build(tauri::generate_context!())
        .expect("error while starting C-Bot")
        .run(runtime::setup::on_event);
}
