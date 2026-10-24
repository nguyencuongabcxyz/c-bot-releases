/* global cbot */
// The drone (main drone.js): launch flies it in an arc from the robot's desk to the mouse,
// tilting into the turn; hover settles it above the menu with the beam on, bobbing a little;
// recall flies it home and it's gone. Positions are the lens (the bottom middle of the drone).
(() => {
  const drone = document.getElementById('drone');
  const beam = document.getElementById('beam');
  const W = 96;
  const LENS_Y = 50; // the lens, from the drone's top
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pos = { x: -200, y: -200, tilt: 0, scale: 1, alpha: 0 };
  let move = null; // { from, to, lift, t0, ms, then, scale: [a, b], alpha: [a, b] }
  let bob = false;
  let beamTo = null; // { y, width }: the menu's top edge, while projecting
  let frame = 0;

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function draw(now) {
    let y = pos.y;
    if (bob && !move) y += Math.sin(now / 260) * 2.2;
    drone.style.transform = `translate(${pos.x - W / 2}px, ${y - LENS_Y}px) rotate(${pos.tilt}deg) scale(${pos.scale})`;
    drone.style.opacity = pos.alpha;
    if (beamTo) {
      const top = y - 2;
      Object.assign(beam.style, { left: `${pos.x - beamTo.width / 2}px`, top: `${top}px`, width: `${beamTo.width}px`, height: `${Math.max(0, beamTo.y - top)}px` });
    }
  }
  function tick(now) {
    if (move) {
      const t = Math.min(1, (now - move.t0) / move.ms);
      const k = ease(t);
      const { from, to, lift } = move;
      // a gentle arc: up and over, then down onto the spot
      const cx = (from.x + to.x) / 2;
      const cy = Math.min(from.y, to.y) - lift;
      const px = (1 - k) ** 2 * from.x + 2 * (1 - k) * k * cx + k * k * to.x;
      const py = (1 - k) ** 2 * from.y + 2 * (1 - k) * k * cy + k * k * to.y;
      const vx = px - pos.x;
      pos.x = px;
      pos.y = py;
      pos.tilt = Math.max(-18, Math.min(18, vx * 1.6)) * (1 - t * 0.6);
      pos.scale = move.scale[0] + (move.scale[1] - move.scale[0]) * k;
      // (it fades in quickly on take-off, and out only at the very end on the way home)
      const fade = move.alpha[1] > move.alpha[0] ? Math.min(1, t * 2.5) : t ** 3;
      pos.alpha = move.alpha[0] + (move.alpha[1] - move.alpha[0]) * fade;
      if (t >= 1) {
        const then = move.then;
        move = null;
        pos.tilt = 0;
        then?.();
      }
    } else pos.tilt *= 0.8;
    draw(now);
    frame = move || bob || beamTo ? requestAnimationFrame(tick) : 0;
  }
  const run = () => frame || (frame = requestAnimationFrame(tick));

  function fly(to, { ms, lift = 60, scale = [pos.scale, 1], alpha = [pos.alpha, 1], then } = {}) {
    if (still) {
      Object.assign(pos, { x: to.x, y: to.y, tilt: 0, scale: scale[1], alpha: alpha[1] });
      draw(performance.now());
      return then?.();
    }
    const d = Math.hypot(to.x - pos.x, to.y - pos.y);
    move = { from: { x: pos.x, y: pos.y }, to, lift: Math.min(lift, d * 0.3), t0: performance.now(), ms: ms ?? Math.max(240, Math.min(360, d / 3)), then, scale, alpha };
    run();
  }

  cbot.on('drone:cmd', (c) => {
    if (c.paint) document.documentElement.style.setProperty('--paint', c.paint);
    if (c.kind === 'launch') {
      beamTo = null;
      beam.classList.remove('on');
      drone.classList.remove('projecting');
      bob = false;
      Object.assign(pos, { x: c.from.x, y: c.from.y, tilt: 0, scale: 0.55, alpha: 0 });
      draw(performance.now());
      fly(c.to, { scale: [0.55, 1], alpha: [0, 1], then: () => cbot.send('drone:arrived') });
    } else if (c.kind === 'retarget') {
      // the menu's real spot: mid-flight it carries on there in the time that's left
      if (move) {
        const { then, scale, alpha } = move;
        const left = Math.max(120, move.ms - (performance.now() - move.t0));
        move = null;
        fly(c.to, { ms: left, lift: 20, scale: [pos.scale, scale[1]], alpha: [pos.alpha, alpha[1]], then });
      } else fly(c.to, { ms: Math.max(120, Math.min(260, Math.hypot(c.to.x - pos.x, c.to.y - pos.y) / 2)), lift: 0, then: () => cbot.send('drone:arrived') });
    } else if (c.kind === 'hover') {
      // over the menu: a short glide to just above its top edge, then the beam
      const gap = 30;
      const to = { x: c.at.x, y: c.at.y - gap };
      fly(to, {
        ms: Math.max(60, Math.min(260, Math.hypot(to.x - pos.x, to.y - pos.y) / 2)), // (usually it's there already)
        lift: 0,
        then: () => {
          bob = true;
          beamTo = { y: c.at.y + 1, width: Math.max(60, c.width - 24) };
          drone.classList.add('projecting');
          beam.classList.add('on');
          run();
        },
      });
    } else if (c.kind === 'recall') {
      bob = false;
      beamTo = null;
      beam.classList.remove('on');
      drone.classList.remove('projecting');
      const home = c.to || { x: pos.x, y: pos.y - 120 };
      fly(home, { ms: 320, scale: [pos.scale, 0.55], alpha: [pos.alpha, 0], then: () => cbot.send('drone:gone') });
    }
  });
})();
