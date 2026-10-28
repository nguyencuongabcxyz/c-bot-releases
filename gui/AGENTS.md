# C-Bot: the pages (`gui/`)

Plain TypeScript and the DOM: no UI framework, no state library. Readability comes from structure: small modules, setup functions, one function per kind of event.

These rules are strict. New code follows them; code you touch is brought in line. When a rule and existing code disagree, the rule wins (and say so in the commit).

## Where code goes

`views/` is what's shown: one folder per window. `features/` is what's handled: the parts the robot window is built from, grouped by what they're about, with the same names as the Rust side (`app/src/features/chat`, `features/notes`, `robots/`, `workbench/`…), not by kind of file.

| Folder | What lives there |
| --- | --- |
| `main.ts` | Picks the window from `?view=` and loads only that one |
| `views/<name>/` | One window each: `robot/` (the robot at its desk: `robot.ts` makes the shared state and calls each part; `life/` its moods, antics and pokes; `layout.ts`, `sound.ts`, `constants.ts`), `workshop/` (`?view=manager`: the robot builder, `look.ts`, `kit.ts`, and `settings.ts`), `big-window/` (`?view=appview`: an MCP App fullscreen), `island`, `walker`, `plane`, `stage`, `groupchat`, `meeting`, `notebook`, `words`, `card`, `quick`, `palette`, `drone`, `snip` |
| `features/chat/` | A robot's chat: `log.ts`, `events.ts` (one function per `ChatEvent` kind), `reply/` (asking and the answer streaming in: steps, commentary, code blocks, local files), `composer/` (the box you type in: format, @ mentions, /commands, attachments), `agents.ts` (sub-agents), `plan/`, `side/` (side questions), `past/` (past conversations), `brief.ts`, `tabs.ts`, `todo.ts`, `outputs.ts`… |
| `features/notes/`, `features/vocab/` | What the robot does with your notes, and with English words (`robot.ts`) |
| `features/robots/` | Robots and each other: `reactions.ts` (noticing each other), `link/` (one asking another, work handed off), `stage/tile.ts` (a robot window as a tile of the stage) |
| `features/workbench/` | Tools round the robot: `quick/robot.ts` and `snip/robot.ts` (what it does for quick actions and a box round the screen), `shell/` (the shell drawer), `files/` (the file viewer), `terminal.ts` |
| `features/mcp/` | MCP Apps: `app-host.ts` (hosting a tool's own page), `apps.ts` (in the chat) |
| `office3d/` | The three.js office. `index.ts` mounts it and runs the frame; each frame's parts are modules of their own (`desk-frame.ts`, `play.ts`, `bonk.ts`, `ambient.ts`, `particles.ts`), as are `camera.ts` and `picking.ts` (what's under the mouse). `screens/` (the monitor's scenes, by group), `antics/` (one module per group; `common.ts` what they all share, `<group>-common.ts` what one group's share), `core/` (`math.ts`, `mesh.ts`, `constants.ts`), `protocol.ts` (what the pages tell it). "Kit" means the robot builder's parts (`kit3d.ts`, `kitwear.ts`) |
| `theme/` | The themes: `theme.ts` (picks one before the page draws), `theme.css` (the tokens), `base.css`, `dark.css`, `vintage.css`, `future.css` |
| `icons/` | `icons.ts` (the line icons, `Icon.fill`), `head.ts` (a flat robot head) |
| `lib/` | Small helpers every page shares: `dom.ts` (`$`, `el`, `iconButton`), `drag.ts` (`onDrag`), `page.ts` (`showView`), `text.ts`, `time.ts`, `markdown.ts`, `speech.ts`, `random.ts`, `math.ts`, `lazy.ts`. Pure, or nearly, and tested |
| `ipc/` | Talking to main: `commands.ts` (one typed wrapper per Rust command), `events.ts` (`on`), `host.ts` (the mouse and dropped files) |
| `types/` | The contract with the Rust side: `model.ts`, `ipc.ts` (events), `pages.ts` (each window's init data) |

- A window is `views/<name>/`: `<name>.ts`, `<name>.html` (its markup, `?raw`), `<name>.css`, and the parts only it uses.
- A file is named for what it does in its domain, not for its kind (`agents.ts`, not `helpers.ts`). Two files in one folder never differ by a letter (`plan.ts`/`plans.ts`): give them a folder and say how they differ.
- What the robot does for a feature lives with the feature, as `robot.ts` (`features/notes/robot.ts`, `features/vocab/robot.ts`, `features/workbench/quick/robot.ts`).
- A view shows; a feature handles. Logic that a window's markup doesn't need to sit next to goes in `features/`, not `views/`.
- A helper used by two domains goes in `lib/`; one used by two parts of the office goes in `office3d/core/` (or `antics/common.ts`). Never copy it into a second file.
- A view never imports another view. What two views share moves to `lib/`, `theme/`, `icons/`, `office3d/` or `features/`.

## Modules

- A file opens with a comment saying what it is for, in plain words.
- Export only what other modules use. `/** */` on exports and on anything whose reason isn't obvious.
- A part of a view that needs the view's state is a factory taking what it needs as a context object (getters for state that changes), returning its API: see `ShellDrawer`, `SideQuestions`, `HistoryView`. It never imports the view.
- The robot window (`views/robot/`) is built that way throughout. `robot.ts` makes the shared state, then calls each part in turn: `create<Part>(hub)` from its own `life/`, or from `features/` (`chat/`, `notes/`, `vocab/`, `workbench/`, `robots/`, `mcp/`). Each part declares what it uses as `<Part>Needs`; a name another part gives is typed by that part's API (`ChatLogApi['addBot']`). `hub` is `lazy()` (`lib/lazy.ts`): every name is read when it's used, as the closure it was split from did.
- A part's new dependency: a member in its `Needs`, and the name in robot.ts's `hub`. Fixed tables and pure helpers aren't dependencies: import them (`views/robot/constants.ts`, `lib/`).
- No import cycles at run time. `import type` between parts is fine: it's gone once compiled.
- No state hung on functions or elements (`fn.timer = …`): a `let` next to the function, or a field of the part's state.

## Size

- **Functions:** at most ~80 lines. Longer only for flat tables (data, key maps, a `switch` whose cases are one-line calls).
- A `switch` over kinds of events dispatches to one function per kind.
- **Files:** at most ~700 lines of code. Past that, split by section into a subfolder. Static data (presets, word lists) goes in its own file.

## DOM

- Find elements with `$` from `lib/dom.ts`, everywhere: it throws when the element isn't there, so no `!` after it.
- Dragging with the mouse: `onDrag()` from `lib/drag.ts` (the pointer held, a threshold for a click, every listener gone after). Only a press let go without moving (`letGo`, not `moved`) is a click.
- Build elements with `el()` and set text with `textContent`. `innerHTML` only for our own markup (icons, fixed templates) or sanitized markdown. Anything else in a template goes through `esc()`.
- Event listeners added for a while (a menu, a drag) are removed again; use an `AbortController` for several at once.

## CSS

- A window imports `@/theme/theme.css` (the tokens, both themes), then `@/theme/base.css` (box sizing, `[hidden]`, `pop-in`), then its own stylesheet. The island and the stage's bar add `@/theme/dark.css`.
- Colours, fonts, radii and shadows come from the tokens in `theme.css`; no raw colours in a window, except the always-dark windows and the cartoon bits drawn the same in every theme.
- `theme/vintage.css` and `theme/future.css` hold only what reaches several windows. A window's own theme touches sit at the top of its stylesheet, selectors as `[data-theme="vintage"] …`.
- `hidden` hides (base.css). Don't add `x[hidden] { display: none }` patches.
- Two of Biome's CSS rules are off (`biome.json`): `noDescendingSpecificity`, because each stylesheet is ordered by component (a part's rules together, its states after it), and `noImportantStyles`, because `!important` is how `hidden` and a theme's touches beat a view's own rules. Use `!important` only for those.
- Check a CSS change in both themes and both modes.

## Talking to main

- Commands only through `ipc/commands.ts`, events only through `ipc.on` (typed by `types/ipc.ts`). No raw `invoke` or `listen` outside `ipc/`.
- A page tells the 3D office what to show only through `office3d/protocol.ts`: `officeData(el)` for the data-* attributes (JSON ones with `writeJson`, read with `readJson`), `Flash`/`Reaction` for the one-shot classes, `CSS_VARS` for the variables. A new thing to show is a new field there first, read and written on both sides in the same change.
- A new command touches three places: the Rust module, `app/src/runtime/commands.rs`, and its wrapper in `ipc/commands.ts`.
- A window's `*_act` command (`cardAct`, `notebookAct`, `quickAct`, `groupchatAct`) lists its actions in `types/pages.ts` (`CardActs`…): what each sends and what main answers. A new action is an entry there, next to its arm in the Rust `match`. No casts on what an action answers.
- A new chat event changes `ChatEvent` in `types/model.ts` and `PageEvent` in Rust in the same commit (see `app/AGENTS.md`).

## Types

- `strict` stays on. No `any`, no `as unknown as`, no `@ts-ignore`.
- Avoid `!`: narrow instead, or use `$`. A cast (`as`) needs a reason in a comment unless it's the event target.
- Anything that is one of a fixed set is a union of string literals, not a bare `string`.

## Style

- Prettier formats the TypeScript (`.prettierrc.json`, `bun run format`); Biome lints (`biome.json`, its formatter off). `bun run check` runs both and fails on warnings too: the code has none. Don't hand-format; don't disable a rule inline without a reason next to it.
- Match the surrounding code: its names, its idioms, its comment density. Comments explain _why_; parenthetical asides `(like this)` are the house style.
- No dead code, no commented-out code.
- No new dependency without a reason in the commit. No pre-release packages.
- UI text: tooltips are short labels (see the root `AGENTS.md`).

## Tests

- Vitest with jsdom (`bun run test`): `name.test.ts` next to `name.ts`. Pure logic gets a test when it's added or changed.
- A refactor that moves logic must give the same output. When there's no test, write one first and run it on the old code and on the new.

Before committing, run the checks in the root `AGENTS.md`.
