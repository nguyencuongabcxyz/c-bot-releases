const { BrowserWindow, screen } = require('electron');
const path = require('path');

// A robot that wandered off: it walks around the screen in a small window of
// its own while its desk stands empty, until you drag it back onto the desk.
// The walk itself happens here (the window moves); the page only animates the
// character (renderer/walker, office3d's solo mode).

// the walker box at size 1 (DIP): the page draws the character as big as at its desk,
// feet FEET of the way down (office3d walker3d.js SOLO.feet). Room for every pose: up to
// ~215 px above its feet (a raised hand, sleepwalking z's), ~90 px either side (swinging as
// it's carried). The empty part of the box lets clicks through (walker:through).
const BOX = { w: 190, h: 250 };
const FEET = 0.9;
const TICK = 33; // ms
const SPEED = { walk: 70, sleepwalk: 32 }; // px/s at size 1
// what it does when it gets somewhere: [gait, min s, max s]
const PAUSES = {
  awake: [['stand', 1.5, 3.5], ['look', 2.5, 4], ['wave', 1.6, 2.2], ['sit', 5, 9]],
  asleep: [['stand', 2.5, 5], ['sit', 6, 11]],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);

function createWalkers({ robots, sizeOf, preload, guardNavigation, onChange }) {
  const walkers = new Map(); // robot id -> walker

  function deskBounds(id) {
    const r = robots.get(id);
    return r && !r.win.isDestroyed() ? r.win.getBounds() : null;
  }
  // where it may roam: the screen its desk is on
  function area(w) {
    const d = deskBounds(w.id);
    const at = d ? { x: d.x + d.width / 2, y: d.y + d.height / 2 } : { x: w.x, y: w.y };
    return screen.getDisplayNearestPoint(at).workArea;
  }
  function send(w, channel, payload) {
    if (!w.win.isDestroyed()) w.win.webContents.send(channel, payload);
  }
  function setGait(w, gait, heading = w.heading) {
    if (gait === w.gait && heading === w.heading) return;
    w.gait = gait;
    w.heading = heading;
    send(w, 'walker:state', { gait, heading, asleep: w.asleep, speed: w.asleep ? 0.6 : 1 });
  }
  function place(w) {
    if (!w.win.isDestroyed()) w.win.setBounds({ x: Math.round(w.x), y: Math.round(w.y), width: w.box.w, height: w.box.h });
  }

  // somewhere else on the screen, not too close
  function newTarget(w) {
    const wa = area(w);
    for (let i = 0; i < 8; i++) {
      const tx = rand(wa.x, wa.x + wa.width - w.box.w);
      const ty = rand(wa.y, wa.y + wa.height - w.box.h);
      if (Math.hypot(tx - w.x, ty - w.y) > 220 || i === 7) {
        w.target = { x: tx, y: ty };
        return;
      }
    }
  }
  function headingTo(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy) * 0.6) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'away' : 'toward';
  }

  function step(w) {
    if (w.win.isDestroyed()) return close(w.id);
    if (w.held) return;
    const now = Date.now();
    if (w.pauseUntil) {
      if (now < w.pauseUntil) return;
      w.pauseUntil = 0;
      newTarget(w);
    }
    const dx = w.target.x - w.x;
    const dy = w.target.y - w.y;
    const dist = Math.hypot(dx, dy);
    const speed = (w.asleep ? SPEED.sleepwalk : SPEED.walk) * w.k;
    const move = (speed * TICK) / 1000;
    if (dist <= move) {
      // there: stop for a bit, doing something
      w.x = w.target.x;
      w.y = w.target.y;
      place(w);
      const [gait, a, b] = pick(PAUSES[w.asleep ? 'asleep' : 'awake']);
      setGait(w, gait, gait === 'stand' || gait === 'sit' ? 'toward' : w.heading);
      w.pauseUntil = now + rand(a, b) * 1000;
      return;
    }
    w.x += (dx / dist) * move;
    w.y += (dy / dist) * move;
    setGait(w, w.asleep ? 'sleepwalk' : 'walk', headingTo(dx, dy));
    place(w);
  }

  // It's getting up to leave: the walker window is made now, hidden, so it's loaded and
  // drawn by the time the character has stood up and turned (go(), below).
  function prepare(id, { asleep = false } = {}) {
    if (walkers.has(id)) return walkers.get(id);
    const d = deskBounds(id);
    if (!d) return null;
    const k = sizeOf(id);
    const box = { w: Math.round(BOX.w * k), h: Math.round(BOX.h * k) };
    const x = d.x + d.width * 0.55 - box.w / 2; // (roughly; go() puts it exactly)
    const y = d.y + d.height * 0.85 - box.h * FEET;
    const win = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width: box.w,
      height: box.h,
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
      // it draws its first frame while still hidden, so it can appear exactly as the desk lets go
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'walker', 'index.html'), { query: { id } });
    guardNavigation(win);
    const w = { id, win, k, box, x, y, asleep, gait: '', heading: 'right', target: { x, y }, pauseUntil: 0, held: null };
    walkers.set(id, w);
    win.on('closed', () => {
      if (walkers.get(id) === w) {
        clearInterval(w.timer);
        walkers.delete(id);
        onChange?.();
      }
    });
    // it sets off walking right (as it turned at the desk)
    setGait(w, asleep ? 'sleepwalk' : 'walk', 'right');
    w.cancel = setTimeout(() => !w.going && close(id), 6000); // (the desk never said go)
    onChange?.();
    return w;
  }

  // Stood up and turned at the desk, feet on `feet` (desk-window px): put the walker's feet
  // on that very spot and take over as soon as it's drawn (at once, if it already is).
  function go(id, { asleep = false, feet } = {}) {
    const w = walkers.get(id) || prepare(id, { asleep });
    if (!w) return null;
    const d = deskBounds(id);
    if (feet && d) {
      w.x = d.x + feet.x - w.box.w / 2;
      w.y = d.y + feet.y - w.box.h * FEET;
      place(w);
    }
    w.going = true;
    const wa = area(w);
    w.target = { x: Math.min(w.x + rand(260, 520) * w.k, wa.x + wa.width - w.box.w), y: Math.min(Math.max(w.y + rand(-60, 60), wa.y), wa.y + wa.height - w.box.h) };
    if (w.ready) takeOver(w);
    else w.handoff = setTimeout(() => takeOver(w), 3000); // (if the page never says it's ready)
    return w;
  }

  // shown, and the desk lets go of its own, in the same moment
  function takeOver(w) {
    if (w.shown || w.win.isDestroyed()) return;
    w.shown = true;
    clearTimeout(w.handoff);
    clearTimeout(w.cancel);
    w.win.showInactive();
    const r = robots.get(w.id);
    if (r && !r.win.isDestroyed()) r.win.webContents.send('robot:action', 'handoff');
    w.timer = setInterval(() => step(w), TICK);
  }

  function close(id) {
    const w = walkers.get(id);
    if (!w) return;
    walkers.delete(id);
    clearInterval(w.timer);
    clearTimeout(w.handoff);
    clearTimeout(w.cancel);
    clearTimeout(w.docking);
    if (!w.win.isDestroyed()) w.win.close();
    onChange?.();
  }

  // Back at the desk: the desk shows its character first (it says 'docked' once it has),
  // then the walker goes, so it never blinks out in between.
  function dock(id) {
    const w = walkers.get(id);
    if (!w || w.docking) return;
    clearInterval(w.timer);
    w.held = null;
    const r = robots.get(id);
    if (!r || r.win.isDestroyed()) return close(id);
    // where its feet are, in desk-window px, so it stands there at the desk as the walker goes
    const d = r.win.getBounds();
    r.win.webContents.send('robot:action', `dock:${Math.round(w.x + w.box.w / 2 - d.x)},${Math.round(w.y + w.box.h * FEET - d.y)}`);
    w.docking = setTimeout(() => close(id), 800); // (if the desk never says so)
  }

  function idFromSender(event) {
    for (const [id, w] of walkers) if (!w.win.isDestroyed() && w.win.webContents === event.sender) return id;
    return null;
  }

  // dropped on its desk (its middle over the desk window)?
  function overDesk(w) {
    const d = deskBounds(w.id);
    if (!d) return false;
    const cx = w.x + w.box.w / 2;
    const cy = w.y + w.box.h * 0.6;
    const pad = 24;
    return cx > d.x - pad && cx < d.x + d.width + pad && cy > d.y - pad && cy < d.y + d.height + pad;
  }

  function registerIpc(ipcMain, { characterOf }) {
    // its first frame is drawn: take over from the desk (now, or once it's told to go)
    ipcMain.on('walker:ready', (event) => {
      const w = walkers.get(idFromSender(event));
      if (!w) return;
      w.ready = true;
      if (w.going) takeOver(w);
    });
    // only the character catches the mouse; the rest of the box lets clicks through
    ipcMain.on('walker:through', (event, through) => {
      const w = walkers.get(idFromSender(event));
      if (w && !w.win.isDestroyed()) w.win.setIgnoreMouseEvents(!!through, { forward: true });
    });
    ipcMain.handle('walker:init', (event) => {
      const id = idFromSender(event);
      const w = walkers.get(id);
      if (!w) return {};
      return { character: characterOf(id), gait: w.gait || 'stand', heading: w.heading, asleep: w.asleep };
    });
    // picked up and carried: it dangles; put down on its desk, it docks
    ipcMain.on('walker:drag', (event, { phase, dx = 0, dy = 0 }) => {
      const w = walkers.get(idFromSender(event));
      if (!w || w.docking) return;
      if (phase === 'start') {
        w.held = { x: w.x, y: w.y };
        w.pauseUntil = 0;
        setGait(w, 'dangle', 'toward');
      } else if (phase === 'move' && w.held) {
        w.x = w.held.x + dx;
        w.y = w.held.y + dy;
        place(w);
        const r = robots.get(w.id);
        // the desk lights up while it's over it (the desk page shows a "drop me here" glow)
        const over = overDesk(w);
        if (over !== w.over && r && !r.win.isDestroyed()) r.win.webContents.send('robot:action', over ? 'dock-hover' : 'dock-leave');
        w.over = over;
      } else if (phase === 'end' && w.held) {
        w.held = null;
        if (w.over || overDesk(w)) return dock(w.id);
        // put down elsewhere: keep it on the screen, then carry on
        const wa = area(w);
        w.x = Math.min(Math.max(w.x, wa.x), wa.x + wa.width - w.box.w);
        w.y = Math.min(Math.max(w.y, wa.y), wa.y + wa.height - w.box.h);
        place(w);
        setGait(w, 'land', 'toward');
        w.target = { x: w.x, y: w.y };
        w.pauseUntil = Date.now() + 1500;
      }
    });
    // a click (no drag): it waves at you
    ipcMain.on('walker:click', (event) => {
      const w = walkers.get(idFromSender(event));
      if (w) wave(w.id);
    });
  }

  function wave(id) {
    const w = walkers.get(id);
    if (!w || w.held) return;
    w.target = { x: w.x, y: w.y };
    setGait(w, w.asleep ? 'stand' : 'wave', 'toward');
    w.pauseUntil = Date.now() + 2000;
  }

  function setAsleep(id, asleep) {
    const w = walkers.get(id);
    if (!w || w.asleep === asleep) return;
    w.asleep = asleep;
    w.gait = ''; // re-send with the new mood
    setGait(w, w.pauseUntil ? 'stand' : asleep ? 'sleepwalk' : 'walk');
  }

  return {
    prepare,
    go,
    close,
    dock,
    wave,
    setAsleep,
    registerIpc,
    has: (id) => walkers.has(id),
    isOut: (id) => !!walkers.get(id)?.shown,
    windows: () => [...walkers.values()].map((w) => w.win),
    // the robot's look changed (Workshop): pass it on
    character(id, c) {
      const w = walkers.get(id);
      if (w) send(w, 'walker:character', c);
    },
    // the cursor, relative to the walker box (for its eyes)
    cursor(p) {
      for (const w of walkers.values()) send(w, 'walker:cursor', { x: p.x - w.x, y: p.y - w.y });
    },
  };
}

module.exports = { createWalkers };
