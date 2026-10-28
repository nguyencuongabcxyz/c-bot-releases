# C-Bot: Rust core (`app/src`)

These rules are strict. New code follows them; code you touch is brought in line. When a rule and existing code disagree, the rule wins (and say so in the commit).

## Where code goes

| Folder | What lives there |
| --- | --- |
| `runtime/` | The app's own life: `State` and `with()`, `setup.rs`, `commands.rs` (every command registered), `hub.rs` (what features share), `error.rs`, `logging.rs`, `paths.rs`, `util.rs`, updates |
| `store/` | `c-bot.json` (`Store`), `saved.rs` (the other JSON files), `fields.rs` (named reads) |
| `agents/` | Coding agents. `claude/`: the `claude -p` session, its stream (`lines.rs`), `Event`, transcripts, locating the CLI |
| `robots/` | Robot windows and what they do on the desktop (walkers, social, stage, island, maid, planes) |
| `features/` | What robots do for the user: `chat/` (tabs, side questions, `group/`), `notes/`, `vocab/` |
| `mcp/` | What Claude itself calls: `server.rs` (the `--robots-mcp` process), `link/`, `tools/` (one file per tool group), `apps/` |
| `workbench/` | Tools around the chat: quick actions, palette, snip, capture, files, shell, terminal, voice |
| `ui/` | The app's own windows and menus: `tray/`, `workshop.rs`, `views.rs` |
| `platform/` | Everything that calls the OS. `common/` (shared types and logic), `windows/` (Win32, WebView2). A future `macos/` or `linux/` offers the same modules with the same functions |

- **No Win32, WebView2 or `unsafe` outside `platform/`.** Other modules call `platform::window`, `platform::input`, and so on. Platform selection is `#[cfg(windows)] mod windows; use windows as os;` in `platform/mod.rs`. Feature code has no `#[cfg(windows)]`, except to pick a whole per-system engine in one place (`workbench/voice.rs`: Windows voice typing, or none yet).
- Use Tauri's API when it does the job. Exceptions:
  - Tauri getters (`cursor_position`, `available_monitors`, `is_visible`…) block on the main thread. Inside loops and background threads, use the `platform::window` equivalents.
  - Keep the Win32 topmost handling (`robots/topmost.rs`): tao only applies the diff from its cached state.
- Never name a module like an import it shadows (`window`, `windows` next to `platform::window`). Pick a more specific name (`big_window`, `opening`).

## Modules

- A module with parts is a folder: `name/mod.rs` plus children. Don't add a `name.rs` + `name/` pair.
- `mod.rs` opens with a `//!` doc, then in this order:
  1. `mod` lines, sorted.
  2. `pub use child::*;` (children with public items: commands, functions other modules call) or `use child::*;`.
  3. The usual imports, grouped std, external crates, then `crate::`/`super::`, separated by a blank line.
- A child starts with its own `//!` doc, then `use super::*;`. Its items are `pub(super)` unless other modules need them; then they're `pub`, re-exported by the parent. Use `pub(in crate::x)` when only a wider part of the crate needs one item, and re-export that item explicitly (no glob).
- The parent keeps the state (types, accessor) and what other modules call. Jobs of their own go into children, split by the `// ---------------------------------------------------------------- name` sections.
- `impl` blocks may be spread over sibling files (as `group/{talk,free,turns,ending,room}.rs` do for `impl Chat`). Methods there are `pub(super)`.

## Size

- **Functions:** at most ~80 lines.
  - Longer is only acceptable for flat tables: command lists, key maps, dispatch `match`es whose arms are one-line calls.
  - A `match` over kinds of messages or events dispatches to one function per kind (see `agents/claude/lines.rs`, `features/chat/events.rs`).
- **Files:** at most ~700 lines of code (tests not counted). Past that, split into child modules by section. Over it today: `features/chat/events.rs` (one function per event); split it before it grows. Also near the limit: `robots/ipc.rs`, `features/chat/page.rs`, `robots/island.rs`.

## State and locks

- The app-wide state is `runtime::State`, reached only through `with(app, |st| …)`.
- A module's own state: `app.manage(Mutex::new(T::default()))` in its `setup`, plus one accessor. That accessor is a one-liner over `runtime::part` (always there), `part_if` (`None` before setup) or `part_or_default` (a default before setup):
  ```rust
  fn soc<R>(app: &AppHandle, f: impl FnOnce(&mut Social) -> R) -> R {
      part_or_default(app, f)
  }
  ```
- Lock with `.locked()` (`runtime::Locked`). **Never** `.lock().unwrap()` or `.lock().unwrap_or_else(…)`.
- **Never call into a window, emit an event, or ask Claude Code while holding a lock.** Take what you need, drop the guard, then act. Where many changes happen under one lock, note the effects and run them after (the group chat's `Fx` / `Env` in `group/effects.rs`).
- Statics:
  - `LazyLock` for regexes and caches built on first use (`LazyLock<Mutex<HashMap<…>>>`, never `Mutex<Option<…>>` + `get_or_insert_with`).
  - `OnceLock` only for something `set` once at start (`runtime::paths`).
  - A regex lives in a `fn name_re() -> &'static Regex` holding a `static RE: LazyLock<Regex>`, or in a `static` inside the one function that uses it.

## Errors

- Commands and fallible functions return `Result<T, runtime::Error>`. Never `Result<T, String>`; the exception is `vocab/lookup.rs`, whose `String` reasons are compared in tests.
- Use `?` directly on `tauri::Error`, `std::io::Error` and `serde_json::Error`. No `.map_err(|e| e.to_string())`.
- Errors the user reads are plain sentences: `Err("That conversation has closed.".into())`, `Err(format!(…).into())`. `Error` serializes to its message, so the page shows it as it is.
- Return `{ "ok": false, "error": … }` only where the page already expects that shape. Don't invent new ones.
- `unwrap()` / `expect()` only where it can't fail: a constant regex, JSON you just built. Never on user data, files or another process's output.

## Logging

- Use `log::info!`, `log::warn!`, `log::error!`. **Never `eprintln!`/`println!`**: a Windows GUI app has no console. The exceptions are the `--robots-mcp` CLI usage line in `mcp/server.rs`, and tests.
- No `[tag]` prefixes: the module path is the log's target.
- Levels:
  - `warn`: something didn't work but the app carries on.
  - `error`: data lost or not saved.
  - `info`: rare, notable events.
- Never log in a loop or per frame.

## Data

- `c-bot.json`'s shape belongs to the pages (TypeScript). **Don't** replace it with typed structs.
  - Read robots, tabs and threads through `store::Fields`: `c.id()`, `c.name()`, `c.folder()`, `c.model()`, `c.effort()`, `c.personality()`, `c.visible()`, `tab.session_id()`. Add a method there for a field read in several places; don't repeat `c["x"].as_str().unwrap_or("")`.
  - Write through the store's methods with `runtime::util::patch(vec![("key", json!(v))])`.
- Inside Rust, anything that is one of a fixed set is an `enum`, not a string compared with `==`. When it crosses to a page or a file:
  - `#[derive(Serialize, Deserialize)]` with `#[serde(rename_all = "…")]`, so the strings stay exactly what they were.
  - A test pins the JSON.

  Existing examples: `chat::AskKind`, `social::{Mode, Phase, Treat}`, `group::Style`, `notes::book::Reminder`, `claude::Event`.
- Values owned by Claude Code stay strings when it can send ones we don't know (permission modes, tool names).

## Talking to the pages

- **Chat → robot page:** only `features/chat/page_event.rs` `PageEvent`. It mirrors `ChatEvent` in `gui/types/model.ts`, with `#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]`. A new message means changing both sides in the same commit, plus the test in `page_event.rs`.
- **Claude Code → us:** its stream-json lines are read into `agents/claude/protocol.rs` types (`Line`, `Kind`, `Block`, `StreamEvent`, `System`…), never with `msg["…"]` by hand. Reading stays forgiving, since the protocol changes between versions: missing or odd fields read as empty (the `text` / `flag` / `lenient` deserializers), unknown kinds as `Other`, and what goes on to the page as it is (a tool's input or result) stays `Value`. A new field or kind is added there, with a test.
- **Session → handlers:** `agents::claude::Event`. What each carries is a struct or enum in `agents/claude/reports.rs` (`Done`, `Fail`, `Tool`, `Diff`, `AgentEvent`, `TaskChange`…), never a `json!` object. They have the TypeScript names and fields (camelCase), so `PageEvent` embeds them as they are; a new field goes in `reports.rs`, `gui/types/model.ts` and their tests together. Only what passes straight through stays `Value` (a tool's input and result, media, the questions Claude asked). Handlers `match` on it. The chat's `match` lists every variant (no `_ =>`), so a new variant has to be handled.
- **Commands:**
  - `#[tauri::command(async)]` when the command opens a window, waits, or does I/O. Plain `#[tauri::command]` only for instant ones.
  - Several arguments become one `#[derive(Deserialize)] #[serde(rename_all = "camelCase")]` struct.
  - Optional page values are `Option<T>` (the page may send `null`).
  - The first line checks who's asking: `robots::sender(&window)?` or `only(&window, LABEL)?`.
- **A new command touches three places:** the module that answers it, `runtime/commands.rs`, and a typed wrapper in `gui/ipc/commands.ts`.

## Threads and windows

- Build windows off the main thread (`thread::spawn`): menus and some events run on it, and building a window there waits on itself.
- Timers use the existing helpers: `walkers::after`, social's `later`. A timer that belongs to a scene checks that the scene is still current (an epoch or generation) before acting.

## Style

- Match the surrounding code: its names, its idioms, its comment density.
- `//!` says what a module is for, in plain words. `///` on what other modules call and on anything whose reason isn't obvious. Comments explain *why*; parenthetical asides `(like this)` are the house style.
- No dead code, no commented-out code, no `#[allow(...)]`. Fix the warning instead.
- No new dependency without a reason in the commit. **No pre-release crates** (`-rc`, `-beta`), and don't propose `tauri-specta`.

## Tests

- Unit tests go in `#[cfg(test)] mod tests` at the bottom of the file they test. Pure logic gets a test when it's added or changed.
- Tests that need the real Claude Code go in `live_tests` with `#[ignore]` (`cargo test -- --ignored`).
- A refactor that moves logic must give the same output. When there's no test, write one first and run it on the old code and on the new.

Before committing, run the checks in the root `AGENTS.md`.
