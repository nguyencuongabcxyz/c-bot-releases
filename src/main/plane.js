const { BrowserWindow } = require('electron');
const path = require('path');

// A paper plane flying across the screen from one robot's desk to another's (social.js):
// a small see-through window that never takes the mouse, moved along an arc here; the page
// (renderer/plane) draws the plane, tilted along its path (plane:pose).
//   fly({ from, to, onLand, miss })  from / to: screen points (where it leaves the hand, where
//                                     it's caught). onLand() as it gets there (the catch).
//                                     miss: it overshoots, glides down past the desk and lies
//                                     there a moment before it fades.

const BOX = { w: 96, h: 72 };
const TICK = 16;

function createPlanes({ preload, guardNavigation }) {
  const flying = new Set();

  function fly({ from, to, onLand = () => {}, miss = false }) {
    const win = new BrowserWindow({
      x: Math.round(from.x - BOX.w / 2),
      y: Math.round(from.y - BOX.h / 2),
      width: BOX.w,
      height: BOX.h,
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
      focusable: false,
      show: false,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'plane', 'index.html'));
    guardNavigation(win);
    flying.add(win);
    win.on('closed', () => flying.delete(win));

    // the path: an arc up and over (a miss carries on past the catch and glides down)
    const end = miss ? { x: to.x + (to.x - from.x) * 0.35, y: to.y + 110 } : to;
    const dist = Math.hypot(end.x - from.x, end.y - from.y);
    const ms = Math.min(3200, Math.max(1100, (dist / 420) * 1000));
    const lift = Math.min(200, 60 + dist * 0.22);
    const at = (u) => ({
      x: from.x + (end.x - from.x) * u,
      y: from.y + (end.y - from.y) * u - 4 * lift * u * (1 - u) + Math.sin(u * Math.PI * 3) * 6, // (a little wobble)
    });
    let t0 = 0;
    let landed = false;
    const step = () => {
      if (win.isDestroyed()) return;
      const u = Math.min(1, (Date.now() - t0) / ms);
      const p = at(u);
      const q = at(Math.min(1, u + 0.02));
      const angle = Math.atan2(q.y - p.y, q.x - p.x);
      win.setBounds({ x: Math.round(p.x - BOX.w / 2), y: Math.round(p.y - BOX.h / 2), width: BOX.w, height: BOX.h });
      win.webContents.send('plane:pose', { angle, flip: end.x < from.x, u });
      // caught a moment before it gets there (the hand comes up to meet it)
      if (!miss && !landed && u >= 0.92) {
        landed = true;
        onLand();
      }
      if (u < 1) return void setTimeout(step, TICK);
      if (!miss) return void setTimeout(() => !win.isDestroyed() && win.close(), 120);
      // a miss: it lies there a moment, then fades
      win.webContents.send('plane:pose', { angle: 0, flip: end.x < from.x, u: 1, landed: true });
      onLand();
      setTimeout(() => !win.isDestroyed() && win.webContents.send('plane:pose', { fade: true }), 2600);
      setTimeout(() => !win.isDestroyed() && win.close(), 3300);
    };
    win.once('ready-to-show', () => {
      win.showInactive();
      t0 = Date.now();
      step();
    });
    return win;
  }

  return {
    fly,
    windows: () => [...flying].filter((w) => !w.isDestroyed()),
    count: () => flying.size,
  };
}

module.exports = { createPlanes };
