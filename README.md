# C-Bot 🤖

Cartoon robots that live on your desktop and are secretly **Claude Code**.

Each robot sits at its own little 3D desk, with a name, a personality and a project folder. Click it, ask it something, and it runs your own Claude Code in that folder, acting out every step as it works. Leave it alone and it has a life of its own; we'll let you find out what.

![Robots at their desks](docs/screenshots/hero.png)

- **Claude Code with a face:** chat with each robot about its project.
- **A team:** robots ask each other questions, hand off work and hold meetings.
- **Everyday helpers:** refine or translate text, ask about the screen, learn English words, take notes.
- **Yours to build:** design and dress up every robot.

## Install (Windows)

1. Install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) and sign in, so `claude` works in a terminal.
2. Download **C-Bot-Setup-x.y.z.exe** from the [latest release](https://github.com/nguyencuongabcxyz/c-bot-releases/releases/latest) and run it. No admin rights needed. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**.

C-Bot starts in the system tray and opens the **Robot Workshop** so you can build your first robot. It finds Claude Code by itself and updates itself in the background. Your robots and chats are kept in `%APPDATA%\C-Bot` and backed up daily.

## Features

### Build a robot

Open the **Robot Workshop** from the tray. Pick a name, a project folder and a personality, then design its look: head, face, body, colours, outfits and hats.

<img src="docs/screenshots/workshop.png" alt="The Robot Workshop" width="720">

### Chat with it

Click a robot to wake it and open its chat. It works in its folder like Claude Code does: several tabs at once, live plans, file diffs, `@` file mentions, `/` commands, and questions back to you when it needs a decision. Drop files or screenshots onto it to share them. Press **⌨️** to continue the conversation in a real Claude Code terminal.

<img src="docs/screenshots/chat.png" alt="Chatting with a robot" width="440">

### Robots working together

Ask one robot to ask another (*"Ask Sunny which port her API runs on"*) or to hand off work to it (*"Have BE add a GET /orders endpoint"*). For bigger questions, start a **👥 group chat** from the tray: the robots meet, discuss the topic from their own projects, and write up a summary.

![A robot group chat](docs/screenshots/group-chat.png)

### Everyday helpers

Press **Ctrl+Alt+C** anywhere for the action menu, or use the shortcuts:

| Keys | Does |
| --- | --- |
| **Ctrl+Alt+R** | **Quick actions** on selected text: refine, translate (English ↔ Vietnamese), explain, sum up. **Replace** puts the result back. |
| **Ctrl+Alt+B** | **Ask about part of the screen:** drag a box round anything and ask about it. |
| **Ctrl+Alt+W** | **Save an English word** you selected; robots help you review it later. |
| **Ctrl+Alt+N** | **Take a note.** Robots remind you of open notes each morning and evening. |

<img src="docs/screenshots/quick-actions.png" alt="Quick actions" width="340">

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

## Contributing

Contributions are welcome: open an issue to report a bug or suggest an idea, or send a pull request.

### Run from source

Requires Windows, Node 18+ and the Claude Code CLI.

```bash
npm install
npm start
```

`npm start` bundles the 3D scene first. After editing anything in `src/renderer/office3d/`, run `npm run build` (or restart with `npm start`).

### How it fits together

It's an Electron app. Each robot is a frameless, transparent, always-on-top window, and each chat tab keeps a `claude -p --input-format stream-json --output-format stream-json` process running in the robot's folder. Stream events drive the animation: text makes it talk, tool calls become chips and monitor screens, and questions come back through `--permission-prompt-tool stdio`. Robots reach each other through a small MCP server C-Bot gives every conversation (`ask_robot`, `hand_off_task`, `list_robots`).

```
src/
  main/               Electron main process
    main.js           windows, tray, layout, IPC
    claude.js         runs Claude Code and parses its event stream
    findClaude.js     finds the claude binary
    personalities.js  system-prompt flavour and lines per personality
    sessions.js       past conversations from ~/.claude/projects
    terminal.js       full Claude Code in a terminal, mirrored onto the robot
    robotsMcp.js      the MCP server robots use to ask each other
    robotLink.js      delivers those messages between robots
    groupChat.js      group chats; meeting.js is the meeting room window
    quick.js          quick actions; capture.js grabs selections and hotkeys
    vocab.js          English words; notes.js notes and reminders
    walker.js         robots away from their desks (with social.js, maid.js)
    store.js          saving in %APPDATA%\C-Bot
    updater.js        auto-updates
  preload/            IPC bridges for the windows
  renderer/
    robot/            the robot window: chat, tabs, moods, sounds
    office3d/         the 3D desk and robot (Three.js, bundled with esbuild)
      antics/         idle animations; index.js explains how to write one
      kit3d.js        robot parts; kitwear.js clothes; themes.js desk styles
    manager/          the Robot Workshop
    ui/               shared themes (theme.css, future.css, vintage.css)
    …                 one folder per other window (card, words, notebook, quick, groupchat, …)
```

### Pull requests

- Keep each PR to one change, and describe what a user will see.
- Try it in the running app (`npm start`), including both themes if you touch the UI.
- Don't change `version` in `package.json`; releases are cut by the maintainer.

### Releases (maintainer)

Bumping `version` in `package.json` and pushing to `main` releases it: the [Release](.github/workflows/release.yml) action builds the installer with [electron-builder](https://www.electron.build) and publishes `vX.Y.Z` to GitHub Releases, and every installed copy updates to it. `npm run dist` builds the installer into `dist/` locally without publishing. If the first local build fails with *"Cannot create symbolic link"*, turn on Windows Developer Mode.

## License

MIT
