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
// the part of the box that's the character (around its feet and up its body), at size 1:
// the mouse there is caught (to pick it up), anywhere else in the box it goes through
const HIT = { halfW: 50, up: 190, down: 22 };
const TICK = 33; // ms
const SPEED = { walk: 70, sleepwalk: 32 }; // px/s at size 1
// what it does when it gets somewhere: [gait, min s, max s]
const PAUSES = {
  awake: [['stand', 1.5, 3.5], ['look', 2.5, 4], ['wave', 1.6, 2.2], ['sit', 5, 9]],
  asleep: [['stand', 2.5, 5], ['sit', 6, 11]],
};
// a stroll lasts this long (seconds), then it walks back to its desk by itself
// (put down somewhere else, it gets a fresh stroll from there)
const ROAM = [120, 240];
const BACK_LINES = ['Back to work! 💼', 'Break over!', 'Better get back to my desk…', 'OK, back to it! 💻'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);

// Besides wandering at random, a walker can run an errand (a visit to another robot's desk,
// main social.js): go(id, { to }) / walkTo(id, feet) walk it to a spot and call onArrive; it
// stands there (pose / say) till it's sent on; goHome(id) walks it back and docks it. Hooks:
// onClick(id) (true: handled, else it waves), onHeld(id) (picked up), onGone(id) (closed).
function createWalkers({ robots, sizeOf, preload, guardNavigation, onChange, onClick, onHeld, onGone }) {
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
  // Catch the mouse (to pick it up) only over the character. The page tells us as the mouse
  // moves (walker:through), but it only hears about moves while Windows forwards them to a
  // see-through window, and Windows can quietly stop doing that (after the PC sleeps, or when
  // it's busy): then the walker could never be grabbed again. So we work it out here too,
  // from the cursor position we already poll, and set it ourselves.
  function setThrough(w, through) {
    if (w.win.isDestroyed() || w.through === through) return;
    w.through = through;
    w.win.setIgnoreMouseEvents(through, { forward: true });
  }
  function overCharacter(w, p) {
    const fx = w.x + w.box.w / 2;
    const fy = w.y + w.box.h * FEET;
    return Math.abs(p.x - fx) < HIT.halfW * w.k && p.y > fy - HIT.up * w.k && p.y < fy + HIT.down * w.k;
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
    // the stroll's over: it heads back to its desk (not while on an errand or standing for one)
    if (w.roamUntil && now > w.roamUntil && !w.errand && w.pauseUntil !== Infinity) {
      w.roamUntil = 0;
      const feet = homeFeet(w);
      if (feet) {
        if (!w.asleep) send(w, 'walker:say', { text: pick(BACK_LINES), ms: 2200 });
        errandTo(w, feet, { onArrive: () => dock(w.id) });
      }
    }
    if (w.pauseUntil) {
      if (now < w.pauseUntil) return;
      w.pauseUntil = 0;
      newTarget(w);
    }
    const dx = w.target.x - w.x;
    const dy = w.target.y - w.y;
    const dist = Math.hypot(dx, dy);
    const speed = (w.asleep ? SPEED.sleepwalk : SPEED.walk) * w.k * (w.errand?.speedK || 1);
    const move = (speed * TICK) / 1000;
    if (dist <= move && w.errand) {
      // there on an errand: it stands (facing where it was told) till it's sent on
      const e = w.errand;
      w.errand = null;
      w.x = w.target.x;
      w.y = w.target.y;
      place(w);
      w.pauseUntil = Infinity;
      setGait(w, 'stand', e.face || 'toward');
      e.onArrive?.();
      return;
    }
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
    setGait(w, w.errand?.gait || (w.asleep ? 'sleepwalk' : 'walk'), headingTo(dx, dy));
    place(w);
  }

  // an errand: walk to where its feet should be (screen px), then onArrive
  function errandTo(w, feet, { gait, speedK = 1, face, onArrive } = {}) {
    w.errand = { gait, speedK, face, onArrive };
    w.target = { x: feet.x - w.box.w / 2, y: feet.y - w.box.h * FEET };
    w.pauseUntil = 0;
  }
  // where its feet go back to at its desk (where it stood up)
  function homeFeet(w) {
    const d = deskBounds(w.id);
    if (!d) return null;
    const f = w.home || { x: d.width * 0.55, y: d.height * 0.85 };
    return { x: d.x + f.x, y: d.y + f.y };
  }

  // It's getting up to leave: the walker window is made now, hidden, so it's loaded and
  // drawn by the time the character has stood up and turned (go(), below).
  // (a visitor with no desk, arrive(): `at` is where its feet start, `k` its size)
  function prepare(id, { asleep = false, at = null, k: size = 0 } = {}) {
    if (walkers.has(id)) return walkers.get(id);
    const d = deskBounds(id);
    if (!d && !at) return null;
    const k = size || sizeOf(id);
    const box = { w: Math.round(BOX.w * k), h: Math.round(BOX.h * k) };
    const x = at ? at.x - box.w / 2 : d.x + d.width * 0.55 - box.w / 2; // (roughly; go() puts it exactly)
    const y = at ? at.y - box.h * FEET : d.y + d.height * 0.85 - box.h * FEET;
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
  function go(id, { asleep = false, feet, errand } = {}) {
    const w = walkers.get(id) || prepare(id, { asleep });
    if (!w) return null;
    const d = deskBounds(id);
    if (feet && d) {
      w.x = d.x + feet.x - w.box.w / 2;
      w.y = d.y + feet.y - w.box.h * FEET;
      w.home = { x: feet.x, y: feet.y };
      place(w);
    }
    w.going = true;
    const wa = area(w);
    w.target = { x: Math.min(w.x + rand(260, 520) * w.k, wa.x + wa.width - w.box.w), y: Math.min(Math.max(w.y + rand(-60, 60), wa.y), wa.y + wa.height - w.box.h) };
    if (errand?.to) errandTo(w, errand.to, errand);
    w.roamUntil = errand ? 0 : Date.now() + rand(...ROAM) * 1000; // (an errand's own code sends it home)
    if (w.ready) takeOver(w);
    else w.handoff = setTimeout(() => takeOver(w), 3000); // (if the page never says it's ready)
    return w;
  }

  // A visitor that isn't one of your robots (the evening housemaid, main maid.js): it has no
  // desk, comes in with its feet at `from` (screen px), looks like `look` (a character's look),
  // can't be picked up (a click goes to onClick), and only goes where it's sent (walkTo).
  function arrive(id, { from, look, k = 1 } = {}) {
    if (walkers.has(id)) return walkers.get(id);
    const w = prepare(id, { at: from, k });
    if (!w) return null;
    clearTimeout(w.cancel);
    w.npc = true;
    w.look = look;
    w.going = true;
    w.pauseUntil = Infinity; // (standing, till it's sent somewhere)
    w.target = { x: w.x, y: w.y };
    if (w.ready) takeOver(w);
    else w.handoff = setTimeout(() => takeOver(w), 3000);
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
    onGone?.(id);
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
      if (w && !w.held) setThrough(w, !!through);
    });
    ipcMain.handle('walker:init', (event) => {
      const id = idFromSender(event);
      const w = walkers.get(id);
      if (!w) return {};
      return { character: w.look || characterOf(id), gait: w.gait || 'stand', heading: w.heading, asleep: w.asleep };
    });
    // picked up and carried: it dangles; put down on its desk, it docks
    ipcMain.on('walker:drag', (event, { phase, dx = 0, dy = 0 }) => {
      const w = walkers.get(idFromSender(event));
      if (!w || w.docking || w.npc) return; // (a visitor can't be carried off)
      if (phase === 'start') {
        w.held = { x: w.x, y: w.y };
        if (w.errand || w.pauseUntil === Infinity) onHeld?.(w.id);
        w.errand = null;
        setThrough(w, false); // carried: it keeps the mouse till it's put down
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
        w.roamUntil = Date.now() + rand(...ROAM) * 1000; // (a fresh stroll from where it was put)
      }
    });
    // a click (no drag): it waves at you
    ipcMain.on('walker:click', (event) => {
      const w = walkers.get(idFromSender(event));
      if (w && !onClick?.(w.id)) wave(w.id);
    });
  }

  // dreaming of one of your words mid-sleepwalk: it stops, stands swaying, and mumbles it
  function dream(id, word) {
    const w = walkers.get(id);
    if (!w || w.held || w.docking || !w.asleep) return false;
    w.target = { x: w.x, y: w.y };
    setGait(w, 'stand', 'toward');
    w.pauseUntil = Date.now() + 9000; // (a nice long pause while the dream bubble is up)
    send(w, 'walker:dream', { word });
    return true;
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
    arrive,
    close,
    dock,
    wave,
    /** Walk (on an errand) to where its feet should be, then onArrive; it stands there after. */
    walkTo(id, feet, opts = {}) {
      const w = walkers.get(id);
      if (!w || w.held || w.docking) return false;
      errandTo(w, feet, opts);
      return true;
    },
    /** Walk back to its desk and dock there. */
    goHome(id, { gait, speedK = 1 } = {}) {
      const w = walkers.get(id);
      if (!w || w.held || w.docking) return false;
      const feet = homeFeet(w);
      if (!feet) return dock(id), true;
      errandTo(w, feet, { gait, speedK, onArrive: () => dock(id) });
      return true;
    },
    /** While it stands on an errand: what it does (talk, clap, wave, stand) and which way it faces. */
    pose(id, gait, heading) {
      const w = walkers.get(id);
      if (!w || w.held || w.docking || w.errand) return;
      w.target = { x: w.x, y: w.y };
      w.pauseUntil = Infinity;
      setGait(w, gait, heading || w.heading);
    },
    /** A speech bubble over its head for ms. */
    say(id, text, ms = 2600) {
      const w = walkers.get(id);
      if (w) send(w, 'walker:say', { text: String(text || ''), ms });
    },
    /** Where its feet are now (screen px), or null. */
    feet(id) {
      const w = walkers.get(id);
      return w ? { x: w.x + w.box.w / 2, y: w.y + w.box.h * FEET } : null;
    },
    onErrand: (id) => !!walkers.get(id)?.errand,
    setAsleep,
    registerIpc,
    has: (id) => walkers.has(id),
    isOut: (id) => !!walkers.get(id)?.shown,
    // out for a walk asleep (sleepwalking), and not being carried
    isSleepwalking: (id) => {
      const w = walkers.get(id);
      return !!(w?.shown && w.asleep && !w.held && !w.docking);
    },
    dream,
    // where it is on screen (out walking), or null
    bounds(id) {
      const w = walkers.get(id);
      return w?.shown && !w.win.isDestroyed() ? w.win.getBounds() : null;
    },
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
    // every tick of the cursor poll, moved or not (it walks under a still mouse too)
    hover(p) {
      for (const w of walkers.values()) if (w.shown && !w.held && !w.docking) setThrough(w, !overCharacter(w, p));
    },
    // the PC woke up, the screen was unlocked or a screen came or went: back on a screen
    // you can see, on top, and the mouse worked out afresh
    recover() {
      for (const w of walkers.values()) {
        if (!w.shown || w.win.isDestroyed()) continue;
        const wa = area(w);
        w.x = Math.min(Math.max(w.x, wa.x), wa.x + wa.width - w.box.w);
        w.y = Math.min(Math.max(w.y, wa.y), wa.y + wa.height - w.box.h);
        if (w.held) w.held = null; // (a drag cut short by the sleep)
        w.target = { x: w.x, y: w.y };
        w.pauseUntil = Date.now() + 1500;
        place(w);
        w.through = undefined; // set it again, whatever we last thought it was
        setThrough(w, true);
        w.win.setAlwaysOnTop(true, 'floating');
        w.win.showInactive();
      }
    },
  };
}

module.exports = { createWalkers };
