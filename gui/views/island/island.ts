import type { IslandEdge, IslandNews, IslandRobot } from '@/types/ipc';
import { showView } from '@/ui/view';
import { EYES_OPEN, EYES_SHUT, HEAD } from '@/ui/head';
import markup from './island.html?raw';
import '@/ui/theme.css';
import './island.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'C-Bot robots' });

(() => {
  // The robot island (main island.rs; docs/mockups/island-*.svg). At rest, every robot's
  // face in a strip on the screen's edge; hovered (main tells: island:hover), a card for
  // each, to bring it out or send it away; a robot that's away and has news says so as a
  // toast. Pressed and held, main moves it round the edges with the mouse. The strip is
  // sized to its layer here. Its window has room for its biggest look all the time
  // (island_size), so opening it never resizes the window (that flickers); main lets clicks
  // through the see-through rest of it, and hovers by where the strip is (island_box).
  // Updates change what's there in place: rebuilt, the rings would jump and hovers flicker.
  const $ = (s: string) => document.querySelector<HTMLElement>(s)!;
  const body = document.body;
  const box = $('#island');
  const layers = { rest: $('#rest'), panel: $('#panel'), toast: $('#toast') };
  type Mode = keyof typeof layers;
  type Toast = IslandNews & { id: string };

  const SHADOW = 14; // room for its shadow, on the sides away from its edge (island.css body padding)
  const OPEN_AFTER = 140; // ms hovered before the panel slides out
  const CLOSE_AFTER = 380; // ms gone before it slides back
  const HOLD = 350; // ms pressed before it lifts to be moved
  const TOAST_FOR = 7000; // ms a toast stays (not a question or your notes: those wait for you)

  let robots: IslandRobot[] = [];
  let edge: IslandEdge = 'top';
  let mode: Mode = 'rest';
  let hovering = false;
  let dragging = false;
  const dots = new Map<string, IslandNews['kind']>(); // news you haven't looked at, by robot
  const queue: Toast[] = [];
  let toast: Toast | null = null;

  const vertical = () => edge === 'left' || edge === 'right';
  const byId = (id: string) => robots.find((r) => r.id === id);
  const elapsed = (since: number | null) => {
    if (!since) return '';
    const s = Math.max(0, Math.round((Date.now() - since) / 1000));
    return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const setText = (e: HTMLElement, text: string) => {
    if (e.textContent !== text) e.textContent = text;
  };
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------ faces

  const asleep = (r: IslandRobot) => r.closed || (r.awake !== true && !r.busy);

  function face(r: IslandRobot, tag: 'span' | 'button' = 'span') {
    const f = el(tag, 'face');
    f.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"></svg><i class="dot"></i>';
    paintFace(f, r);
    return f;
  }
  // (only what changed: a class set as it already was restarts nothing)
  function paintFace(f: HTMLElement, r: IslandRobot) {
    const sleepy = asleep(r) ? '1' : '0';
    if (f.dataset.sleepy !== sleepy) {
      f.dataset.sleepy = sleepy;
      f.firstElementChild!.innerHTML = HEAD + (asleep(r) ? EYES_SHUT : EYES_OPEN);
    }
    const color = r.color || '#5ac8fa';
    if (f.dataset.color !== color) {
      f.dataset.color = color;
      f.style.color = color;
    }
    f.classList.toggle('away', r.away);
    f.classList.toggle('asking', !!r.asking && !r.closed);
    f.classList.toggle('busy', !!r.busy && !r.asking && !r.closed);
    const dot = dots.get(r.id);
    if (dot) f.dataset.dot = dot;
    else delete f.dataset.dot;
  }

  // One element per robot, in the robots' order; nodes only move when the order does
  // (taken out and put back, their animations would start over).
  function keep<T extends { el: HTMLElement }>(parent: HTMLElement, made: Map<string, T>, make: (r: IslandRobot) => T, paint: (t: T, r: IslandRobot) => void) {
    for (const id of [...made.keys()]) if (!byId(id)) made.delete(id);
    const want = robots.map((r) => {
      let t = made.get(r.id);
      if (!t) made.set(r.id, (t = make(r)));
      paint(t, r);
      return t.el;
    });
    const now = [...parent.children];
    if (now.length !== want.length || now.some((n, i) => n !== want[i])) parent.replaceChildren(...want);
  }

  // what it's up to, in a few words
  function statusOf(r: IslandRobot): { text: string; cls: string } {
    if (r.closed) return { text: 'Put away', cls: 'dim' };
    if (r.asking) return { text: 'Has a question for you', cls: 'ask' };
    if (r.busy) return { text: `${r.text || 'Working…'}${r.since ? ` · ${elapsed(r.since)}` : ''}`, cls: 'busy' };
    if (r.walking) return { text: 'Out for a walk', cls: '' };
    if (r.awake !== true) return { text: r.away ? 'Asleep · away' : 'Asleep on the desk', cls: 'dim' };
    return { text: r.away ? 'Awake · away' : 'On your desk · idle', cls: '' };
  }

  // ------------------------------------------------------------ at rest

  const restFaces = new Map<string, { el: HTMLElement }>();
  function renderRest() {
    keep($('#faces'), restFaces, (r) => ({ el: face(r) }), (t, r) => paintFace(t.el, r));
    const t = $('#rest-text');
    // a robot that's away and at work (or waiting on you) gets the line to itself
    const news = robots.find((r) => r.away && !r.closed && r.asking) || robots.find((r) => r.away && !r.closed && r.busy);
    t.className = news ? `ticker${news.asking ? ' asking' : ''}` : '';
    if (news) {
      if (!t.querySelector('b')) t.replaceChildren(el('b'), el('span'), el('span', 'time'));
      const [name, what, time] = [...t.children] as HTMLElement[];
      setText(name, news.name);
      setText(what, news.asking ? 'has a question for you' : news.text || 'Working…');
      setText(time, news.asking ? '' : elapsed(news.since));
    } else {
      const out = robots.filter((r) => !r.away).length;
      setText(t, `${out} out · ${robots.length - out} away`);
    }
  }

  // ------------------------------------------------------------ the panel

  type Card = { el: HTMLElement; face: HTMLElement; name: HTMLElement; status: HTMLElement; go: HTMLButtonElement };
  const cards = new Map<string, Card>();
  function makeCard(r: IslandRobot): Card {
    const card = el('div', 'card');
    const f = face(r, 'button');
    (f as HTMLButtonElement).type = 'button';
    f.append(el('i', 'here'));
    f.addEventListener('click', () => act('chat', r.id));
    const who = el('div', 'who');
    const name = el('div', 'name');
    const status = el('div', 'status');
    who.append(name, status);
    const go = el('button', 'pill');
    go.type = 'button';
    go.addEventListener('click', () => {
      const now = byId(r.id);
      if (now) act(now.away ? 'out' : 'away', r.id);
    });
    card.append(f, who, go);
    return { el: card, face: f, name, status, go };
  }
  function paintCard(c: Card, r: IslandRobot) {
    c.el.classList.toggle('busy', !!r.busy && !r.closed);
    c.el.classList.toggle('asking', !!r.asking && !r.closed);
    paintFace(c.face, r);
    c.face.title = `Open ${r.name}'s chat`;
    setText(c.name, r.name);
    const st = statusOf(r);
    setText(c.status, st.text);
    c.status.className = `status ${st.cls}`;
    setText(c.go, r.away ? 'Bring out' : 'Send away');
    c.go.classList.toggle('primary', r.away);
    c.go.disabled = r.walking && !r.away; // (out for a walk: call it back to its desk first)
  }
  function renderPanel() {
    setText($('#count'), String(robots.length));
    ($('#all-out') as HTMLButtonElement).disabled = !robots.some((r) => r.away);
    ($('#all-away') as HTMLButtonElement).disabled = !robots.some((r) => !r.away && !r.walking);
    keep($('#cards'), cards, makeCard, paintCard);
  }

  function act(action: 'out' | 'away' | 'chat' | 'notes', id: string) {
    if (action !== 'notes') dots.delete(id);
    ipc.islandAct(action, id);
  }
  $('#all-out').addEventListener('click', () => {
    dots.clear();
    ipc.islandAct('all-out');
  });
  $('#all-away').addEventListener('click', () => ipc.islandAct('all-away'));

  // ------------------------------------------------------------ news

  // How each kind of news reads. waits: it stays till you act (no countdown); go: its
  // button (none: just ✕); dot: what its face keeps till you look; robot: news of the
  // robot's own work, gone once it's back on the desk (the rest is for you, robot or not).
  type Kind = IslandNews['kind'];
  const KINDS: Record<Kind, { title: (name: string, text: string) => string; text: (name: string, text: string) => string; go?: string; no?: string; waits?: boolean; dot?: boolean; robot?: boolean }> = {
    done: { title: (n) => `${n} finished`, text: (_, t) => t, go: 'Bring out', dot: true, robot: true },
    error: { title: (n) => `${n} hit a snag`, text: (_, t) => t, go: 'Bring out', dot: true, robot: true },
    ask: { title: (n) => `${n} needs you`, text: (_, t) => t, go: 'Answer', no: 'Later', waits: true, dot: true, robot: true },
    word: { title: (n) => `💭 ${n} dreamt of a word`, text: (_, t) => `“${t}” (its card is open beside me)` },
    quiz: { title: (n) => `🃏 ${n} is quizzing you`, text: (_, t) => `Do you remember “${t}”? The card is beside me.` },
    notes: { title: (_, t) => `📒 ${t}`, text: (n) => `${n} is holding up your notes.`, go: 'Open', no: 'Later', waits: true },
  };
  const ALL_KINDS = Object.keys(KINDS).map((k) => `kind-${k}`);
  const waits = (t: Toast | null) => !!t && !!KINDS[t.kind].waits;

  function renderToast() {
    if (!toast) return;
    const r = byId(toast.id);
    if (!r) return;
    const k = KINDS[toast.kind];
    body.classList.remove(...ALL_KINDS);
    body.classList.add(`kind-${toast.kind}`);
    body.classList.toggle('toast-waits', !!k.waits);
    const f = face(r, 'button');
    f.classList.add('big');
    f.id = 't-face';
    f.dataset.dot = toast.kind;
    f.title = `Bring ${r.name} out and open its chat`;
    f.addEventListener('click', () => {
      if (toast) act('chat', toast.id);
      endToast();
    });
    $('#t-face').replaceWith(f);
    $('#t-title').textContent = k.title(r.name, toast.text);
    $('#t-text').textContent = k.text(r.name, toast.text);
    const go = $('#t-go');
    go.hidden = !k.go;
    go.textContent = k.go || '';
    $('#t-no').textContent = k.no || '✕';
    $('#t-no').title = k.no ? 'Not now' : 'Dismiss';
    // the countdown starts again
    const bar = $('#t-time i');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
    box.style.setProperty('--ms', `${TOAST_FOR}ms`);
  }

  function news(n: Toast) {
    const r = byId(n.id);
    if (!r?.away) return; // (out on the desk: its own bubble says it)
    if (KINDS[n.kind].dot && (n.kind === 'ask' || dots.get(n.id) !== 'ask')) dots.set(n.id, n.kind);
    // one toast per robot and kind waiting; the ones that wait for you jump the queue
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === n.id && (queue[i].kind === n.kind || KINDS[n.kind].robot)) queue.splice(i, 1);
    if (KINDS[n.kind].waits) queue.unshift(n);
    else queue.push(n);
    if (toast?.id === n.id && toast.kind === n.kind) {
      toast = null; // (this one's newer)
      stopCountdown();
    }
    renderRest();
    nextToast();
  }

  function nextToast() {
    if (toast || dragging || mode === 'panel' || !queue.length) return;
    toast = queue.shift()!;
    renderToast();
    setMode('toast');
    if (!waits(toast)) startCountdown();
  }

  function endToast() {
    stopCountdown();
    toast = null;
    body.classList.remove(...ALL_KINDS, 'toast-held', 'toast-waits');
    setMode(hovering ? 'panel' : 'rest');
    nextToast();
  }

  $('#t-go').addEventListener('click', () => {
    if (toast) act(toast.kind === 'notes' ? 'notes' : 'chat', toast.id);
    endToast();
  });
  $('#t-no').addEventListener('click', () => {
    if (toast && toast.kind !== 'ask') dots.delete(toast.id); // (seen it; a question you put off keeps its dot)
    renderRest();
    endToast();
  });

  // it tucks itself away after a while, unless the mouse is on it
  let left = 0;
  let since = 0;
  let timer = 0;
  function startCountdown() {
    left = TOAST_FOR;
    resumeCountdown();
  }
  function resumeCountdown() {
    since = Date.now();
    clearTimeout(timer);
    timer = window.setTimeout(endToast, Math.max(400, left));
  }
  function stopCountdown() {
    clearTimeout(timer);
  }
  function holdToast(held: boolean) {
    if (!toast || waits(toast)) return;
    body.classList.toggle('toast-held', held);
    if (held) {
      stopCountdown();
      left -= Date.now() - since;
    } else resumeCountdown();
  }

  // ------------------------------------------------------------ size and shape

  let win = { w: 0, h: 0 };
  let hit = '';
  // the strip as big as its layer (CSS eases it there); the window as big as the biggest
  // layer, so it stays put while the strip changes
  function fit() {
    const l = layers[mode];
    const w = Math.ceil(l.offsetWidth);
    const h = Math.ceil(l.offsetHeight);
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    let mw = 0;
    let mh = 0;
    for (const x of Object.values(layers)) {
      mw = Math.max(mw, Math.ceil(x.offsetWidth));
      mh = Math.max(mh, Math.ceil(x.offsetHeight));
    }
    const W = mw + (vertical() ? SHADOW : 2 * SHADOW);
    const H = mh + (vertical() ? 2 * SHADOW : SHADOW);
    if (W !== win.w || H !== win.h) {
      win = { w: W, h: H };
      ipc.islandSize(W, H);
    }
    // where the strip ends up in it (body's flex puts it there: island.css)
    const at = [edge === 'left' ? 0 : edge === 'right' ? W - w : (W - w) / 2, edge === 'top' ? 0 : edge === 'bottom' ? H - h : (H - h) / 2, w, h].map(Math.round);
    if (at.join() !== hit) {
      hit = at.join();
      ipc.islandBox(at[0], at[1], at[2], at[3]);
    }
  }

  function setMode(m: Mode) {
    if (m !== mode) {
      mode = m;
      body.classList.remove('mode-rest', 'mode-panel', 'mode-toast');
      body.classList.add(`mode-${m}`);
    }
    fit();
  }

  function setEdge(e: IslandEdge) {
    edge = e;
    body.classList.remove('edge-top', 'edge-bottom', 'edge-left', 'edge-right');
    body.classList.add(`edge-${e}`);
    body.classList.toggle('vertical', vertical());
    renderRest();
    renderPanel();
    fit();
  }

  function render() {
    renderRest();
    renderPanel(); // (hidden too: it's measured for the window's size)
    fit();
  }

  // ------------------------------------------------------------ the mouse

  let openTimer = 0;
  let closeTimer = 0;
  ipc.on('island:hover', (over) => {
    hovering = over;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (dragging || press) return;
    if (mode === 'toast') return holdToast(over);
    if (over) openTimer = window.setTimeout(() => setMode('panel'), OPEN_AFTER);
    else
      closeTimer = window.setTimeout(() => {
        if (mode === 'panel') setMode('rest');
        nextToast();
      }, CLOSE_AFTER);
  });

  // press and hold (or press and pull) anywhere but a button: main moves it from there
  let press: { x: number; y: number; timer: number } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    press = { x: e.screenX, y: e.screenY, timer: window.setTimeout(lift, HOLD) };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (press && !dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) lift();
  });
  const letGo = () => {
    const was = press;
    if (was) clearTimeout(was.timer);
    press = null;
    if (dragging) ipc.islandDrag('end'); // (main may have seen it first: island:edge says)
    else if (was && mode === 'rest') setMode('panel'); // a click opens it too
  };
  box.addEventListener('pointerup', letGo);
  box.addEventListener('pointercancel', letGo);
  function lift() {
    if (!press || dragging) return;
    clearTimeout(press.timer);
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    dragging = true;
    body.classList.add('dragging');
    if (toast) {
      stopCountdown();
      queue.unshift(toast); // (shown again once it's put down)
      toast = null;
    }
    setMode('rest');
    ipc.islandDrag('start');
  }

  ipc.on('island:edge', ({ edge: e, dragging: still }) => {
    if (e !== edge) setEdge(e);
    if (still) return;
    dragging = false;
    press = null;
    body.classList.remove('dragging');
    nextToast();
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------ main

  ipc.on('island:robots', (list) => {
    robots = list;
    // back on the desk: its news is seen (and any toast of it goes)
    for (const r of robots) if (!r.away) dots.delete(r.id);
    for (const [id] of dots) if (!byId(id)) dots.delete(id);
    for (let i = queue.length - 1; i >= 0; i--) {
      const r = byId(queue[i].id);
      if (!r || (KINDS[queue[i].kind].robot && !r.away) || (queue[i].kind === 'ask' && !r.asking)) queue.splice(i, 1);
    }
    for (const r of robots) if (!r.asking && dots.get(r.id) === 'ask') dots.delete(r.id); // (answered)
    if (toast) {
      const r = byId(toast.id);
      if (!r || (KINDS[toast.kind].robot && !r.away) || (toast.kind === 'ask' && !r.asking)) return endToast(), render();
    }
    render();
  });
  ipc.on('island:news', news);

  // the times tick on (the ticker and the cards' "· 0:42")
  setInterval(() => {
    if (!robots.some((r) => r.busy && r.since)) return;
    renderRest();
    for (const r of robots) {
      const c = cards.get(r.id);
      if (c) setText(c.status, statusOf(r).text);
    }
  }, 1000);

  (async () => {
    const init = await ipc.islandInit();
    robots = init.robots;
    body.classList.add('mode-rest');
    setEdge(init.edge);
  })();
})();
