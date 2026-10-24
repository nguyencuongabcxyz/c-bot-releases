# C-Bot 🤖

Cartoon robots that live on your desktop and are secretly **Claude Code**.

Give each robot a name, a personality and a home folder, stick it anywhere on screen, click to wake it up and ask it things. Under the hood each question runs `claude -p` in the robot's folder, and the robot animates along with what Claude Code is doing.

## Install it (Windows)

1. Install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) and sign in, so `claude` works in a terminal. The robots run your own Claude Code.
2. Download **C-Bot-Setup-x.y.z.exe** from the [latest release](https://github.com/nguyencuongabcxyz/c-bot-releases/releases/latest) and run it. It installs just for you, no admin rights needed, with Start-menu and desktop shortcuts. Until the app is code-signed, Windows may say *"Windows protected your PC"*: click **More info → Run anyway**.

C-Bot **finds Claude Code by itself**. It looks in every usual install spot first: the Claude Code installer's `~\.local\bin`, npm, nvm, Volta, pnpm, Yarn, Scoop, WinGet and Bun. Next it tries your PATH as it is now (read fresh, so a Claude Code you installed after signing in to Windows still counts). Last, it uses the copy the Claude desktop app keeps for itself. The Robot Workshop's bottom-left corner shows which one it's using. If it says *not found*, install Claude Code (the command to copy is right there) and press **Search again**, or **Locate it myself…** to pick the file; it checks that the file really is Claude Code.

C-Bot then **updates itself**: it checks for a new version at start and every few hours, downloads it in the background and installs it the next time it restarts. Right-click the tray icon to see the version, check now, or **Restart to update** straight away. Updates never touch your robots or chats; they live in `%APPDATA%\C-Bot`.

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

The tray menu is grouped like a robot's right-click menu: your robots (tick to show, untick to put away; walkers can be called back) with the Workshop and New robot; then the features (⌨️ All actions, 🔍 Ask about part of the screen, ✨ Quick actions, 📒 Notes, 📚 English words, each a submenu with its hotkey); then ⚙️ Settings (Theme, Mute, Start with Windows, backups); then the version and Quit.

Your robots survive restarts:
- **Start with Windows** (tray menu, on by default) brings C-Bot and its robots back after a reboot. Robots you **Put away** stay hidden until you tick them in the tray menu.
- **Saving is power-cut safe:** each save goes to disk before it replaces the old file, and Windows shutting down or signing out triggers a save straight away.
- **A daily backup** of the robots goes to `<userData>/backups/` (14 days kept; the tray's **⚙️ Settings → Open backups folder** opens it).
- **A damaged save file is never replaced by an empty one.** It's set aside as `c-bot.broken-….json`, and the robots come back from the newest backup, with a message saying so.
- **Closed tabs can come back:** **Undo** right after closing one, then **↺** next to ＋ or **Ctrl+Shift+T** (the last 10 per robot).

### Build your own robot

Every robot is one you build. The Workshop's editor starts with its **name** and **home folder**, always at the top. Below them are three tabs:

- **Look:** the robot itself
- **Mind:** personality, brain, what it may do, what a click opens; at the bottom, Forget conversation (**Delete robot** is in the bottom bar on every tab, and beside each robot in the list)
- **Habits:** whether it wanders off

The preview faces you. Hold and drag it to turn it round, to see a cape or wings on its back; its chair gets out of the way, and when you let go it turns back to face you. Picking something worn on its back shows it from behind for a moment.

**Look** has the presets, **Surprise me** and **Undo** at the top, then its own tabs:

- **Shape:** a row of parts per slot, scrolling sideways
- **Colours:** the paint, the other colours, the finish
- **Outfit**
- **Size and desk**

Click a part to try it; the preview changes straight away. Robots made before this, as Loopy, the cat, the nerd, the girl, the classic robot or your own 3D model, were turned into builds that look like them the first time C-Bot started.

- **Head:** rounded box, ball, dome, capsule, old TV, bucket
- **Face:** classic, cute (big shiny eyes, rosy cheeks), visor, cyclops (one big eye that follows the mouse), pixel (chunky pixels)
- **On top:** antenna, twin antennas, cat ears, a propeller that turns, a dish, a light bulb, or nothing
- **Body:** box, barrel, egg, slim, chunky
- **Arms:** classic, noodle, mittens, claws
- **Stands on:** legs, a wheel, treads, a jet, a spring
- **Finish:** matte, glossy, metal, painted wood
- **Colours:** the main colour is the **Paint job**; then one for the arms and legs, one for the lights (antenna, chest light, cat-ear glow), and one for the eyes (or **Like its brain**, as the classic robot does)

Start from a preset (**Classic bot, Cat-bot, Nerd-bot, Cutie-bot, Rover, Retro TV**). Or press **Surprise me** for a random robot, or **Shuffle this part** to try another part in the slot you're on. **Undo** steps back through your changes. Every combination does everything the other characters do: poses, idle antics, dreams, the hats. With legs it walks when it goes off round the screen; on a wheel, treads, a jet or a spring it hops along, balancing. It's `src/renderer/office3d/kit3d.js` (the parts) and `kitface.js` (the faces).

### Outfits and hats

The builder's **Outfit** tab dresses up a robot you built.

- **Themed looks**, each with a boy's and a girl's version:
  - **Christmas:** Santa; Elf
  - **Halloween:** Vampire; Witch
  - **Beach:** Surfer; Beach day
  - **Party:** Gentleman; Princess
  - **Winter:** Snow day; Snow day
- **What a look does:** it puts on the hat, the clothes and the extras in one click. A girl's look also does her hair (pigtails, a ponytail or curls) unless it's already done. **Take it all off** clears the outfit. **Shuffle this part** on the Outfit tab picks a random look.
- **Or mix your own:**
  - **Clothes:** T-shirt, Hawaiian shirt, suit, Santa suit, elf tunic, vampire, witch dress, dress, swimsuit, tutu
  - **Round its neck:** scarf, tie, bow, pearls, flower lei
  - **Holding, or on its back:** a present, candy cane, pumpkin bucket, ice cream, balloon, cape, fairy wings, bat wings, surfboard, backpack. It holds things in its left hand, as its right is busy with its phone and mug.
  - **Glasses:** sunglasses, heart shades, round glasses, star glasses, eye patch
- **On top** also has hairstyles: pigtails, ponytail, spiky, curly.
- **Colours** has a **Clothes** colour (for the T-shirt, dress, swimsuit…) and a **Hair** colour.
- Clothes are cut to its body shape and sleeves move with its arms. Dressed up, it takes its ID badge off.

**Hat** (on the Outfit tab) has, besides the hard hat, glasses, bow tie, top hat, crown, headphones, flower, pirate hat and graduation cap: Santa hat, elf hat, reindeer antlers, witch hat, devil horns, sun hat, straw hat, party hat, tiara, hair bow, beanie. The clothes are in `src/renderer/office3d/kitwear.js`, the hats in `robot3d.js`.


On **Size and desk**, **Size** makes a robot 🐭 Small (70%), 🙂 Normal, 🦒 Large (135%) or 🐘 Huge (170%); it grows or shrinks around its feet, so it stays where you put it, and its speech bubbles keep a readable size.

**Desk** dresses the whole workstation: **🎨 Classic** (the wooden desk), or **⛺ Sioux Connect**, styled after the Sioux Connect employee portal: a white desk with charcoal legs, the portal's tent logo and "SIOUX CONNECT" wordmark on the monitor (on its blue-grey-peach backdrop), an orange boot splash, the brand orange on every screen, a logo nameplate on the desk, a logo mug, the logo on the back of the chair, an orange status light and an ID badge with the logo on a cyan lanyard. Picking it also paints the robot Sioux orange (change the paint afterwards if you like). The themes live in `src/renderer/office3d/themes.js`, so adding one for another project is one entry there.

## Playing with your robots

| Do this | And the robot… |
| --- | --- |
| Click a sleeping robot | the squeaky toy hammer bonks it awake (SQUEAK!): it jolts up, a bit dizzy, grumbles, and opens its speech bubble: a chat panel beside the robot, the full height of the screen, on whichever side has room |
| Drag the chat's outer edge | makes it wider or narrower (each robot remembers its width; double-click the edge to reset it) |
| Type and press Enter | watches you type, thinks (antenna spins, thought bubble shows 📖 🔍 ⚙️ ✏️ for each tool), then talks while the answer streams in |
| Send a question | the chat stays open and the answer streams in while the robot works at its desk |
| 🔽 | tucks the chat away so you can watch it work: a little status bubble above the robot (below it, if the robot sits at the top of the screen; never over the desk) says what it's doing ("📖 Reading main.js…", "💬 Writing it up…"). Click the bubble or the robot to bring the chat back. It stays tucked away until you do: when the task is done the bubble says "✅ Done! Click to read the answer", and when Claude has a question for you it says "✋ I have a question for you" |
| Click the squeaky hammer on the floor by the desk | bonks the robot (wakes it if it's asleep). Hover it and it lights up |
| Click the plug in the power strip under the desk | charges its battery: the plug buzzes, its light goes green and a battery over the robot's head fills red → green while bolts crackle. It doesn't wake a sleeping robot |
| Click an awake robot | gets poked. Poke it too often and it gets grumpy or dizzy |
| Double-click its monitor | crashes the computer: a blue screen, and it turns round to you, hand on its heart, betrayed |
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

### One hotkey for everything

You only need to remember **Ctrl+Alt+C** (C for C-Bot). Press it anywhere and a small menu opens by the mouse with what you can do right now:

- **With some text selected:** 📚 Save “word” to my words (for a word or a short phrase), ✨ Refine it, 🌐 Translate it, 💡 Explain it, 📝 Sum it up, 📒 Note it down, 💬 Ask a robot about it (a new chat tab with the text in it, for you to add your question), then 🔍 Ask about part of the screen and 📖 My words.
- **With nothing selected:** 🔍 Ask about part of the screen, 📚 Box a word on screen, 📒 New note, ✨ Quick actions, 📖 My words and 🗒️ My notes.

**The drone.** The menu is delivered: when you press the hotkey, the robot nearest the mouse raises its arm and sends off its little drone. The drone flies over to you in an arc, tilting into the turn, hovers just above where the menu opens and projects it with a beam of light: the menu unrolls down from its top edge with a scan line running down it. When the menu goes, the drone flies home and fades out. It's a sleek dark drone with a cyan beam in Future and a brass one with a warm lamp in Vintage, with a stripe in the robot's paint. It takes off once your selection is read and the menu's spot is known, so it's one smooth flight: the menu is up about 0.3 s after the key with text selected, about 0.5 s with nothing selected. Turn it off in the tray, **⚙️ Settings → 🛸 A drone brings the action menu**, and the menu just pops up. With Windows animations off it skips the flight. It's `src/main/drone.js` and `src/renderer/drone/`.

Pick one with its number key (1–9), the arrow keys and Enter, or the mouse. Esc or clicking away closes the menu. It follows the theme. The tray has it too (**⌨️ All actions…**). Each feature's own hotkey (Ctrl+Alt+W, N, R, B) still works if you know it. Change the hotkey in the Workshop: **Settings → Shortcuts**. The menu is `src/main/palette.js` and `src/renderer/palette/`.

### Settings

The Workshop's **Settings** button (bottom of the sidebar) opens the app's settings in place of the robot editor. Above the button, the sidebar always shows where Claude Code (`claude`) was found, with **Search again** and **Change…**, and the action menu's hotkey (click it to go to Shortcuts).

- **Shortcuts:** every hotkey (action menu, ask about part of the screen, quick actions, save a word, take a note), with what it does and whether it works or another app has it. Click one and press the new keys (with Ctrl or Alt; Esc cancels). ↺ puts it back to its default.
- **Look and sound:** app theme, light or dark, mute robot sounds, and whether a drone brings the action menu.
- **Notes and reminders:** the reminders, the workdays, who reminds you, where the corkboard goes.

### Ask about part of the screen

Press **Ctrl+Alt+B** anywhere (or the 🔍 button left of the chat box, right-click a robot → **🔍 Ask about part of the screen…**, the tray menu, or `/screen` in a chat). Then drag a box round anything: an error dialog, a chart, a paragraph in another language, part of a web page. Esc or a right-click cancels.

The robots fade out while the screen is captured, so they aren't in the way. The box is saved like a pasted screenshot, and the robot nearest the mouse opens a fresh tab with it attached. Above the chat box it offers **💡 Explain this**, **🛠️ What's wrong?**, **🌐 Translate** (into Vietnamese) and **📝 Sum it up**. Click one, or type your own question and send. With the hotkey, the one-click questions also tell Claude which app the box came from. If every robot is out for a walk, one is called back to its desk first. Change the hotkey in the Workshop: **Settings → Shortcuts**.

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

Leave it alone and it finds things to do. Awake and idle, it looks around, waves, spins in its chair, throws itself a little dance party (disco screen, disco lamp, a little tune), holds a hand up for a high-five, sips its coffee (sometimes the mug is empty), pumps a dumbbell (three curls, the last one a real struggle, then a 💪 flex), hums, sneezes, rocks back on two chair legs and nearly falls ("…nobody saw that"), throws paper balls at the wastebasket by the desk, flicks the desk lamp, watches the bouncing-logo screensaver (and cheers if it hits the corner), or leans back with its hands behind its head until your mouse comes near, when it spins round and types furiously. The longer you ignore it, the bigger it gets: it talks to itself in its personality's voice, then sighs, drums its fingers and waves at you. It has its own fidgets too: it flicks its antenna or defragments.

It also lives the office life: it explains its bug to a rubber duck until the duck squeaks and it goes "OH!", glares at a frozen monitor and turns it off and on again, Ctrl+C / Ctrl+V's an answer off Stack Overflow and looks round guiltily, yanks a cable under the desk (the whole desk jolts), shakes the crumbs (once in a while a whole cookie) out of its keyboard, holds its head at a screen full of merge conflicts and then meditates, gives its daily stand-up ("Yesterday: stuff. Today: more stuff. Blockers: you."), juggles Jira tickets until one sticks to its face, hugs its monitor because it works on its machine, and chugs three coffees and types at warp speed.

The clock joins in: on Friday afternoons it holds up a "NO DEPLOYS ON FRIDAY" sign, on Monday mornings it's on a coffee drip, at lunch (12–1) it slurps instant noodles at the desk, on the 25th it's payday (money rain, then an empty wallet), once an hour it stretches and takes a 20-20-20 eye break, and after 10 pm it codes with its hood up in the glow of the monitor.

Asleep, every 30–60 seconds: a snot bubble that pops and half-wakes it ("huh?"), sleep-talking, dreams in a thought bubble (and faintly on the dark monitor), typing in its sleep, slowly sliding down the chair, a big snore that rattles the mug, the chair drifting round, a drop of drool. After 10 pm it sleeps in a nightcap. It has office dreams too: a nightmare that prod is down (it jolts awake, "…just a dream"), snores that fill a progress bar to "Sleep.exe ✓ 100%", a 3 am message buzzing its phone (it slaps it face-down without waking), a little robot vacuum that bumps into it while hoovering up crumbs, and, on the floor, rolling itself up into a blanket burrito 🌯.

### Wandering off

Leave it alone for a few minutes and it may get up and go for a walk round your screen (asleep, it sleepwalks: arms out, eyes shut). It steps out of its desk window into a little window of its own and strolls from place to place, stopping to look around, wave or sit down for a bit. Its desk stands empty with a **BRB** note on the monitor, and the chat tucks away: clicking the empty desk just makes it wave at you from wherever it is.

To use it again, **drag it back onto its desk**: pick it up (it dangles and kicks), carry it over the desk (the desk lights up) and let go. It hops back into its chair, awake or asleep as it was. Put it down anywhere else and it carries on walking. If it's somewhere you can't reach, the tray menu (and the empty desk's right-click menu) can call it back. In the Workshop, **Wanders off → 🪑 Stays at its desk** turns this off for a robot.

The walking happens in `src/main/walker.js` (the window and its route) and `src/renderer/walker/` (the page); the standing, walking character is office3d's solo mode (`walker3d.js`).

### Robots asking each other

In a robot's chat, ask it to ask another robot: *"Ask Sunny which port her API runs on and which header the token goes in"*. Your robot's Claude sends Sunny a message; Sunny works on it in a tab of her own chat (titled with the message, in her own folder, with her own tools, personality and permissions; her chat stays tucked away so you see her working) and her answer goes back. Your robot decides by itself whether that's enough: it follows up as many times as it takes (the follow-ups go to the same tab, so Sunny remembers the conversation), then answers you, saying what it found out from whom. Each question flies over as a paper plane, and the answer flies back.

More than two at once works too:

- **One robot asks several** at the same time ("ask Sunny for the port and Captain for the staging host, then give me the full URL"): each answers in parallel and your robot puts it together.
- **A robot is asked by several**: a tab for each, answered in parallel.
- **Chains**: a robot answering one can ask another to find out (Grumbo asks Captain, who asks Sunny), up to four robots in a chain. It can never ask back up its own chain (the robot waiting on it), so they can't go round in circles.

Guards: a robot can't ask itself or a robot that's put away (it's told who is on the desktop); at most 12 messages in 10 minutes per robot (then it's told to answer with what it has); and an answer that hasn't come after 10 minutes (say the other robot is waiting on you in its chat) comes back as "couldn't answer". The asked robot follows its own **What may it do?** setting from the Workshop: reading and searching its files always works, while running commands may need a permission it doesn't have.

Under the hood every robot's Claude Code gets two tools, `ask_robot` and `list_robots`, from a tiny MCP server C-Bot starts with each conversation (`src/main/robotsMcp.js`, run by C-Bot's own executable); it reaches the app over a private local pipe, where `src/main/robotLink.js` finds the robot, hands it the message (it takes it on in robot.js like any question) and returns its answer. Each robot's system prompt names the others it can ask.

### Robots together

With two or more robots out, they notice each other:

- **Waves:** two idle robots on the same screen: one turns in its chair and waves at the other, which waves back (asleep, it just stirs).
- **Claps:** when a robot finishes a task, the idle ones turn to it and clap, sometimes with a line ("Nice one, Culi! 🎉").
- **Contagious yawns:** when a robot dozes off, idle neighbours stretch and yawn; one that's been idle a while may nod off soon after.
- **Group dance:** at a vocab milestone every free robot dances, not just the one that caught the word.
- **Visits:** a robot bored for a minute or so may get up and walk over to another desk. What happens depends on the host:
  - awake and free: they **chat**, three lines in their own personalities (a Grumpy one visiting a Cheerful one: "Sunny. You look busy. Good." / "Hi hi! Nice to see you!" / "Don't follow me."). The host turns to listen.
  - working on a task: the visitor **watches over its shoulder** and cheers it on ("You got this! 💪"), then claps and goes home when the task is done.
  - asleep: it **tiptoes** over and leaves a pink "came by 👋" sticky on the sleeper's monitor; when the sleeper wakes it reads it ("Aww, Grumbo came by! 💕").
- **Paper planes:** a bored robot folds a paper plane and throws it at another one; the plane flies across your screen from desk to desk. If the other robot is free it catches it and reads it out ("From Grumbo: 'who took my mug?'"), then waves over and gets a wave back. If it's busy or asleep, the plane lands on top of its monitor and gets read once it's free (or wakes up). Each personality has its own notes ("is it Friday yet? 😄", "you dropped this: 🐛", "HELP! The build is ON FIRE! 🔥"). Once in a while one misses, sails past the desk, lies on your desktop for a moment and fades ("Oops! 😅").
- **Office life**, once a day each on workdays, at the right time:
  - **Lunch order** (10:30–11:40): a robot walks over: "Lunch order? I'm getting cơm tấm 🍚" / "Yes! Bún chả for me, please 🍜" / "Ordered! 20 minutes 🛵". A few minutes later the food comes to both desks ("Food's here! 😋") and they eat.
  - **Lunch out** (11:40–12:30): "Lunch time! Wanna go out? 🍜" / "Yes! I'm starving!": both get up, walk to a spot between their desks, sit side by side chatting ("This bún bò is so good!" / "Same place tomorrow?") and walk back. Their desks say they're out for lunch together; click either one and both head back.
  - **Milk tea round** (14:00–16:00): one robot goes desk to desk taking orders ("Brown sugar pearls, less ice!"), or "I'll get you the usual" for one that's busy, then "Ordered for everyone! 🛵". A few minutes later everyone's milk tea comes and they drink it.

  An order that comes while a robot is busy waits till its task is done; a sleeping robot wakes up for it (its chat stays tucked away). Every line is in the robot's own personality (a Grumpy one: "Ordering lunch. You want something or not?" / "Busy? I'm getting you the usual.").

A visit never gets in your way. Click the visitor and it says "Gotta go!" and hurries home; start using the host, give the visitor a task or press a hotkey that needs it, and it heads back (or is called back at once). Its empty desk says who it's visiting. Only one visit (and one plane) happens at a time, each robot visits or throws at most every ten minutes or so, and nothing social happens while you're using a robot (its chat, a card, the notebook, Quick actions), while you're away, the screen is locked or Windows says you're busy (a meeting, presenting, fullscreen, Focus). A robot set to **🪑 Stays at its desk** in the Workshop doesn't visit, but can be visited. **⚙️ Settings → 🤝 Robots socialising** in the tray: Often, Sometimes (the default) or Never.

`src/main/social.js` decides who does what (each robot reports how it is every few seconds); the visit walks are errands of the walker (`walker.js`), the flying plane is `src/main/plane.js` and `src/renderer/plane/`, the desk animations (wave, clap, listen, throw, catch, read) are in `office3d/antics/social.js` with the paper plane model in `office3d/plane3d.js`, the walking ones (talk, tiptoe, clap) in `walker3d.js`, and the lines and plane notes in each personality's `social` (`personalities.js`).

### Learning English words

Select a word (or a short phrase) anywhere, in a browser, Word, a PDF, Teams, and press **Ctrl+Alt+W**. The robot nearest the mouse catches it ("Ooh, *meticulous*!"), pulls out a dictionary and leafs through it while its monitor searches for the word, then reads the word out, holds up a flash card of it and pops it into the **word box** on its desk (it fills up with cards as you collect words). Asleep, it wakes up for it, its chat staying tucked away.

Next to it a **word card** shows the word straight away and fills in as Claude (the quick Haiku model) answers, in three tabs:
- **📖 Meaning**: the pronunciation, the meanings in **Vietnamese** (with a short English definition; the one that fits first), for a verb **all its forms** (*go · goes · went · gone · going*, marked when irregular; click one to hear it), the **common phrases** it's used in (*tackle a problem*, *tackle a task*…), each with an example sentence and its translation, and a usage tip.
- **🔁 Similar**: synonyms and antonyms for that meaning, each with a note on how it differs (stronger, more formal, only for things…).
- **🌳 Family**: the other words built on it (*diligence*, *diligently*), each with an example.

🔊 reads the word or an example aloud; ＋ by a synonym or a family word saves it as a word of its own (looked up in the background); **✏️ Edit** fixes a meaning or an example; **↩️ Undo** throws the word away; **💬 Ask more** opens a chat tab with a question about the word ready to send. Catching a word you already have shows its card instead, and it comes up for review sooner. Ask a robot *"what does X mean?"* (or *"X nghĩa là gì?"*) in a chat and its answer offers **📚 Save "X" to my words**.

**A word you can't select** (in a picture, a video, a scanned PDF): press **Ctrl+Alt+W** with nothing selected (or pick **🔍 Box a word on screen** in a robot's right-click menu) and the screen dims: drag a box round the word. Claude reads the word in the box (and the sentence round it, so the meaning that fits comes first), and the robot catches it as usual. Esc or a right-click cancels.

**Seeing your words again**, the more often the better:
- **Sticky notes** on the left edge of each robot's monitor show the three words you're still learning (click one for its card).
- When it's idle, a robot sometimes swivels round to its monitor, which shows one of your words as a flash card, and reads it out (*"tackle… giải quyết"*). Asleep, it mutters your words in its sleep.
- **Dreams**: when a word is due, a **sleeping** robot dreams of it (at its desk the word glows on its monitor and it mumbles it; sleepwalking round the screen it stops where it is and mumbles it) and a **dream bubble** beside it shows the word, its meaning and an example sentence (a different common phrase each time it comes back), with **📖 Details** (the whole card) and **✓ I know this one** (it comes back much later). Nothing to answer: the bubble fades after 20 seconds (not while the mouse is on it) and the word counts as seen.
- **When each word comes back**: the first dream 30 minutes after you save it, then 2 hours later, 6 hours, a day, 2 days, 4 days, a week, 2 weeks, and a month from then on, so a new word shows 3–4 times on its first day and less and less after. ✓ I know this one skips it two steps ahead; catching it again (you met it somewhere) puts it back to "2 hours". The most overdue word goes first (a tie: the newer one), never the same word twice in a row. Seen six times, it counts as learnt.
- **How often**: one dream every 20 minutes at most, 12 a day, during your hours (9:00–18:00 by default), only while you're at the PC (not away, locked or presenting) and only from a sleeping robot (your word tutor if it's asleep); with none asleep, the word waits for the next nap. **💭 Show me one of my words** (a robot's right-click menu) shows one straight away.
- **🃏 Quiz me** (the tray, a robot's menu, My words) tests you when you want it: the card shows the word, 💡 Hint shows a phrase it's used in, 👀 Show the meaning turns it over; then **✓ Knew it** (a step ahead), **✗ Forgot** (back to the start) or **⏰ Later**. A bonk (the hammer) skips it.

**📚 My words** (tray menu, or a robot's right-click menu) lists them all, **sorted and grouped** your way: 🆕 Newest (Today / Yesterday / This week / This month / Earlier), 🔤 A–Z (by letter), 💭 Next dream (Due now / Later today / This week / Later) or 🌱 Progress (New / Learning / Learnt); click a heading to fold it. Search by word or Vietnamese meaning (accents optional), filter the due / learning / learnt ones (each filter shows how many), and see each word's main meaning, how many times you've seen it (the bar and the coloured edge) and when its next dream is; click one for its card, 🗑️ to delete it. Up top: words, learnt, learning, due now and your **daily streak** 🔥; **🃏 Quiz me now**; at the bottom the dreams switch and your hours, and **⬇️ Export** (a CSV for Anki, Quizlet or Excel). **🎓 This robot is my word tutor** (a robot's right-click menu) picks which robot dreams of your words and quizzes you.

**Rewards**: a dance party at 10, 25, 50, 100… words learnt and at 3, 7, 14, 30… days in a row; at 10 learnt, the **🎓 Graduation cap** appears in the Workshop's accessories.

C-Bot copies the selection the way you would (Ctrl+C) and puts your clipboard back afterwards. Only the word (or the box you drag) goes to Claude. Your words are kept in `vocab.json` in C-Bot's data folder (saved power-cut safe, backed up daily with the robots), with their review state. `src/main/capture.js` is the hotkey and copy-the-selection part (other features can register hotkeys of their own); `vocab.js` keeps the words, their schedule and stats and looks them up; `reminders.js` decides when to quiz; `snip.js` and `src/renderer/snip/` are the drag-a-box screen; `wordCard.js` and `src/renderer/card/` the card; `src/renderer/words/` the My words window; the antics are in `office3d/antics/vocab.js`, the sticky notes in `office3d/scene.js` (`set.stickies`, shared with other features: words on the monitor's left edge, the right edge is free).

### Notes and daily reminders

A **corkboard** stands on the left end of every desk with your open notes pinned to it as little stickies (up to five, then a "+3" pin; important ones are red, ones older than a few days go yellow; nothing open: *✓ all clear*). Hover it and it lights up and says how many; **click it** (or a sticky) and your **notebook** opens beside the robot. It works with the robot awake, asleep or out for a walk.

In the notebook, type in the box and press Enter (start with **!** for an important one). Notes are grouped **Important / Today / Yesterday / Earlier**, with the done ones folded away at the bottom. Tick one off, double-click it to edit, or use its **⋯** menu: **🤖 Ask Claude** (a new chat tab works on it, a 🔧 shows on its sticky meanwhile, and the answer ends with **✅ Tick it off my notes**), copy, or delete (with Undo). The filter box searches them; the header's ⋯ copies them all or clears the done ones. Esc or clicking away closes it.

**Other ways to take a note:**
- **Ctrl+Alt+N** anywhere: the notebook opens with what you had selected already in the box (and where it came from).
- **/note buy milk** in a chat (**/notes** opens the notebook), or a robot's right-click menu or the tray.

**The robot joins in:** it writes a new note on a sticky and pins it up ("Noted! 📝"; asleep, it half-wakes and mumbles "…noted…"); tick one off and it takes that sticky down, crumples it and bins it, with a happy spin when the board is all clear. When idle it sometimes glances over at the board and straightens a pin, juggles your actual notes instead of Jira tickets, and with eight or more open it gets a little overwhelmed.

**Reminders:**
- At the **end of the day** (17:30 on workdays) and the **first time you're at your PC in the morning** (after 6:00), a robot holds its corkboard up, points at you and the notebook opens with what you noted (the morning one: since your last workday, plus everything still open).
- The banner has **⏰ In 15 min** and **👍 Done for today**, and in the evening **✨ Summarise my day** (Claude writes a short summary in a new tab). After the evening one the robot clocks out and goes to sleep.
- It waits while the robot is busy and only when you're there (not locked, not away). Out for a walk, the robot waves and the notebook opens; with no robot out, you get a Windows notification. A reminder you missed isn't shown late, the next one covers it.

In the Workshop, **Settings → Notes and reminders** sets the reminders (on/off, end-of-day time, mornings, workdays, every open note or just yesterday's), which robot reminds you (also in a robot's right-click menu) and whether the corkboard is on every desk or only on that robot's.

Notes are kept in `notes.json` in C-Bot's data folder (backed up daily); done notes are cleared after 30 days. `src/main/notes.js` keeps them and decides when to remind you; `notebook.js` and `src/renderer/notebook/` are the notebook; the corkboard is `office3d/board.js` and its antics `office3d/antics/notes.js`.

### Quick actions on selected text

Select some text anywhere (an email you're writing, a Teams message, an error, some code) and press **Ctrl+Alt+R**. The **Quick actions** window opens beside the robot nearest the mouse with your text in it (line breaks kept; you can edit it), and runs the action you used last:

- **Refine text** rewrites it in a style: **Polished** (correct and natural, your own voice), **Professional**, **Polite**, **Friendly**, **Formal**, **Concise**, **Simple** (plain English) or **Grammar only**. Add your own instruction too ("sound more confident"). Under the answer, **What changed** lists the main fixes, the original crossed out, the fix and why ("*inform* needs a person as its object"), so you learn as you go.
- **Translate**: English ↔ Vietnamese. It works out the direction from the text; ⟳ swaps it.
- **Explain**: what it means. For code, what it does; for an error, what went wrong and how to fix it; for an idiom, its meaning. Answers in English or Tiếng Việt.
- **Summarise**: 3 to 5 bullet points, in English or Tiếng Việt.

The answer streams in as Claude writes it. **Replace** (Ctrl+Enter) puts it back over your selection in the app it came from; **Copy** (Ctrl+Shift+C) copies it; **Again** runs it again; **Ask more** opens a chat tab with the text and the answer, ready for your question. Switching back to a style you already tried is instant. Esc closes it. Your clipboard is put back as it was after grabbing the text and after Replace.

With nothing selected (or from the tray's **✨ Quick actions → Quick actions on text…**, a robot's right-click menu, or **/refine some text** in a chat) the box opens empty (or with what's on your clipboard) for you to paste or type into. While it works, the robot writes on its sticky pad (refine, summarise) or leafs through its dictionary (translate, explain), and gives a little hop when your text goes back. The tray's **✨ Quick actions** submenu picks the model: **Fast brain (Haiku)**, the default, or **Better writing (Sonnet)**. Change the hotkey in the Workshop: **Settings → Shortcuts**.

Only the text you selected (or typed) goes to Claude. `src/main/quick.js` holds the prompts and runs Claude Code; `quickWindow.js` and `src/renderer/quick/` are the window; `capture.js` grabs the selection and pastes the answer back.

The 3D side lives in `src/renderer/office3d/antics/` (`index.js` explains how an antic is written); `robot.js` decides when they play and adds the sounds and words.

The 3D scene (Three.js, toon-shaded with ink outlines) lives in `src/renderer/office3d/` and is bundled by esbuild into `src/renderer/office3d.bundle.js`. `npm start` builds it automatically; run `npm run build` after editing it.

Personalities: 😄 Cheerful, 😒 Grumpy, 🏴‍☠️ Pirate, 🧘 Zen, 🎭 Dramatic. They change both the canned reactions and the tone of Claude's answers (through `--append-system-prompt`).

### Themes

Every window (chat, word card, My words, notebook, Workshop) comes in two looks, each light or dark:

- **🛰️ Future tech**: a calm sci-fi console. Rounded glass panels with a thin glowing line along the top, pill buttons and tabs, a soft cyan glow, slim glowing progress bars, and a shimmer when a dream appears.
- **📜 Vintage notebook**: paper and navy ink. Square corners, typewriter labels, ink-stamp buttons, washi tape on the word card, examples on ruled lines in an italic serif, My words as index cards, and the notebook as a ruled page with a red margin.

Pick one in **⚙️ Settings → 🎨 Theme** (in the tray menu, or a robot's right-click menu), or in the Workshop (**Settings → Look and sound**). Light or dark follows Windows unless you choose *Always light* or *Always dark*. It changes every open window at once. The robot's paint colour tints the accent (in Vintage, as an aged, sepia-toned shade of it).

The tokens (colours, fonts, corners) are in `src/renderer/ui/theme.css`, and each theme's touches are in `ui/future.css` and `ui/vintage.css`. `ui/theme.js` puts `data-theme` and `data-mode` on each window before it draws.

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
