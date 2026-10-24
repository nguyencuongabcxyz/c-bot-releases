const { powerMonitor, screen } = require('electron');

// The office manager: robots noticing each other. Every robot tells us how it is (robot.js
// social:report, every few seconds: awake, busy, chat open, idle for how long, free for an
// antic), and what just happened to it (a task done, dozed off). From that we decide:
//   wave        two idle robots on the same screen: one turns and waves, the other waves back
//   clap        a robot finishes a task: the idle ones turn to it and clap
//   yawn        a robot dozes off: idle neighbours yawn (and one idle a while dozes off sooner)
//   dance       a vocab milestone: every free robot dances, not just the one that caught it
//   visit       a bored robot walks over to another desk (main walker.js errands) and
//                 chats (the host awake and free: lines in both their personalities),
//                 watches over its shoulder (the host at work: cheers it on quietly), or
//                 tiptoes over (the host asleep: leaves a "came by" sticky on its monitor)
//   office life, at the right time of day, once a day each (workdays):
//     lunch order  10:30-11:40: it walks over: "Lunch order?" / "Bún chả for me!" / "Ordered!";
//                  the food comes to both desks a few minutes later and they eat
//     lunch out    11:40-12:30: "Wanna go out for lunch?" / "Yes!": both walk off to a spot
//                  on the screen, sit side by side chatting, and walk back
//     milk tea     14:00-16:00: it goes desk to desk taking orders (the usual for a busy
//                  one); a few minutes later everyone's milk tea comes and they drink
//   paper plane a bored robot throws one at another (main plane.js flies it across the
//                 screen): caught and read out if the other's free, else it lands on its desk
//                 and gets read later (then it waves over); now and then one misses and lands
//                 on your desktop for a moment
// None of it while you're using a robot (its chat, a card, the notebook, Quick actions), while
// you're away, the screen's locked or Windows says you're busy (a meeting, fullscreen, Focus).
// Your click, a task or a hotkey that needs a visitor sends it home ("Gotta go!"), and a
// visit ends early if the host gets busy or you start using it. Settings: socialising
// 'often' | 'sometimes' (the default) | 'never'.

const TICK = 6000;
const FRESH = 20_000; // a robot's report is this old at most
const AWAY_AFTER = 120; // s without touching mouse or keyboard: you're not there
const WAVE_PAIR_GAP = 3 * 60_000;
const VISIT_ROBOT_GAP = 10 * 60_000;
const VISIT_GAP = { often: 2 * 60_000, sometimes: 4 * 60_000 }; // between any two visits
const CLAP_GAP = 60_000;
const NEAR = 1500; // px between desks, for a wave across the screen
const LINE_GAP = 2800; // ms between lines of a chat
const PLANE_ROBOT_GAP = 10 * 60_000;
const PLANE_GAP = { often: 90_000, sometimes: 3 * 60_000 }; // between any two planes
const THROW_AT = 1000; // ms into its throw that the plane leaves its hand (antics/social.js)
// office life: when (minutes into the day), and how long the delivery takes
const SCENES = { order: [630, 700], goout: [700, 750], tea: [840, 960] };
const DELIVERY = { food: 8 * 60_000, tea: 6 * 60_000 };
const today = () => new Date().toDateString();
const WATCH_MAX = 45_000;

const pick = (arr) => (Array.isArray(arr) ? arr[Math.floor(Math.random() * arr.length)] : arr);

// (robotRect: where a robot is on screen, out walking or at its desk; deskRect: its desk)
function createSocial({ robots, store, walkers, planes, personalityOf, nameOf, sendToRobot, robotRect, deskRect = robotRect, appBusy, acceptsNotifications }) {
  const reports = new Map(); // id -> { awake, busy, chat, idleMs, free, away, wanders, at }
  const lastWave = new Map(); // "a|b" -> time
  const lastVisitOf = new Map(); // id -> time
  const lastClap = new Map(); // id -> time
  let lastVisit = 0;
  const lastPlaneOf = new Map(); // thrower id -> time
  let lastPlane = 0;
  let inFlight = null; // { a, b }
  const deskPlanes = new Map(); // id -> who threw the plane on its desk (it's read later)
  const sceneDay = { lunch: '', tea: '' }; // the day lunch / the milk tea round last happened
  let visit = null; // { a, b, mode, side, phase, timers: [] }
  let locked = false;
  powerMonitor.on('lock-screen', () => (locked = true));
  powerMonitor.on('unlock-screen', () => (locked = false));

  const level = () => store.settings.socialising || 'sometimes';
  const k = () => (level() === 'often' ? 2 : 1);
  const present = () => !locked && powerMonitor.getSystemIdleTime() < AWAY_AFTER && acceptsNotifications();
  const tell = (id, payload) => sendToRobot(id, 'robot:social', payload);
  const line = (id, key, other) => String(pick(personalityOf(id)?.social?.[key]) || '').replace(/\{other\}/g, nameOf(other) || 'friend');
  // two different lines of a kind (or the one twice, if that's all there is)
  function twoLines(id, key, other) {
    const first = line(id, key, other);
    let second = line(id, key, other);
    for (let i = 0; i < 8 && second === first; i++) second = line(id, key, other);
    return [first, second];
  }

  // robots that are out on the desktop and have told us lately how they are
  function live() {
    const now = Date.now();
    return [...robots.keys()].filter((id) => {
      const r = robots.get(id);
      const rep = reports.get(id);
      return r && !r.win.isDestroyed() && r.win.isVisible() && rep && now - rep.at < FRESH;
    });
  }
  const rep = (id) => reports.get(id) || {};
  const atDesk = (id) => !rep(id).away && !walkers.has(id);
  // free for a little reaction at its desk (awake, idle, not in your hands)
  const freeAwake = (id) => atDesk(id) && rep(id).awake && rep(id).free && !rep(id).chat;
  function centre(id) {
    const r = robotRect(id);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }
  function sameScreen(a, b) {
    const ca = centre(a);
    const cb = centre(b);
    return !!(ca && cb && screen.getDisplayNearestPoint(ca).id === screen.getDisplayNearestPoint(cb).id);
  }
  const dist = (a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    return ca && cb ? Math.hypot(ca.x - cb.x, ca.y - cb.y) : Infinity;
  };
  // which side of `from`'s screen `to` is on
  const sideOf = (from, to) => ((centre(to)?.x ?? 0) < (centre(from)?.x ?? 0) ? 'L' : 'R');

  // ---------------------------------------------------------------- the reports

  function report(id, r = {}) {
    if (r.kind === 'done') return onDone(id);
    if (r.kind === 'slept') return onSlept(id);
    if (r.kind === 'decline') {
      if (visit?.a === id) return endVisit('declined');
      // asked out to lunch, but it can't come (busy, or it stays at its desk)
      if (visit?.b === id && visit.mode === 'goout') {
        walkers.say(visit.a, line(visit.a, 'goOutBusy', id), 2200);
        visit.phase = 'there';
        return later(1600, () => homeward());
      }
      return;
    }
    if (r.kind === 'plane-read') return planeRead(id);
    reports.set(id, { ...rep(id), ...r, at: Date.now() });
  }

  // ---------------------------------------------------------------- reactions

  function onDone(id) {
    const now = Date.now();
    // the visitor watching it work cheers, and goes home
    if (visit && visit.b === id && visit.mode === 'watch' && visit.phase === 'there') {
      walkers.say(visit.a, line(visit.a, 'clap', id), 2400);
      walkers.pose(visit.a, 'clap', visit.face);
      later(2600, () => homeward());
    }
    if (level() === 'never' || appBusy()) return;
    for (const o of live()) {
      if (o === id || isInVisit(o) || !freeAwake(o) || !sameScreen(o, id)) continue;
      if (now - (lastClap.get(o) || 0) < CLAP_GAP) continue;
      lastClap.set(o, now);
      tell(o, { phase: 'clap', side: sideOf(o, id), text: Math.random() < 0.45 ? line(o, 'clap', id) : '' });
    }
  }

  function onSlept(id) {
    if (level() === 'never' || appBusy()) return;
    for (const o of live()) {
      if (o === id || isInVisit(o) || !freeAwake(o) || dist(o, id) > NEAR) continue;
      if (Math.random() < 0.5) tell(o, { phase: 'yawn', side: sideOf(o, id), sleepSoon: rep(o).idleMs > 90_000 && Math.random() < 0.5 });
    }
  }

  /** A vocab milestone at robot id (main checkMilestones): the others dance too. */
  function milestone(id) {
    if (level() === 'never') return;
    for (const o of live()) if (o !== id && !isInVisit(o) && freeAwake(o)) tell(o, { phase: 'dance' });
  }

  function tryWave(now) {
    const free = live().filter((id) => freeAwake(id) && rep(id).idleMs > 15_000 && !isInVisit(id));
    for (const a of free) {
      for (const b of free) {
        if (a >= b || !sameScreen(a, b) || dist(a, b) > NEAR) continue;
        const key = `${a}|${b}`;
        if (now - (lastWave.get(key) || 0) < WAVE_PAIR_GAP) continue;
        if (Math.random() > 0.05 * k()) continue;
        lastWave.set(key, now);
        const [x, y] = Math.random() < 0.5 ? [a, b] : [b, a];
        tell(x, { phase: 'wave', side: sideOf(x, y) });
        setTimeout(() => tell(y, rep(y).awake ? { phase: 'wave-back', side: sideOf(y, x) } : { phase: 'stir' }), 900);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- visits

  const isInVisit = (id) => !!visit && (visit.a === id || visit.b === id);
  function later(ms, fn) {
    if (!visit) return;
    visit.timers.push(setTimeout(() => visit && fn(), ms));
  }

  function tryVisit(now) {
    if (visit || now - lastVisit < (VISIT_GAP[level()] || VISIT_GAP.sometimes)) return false;
    const ids = live();
    const visitors = ids.filter((id) => freeAwake(id) && rep(id).wanders !== false && rep(id).idleMs >= 60_000 && now - (lastVisitOf.get(id) || 0) > VISIT_ROBOT_GAP);
    for (const a of visitors) {
      if (Math.random() > 0.3 * k()) continue;
      const hosts = ids.filter((b) => b !== a && atDesk(b) && !rep(b).chat && sameScreen(a, b));
      const b = pick(hosts);
      if (!b) continue;
      start(a, b, rep(b).busy ? 'watch' : rep(b).awake ? 'chat' : 'tiptoe');
      return true;
    }
    return false;
  }

  /**
   * Send a over to b's desk (mode: 'chat' | 'watch' | 'tiptoe'; else from how b is), or an office
   * scene: 'order' (lunch), 'goout' (lunch together), 'tea' (b, then opts.stops, desk to desk).
   * opts.delivery: ms till the food / tea comes.
   */
  function start(a, b, mode, opts = {}) {
    if (visit || a === b || !robots.has(a) || !robots.has(b) || !atDesk(b)) return false;
    mode ||= rep(b).busy ? 'watch' : rep(b).awake ? 'chat' : 'tiptoe';
    const side = sideOf(b, a); // the side of b's desk it comes from, and stands on
    visit = { a, b, mode, side, face: side === 'L' ? 'right' : 'left', phase: 'out', timers: [], delivery: opts.delivery, stops: [...(opts.stops || [])], ordered: [a] };
    lastVisit = Date.now();
    lastVisitOf.set(a, Date.now());
    tell(a, { phase: 'visit', host: nameOf(b), mode });
    tell(b, { phase: 'hosting', on: true }); // (it stays at its desk till the visitor's gone)
    // (it never set off: it's sitting tight)
    later(9000, () => visit.phase === 'out' && !walkers.isOut(a) && endVisit('never left'));
    return true;
  }

  // where the visitor's feet go: beside the host's desk, on the side it came from
  function spot() {
    const r = robotRect(visit.b);
    if (!r) return null;
    return { x: r.x + r.width * (visit.side === 'L' ? 0.1 : 0.9), y: r.y + r.height * 0.93 };
  }

  /** The visitor is off (robot:wander): its errand there, or null when it's just wandering. */
  function errandFor(id) {
    // asked out to lunch: its walk to the spot beside the visitor
    if (visit?.mode === 'goout' && visit.phase === 'outing' && visit.b === id && visit.spotB) {
      visit.out.add(id);
      return { to: visit.spotB, face: visit.faceB, onArrive: () => sitDown(id) };
    }
    if (!visit || visit.a !== id || visit.phase !== 'out') return null;
    const to = spot();
    if (!to) return null;
    visit.phase = 'walking';
    const tiptoe = visit.mode === 'tiptoe';
    return { to, gait: tiptoe ? 'tiptoe' : 'walk', speedK: tiptoe ? 0.6 : 1, face: visit.face, onArrive: arrived };
  }

  function arrived() {
    if (!visit) return;
    const { a, b } = visit;
    visit.phase = 'there';
    visit.arrivedAt = Date.now();
    // things may have changed on the way
    if (visit.mode === 'chat' && rep(b).busy) visit.mode = 'watch';
    if (visit.mode === 'chat' && !rep(b).awake) visit.mode = 'tiptoe';
    if (visit.mode === 'tiptoe' && rep(b).awake) visit.mode = 'chat';
    const mine = visit.side; // b turns to the side the visitor stands on
    if (visit.mode === 'chat') {
      tell(b, { phase: 'listen', side: mine });
      const lines = [
        [a, line(a, 'hi', b)],
        [b, line(b, 'reply', a)],
        [a, line(a, 'bye', b)],
      ];
      lines.forEach(([who, text], i) => {
        later(400 + i * LINE_GAP, () => {
          if (who === a) {
            walkers.pose(a, 'talk', visit.face);
            walkers.say(a, text, LINE_GAP - 200);
            later(LINE_GAP - 300, () => walkers.pose(a, 'stand', visit.face));
          } else tell(b, { phase: 'say', text });
        });
      });
      later(400 + lines.length * LINE_GAP, () => {
        walkers.pose(a, 'wave', visit.face);
        tell(b, { phase: 'listen-end', wave: true });
      });
      later(400 + lines.length * LINE_GAP + 1300, () => homeward());
    } else if ((visit.mode === 'order' || visit.mode === 'goout') && !freeAwake(b)) {
      // it got busy (or dozed off) while the visitor walked over: maybe next time
      talk(a, line(a, 'goOutBusy', b));
      later(1800, () => homeward());
    } else if (visit.mode === 'order' || visit.mode === 'goout') {
      // lunch: "order?" / "yes, …" / "ordered!" — or "go out?" / "yes!" and off they go
      tell(b, { phase: 'listen', side: mine });
      const lines = visit.mode === 'order'
        ? [[a, line(a, 'lunchAsk', b)], [b, line(b, 'lunchDish', a)], [a, line(a, 'lunchOrdered', b)]]
        : [[a, line(a, 'goOut', b)], [b, line(b, 'goOutYes', a)]];
      lines.forEach(([who, text], i) => later(400 + i * LINE_GAP, () => talk(who, text)));
      const after = 400 + lines.length * LINE_GAP;
      if (visit.mode === 'order') {
        later(after, () => {
          walkers.pose(a, 'wave', visit.face);
          tell(b, { phase: 'listen-end', wave: true });
          deliver([a, b], 'food');
          sceneDay.lunch = today();
        });
        later(after + 1300, () => homeward());
      } else later(after - 600, () => goOut());
    } else if (visit.mode === 'tea') {
      // milk tea: takes this desk's order (the usual for a busy one), then on to the next
      const wantsTea = freeAwake(b);
      if (wantsTea) {
        tell(b, { phase: 'listen', side: mine });
        later(400, () => talk(a, line(a, 'teaAsk', b)));
        later(400 + LINE_GAP, () => talk(b, line(b, 'teaOrder', a)));
        visit.ordered.push(b);
      } else if (rep(b).busy) {
        later(400, () => talk(a, line(a, 'teaUsual', b)));
        visit.ordered.push(b);
      }
      later(wantsTea ? 400 + 2 * LINE_GAP : 400 + LINE_GAP, () => nextTeaStop());
    } else if (visit.mode === 'watch') {
      walkers.pose(a, 'stand', visit.face);
      const cheer = (n) =>
        later(n ? 6500 : 1200, () => {
          walkers.say(a, line(a, 'watch', b), 2400);
          walkers.pose(a, 'clap', visit.face);
          later(2200, () => walkers.pose(a, 'stand', visit.face));
          if (n < 5) cheer(n + 1);
        });
      cheer(0);
      later(WATCH_MAX, () => homeward());
    } else {
      // tiptoe: a sticky on its monitor, and back without waking it
      walkers.pose(a, 'stand', visit.face);
      walkers.say(a, line(a, 'tiptoe', b), 2200);
      tell(b, { phase: 'visit-note', from: nameOf(a), found: line(b, 'found', a) });
      later(2600, () => homeward({ gait: 'tiptoe', speedK: 0.6 }));
    }
  }

  // one line of a scene: the walker's bubble (and hands), or the robot at its desk
  function talk(who, text) {
    if (!visit || !text) return;
    if (walkers.has(who)) {
      const sitting = visit.phase === 'sitting';
      walkers.pose(who, sitting ? 'sit' : 'talk', who === visit.a ? visit.face : visit.faceB);
      walkers.say(who, text, LINE_GAP - 200);
      if (!sitting) later(LINE_GAP - 300, () => walker(who) && walkers.pose(who, 'stand', who === visit.a ? visit.face : visit.faceB));
    } else tell(who, { phase: 'say', text });
  }
  const walker = (id) => walkers.has(id);

  // lunch out: b gets up too, and both walk to a spot between their desks
  function goOut() {
    const { a, b } = visit;
    tell(b, { phase: 'listen-end' });
    // (between their desks: the visitor's out walking already, its desk is where it came from)
    const ra = deskRect(a);
    const rb = deskRect(b);
    if (!ra || !rb) return homeward();
    const wa = screen.getDisplayNearestPoint({ x: ra.x, y: ra.y }).workArea;
    const mid = (ra.x + ra.width / 2 + rb.x + rb.width / 2) / 2;
    const y = Math.min(Math.max(ra.y + ra.height, rb.y + rb.height) - 10, wa.y + wa.height - 12);
    const aLeft = ra.x < rb.x;
    visit.spotA = { x: mid + (aLeft ? -58 : 58), y };
    visit.spotB = { x: mid + (aLeft ? 58 : -58), y };
    visit.face = aLeft ? 'right' : 'left';
    visit.faceB = aLeft ? 'left' : 'right';
    visit.phase = 'outing';
    visit.out = new Set([a]);
    visit.there = new Set();
    walkers.walkTo(a, visit.spotA, { face: visit.face, onArrive: () => sitDown(a) });
    tell(b, { phase: 'go-out', with: nameOf(a) }); // (it gets up: robot:wander asks errandFor for its walk)
    later(12000, () => visit.phase === 'outing' && !walkers.isOut(b) && homeward()); // (it never came)
  }
  function sitDown(id) {
    if (!visit) return;
    visit.there.add(id);
    walkers.pose(id, 'sit', id === visit.a ? visit.face : visit.faceB);
    if (visit.there.size < 2) return;
    // both there: lunch, side by side, chatting
    visit.phase = 'sitting';
    const { a, b } = visit;
    const [a1, a2] = twoLines(a, 'lunchChat', b); // (never the same line twice)
    const [b1, b2] = twoLines(b, 'lunchChat', a);
    const said = [a1, b1, a2, b2];
    said.forEach((text, i) => later(1500 + i * (LINE_GAP + 600), () => talk(i % 2 ? b : a, text)));
    later(1500 + said.length * (LINE_GAP + 600) + 800, () => homeward());
  }

  // the milk tea round: the next desk, or home with everyone's order in
  function nextTeaStop() {
    if (!visit) return;
    tell(visit.b, { phase: 'listen-end' });
    tell(visit.b, { phase: 'hosting', on: false });
    const next = visit.stops.find((x) => robots.has(x) && atDesk(x) && !rep(x).chat);
    visit.stops = visit.stops.filter((x) => x !== next);
    if (!next) {
      talk(visit.a, line(visit.a, 'teaOrdered', visit.b));
      deliver(visit.ordered, 'tea');
      sceneDay.tea = today();
      return later(LINE_GAP, () => homeward());
    }
    visit.b = next;
    visit.side = sideOf(next, visit.a);
    visit.face = visit.side === 'L' ? 'right' : 'left';
    visit.phase = 'walking';
    tell(next, { phase: 'hosting', on: true });
    const to = spot();
    if (!to || !walkers.walkTo(visit.a, to, { face: visit.face, onArrive: arrived })) homeward();
  }

  // the food / the milk tea comes, a few minutes later, to every robot in on it
  function deliver(ids, kind) {
    const ms = visit?.delivery ?? DELIVERY[kind];
    setTimeout(() => {
      for (const id of new Set(ids)) if (robots.has(id)) tell(id, { phase: 'treat', kind, text: line(id, kind === 'food' ? 'lunchArrived' : 'teaArrived') });
    }, ms);
  }

  function homeward(opts = {}) {
    if (!visit || visit.phase === 'home') return;
    const out = visit.mode === 'goout' && visit.out;
    visit.phase = 'home';
    if (visit.mode === 'chat') tell(visit.b, { phase: 'listen-end' });
    walkers.goHome(visit.a, opts);
    if (out && walkers.has(visit.b)) walkers.goHome(visit.b, opts);
  }

  // the visit's over (home and docked, picked up, called back, or it never left)
  function endVisit(why) {
    if (!visit) return;
    for (const t of visit.timers) clearTimeout(t);
    if (visit.mode === 'chat') tell(visit.b, { phase: 'listen-end' });
    tell(visit.a, { phase: 'visit-over', why });
    if (visit.mode === 'goout') tell(visit.b, { phase: 'visit-over', why });
    tell(visit.b, { phase: 'hosting', on: false });
    visit = null;
  }

  // a visit that should end early: you're using the host or the visitor, or the host got busy
  function check() {
    if (!visit || visit.phase !== 'there') return;
    const { a, b } = visit;
    if (!atDesk(b)) return homeward(); // (the host's gone off: nobody to visit)
    if (rep(b).chat || (visit.mode === 'chat' && rep(b).busy)) {
      walkers.say(a, line(a, rep(b).chat ? 'gotta' : 'busy', b), 1800);
      later(1200, () => homeward({ speedK: 1.4 }));
    } else if (visit.mode === 'watch' && !rep(b).busy && Date.now() - visit.arrivedAt > 3000) {
      // its task ended without a "done" (stopped, an error): back home
      later(800, () => homeward());
    }
  }

  // ---------------------------------------------------------------- paper planes

  function tryPlane(now) {
    if (inFlight || now - lastPlane < (PLANE_GAP[level()] || PLANE_GAP.sometimes)) return false;
    const ids = live();
    const throwers = ids.filter((id) => freeAwake(id) && rep(id).idleMs >= 45_000 && !isInVisit(id) && now - (lastPlaneOf.get(id) || 0) > PLANE_ROBOT_GAP);
    for (const a of throwers) {
      if (Math.random() > 0.05 * k()) continue;
      const b = pick(ids.filter((x) => x !== a && atDesk(x) && !rep(x).chat && !isInVisit(x) && !deskPlanes.has(x) && sameScreen(a, x)));
      if (!b) continue;
      return throwPlane(a, b, { miss: Math.random() < 0.1 });
    }
    return false;
  }

  // where the plane leaves the thrower's hand, and where the catcher's hand meets it (screen px)
  function handPoint(id, side, up) {
    const r = robotRect(id);
    if (!r) return null;
    return { x: r.x + r.width * (side === 'L' ? 0.36 : 0.64), y: r.y + r.height * (up ? 0.3 : 0.42) };
  }

  /** a throws a paper plane at b (miss: it overshoots and lands on your desktop). */
  function throwPlane(a, b, { miss = false } = {}) {
    if (inFlight || !robots.has(a) || !robots.has(b) || a === b) return false;
    const side = sideOf(a, b);
    const text = line(a, 'planes', b);
    inFlight = { a, b };
    lastPlane = Date.now();
    lastPlaneOf.set(a, Date.now());
    tell(a, { phase: 'throw', side });
    setTimeout(() => {
      const from = handPoint(a, side, false);
      const to = handPoint(b, sideOf(b, a), true);
      if (!from || !to) return void (inFlight = null);
      planes.fly({
        from,
        to,
        miss,
        onLand: () => {
          inFlight = null;
          if (miss) return tell(a, { phase: 'oops' });
          // caught and read out if it's free; otherwise it lands on its desk, for later
          if (freeAwake(b) && !rep(b).busy) {
            tell(b, { phase: 'catch', side: sideOf(b, a), from: nameOf(a), text });
            setTimeout(() => waveOver(b, a), 3000);
          } else {
            deskPlanes.set(b, a);
            tell(b, { phase: 'plane-land', from: nameOf(a), text });
          }
        },
      });
    }, THROW_AT);
    return true;
  }
  // read it: a wave over to whoever threw it, and a wave back
  function waveOver(b, a) {
    if (!freeAwake(b)) return;
    tell(b, { phase: 'wave', side: sideOf(b, a) });
    setTimeout(() => freeAwake(a) && tell(a, { phase: 'wave-back', side: sideOf(a, b) }), 900);
  }
  function planeRead(id) {
    const a = deskPlanes.get(id);
    deskPlanes.delete(id);
    if (a) setTimeout(() => waveOver(id, a), 400);
  }

  // ---------------------------------------------------------------- walker hooks

  /** You clicked a walker: a visitor says "gotta go!" and hurries home (true: handled). */
  function clicked(id) {
    // out at lunch: both head back
    if (visit?.mode === 'goout' && visit.out?.has(id)) {
      walkers.say(id, line(id, 'gotta', id === visit.a ? visit.b : visit.a), 1600);
      for (const t of visit.timers) clearTimeout(t);
      visit.timers = [];
      later(700, () => homeward({ speedK: 1.4 }));
      return true;
    }
    if (!visit || visit.a !== id) return false;
    walkers.say(id, line(id, 'gotta', visit.b), 1600);
    for (const t of visit.timers) clearTimeout(t);
    visit.timers = [];
    if (visit.phase === 'there' || visit.phase === 'walking') {
      visit.phase = 'there';
      later(700, () => homeward({ speedK: 1.6 }));
    }
    return true;
  }
  /** Picked up mid-visit: the visit's off (it's an ordinary walker now, till you put it back). */
  function held(id) {
    if (visit?.a === id || (visit?.mode === 'goout' && visit.out?.has(id))) endVisit('picked up');
  }
  /** A walker's window closed (docked at home, or called back). */
  function gone(id) {
    if (!visit) return;
    // out at lunch: over once both are back
    if (visit.mode === 'goout' && visit.out?.has(id)) {
      visit.out.delete(id);
      if (visit.out.size === 0) endVisit('home');
      else if (visit.phase !== 'home') homeward();
      return;
    }
    if (visit.a === id) endVisit('home');
  }

  // ---------------------------------------------------------------- office life

  function tryScene(now) {
    if (visit) return false;
    const d = new Date(now);
    const workdays = store.settings.notesWorkdays || [1, 2, 3, 4, 5];
    if (!workdays.includes(d.getDay())) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    const within = (w) => mins >= w[0] && mins < w[1];
    const ids = live();
    const hosts = (a, also = () => true) => ids.filter((b) => b !== a && freeAwake(b) && !isInVisit(b) && sameScreen(a, b) && also(b));
    const organisers = ids.filter((id) => freeAwake(id) && rep(id).idleMs >= 45_000 && rep(id).wanders !== false && !isInVisit(id));
    for (const a of organisers) {
      if (Math.random() > 0.06 * k()) continue;
      if (sceneDay.lunch !== today() && (within(SCENES.order) || within(SCENES.goout))) {
        const out = within(SCENES.goout);
        const b = pick(hosts(a, (x) => !out || rep(x).wanders !== false));
        if (b) return scene(out ? 'goout' : 'order', a, b);
      }
      if (sceneDay.tea !== today() && within(SCENES.tea)) {
        // everyone at a desk on this screen, nearest first (the busy ones get the usual)
        const stops = ids
          .filter((b) => b !== a && atDesk(b) && !rep(b).chat && rep(b).awake && sameScreen(a, b))
          .sort((x, y) => dist(a, x) - dist(a, y));
        if (stops.length) return scene('tea', a, stops[0], { stops: stops.slice(1) });
      }
    }
    return false;
  }
  /** An office scene: 'order' | 'goout' | 'tea' (a goes to b; tea: then opts.stops). */
  function scene(kind, a, b, opts = {}) {
    if (kind === 'tea') sceneDay.tea = today();
    else sceneDay.lunch = today();
    return start(a, b, kind, opts);
  }

  // ---------------------------------------------------------------- the clock

  function tick() {
    check();
    if (level() === 'never' || !present() || appBusy()) return;
    const now = Date.now();
    tryScene(now) || tryVisit(now) || tryPlane(now) || tryWave(now);
  }
  const timer = setInterval(tick, TICK);
  timer.unref?.();

  return {
    report,
    milestone,
    errandFor,
    clicked,
    held,
    gone,
    start, // (for testing, and a menu item one day: "visit …")
    throwPlane, // (for testing)
    scene, // (for testing)
    peek: (id) => ({ ...rep(id), freeAwake: freeAwake(id) }), // (for testing)
    visiting: (id) => visit?.a === id,
    state: () => (visit ? { a: visit.a, b: visit.b, mode: visit.mode, phase: visit.phase } : null),
    tick,
    stop: () => clearInterval(timer),
  };
}

module.exports = { createSocial };
