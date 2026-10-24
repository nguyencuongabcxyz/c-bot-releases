const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// The robot's little drone, which delivers the action menu: it takes off from the robot's
// desk, flies to the mouse, hovers there and projects the menu (palette.js) under it with a
// beam of light; when the menu goes, it flies home. It's drawn in a see-through window over
// the whole screen that the mouse goes straight through and that never takes the focus
// (so the app you're in keeps it, and its selection can still be copied).
//   const drone = createDrone({ preload, guardNavigation })
//   await drone.launch({ from, to, paint })   from/to: screen points; resolves on arrival
//   await drone.goTo(point)                   steer it there (mid-flight too); resolves on arrival
//   drone.hover({ x, y, width })              settle above the menu's top edge, beam down
//   drone.recall(to)                          fly back to the desk, then it's gone

function createDrone({ preload, guardNavigation }) {
  let win = null;
  let ready = null; // resolves once the page has loaded
  let area = null; // the screen it covers (DIP)
  let arrivals = []; // waiting for it to get where it's going
  let home = null; // where it took off from

  function make() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      width: 400,
      height: 300,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      title: 'C-Bot drone',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'drone', 'index.html'));
    guardNavigation(win);
    ready = new Promise((r) => win.webContents.once('did-finish-load', r));
    win.on('closed', () => {
      win = null;
      ready = null;
    });
    return ready;
  }

  const send = (cmd) => win && !win.isDestroyed() && win.webContents.send('drone:cmd', cmd);
  // a screen point -> a point in the window
  const local = (p) => ({ x: p.x - area.x, y: p.y - area.y });

  async function launch({ from, to, paint = '#5ac8fa' }) {
    await make();
    area = screen.getDisplayNearestPoint(to).bounds;
    // (a pixel short of the whole screen, so Windows doesn't take it for a full-screen app)
    win.setBounds({ ...area, height: area.height - 1 });
    // took off from another screen: it comes in from that side
    const start = {
      x: Math.min(Math.max(from.x, area.x - 40), area.x + area.width + 40),
      y: Math.min(Math.max(from.y, area.y - 40), area.y + area.height + 40),
    };
    home = start;
    win.showInactive();
    const done = arrival();
    send({ kind: 'launch', from: local(start), to: local(to), paint });
    return done;
  }
  // the next time it gets where it's going (never waited on for long, whatever the page does)
  const arrival = () => Promise.race([new Promise((r) => arrivals.push(r)), new Promise((r) => setTimeout(r, 900))]);

  function goTo(to) {
    if (!area || !win || win.isDestroyed()) return Promise.resolve();
    const done = arrival();
    send({ kind: 'retarget', to: local(to) });
    return done;
  }

  function hover({ x, y, width }) {
    if (!area) return;
    send({ kind: 'hover', at: local({ x, y }), width });
  }

  function recall() {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    send({ kind: 'recall', to: home ? local(home) : null });
  }

  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.on('drone:arrived', (event) => {
    if (!fromPage(event)) return;
    for (const r of arrivals.splice(0)) r();
  });
  // back home (or faded out): nothing left to show
  ipcMain.on('drone:gone', (event) => {
    if (fromPage(event) && win.isVisible()) win.hide();
  });

  return { launch, goTo, hover, recall, prepare: make, windows: () => (win && !win.isDestroyed() && win.isVisible() ? [win] : []) };
}

module.exports = { createDrone };
