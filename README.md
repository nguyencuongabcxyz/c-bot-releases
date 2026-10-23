# C-Bot 🤖

Cartoon robots that live on your desktop and are secretly **Claude Code**.

Give each robot a name, a personality and a home folder, stick it anywhere on screen, click to wake it up and ask it things. Under the hood each question runs `claude -p` in the robot's folder, and the robot animates along with what Claude Code is doing.

## Install it (Windows)

1. Install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) and sign in, so `claude` works in a terminal. The robots run your own Claude Code.
2. Download **C-Bot-Setup-x.y.z.exe** from the [latest release](https://github.com/nguyencuongabcxyz/c-bot-releases/releases/latest) and run it. It installs just for you, no admin rights needed, with Start-menu and desktop shortcuts. Until the app is code-signed, Windows may say *"Windows protected your PC"*: click **More info → Run anyway**.

C-Bot then **updates itself**: it checks for a new version at start and every few hours, downloads it in the background and installs it the next time it restarts. Right-click the tray icon to see the version, check now, or **Restart to update** straight away. Updates never touch your robots or chats; they live in `%APPDATA%\C-Bot`. The free characters aren't in the installer, to keep it small: download the ones you like from [`characters/`](characters/CREDITS.md) and pick them in the Workshop's **📦 My model**.

## Run it from source

Requires Node 18+ and the Claude Code CLI as above.

```bash
npm install
npm start
```

## Release a new version

The code and the releases share this repo. Installed copies update from its GitHub Releases with electron-updater.

1. Bump `version` in `package.json` (e.g. `0.1.0` → `0.2.0`). Installed copies only update to a higher version.
2. Push to `main`.

The **Release** GitHub Action ([.github/workflows/release.yml](.github/workflows/release.yml)) sees a version that has no release yet, builds the 3D bundle, the installer and its block map (so updates download only what changed) with [electron-builder](https://www.electron.build), and publishes them as release `vX.Y.Z`. Pushes that keep the version just check and stop. It uses the workflow's own token: no secrets to set up.

`npm run dist` builds the installer into `dist/` without publishing, for a local try. `npm run release` publishes from your machine instead of the Action, with a token that can write to this repo in the `GH_TOKEN` environment variable. On Windows, if the first build fails with *"Cannot create symbolic link"*, turn on Developer Mode (or build once as administrator): electron-builder's signing tools contain two macOS symlinks.

C-Bot lives in the system tray. The first launch opens the **Robot Workshop**, where you build your first robot.

Your robots survive restarts:
- **Start with Windows** (tray menu, on by default) brings C-Bot and its robots back after a reboot. Robots you **Put away** stay hidden until you tick them in the tray menu.
- **Saving is power-cut safe:** each save goes to disk before it replaces the old file, and Windows shutting down or signing out triggers a save straight away.
- **A daily backup** of the robots goes to `<userData>/backups/` (14 days kept; the tray's **Open backups folder** opens it).
- **A damaged save file is never replaced by an empty one.** It's set aside as `c-bot.broken-….json`, and the robots come back from the newest backup, with a message saying so.
- **Closed tabs can come back:** **Undo** right after closing one, then **↺** next to ＋ or **Ctrl+Shift+T** (the last 10 per robot).

In the Workshop, **Character** picks who sits at the desk: **🦫 Loopy** (the default, the pink beaver; she always stays pink), a cute **🐱 Cat** (its fur takes the paint job, its eyes the brain's colour, and its tail swishes while it thinks), an IT **🤓 Nerd** (messy hair with a cowlick that wiggles while he thinks, taped-up glasses, a hoodie in the paint colour with a `</>` logo, headphones round his neck) or the original **🤖 Robot**. They all act out everything below, and wear the same hats.

**Size** makes a robot 🐭 Small (70%), 🙂 Normal, 🦒 Large (135%) or 🐘 Huge (170%); it grows or shrinks around its feet, so it stays where you put it, and its speech bubbles keep a readable size.

**Theme** dresses the whole workstation: **🎨 Classic** (the wooden desk), or **⛺ Sioux Connect**, styled after the Sioux Connect employee portal: a white desk with charcoal legs, the portal's tent logo and "SIOUX CONNECT" wordmark on the monitor (on its blue-grey-peach backdrop), an orange boot splash, the brand orange on every screen, a logo nameplate on the desk, a logo mug, the logo on the back of the chair, an orange status light and an ID badge with the logo on a cyan lanyard. Picking it also paints the robot Sioux orange (change the paint afterwards if you like). The themes live in `src/renderer/office3d/themes.js`, so adding one for another project is one entry there.

Or bring your own: **📦 My model** takes any `.glb` 3D model, or a `.vrm` avatar (VRoid Hub, Open Source Avatars). To get one of your exact character, upload a picture of it to an image-to-3D tool (Meshy, Tripo, Rodin…), turn on auto-rigging if it offers it, and download the result as `.glb`. C-Bot copies the file into its own data folder and:

- **with a skeleton** (bones named the usual ways: Mixamo, Meshy, Tripo, Unreal, VRM…) sits it in the chair and drives its spine, head, arms and legs, so it types, waves, cheers, sleeps and gets bonked like the others;
- **without one** stands it on the seat like a plush toy and moves it as a whole;
- uses the model's own blink / mouth-open / smile shapes for its face, if it has any.

Press **↻ Turn** (a quarter turn each time) until it faces you. Ready-made free animal characters (a tiger, cats, teddies, a fox, a squirrel, a shark, a panda…) are in [`characters/`](characters/CREDITS.md). The Workshop says what it found (skeleton, face shapes) under the picker.

## Playing with your robots

| Do this | And the robot… |
| --- | --- |
| Click a sleeping robot | the squeaky toy hammer bonks it awake (SQUEAK!): it jolts up, a bit dizzy, grumbles, and opens its speech bubble: a chat panel beside the robot, the full height of the screen, on whichever side has room |
| Drag the chat's outer edge | makes it wider or narrower (each robot remembers its width; double-click the edge to reset it) |
| Type and press Enter | watches you type, thinks (antenna spins, thought bubble shows 📖 🔍 ⚙️ ✏️ for each tool), then talks while the answer streams in |
| Send a question | the chat stays open and the answer streams in while the robot works at its desk |
| 🔽 | tucks the chat away so you can watch it work: a little status bubble above the robot (below it, if the robot sits at the top of the screen; never over the desk) says what it's doing ("📖 Reading main.js…", "💬 Writing it up…"). Click the bubble or the robot to bring the chat back. It stays tucked away until you do: when the task is done the bubble says "✅ Done! Click to read the answer", and when Claude has a question for you it says "✋ I have a question for you" |
| Hover over the robot | a little menu pops up at its feet: 🔨 bonk it (wakes it if asleep), 🔋 charge its battery (a battery over its head fills red → green while bolts crackle), 🤭 tickle it (it wriggles and giggles), ✋ high-five it, or 💃 throw a dance party (disco screen, disco lamp, a little tune). Apart from the bonk they play on a sleeping robot without waking it, and the menu stays open so you can keep playing |
| Click an awake robot | gets poked. Poke it too often and it gets grumpy or dizzy |
| Drag it | swings around and yells "wheee". Drag it around too much and it gets dizzy |
| Right-click | menu: sleep/wake, new conversation, open folder, personality, permissions |
| Esc / 💤 | goes back to sleep. It also dozes off by itself after 3 idle minutes |
| Ask, then put it to sleep | keeps working and shows a red **!** badge when the answer is ready |

### Tabs: several conversations at once

Each robot can juggle up to 8 conversations as tabs along the top of its chat bubble. Every tab is its own Claude Code conversation, and they **run in parallel**: ask something in one tab, press **＋** (or Ctrl+T), and ask something else while the first is still working.

Each tab shows its state at a glance: a spinner while it works, ✋ when Claude has a question for you there, a green dot when it finished while you were looking elsewhere, red if it hit a snag, ⌨️ while it's open in the terminal. When a background tab finishes or asks something, the robot tells you ("“Fix login” is done!"). The robot acts out the tab you're looking at, or whichever one is busy when yours is idle.

Tabs are named after their first question; double-click one to rename it. Ctrl+Tab / Ctrl+Shift+Tab switch, Ctrl+1…8 jump, Ctrl+W or × closes (it asks first if that tab is still working). Each tab remembers its half-typed message. `/new` opens a new tab, `/clear` wipes the current one, `/close` closes it. Resuming a past conversation opens it in a new tab, or jumps to the tab that already has it.

### Steering it while it works

Each tab keeps one Claude Code process open for its conversation (closed after 15 idle minutes, and picked up again on your next question), so you can:

- **Stop** with ■ or **Esc**: the answer is interrupted, but the conversation carries on.
- **Type ahead**: send another message while it's working. It waits as "📨 next up" and runs as soon as the current answer is done. **⚡ Send now** stops the current answer and does this one instead; ✕ takes it back.
- **Bonk it 🔨** (header button, the button in the "working" bubble, right-click menu, or a quick side-to-side shake while dragging the robot). A squeaky toy hammer swings in and bonks it on the head: the pink accordion head squishes, the robot's head squashes and wobbles, "SQUEAK!" and stars. If it's working, it drops the current answer and starts the same question over, told to hurry: sweat drops, frantic typing. Asleep, it jolts awake. Idle, it just yelps. There's a 3-second cooldown.

### The plan card

When Claude plans its work with its task tools, a **📋 Plan** card appears above the chat box: each task with ⬜ / a spinner / ✅, a progress bar, and the robot ticking items off ("✓ Find the bug"). It cheers when everything is done, then tucks the card away.

When Claude sends out helper agents (sub-agents), a **🤖 Helpers** card appears too: each helper with a spinner or ✅, what it's doing right now ("📖 Reading server.js"), and its steps, tokens and time. Click a helper, or its "🤖 Sending a helper bot" chip in the answer, to watch it up close: the job it was given, every step as it happens, what it says, and its report when it's back (Esc or ← returns to the chat). Helpers sent to work in the background keep going after the answer ends; when they finish, Claude's follow-up message shows up in the chat by itself. The card clears when you ask the next question.

The robot acts its helpers out too. Each helper is a little bot with a propeller that flies out of the robot's head (whee!) and circles it while the helper works, hopping whenever its helper takes a step; when the helper is done it flies home into the robot's head in a burst of stars. While any helper is out the robot supervises, chin in hand, with the helper-bots scene on its monitor, instead of dozing off, and it cheers when the last one is back. A tab whose helpers are still out after the answer gets a 🤖 dot, and the tucked-away status bubble says "🤖 2 helpers are still working…". C-Bot also keeps such a conversation's Claude Code running past the usual 15 idle minutes until its helpers are done.

### The brain bar

Under the chat:

- **🧠 model ▾** switches the tab's model mid-conversation. The robot spins, its monitor reboots and its eyes change colour (purple Opus, cyan Sonnet, green Haiku, gold Fable). Also `/model sonnet`.
- **⚡ effort ▾** sets how hard it thinks, from ☕ low to 🤯 max; at xhigh and max it wears a red headband. Also `/effort high`.
- **memory** shows how full the conversation's context is. At 80% it turns red, steam comes out of the robot's ears and it suggests compacting. Click it, or type `/compact`, and it squishes its memory on the monitor ("170k → 30k tokens"). `/context` shows the numbers.

### Slash commands

Type `@` anywhere in a message to mention a file: a list of the files and folders in the robot's folder pops up and narrows as you type (file names first, then paths, then fuzzy matches; it follows `.gitignore` in a git repo and skips `node_modules`, `dist` and the like otherwise). Arrow keys and Tab/Enter pick one, `@path/to/file` goes into your message (highlighted once sent), and picking a folder lets you carry on inside it. When you send, the robot tells Claude Code exactly which files you mentioned.

Type `/` in the chat box for a list (arrow keys to pick, Tab to complete, Enter to run):

| Command | Does |
| --- | --- |
| `/resume [search]` | open past conversations, optionally pre-filtered |
| `/history` | same list, to browse |
| `/new` | start another conversation in a new tab |
| `/model [name]`, `/effort [level]` | switch this tab's model or effort |
| `/compact`, `/context` | squish the conversation's memory, or show how full it is |
| `/clear` | wipe the current tab and start over |
| `/close` | close the current tab |
| `/folder` | open the robot's folder |
| `/sleep` | send it to bed |
| `/help` | list the tricks |

Any other `/command` is sent to Claude Code as-is, so your skills and custom commands work too. The list shows the ones Claude Code reports for that folder.

### Full Claude Code in a terminal

Want every Claude Code feature (all slash commands, permission prompts, Esc to interrupt, `/model`…)? Press ⌨️ in the bubble, type `/terminal`, or right-click → **Open in terminal**. Real `claude` opens in a terminal window, in the robot's folder, with its model and permission mode, **resuming the robot's current conversation**.

While the terminal is open the robot acts out what happens there, by following Claude Code's transcript: thinking when you send something, typing when Claude edits or runs commands, leaning in when it reads, hand up when Claude asks you a question, cheering when the turn ends. Close the terminal and the robot picks the conversation back up, so the chat bubble shows everything said there. Chat and terminal never run on the same conversation at once.

In the Workshop, set **Clicking me opens → Terminal** for robots you always want in CLI mode; clicking them then opens the terminal instead of the bubble.

### Questions mid-task

When Claude Code needs a decision (its AskUserQuestion tool), the robot swivels round, puts its hand up, its monitor flashes **YOUR TURN!**, and a question card appears in the chat bubble. Click an option, press its number, or type your own answer (in the card's "Something else" box or straight into the chat box). Multi-select questions take several picks and a **Send answer** button. Claude Code waits for you, then carries on in a new bubble below the card. If the robot is asleep it shows a **?** badge until you wake it. Stopping the robot closes any unanswered question. Answered questions are kept in the history as "✋ question → answer".

This works because each run talks stream-json both ways with Claude Code (`--input-format stream-json --permission-prompt-tool stdio`). Other permission requests are still refused automatically, as before.

### Running commentary

While it works, the robot drops short in-character remarks in a comic thought bubble next to its head ("Ahoy, a small ship with a tidy manifest!"). They're separate from the answer and are kept as 💭 chips on it. Claude Code is asked to put them on their own line as `<aside>…</aside>`, and the app pulls them out of the stream; an `<aside>` mentioned inside an answer is left alone.

### Diffs and tool views

When Claude changes a file, the answer shows a card for it, as Claude Code's terminal does: the file name, **+added −removed**, and the changed lines with line numbers (green added, red removed). Long diffs start folded; click the header to open them.

Pictures show up too. A picture or SVG Claude creates appears as a preview in its card, with the SVG source folded under it. A local picture Claude points at in its answer shows inline: a markdown image with a path like `![chart](<C:/…/chart.png>)`, or a path such as `C:\…\icon.svg` in code. Images that MCP tools return (screenshots, rendered charts) show as thumbnails. Local file links and paths are clickable and open the file in its usual app; programs and scripts are only shown in their folder, never run. Pictures are served only from your user folder, temp and the robots' folders. The robot's system prompt tells Claude its bubble can show pictures, so it stops opening them elsewhere "because the bubble is text-only".

Some MCP tools come with their own view (an *MCP App*), like the Excalidraw connector's drawings. The robot shows that view right in the answer, just as Claude Desktop does: it fetches the tool's page from the same MCP server and runs it in a sandboxed frame, feeding it the tool's input and result. Excalidraw's public server works out of the box. HTTP MCP servers from your Claude Code config work too, as long as they don't need a login. Other claude.ai connectors run behind Anthropic's proxy, so their views can't be shown here. Diffs and views are kept with the answer in the chat history.

A view's own fullscreen button (Excalidraw's **Edit ⤢**), or **⤢** on the card's header, opens it big in a window of its own. That's its fullscreen mode, where Excalidraw becomes a full editor. Press **Esc** in the view (or close the window) to leave.

### Feeding it files

Drag files, folders or screenshots onto the robot (asleep or awake), or paste them: **Ctrl+V** anywhere in the open chat, or right-click the robot → **📋 Paste screenshot / file from clipboard**, which works even while it sleeps. A snip from the Snipping Tool (Win+Shift+S) pastes straight in, saved as "Screenshot <date> <time>.png". It leans out with its mouth open, chomps them (a page flies in, crumbs fly out), and they show up as chips above the chat box, images with a little preview. They go along with your next question: their paths are added to the prompt, and folders outside the robot's own get `--add-dir` so Claude Code may read them. Press ✕ on a chip to spit it back out. Send with no text and it asks "Take a look at this."

### Past conversations

🕘 in the bubble header (or `/resume`, or right-click → Past conversations…) lists every Claude Code conversation in the robot's folder, newest first. That includes the robot's own chats and sessions you ran in a terminal in the same folder. Search them, open one to read the transcript, and press **Resume** to make it the robot's current conversation. Its next answer continues from there (`claude --resume`). Conversations still open in another Claude Code window are marked 🟢 and ask before resuming.

These come straight from Claude Code's own transcripts in `~/.claude/projects/`, so nothing extra is stored.

### The 3D workstation

Each robot sits at its own desk in 3D: a swivel chair, a desk with a monitor, keyboard, mug and lamp, and nothing else, so it stays small on your desktop. It wears an engineer's ID badge with its name on it.

The desk is an electric **standing desk**: telescoping legs, with a little control panel at its right-hand end that has a height display and ▲ / ▼ buttons. Now and then, when it's awake and has been idle for a while, the robot swivels over and presses ▲ (*beep*). The desk motors up, carrying the monitor, keyboard, mug and lamp, while the display counts 72 → 102 cm. Now too low, the robot pulls the chair's lever (*psshh*) to pump its seat up to match, and types up there in "Standing desk mode!". Then it presses ▼ and both glide back down. If work starts or it nods off halfway, the desk and seat simply glide down on their own.

It also treats itself to a **bubble milk tea** now and then. A cup pops into its hand (*pop*), and it sips through the fat pink straw (*slurp*) while tapioca pearls ride up the straw and the tea level drops. Then 😋, and the cup pops away.

Idle for a bit, it may sneak in some **social media** instead of working. It swivels round to the monitor and scrolls a cartoon Facebook, TikTok or YouTube (picked at random), one hand on the mouse, with a wheel *tick* for every scroll. Then it hits a funny cat post, cracks up laughing and slapping the desk, and likes it (👍 or a big ♥). On YouTube it clicks a cat video first and watches the cat knock a cup off the table. The feeds are drawn in `office3d/feeds.js`.

When it's been idle a while it may drop for **push-ups**. It hops off the chair (*boing*), the chair rolls aside, and it gets into a straight plank on the floor, side-on to you, face turned your way. It does five push-ups, grunting and counting them out (1, 2, … 5!!) while it sweats more and more; the last one is slow and wobbly. After a "phew…" flop it hops back into the chair, fists up: "Feel the burn! 💪".

Sometimes it **doom-scrolls on its phone**. The phone pops into its hand and it hunches over it, thumb-flicking (*tick, tick*) through a feed that really scrolls, the screen glowing on its face, until something makes it laugh 😂. Then the phone pops away.

**Sleeping** comes in two styles, a coin toss each time it nods off:
- **in the chair** with a lavender eye mask, lashes printed on it. Now and then it can't resist: it slides the mask up, opens its eyes and scrolls its phone, held over its face ("…just one more"), then slides the mask back down and drops off again;
- **on the floor**: the chair rolls out of the way (*poof*), and it curls up on its side with its head on a pillow and its hands tucked by its face, under a plaid blanket that rises and falls as it breathes.

On the floor it skips the chair-only dreams (sleep-typing, sliding off the seat, drifting round). Its speech bubbles float above it in the room.

The robot swivels its chair to face you when it's idle or answering, and turns to the monitor when it's working. The monitor and its body language follow what Claude Code is doing:

| Claude Code is… | Monitor shows | Robot |
| --- | --- | --- |
| thinking | spinner with a `?` | half-turned, hand on chin, `?` bubbles float up, coffee steams faster |
| reading a file (`Read`) | a page scrolling by | faces the screen, leaning in |
| searching (`Grep`, `Glob`) | a magnifying glass hunting over the page | faces the screen, leaning in |
| editing or writing a file | code lines typing in, with diff markers | typing furiously |
| running a command (`Bash`) | a green terminal scrolling | typing, sweat drops |
| on the web | a spinning globe | reading |
| sending a sub-agent | two little helper bots | watching them |
| planning (`TodoWrite`) | a checklist ticking itself off | typing |
| answering you | a speech bubble | swivels round to face you and talks with its hands; a 💡 pops up as the answer starts |
| done | a big green ✓ | arms up, bouncing in its chair |
| failed | a blue screen `:(` | dizzy eyes |
| blocked by permissions | a padlock | annoyed |
| asleep | screen off | leans back in its chair snoring; the lights dim |

The monitor casts its colour onto the robot and desk. Poke it for hearts; it sometimes spins round in its chair when it's bored. The Workshop preview cycles through all of these.

### Left to its own devices

Leave it alone and it finds things to do. Awake and idle, it looks around, waves, spins in its chair, sips its coffee (sometimes the mug is empty), pumps a dumbbell (three curls, the last one a real struggle, then a 💪 flex), hums, sneezes, rocks back on two chair legs and nearly falls ("…nobody saw that"), throws paper balls at the wastebasket by the desk, flicks the desk lamp, watches the bouncing-logo screensaver (and cheers if it hits the corner), or leans back with its hands behind its head until your mouse comes near, when it spins round and types furiously. The longer you ignore it, the bigger it gets: it talks to itself in its personality's voice, then sighs, drums its fingers and waves at you. Each character has its own too: the cat chases its tail or pushes the mug toward the edge while staring at you, Loopy gnaws a pencil, the nerd pushes up his glasses or plays air guitar, the robot flicks its antenna or defragments.

Asleep, every 30–60 seconds: a snot bubble that pops and half-wakes it ("huh?"), sleep-talking, dreams in a thought bubble (and faintly on the dark monitor), typing in its sleep, slowly sliding down the chair, a big snore that rattles the mug, the chair drifting round, a drop of drool. After 10 pm it sleeps in a nightcap.

The 3D side lives in `src/renderer/office3d/antics/` (`index.js` explains how an antic is written); `robot.js` decides when they play and adds the sounds and words.

The 3D scene (Three.js, toon-shaded with ink outlines) lives in `src/renderer/office3d/` and is bundled by esbuild into `src/renderer/office3d.bundle.js`. `npm start` builds it automatically; run `npm run build` after editing it.

Personalities: 😄 Cheerful, 😒 Grumpy, 🏴‍☠️ Pirate, 🧘 Zen, 🎭 Dramatic. They change both the canned reactions and the tone of Claude's answers (through `--append-system-prompt`).

## Permissions

Each robot gets a Claude Code permission mode. In print mode nobody can click "allow", so anything outside the mode is refused, and the robot tells you which tool was blocked.

- **Look, don't touch** (`default`): reads and searches only
- **Helpful hands** (`acceptEdits`): can edit files in its folder
- **Unleashed** (`bypassPermissions`): can run anything. Only use it on folders you trust it with
- **Planner** (`plan`): proposes plans, makes no changes

## How it works

```
src/
  main/
    main.js           windows, tray, drag/expand layout, IPC
    claude.js         spawns `claude -p --output-format stream-json`, parses the event stream
    personalities.js  system-prompt flavour + canned lines per personality
    sessions.js       reads Claude Code's transcripts for past conversations / resume
    terminal.js       opens full Claude Code in a terminal and mirrors it onto the robot
    store.js          JSON persistence in <userData>/c-bot.json
    trayIcon.js       pixel-art tray icon
  preload/preload.js  whitelisted IPC bridge
  renderer/
    office3d/         the 3D workstation: desk, robot rig, face, monitor screens (bundled by esbuild)
    robot/            the floating robot window: moods, poking, dragging, chat bubble, sounds,
                      slash-command palette, past-conversations view (history.js)
    manager/          the Robot Workshop
```

- One robot is one frameless, transparent, always-on-top window. It's small while the robot sleeps; when it wakes it grows to the full height of the screen with the chat panel beside the robot (520 px wide by default, resizable, on the left unless there's more room on the right). The robot itself stays where you put it. Clicks on the window's see-through parts pass through to whatever is behind it (`setIgnoreMouseEvents` with forwarding).
- Windows sometimes drops a window's "always on top" flag without telling the app (taking a snip with the Snipping Tool does it), which made robots vanish behind other windows. On Windows, `src/main/topmost.js` reads each robot window's real flag every 2 seconds (through [koffi](https://koffi.dev/)) and restores it if it's gone.
- Every question starts a `claude -p` process in the robot's folder with `--resume <session>`, so each robot keeps its own ongoing conversation. **New conversation** clears that.
- Stream events drive the animation: text deltas make it talk, `tool_use` blocks show up as chips and thought-bubble icons, `task_summary` events become the status line.
- The `claude` binary is found in `~/.local/bin`, then the usual install locations, then `PATH`. You can also point to it in the Workshop.
