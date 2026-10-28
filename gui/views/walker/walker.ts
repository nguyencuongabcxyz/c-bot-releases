// A robot out for a walk round the screen. The main process moves this window
// along its route and says what it's doing (walker:state); this page animates the
// character (office3d's solo mode) and lets you pick it up and carry it back to
// its desk, which docks it.
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';
import { Office3D } from '@/office3d';
import { officeData, writeJson } from '@/office3d/protocol';
import type { WalkerLook, WalkerState } from '@/types/pages';
import { showView } from '@/lib/page';
import markup from './walker.html?raw';
import './walker.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'C-Bot (out for a walk)', bodyClass: 'awake' });

(() => {
  const W = 190; // (main walker.js BOX)
  const H = 250;
  const FEET = 0.9;
  const SIZES: Record<string, number> = { small: 0.7, large: 1.35, huge: 1.7 };
  const body = document.body;
  const box = $<HTMLElement>('#walker');
  const stateEl = box; // the 3D view reads its dataset and --paint from here
  const data = officeData(stateEl); // (office3d/protocol.ts)
  const office = Office3D.mount($<HTMLElement>('#bot-host'), {
    stateEl,
    moodEl: body,
    width: W,
    height: H,
    solo: true,
  });
  const root = document.documentElement.style;
  let asleep = false;
  let face = null as { eyes: string; mouth: string; until: number } | null; // a short-lived expression { eyes, mouth, until }

  function look(c: WalkerLook | null | undefined) {
    if (!c) return;
    k = (c.size && SIZES[c.size]) || 1; // (no size: normal)
    root.setProperty('--s', String(k));
    office.setScale(k);
    stateEl.style.setProperty('--paint', c.color || '#5ac8fa');
    writeJson(data, 'kit', c.kit || {});
    Object.assign(data, {
      body: 'kit',
      acc: c.accessory || 'none',
      name: c.name || '',
      theme: c.theme || 'classic',
    });
    document.title = `${c.name} (out for a walk)`;
    onDuty = !!c.staff;
    const tag = $('#tag');
    tag.textContent = c.tag || '';
    tag.hidden = !c.tag;
  }
  let onDuty = false; // (the evening housemaid: in uniform, never in a hoodie or a nightcap)

  function renderFace() {
    const f = face && face.until > Date.now() ? face : null;
    const gait = data.gait;
    data.eyes = f?.eyes || (asleep ? 'closed' : gait === 'dangle' ? 'open' : 'open');
    data.mouth =
      f?.mouth ||
      (asleep ? (gait === 'dangle' ? 'o' : 'flat') : gait === 'dangle' ? 'o' : gait === 'wave' ? 'talk' : 'smile');
  }
  function express(eyes: string, mouth: string, ms: number) {
    face = { eyes, mouth, until: Date.now() + ms };
    renderFace();
    setTimeout(renderFace, ms + 20);
  }

  function setState({ gait, heading, asleep: a, speed }: Partial<WalkerState>) {
    asleep = !!a;
    body.classList.toggle('asleep', asleep);
    body.classList.toggle('awake', !asleep);
    // a nightcap if it's sleepwalking late at night, a hood if it's up late
    const h = new Date().getHours();
    const late = !onDuty && (h >= 22 || h < 6);
    data.nightcap = asleep && late ? '1' : '';
    data.lateNight = !asleep && late ? '1' : '';
    if (gait) data.gait = gait;
    if (heading) data.heading = heading;
    data.speed = String(speed || 1);
    if (gait === 'land' && !asleep) express('happy', 'o', 500);
    renderFace();
  }

  // blinking, when awake
  (function blink() {
    if (!asleep && !(face && face.until > Date.now())) {
      data.eyes = 'closed';
      setTimeout(renderFace, 140);
    }
    setTimeout(blink, 2200 + Math.random() * 3800);
  })();

  // eyes follow the cursor, as at the desk
  ipc.on('walker:cursor', (p) => {
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
  let through: boolean | null = null;
  let k = 1;
  let pressed = false; // (held: it's yours till you let go)
  function hitTest(e: MouseEvent) {
    if (pressed) return;
    const fx = (W / 2) * k;
    const fy = H * FEET * k;
    const over = Math.abs(e.clientX - fx) < 50 * k && e.clientY > fy - 190 * k && e.clientY < fy + 22 * k;
    if (through !== !over) {
      through = !over;
      ipc.walkerThrough(through);
    }
  }
  document.addEventListener('mousemove', hitTest);
  document.addEventListener('mouseleave', () => {
    if (through === true) return;
    through = true;
    ipc.walkerThrough(true);
  });

  // pick it up and carry it (it dangles and swings); a click without moving makes it wave
  onDrag(
    box,
    (e) => {
      pressed = true;
      let [lastX, lastT] = [e.screenX, performance.now()];
      return {
        begin: () => {
          body.classList.add('dragging');
          ipc.walkerDrag({ phase: 'start' });
          if (!asleep) express('open', 'o', 60000);
        },
        move: ({ dx, dy, e: ev }) => {
          const now = performance.now();
          const vx = (ev.screenX - lastX) / Math.max(1, now - lastT);
          [lastX, lastT] = [ev.screenX, now];
          root.setProperty('--swing', `${Math.min(28, Math.max(-28, -vx * 18)).toFixed(1)}deg`);
          ipc.walkerDrag({ phase: 'move', dx, dy });
        },
        end: ({ moved, letGo }) => {
          pressed = false;
          body.classList.remove('dragging');
          root.setProperty('--swing', '0deg');
          face = null;
          if (moved) ipc.walkerDrag({ phase: 'end' });
          else if (letGo) ipc.walkerClick();
          renderFace();
        },
      };
    },
    { threshold: 5 },
  );

  // dreaming of one of your words, mid-sleepwalk (main walker.js dream): it mumbles it
  ipc.on('walker:dream', () => {
    express('closed', 'talk', 2400);
    setTimeout(() => express('closed', 'talk', 1600), 3600);
  });
  // a word bubble, visiting another robot (main social.js): it talks while it shows
  const sayEl = $('#say');
  let sayTimer = 0;
  ipc.on('walker:say', ({ text, ms = 2600 }) => {
    clearTimeout(sayTimer);
    sayEl.textContent = text;
    sayEl.classList.toggle('show', !!text);
    if (!text) return;
    if (!asleep) express('happy', 'talk', Math.min(ms, 1800));
    sayTimer = setTimeout(() => sayEl.classList.remove('show'), ms);
  });
  ipc.on('walker:state', setState);
  ipc.on('walker:character', look);

  (async () => {
    const init = await ipc.walkerInit();
    look(init.character);
    setState(init);
    // drawn as itself: it can take over from the desk now
    // (a hidden window may get only a frame a second: one drawn frame, then a moment, is enough)
    const frames = (n: number): Promise<void> =>
      new Promise((r) => (n ? requestAnimationFrame(() => frames(n - 1).then(r)) : r()));
    await frames(1);
    await Promise.race([frames(2), new Promise((r) => setTimeout(r, 250))]);
    ipc.walkerReady();
  })();
})();
