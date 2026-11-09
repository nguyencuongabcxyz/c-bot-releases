# C-Bot 🤖

Cartoon robots that live on your desktop and are secretly **Claude Code**.

Each robot sits at its own little 3D desk, with a name, a personality and a project folder. Click it, ask it something, and it runs your own Claude Code in that folder, acting out every step as it works. Leave it alone and it has a life of its own; we'll let you find out what.

![Robots at their desks](docs/screenshots/hero.png)

- **Claude Code with a face:** chat with each robot about its project, plan first, ask side questions, and see every file it touches.
- **A team:** robots ask each other questions, hand off work and hold meetings.
- **Everyday helpers:** refine or translate text, ask about the screen, learn English words, take notes, run prompts on a schedule.
- **Yours to build:** design and dress up every robot.

## Install (Windows)

1. Install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) and sign in, so `claude` works in a terminal.
2. Download **C-Bot_x.y.z_x64-setup.exe** from the [latest release](https://github.com/nguyencuongabcxyz/c-bot-releases/releases/latest) and run it. It's a few MB, needs no admin rights, and runs on Windows 10 and 11 (it uses the WebView2 that comes with Windows). If Windows says *"Windows protected your PC"*, click **More info → Run anyway**.

C-Bot starts in the system tray and opens the **Robot Workshop** so you can build your first robot. It finds Claude Code by itself and updates itself in the background. Your robots and chats are kept in `%APPDATA%\com.cbot.desktop` and backed up daily.

**Coming from 0.4.0 or older?** That version can't update itself to this one: uninstall it (Windows Settings → Apps), then install the new one. Your robots, chats, words and notes are copied over from `%APPDATA%\C-Bot` the first time it starts.

## Features

### Build a robot

Open the **Robot Workshop** from the tray. Pick a name, a project folder and a personality, then design its look: head, face, body, colours, outfits and hats.

<img src="docs/screenshots/workshop.png" alt="The Robot Workshop" width="720">

Or skip the Workshop: right-click any folder in Explorer (or the empty space inside one) and pick **Open with C-Bot**. The robot that looks after that folder comes out with its chat open; if none does yet, a new one is made for it, named after the folder, ready to talk. On Windows 11 the entry is under **Show more options**.

### Chat with it

Click a robot to wake it and open its chat. Under the hood it *is* your own Claude Code, running in the robot's folder, so **anything Claude Code can do, a robot can do too**: write and fix code, run commands, search the web, and use your skills, MCP servers, hooks, subagents, `CLAUDE.md` and slash commands. The chat shows it all: several tabs at once, live plans, file diffs, `@` file mentions, `/` commands, and questions back to you when it needs a decision. Drop files or screenshots onto it to share them. Right-click the robot and pick **⌨️ Open in terminal** to continue the conversation in a real Claude Code terminal.

<img src="docs/screenshots/chat.png" alt="Chatting with a robot" width="440">

- **Plan first:** press **Shift+Tab** (or `/plan`) for plan mode. The robot looks around, changes nothing, and comes back with a plan card: go ahead in the mode you pick, or send it back with notes.
- **Side questions:** select part of an answer and *Ask about this*. A thread opens under it that knows the whole conversation, but the conversation never hears about it, like Claude Code's `/btw`. It works while the robot is still answering; *Use in main* brings a side answer back.
- **Tabs brief each other:** type `@#` and pick another tab to bring what it knows into this one. A branch of that tab writes a short brief while you type: the decisions, the files and what's still open, or just the answer if you asked something. The tab itself is never interrupted. The brief goes with your message as a chip you can open.

  <img src="docs/screenshots/tab-brief.png" alt="A message that brings in a brief from another tab" width="440">
- **Tabs mind each other:** a robot's tabs can work in its folder at the same time without tripping over each other. A tab that starts work hears which others are busy, and on which files. It can check on them (`list_tabs`) or wait for one to finish and hear what it did (`wait_for_tab`). If it tries to change a file another tab is changing right now, the edit is stopped and it's told to wait for that tab, then read the file again.
- **Tabs talk to each other:** ask a tab to split the work (*"open a tab to migrate the DB while you update the types"*) and it opens new tabs, each with its job, and carries on while they work; it gets each one's report when it needs it. Tabs can ask each other something and wait for the answer, or pass something on. A message from another tab shows in the chat marked **↳ From "Types"**: click the mark to go to that tab. Tabs opened this way are grouped: the strip folds the group into one chip with a dot for each tab, so it takes the room of one. Click the chip to see what each one is doing and go to it, unfold the group in the strip, or ungroup it.
- **Tabs your way:** hold a tab and drag it to another place in the strip. Right-click a tab to close it, the others, or all of them; **Undo** brings them all back.
- **Saved chats:** click the ☆ on a tab (or **Ctrl+S**, or `/save`) to keep its conversation for later, under a name and an emoji you choose. **🔖** in the header (**Ctrl+O**, or `/saved`) lists them: type to find one, and click it or press **Alt+1…9** to pick it up again where it left off. *Past chats* shows the saved ones first, with a ☆ on every row, and clearing the history leaves them alone.

  <img src="docs/screenshots/saved-chats.png" alt="The saved chats list, opened from the chat's header" width="440">
- **Bookmarks:** hover a question or an answer and click the 🚩 to bookmark it; a flag marks it in the chat. Once a tab has some, **🚩** in the header lists them: click one to scroll straight back to it, even one from further back than the chat shows. They're kept with the conversation.
- **Steps, folded:** what it did folds under one line (*"Read 2 files, ran 1 command · 4 steps"*) that says what it's on while it works. Open a step to see the command or file and what came back, and its thinking too.
- **Files in place:** click any file in the chat to look at it right there: highlighted code, markdown, tables, pictures to zoom, PDFs, songs and videos. **Outputs** lists everything the conversation made or changed, with `+12 −3` per file; click a changed file to see its **Changes**, every diff in turn.
- **Your way:** 🎤 to speak instead of typing (Windows voice typing), ✏️ to edit your last question (the robot really forgets the old one), 👁 temporary chats that keep nothing, and 🗑 in *Past chats* to delete old conversations: one, the ones you tick, or all of them.
- **Signed out? Sign back in:** when Claude Code's sign-in runs out, the error comes with a **🔑 Sign in to Claude** button. Your browser opens, you sign in, and the robot asks your question again.
- **Knows your code:** switch on the context optimizer from the bar under the chat and the robot reads its folder into an index of its own: TypeScript/JavaScript, C#, Java, C/C++, Go, Python (Jupyter notebooks too), Rust, Dart with Flutter, Zig, PHP, Ruby, shell scripts and PowerShell (Kotlin, Swift, and Prisma, Protocol Buffers and Terraform schemas too, for what they define), their XML/XAML, Razor views, YAML, Dockerfiles, JSON, TOML, SQL, HTML, Vue, Svelte, CSS, INI, .properties and .conf, and the docs, Word documents and Cursor's rules included. It finds code by what it does (in English or Vietnamese), knows who calls what (and where a constant is read or a function handed on), what each type holds, where it's used (as a parameter's, a field's, what a function returns) and what a change would touch, and reads fewer whole files. It can sum up a function or a type with everything around it in one go, say which tests reach what you changed and how to run just those, read a library's API from the version your project has installed (npm, Cargo, a virtualenv, Go modules, NuGet) instead of guessing it, and get the compiler's errors after a change in a few lines (cargo check, tsc, dotnet build, go vet) instead of a whole build's output. The Context optimizer window shows which code tools the robots use, how often and what each costs. The index follows your files as you save them. The first time, it downloads what it needs. Its button shows how far it's got, with a dot for each index (syntax trees, keywords, vectors, the code graph), and the 🗺 in the header shows this folder's index. **🧭 Context optimizer…** in a robot's menu (or the tray's) opens a window with everything: every folder it has read, every file with its definitions and chunks, the store and the models. From there you can delete a folder's index, every index, or everything it downloaded too.

  <img src="docs/screenshots/context-engine.png" alt="The context optimizer's menu under the chat" width="440">

Drag the chat's edges or corner to resize it; double-click to put it back.

<table>
<tr>
<td width="50%" valign="top">

**A terminal in the chat** · `` Ctrl+` ``<br>
A terminal in the robot's folder (PowerShell or Git Bash) opens in a drawer under the chat. The robot uses it too: ask it to start your dev server and it runs it there, where you can watch, then reads the output back to check it's really up.

<img src="docs/screenshots/terminal.png" alt="A robot starting a dev server in the chat's terminal">

</td>
<td width="50%" valign="top">

**📱 Remote Control** · `/remote-control`<br>
Carry the conversation on from [claude.ai/code](https://claude.ai/code) or the Claude phone app while the robot keeps working on your PC. It acts out what you send from there, and your PC stays awake while it's on.

<img src="docs/screenshots/remote-control.png" alt="Remote Control turned on in a robot's chat">

</td>
</tr>
</table>

### Share a chat with a colleague

Press **🔗** in a robot's chat to share that tab with colleagues: **🏢 Office** for those on your network, or **🌍 Internet** for anyone, anywhere, through C-Bot's small relay. **Copy invite link** gives you a link for one person; it works once, for ten minutes. When they open it, their C-Bot asks you to let them in, showing their name, PC and address. Once in, your robot walks onto their desktop, with a 🔗 badge so it's clearly a visitor, and shows the whole chat as you see it, live. When the share ends it waves goodbye and walks off.

They can't ask your robot anything themselves: what they type goes to you as a suggestion, your robot raises its hand, and you **Send** it, **Edit** it first, or **Decline** it. Whatever you send runs on your own Claude Code, in your folder, so nothing they suggest runs without you. What tools read and ran (file contents, command output) stays hidden unless you choose to share it. Either way it's encrypted end to end and pinned to your C-Bot: the relay only passes along bytes it can't read. Sharing stops when you say or after an hour. On the office network it also stops when the network changes, and it won't start on a network Windows calls Public (share over the internet instead). If someone sent you a link, you can also pick **🔗 Join a shared chat** from the tray after copying it.

Working it out together: **💬 Talk** opens a line for the people in the chat (Claude never sees it). On the visiting robot, select a piece of the chat and **📍 Comment** on exactly that; the host gets it as a card, with **Add to my message**. When the host's robot asks a question or brings a plan, guests see it too and **recommend** what to do, with a reason; the host still decides, and everyone sees what was decided. Only the host is marked 👑 in Talk (a guest who takes the host's name is shown as a guest), a comment that quotes something not in the chat is flagged, and a comment you add to your message goes in as a quote, so you and Claude can tell it isn't your own words. Good for pair programming, digging into a bug together, or an old hand watching over someone new to it.

<img src="docs/screenshots/shared-chat-together.png" alt="Talking and commenting in a shared chat, on the host's PC and a guest's" width="720">

<img src="docs/screenshots/shared-chat.png" alt="A shared tab on your PC, and your robot visiting a colleague's" width="720">

### Robots working together

Ask one robot to ask another (*"Ask Sunny which port her API runs on"*) or to hand off work to it (*"Have BE add a GET /orders endpoint"*). For bigger questions, start a **👥 group chat** from the tray: the robots meet, discuss the topic from their own projects, and write up a summary.

![A robot group chat](docs/screenshots/group-chat.png)

To work with several robots at once, put them **▦ on stage**: Ctrl+click the robots, then *Take the stage* in the tray's *Arrange on stage*. Their chats tile the screen like windows: drag the gaps between them to resize (the neighbours give way), drag a title bar onto another to swap, or spotlight one. The bar along the bottom sends one message to all of them, and each answers from its own project.

![Three robots on stage, answering one question](docs/screenshots/stage.png)

### Docked chats

Want a chat to sit right at the screen's edge? With its chat open, press **Dock to edge** in the chat's title bar, or drag the robot into the left or right edge of the screen and let go when the chat glows. At the edge between two screens the chat holds there while it glows; push on past it to carry the robot over to the next screen. The chat docks flush against that edge, the full height of the screen, with the robot's face in its title bar. Drag its inner edge to make it wider. Dock a second robot on the same edge and they stack, one above the other; drag the gap between them to share the height. Press **Back to desk**, or drag the title bar away from the edge, to undock it.

A docked chat goes back to the robot's desk when you tuck it away, send the robot to the island or put it on stage, and docks again when the chat comes back. If the robot island is on the same edge, it tucks itself into a slim tab so it doesn't cover the chat; hover the tab to slide it out. To keep other windows off a docked chat's edge, turn on **📌 Docked chats keep windows off their edge** in the tray's Settings. Maximised windows then stop beside the chat instead of going under it.

![Two robots' chats docked on the right edge of the screen](docs/screenshots/docked.png)

### The robot island

Too many desks? Turn on **🏝️ Robot island** in the tray: every robot's face sits in a strip at the screen's edge. Drag a robot onto it (or press 🏝️ in its chat) to send it away; its desk keeps its place for when it comes back. Hover the island to bring robots out or send them away. Robots that are away keep working, and the island tells you when one finishes, hits a snag or needs you. It also passes on their word cards.

![The robot island: its panel, and news from a robot that's away](docs/screenshots/island.png)

### Routines

Have a robot do something on a schedule and show you what it found: the news on your topics every weekday at 8, your open pull requests every two hours, a plan for your day from your notes. Open **⏰ Routines** from the tray (or `/routines` in a chat), pick a robot, when it runs (set times on chosen days, every few hours, or once) and what to do. Or just ask a robot in its chat: *"Every weekday at 8, bring me the news on AI chips."*

At the set time, the robot runs the prompt in a tab of its own and shows the result beside its desk, says it in a bubble, or sends a Windows notification. **Ask about it** opens that tab so you can keep the conversation going. If your PC was asleep at the time, the routine runs when you're back that day. Run any routine right away with ⚡, or switch it off for a while.

![The Routines window, and a morning's news](docs/screenshots/routines.png)

### Everyday helpers

Your robots help outside the code too, in any app. Remember one hotkey, **Ctrl+Alt+C**: it opens a menu of everything below.

<table>
<tr>
<td width="50%" valign="top">

**✨ Polish any text** · `Ctrl+Alt+R`<br>
Select text anywhere to refine it, translate it (English ↔ Vietnamese), explain it or sum it up, then put the result straight back.

<img src="docs/screenshots/quick-actions.png" alt="Refining a sentence with Quick actions" width="300">

</td>
<td width="50%" valign="top">

**🔍 Ask about the screen** · `Ctrl+Alt+B`<br>
Drag a box round an error, a chart or a foreign paragraph, and a robot tells you what it means or what's wrong. Or just ask it in the chat (*"What's this error on my screen?"*): it takes a screenshot itself and looks.

<img src="docs/screenshots/screen-ask.png" alt="A robot explaining a git error from a screen box">

</td>
</tr>
<tr>
<td valign="top">

**📚 Learn English words** · `Ctrl+Alt+W`<br>
Select a word to get its Vietnamese meaning, phrases and examples. Your robots bring it back now and then until it sticks.

<img src="docs/screenshots/word-card.png" alt="A word card for 'meticulous'" width="300">

**🔤 Find the English** · `Ctrl+Alt+E`<br>
Know it in Vietnamese but not in English? Type it (a word, a phrase, an idiom) and pick from a few English choices, each with its tone, its meaning and an example. ☆ saves the one you want to your words.

<img src="docs/screenshots/find-english.png" alt="Find the English: the English choices for 'tỉ mỉ'" width="300">

</td>
<td valign="top">

**📒 Notes and reminders** · `Ctrl+Alt+N`<br>
Jot something down from anywhere. Notes pin to each desk's corkboard, and a robot reminds you each morning and evening.

<img src="docs/screenshots/notes.png" alt="The notebook beside a robot's corkboard">

</td>
</tr>
</table>

Change the shortcuts in the Workshop under **Settings → Shortcuts**.

### Settings

The tray's **⚙️ Settings** menu sets the theme (🛰️ Future tech or 📜 Vintage notebook, light or dark), sounds, and start with Windows.

### Permissions

Each robot has a permission mode, set in the Workshop under **Mind**:

| Mode | Can |
| --- | --- |
| **Look, don't touch** | read and search only |
| **Helpful hands** | edit files in its folder |
| **Unleashed** | run anything; only for folders you trust it with |
| **Planner** | propose plans, change nothing |

Each chat tab can also switch on its own with **Shift+Tab** or the mode picker: read-only, auto-accept edits, plan mode, and full access (only where the robot is unleashed).

## Contributing

Contributions are welcome: open an issue to report a bug or suggest an idea, or send a pull request.

### Run from source

Requires Windows, [Bun](https://bun.sh), [Rust](https://rustup.rs) (stable) and the Claude Code CLI.

```bash
bun install
bun start
```

`bun start` is `tauri dev`: Vite serves the pages (they reload as you edit them) and the Rust side is built and run. `bun run typecheck` checks the pages' TypeScript; `cargo test` in `app/` runs the Rust tests.

### How it fits together

It's a [Tauri 2](https://tauri.app) app: the main process is Rust, and every window is a TypeScript page in WebView2. Each robot is a frameless, transparent, always-on-top window, and each chat tab keeps a `claude -p --input-format stream-json --output-format stream-json` process running in the robot's folder. Stream events drive the animation: text makes it talk, tool calls become chips and monitor screens, and questions come back through `--permission-prompt-tool stdio`. Robots reach each other through a small MCP server C-Bot gives every conversation (`ask_robot`, `hand_off_task`, `list_robots`), run by C-Bot's own executable.

```text
app/                  the main process (Rust; tauri.conf.json, icons, Cargo.toml)
  src/
    main.rs           starts the app (the plugins, then runtime/)
    runtime/          the app's own life: the state (with()), setup and shutdown, every command
                      the pages can call (commands.rs), the cbot-file / cbot-app schemes,
                      hub.rs the hotkeys, updater.rs auto-updates
    store/            saving in %APPDATA%\com.cbot.desktop (c-bot.json; histories.rs each chat's
                      conversation in histories/, saved only when it changed; saved.rs the rest)
    agents/           the coding agents that do the work, and the robots' personalities;
      claude/         Claude Code: session.rs runs it, stream.rs reads its stream, steps.rs
                      describes its steps; locate.rs finds it; transcripts.rs past conversations
    robots/           the robot windows (mod.rs: layout, drag, resize, click-through); ipc/
                      a robot window's commands about itself (tabs.rs its tabs); stage/ several chats tiled
                      over a screen; docking/ chats docked at the screen's edge (column.rs the
                      stack's geometry); island.rs the island at the screen's edge; walkers/,
                      social/, maid.rs robots away from their desks; topmost.rs, screens.rs
    mcp/              what Claude itself calls: server.rs C-Bot's MCP server; tools/ its tools
                      (robots, words, notes, routines, terminal, screen, tabs: schema and handler
                      together); link.rs the app's end of it and robots asking each other;
                      guard.rs the hook that stops two tabs changing one file; apps.rs MCP Apps
    context/          the context optimizer: a robot's folder read (tree-sitter) into its own
                      PostgreSQL, with a keyword index, vectors and the code graph derived from
                      it, for the code tools (mcp/tools/code.rs); library/ reads the packages it
                      uses as installed (npm, Cargo, virtualenvs, Go modules, NuGet)
    workbench/        what you use in the chat: files.rs, shell.rs, terminal.rs (full Claude
                      Code in a terminal), voice.rs, paste.rs; capture.rs grabs selections;
                      snip, quick, palette
    features/         what the robots do for you: chat/ a robot's tabs (page.rs what its page
                      asks; side.rs side questions; brief.rs briefs from one tab for another;
                      tabs.rs what each tab is up to, for the others; peers.rs tabs asking,
                      telling and opening each other; saved.rs saved chats;
                      bookmarks.rs bookmarked messages;
                      temporary.rs; awake.rs the PC kept awake for Remote Control) and
                      group/ the group chat and meeting room; vocab/ English words (find.rs
                      Find the English); notes/
                      notes and reminders; routines/ prompts a robot runs on a schedule
                      (schedule.rs when, runs.rs a run and its result, panel.rs the window);
                      share/ a tab shared with colleagues (host/ the sharing end, on the
                      office network or through the relay; guest.rs the visiting robot;
                      wire.rs what they say; tls.rs the encryption; relay.rs and pipe.rs
                      the way through the relay)
    ui/               the app's own windows and menus: views.rs, place.rs, tray.rs, workshop.rs,
                      folder_menu.rs ("Open with C-Bot" in Explorer's right-click menu)
    platform/         what needs the operating system, kept by system: windows/ (window,
                      appbar, input, clipboard, network, screenshot, presence, power, process,
                      webview), and
                      common/ for what every system shares (types, input logic, images)
relay/                the relay for shared chats over the internet: a Cloudflare Worker that
                      passes encrypted bytes between a host and its guests (bun run deploy)
gui/                  the pages (TypeScript, built by Vite into dist/)
  ipc/                main, through @tauri-apps/api: a typed function per command, events
  views/
    robot/            the robot window: its life (moods, antics, sounds), calling the parts below
    workshop/         the Robot Workshop and Settings
    …                 one folder per other window (island, stage, notebook, routines, words, quick, …)
  features/           what the robot window is built from (views/ shows, features/ handles)
    chat/             a robot's chat: the log, replies, the box you type in, plans, side
                      questions, past chats, saved/ saved chats, bookmarks/ bookmarked
                      messages, share/ a shared chat
    notes/  vocab/    what the robot does with your notes, and with English words
    routines/         what the robot does when one of your routines runs
    robots/           robots noticing and asking each other, the robot as a stage tile, and
                      dock/ its chat docked at the screen's edge
    workbench/        quick actions, snip, the shell drawer, the file viewer
    mcp/              MCP Apps: a tool's own page, shown in the chat
  office3d/           the 3D desk and robot (Three.js)
    antics/           idle animations; index.ts explains how to write one
    kit3d.ts          robot parts; kitwear.ts clothes; themes.ts desk styles
  theme/  icons/      the themes (theme.css, future.css, vintage.css); the line icons
  lib/                small helpers every page shares
  types/              the model, and every event main sends
shared/
  personalities.json  system-prompt flavour and lines per personality
```

A page calls main as `ipc.robotAsk(tabId, prompt, …)` (`import * as ipc from '@/ipc'`): that's `invoke('robot_ask', { tabId, prompt, … })`, which Tauri hands to `#[tauri::command] fn robot_ask(…, tab_id: String, prompt: String, …)` in `app/src/robot_ipc.rs`. A new command is a function in its module, its name in `generate_handler!` in `main.rs`, and its typed function in `gui/ipc/commands.ts`.

### Pull requests

- Keep each PR to one change, and describe what a user will see.
- Try it in the running app (`bun start`), including both themes if you touch the UI.
- Don't change `version` in `package.json`; releases are cut by the maintainer.

### Releases (maintainer)

Bumping `version` in `package.json` and pushing to `main` releases it: the [Release](.github/workflows/release.yml) action builds the installer with [tauri-action](https://github.com/tauri-apps/tauri-action), signs the update, and publishes `vX.Y.Z` with its `latest.json` to GitHub Releases, and every installed copy updates to it. It needs the `TAURI_SIGNING_PRIVATE_KEY` secret: the updater's private key, whose public half is in `app/tauri.conf.json`. Keep it safe; installed copies only take updates signed with it.

`bun run dist` builds the installer into `app/target/release/bundle/nsis/` locally without publishing (set `TAURI_SIGNING_PRIVATE_KEY` too, or the build stops at signing the update).

## License

MIT
