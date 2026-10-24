const { BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');

// The notebook: a small window beside a robot with all your notes (notes.js). The desk's
// corkboard opens it, and so do the hotkey, /notes, the menus and the daily reminders.
// One notebook at a time; opening it again just brings it round (to a note, the add box,
// or a reminder). It closes on Esc, ✕, or when you click away from it, but not while a
// reminder is up and you haven't looked at it yet.
// The page (renderer/notebook) asks for everything with notebook:init, gets each change
// as notebook:notes, and sends what you do with notebook:act; asking Claude about a note,
// summing up the day and putting a reminder off go on to onAction (main.js).

const SIZE = { w: 340, h: 460, minW: 280, minH: 300 };
const GAP = 8;

function createNotebook({ preload, guardNavigation, notes, settings, saveSize, onAction, onClosed = () => {} }) {
  let win = null;
  let ctx = { robotId: null, focus: 'add', reminder: null, near: null };
  let undo = null; // the note just deleted
  let focusedOnce = false;

  // beside the robot (its box on screen), on the side with room; else by the mouse
  function place() {
    if (!win || win.isDestroyed()) return;
    const saved = settings()?.notebookSize || {};
    const w = Math.max(SIZE.minW, saved.w || SIZE.w);
    const h = Math.max(SIZE.minH, saved.h || SIZE.h);
    const near = ctx.near || { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const wa = screen.getDisplayMatching(near).workArea;
    const height = Math.min(h, wa.height - 2 * GAP);
    let x = near.x - w - GAP >= wa.x ? near.x - w - GAP : near.x + near.width + GAP;
    x = Math.round(Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - w - GAP));
    const y = Math.round(Math.min(Math.max(near.y + near.height - height, wa.y + GAP), wa.y + wa.height - height - GAP));
    win.setBounds({ x, y, width: w, height });
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  const view = () => ({ notes: notes.list(), board: notes.board() });

  /**
   * Open it (or bring it round).
   *   robotId   the robot it's opened for (whose side it goes on, who acts things out)
   *   near      that robot's box on screen {x, y, width, height}
   *   focus     'add' | a note id | null
   *   reminder  { kind: 'morning' | 'evening', info } for a reminder banner, or null
   *   activate  focus the window (a click, the hotkey); false: show it without taking focus (a reminder)
   *   text, source  text to put in the add box (the hotkey, with something selected) and where it's from
   */
  function open({ robotId = null, near = null, focus = 'add', reminder = null, activate = true, text = '', source = '' } = {}) {
    ctx = { robotId, near, focus, reminder, text, source };
    focusedOnce = false;
    if (win && !win.isDestroyed()) {
      send('notebook:open', { focus, reminder, text, source });
      place();
      if (activate) win.show();
      else win.showInactive();
      return;
    }
    win = new BrowserWindow({
      width: SIZE.w,
      height: SIZE.h,
      minWidth: SIZE.minW,
      minHeight: SIZE.minH,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      title: 'Notes',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'notebook', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => {
      place();
      if (activate) win.show();
      else win.showInactive();
    });
    win.on('focus', () => (focusedOnce = true));
    // clicked away: it goes (a reminder you haven't looked at yet stays)
    win.on('blur', () => {
      if (focusedOnce) setTimeout(() => win && !win.isDestroyed() && !win.isFocused() && close(), 120);
    });
    win.on('resized', () => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      saveSize({ w: b.width, h: b.height });
    });
    win.on('closed', () => {
      win = null;
      onClosed(ctx);
    });
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
  }

  // every change to the notes reaches the page
  notes.onChange(() => send('notebook:notes', view()));

  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('notebook:init', (event) => (fromPage(event) ? { ...view(), focus: ctx.focus, reminder: ctx.reminder, text: ctx.text, source: ctx.source } : null));
  ipcMain.handle('notebook:act', async (event, action, p = {}) => {
    if (!fromPage(event)) return null;
    switch (action) {
      case 'add': {
        const note = notes.add({ text: p.text, important: !!p.important, source: p.source || '' });
        if (note) onAction('added', ctx, { note });
        return note;
      }
      case 'edit':
        return notes.update(String(p.id), { text: p.text, important: p.important });
      case 'done': {
        const note = notes.setDone(String(p.id), !!p.done);
        if (note) onAction(p.done ? 'done' : 'undone', ctx, { note, left: notes.open().length });
        return note;
      }
      case 'delete': {
        undo = notes.remove(String(p.id));
        return undo ? { id: undo.id } : null;
      }
      case 'undo-delete': {
        const note = undo && notes.restore(undo);
        undo = null;
        return note;
      }
      case 'clear-done':
        return notes.clearDone();
      case 'copy': {
        const note = notes.get(String(p.id));
        if (note) clipboard.writeText(note.text);
        return !!note;
      }
      case 'copy-all': {
        const open = notes.open();
        const done = notes.list().filter((n) => n.doneAt);
        const line = (n) => `${n.doneAt ? '[x]' : '[ ]'} ${n.important ? '(!) ' : ''}${n.text.replace(/\n/g, ' ')}`;
        clipboard.writeText([...open, ...done].map(line).join('\n'));
        return open.length + done.length;
      }
      case 'close':
        return close();
      // the rest is up to main.js: Claude, the robot, the reminder clock
      default:
        return onAction(action, ctx, p);
    }
  });

  return {
    open,
    close,
    isOpen: () => !!(win && !win.isDestroyed() && win.isVisible()),
    /** The reminder banner was dealt with (snoozed, done for today): drop it from the page. */
    clearReminder() {
      ctx.reminder = null;
      send('notebook:open', { focus: null, reminder: null });
    },
    windows: () => (win && !win.isDestroyed() ? [win] : []),
  };
}

module.exports = { createNotebook };
