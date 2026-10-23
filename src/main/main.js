const { app, BrowserWindow, ipcMain, Menu, Tray, clipboard, dialog, nativeImage, powerMonitor, protocol, screen, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, titleFor } = require('./store');
const { ClaudeSession, findClaude, describeTool } = require('./claude');
const { launchTerminal, TranscriptMirror } = require('./terminal');
const { listSessions, readSession } = require('./sessions');
const { PERSONALITIES, systemPromptFor, publicPersonalities } = require('./personalities');
const { trayIcon } = require('./trayIcon');
const { startUpdates, checkForUpdates, restartToUpdate, updateState } = require('./updater');
const { keepOnTop } = require('./topmost');
const { searchFiles, mentionedPaths } = require('./files');
const mcpApps = require('./mcpApps');

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
  win.on('closed', () => robots.delete(character.id));
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
}

// Eyes follow the mouse: poll the global cursor and tell each robot where it is
// relative to its own face.
function startCursorTracking() {
  let last = '';
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const key = `${p.x},${p.y}`;
    if (key === last) return;
    last = key;
    for (const r of robots.values()) {
      if (r.win.isDestroyed() || !r.win.isVisible()) continue;
      // relative to the robot box; the renderer knows where the 3D head is
      r.win.webContents.send('robot:cursor', { x: p.x - r.anchor.x, y: p.y - r.anchor.y });
    }
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
    systemPrompt: systemPromptFor(c),
    permissionMode: c.permissionMode,
    model: tab.model ?? c.model ?? '', // '' = Claude Code's default; a tab's choice beats the robot's
    effort: tab.effort || '',
    tools: toolset?.tools || null,
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
    return { ok: false, error: "I can't find the `claude` command. Install Claude Code, or set its path in the Robot Workshop settings." };
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
  session.setSystemPrompt(systemPromptFor(c)); // personality changes apply from the next question
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

function notifyManager() {
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('mgr:changed');
}

// ---------------------------------------------------------------- tray

function refreshTray() {
  if (!tray) return;
  const chars = store.list();
  const menu = Menu.buildFromTemplate([
    { label: 'New robot…', click: () => openManager('new') },
    { label: 'Robot Workshop', click: () => openManager() },
    { type: 'separator' },
    ...(chars.length
      ? chars.map((c) => ({
          label: `${PERSONALITIES[c.personality]?.emoji || '🤖'}  ${c.name}`,
          type: 'checkbox',
          checked: !!c.visible,
          click: (item) => (item.checked ? showRobot(c.id) : hideRobot(c.id)),
        }))
      : [{ label: 'No robots yet', enabled: false }]),
    { type: 'separator' },
    {
      label: 'Mute robot sounds',
      type: 'checkbox',
      checked: !!store.settings.muted,
      click: (item) => setSettings({ muted: item.checked }),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: store.settings.startAtLogin !== false,
      click: (item) => {
        setSettings({ startAtLogin: item.checked });
        applyLoginItem();
      },
    },
    { label: 'Open backups folder', click: () => shell.openPath(store.backupDir) },
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

function setSettings(patch) {
  const settings = store.updateSettings(patch);
  for (const r of robots.values()) if (!r.win.isDestroyed()) r.win.webContents.send('robot:settings', settings);
  refreshTray();
  notifyManager();
  return settings;
}

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
  ipcMain.handle('robot:init', (event) => {
    const id = idFromSender(event);
    const c = store.get(id);
    return {
      character: c ? robotView(c) : null,
      personalities: publicPersonalities(),
      settings: store.settings,
      user: os.userInfo().username,
    };
  });

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

  ipcMain.handle('robot:menu', (event, { awake }) => {
    const id = idFromSender(event);
    const c = store.get(id);
    const r = robots.get(id);
    if (!c || !r) return;
    const say = (action) => r.win.webContents.send('robot:action', action);
    const canPaste = clipboardHasSomething();
    Menu.buildFromTemplate([
      { label: `${c.name} — ${path.basename(c.folder) || c.folder}`, enabled: false },
      { type: 'separator' },
      awake ? { label: 'Go to sleep', click: () => say('sleep') } : { label: 'Wake up', click: () => say('wake') },
      { label: terminals.has(id) ? 'Terminal is open' : 'Open in terminal (full Claude Code)', enabled: !terminals.has(id), click: () => say('terminal') },
      { label: canPaste ? '📋 Paste screenshot / file from clipboard' : '📋 Paste (copy a screenshot or file first)', enabled: canPaste, click: () => say('paste') },
      { label: 'New tab', click: () => say('new-tab') },
      { label: '🔨 Bonk with the squeaky hammer (wake up / hurry up)', click: () => say('bonk') },
      { label: 'Past conversations…', click: () => say('history') },
      { label: 'Open folder', click: () => shell.openPath(c.folder) },
      { type: 'separator' },
      {
        label: 'Personality',
        submenu: Object.entries(PERSONALITIES).map(([key, p]) => ({
          label: `${p.emoji}  ${p.label}`,
          type: 'radio',
          checked: c.personality === key,
          click: () => updateCharacter(id, { personality: key }),
        })),
      },
      {
        label: 'Permissions',
        submenu: Object.entries(PERMISSION_MODES).map(([key, label]) => ({
          label,
          type: 'radio',
          checked: c.permissionMode === key,
          click: () => updateCharacter(id, { permissionMode: key }),
        })),
      },
      { label: 'Customize…', click: () => openManager(id) },
      { type: 'separator' },
      { label: 'Mute sounds', type: 'checkbox', checked: !!store.settings.muted, click: (i) => setSettings({ muted: i.checked }) },
      { label: 'Put away (hide)', click: () => hideRobot(id) },
    ]).popup({ window: r.win });
  });

  // manager window
  ipcMain.handle('mgr:state', () => ({
    characters: store.list().map(robotView),
    personalities: Object.fromEntries(Object.entries(PERSONALITIES).map(([k, p]) => [k, { label: p.label, emoji: p.emoji }])),
    permissionModes: PERMISSION_MODES,
    settings: store.settings,
    claudePath: findClaude(store.settings.claudePath),
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
  ipcMain.handle('mgr:pick-model', async () => {
    const res = await dialog.showOpenDialog(managerWin, {
      title: 'Pick your character (.glb or .vrm)',
      filters: [{ name: '3D model (glTF binary or VRM)', extensions: ['glb', 'vrm'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return null;
    const src = res.filePaths[0];
    const { size } = await fs.promises.stat(src);
    if (size > MAX_MODEL_BYTES) return { error: `That model is ${Math.round(size / 1e6)} MB; the limit is ${MAX_MODEL_BYTES / 1e6} MB.` };
    const fd = await fs.promises.open(src, 'r');
    const magic = Buffer.alloc(4);
    await fd.read(magic, 0, 4, 0);
    await fd.close();
    if (magic.toString() !== 'glTF') return { error: "That file isn't a .glb or .vrm model." };
    const glb = `${crypto.randomUUID()}.glb`;
    await fs.promises.mkdir(modelsDir(), { recursive: true });
    await fs.promises.copyFile(src, path.join(modelsDir(), glb));
    return { glb, glbName: path.basename(src) };
  });
  ipcMain.handle('model:data', (_e, glb) => {
    if (!MODEL_FILE.test(glb)) throw new Error('Bad model name');
    return fs.promises.readFile(path.join(modelsDir(), glb));
  });

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
  ipcMain.handle('mgr:pick-claude', async () => {
    const res = await dialog.showOpenDialog(managerWin, { title: 'Locate the claude executable', properties: ['openFile'] });
    return res.canceled ? null : res.filePaths[0];
  });
}

const MAX_MODEL_BYTES = 200e6;
const MODEL_FILE = /^[\w-]+\.glb$/;
const modelsDir = () => path.join(app.getPath('userData'), 'models');

// models picked in the Workshop but never saved, or no longer used by any robot
function removeUnusedModels() {
  const used = new Set(store.list().map((c) => c.glb).filter(Boolean));
  fs.readdir(modelsDir(), (err, files) => {
    if (err) return;
    for (const f of files) if (MODEL_FILE.test(f) && !used.has(f)) fs.unlink(path.join(modelsDir(), f), () => {});
  });
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
  if (['loopy', 'cat', 'nerd', 'robot', 'custom'].includes(fields.body)) out.body = fields.body;
  if (['classic', 'sioux'].includes(fields.theme)) out.theme = fields.theme;
  if (fields.size in SIZES) out.size = fields.size;
  if (typeof fields.glb === 'string' && (fields.glb === '' || MODEL_FILE.test(fields.glb))) out.glb = fields.glb;
  if (typeof fields.glbName === 'string') out.glbName = fields.glbName.slice(0, 120);
  if ([0, 1, 2, 3].includes(fields.glbTurn)) out.glbTurn = fields.glbTurn;
  if (fields.clickOpens === 'chat' || fields.clickOpens === 'terminal') out.clickOpens = fields.clickOpens;
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
  registerIpc();
  removeUnusedModels();

  tray = new Tray(trayIcon());
  tray.setToolTip('C-Bot');
  tray.on('click', () => openManager());
  refreshTray();

  store.list().forEach((c, i) => c.visible && createRobotWindow(c, i));
  keepOnTop(() => [...robots.values()].map((r) => r.win));
  if (!store.list().length) openManager('new');
  startCursorTracking();

  // the taskbar moved or a screen changed size: re-fit the open chats
  screen.on('display-metrics-changed', () => {
    for (const id of robots.keys()) applyLayout(id);
  });
  screen.on('display-removed', () => {
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
  for (const s of sessions.values()) s.close();
  for (const t of terminals.values()) t.mirror.stop(); // terminal windows stay open on their own
  store?.flush();
});
