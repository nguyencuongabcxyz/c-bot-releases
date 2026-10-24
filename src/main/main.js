const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, clipboard, dialog, globalShortcut, nativeImage, powerMonitor, protocol, screen, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, titleFor } = require('./store');
const { ClaudeSession, findClaude, describeTool } = require('./claude');
const { locateClaude, checkClaude } = require('./findClaude');
const { launchTerminal, TranscriptMirror } = require('./terminal');
const { listSessions, readSession } = require('./sessions');
const { PERSONALITIES, systemPromptFor, publicPersonalities } = require('./personalities');
const { trayIcon } = require('./trayIcon');
const { startUpdates, checkForUpdates, restartToUpdate, updateState } = require('./updater');
const { keepOnTop } = require('./topmost');
const { createWalkers } = require('./walker');
const { searchFiles, mentionedPaths } = require('./files');
const mcpApps = require('./mcpApps');
const capture = require('./capture');
const { Vocab, lookup, readPicture, HOUR, MIN } = require('./vocab');
const { createSnipper } = require('./snip');
const { createReminders, acceptsNotifications } = require('./reminders');
const { createSocial } = require('./social');
const { createPlanes } = require('./plane');
const { createRobotLink, TOOLS: LINK_TOOLS } = require('./robotLink');
const { createWordCard } = require('./wordCard');
const { Notes, createNoteReminders, NOTE_DEFAULTS } = require('./notes');
const { createNotebook } = require('./notebook');
const { createQuickWindow } = require('./quickWindow');
const { createPalette } = require('./palette');
const { createDrone } = require('./drone');

// MCP tool views (e.g. an Excalidraw drawing) are served on their own origin, sandboxed in the chat
// and local pictures (an SVG Claude made, a chart it saved) are shown through cbot-file:
const localFiles = require('./localFiles');
protocol.registerSchemesAsPrivileged([
  { scheme: 'cbot-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'cbot-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Robot window sizes (DIP). Asleep the window hugs the robot; awake it grows
// to make room for the speech-bubble chat panel.
const ROBOT = { w: 300, h: 290 };
// each robot can be smaller or bigger (the Workshop's "Size")
const SIZES = { small: 0.7, normal: 1, large: 1.35, huge: 1.7 };
const robotDims = (size) => {
  const k = SIZES[size] || 1;
  return { w: Math.round(ROBOT.w * k), h: Math.round(ROBOT.h * k) };
};
// Awake: the chat panel sits beside the robot, the full height of the screen.
// You can drag its outer edge to make it wider or narrower (remembered per robot).
const CHAT = { w: 520, min: 360 };
// Awake with the chat tucked away: a strip above the robot (below it, at the top of
// the screen) for the status bubble and its speech bubble, so neither covers the desk.
const TUCK = { strip: 116, minW: 300 };

const PERMISSION_MODES = {
  default: 'Look, don\'t touch (read-only)',
  acceptEdits: 'Helpful hands (can edit files)',
  bypassPermissions: 'Unleashed (can do anything)',
  plan: 'Planner (plans only)',
};

let store;
let tray;
let managerWin = null;
let walkers = null; // robots out for a walk round the screen (walker.js)
let vocab = null; // your English words (vocab.js)
let wordCard = null; // the card showing a word you just caught (wordCard.js)
let notes = null; // your notes (notes.js)
let notebook = null; // the window they're in (notebook.js)
let noteReminders = null; // the start- and end-of-day reminders about them
let quickWin = null; // quick actions on selected text (quickWindow.js)
let social = null; // the robots noticing each other: waves, claps, visits (social.js)
let planes = null; // the paper planes they throw at each other (plane.js)
let robotLink = null; // robots asking each other from the chat (robotLink.js)
let reminders = null; // when a robot quizzes you on a word (reminders.js)
let snipper = null; // drag a box round a word you can't select (snip.js)
let palette = null; // the one-hotkey menu of everything (palette.js)
let drone = null; // the robot's drone, which flies the menu over to you (drone.js)
let droneOut = false; // it's out, hovering over the menu
let snipFor = null; // { kind: 'word' | 'ask', robotId, source } while you're dragging that box
const robots = new Map(); // id -> { win, expanded, anchor, drag, chatW, resize }
const sessions = new Map(); // "robotId|tabId" -> ClaudeSession
const terminals = new Map(); // id -> { child, mirror } while the robot's conversation is open in a terminal

// a second launch just opens the Workshop of the running C-Bot, then quits
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => openManager());
}

const preload = path.join(__dirname, '..', 'preload', 'preload.js');

// ---------------------------------------------------------------- robots

function defaultAnchor(index) {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - ROBOT.w - 30 - index * (ROBOT.w + 10),
    y: wa.y + wa.height - ROBOT.h - 10,
  };
}

function clampAnchor(anchor, dims = ROBOT) {
  const display = screen.getDisplayNearestPoint({ x: anchor.x + dims.w / 2, y: anchor.y + dims.h / 2 });
  const wa = display.workArea;
  return {
    x: Math.round(Math.min(Math.max(anchor.x, wa.x), wa.x + wa.width - dims.w)),
    y: Math.round(Math.min(Math.max(anchor.y, wa.y), wa.y + wa.height - dims.h)),
  };
}

// The chat goes on whichever side of the robot has room for it (left first:
// robots start in the bottom-right corner), from the top of the screen to the bottom.
function layoutFor(anchor, expanded, chatW = CHAT.w, dims = ROBOT, tucked = false) {
  if (!expanded && tucked) {
    const wa = screen.getDisplayNearestPoint({ x: anchor.x + dims.w / 2, y: anchor.y + dims.h / 2 }).workArea;
    const width = Math.max(dims.w, TUCK.minW);
    const x = Math.round(Math.min(Math.max(anchor.x + dims.w / 2 - width / 2, wa.x), wa.x + wa.width - width));
    const above = anchor.y - TUCK.strip >= wa.y;
    const y = above ? anchor.y - TUCK.strip : anchor.y;
    return { bounds: { x, y, width, height: dims.h + TUCK.strip }, robotX: anchor.x - x, robotY: anchor.y - y, placement: above ? 'tuck-above' : 'tuck-below' };
  }
  if (!expanded) {
    return { bounds: { x: anchor.x, y: anchor.y, width: dims.w, height: dims.h }, robotX: 0, robotY: 0, placement: 'none' };
  }
  const wa = screen.getDisplayNearestPoint({ x: anchor.x + dims.w / 2, y: anchor.y + dims.h / 2 }).workArea;
  const roomLeft = anchor.x - wa.x;
  const roomRight = wa.x + wa.width - (anchor.x + dims.w);
  const want = Math.max(CHAT.min, chatW);
  const placement = roomLeft >= want || roomLeft >= roomRight ? 'left' : 'right';
  const room = placement === 'left' ? roomLeft : roomRight;
  const panelW = Math.round(Math.max(Math.min(want, room), Math.min(CHAT.min, wa.width - dims.w)));
  let x = placement === 'left' ? anchor.x - panelW : anchor.x;
  x = Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - panelW - dims.w));
  const width = panelW + dims.w;
  const robotX = anchor.x - x;
  return {
    bounds: { x, y: wa.y, width, height: wa.height },
    robotX,
    robotY: anchor.y - wa.y,
    placement,
    // where the panel goes inside the window (its shadow and tail need a few px)
    panel: placement === 'left' ? { x: 8, w: Math.max(200, robotX - 14) } : { x: robotX + dims.w + 6, w: Math.max(200, width - robotX - dims.w - 14) },
    maxChatW: Math.max(CHAT.min, room),
  };
}

function applyLayout(id) {
  const r = robots.get(id);
  if (!r || r.win.isDestroyed()) return;
  const layout = layoutFor(r.anchor, r.expanded, r.chatW, r.dims, r.tucked);
  r.layout = layout;
  r.win.webContents.send('robot:layout', { expanded: r.expanded, ...layout });
  r.win.setBounds(layout.bounds);
}

// Save everything at once (the store normally waits a moment to batch changes).
function saveNow() {
  try {
    store?.flush();
  } catch (err) {
    console.error('[store] save failed:', err);
  }
}

// "Start with Windows": C-Bot comes back with your robots after a restart.
// From a source checkout it's electron.exe plus this app's folder.
function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const openAtLogin = store.settings.startAtLogin !== false;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  app.setLoginItemSettings({ openAtLogin, path: process.execPath, args, name: 'C-Bot' });
}

function createRobotWindow(character, index = 0) {
  if (robots.has(character.id)) return robots.get(character.id).win;
  const dims = robotDims(character.size);
  const anchor = clampAnchor(character.position || defaultAnchor(index), dims);
  const win = new BrowserWindow({
    x: anchor.x,
    y: anchor.y,
    width: dims.w,
    height: dims.h,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: character.name,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'robot', 'index.html'), { query: { id: character.id } });
  guardNavigation(win);
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    robots.delete(character.id);
    walkers?.close(character.id);
  });
  // Windows shutting down / signing out doesn't send before-quit: save right now
  win.on('query-session-end', saveNow);
  win.on('session-end', saveNow);
  robots.set(character.id, { win, expanded: false, anchor, dims, drag: null, chatW: character.chatWidth || CHAT.w });
  return win;
}

// Links in answers open in the real browser; the app windows never navigate.
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showRobot(id) {
  const c = store.get(id);
  if (!c) return;
  store.update(id, { visible: true });
  const r = robots.get(id);
  if (r) r.win.showInactive();
  else createRobotWindow(c, store.list().indexOf(c));
  refreshTray();
  notifyManager();
}

function hideRobot(id) {
  store.update(id, { visible: false });
  const r = robots.get(id);
  if (r) r.win.close();
  refreshTray();
  notifyManager();
}

function sendToRobot(id, channel, payload) {
  const r = robots.get(id);
  if (r && !r.win.isDestroyed()) r.win.webContents.send(channel, payload);
  if (channel === 'robot:character') walkers?.character(id, walkerLook(payload));
}

// what a walker needs to look like its robot
function walkerLook(c) {
  return c && { name: c.name, color: c.color, body: c.body, kit: c.kit, accessory: c.accessory, theme: c.theme, size: c.size };
}

// Eyes follow the mouse: poll the global cursor and tell each robot where it is
// relative to its own face.
function startCursorTracking() {
  let last = '';
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    walkers?.hover(p); // (every tick: a walker can walk under a still mouse)
    const key = `${p.x},${p.y}`;
    if (key === last) return;
    last = key;
    for (const r of robots.values()) {
      if (r.win.isDestroyed() || !r.win.isVisible()) continue;
      // relative to the robot box; the renderer knows where the 3D head is
      r.win.webContents.send('robot:cursor', { x: p.x - r.anchor.x, y: p.y - r.anchor.y });
    }
    walkers?.cursor(p);
  }, 66);
}

// ---------------------------------------------------------------- fed files

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function inspectPath(p, { thumb = false } = {}) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  try {
    const st = fs.statSync(p);
    const entry = { path: p, name: path.basename(p) || p, isDir: st.isDirectory(), size: st.size, isImage: IMAGE_EXT.test(p) };
    if (thumb && entry.isImage && st.size < 40 * 1024 * 1024) entry.thumb = thumbnail(nativeImage.createFromPath(p));
    return entry;
  } catch {
    return null;
  }
}

// a small preview for the file chips (a data: URL, so the sandboxed page can show it)
function thumbnail(img) {
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  return img.resize(height > width ? { height: 64 } : { width: 96, quality: 'good' }).toDataURL();
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Pasted screenshots have no file yet; keep them next to the app's data,
// named like "Screenshot 2026-10-22 22.11.48.png" (local time).
function savePaste(bytes, ext) {
  const dir = path.join(app.getPath('userData'), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const safeExt = /^(png|jpe?g|gif|webp)$/i.test(ext) ? ext.toLowerCase() : 'png';
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
  let file = path.join(dir, `Screenshot ${stamp}.${safeExt}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `Screenshot ${stamp} (${n}).${safeExt}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return inspectPath(file, { thumb: true });
}

// What's on the clipboard, as attachments: a copied image or screenshot, or
// (on Windows) a file copied in Explorer.
function clipboardEntries() {
  const img = clipboard.readImage();
  if (!img.isEmpty()) return [savePaste(img.toPNG(), 'png')].filter(Boolean);
  if (process.platform === 'win32') {
    const p = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0[\s\S]*$/, '');
    if (p) return [inspectPath(p, { thumb: true })].filter(Boolean);
  }
  return [];
}
const clipboardHasSomething = () =>
  !clipboard.readImage().isEmpty() || (process.platform === 'win32' && clipboard.readBuffer('FileNameW').length > 0);

// ---------------------------------------------------------------- claude

// Each robot has tabs; each tab is its own Claude Code conversation, kept open
// as one live `claude` process (a ClaudeSession) so it can be interrupted,
// take questions typed ahead, and switch model or effort mid-chat.
const runKey = (id, tabId) => `${id}|${tabId}`;
const isBusy = (key) => !!sessions.get(key)?.busy;
const robotBusy = (id) => [...sessions.entries()].some(([k, s]) => k.startsWith(`${id}|`) && s.busy);
const tell = (id, tabId, payload) => sendToRobot(id, 'robot:event', { tabId, ...payload });
const IDLE_CLOSE_MS = 15 * 60 * 1000; // an idle conversation's process is closed; it resumes on the next question
let modelChoices = []; // learned from Claude Code: [{ value, displayName, description, efforts }]

function closeSession(key) {
  sessions.get(key)?.close();
  sessions.delete(key);
}

function closeRobotSessions(id) {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${id}|`)) closeSession(key);
}

// Its personality, and the other robots it can ask (robotLink.js)
const promptFor = (c) => [systemPromptFor(c), robotLink?.note(c.id)].filter(Boolean).join('\n');

// The tab's live Claude Code process (started on its first question).
function sessionFor(id, tabId) {
  const key = runKey(id, tabId);
  if (sessions.has(key)) return sessions.get(key);
  const c = store.get(id);
  const tab = store.tab(id, tabId);
  const toolset = store.settings.toolset;
  const session = new ClaudeSession({
    claudePath: findClaude(store.settings.claudePath),
    cwd: c.folder,
    sessionId: tab.sessionId,
    systemPrompt: promptFor(c),
    permissionMode: c.permissionMode,
    model: tab.model ?? c.model ?? '', // '' = Claude Code's default; a tab's choice beats the robot's
    effort: tab.effort || '',
    tools: toolset?.tools || null,
    // the other robots, to ask (robotLink.js): its tools, usable without asking, and time to wait for an answer
    mcpConfig: robotLink?.mcpConfigFile(id) || '',
    allowedTools: robotLink ? LINK_TOOLS : [],
    env: { MCP_TOOL_TIMEOUT: String(11 * 60_000) },
  });
  sessions.set(key, session);
  const turns = new Map(); // turnId -> { prompt, kind, retried }
  session.turns = turns;

  session.on('turn-start', (turnId) => tell(id, tabId, { type: 'turn-start', turnId, kind: turns.get(turnId)?.kind }));
  session.on('session', (sessionId) => {
    store.updateTab(id, tabId, { sessionId });
    store.rememberSession(id, sessionId);
  });
  session.on('initialized', (info) => {
    const models = (info.models || []).filter((m) => !/^claude-/.test(m.value));
    if (models.length) modelChoices = models.map((m) => ({ value: m.value === 'default' ? '' : m.value, displayName: m.displayName, description: m.description, efforts: m.supportedEffortLevels || [] }));
  });
  session.on('tools', ({ version, tools, chosen }) => {
    // learn Claude Code's default tools once (per version), so later sessions can add the task tools to them
    const cached = store.settings.toolset;
    if (!chosen) {
      const learned = { version, tools: tools.filter((t) => !t.startsWith('mcp__')) };
      store.updateSettings({ toolset: learned });
      // this conversation started without the task tools: pick them up from its next question
      session.opts.tools = learned.tools;
      session.restartBeforeNext = true;
    } else if (cached && cached.version !== version) store.updateSettings({ toolset: null });
  });
  session.on('commands', (commands) => {
    // keep descriptions we already know when init only gives us names
    const known = new Map((store.get(id)?.claudeCommands || []).map((cmd) => [cmd.name, cmd.description]));
    const merged = commands.map((cmd) => ({ name: cmd.name, description: cmd.description || known.get(cmd.name) || '' })).slice(0, 200);
    store.update(id, { claudeCommands: merged });
  });
  session.on('text', (delta) => tell(id, tabId, { type: 'text', delta }));
  session.on('aside', (text) => tell(id, tabId, { type: 'aside', text }));
  session.on('question', (q) => tell(id, tabId, { type: 'question', ...q }));
  session.on('thinking', () => tell(id, tabId, { type: 'thinking' }));
  session.on('tool', ({ input, ...tool }) => {
    tell(id, tabId, { type: 'tool', ...tool });
    if (!input) return;
    // an MCP tool: if it comes with its own view (an MCP App), show it in the chat
    const call = { name: tool.name, input };
    (session.mcpCalls ||= new Map()).set(tool.id, call);
    mcpApps.appFor(tool.name, store.get(id)?.folder).then((view) => {
      call.noView = !view;
      if (!view) return;
      call.view = view;
      if (session.mcpCalls.get(tool.id) === call) tell(id, tabId, { type: 'app', id: tool.id, ...view, input, result: call.result });
    });
  });
  session.on('tool-result', ({ id: callId, result }) => {
    const call = session.mcpCalls?.get(callId);
    if (!call) return;
    call.result = result;
    if (call.view) tell(id, tabId, { type: 'app-result', id: callId, result });
    // pictures the tool returned (a screenshot, a rendered chart): shown in the answer
    const images = (result.content || []).filter((c) => c.type === 'image' && /^image\/[\w.+-]+$/.test(c.mimeType || '') && typeof c.data === 'string');
    if (!images.length) return;
    const pics = images.slice(0, 6).map((c) => ({ mimeType: c.mimeType, data: c.data }));
    tell(id, tabId, { type: 'tool-images', id: callId, images: pics });
    // kept with the answer while they're small, so the store file stays light
    const kept = (session.turnImages ||= []);
    for (const pic of pics) if (kept.reduce((n, k) => n + k.data.length, 0) + pic.data.length < 800000) kept.push(pic);
  });
  // files it changed: shown as diffs now, and kept (trimmed) with the answer in history
  session.on('edit', (diff) => {
    tell(id, tabId, { type: 'edit', ...diff });
    const kept = (session.turnEdits ||= []);
    if (kept.length < 20) kept.push({ ...diff, hunks: trimHunks(diff.hunks, 120), truncated: diff.truncated || countLines(diff.hunks) > 120 });
  });
  session.on('agent', (ev) => {
    // a background helper's full report sits in a file; short ones are already in the summary
    if (ev.op === 'done' && ev.outputFile) {
      try {
        const report = fs.readFileSync(ev.outputFile, 'utf8').trim();
        if (report && report.length > (ev.summary || '').length) ev.report = report.slice(-20000);
      } catch {}
      delete ev.outputFile;
    }
    tell(id, tabId, { type: 'agent', ...ev });
  });
  session.on('status', (text) => tell(id, tabId, { type: 'status', text }));
  session.on('task', (ev) => {
    const t = store.tab(id, tabId);
    if (!t) return;
    let tasks = [...(t.tasks || [])];
    if (ev.op === 'replace') tasks = ev.tasks;
    else if (ev.op === 'create') tasks = [...tasks.filter((x) => x.id !== ev.id), { id: ev.id, subject: ev.subject, activeForm: ev.activeForm, status: 'pending' }];
    else tasks = tasks.map((x) => (x.id === ev.id ? { ...x, ...Object.fromEntries(Object.entries(ev).filter(([k, v]) => v && k !== 'op')) } : x));
    store.updateTab(id, tabId, { tasks: tasks.filter((x) => x.status !== 'deleted') });
    tell(id, tabId, { type: 'tasks', tasks: store.tab(id, tabId).tasks, change: ev });
  });
  session.on('compact', (ev) => {
    session.lastCompact = ev;
    tell(id, tabId, { type: 'compact', ...ev });
  });
  session.on('done', (result) => {
    const turn = turns.get(result.turnId) || {};
    turns.delete(result.turnId);
    const edits = session.turnEdits?.length ? session.turnEdits : undefined;
    session.turnEdits = [];
    const apps = takeApps(session);
    const images = takeImages(session);
    const cur = store.get(id);
    if (!cur) return;
    if (turn.kind === 'compact') {
      const ev = session.lastCompact || {};
      store.pushHistory(id, tabId, { role: 'note', text: ev.pre ? `🗜️ Compacted my memory: ${Math.round(ev.pre / 1000)}k → ${Math.round(ev.post / 1000)}k tokens` : '🗜️ Compacted my memory' });
    } else {
      store.pushHistory(id, tabId, { role: 'assistant', text: result.text, asides: result.asides, isError: result.isError, denials: result.denials, interrupted: result.interrupted, edits, apps, images });
    }
    if (result.sessionId) store.updateTab(id, tabId, { sessionId: result.sessionId });
    store.update(id, { stats: { ...cur.stats, costUsd: (cur.stats?.costUsd || 0) + result.costUsd } });
    tell(id, tabId, { type: 'done', ...result, kind: turn.kind });
    refreshContext(id, tabId);
  });
  session.on('fail', (err) => {
    const turn = turns.get(err.turnId) || {};
    if (err.sessionMissing && session.sessionId && !turn.retried) {
      // The old conversation is gone (e.g. folder moved) — quietly start fresh.
      session.sessionId = null;
      store.updateTab(id, tabId, { sessionId: null });
      turn.retried = true;
      session.ask(turn.prompt, err.turnId);
      return;
    }
    turns.delete(err.turnId);
    const edits = session.turnEdits?.length ? session.turnEdits : undefined;
    session.turnEdits = [];
    const apps = takeApps(session);
    const images = takeImages(session);
    if (!err.cancelled) store.pushHistory(id, tabId, { role: 'assistant', text: err.message, isError: true, edits, apps, images });
    tell(id, tabId, { type: 'fail', ...err });
  });
  return session;
}

// The finished turn's MCP tool calls that have (or may have) a view, kept with the
// answer so the chat can show the view again. Their pages are fetched when shown.
function takeApps(session) {
  const calls = [...(session.mcpCalls?.entries() || [])];
  session.mcpCalls = new Map();
  const kept = calls
    .filter(([, c]) => !c.noView)
    .map(([callId, c]) => ({ id: callId, name: c.name, input: c.input, result: c.result }))
    .filter((a) => JSON.stringify(a).length < 300000)
    .slice(0, 10);
  return kept.length ? kept : undefined;
}

// Pictures MCP tools returned this turn (already capped when they arrived).
function takeImages(session) {
  const kept = session.turnImages || [];
  session.turnImages = [];
  return kept.length ? kept : undefined;
}

// Diffs kept in history are cut down so the store file stays small.
const countLines = (hunks = []) => hunks.reduce((n, h) => n + h.lines.length, 0);
function trimHunks(hunks = [], max) {
  const out = [];
  for (const h of hunks) {
    if (max <= 0) break;
    out.push({ ...h, lines: h.lines.slice(0, max) });
    max -= h.lines.length;
  }
  return out;
}

// How full the tab's context is ("brain battery"), after each answer.
async function refreshContext(id, tabId) {
  const session = sessions.get(runKey(id, tabId));
  try {
    const u = await session?.contextUsage();
    if (!u) return store.tab(id, tabId)?.context || null;
    const context = { percentage: u.percentage, totalTokens: u.totalTokens, maxTokens: u.maxTokens, autoCompactAt: u.autoCompactThreshold, autoCompact: u.isAutoCompactEnabled };
    store.updateTab(id, tabId, { context });
    tell(id, tabId, { type: 'context', context });
    return context;
  } catch {
    return store.tab(id, tabId)?.context || null;
  }
}

function ask(id, tabId, prompt, { attachments = [], turnId = crypto.randomUUID(), kind = 'chat' } = {}) {
  const c = store.get(id);
  const tab = store.tab(id, tabId);
  if (!c || !tab) return { ok: false, error: 'That conversation is gone.' };
  if (terminals.get(id)?.tabId === tabId) return { ok: false, error: "This conversation is open in the terminal. Carry on there, or close it to chat here." };

  const claudePath = findClaude(store.settings.claudePath);
  if (!claudePath) {
    return { ok: false, error: "I can't find Claude Code anywhere on this computer. Install it, then press “Search again” in the Robot Workshop (bottom left), or point me to it there." };
  }
  if (!c.folder || !fs.existsSync(c.folder)) {
    return { ok: false, error: `My folder is missing: ${c.folder || '(none)'}. Point me at a new one in the Robot Workshop.` };
  }

  // Files fed to the robot: name them in the prompt and let Claude Code read their folders.
  const files = attachments.map(inspectPath).filter(Boolean).slice(0, 20);
  let fullPrompt = prompt;
  if (files.length) {
    fullPrompt += `\n\n[The user dropped ${files.length === 1 ? 'this' : 'these'} onto you. Read ${files.length === 1 ? 'it' : 'them'} as needed:]\n`;
    fullPrompt += files.map((f) => `- ${f.path}${f.isDir ? ' (folder)' : ''}`).join('\n');
  }
  // files mentioned with @ in the message: spell out exactly which ones
  const dropped = new Set(files.map((f) => path.normalize(f.path)));
  const mentioned = mentionedPaths(c.folder, prompt).filter((p) => !dropped.has(p)).map((p) => inspectPath(p)).filter(Boolean);
  if (mentioned.length) {
    fullPrompt += `\n\n[Files the user mentioned with @. Read ${mentioned.length === 1 ? 'it' : 'them'} as needed:]\n`;
    fullPrompt += mentioned.map((f) => `- ${f.path}${f.isDir ? ' (folder)' : ''}`).join('\n');
  }
  const addDirs = [...new Set([...files, ...mentioned].map((f) => (f.isDir ? f.path : path.dirname(f.path))))].filter((d) => !isInside(d, c.folder));

  if (kind === 'bonk') store.pushHistory(id, tabId, { role: 'note', text: '🔨 Bonked! Starting over, quicker.' });
  if (kind === 'chat') {
    store.pushHistory(id, tabId, { role: 'user', text: prompt, files: files.map((f) => ({ name: f.name, isDir: f.isDir, isImage: f.isImage })) });
    store.update(id, { stats: { ...c.stats, questions: (c.stats?.questions || 0) + 1 } });
  }

  const session = sessionFor(id, tabId);
  session.setSystemPrompt(promptFor(c)); // personality changes (and who else is out) apply from the next question
  session.allowDirs(addDirs);
  session.turns.set(turnId, { prompt: fullPrompt, kind });
  const { queued } = session.ask(fullPrompt, turnId);
  return { ok: true, turnId, queued };
}

// Close conversations nobody has used for a while; they resume on the next question.
setInterval(() => {
  for (const [key, s] of sessions) if (!s.busy && !s.helpersRunning && s.alive && Date.now() - s.lastUsed > IDLE_CLOSE_MS) closeSession(key);
}, 60 * 1000);

// ---------------------------------------------------------------- terminal mode

// Open one tab's conversation in real, full Claude Code in a terminal window.
// While it's open the robot acts out what Claude does there.
function openTerminal(id, tabId) {
  const c = store.get(id);
  const tab = store.tab(id, tabId);
  if (!c || !tab) return { ok: false, error: 'Unknown conversation' };
  const open = terminals.get(id);
  if (open) return open.tabId === tabId ? { ok: true, already: true } : { ok: false, error: 'Another tab already has the terminal open. Close it first.' };
  if (isBusy(runKey(id, tabId))) return { ok: false, error: "I'm still answering here. Stop me first, then we can move to the terminal." };
  closeSession(runKey(id, tabId)); // the terminal takes over this conversation
  const claudePath = findClaude(store.settings.claudePath);
  if (!claudePath) return { ok: false, error: "I can't find the `claude` command." };
  if (!c.folder || !fs.existsSync(c.folder)) return { ok: false, error: `My folder is missing: ${c.folder || '(none)'}.` };

  const child = launchTerminal({ claudePath, folder: c.folder, sessionId: tab.sessionId, model: c.model, permissionMode: c.permissionMode, title: `C-Bot - ${c.name}` });
  const mirror = new TranscriptMirror({ folder: c.folder, sessionId: tab.sessionId }).start();
  const say = (kind, extra = {}) => tell(id, tabId, { type: 'mirror', kind, ...extra });
  mirror.on('session', (sessionId) => {
    store.updateTab(id, tabId, { sessionId });
    store.rememberSession(id, sessionId);
  });
  mirror.on('prompt', () => say('prompt'));
  mirror.on('tool', ({ name, input }) => say('tool', { name, detail: describeTool(name, input) }));
  mirror.on('question', () => say('question'));
  mirror.on('text', () => say('text'));
  mirror.on('idle', () => say('idle'));

  const entry = { child, mirror, tabId };
  terminals.set(id, entry);
  if (child) {
    child.on('exit', () => closeTerminal(id));
  } else {
    // macOS/Linux terminals don't report back; stop watching after a quiet while
    entry.timeout = setTimeout(() => closeTerminal(id), 2 * 60 * 60 * 1000);
  }
  tell(id, tabId, { type: 'terminal', state: 'opened' });
  notifyManager();
  return { ok: true };
}

// The terminal closed: pick the conversation back up so the tab shows what happened there.
function closeTerminal(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  terminals.delete(id);
  entry.mirror.stop();
  clearTimeout(entry.timeout);
  const c = store.get(id);
  const tab = store.tab(id, entry.tabId);
  if (!c || !tab) return;
  const session = tab.sessionId && readSession(c.folder, tab.sessionId, { limit: 60 });
  if (session) store.updateTab(id, entry.tabId, { history: session.messages.map((m) => ({ ...m, at: Date.parse(m.at) || Date.now() })) });
  sendToRobot(id, 'robot:character', robotView(store.get(id)));
  tell(id, entry.tabId, { type: 'terminal', state: 'closed' });
  notifyManager();
}

// Open an earlier conversation: in its tab if one already has it, in the
// current tab if that's empty, otherwise in a new tab.
function resumeConversation(id, tabId, sessionId) {
  const c = store.get(id);
  if (!c) return { ok: false, error: 'Unknown robot' };
  const owner = c.tabs.find((t) => t.sessionId === sessionId);
  if (owner) {
    store.update(id, { activeTab: owner.id });
    return { ok: true, tabId: owner.id, already: true };
  }
  const session = readSession(c.folder, sessionId, { limit: 60 });
  if (!session) return { ok: false, error: "I couldn't find that conversation any more." };
  const history = session.messages.map((m) => ({ ...m, at: Date.parse(m.at) || Date.now() }));
  const here = store.tab(id, tabId);
  const reuse = here && !here.sessionId && !here.history.length && !isBusy(runKey(id, tabId));
  let target;
  if (reuse) {
    target = store.updateTab(id, tabId, { sessionId, history, title: session.title });
    store.update(id, { activeTab: tabId });
  } else {
    target = store.addTab(id, { sessionId, history, title: session.title });
    if (!target) return { ok: false, error: 'Too many tabs open. Close one first.' };
  }
  store.rememberSession(id, sessionId);
  sendToRobot(id, 'robot:character', robotView(store.get(id)));
  notifyManager();
  return { ok: true, tabId: target.id, title: session.title, total: session.total };
}

// Clear one tab (or, from the Workshop, every tab) back to a fresh conversation.
function resetConversation(id, tabId) {
  const c = store.get(id);
  if (!c) return;
  if (terminals.get(id)?.tabId === tabId) return;
  const tabs = tabId ? c.tabs.filter((t) => t.id === tabId) : c.tabs;
  for (const t of tabs) {
    closeSession(runKey(id, t.id));
    store.updateTab(id, t.id, { sessionId: null, history: [], title: '', tasks: [], context: null });
  }
  if (!tabId) {
    // the Workshop's "forget": back to a single empty tab
    for (const t of c.tabs.slice(1)) if (terminals.get(id)?.tabId !== t.id) store.removeTab(id, t.id);
  }
  sendToRobot(id, 'robot:character', robotView(store.get(id)));
}

function newTab(id) {
  const tab = store.addTab(id);
  if (!tab) return { ok: false, error: `That's the most tabs I can juggle!` };
  sendToRobot(id, 'robot:character', robotView(store.get(id)));
  return { ok: true, tabId: tab.id };
}

function closeTab(id, tabId) {
  if (terminals.get(id)?.tabId === tabId) return { ok: false, error: 'That conversation is open in the terminal. Close the terminal first.' };
  closeSession(runKey(id, tabId));
  store.removeTab(id, tabId);
  sendToRobot(id, 'robot:character', robotView(store.get(id)));
  return { ok: true, activeTab: store.get(id)?.activeTab };
}

function robotView(c) {
  return {
    ...c,
    tabs: c.tabs.map((t) => ({ ...t, title: titleFor(t), custom: !!t.title, busy: isBusy(runKey(c.id, t.id)) })),
    closedTabs: (c.closedTabs || []).map((t) => ({ id: t.id, title: titleFor(t), closedAt: t.closedAt })),
    busy: robotBusy(c.id),
    terminalOpen: terminals.has(c.id),
    terminalTab: terminals.get(c.id)?.tabId || null,
  };
}

// ---------------------------------------------------------------- manager

function openManager(focusId) {
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.show();
    managerWin.focus();
    if (focusId) managerWin.webContents.send('mgr:focus', focusId);
    return;
  }
  managerWin = new BrowserWindow({
    width: 1040,
    height: 620,
    minWidth: 880,
    minHeight: 520,
    title: 'C-Bot · Robot Workshop',
    icon: trayIcon(),
    backgroundColor: '#1b1f2e',
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  managerWin.loadFile(path.join(__dirname, '..', 'renderer', 'manager', 'index.html'), {
    query: focusId ? { focus: focusId } : {},
  });
  guardNavigation(managerWin);
  managerWin.on('closed', () => (managerWin = null));
}

// where Claude Code is, for the Workshop: { claudePath, claudeSource }
function claudeInfo() {
  const found = locateClaude(store.settings.claudePath);
  return { claudePath: found?.path || null, claudeSource: found?.source || '' };
}

function notifyManager() {
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('mgr:changed');
}

// ---------------------------------------------------------------- tray

function refreshTray() {
  if (!tray) return;
  const chars = store.list();
  // a hotkey's line in its feature's menu: what it does, or that another app has it
  const hotkeyLine = (ok, key, what) => ({ label: ok ? `${key} anywhere: ${what}` : `${key} is taken by another app`, enabled: false });
  const openNotes = notes?.open().length || 0;
  const menu = Menu.buildFromTemplate([
    // your robots: on the desktop or put away, and back from a walk
    ...(chars.length
      ? chars.map((c) => ({
          label: `${PERSONALITIES[c.personality]?.emoji || '🤖'}  ${c.name}`,
          type: 'checkbox',
          checked: !!c.visible,
          click: (item) => (item.checked ? showRobot(c.id) : hideRobot(c.id)),
        }))
      : [{ label: 'No robots yet', enabled: false }]),
    ...chars.filter((c) => walkers?.has(c.id)).map((c) => ({ label: `🚶  Call ${c.name} back to the desk`, click: () => walkers.dock(c.id) })),
    { label: '🛠️ Robot Workshop…', click: () => openManager() },
    { label: '➕ New robot…', click: () => openManager('new') },
    { type: 'separator' },
    // the features
    paletteHotkeyOk
      ? { label: `⌨️ All actions… (${paletteHotkey()})`, click: () => openPalette() }
      : { label: `⌨️ All actions… (${paletteHotkey()} is taken by another app)`, click: () => openPalette() },
    { label: `🔍 Ask about part of the screen… (${screenHotkey()})`, click: () => askScreen() },
    {
      label: '✨ Quick actions',
      submenu: [
        { label: `✨ Quick actions on text… (${quickHotkey()})`, click: () => openQuick({ text: clipboard.readText().trim().slice(0, 12000) }) },
        { type: 'separator' },
        { label: 'Fast brain (Haiku)', type: 'radio', checked: (store.settings.quickModel || 'haiku') === 'haiku', click: () => setSettings({ quickModel: 'haiku' }) },
        { label: 'Better writing (Sonnet)', type: 'radio', checked: store.settings.quickModel === 'sonnet', click: () => setSettings({ quickModel: 'sonnet' }) },
        { type: 'separator' },
        hotkeyLine(quickHotkeyOk, quickHotkey(), 'select text, then refine, translate or explain it'),
      ],
    },
    {
      label: `📒 Notes${openNotes ? ` (${openNotes} open)` : ''}`,
      submenu: [
        { label: '📒 Open my notebook…', click: () => openNotebook({ focus: null }) },
        { label: `📝 Take a note… (${noteHotkey()})`, click: () => openNotebook({ focus: 'add' }) },
        { type: 'separator' },
        hotkeyLine(noteHotkeyOk, noteHotkey(), 'take a note (with what you selected)'),
      ],
    },
    {
      label: `📚 English words (${vocab?.count || 0})`,
      submenu: [
        { label: '📚 My words…', click: () => openWords() },
        { label: '🔍 Box a word on screen to save it…', click: () => setTimeout(() => boxWord(), 250) }, // (after the menu has gone)
        { label: '🃏 Quiz me now', enabled: !!vocab?.ready.length, click: () => reminders.quizNow() || dialog.showMessageBox({ message: 'No robot is free to quiz you right now.' }) },
        { type: 'separator' },
        {
          label: '💭 Dream about my words during the day',
          type: 'checkbox',
          checked: store.settings.vocabReminders !== false,
          click: (item) => setSettings({ vocabReminders: item.checked }),
        },
        { type: 'separator' },
        hotkeyLine(vocabHotkeyOk, vocabHotkey(), 'select a word to save it'),
      ],
    },
    { type: 'separator' },
    {
      label: '⚙️ Settings',
      submenu: [
        themeMenu(),
        { label: '🔇 Mute robot sounds', type: 'checkbox', checked: !!store.settings.muted, click: (item) => setSettings({ muted: item.checked }) },
        {
          label: '🤝 Robots socialising',
          submenu: [
            { label: 'Often', type: 'radio', checked: store.settings.socialising === 'often', click: () => setSettings({ socialising: 'often' }) },
            { label: 'Sometimes', type: 'radio', checked: !store.settings.socialising || store.settings.socialising === 'sometimes', click: () => setSettings({ socialising: 'sometimes' }) },
            { label: 'Never', type: 'radio', checked: store.settings.socialising === 'never', click: () => setSettings({ socialising: 'never' }) },
          ],
        },
        { label: '🛸 A drone brings the action menu', type: 'checkbox', checked: store.settings.paletteDrone !== false, click: (item) => setSettings({ paletteDrone: item.checked }) },
        {
          label: '🚀 Start with Windows',
          type: 'checkbox',
          checked: store.settings.startAtLogin !== false,
          click: (item) => {
            setSettings({ startAtLogin: item.checked });
            applyLoginItem();
          },
        },
        { type: 'separator' },
        { label: '🗄️ Open backups folder', click: () => shell.openPath(store.backupDir) },
      ],
    },
    { type: 'separator' },
    // the installed app updates itself from GitHub Releases (see updater.js)
    ...(updateState.ready
      ? [{ label: `⬆️ Restart to update (v${updateState.ready})`, click: () => restartToUpdate() }]
      : [{
          label: `C-Bot ${app.getVersion()}${updateState.checking ? ' — checking…' : updateState.last ? ` — ${updateState.last}` : ''}`,
          enabled: app.isPackaged && !updateState.checking,
          click: () => checkForUpdates(),
          toolTip: 'Check for updates',
        }]),
    { label: 'Quit C-Bot', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------- theme

// Two looks for every window: Vintage notebook and Future tech, each light or dark (or
// following Windows). ui/theme.js reads the pick when a window opens and follows changes.
const THEMES = { vintage: '📜  Vintage notebook', future: '🛰️  Future tech' };
const THEME_MODES = { auto: 'Follow Windows light / dark', light: 'Always light', dark: 'Always dark' };
function themeOf() {
  const { theme, themeMode } = store.settings;
  return { theme: theme in THEMES ? theme : 'future', mode: themeMode in THEME_MODES ? themeMode : 'auto' };
}
ipcMain.on('theme:get', (event) => {
  event.returnValue = themeOf();
});
function themeMenu() {
  const now = themeOf();
  return {
    label: '🎨 Theme',
    submenu: [
      ...Object.entries(THEMES).map(([key, label]) => ({ label, type: 'radio', checked: now.theme === key, click: () => setSettings({ theme: key }) })),
      { type: 'separator' },
      ...Object.entries(THEME_MODES).map(([key, label]) => ({ label, type: 'radio', checked: now.mode === key, click: () => setSettings({ themeMode: key }) })),
    ],
  };
}

function setSettings(patch) {
  const settings = store.updateSettings(patch);
  if ('theme' in patch || 'themeMode' in patch) {
    const pick = themeOf();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme:changed', pick);
  }
  // (the notes' own settings: a new hotkey, which robot's board shows them)
  if (notes && 'noteHotkey' in patch) bindNoteHotkey();
  if (quickWin && 'quickHotkey' in patch) bindQuickHotkey();
  if (snipper && 'screenHotkey' in patch) bindScreenHotkey();
  if (palette && 'paletteHotkey' in patch) bindPaletteHotkey();
  if (vocab && 'vocabHotkey' in patch) bindVocabHotkey();
  if (notes && ('notesBoard' in patch || 'notesRobot' in patch)) notesChanged();
  for (const r of robots.values()) if (!r.win.isDestroyed()) r.win.webContents.send('robot:settings', settings);
  refreshTray();
  notifyManager();
  return settings;
}

// ---------------------------------------------------------------- vocabulary

// English words: select one anywhere and press the hotkey. The robot nearest
// the mouse catches it and looks it up in its dictionary (Claude, the quick
// model) while a word card shows it; then the meanings in Vietnamese and the
// examples fill in, and the card goes in the word box on its desk.
const VOCAB_HOTKEY = 'Ctrl+Alt+W';
const vocabHotkey = () => store.settings.vocabHotkey || VOCAB_HOTKEY;
let vocabHotkeyOk = true;

// the robot at its desk nearest the mouse
function nearestRobot() {
  const p = screen.getCursorScreenPoint();
  let best = null;
  let bestD = Infinity;
  for (const [id, r] of robots) {
    if (r.win.isDestroyed() || !r.win.isVisible() || walkers?.has(id)) continue;
    const b = r.win.getBounds();
    const d = Math.hypot(b.x + b.width / 2 - p.x, b.y + b.height / 2 - p.y);
    if (d < bestD) [best, bestD] = [id, d];
  }
  return best;
}

const tellVocab = (id, payload) => id && sendToRobot(id, 'robot:vocab', payload);
// the words each robot keeps in sight: on sticky notes on its monitor, on its screen
// when it's idle, in its sleep talk (the ones you're still learning first)
const sightWords = () =>
  vocab.inSight(6).map((w) => ({ id: w.id, word: w.word, vi: w.senses?.[0]?.vi || '', phrase: w.phrases?.[0]?.phrase || '', box: w.review?.step || 0 }));
function vocabCountChanged() {
  const words = sightWords();
  for (const id of robots.keys()) {
    tellVocab(id, { phase: 'count', count: vocab.count });
    tellVocab(id, { phase: 'sight', words });
  }
  refreshTray();
  notifyWords();
}

// ---- the quiz (reminders.js decides when; this decides who and shows it)

let quizzing = null; // { wordId, robotId } while a quiz card is up
// a robot free to quiz you: the tutor if it's free, else the free robot nearest the mouse
function freeRobot() {
  const free = (id) => {
    const r = robots.get(id);
    return r && !r.win.isDestroyed() && r.win.isVisible() && !walkers?.has(id) && !robotBusy(id);
  };
  if (free(store.settings.vocabTutor)) return store.settings.vocabTutor;
  const p = screen.getCursorScreenPoint();
  const ids = [...robots.keys()].filter(free);
  const dist = (id) => {
    const b = robots.get(id).win.getBounds();
    return Math.hypot(b.x + b.width / 2 - p.x, b.y + b.height / 2 - p.y);
  };
  return ids.sort((a, b) => dist(a) - dist(b))[0] || null;
}

// a word to quiz you on when you ask for one: a due one, or else one you're still learning
const quizPick = () => vocab.nextDue() || vocab.inSight(4).sort(() => Math.random() - 0.5)[0] || null;

// ---- the dream: a sleeping robot dreams of a word that's due, and a dream bubble beside
// it shows the word, its meaning and an example (reminders.js decides when)

// a robot that's asleep, at its desk or sleepwalking round the screen: the tutor if it is,
// else the one nearest the mouse
function sleepingRobot() {
  const asleep = (id) => {
    const r = robots.get(id);
    if (!r || r.win.isDestroyed() || robotBusy(id)) return false;
    if (walkers?.has(id)) return walkers.isSleepwalking(id);
    return r.win.isVisible() && !r.expanded && !r.tucked;
  };
  if (asleep(store.settings.vocabTutor)) return store.settings.vocabTutor;
  const p = screen.getCursorScreenPoint();
  const dist = (id) => {
    const b = robotRect(id);
    return b ? Math.hypot(b.x + b.width / 2 - p.x, b.y + b.height / 2 - p.y) : Infinity;
  };
  return [...robots.keys()].filter(asleep).sort((a, b) => dist(a) - dist(b))[0] || null;
}

// (asked: you asked for one from a robot's menu: it shows even if that robot is awake)
function startDream(word, robotId = sleepingRobot()) {
  if (!word || !robotId || quizzing) return false;
  const seen = vocab.dreamt(word.id); // shown: it counts as seen, the next time is further off
  if (!seen) return false;
  // sleepwalking: it stops and mumbles it where it is, and the bubble goes there
  if (walkers?.has(robotId)) walkers.dream(robotId, seen.word);
  else tellVocab(robotId, { phase: 'dream', word: seen });
  wordCard.open({ ...seen, dream: true, known: true }, { robotId, paint: store.get(robotId)?.color, near: robotRect(robotId) });
  vocabCountChanged();
  return true;
}

function startQuiz(word, { asked = false, robotId = freeRobot() } = {}) {
  if (!word || !robotId) return false;
  if (quizzing) endQuiz('ignored');
  quizzing = { wordId: word.id, robotId };
  tellVocab(robotId, { phase: 'quiz', word, asked });
  wordCard.open({ ...word, quiz: true }, { robotId, paint: store.get(robotId)?.color, bounds: cardBounds(robotId) });
  return true;
}

// ---- rewards: a celebration when you've learnt 10, 25, 50… words or kept a streak going,
// and the 🎓 graduation cap (an accessory) once you've learnt 10
const LEARNT_MILESTONES = [10, 25, 50, 100, 200, 500, 1000];
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];
function checkMilestones(robotId) {
  const st = vocab.stats();
  const done = store.settings.vocabMilestones || {};
  const learnt = LEARNT_MILESTONES.filter((n) => st.learnt >= n && n > (done.learnt || 0)).pop() || 0;
  const streak = STREAK_MILESTONES.filter((n) => st.streak >= n && n > (done.streak || 0)).pop() || 0;
  if (!learnt && !streak) return;
  const patch = { vocabMilestones: { learnt: learnt || done.learnt || 0, streak: streak || done.streak || 0 } };
  const unlocked = learnt >= 10 && !store.settings.vocabRewards?.gradcap ? 'gradcap' : '';
  if (unlocked) patch.vocabRewards = { ...store.settings.vocabRewards, gradcap: true };
  setSettings(patch);
  tellVocab(robotId, { phase: 'milestone', learnt, streak, unlocked });
  social?.milestone(robotId);
}

// how the quiz ended: 'knew' / 'forgot' / 'later' (put off for a couple of hours) / 'ignored'
function endQuiz(how) {
  if (!quizzing) return null;
  const { wordId, robotId } = quizzing;
  quizzing = null;
  reminders.done();
  const word =
    how === 'knew' || how === 'forgot' ? vocab.answer(wordId, how === 'knew') : vocab.later(wordId, how === 'later' ? 2 * HOUR : 30 * MIN);
  if (word) tellVocab(robotId, { phase: 'answered', how, word, wait: (word.review?.due || 0) - Date.now() });
  vocabCountChanged(); // (what's in sight changes as you learn)
  if (how === 'knew' || how === 'forgot') checkMilestones(robotId);
  return word;
}

// The word card is as big as a chat (the standard width, however wide you've dragged
// this robot's) and goes where its chat would (see layoutFor), from the top of the
// screen to the bottom; with the chat already open there, it takes the robot's other
// side if that has room.
function cardBounds(id) {
  const r = robots.get(id);
  if (!r || r.win.isDestroyed()) return null;
  const { anchor, dims } = r;
  const wa = screen.getDisplayNearestPoint({ x: anchor.x + dims.w / 2, y: anchor.y + dims.h / 2 }).workArea;
  const want = CHAT.w;
  const roomLeft = anchor.x - wa.x;
  const roomRight = wa.x + wa.width - (anchor.x + dims.w);
  let side = roomLeft >= want || roomLeft >= roomRight ? 'left' : 'right';
  if (r.expanded) {
    const other = side === 'left' ? 'right' : 'left';
    if ((other === 'left' ? roomLeft : roomRight) >= CHAT.min) side = other;
  }
  const room = side === 'left' ? roomLeft : roomRight;
  const width = Math.round(Math.min(want, Math.max(room, CHAT.min), wa.width));
  const x = Math.round(Math.min(Math.max(side === 'left' ? anchor.x - width : anchor.x + dims.w, wa.x), wa.x + wa.width - width));
  return { x, y: wa.y, width, height: wa.height };
}

function showCard(word, robotId) {
  if (quizzing) endQuiz('ignored'); // a new word takes over the quiz card
  wordCard.open(word, { robotId, paint: store.get(robotId)?.color, bounds: cardBounds(robotId) });
}

// the hotkey: whatever's selected in the app in front
// drag a box round a word on screen, for this robot (its menu; the hotkey with nothing selected)
function boxWord(robotId = nearestRobot(), source = '') {
  snipFor = { kind: 'word', robotId, source };
  return snipper.start().then(
    () => true,
    (err) => {
      console.warn('[snip]', err.message);
      tellVocab(robotId, { phase: 'unreadable' });
      snipFor = null;
      return false;
    },
  );
}

async function captureWord() {
  const { text, source } = await capture.readSelection({ hotkeyKey: capture.keyCode(vocabHotkey()) });
  if (text) return catchWord(text, { source, robotId: nearestRobot() });
  // nothing selected (a word in a picture, a video…): drag a box round it instead
  boxWord(nearestRobot(), source);
}

// the box you dragged: Claude reads the word in it (and its sentence), then it's caught as usual
async function readBoxed(image) {
  const { robotId, source } = snipFor || { robotId: nearestRobot(), source: '' };
  snipFor = null;
  tellVocab(robotId, { phase: 'reading' });
  try {
    const found = await readPicture(image.toPNG(), { claudePath: store.settings.claudePath });
    if (!found.text) return tellVocab(robotId, { phase: 'unreadable' });
    catchWord(found.text, { source, robotId, context: found.sentence });
  } catch (err) {
    console.warn('[snip] reading failed:', err.message);
    tellVocab(robotId, { phase: 'unreadable' });
  }
}

// trims quotes and punctuation round a selection ("meticulous," -> meticulous)
const EDGES = /^[\s"'“”‘’([{]+|[\s"'“”‘’)\]}.,;:!?]+$/g;

function catchWord(raw, { source = '', robotId = nearestRobot(), context = '' } = {}) {
  const text = String(raw || '').replace(EDGES, '').trim();
  if (!text) return tellVocab(robotId, { phase: 'empty', hotkey: vocabHotkey() });
  if (text.length > 60 || text.split(/\s+/).length > 5) return tellVocab(robotId, { phase: 'too-long' });
  const known = vocab.find(text);
  if (known && known.status === 'ready') {
    // you met it again: it comes up for review sooner
    vocab.seenAgain(known.id);
    tellVocab(robotId, { phase: 'known', word: known });
    showCard({ ...known, known: true }, robotId);
    return;
  }
  const word = known || vocab.add({ text, source, context });
  tellVocab(robotId, { phase: 'catch', word });
  showCard(word, robotId);
  findMeaning(word.id, robotId);
}

// quiet: a word saved from a card's lists (＋): looked up in the background, no show
async function findMeaning(id, robotId, { quiet = false } = {}) {
  const word = vocab.update(id, { status: 'looking', error: '' });
  if (!word) return;
  wordCard.update(word);
  try {
    // the meaning comes back first: show it while the phrases, synonyms and family are still coming
    const onCore = (meaning) => {
      if (!vocab.get(id)) return;
      const partial = vocab.update(id, meaning); // (still 'looking' until the rest is in)
      if (partial) wordCard.update(partial);
    };
    const found = await lookup(word.text, { context: word.context, claudePath: store.settings.claudePath, onCore });
    if (!vocab.get(id)) return; // undone while it was looking
    // "ran" is "run": keep the one you already have
    const twin = vocab.find(found.word);
    if (twin && twin.id !== id && twin.status === 'ready') {
      vocab.remove(id);
      if (!quiet) {
        tellVocab(robotId, { phase: 'known', word: twin });
        showCard({ ...twin, known: true }, robotId);
      }
      vocabCountChanged();
      return;
    }
    const done = vocab.update(id, { ...found, status: 'ready' });
    wordCard.update(done);
    if (!quiet) {
      tellVocab(robotId, { phase: 'found', word: done });
      checkMilestones(robotId); // (a new day's first word can extend the streak)
    }
  } catch (err) {
    const failed = vocab.update(id, { status: 'failed', error: err.message });
    if (failed) wordCard.update(failed);
    if (!quiet) tellVocab(robotId, { phase: 'failed', word: failed, error: err.message });
  }
  vocabCountChanged();
}

// the card's buttons
function onCardAction(action, { word, robotId }, payload) {
  if (action === 'retry') return findMeaning(word.id, robotId);
  // the dream bubble: 📖 Details opens the whole card, ✓ I know this one skips it ahead
  if (action === 'details') {
    const w = vocab.get(word.id);
    if (w) wordCard.open({ ...w, known: true }, { robotId, paint: store.get(robotId)?.color, bounds: cardBounds(robotId) });
    return true;
  }
  if (action === 'know') {
    const w = vocab.knowIt(word.id);
    if (w) tellVocab(robotId, { phase: 'knowit', word: w });
    vocabCountChanged();
    setTimeout(() => wordCard.close(), 900);
    return w ? { review: w.review } : null;
  }
  // the quiz card: ✓ Knew it / ✗ Forgot / ⏰ Later, or left unanswered
  if (action === 'quiz') {
    if (!quizzing || quizzing.wordId !== word.id) return null;
    const how = ['knew', 'forgot', 'later', 'ignored'].includes(payload) ? payload : 'ignored';
    const done = endQuiz(how);
    if (how === 'ignored' || how === 'later') setTimeout(() => wordCard.close(), how === 'later' ? 900 : 0);
    return done ? { review: done.review } : null;
  }
  if (action === 'add') {
    // ＋ by a synonym, an antonym or a family word: saved as a word of its own
    const text = String(payload || '').replace(EDGES, '').trim().slice(0, 60);
    if (!text || vocab.find(text)) return false;
    const added = vocab.add({ text, source: `with “${word.word || word.text}”` });
    findMeaning(added.id, robotId, { quiet: true });
    return true;
  }
  if (action === 'undo') {
    vocab.remove(word.id);
    tellVocab(robotId, { phase: 'undone', word });
    vocabCountChanged();
    setTimeout(() => wordCard.close(), 700);
    return true;
  }
  if (action === 'save') {
    const patch = {};
    if (Array.isArray(payload?.senses)) patch.senses = payload.senses.slice(0, 5).map((x) => ({ pos: String(x.pos || ''), vi: String(x.vi || '').slice(0, 300), en: String(x.en || '').slice(0, 300) }));
    if (Array.isArray(payload?.examples)) patch.examples = payload.examples.slice(0, 6).map((e) => ({ en: String(e.en || '').slice(0, 400), vi: String(e.vi || '').slice(0, 400) }));
    if (Array.isArray(payload?.phrases)) {
      patch.phrases = payload.phrases.slice(0, 6).map((p) => ({
        phrase: String(p.phrase || '').slice(0, 80),
        vi: String(p.vi || '').slice(0, 200),
        example: String(p.example || '').slice(0, 400),
        exampleVi: String(p.exampleVi || '').slice(0, 400),
      }));
    }
    if (typeof payload?.tip === 'string') patch.tip = payload.tip.slice(0, 400);
    const saved = vocab.update(word.id, { ...patch, editedAt: Date.now() });
    if (saved) wordCard.update(saved);
    return saved;
  }
  if (action === 'ask') {
    tellVocab(robotId || nearestRobot(), { phase: 'ask', word: vocab.get(word.id) || word });
    wordCard.close();
    return true;
  }
  return null;
}

function bindVocabHotkey() {
  vocabHotkeyOk = capture.register('vocab', vocabHotkey(), () => captureWord());
  refreshTray();
}

// a saved word's card again (a sticky note on a monitor, the My words window)
function openWord(id, robotId = nearestRobot()) {
  const w = vocab.get(id);
  if (!w) return false;
  if (quizzing) endQuiz('ignored');
  vocab.update(id, { lastSeenAt: Date.now() });
  wordCard.open({ ...w, known: true }, { robotId, paint: store.get(robotId)?.color, bounds: cardBounds(robotId) });
  return true;
}

// ---------------------------------------------------------------- notes

// Your notes (notes.js): one notebook for all your robots. Each robot's desk has a
// corkboard with the open ones pinned on it; clicking it (or the hotkey, /notes, the
// menus) opens the notebook (notebook.js) beside that robot, and the robot pins new
// notes up and tosses done ones in its wastebasket. At the end of your workday, and
// the first time you're at the PC on a workday, a robot reminds you about them.
const NOTE_HOTKEY = 'Ctrl+Alt+N';
const noteHotkey = () => store.settings.noteHotkey || NOTE_HOTKEY;
let noteHotkeyOk = true;
const tellNotes = (id, payload) => id && sendToRobot(id, 'robot:notes', payload);

// the robot that reminds you: the one picked in the Workshop if it's out, else the one nearest the mouse
function notesRobot() {
  const pick = store.settings.notesRobot;
  const r = robots.get(pick);
  if (r && !r.win.isDestroyed() && r.win.isVisible()) return pick;
  return nearestRobot() || [...robots.keys()].find((id) => robots.get(id).win.isVisible()) || null;
}
// what this robot's corkboard shows (every desk has one, or just the reminding robot's when
// you've picked one in the Workshop)
const boardFor = (id) =>
  store.settings.notesBoard === 'one' && robots.has(store.settings.notesRobot) && store.settings.notesRobot !== id ? { items: [], total: 0, hidden: true } : notes.board();
function notesChanged() {
  for (const id of robots.keys()) tellNotes(id, { phase: 'board', board: boardFor(id) });
  refreshTray();
}
// a robot's box on screen, where the notebook goes beside it (out walking: where it is)
function robotRect(id) {
  const w = walkers?.bounds(id);
  if (w) return w;
  const r = robots.get(id);
  if (!r || r.win.isDestroyed()) return null;
  return { x: r.anchor.x, y: r.anchor.y, width: r.dims.w, height: r.dims.h };
}
function openNotebook({ robotId = nearestRobot() || notesRobot(), ...opts } = {}) {
  notebook.open({ robotId, near: robotRect(robotId), ...opts });
  tellNotes(robotId, { phase: 'opened' });
}
// the hotkey: the notebook with the add box ready (and whatever's selected, already in it)
async function captureNote() {
  const { text, source } = await capture.readSelection({ hotkeyKey: capture.keyCode(noteHotkey()) }).catch(() => ({ text: '', source: '' }));
  openNotebook({ focus: 'add', text: (text || '').slice(0, 2000), source: text ? source : '' });
}
function bindNoteHotkey() {
  noteHotkeyOk = capture.register('note', noteHotkey(), () => captureNote());
  refreshTray();
}

// ---------------------------------------------------------------- ask about the screen

// Drag a box round anything on screen (an error, a chart, a paragraph in another language)
// and ask about it: the box is saved as a screenshot, and the robot nearest the mouse opens
// a new tab with it attached and a few one-click questions (explain, fix, translate, sum up),
// or you type your own. The robots fade out while the screen is captured, so they're not in
// the way. The same drag-a-box screen as boxing a word (snip.js).
const SCREEN_HOTKEY = 'Ctrl+Alt+B';
const screenHotkey = () => store.settings.screenHotkey || SCREEN_HOTKEY;
let screenHotkeyOk = true;

function askScreen(robotId = nearestRobot(), from = null) {
  // the app you were in (not when it's one of ours: the menu, the chat button)
  const source = from ?? (BrowserWindow.getFocusedWindow() ? '' : capture.foregroundTitle() || '');
  snipFor = { kind: 'ask', robotId, source };
  const hide = [...robots.values()].map((r) => r.win);
  return snipper.start({ hint: '🔍 Drag a box round what you want to ask about · Esc to cancel', hide }).then(
    () => true,
    (err) => {
      console.warn('[snip]', err.message);
      snipFor = null;
      return false;
    },
  );
}
// the box you dragged: saved like a pasted screenshot, and handed to a robot at its desk
function screenShot(image) {
  const { robotId, source } = snipFor || {};
  snipFor = null;
  const file = savePaste(image.toPNG(), 'png');
  if (!file) return;
  const atDesk = (id) => id && robots.has(id) && !robots.get(id).win.isDestroyed() && robots.get(id).win.isVisible() && !walkers?.has(id);
  const id = atDesk(robotId) ? robotId : nearestRobot();
  if (id) return sendToRobot(id, 'robot:screen', { file, source });
  // everyone's out for a walk: call one back to its desk first
  const walker = [...robots.keys()].find((k) => walkers?.has(k));
  if (walker) {
    walkers.dock(walker);
    return setTimeout(() => sendToRobot(walker, 'robot:screen', { file, source }), 2500);
  }
  dialog.showMessageBox({ message: 'No robot is out to ask. Show one from the tray menu first.' });
}
function bindScreenHotkey() {
  screenHotkeyOk = capture.register('screen', screenHotkey(), () => askScreen());
  refreshTray();
}

// ---------------------------------------------------------------- the action palette

// One hotkey for everything, so there's just one to remember: press it with some text
// selected and a small menu by the mouse offers what fits (save the word, refine, translate,
// explain, sum up, note it, ask a robot); with nothing selected, the rest (box part of the
// screen, box a word, a new note, My words…). Each feature's own hotkey still works too.
const PALETTE_HOTKEY = 'Ctrl+Alt+C'; // (C for C-Bot; Ctrl+Alt+Space is often taken)
const paletteHotkey = () => store.settings.paletteHotkey || PALETTE_HOTKEY;
let paletteHotkeyOk = true;

// With the drone on (the default): the robot nearest the mouse waves its drone off the moment
// you press the hotkey; once your selection's read and the menu is drawn (hidden), the drone
// flies over in one smooth arc to just above it and projects it; when the menu goes, it flies home.
let paletteOpening = false;
async function openPalette() {
  if (palette.isOpen()) return palette.close();
  if (paletteOpening) return;
  paletteOpening = true;
  try {
    const robotId = nearestRobot() || notesRobot();
    const flying = store.settings.paletteDrone !== false;
    if (flying && robotId) sendToRobot(robotId, 'robot:palette', { phase: 'launch' });
    const sel = await capture.readSelection({ hotkeyKey: capture.keyCode(paletteHotkey()), keepLines: true }).catch(() => ({ text: '', source: '', hwnd: 0 }));
    const text = String(sel.text || '').slice(0, 12000);
    const box = await palette.stage({ text, source: sel.source || '', hwnd: text ? sel.hwnd : 0, robotId, items: paletteItems(text), projected: flying });
    if (!box) return; // (closed meanwhile)
    if (flying) {
      const r = robotId ? robotRect(robotId) : null;
      const wa = screen.getDisplayMatching(box).workArea;
      // from the robot's desk (or, with no robot out, from the tray's corner) to just above the menu
      const from = r ? { x: r.x + r.width / 2, y: r.y + r.height * 0.3 } : { x: wa.x + wa.width - 40, y: wa.y + wa.height };
      droneOut = true;
      await drone.launch({ from, to: { x: box.x + box.width / 2, y: box.y + 6 - 30 }, paint: store.get(robotId)?.color || '#5ac8fa' }).catch(() => {}); // (30: drone.js's hover gap)
    }
    palette.reveal();
  } finally {
    paletteOpening = false;
  }
}
function paletteItems(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  const word = one.replace(EDGES, '');
  const wordy = word && word.length <= 60 && word.split(' ').length <= 5;
  if (!one) {
    return [
      { id: 'screen', icon: 'scan', label: 'Ask about part of the screen' },
      { id: 'box-word', icon: 'text-box', label: 'Box a word on screen to save it' },
      { id: 'new-note', icon: 'note-plus', label: 'New note' },
      { id: 'quick', icon: 'sparkles', label: 'Quick actions on text…' },
      { id: 'words', icon: 'book', label: 'My words' },
      { id: 'notes', icon: 'notebook', label: 'My notes' },
    ];
  }
  return [
    { heading: 'With what you selected' },
    ...(wordy ? [{ id: 'word', icon: 'book-plus', label: `Save “${word}” to my words` }] : []),
    { id: 'refine', icon: 'wand', label: 'Refine it', hint: 'polished, professional…' },
    { id: 'translate', icon: 'languages', label: 'Translate it' },
    { id: 'explain', icon: 'bulb', label: 'Explain it' },
    { id: 'summarise', icon: 'summary', label: 'Sum it up' },
    { id: 'note', icon: 'note-plus', label: 'Note it down' },
    { id: 'ask', icon: 'chat-ask', label: 'Ask a robot about it' },
    { heading: 'Anything' },
    { id: 'screen', icon: 'scan', label: 'Ask about part of the screen' },
    { id: 'words', icon: 'book', label: 'My words' },
  ];
}
function onPaletteAction(id, { text = '', source = '', hwnd = 0, robotId = null }) {
  switch (id) {
    case 'word':
      return catchWord(text, { source, robotId });
    case 'refine':
    case 'translate':
    case 'explain':
    case 'summarise':
      return openQuick({ text, source, hwnd, robotId, prefs: { action: id } });
    case 'note':
      return openNotebook({ robotId, focus: 'add', text: text.slice(0, 2000), source });
    case 'ask': {
      // a new chat tab with the text in it, for you to say what you want to know
      const r = chattyRobot(robotId);
      if (!r) return;
      const prompt = [`About this text I selected${source ? ` in ${source}` : ''}:`, '', '---', text, '---', '', ''].join('\n');
      return setTimeout(() => tellNotes(r, { phase: 'ask', prompt, draft: true }), walkers?.has(r) ? 1800 : 0);
    }
    case 'screen':
      return askScreen(robotId || nearestRobot(), source);
    case 'box-word':
      return boxWord(robotId || nearestRobot(), source);
    case 'new-note':
      return openNotebook({ robotId, focus: 'add' });
    case 'quick':
      return openQuick({ text: clipboard.readText().trim().slice(0, 12000), robotId });
    case 'words':
      return openWords();
    case 'notes':
      return openNotebook({ robotId, focus: null });
  }
}
// every hotkey, for the Workshop's Settings > Shortcuts: what it does, its keys, its default,
// whether it works (registered, not taken by another app), and the setting that changes it
function hotkeyList() {
  return [
    { setting: 'paletteHotkey', label: 'Action menu', what: 'Every action in one menu, by the mouse', key: paletteHotkey(), def: PALETTE_HOTKEY, ok: paletteHotkeyOk },
    { setting: 'screenHotkey', label: 'Ask about part of the screen', what: 'Drag a box round anything and ask a robot', key: screenHotkey(), def: SCREEN_HOTKEY, ok: screenHotkeyOk },
    { setting: 'quickHotkey', label: 'Quick actions', what: 'Refine, translate or explain the text you selected', key: quickHotkey(), def: QUICK_HOTKEY, ok: quickHotkeyOk },
    { setting: 'vocabHotkey', label: 'Save a word', what: 'The word you selected goes into My words', key: vocabHotkey(), def: VOCAB_HOTKEY, ok: vocabHotkeyOk },
    { setting: 'noteHotkey', label: 'Take a note', what: 'The notebook, with what you selected in it', key: noteHotkey(), def: NOTE_HOTKEY, ok: noteHotkeyOk },
  ];
}

function bindPaletteHotkey() {
  paletteHotkeyOk = capture.register('palette', paletteHotkey(), () => openPalette());
  refreshTray();
}

// ---------------------------------------------------------------- quick actions

// Select some text anywhere and press the hotkey: the Quick actions window opens beside the
// robot nearest the mouse with it, and refines it in a style you pick (polished, professional,
// polite…), translates it, explains it or sums it up (quick.js, Claude's quick model). Replace
// puts the answer back over your selection. The robot writes on its pad while it works.
const QUICK_HOTKEY = 'Ctrl+Alt+R';
const quickHotkey = () => store.settings.quickHotkey || QUICK_HOTKEY;
let quickHotkeyOk = true;
const tellQuick = (id, payload) => id && sendToRobot(id, 'robot:quick', payload);

function openQuick({ text = '', source = '', hwnd = 0, robotId = nearestRobot() || notesRobot(), prefs = null } = {}) {
  quickWin.open({ text, source, hwnd, robotId, prefs, near: robotId ? robotRect(robotId) : null, paint: store.get(robotId)?.color || '#5ac8fa' });
}
async function captureQuick() {
  const sel = await capture.readSelection({ hotkeyKey: capture.keyCode(quickHotkey()), keepLines: true }).catch(() => ({ text: '', source: '', hwnd: 0 }));
  openQuick({ text: sel.text, source: sel.text ? sel.source : '', hwnd: sel.text ? sel.hwnd : 0 });
}
function bindQuickHotkey() {
  quickHotkeyOk = capture.register('quick', quickHotkey(), () => captureQuick());
  refreshTray();
}

// what the window's buttons do beyond itself, and the robot's reactions
async function onQuickAction(action, ctx, p = {}) {
  const id = ctx.robotId;
  switch (action) {
    case 'start':
    case 'done':
    case 'fail':
    case 'copied':
      return tellQuick(id, { phase: action, action: p.action });
    case 'replace': {
      const ok = await capture.pasteInto(ctx.hwnd, p.text);
      if (!ok) clipboard.writeText(String(p.text || '')); // (that window's gone: it's on the clipboard instead)
      tellQuick(id, { phase: ok ? 'replaced' : 'copied', action: p.action });
      return ok;
    }
    case 'ask': {
      // talk it over with the robot: a new chat tab with the text (and the answer so far)
      const robotId = chattyRobot(id);
      if (!robotId) return false;
      const what = { refine: `refine it (${p.style || 'polished'})`, translate: 'translate it', explain: 'explain it', summarise: 'summarise it' }[p.action] || 'help with it';
      const prompt = [`I selected this text and asked you to ${what}.`, '', '---', p.text, '---', ...(p.result ? ['', 'Your answer was:', '---', p.result, '---'] : []), '', "Let's go over it together: "].join('\n');
      quickWin.close();
      setTimeout(() => tellNotes(robotId, { phase: 'ask', prompt, draft: true }), walkers?.has(robotId) ? 1800 : 0);
      return true;
    }
    default:
      return null;
  }
}

// A daily reminder is due: a robot holds up its corkboard and the notebook opens (robot.js
// asks for it). It waits while that robot's busy; with no robot out, a Windows notification.
function remindNotes(kind, info) {
  const id = notesRobot();
  const summary = { today: info.today, open: info.open, taken: info.taken };
  if (!id) {
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: kind === 'morning' ? '🌅 Your notes from yesterday' : '🌇 Before you go: your notes',
      body: info.notes.slice(0, 4).map((x) => `${x.doneAt ? '✓' : '•'} ${x.text.split('\n')[0]}`).join('\n'),
      silent: false,
    });
    n.on('click', () => openNotebook({ focus: null, reminder: { kind, info: summary } }));
    n.show();
    return true;
  }
  if (robotBusy(id)) return false; // tried again on the next check
  tellNotes(id, { phase: 'remind', kind, info: summary });
  return true;
}

// what the notebook passes on (notebook.js onAction)
function onNotebookAction(action, ctx, p = {}) {
  const robotId = ctx.robotId;
  switch (action) {
    case 'added':
      return tellNotes(robotId, { phase: 'added', note: p.note });
    case 'done':
      return tellNotes(robotId, { phase: 'done', note: p.note, left: p.left });
    case 'undone':
      return null;
    case 'typing':
      // you're writing a note: the robot writes it down too (robot.js notewrite)
      return tellNotes(robotId, { phase: 'writing', on: !!p.on });
    case 'ask':
      return askAboutNote(String(p.id), robotId);
    case 'summary':
      return summariseDay(robotId);
    case 'snooze':
      noteReminders.snooze(ctx.reminder?.kind || 'evening', Number(p.minutes) || 15);
      notebook.clearReminder();
      return notebook.close();
    case 'done-for-today': {
      const evening = ctx.reminder?.kind === 'evening';
      noteReminders.doneForToday();
      notebook.clearReminder();
      notebook.close();
      if (evening) tellNotes(robotId, { phase: 'clockout' });
      return true;
    }
    default:
      return null;
  }
}

// a robot that can chat about a note: this one, unless it's out walking (then it's called back)
function chattyRobot(id) {
  if (!id || !robots.has(id)) id = notesRobot();
  if (id && walkers?.has(id)) walkers.dock(id);
  return id;
}
// "Ask Claude" on a note: the robot takes it on in a new chat tab (robot.js), the note
// shows 🔧 on the board while it's being worked on
function askAboutNote(noteId, robotId) {
  const note = notes.get(noteId);
  const id = chattyRobot(robotId);
  if (!note || !id) return false;
  notes.update(noteId, { working: true });
  notebook.close();
  const prompt = `Here's a note from my notebook. Help me get it done (look into it in this folder if that's useful):\n\n${note.text}`;
  setTimeout(() => tellNotes(id, { phase: 'ask', note, prompt }), walkers?.has(id) ? 1800 : 0);
  return true;
}
// "Summarise my day": the robot asks Claude for a short recap of today's notes, to paste into a stand-up
function summariseDay(robotId) {
  const id = chattyRobot(robotId);
  if (!id) return false;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = notes.list().filter((n) => n.createdAt >= start.getTime() || (n.doneAt && n.doneAt >= start.getTime()));
  const open = notes.open().filter((n) => !today.includes(n));
  if (!today.length && !open.length) return false;
  const line = (n) => `- ${n.doneAt ? '[done] ' : ''}${n.important ? '(important) ' : ''}${n.text.replace(/\n+/g, ' ')}`;
  const prompt = [
    'Summarise my day from my notebook, as a short update I can paste into a stand-up or a report:',
    'a few bullet points (done, in progress, next), plain and friendly, no preamble. Just the notes, no need to look at files.',
    '',
    "Today's notes:",
    ...today.map(line),
    ...(open.length ? ['', 'Still open from before:', ...open.map(line)] : []),
  ].join('\n');
  notebook.close();
  setTimeout(() => tellNotes(id, { phase: 'ask', prompt, summary: true }), walkers?.has(id) ? 1800 : 0);
  return true;
}

// ---- the My words window: every word, a search box, click one to see its card

let wordsWin = null;
function openWords() {
  if (wordsWin && !wordsWin.isDestroyed()) {
    wordsWin.show();
    wordsWin.focus();
    return;
  }
  wordsWin = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 420,
    title: 'My words — C-Bot',
    autoHideMenuBar: true,
    backgroundColor: '#f1f3f9',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wordsWin.loadFile(path.join(__dirname, '..', 'renderer', 'words', 'index.html'));
  guardNavigation(wordsWin);
  wordsWin.on('closed', () => (wordsWin = null));
}
function notifyWords() {
  if (wordsWin && !wordsWin.isDestroyed()) wordsWin.webContents.send('words:changed');
}
// what the window lists: the card's main points and how well you know each word
const wordRow = (w) => ({
  id: w.id,
  word: w.word,
  ipa: w.ipa,
  vi: w.senses?.map((s) => s.vi).join('; ') || '',
  pos: [...new Set((w.senses || []).map((s) => s.pos))].join(', '),
  status: w.status,
  addedAt: w.addedAt,
  box: w.review?.step || 0, // (times seen)
  seen: w.review?.seen || 0,
  right: w.review?.right || 0,
  due: w.review?.due || 0,
});

// ---------------------------------------------------------------- IPC

// An MCP tool's view, big, in a window of its own (the view's fullscreen mode).
// One window per tool call: asking again brings it to the front.
const appWindows = new Map(); // webContents id -> { robotId, view, win }

function openAppWindow(robotId, view) {
  if (!robotId || !view?.server || !view?.uri) return false;
  for (const w of appWindows.values()) {
    if (w.view.id === view.id && !w.win.isDestroyed()) {
      w.win.show();
      w.win.focus();
      return true;
    }
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(1400, Math.round(wa.width * 0.85)),
    height: Math.min(950, Math.round(wa.height * 0.85)),
    title: view.title || 'Tool view',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const key = win.webContents.id;
  appWindows.set(key, {
    robotId,
    win,
    view: { id: String(view.id || ''), server: String(view.server), tool: String(view.tool || ''), uri: String(view.uri), title: String(view.title || ''), input: view.input, result: view.result },
  });
  win.on('closed', () => appWindows.delete(key));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'appview', 'index.html'));
  guardNavigation(win);
  win.once('ready-to-show', () => win.show());
  return true;
}

function idFromSender(event) {
  for (const [id, r] of robots) if (!r.win.isDestroyed() && r.win.webContents === event.sender) return id;
  return null;
}

function registerIpc() {
  // robot windows
  // notes: the corkboard was clicked (or /notes), /note …, and the chat's side of "Ask Claude"
  ipcMain.handle('notes:open', (event, { focus = null } = {}) => openNotebook({ robotId: idFromSender(event), focus }));
  ipcMain.handle('notes:add', (event, text) => {
    const note = notes.add({ text: String(text || ''), source: 'chat' });
    if (note) tellNotes(idFromSender(event), { phase: 'added', note, quiet: true });
    return note;
  });
  ipcMain.handle('notes:act', (event, action, p = {}) => {
    if (action === 'working') return notes.update(String(p.id), { working: !!p.working });
    if (action === 'done') {
      const note = notes.setDone(String(p.id), true);
      if (note) tellNotes(idFromSender(event), { phase: 'done', note, left: notes.open().length });
      return note;
    }
    if (action === 'remind-shown') return true;
    return null;
  });
  // the reminder's moment is over (the robot held up its board): open the notebook with the banner
  ipcMain.handle('quick:open-blank', (event, { text = '' } = {}) => openQuick({ text: String(text).slice(0, 12000), robotId: idFromSender(event) }));
  ipcMain.handle('notes:remind-open', (event, { kind, info } = {}) =>
    openNotebook({ robotId: idFromSender(event), focus: null, reminder: { kind, info }, activate: false }));

  ipcMain.handle('robot:init', (event) => {
    const id = idFromSender(event);
    const c = store.get(id);
    walkers.close(id);
    return {
      character: c ? robotView(c) : null,
      personalities: publicPersonalities(),
      settings: store.settings,
      user: os.userInfo().username,
      vocabCount: vocab.count,
      vocabSight: sightWords(),
      vocabHotkey: vocabHotkey(),
      notesBoard: boardFor(id),
      noteHotkey: noteHotkey(),
    };
  });
  // 📚 Save this word (offered under an answer about what a word means)
  ipcMain.handle('robot:vocab-save', (event, text) => catchWord(String(text || ''), { robotId: idFromSender(event) }));
  // a sticky note on its monitor clicked; slapped mid-quiz (skip it) or a hint wanted
  ipcMain.handle('robot:vocab-open', (event, id) => openWord(String(id || ''), idFromSender(event)));
  ipcMain.handle('robot:vocab-quiz', (event, how) => (quizzing?.robotId === idFromSender(event) ? (wordCard.close(), !!endQuiz(how === 'later' ? 'later' : 'ignored')) : false));
  ipcMain.handle('robot:vocab-quiz-me', () => reminders.quizNow());
  ipcMain.handle('robot:vocab-words', () => openWords());
  ipcMain.handle('robot:vocab-dream', (event) => startDream(quizPick(), idFromSender(event)));
  ipcMain.handle('robot:vocab-box', (event) => boxWord(idFromSender(event)));
  ipcMain.handle('robot:screen-ask', (event) => askScreen(idFromSender(event)));
  // the My words window
  ipcMain.handle('words:list', () => ({
    words: vocab.list().map(wordRow),
    stats: vocab.stats(),
    hotkey: vocabHotkey(),
    reminders: store.settings.vocabReminders !== false,
    hours: store.settings.vocabHours || [9, 18],
  }));
  ipcMain.handle('words:settings', (_e, patch = {}) => {
    const out = {};
    if (typeof patch.reminders === 'boolean') out.vocabReminders = patch.reminders;
    const h = patch.hours;
    if (Array.isArray(h) && h.length === 2 && h.every((x) => Number.isInteger(x) && x >= 0 && x <= 24) && h[0] < h[1]) out.vocabHours = h;
    setSettings(out);
    return true;
  });
  // a CSV for Anki or Quizlet: word, meaning, pronunciation, a phrase and its example
  ipcMain.handle('words:export', async () => {
    const res = await dialog.showSaveDialog(wordsWin || undefined, {
      title: 'Export my words',
      defaultPath: path.join(app.getPath('documents'), `my-english-words-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV (Anki, Quizlet, Excel)', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Word', 'Meaning (Vietnamese)', 'IPA', 'Part of speech', 'Phrase', 'Example', 'Example (Vietnamese)', 'Synonyms']];
    for (const w of vocab.list().filter((x) => x.status === 'ready')) {
      const p = w.phrases?.[0] || {};
      const ex = p.example ? { en: p.example, vi: p.exampleVi } : w.examples?.[0] || {};
      rows.push([w.word, (w.senses || []).map((x) => x.vi).join('; '), w.ipa, [...new Set((w.senses || []).map((x) => x.pos))].join(', '), p.phrase || '', ex.en || '', ex.vi || '', (w.synonyms || []).map((x) => x.word).join(', ')]);
    }
    fs.writeFileSync(res.filePath, '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'utf8'); // (BOM: Excel reads the Vietnamese right)
    shell.showItemInFolder(res.filePath);
    return res.filePath;
  });
  ipcMain.handle('words:open', (_e, id) => openWord(String(id || '')));
  ipcMain.handle('words:delete', (_e, id) => {
    const ok = vocab.remove(String(id || ''));
    if (ok) vocabCountChanged();
    return ok;
  });
  ipcMain.handle('words:quiz', () => reminders.quizNow());

  ipcMain.handle('robot:ask', (event, tabId, prompt, attachments, turnId, kind) =>
    ask(idFromSender(event), String(tabId), String(prompt || '').trim(), {
      attachments: Array.isArray(attachments) ? attachments : [],
      turnId: turnId ? String(turnId) : undefined,
      kind: kind === 'bonk' ? 'bonk' : 'chat',
    }));
  ipcMain.handle('robot:inspect-paths', (_e, paths) => (Array.isArray(paths) ? paths.slice(0, 20).map((p) => inspectPath(p, { thumb: true })).filter(Boolean) : []));
  ipcMain.handle('robot:paste-clipboard', () => clipboardEntries());
  ipcMain.handle('robot:save-paste', (_e, bytes, ext) => (bytes && bytes.byteLength < 25 * 1024 * 1024 ? savePaste(bytes, String(ext || 'png')) : null));
  // Stop: interrupt the current answer; questions typed ahead come back unsent
  ipcMain.handle('robot:cancel', (event, tabId) => {
    const id = idFromSender(event);
    const dropped = sessions.get(runKey(id, String(tabId)))?.interrupt() || [];
    if (dropped.length) tell(id, String(tabId), { type: 'dropped', turnIds: dropped });
    return dropped;
  });
  ipcMain.handle('robot:unqueue', (event, tabId, turnId) => !!sessions.get(runKey(idFromSender(event), String(tabId)))?.unqueue(String(turnId)));
  ipcMain.handle('robot:send-now', (event, tabId, turnId) => !!sessions.get(runKey(idFromSender(event), String(tabId)))?.sendNow(String(turnId)));
  // the tab's "brain": model, effort and how full its context is
  ipcMain.handle('robot:brain', async (event, tabId) => {
    const id = idFromSender(event);
    const c = store.get(id);
    const tab = store.tab(id, String(tabId));
    if (!c || !tab) return null;
    return { models: modelChoices, model: tab.model ?? c.model ?? '', effort: tab.effort || '', context: await refreshContext(id, String(tabId)) };
  });
  ipcMain.handle('robot:set-brain', async (event, tabId, patch = {}) => {
    const id = idFromSender(event);
    const tab = store.tab(id, String(tabId));
    if (!tab) return { ok: false };
    const session = sessions.get(runKey(id, String(tabId)));
    try {
      if (typeof patch.model === 'string') {
        store.updateTab(id, tab.id, { model: patch.model });
        await session?.setModel(patch.model);
      }
      if (typeof patch.effort === 'string') {
        store.updateTab(id, tab.id, { effort: patch.effort });
        await session?.setEffort(patch.effort);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('robot:compact', (event, tabId, turnId) => ask(idFromSender(event), String(tabId), '/compact', { turnId: String(turnId), kind: 'compact' }));

  // focus: false reopens the bubble without stealing focus (a finished task popping back up)
  // tucked: awake with the chat put away (room for its status bubble), rather than asleep
  ipcMain.handle('robot:expand', (event, expanded, { focus = true, tucked = false } = {}) => {
    const id = idFromSender(event);
    const r = robots.get(id);
    if (!r) return;
    r.expanded = !!expanded;
    r.tucked = !expanded && !!tucked;
    applyLayout(id);
    if (r.expanded && focus) r.win.focus();
  });

  // dragging the chat panel's outer edge: wider or narrower (the robot stays put)
  ipcMain.on('robot:resize', (event, { phase, dx = 0 }) => {
    const id = idFromSender(event);
    const r = robots.get(id);
    if (!r || !r.expanded) return;
    if (phase === 'start') {
      r.resize = { w: r.layout?.panel ? r.layout.panel.w + 14 : r.chatW };
    } else if (phase === 'move' && r.resize) {
      const grow = r.layout?.placement === 'right' ? dx : -dx;
      r.chatW = Math.round(Math.min(Math.max(r.resize.w + grow, CHAT.min), r.layout?.maxChatW || CHAT.w));
      applyLayout(id);
    } else if (phase === 'end' && r.resize) {
      r.resize = null;
      store.update(id, { chatWidth: r.chatW });
    } else if (phase === 'reset') {
      r.chatW = CHAT.w;
      applyLayout(id);
      store.update(id, { chatWidth: CHAT.w });
    }
  });

  // the awake window is mostly see-through: clicks there go to whatever is behind it
  ipcMain.on('robot:click-through', (event, through) => {
    const r = robots.get(idFromSender(event));
    if (r && !r.win.isDestroyed()) r.win.setIgnoreMouseEvents(!!through, { forward: true });
  });

  ipcMain.on('robot:drag', (event, { phase, dx, dy }) => {
    const id = idFromSender(event);
    const r = robots.get(id);
    if (!r) return;
    if (phase === 'start') {
      r.drag = { anchor: { ...r.anchor }, bounds: r.win.getBounds() };
    } else if (phase === 'move' && r.drag) {
      r.anchor = { x: r.drag.anchor.x + dx, y: r.drag.anchor.y + dy };
      r.win.setBounds({ ...r.drag.bounds, x: r.drag.bounds.x + dx, y: r.drag.bounds.y + dy });
    } else if (phase === 'end' && r.drag) {
      r.drag = null;
      r.anchor = clampAnchor(r.anchor, r.dims);
      store.update(id, { position: r.anchor });
      applyLayout(id); // re-flow the bubble if we were dragged near an edge
    }
  });

  ipcMain.handle('robot:poke', (event) => {
    const id = idFromSender(event);
    const c = store.get(id);
    if (!c) return 0;
    const pokes = (c.stats?.pokes || 0) + 1;
    store.update(id, { stats: { ...c.stats, pokes } });
    return pokes;
  });

  ipcMain.handle('robot:reset', (event, tabId) => resetConversation(idFromSender(event), String(tabId)));
  ipcMain.handle('robot:terminal', (event, tabId) => openTerminal(idFromSender(event), String(tabId)));
  ipcMain.handle('robot:tab-new', (event) => newTab(idFromSender(event)));
  ipcMain.handle('robot:tab-close', (event, tabId) => closeTab(idFromSender(event), String(tabId)));
  // bring back a closed tab (the last one, or the one with this id)
  ipcMain.handle('robot:tab-reopen', (event, tabId) => {
    const id = idFromSender(event);
    const tab = store.reopenTab(id, tabId ? String(tabId) : undefined);
    if (!tab) return { ok: false, error: store.get(id)?.closedTabs?.length ? `That's the most tabs I can juggle!` : 'No closed tabs to bring back.' };
    sendToRobot(id, 'robot:character', robotView(store.get(id)));
    return { ok: true, tabId: tab.id, title: titleFor(tab) };
  });
  ipcMain.handle('robot:tab-rename', (event, tabId, title) => {
    const id = idFromSender(event);
    store.updateTab(id, String(tabId), { title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
    sendToRobot(id, 'robot:character', robotView(store.get(id)));
  });
  ipcMain.handle('robot:tab-activate', (event, tabId) => {
    const id = idFromSender(event);
    if (store.tab(id, String(tabId))) store.update(id, { activeTab: String(tabId) });
  });
  // the user answered a question Claude Code asked mid-task
  ipcMain.handle('robot:answer', (event, tabId, requestId, answers, items) => {
    const id = idFromSender(event);
    const session = sessions.get(runKey(id, String(tabId)));
    if (!session || !answers || typeof answers !== 'object') return false;
    const ok = session.answer(String(requestId), answers);
    if (ok && Array.isArray(items)) store.pushHistory(id, String(tabId), { role: 'qa', items: items.slice(0, 8) });
    return ok;
  });
  ipcMain.handle('robot:sessions', (event) => {
    const c = store.get(idFromSender(event));
    if (!c?.folder) return [];
    // sessions open in a tab are always the robot's, even if they predate session tracking
    const open = new Map(c.tabs.filter((t) => t.sessionId).map((t) => [t.sessionId, t.id]));
    const robotSessionIds = [...(c.sessionIds || []), ...open.keys()];
    return listSessions(c.folder, { robotSessionIds }).map((s) => ({ ...s, current: s.id === c.tabs.find((t) => t.id === c.activeTab)?.sessionId, tabId: open.get(s.id) || null }));
  });
  ipcMain.handle('robot:session', (event, sessionId) => {
    const c = store.get(idFromSender(event));
    return c?.folder ? readSession(c.folder, String(sessionId)) : null;
  });
  ipcMain.handle('robot:resume', (event, tabId, sessionId) => resumeConversation(idFromSender(event), String(tabId), String(sessionId)));
  ipcMain.handle('robot:commands', (event) => store.get(idFromSender(event))?.claudeCommands || []);
  // @-mentions: files and folders in the robot's folder matching what's typed after @
  ipcMain.handle('robot:files', (event, query) => {
    const c = store.get(idFromSender(event));
    return c?.folder && fs.existsSync(c.folder) ? searchFiles(c.folder, String(query || '').slice(0, 200)) : [];
  });
  // MCP tool views: does a tool call have one, its page, and what the page asks its server for.
  // These come from robot windows and from the big view windows they open.
  const folderOf = (event) => store.get(idFromSender(event) ?? appWindows.get(event.sender.id)?.robotId)?.folder;
  ipcMain.handle('robot:app-view', (event, toolName) => mcpApps.appFor(String(toolName), folderOf(event)));
  ipcMain.handle('robot:app-page', async (event, server, uri) => {
    try {
      return { ok: true, ...(await mcpApps.pageFor(String(server), String(uri), folderOf(event))) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('robot:app-call', async (event, server, method, params) => {
    try {
      return { ok: true, result: await mcpApps.callFromApp(String(server), String(method), params, folderOf(event)) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.rpc?.code };
    }
  });
  ipcMain.handle('robot:app-window', (event, view) => openAppWindow(idFromSender(event), view));
  ipcMain.handle('appview:init', (event) => appWindows.get(event.sender.id)?.view || null);
  // a file shown or linked in the chat: open it (or show it in its folder)
  ipcMain.handle('robot:open-file', (_e, file, opts) => localFiles.openFile(String(file || ''), { reveal: !!opts?.reveal }));
  ipcMain.handle('robot:open-link', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  });
  ipcMain.handle('robot:open-folder', (event) => {
    const c = store.get(idFromSender(event));
    if (c?.folder) shell.openPath(c.folder);
  });

  // it gets up and goes for a walk round the screen (asleep: it sleepwalks)
  ipcMain.handle('robot:wander-prep', (event, { asleep } = {}) => !!walkers.prepare(idFromSender(event), { asleep: !!asleep }));
  ipcMain.handle('robot:wander', (event, { asleep, feet } = {}) => {
    const id = idFromSender(event);
    const at = feet && Number.isFinite(feet.x) && Number.isFinite(feet.y) ? { x: feet.x, y: feet.y } : undefined;
    // (off to visit another robot's desk: social.js has its errand)
    return !!walkers.go(id, { asleep: !!asleep, feet: at, errand: social?.errandFor(id) });
  });
  // a robot's answer to another robot's message (robot.js; robotLink.js hands it back)
  ipcMain.on('robots:answer', (event, r = {}) => {
    const id = idFromSender(event);
    if (id && robotLink?.isFor(String(r.reqId), id)) robotLink.answer(String(r.reqId), { text: String(r.text || ''), error: r.error ? String(r.error) : '' });
  });
  // how a robot is (and what just happened to it), for the robots noticing each other
  ipcMain.on('social:report', (event, r) => {
    const id = idFromSender(event);
    if (id && r && typeof r === 'object') social?.report(id, r);
  });
  ipcMain.on('robot:walker', (event, what) => {
    const id = idFromSender(event);
    if (what === 'wave') walkers.wave(id);
    else if (what === 'asleep' || what === 'awake') walkers.setAsleep(id, what === 'asleep');
    else if (what === 'dock') walkers.dock(id);
    else if (what === 'docked') walkers.close(id); // the desk has its character back: the walker can go
    else if (what === 'cancel' && !walkers.isOut(id)) walkers.close(id); // it sat back down before setting off
  });
  walkers.registerIpc(ipcMain, { characterOf: (id) => walkerLook(store.get(id)) });

  ipcMain.handle('robot:menu', (event, { awake, away }) => {
    const id = idFromSender(event);
    const c = store.get(id);
    const r = robots.get(id);
    if (!c || !r) return;
    const say = (action) => r.win.webContents.send('robot:action', action);
    // grouped by feature: the everyday things at the top, each feature in a submenu
    const notesMenu = {
      label: `📒 Notes${notes.open().length ? ` (${notes.open().length} open)` : ''}`,
      submenu: [
        { label: '📒 Open my notebook…', click: () => openNotebook({ robotId: id, focus: null }) },
        { label: '📝 Take a note…', click: () => openNotebook({ robotId: id, focus: 'add' }) },
        { type: 'separator' },
        {
          label: '🔔 This robot reminds me about my notes',
          type: 'checkbox',
          checked: store.settings.notesRobot === id,
          click: (item) => setSettings({ notesRobot: item.checked ? id : '' }),
        },
      ],
    };
    const wordsMenu = {
      label: `📚 English words (${vocab.count})`,
      submenu: [
        { label: '📚 My words…', click: () => openWords() },
        { label: '🔍 Box a word on screen to save it…', click: () => setTimeout(() => boxWord(id), 250) }, // (after the menu has gone)
        { label: '💭 Show me one of my words', enabled: vocab.ready.length > 0, click: () => startDream(quizPick(), id) },
        { label: '🃏 Quiz me on a word', enabled: vocab.ready.length > 0, click: () => startQuiz(quizPick(), { asked: true, robotId: id }) },
        { type: 'separator' },
        {
          label: '🎓 This robot is my word tutor',
          type: 'checkbox',
          checked: store.settings.vocabTutor === id,
          click: (item) => setSettings({ vocabTutor: item.checked ? id : '' }),
        },
      ],
    };
    const settingsMenu = {
      label: '⚙️ Settings',
      submenu: [
        {
          label: '😄 Personality',
          submenu: Object.entries(PERSONALITIES).map(([key, p]) => ({
            label: `${p.emoji}  ${p.label}`,
            type: 'radio',
            checked: c.personality === key,
            click: () => updateCharacter(id, { personality: key }),
          })),
        },
        {
          label: '🔐 Permissions',
          submenu: Object.entries(PERMISSION_MODES).map(([key, label]) => ({
            label,
            type: 'radio',
            checked: c.permissionMode === key,
            click: () => updateCharacter(id, { permissionMode: key }),
          })),
        },
        { label: '🔇 Mute sounds', type: 'checkbox', checked: !!store.settings.muted, click: (i) => setSettings({ muted: i.checked }) },
        themeMenu(),
        { type: 'separator' },
        { label: '🛠️ Customize in the Workshop…', click: () => openManager(id) },
      ],
    };
    if (away) {
      Menu.buildFromTemplate([
        { label: `${c.name} is out for a walk`, enabled: false },
        { type: 'separator' },
        { label: '🚶 Call back to the desk', click: () => walkers.dock(id) },
        { label: '📁 Open folder', click: () => shell.openPath(c.folder) },
        { type: 'separator' },
        notesMenu,
        wordsMenu,
        { type: 'separator' },
        settingsMenu,
        { label: '🙈 Put away (hide)', click: () => hideRobot(id) },
      ]).popup({ window: r.win });
      return;
    }
    const canPaste = clipboardHasSomething();
    Menu.buildFromTemplate([
      { label: `${c.name} — ${path.basename(c.folder) || c.folder}`, enabled: false },
      { type: 'separator' },
      awake ? { label: '💤 Go to sleep', click: () => say('sleep') } : { label: '☀️ Wake up', click: () => say('wake') },
      { type: 'separator' },
      // the chat and Claude Code
      { label: '💬 New tab', click: () => say('new-tab') },
      { label: '🕘 Past conversations…', click: () => say('history') },
      { label: canPaste ? '📋 Paste screenshot / file from clipboard' : '📋 Paste (copy a screenshot or file first)', enabled: canPaste, click: () => say('paste') },
      { label: `🔍 Ask about part of the screen… (${screenHotkey()})`, click: () => askScreen(id) },
      { label: terminals.has(id) ? '⌨️ Terminal is open' : '⌨️ Open in terminal (full Claude Code)', enabled: !terminals.has(id), click: () => say('terminal') },
      { label: '📁 Open folder', click: () => shell.openPath(c.folder) },
      { type: 'separator' },
      // the features
      { label: `✨ Quick actions on text… (${quickHotkey()})`, click: () => openQuick({ text: clipboard.readText().trim().slice(0, 12000), robotId: id }) },
      notesMenu,
      wordsMenu,
      {
        label: '🎮 Play',
        submenu: [
          { label: '🔨 Bonk with the squeaky hammer (wake up / hurry up)', click: () => say('bonk') },
          { label: awake ? '🚶 Go for a walk' : '🚶 Sleepwalk', click: () => say('wander') },
        ],
      },
      { type: 'separator' },
      settingsMenu,
      { label: '🙈 Put away (hide)', click: () => hideRobot(id) },
    ]).popup({ window: r.win });
  });

  // manager window
  ipcMain.handle('mgr:state', () => ({
    characters: store.list().map(robotView),
    personalities: Object.fromEntries(Object.entries(PERSONALITIES).map(([k, p]) => [k, { label: p.label, emoji: p.emoji }])),
    permissionModes: PERMISSION_MODES,
    settings: store.settings,
    ...claudeInfo(),
    notes: { hotkey: noteHotkey(), hotkeyOk: noteHotkeyOk, defaults: NOTE_DEFAULTS },
    hotkeys: hotkeyList(),
  }));

  ipcMain.handle('mgr:pick-folder', async (_e, current) => {
    const res = await dialog.showOpenDialog(managerWin, {
      title: 'Which folder should this robot live in?',
      defaultPath: current || os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // your own character model: copied into <userData>/models, served back to the 3D view

  ipcMain.handle('mgr:create', (_e, fields) => {
    const c = store.create(sanitize(fields));
    createRobotWindow(c, store.list().length - 1);
    refreshTray();
    notifyManager();
    return c;
  });

  ipcMain.handle('mgr:update', (_e, id, patch) => updateCharacter(id, sanitize(patch)));

  ipcMain.handle('mgr:delete', (_e, id) => {
    closeRobotSessions(id);
    robots.get(id)?.win.close();
    store.remove(id);
    refreshTray();
    notifyManager();
  });

  ipcMain.handle('mgr:visible', (_e, id, visible) => (visible ? showRobot(id) : hideRobot(id)));
  ipcMain.handle('mgr:reset', (_e, id) => resetConversation(id));
  ipcMain.handle('mgr:settings', (_e, patch) => setSettings(patch));
  // pick claude by hand (opens where the installer puts it), and check it really is Claude Code
  ipcMain.handle('mgr:pick-claude', async () => {
    const bin = path.join(os.homedir(), '.local', 'bin');
    const res = await dialog.showOpenDialog(managerWin, {
      title: 'Locate Claude Code (claude)',
      defaultPath: fs.existsSync(bin) ? bin : os.homedir(),
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Claude Code', extensions: ['exe', 'cmd'] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    if (res.canceled) return { ok: false };
    const file = res.filePaths[0];
    const check = await checkClaude(file);
    if (!check.ok) return check;
    setSettings({ claudePath: file });
    return { ok: true, path: file, version: check.version };
  });
  // look again everywhere (just installed it, or it moved); a picked path that's gone is forgotten
  ipcMain.handle('mgr:find-claude', () => {
    if (store.settings.claudePath && !fs.existsSync(store.settings.claudePath)) store.updateSettings({ claudePath: '' });
    locateClaude(store.settings.claudePath, { fresh: true });
    notifyManager();
    return claudeInfo();
  });
}

// The characters there used to be (Loopy, the cat, the nerd, the girl, the classic robot and
// your own .glb model), as robots built from parts that look like them (office3d/kit3d.js).
const OLD_LOOKS = {
  robot: {},
  custom: {},
  loopy: { head: 'ball', face: 'cute', top: 'ears', body: 'egg', arms: 'mitten', finish: 'glossy', second: '#f4c7d4', accent: '#ff8fb1' },
  cat: { head: 'ball', face: 'cute', top: 'ears', body: 'egg', arms: 'mitten', finish: 'glossy', second: '#f4d7b8', accent: '#ff8fb1' },
  nerd: { face: 'visor', top: 'spiky', body: 'slim', specs: 'round', clothes: 'tshirt', hair: '#3a2a1e' },
  girl: { face: 'cute', top: 'pigtails', body: 'slim', clothes: 'dress', neck: 'bow', hair: '#6b3e26' },
};
function kitLike(body, color) {
  const kit = { ...(OLD_LOOKS[body] || {}) };
  if (kit.clothes && /^#[0-9a-f]{6}$/i.test(color || '')) kit.cloth = color; // (their hoodie or sweater was the paint colour)
  return kit;
}
// at start: any robot that's still an old character becomes a build like it
function migrateLooks() {
  for (const c of store.list()) {
    if (c.body === 'kit' && c.kit) continue;
    store.update(c.id, { body: 'kit', kit: c.kit || kitLike(c.body, c.color), glb: undefined, glbName: undefined, glbTurn: undefined });
  }
}

function sanitize(fields = {}) {
  const out = {};
  if (typeof fields.name === 'string') out.name = fields.name.trim().slice(0, 24) || 'Robo';
  if (typeof fields.folder === 'string') out.folder = fields.folder;
  if (fields.personality in PERSONALITIES) out.personality = fields.personality;
  if (fields.permissionMode in PERMISSION_MODES) out.permissionMode = fields.permissionMode;
  if (typeof fields.color === 'string' && /^#[0-9a-f]{6}$/i.test(fields.color)) out.color = fields.color;
  if (typeof fields.model === 'string') out.model = fields.model.trim();
  if (typeof fields.accessory === 'string') out.accessory = fields.accessory;
  // every robot is one you build (the old characters' names still come in: as a build like them)
  if (fields.body === 'kit' || fields.body in OLD_LOOKS) out.body = 'kit';
  if (fields.body in OLD_LOOKS && !fields.kit) out.kit = kitLike(fields.body, fields.color);
  // a robot built from parts: a part name per slot and its colours (office3d/kit3d.js knows the parts)
  if (fields.kit && typeof fields.kit === 'object') {
    const kit = {};
    for (const slot of ['head', 'face', 'top', 'body', 'arms', 'base', 'finish', 'clothes', 'neck', 'extra', 'specs']) if (/^[a-z]{1,16}$/.test(fields.kit[slot] || '')) kit[slot] = fields.kit[slot];
    for (const c of ['second', 'accent', 'eye', 'cloth', 'hair']) if (/^#[0-9a-f]{6}$/i.test(fields.kit[c] || '')) kit[c] = fields.kit[c];
    out.kit = kit;
  }
  if (['classic', 'sioux'].includes(fields.theme)) out.theme = fields.theme;
  if (fields.size in SIZES) out.size = fields.size;
  if (fields.clickOpens === 'chat' || fields.clickOpens === 'terminal') out.clickOpens = fields.clickOpens;
  if (typeof fields.wanders === 'boolean') out.wanders = fields.wanders;
  return out;
}

function updateCharacter(id, patch) {
  const before = store.get(id);
  if (!before) return null;
  const folderChanged = patch.folder && patch.folder !== before.folder;
  const sizeChanged = patch.size && patch.size !== (before.size || 'normal'); // before the store updates it in place
  const c = store.update(id, patch);
  // a new folder means new conversations: Claude Code keeps them per folder
  if (folderChanged) {
    closeRobotSessions(id);
    for (const t of c.tabs) store.updateTab(id, t.id, { sessionId: null });
  } else if (patch.permissionMode) {
    for (const [key, session] of sessions) if (key.startsWith(`${id}|`)) session.setPermissionMode(patch.permissionMode).catch(() => {});
  }
  const r = robots.get(id);
  if (r) {
    r.win.setTitle(c.name);
    if (sizeChanged) {
      // a new size grows (or shrinks) around its feet: bottom centre stays put
      const dims = robotDims(c.size);
      const old = r.dims;
      r.anchor = clampAnchor({ x: Math.round(r.anchor.x + (old.w - dims.w) / 2), y: r.anchor.y + old.h - dims.h }, dims);
      r.dims = dims;
      store.update(id, { position: r.anchor });
      applyLayout(id);
    }
    sendToRobot(id, 'robot:character', robotView(c));
  }
  refreshTray();
  notifyManager();
  return c;
}

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  if (!primary) return;
  if (process.platform === 'win32') app.setAppUserModelId('com.cbot.desktop');
  if (process.platform === 'darwin') app.dock?.hide();
  store = new Store();
  if (store.recovered) {
    // the save file was damaged (e.g. by a power cut): say where the robots came back from
    const { from, broken } = store.recovered;
    dialog.showMessageBox({
      type: 'warning',
      title: 'C-Bot',
      message: from ? 'Your robots were recovered from a backup.' : "C-Bot's save file couldn't be read.",
      detail: `${from ? `They came back from:\n${from}\n\n` : 'No backup could be read either, so C-Bot starts fresh.\n\n'}The damaged file was kept as:\n${broken}`,
    });
  }
  applyLoginItem();
  startUpdates({ onChange: () => refreshTray() });
  // macOS/Linux shutdown (Windows uses each window's session-end)
  powerMonitor.on('shutdown', saveNow);
  protocol.handle('cbot-app', mcpApps.servePage);
  localFiles.setAllowedRoots(() => [os.homedir(), os.tmpdir(), path.join(app.getPath('userData'), 'attachments'), ...store.list().map((c) => c.folder)]);
  protocol.handle('cbot-file', localFiles.serveImage);
  walkers = createWalkers({
    robots,
    sizeOf: (id) => SIZES[store.get(id)?.size] || 1,
    preload,
    guardNavigation,
    onChange: () => refreshTray(),
    onClick: (id) => !!social?.clicked(id),
    onHeld: (id) => social?.held(id),
    onGone: (id) => social?.gone(id),
  });
  vocab = new Vocab();
  wordCard = createWordCard({ preload, guardNavigation, onAction: onCardAction, onClosed: () => quizzing && endQuiz('ignored') });
  snipper = createSnipper({
    preload,
    guardNavigation,
    onShot: (image) => (snipFor?.kind === 'ask' ? screenShot(image) : readBoxed(image)),
    onCancel: () => (snipFor = null),
  });
  reminders = createReminders({ vocab, settings: () => store.settings, dream: (word) => startDream(word), quiz: (word, opts) => !quizzing && startQuiz(word, opts) });
  setInterval(vocabCountChanged, HOUR).unref?.(); // what's in sight moves on as words come due
  notes = new Notes();
  notebook = createNotebook({
    preload,
    guardNavigation,
    notes,
    settings: () => store.settings,
    saveSize: (size) => store.updateSettings({ notebookSize: size }),
    onAction: onNotebookAction,
    // closed after the end-of-day reminder (you've had your look): the robot clocks out
    onClosed: (ctx) => ctx.reminder?.kind === 'evening' && tellNotes(ctx.robotId, { phase: 'clockout' }),
  });
  notes.onChange(() => notesChanged());
  noteReminders = createNoteReminders({ notes, settings: () => store.settings, remind: remindNotes });
  quickWin = createQuickWindow({ preload, guardNavigation, settings: () => store.settings, saveSettings: (patch) => store.updateSettings(patch), onAction: onQuickAction });
  planes = createPlanes({ preload, guardNavigation });
  robotLink = createRobotLink({
    dir: path.join(app.getPath('userData'), 'robot-link'),
    robots,
    store,
    statusOf: (id) => (walkers.has(id) ? 'out for a walk' : robotBusy(id) ? 'busy working' : social?.peek(id)?.awake === false ? 'asleep' : 'awake'),
    // the message flies over as a paper plane; the asked robot takes it on in a tab of its own chat
    onAsk: ({ from, to, reqId, exchange, first, text }) => {
      const hand = (id, up) => {
        const r = robotRect(id);
        return r && { x: r.x + r.width / 2, y: r.y + r.height * (up ? 0.3 : 0.42) };
      };
      const deliver = () => sendToRobot(to, 'robot:link', { phase: 'incoming', reqId, exchange, first, from: store.get(from)?.name || '', text });
      if (walkers.has(to)) walkers.dock(to); // (out walking: back to its desk first)
      const a = hand(from, false);
      const b = hand(to, true);
      if (a && b && planes) planes.fly({ from: a, to: b, onLand: deliver });
      else deliver();
    },
    onAnswered: ({ from, to }) => {
      const r1 = robotRect(to);
      const r2 = robotRect(from);
      if (r1 && r2 && planes) planes.fly({ from: { x: r1.x + r1.width / 2, y: r1.y + r1.height * 0.42 }, to: { x: r2.x + r2.width / 2, y: r2.y + r2.height * 0.3 } });
    },
  });
  social = createSocial({
    robots,
    store,
    walkers,
    planes,
    personalityOf: (id) => PERSONALITIES[store.get(id)?.personality] || Object.values(PERSONALITIES)[0],
    nameOf: (id) => store.get(id)?.name || '',
    sendToRobot,
    robotRect,
    deskRect: (id) => {
      const r = robots.get(id);
      return r && !r.win.isDestroyed() ? { x: r.anchor.x, y: r.anchor.y, width: r.dims.w, height: r.dims.h } : null;
    },
    // (you're working with C-Bot: a card, the notebook or Quick actions is open)
    appBusy: () => !!(notebook?.isOpen() || quickWin?.isOpen() || wordCard?.showing()),
    acceptsNotifications,
  });
  if (process.env.CBOT_TEST) global.cbotSocial = social; // (the tests start visits themselves)
  drone = createDrone({ preload, guardNavigation });
  palette = createPalette({
    preload,
    guardNavigation,
    onPick: onPaletteAction,
    // the drone hovers over the menu's top edge while it's open, and flies home after
    onShown: (b) => droneOut && drone.hover({ x: b.x + b.width / 2, y: b.y + 6, width: b.width - 12 }),
    onHidden: () => {
      if (!droneOut) return;
      droneOut = false;
      drone.recall();
    },
  });
  setTimeout(() => (palette.prepare(), drone.prepare()), 4000); // (ready before the first hotkey, without slowing the start)
  registerIpc();
  migrateLooks();

  tray = new Tray(trayIcon());
  tray.setToolTip('C-Bot');
  tray.on('click', () => openManager());
  refreshTray();

  store.list().forEach((c, i) => c.visible && createRobotWindow(c, i));
  keepOnTop(() => [...[...robots.values()].map((r) => r.win), ...walkers.windows(), ...wordCard.windows(), ...notebook.windows(), ...quickWin.windows()]);
  bindVocabHotkey();
  bindNoteHotkey();
  bindQuickHotkey();
  bindScreenHotkey();
  bindPaletteHotkey();
  if (!store.list().length) openManager('new');
  startCursorTracking();

  // the taskbar moved or a screen changed size: re-fit the open chats
  // after a sleep, an unlock or a change of screens, robots out for a walk come back where you can reach them
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(() => walkers?.recover(), 1500));
  screen.on('display-added', () => walkers?.recover());
  screen.on('display-metrics-changed', () => {
    walkers?.recover();
    for (const id of robots.keys()) applyLayout(id);
  });
  screen.on('display-removed', () => {
    walkers?.recover();
    for (const [id, r] of robots) {
      r.anchor = clampAnchor(r.anchor, r.dims);
      applyLayout(id);
    }
  });
});

app.on('window-all-closed', () => {
  // Live in the tray; robots and the workshop can all be closed.
});

app.on('before-quit', () => {
  notes?.flush();
  for (const s of sessions.values()) s.close();
  for (const t of terminals.values()) t.mirror.stop(); // terminal windows stay open on their own
  store?.flush();
  vocab?.flush();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
