# C-Bot

## README

- When adding a major feature, describe it in `README.md` too, under Features, in the same short, user-facing style, with a screenshot in `docs/screenshots/` when it's something you can see. If it adds a module, list it under "How it fits together".

## UI text

- Tooltips (`title`) are short, plain labels naming the control, like "Remote control" or "Past chats". No sentences explaining the feature, no state, no slash commands in them.

## Code

- Rust core (`app/`): the rules are in `app/AGENTS.md`. Read them before writing or changing any Rust.
- Pages (`gui/`): TypeScript, `gui/types/model.ts` and `gui/ipc/commands.ts` are the contract with the Rust side.

## Before every commit (all must pass)

```
cd app
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
cd .. && bun run typecheck      # when gui/ changed
```

- **Release builds:** use `bun tauri build`. Building directly with cargo needs `cargo build --release --features tauri/custom-protocol`; without it, pages load from the dev server and come up blank.
- **Trying the app:** run a test copy with `CBOT_DATA_DIR=<folder>` (its own data, no single-instance, no Start-with-Windows).
  - Drive it through CDP: set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`.
  - Never move the user's mouse or keyboard, or touch their clipboard.
  - Never stop the user's own C-Bot (`%LOCALAPPDATA%\C-Bot\c-bot.exe`). Stop only processes whose path is the test copy's.
