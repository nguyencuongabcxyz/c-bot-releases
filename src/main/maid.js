const { screen, powerMonitor } = require('electron');

// The evening housemaid: at 5 pm on workdays a housemaid robot (not one of yours) comes in from
// the edge of the screen and goes round the desks, left to right. At each one she dusts with
// her feather duster (sparkles all over the desk), sweeps under it and empties the bin, and the
// robot there reacts (robot.js 'tidy'): free, it lifts its feet for her and thanks her; busy or
// with its chat open, it carries on; asleep, she tiptoes round it; out for a walk, she tidies the
// empty desk. Then she says good night and leaves by the nearest edge. Once a day; if you're
// away at 5 she comes when you're back, until half past six. Her walk is a walker with no desk
// (walker.js arrive); store.settings.maid === false turns her off, maidDay is the day she came.
//   createMaid({ robots, store, walkers, sendToRobot, deskRect, sizeOf, sizes, statusOf, thanksOf, busy, presenting })
//     sizeOf(id): its size ('small'…), sizes: their scales
//     statusOf(id): { awake, busy, chat, away } (social.js reports); thanksOf(id): its thank-you
//     line; busy(): something else is going on (a visit, a card open): she waits
//   maid.start() (now, whatever the time) · maid.active() · maid.clicked(id) · maid.gone(id)

const ID = 'maid';
const FROM = 17 * 60; // 17:00
const UNTIL = 18 * 60 + 30; // (you were away at five: she still comes till half past six)
const AWAY_AFTER = 120; // s without touching mouse or keyboard: you're not there to see her
const TICK = 30 * 1000;
const DUST_MS = 7000; // at each desk
const LOOK = {
  name: 'Housemaid',
  staff: true, // (on duty: never in a hoodie or a nightcap, walker page)
  tag: '🧹 Housekeeping', // (her name tag, at her feet)
  color: '#ffb3cf', // (a soft pink robot in the classic black-and-white uniform)
  body: 'kit',
  theme: 'classic',
  size: 'normal',
  accessory: 'maidcap',
  kit: {
    head: 'ball', face: 'cute', top: 'none', body: 'egg', arms: 'mitten', base: 'legs', finish: 'glossy',
    clothes: 'maid', neck: 'none', extra: 'duster', specs: 'none',
    second: '#ffffff', accent: '#ff6fa5', eye: '', cloth: '#1d2235', hair: '#5a3a22',
  },
};
const LINES = {
  free: ['Evening clean-up! 🧹', 'Feet up, please! 🧹', 'Time for a little tidy! ✨'],
  chat: ['Just a quick dust! 🧹', 'Don’t mind me! ✨'],
  busy: ['Don’t mind me, keep going! 🧹', 'I’ll work around you! ✨'],
  asleep: ['Shh… 🤫', 'Sleep tight, I’ll be quick…'],
  away: ['Nobody home? I’ll tidy anyway! 🧹', 'Out for a walk? A clean desk for when you’re back!'],
  done: ['All sparkly! ✨', 'There, spotless! 🌟', 'Much better! ✨'],
  bye: ['Good night, everyone! 🌙', 'See you tomorrow! 👋', 'All tidy! Have a nice evening! 🌙'],
  click: ['Almost done! ✨', 'Mind the duster! 🧹', 'A tidy desk, a tidy mind!', 'Hi there! Just tidying up 🧹'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const today = () => new Date().toDateString();

function createMaid({ robots, store, walkers, sendToRobot, deskRect, sizeOf, sizes = { normal: 1 }, statusOf, thanksOf, busy = () => false, presenting = () => false }) {
  let round = null; // { ids, i, timers }
  let locked = false;
  powerMonitor.on('lock-screen', () => (locked = true));
  powerMonitor.on('unlock-screen', () => (locked = false));

  const tell = (id, payload) => sendToRobot(id, 'robot:social', payload);
  const later = (ms, fn) => round?.timers.push(setTimeout(fn, ms));
  const showing = (id) => {
    const r = robots.get(id);
    return r && !r.win.isDestroyed() && r.win.isVisible();
  };

  /** Her round, now. False when there's no desk to tidy or she's already about. */
  function start() {
    if (round || walkers.has(ID)) return false;
    // the desks on the screen of the first one, left to right
    const all = [...robots.keys()].filter(showing).filter((id) => deskRect(id));
    if (!all.length) return false;
    all.sort((a, b) => deskRect(a).x - deskRect(b).x);
    const first = deskRect(all[0]);
    const wa = screen.getDisplayNearestPoint({ x: first.x + first.width / 2, y: first.y + first.height / 2 }).workArea;
    const ids = all.filter((id) => {
      const r = deskRect(id);
      return screen.getDisplayNearestPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }).workArea.x === wa.x;
    });
    // as big as the smallest robot, so she doesn't tower over them
    const size = ids.map((id) => sizeOf(id)).sort((a, b) => (sizes[a] || 1) - (sizes[b] || 1))[0] || 'normal';
    const k = sizes[size] || 1;
    const from = { x: wa.x + 30 * k, y: Math.min(first.y + first.height * 0.93, wa.y + wa.height - 8) };
    if (!walkers.arrive(ID, { from, look: { ...LOOK, size }, k })) return false;
    round = { ids, i: 0, timers: [], wa };
    store.updateSettings({ maidDay: today() });
    later(1200, next);
    return true;
  }

  // on to the next desk (from the left, she stands on its left; the last one, she leaves)
  function next() {
    if (!round) return;
    const id = round.ids[round.i];
    if (id === undefined) return leave();
    const r = deskRect(id);
    if (!r || !showing(id)) {
      round.i++;
      return next();
    }
    // (at the desk's left end, a little back, facing it: she reaches up and wipes the clear end of
    // the desk top, left of the robot)
    const spot = { x: r.x + r.width * 0.1, y: r.y + r.height * 0.87 };
    if (!walkers.walkTo(ID, spot, { face: 'right', onArrive: () => tidy(id) })) end();
  }

  function tidy(id) {
    if (!round) return;
    round.at = id;
    const s = statusOf(id) || {};
    const mood = s.away ? 'away' : !s.awake ? 'asleep' : s.busy ? 'busy' : s.chat ? 'chat' : 'free';
    walkers.say(ID, pick(LINES[mood]), 2400);
    tell(id, { phase: 'tidy', side: 'L', mood, thanks: thanksOf(id) });
    later(500, () => walkers.pose(ID, 'dust', 'right'));
    later(DUST_MS, () => {
      walkers.pose(ID, 'stand', 'toward'); // (turns round to say so)
      walkers.say(ID, pick(LINES.done), 1800);
      tell(id, { phase: 'tidy-end' });
      round.at = null;
    });
    later(DUST_MS + 1700, () => {
      round.i++;
      next();
    });
  }

  // good night, and off by the nearest edge of the screen
  function leave() {
    const feet = walkers.feet(ID);
    if (!feet || !round) return end();
    const wa = round.wa;
    const right = feet.x - wa.x > wa.x + wa.width - feet.x;
    walkers.say(ID, pick(LINES.bye), 2400);
    later(900, () => {
      const to = { x: right ? wa.x + wa.width - 20 : wa.x + 20, y: feet.y };
      if (!walkers.walkTo(ID, to, { onArrive: () => walkers.close(ID) })) end();
    });
  }

  // her round is over (or cut short): the desk she was at stops sparkling
  function end() {
    if (!round) return;
    for (const t of round.timers) clearTimeout(t);
    if (round.at) tell(round.at, { phase: 'tidy-end' });
    round = null;
    walkers.close(ID);
  }

  // 5 pm on a workday, she hasn't been today, and you're there to see her
  function due() {
    if (store.settings.maid === false || store.settings.maidDay === today()) return false;
    const now = new Date();
    if (!(store.settings.notesWorkdays || [1, 2, 3, 4, 5]).includes(now.getDay())) return false;
    const m = now.getHours() * 60 + now.getMinutes();
    if (m < FROM || m >= UNTIL) return false;
    return !locked && powerMonitor.getSystemIdleTime() < AWAY_AFTER && !presenting();
  }
  const timer = setInterval(() => due() && !busy() && start(), TICK);
  timer.unref?.();

  return {
    start,
    active: () => !!round,
    /** A click on her: a cheery word (true: handled). */
    clicked(id) {
      if (id !== ID) return false;
      walkers.say(ID, pick(LINES.click), 1800);
      return true;
    },
    /** Her walker window closed. */
    gone(id) {
      if (id === ID && round) end();
    },
    isMaid: (id) => id === ID,
    due, // (for the tests)
    stop() {
      clearInterval(timer);
      end();
    },
  };
}

module.exports = { createMaid, MAID_ID: ID };
