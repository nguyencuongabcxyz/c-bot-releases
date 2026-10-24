const { BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const quick = require('./quick');

// The Quick actions window: the text you selected, the four actions (refine with its styles,
// translate, explain, summarise) and the answer as it streams in, with Replace (back over
// your selection), Copy and Ask more. Beside the robot that caught it, or by the mouse.
// The page (renderer/quick) asks for its text with quick:init, runs an action with
// quick:run (the words come as quick:text), reports its height with quick:size and its
// buttons with quick:act; replace / ask / the robot's reactions go to onAction.

const W = 420;
const GAP = 8;

function createQuickWindow({ preload, guardNavigation, settings, saveSettings, onAction, onClosed = () => {} }) {
  let win = null;
  let ctx = null; // { text, source, hwnd, robotId, near, paint }
  let height = 360;
  let job = null; // the action running now

  // beside the robot (its box on screen), on the side with room; else above the mouse
  function place() {
    if (!win || win.isDestroyed() || !ctx) return;
    const near = ctx.near || { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const wa = screen.getDisplayMatching(near).workArea;
    const h = Math.min(height, wa.height - 2 * GAP);
    let x = near.x - W - GAP >= wa.x ? near.x - W - GAP : near.x + near.width + GAP;
    x = Math.round(Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - W - GAP));
    const y = Math.round(Math.min(Math.max(near.y + near.height - h, wa.y + GAP), wa.y + wa.height - h - GAP));
    win.setBounds({ x, y, width: W, height: h });
  }

  const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

  function open(next) {
    job?.cancel();
    job = null;
    ctx = { text: '', source: '', hwnd: 0, robotId: null, near: null, paint: '#5ac8fa', ...next };
    if (win && !win.isDestroyed()) {
      send('quick:open', view());
      place();
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: W,
      height,
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
      title: 'Quick actions',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'quick', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => {
      place();
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      job?.cancel();
      job = null;
      win = null;
      ctx = null;
      onClosed();
    });
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
  }

  // what the page needs: the text, where it came from, the last action and style you used
  function view() {
    const s = settings();
    return {
      text: ctx.text,
      source: ctx.source,
      canReplace: !!ctx.hwnd,
      paint: ctx.paint,
      prefs: { action: 'refine', style: 'polished', lang: 'en', ...(s.quickPrefs || {}), ...(ctx.prefs || {}) }, // (ctx.prefs: an action picked in the palette)
      styles: Object.entries(quick.STYLES).map(([id, st]) => ({ id, label: st.label, how: st.how })),
      model: s.quickModel || 'haiku',
      max: quick.MAX_TEXT,
    };
  }

  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('quick:init', (event) => (fromPage(event) && ctx ? view() : null));
  ipcMain.on('quick:size', (event, h) => {
    if (!fromPage(event) || !Number.isFinite(h)) return;
    height = Math.max(200, Math.min(780, Math.ceil(h)));
    place();
  });
  // run an action on the text; the words stream as quick:text { id, text }, the answer resolves
  ipcMain.handle('quick:run', async (event, req = {}) => {
    if (!fromPage(event) || !ctx) return null;
    job?.cancel();
    const id = Date.now();
    const s = settings();
    const run = quick.run(
      { action: req.action, text: String(req.text || ''), style: req.style, custom: req.custom, to: req.to, lang: req.lang, model: s.quickModel || 'haiku', claudePath: s.claudePath },
      (text) => send('quick:text', { id, text }),
    );
    job = run;
    send('quick:text', { id, text: '' });
    onAction('start', ctx, { action: req.action });
    const t0 = Date.now();
    try {
      const res = await run.done;
      if (job === run) job = null;
      onAction('done', ctx, { action: req.action });
      return { id, ...res, ms: Date.now() - t0, model: s.quickModel || 'haiku' };
    } catch (err) {
      if (job === run) job = null;
      if (err.cancelled) return { id, cancelled: true };
      onAction('fail', ctx, { action: req.action });
      return { id, error: err.message };
    }
  });
  ipcMain.handle('quick:act', async (event, action, p = {}) => {
    if (!fromPage(event) || !ctx) return null;
    switch (action) {
      case 'close':
        return close();
      case 'prefs': // the action / style / language you picked: next time it starts there
        return saveSettings({ quickPrefs: { ...(settings().quickPrefs || {}), ...p } });
      case 'copy':
        clipboard.writeText(String(p.text || ''));
        onAction('copied', ctx, p);
        return true;
      case 'replace': {
        // back to the app it came from, over the selection there
        const at = { ...ctx };
        close();
        return onAction('replace', at, p);
      }
      case 'stop':
        job?.cancel();
        return true;
      default:
        return onAction(action, ctx, p);
    }
  });

  return {
    open,
    close,
    isOpen: () => !!(win && !win.isDestroyed()),
    windows: () => (win && !win.isDestroyed() ? [win] : []),
  };
}

module.exports = { createQuickWindow };
