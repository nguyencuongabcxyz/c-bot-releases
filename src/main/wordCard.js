const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// The word card: a window that pops up beside the robot that caught a
// word (vocab.js), showing the word while it's looked up and then its meanings
// and examples. One card at a time; a new word takes over the open card.
// The page (renderer/card) asks for its word with card:init, reports its height
// with card:size and its buttons with card:act, which go to onAction.

const W = 360;
const GAP = 6;

function createWordCard({ preload, guardNavigation, onAction, onClosed = () => {} }) {
  let win = null;
  let shown = null; // { word, robotId, paint, bounds: as big as the robot's chat, or near: a small one by these bounds }
  let height = 220;

  // where its robot says (as big as its chat), or else a small card by the mouse
  function place() {
    if (!win || win.isDestroyed() || !shown) return;
    if (shown.bounds) return win.setBounds(shown.bounds);
    const near = shown.near || { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const wa = screen.getDisplayMatching(near).workArea;
    const h = Math.min(height, wa.height - 2 * GAP);
    const clampX = (x) => Math.round(Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - W - GAP));
    const clampY = (y) => Math.round(Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - h - GAP));
    let x;
    let y;
    if (near.y - h - GAP >= wa.y) {
      x = clampX(near.x + near.width / 2 - W / 2);
      y = near.y - h - GAP;
    } else {
      x = near.x - W - GAP >= wa.x ? near.x - W - GAP : near.x + near.width + GAP;
      x = clampX(x);
      y = clampY(near.y + near.height - h);
    }
    win.setBounds({ x, y, width: W, height: h });
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function open(word, { robotId = null, paint = '#5ac8fa', bounds = null, near = null } = {}) {
    shown = { word, robotId, paint, bounds, near };
    if (win && !win.isDestroyed()) {
      send('card:word', { word, paint, fresh: true });
      place();
      win.showInactive();
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
      title: 'Word card',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'card', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => {
      place();
      win.showInactive();
    });
    win.on('closed', () => {
      win = null;
      shown = null;
      onClosed();
    });
  }

  // the word changed (looked up, edited): refresh the card if it's showing it
  function update(word) {
    if (!shown || shown.word.id !== word.id) return;
    shown.word = { ...word, known: shown.word.known, quiz: shown.word.quiz, dream: shown.word.dream }; // still a word you had (no Undo), still a quiz / dream
    send('card:word', { word: shown.word, paint: shown.paint });
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
  }

  const fromCard = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('card:init', (event) => (fromCard(event) && shown ? { word: shown.word, paint: shown.paint } : null));
  ipcMain.on('card:size', (event, h) => {
    if (!fromCard(event) || !Number.isFinite(h)) return;
    height = Math.max(120, Math.min(640, Math.ceil(h)));
    place();
  });
  ipcMain.handle('card:act', (event, action, payload) => {
    if (!fromCard(event) || !shown) return null;
    if (action === 'close') return close();
    return onAction(action, shown, payload);
  });

  return {
    open,
    update,
    close,
    showing: () => shown?.word.id || null,
    windows: () => (win && !win.isDestroyed() ? [win] : []),
  };
}

module.exports = { createWordCard };
