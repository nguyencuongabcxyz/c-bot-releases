/* global cbot */
// A robot out for a walk round the screen. The main process moves this window
// along its route and says what it's doing (walker:state); this page animates the
// character (office3d's solo mode) and lets you pick it up and carry it back to
// its desk, which docks it.
(() => {
  const W = 190; // (main walker.js BOX)
  const H = 250;
  const FEET = 0.9;
  const SIZES = { small: 0.7, large: 1.35, huge: 1.7 };
  const body = document.body;
  const box = document.querySelector('#walker');
  const stateEl = box; // the 3D view reads its dataset and --paint from here
  const office = window.Office3D.mount(document.querySelector('#bot-host'), { stateEl, moodEl: body, width: W, height: H, solo: true });
  const root = document.documentElement.style;
  let asleep = false;
  let face = null; // a short-lived expression { eyes, mouth, until }

  function look(c) {
    if (!c) return;
    k = SIZES[c.size] || 1;
    root.setProperty('--s', String(k));
    office.setScale(k);
    stateEl.style.setProperty('--paint', c.color || '#5ac8fa');
    Object.assign(stateEl.dataset, {
      body: 'kit', kit: JSON.stringify(c.kit || {}), acc: c.accessory || 'none', name: c.name || '', theme: c.theme || 'classic',
    });
    document.title = `${c.name} (out for a walk)`;
  }

  function renderFace() {
    const f = face && face.until > Date.now() ? face : null;
    const gait = stateEl.dataset.gait;
    stateEl.dataset.eyes = f?.eyes || (asleep ? 'closed' : gait === 'dangle' ? 'open' : 'open');
    stateEl.dataset.mouth = f?.mouth || (asleep ? (gait === 'dangle' ? 'o' : 'flat') : gait === 'dangle' ? 'o' : gait === 'wave' ? 'talk' : 'smile');
  }
  function express(eyes, mouth, ms) {
    face = { eyes, mouth, until: Date.now() + ms };
    renderFace();
    setTimeout(renderFace, ms + 20);
  }

  function setState({ gait, heading, asleep: a, speed }) {
    asleep = !!a;
    body.classList.toggle('asleep', asleep);
    body.classList.toggle('awake', !asleep);
    // a nightcap if it's sleepwalking late at night, a hood if it's up late
    const h = new Date().getHours();
    const late = h >= 22 || h < 6;
    stateEl.dataset.nightcap = asleep && late ? '1' : '';
    stateEl.dataset.lateNight = !asleep && late ? '1' : '';
    if (gait) stateEl.dataset.gait = gait;
    if (heading) stateEl.dataset.heading = heading;
    stateEl.dataset.speed = String(speed || 1);
    if (gait === 'land' && !asleep) express('happy', 'o', 500);
    renderFace();
  }

  // blinking, when awake
  (function blink() {
    if (!asleep && !(face && face.until > Date.now())) {
      stateEl.dataset.eyes = 'closed';
      setTimeout(renderFace, 140);
    }
    setTimeout(blink, 2200 + Math.random() * 3800);
  })();

  // eyes follow the cursor, as at the desk
  cbot.on('walker:cursor', (p) => {
    const head = office.headPosition();
    const dx = p.x - head.x;
    const dy = p.y - head.y;
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 120);
    root.setProperty('--look-x', `${((dx / dist) * 6 * reach).toFixed(2)}px`);
    root.setProperty('--look-y', `${((dy / dist) * 4 * reach).toFixed(2)}px`);
  });

  // Only the character catches the mouse; the rest of the box lets clicks through to
  // whatever's under it (main forwards the mouse moves so this can tell).
  let through = null;
  let k = 1;
  function hitTest(e) {
    if (press) return;
    const fx = (W / 2) * k;
    const fy = H * FEET * k;
    const over = Math.abs(e.clientX - fx) < 50 * k && e.clientY > fy - 190 * k && e.clientY < fy + 22 * k;
    if (through !== !over) {
      through = !over;
      cbot.send('walker:through', through);
    }
  }
  document.addEventListener('mousemove', hitTest);
  document.addEventListener('mouseleave', () => through !== true && ((through = true), cbot.send('walker:through', true)));

  // pick it up and carry it (it dangles and swings); a click without moving makes it wave
  let press = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    box.setPointerCapture(e.pointerId);
    press = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastT: performance.now(), moved: false };
  });
  box.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 5) return;
    if (!press.moved) {
      press.moved = true;
      body.classList.add('dragging');
      cbot.send('walker:drag', { phase: 'start' });
      if (!asleep) express('open', 'o', 60000);
    }
    const now = performance.now();
    const vx = (e.screenX - press.lastX) / Math.max(1, now - press.lastT);
    press.lastX = e.screenX;
    press.lastT = now;
    root.setProperty('--swing', `${Math.min(28, Math.max(-28, -vx * 18)).toFixed(1)}deg`);
    cbot.send('walker:drag', { phase: 'move', dx, dy });
  });
  function endPress(e) {
    if (!press) return;
    const p = press;
    press = null;
    try { box.releasePointerCapture(e.pointerId); } catch {}
    body.classList.remove('dragging');
    root.setProperty('--swing', '0deg');
    face = null;
    if (p.moved) cbot.send('walker:drag', { phase: 'end' });
    else cbot.send('walker:click');
    renderFace();
  }
  box.addEventListener('pointerup', endPress);
  box.addEventListener('pointercancel', endPress);

  // dreaming of one of your words, mid-sleepwalk (main walker.js dream): it mumbles it
  cbot.on('walker:dream', () => {
    express('closed', 'talk', 2400);
    setTimeout(() => express('closed', 'talk', 1600), 3600);
  });
  // a word bubble, visiting another robot (main social.js): it talks while it shows
  const sayEl = document.querySelector('#say');
  cbot.on('walker:say', ({ text, ms = 2600 }) => {
    clearTimeout(sayEl.t);
    sayEl.textContent = text;
    sayEl.classList.toggle('show', !!text);
    if (!text) return;
    if (!asleep) express('happy', 'talk', Math.min(ms, 1800));
    sayEl.t = setTimeout(() => sayEl.classList.remove('show'), ms);
  });
  cbot.on('walker:state', setState);
  cbot.on('walker:character', look);

  (async () => {
    const init = await cbot.invoke('walker:init');
    look(init.character);
    setState(init);
    // drawn as itself: it can take over from the desk now
    // (a hidden window may get only a frame a second: one drawn frame, then a moment, is enough)
    const frames = (n) => new Promise((r) => (n ? requestAnimationFrame(() => frames(n - 1).then(r)) : r()));
    await frames(1);
    await Promise.race([frames(2), new Promise((r) => setTimeout(r, 250))]);
    cbot.send('walker:ready');
  })();
})();
