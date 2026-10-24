const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// The action palette: one hotkey for everything. A small menu by the mouse with what you can
// do with the text you selected (save the word, refine, translate, explain, sum up, note it,
// ask a robot) or, with nothing selected, the things that don't need any (box part of the
// screen, a new note, My words…). Keys 1–9, the arrows and Enter pick; Esc or clicking away
// closes it. main.js builds the items and runs the one you pick.
// The window is made once, hidden, and kept: opening it is just showing it (fast).
//   const palette = createPalette({ preload, guardNavigation, onPick })
//   palette.open({ text, source, items: [{ id, icon, label, hint? } | { heading }] })  (icon: a ui/icons.js name)
//   onPick(id, ctx)  ctx is what open() was given
//   onShown(bounds) / onHidden()  when it appears and goes (the drone hovers over it, then flies home)
//   open({ projected: true, … }) plays the projected-by-the-drone opening instead of the pop

const W = 320;
const GAP = 10;

function createPalette({ preload, guardNavigation, onPick, onShown = () => {}, onHidden = () => {} }) {
  let win = null;
  let ready = false; // the page has loaded
  let ctx = null;
  let height = 300;
  let at = null; // the mouse when it opened
  let showing = null; // the longest it waits for the page to draw the new items
  let staged = null; // while it draws them (hidden): settles where it will open

  // below and right of the mouse (above it, near the bottom), kept on its screen
  function plan(point, tall) {
    const wa = screen.getDisplayNearestPoint(point).workArea;
    const h = Math.min(tall, wa.height - 2 * GAP);
    const at = point;
    let x = at.x + 12;
    let y = at.y + 14;
    if (x + W > wa.x + wa.width - GAP) x = at.x - W - 12;
    if (y + h > wa.y + wa.height - GAP) y = at.y - h - 14;
    x = Math.round(Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - W - GAP));
    y = Math.round(Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - h - GAP));
    return { x, y, width: W, height: h };
  }
  function place() {
    if (!win || win.isDestroyed() || !at) return;
    win.setBounds(plan(at, height));
  }

  const view = () => ctx && { text: ctx.text || '', source: ctx.source || '', items: ctx.items || [], projected: !!ctx.projected };

  // made once and kept hidden till it's needed
  function make() {
    if (win && !win.isDestroyed()) return;
    ready = false;
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
      title: 'C-Bot',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'palette', 'index.html'));
    guardNavigation(win);
    win.webContents.once('did-finish-load', () => {
      ready = true;
      if (ctx && staged) win.webContents.send('palette:open', view());
    });
    // clicked somewhere else: it's a menu, it goes
    win.on('blur', () => close());
    win.on('closed', () => {
      win = null;
      ready = false;
      ctx = null;
    });
  }

  function reveal() {
    if (!win || win.isDestroyed() || !ctx) return;
    place();
    win.show();
    win.focus();
    onShown(win.getBounds(), ctx);
  }

  // The page draws the items in the hidden window and says how tall it is (palette:size; a
  // moment at most), so the old items never flash up: resolves with where it will open, or
  // null if it was closed meanwhile. reveal() shows it.
  function stage(next) {
    ctx = { text: '', source: '', items: [], ...next };
    at = screen.getCursorScreenPoint();
    make();
    clearTimeout(showing);
    staged?.(null);
    return new Promise((resolve) => {
      staged = (box) => {
        clearTimeout(showing);
        showing = null;
        staged = null;
        resolve(box);
      };
      showing = setTimeout(() => staged?.(plan(at, height)), 250);
      if (ready) win.webContents.send('palette:open', view());
    });
  }
  const open = (next) => stage(next).then((box) => box && reveal());

  function close() {
    if (staged) {
      ctx = null;
      staged(null);
    }
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
      onHidden();
    }
  }

  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('palette:init', (event) => (fromPage(event) && staged ? view() : null));
  ipcMain.on('palette:size', (event, h) => {
    if (!fromPage(event) || !Number.isFinite(h)) return;
    height = Math.max(80, Math.min(640, Math.ceil(h)));
    if (staged) staged(plan(at, height));
    else place();
  });
  ipcMain.handle('palette:pick', (event, id) => {
    if (!fromPage(event) || !ctx) return false;
    const picked = { ...ctx };
    close();
    // (a moment for the menu to go, so whatever opens next gets the focus)
    setTimeout(() => onPick(String(id), picked), 60);
    return true;
  });
  ipcMain.handle('palette:close', (event) => (fromPage(event) ? (close(), true) : false));

  return {
    open,
    close,
    prepare: make, // make the window now, so the first open is quick too
    // where it would open for the mouse at point, about this tall (the drone heads there)
    plan: (point, tall = height) => plan(point, tall),
    stage,
    reveal,
    isOpen: () => !!(win && !win.isDestroyed() && (win.isVisible() || staged)),
    windows: () => (win && !win.isDestroyed() && win.isVisible() ? [win] : []),
  };
}

module.exports = { createPalette };
