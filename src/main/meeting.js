const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// The group chat's meeting room (groupChat.js): a small window with everyone in the chat round
// one table (renderer/meeting, drawn by office3d/meeting.js from its own small bundle). It's
// made when the meeting starts and destroyed when it ends, so it costs nothing the rest of the
// time. It sits beside the group chat window (left if there's room, else right, else above),
// stays on top like the desks, and can be dragged anywhere.
//   open({ people, topic, state, near })  people [{ id, name, color, kit, acc, theme }],
//                                         near: the chat window's bounds
//   update(state)   { ids, speaker, typing: [ids], agree: [ids], phase, mode }
//   say(id, text, agree)   a line of what it just posted, in a bubble over its head
//   close()

const GAP = 10;
const size = (n) => ({ width: n > 4 ? 640 : 540, height: n > 4 ? 380 : 340 });

function createMeetingRoom({ guardNavigation }) {
  let win = null;
  let info = null; // what the page asks for when it loads

  function place(near, { width, height }) {
    const wa = screen.getDisplayMatching(near).workArea;
    let x = near.x - width - GAP;
    let y = near.y + near.height - height;
    if (x < wa.x) x = near.x + near.width + GAP; // (no room on the left: the right)
    if (x + width > wa.x + wa.width) {
      x = near.x + (near.width - width) / 2; // (nor there: above it)
      y = near.y - height - GAP;
    }
    x = Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - width));
    y = Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - height));
    return { x, y, width, height };
  }

  function open({ people, topic, state, near }) {
    close();
    info = { people, topic, state };
    const bounds = place(near || { ...screen.getCursorScreenPoint(), width: 0, height: 0 }, size(people.length));
    win = new BrowserWindow({
      ...bounds,
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
      title: 'Meeting room',
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'meeting.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'meeting', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => win && !win.isDestroyed() && win.showInactive());
    win.on('closed', () => {
      win = null;
      info = null;
    });
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function close() {
    if (win && !win.isDestroyed()) win.destroy(); // (at once: everyone's back at their desks)
    win = null;
    info = null;
  }

  ipcMain.handle('meeting:init', (event) => (win && !win.isDestroyed() && event.sender === win.webContents ? info : null));

  return {
    open,
    close,
    update(state) {
      if (info) info.state = state;
      send('meeting:state', state);
    },
    say: (id, text, agree = false) => send('meeting:say', { id, text, agree }),
    isOpen: () => !!(win && !win.isDestroyed()),
    windows: () => (win && !win.isDestroyed() ? [win] : []),
  };
}

module.exports = { createMeetingRoom };
