import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, noOutline, canvasTexture, roundRect } from './materials';
import { THEMES } from './themes';
import type { CanvasDraw } from './materials';
import type { Board, BoardNote } from './types';

// The notes corkboard: a little standing board at the desk's front-left corner with
// your open notes pinned on it as sticky notes. Clicking it opens the notebook.
//
//   const board = buildBoard(theme);
//   set.desk.top.add(board.group);   // rides up with the standing desk (office space)
//   board.setNotes(items, total)      items: up to 5 [{ id, text, important, age, working }]
//   board.setHover(on)                a soft glow round the frame and a little scale-up
//   board.setLift(k)                  0..1: tipped up and turned to the camera (held up)
//   board.hit(raycaster)              { kind: 'note', id } | { kind: 'board' } | null
//   board.stickyAt(id, out)           world position of that sticky's middle (or null)
//   board.update(t, dt)               per frame: eases hover / lift, flutters the stickies
//   board.dispose()
//
// The group's origin is on the desk top (y = LAYOUT.deskTop in office space).

export const BOARD = {
  position: new THREE.Vector3(-1.09, 0.82, -0.67), // front-left corner of the desk top
  yaw: 0.62, // turned toward the camera (which is at yaw ~0.75 from here)
  width: 0.34,
  height: 0.26,
  lean: 0.2, // leaning back on its kickstand (radians)
};

const W = BOARD.width;
const H = BOARD.height;
const BAR = 0.022; // frame bar width
const DEPTH = 0.024; // frame depth
const CORK_W = W - 2 * BAR + 0.004;
const CORK_H = H - 2 * BAR + 0.004;
const FOOT = 0.018; // the feet lift the frame this much off the desk
const STICKY = 0.088; // a sticky note's side
const PIN_DROP = 0.013; // the pin sits this far below the sticky's top edge
const CORK_Z = 0.0; // the cork's front face (in the board's own space)
const INK = '#1d2235';
const HAND = '"Segoe Print", "Ink Free", "Comic Sans MS", "Segoe UI", sans-serif';

// (a touch stronger than true pastels: the toon lights wash them out)
const PAPER = ['#ffe45c', '#ff9cc4', '#86e0ad', '#8fc8ff', '#c6a8ff'];
const PAPER_IMPORTANT = '#ff6b5e';
const PAPER_OLD = '#d9b25e';
const PINS = {
  classic: ['#e5484d', '#2b6fe0', '#3fb37f', '#ffb020', '#9b59ff'],
  brand: (accent: string) => [accent, '#00AEEF', accent, '#484848', '#00AEEF'],
};

// where the stickies go for 1..5 of them: [x, y, scale] on the cork (its middle is 0, 0)
const LAYOUTS: [number, number, number][][] = [
  [],
  [[0, 0.0, 1.35]],
  [[-0.06, 0.012, 1.18], [0.064, -0.006, 1.18]],
  [[-0.088, 0.024, 1.04], [0.004, -0.02, 1.04], [0.092, 0.026, 1.04]],
  [[-0.058, 0.045, 1.0], [0.062, 0.05, 1.0], [-0.052, -0.048, 1.0], [0.064, -0.044, 1.0]],
  [[-0.094, 0.048, 0.98], [0.0, 0.054, 0.98], [0.094, 0.046, 0.98], [-0.072, -0.05, 0.98], [0.022, -0.052, 0.98]],
];

const mesh = <G extends THREE.BufferGeometry, M extends THREE.Material | THREE.Material[]>(geo: G, mat: M, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};
const hash = (s: string | number) => {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296; // 0..1
};
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

// a pinned paper's bits, kept on its group's userData (paper() below), and a note as pinned up
type PaperParts = { sheet: THREE.Mesh; pin: THREE.Mesh; base: number; phase: number };
type PinnedNote = { id: string | undefined; group: THREE.Group; sheet: THREE.Mesh; pin: THREE.Mesh; tex: THREE.CanvasTexture; mat: THREE.MeshToonMaterial };

// ---------------------------------------------------------------- textures

function corkTexture() {
  return canvasTexture(256, 192, (ctx, w, h) => {
    ctx.fillStyle = '#b57d45';
    ctx.fillRect(0, 0, w, h);
    // speckle: lots of little darker and lighter crumbs
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1400; i++) {
      const r = rnd();
      ctx.fillStyle = r < 0.45 ? 'rgba(120,72,30,0.45)' : r < 0.8 ? 'rgba(232,186,128,0.6)' : 'rgba(90,52,20,0.5)';
      const s = 1 + rnd() * 2.6;
      ctx.fillRect(rnd() * w, rnd() * h, s, s * (0.6 + rnd() * 0.8));
    }
    // a little shade in from the frame
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(60,30,10,0.22)');
    g.addColorStop(0.12, 'rgba(60,30,10,0)');
    g.addColorStop(0.9, 'rgba(60,30,10,0)');
    g.addColorStop(1, 'rgba(60,30,10,0.14)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function haloTexture() {
  return canvasTexture(128, 104, (ctx, w, h) => {
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.07})`;
      roundRect(ctx, i * 1.6, i * 1.6, w - i * 3.2, h - i * 3.2, 22 - i);
      ctx.fill();
    }
  });
}

// the first one or two words of a note, for the front of its sticky
function headline(text: string | undefined) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return ['…'];
  const [a, b] = words.map((w) => w.replace(/^[^\p{L}\p{N}#@]+|[^\p{L}\p{N}]+$/gu, '') || w);
  if (!b || a.length >= 8 || b.length >= 10) return [a];
  return [a, b];
}

function mixHex(a: string, b: string, k: number) {
  return '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();
}

function stickyTexture(item: BoardNote, paper: string) {
  const S = 128;
  return canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, S, S);
    // the gummed strip along the top, and a thin darker edge so it reads against the cork
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(0, 0, S, 22);
    ctx.strokeStyle = 'rgba(29,34,53,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, S - 4, S - 4);
    if ((item.age || 0) >= 3) {
      // old: blotchy and a bit browner, and a shade where the corner curls up
      ctx.fillStyle = 'rgba(150,110,40,0.14)';
      for (const [x, y, r] of [[30, 90, 16], [96, 40, 11], [70, 108, 9]]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      const g = ctx.createLinearGradient(S, S, S * 0.55, S * 0.55);
      g.addColorStop(0, 'rgba(90,60,20,0.35)');
      g.addColorStop(0.5, 'rgba(90,60,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    // the words, as big as fit
    const lines = headline(item.text);
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxW = S - 16;
    let size = lines.length > 1 ? 42 : 52;
    const fit = () => lines.every((l) => ctx.measureText(l).width <= maxW);
    for (; size > 18; size -= 2) {
      ctx.font = `700 ${size}px ${HAND}`;
      if (fit()) break;
    }
    const shown = lines.map((l) => {
      if (ctx.measureText(l).width <= maxW) return l;
      let s = l;
      while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      return s + '…';
    });
    const lh = size * 0.98;
    const y0 = 72 - ((shown.length - 1) * lh) / 2;
    // (stroked as well as filled: fatter letters survive being drawn a few pixels big)
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.lineJoin = 'round';
    shown.forEach((l, i) => {
      ctx.strokeText(l, S / 2, y0 + i * lh);
      ctx.fillText(l, S / 2, y0 + i * lh);
    });
    if (item.important) {
      // a red "!" tucked in the top-left corner
      ctx.fillStyle = '#c81e2a';
      ctx.font = `900 30px "Segoe UI", sans-serif`;
      ctx.fillText('!', 16, 22);
    }
    if (item.working) {
      // a little badge: Claude is on it
      ctx.fillStyle = '#2a3049';
      ctx.beginPath();
      ctx.arc(S - 22, 24, 19, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '22px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
      ctx.fillText('🔧', S - 22, 26);
    }
  });
}

function cardTexture(draw: CanvasDraw) {
  return canvasTexture(160, 96, (ctx, w, h) => {
    ctx.fillStyle = '#fffdf5';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(29,34,53,0.4)';
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, w - 5, h - 5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    draw(ctx, w, h);
  });
}

// ---------------------------------------------------------------- geometry

// a sticky with its bottom-right corner curling up off the board (for old notes)
function curledGeometry() {
  const g = new THREE.PlaneGeometry(STICKY, STICKY, 8, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / STICKY + 0.5; // 0..1 left to right
    const v = 0.5 - p.getY(i) / STICKY; // 0..1 top to bottom
    const d = Math.max(0, u + v - 1.35); // past the diagonal near the corner
    if (d > 0) {
      const lift = d * d * 0.16;
      p.setZ(i, lift);
      // pull the corner back in a touch as it rolls up
      p.setX(i, p.getX(i) - lift * 0.35);
      p.setY(i, p.getY(i) + lift * 0.35);
    }
  }
  g.computeVertexNormals();
  return g;
}

// a cylinder from a to b (Vector3s, in the parent's space)
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

// ---------------------------------------------------------------- the board

export function buildBoard(theme = THEMES.classic): Board {
  const T = theme;
  const accent = T.brand?.accent || T.mug.band;
  const glowHex = T.brand?.accent || '#ffc93c'; // the hover glow: brand orange, or lamp-light yellow
  const pinColors = T.brand ? PINS.brand(accent) : PINS.classic;

  const group = new THREE.Group();
  group.position.copy(BOARD.position);
  group.rotation.y = BOARD.yaw;

  // body: everything that moves (hover scale, lift); its origin is on the desk under the
  // board's bottom edge, so it grows upward and tips about its feet
  const body = new THREE.Group();
  group.add(body);
  const tilt = new THREE.Group(); // the board itself, leaning back on its kickstand
  tilt.position.y = FOOT;
  tilt.rotation.x = -BOARD.lean;
  body.add(tilt);
  const face = new THREE.Group(); // the board's middle, on the cork's front face
  face.position.y = H / 2;
  tilt.add(face);

  const owned: { dispose(): void }[] = []; // geometries / materials / textures made once, freed on dispose()
  const own = <T extends { dispose(): void }>(x: T) => (owned.push(x), x);

  // ---- frame
  const frameMat = own(toon(T.desk.frame));
  const frameBars = [
    [W, BAR, 0, H / 2 - BAR / 2],
    [W, BAR, 0, -H / 2 + BAR / 2],
    [BAR, H - 2 * BAR + 0.002, -W / 2 + BAR / 2, 0],
    [BAR, H - 2 * BAR + 0.002, W / 2 - BAR / 2, 0],
  ];
  for (const [w, h, x, y] of frameBars) {
    face.add(mesh(own(new RoundedBoxGeometry(w, h, DEPTH, 2, 0.006)), frameMat, x, y, DEPTH / 2 - 0.012 + CORK_Z));
  }
  // brand themes: little accent caps on the corners
  if (T.brand) {
    const capMat = own(toon(accent));
    const capGeo = own(new RoundedBoxGeometry(BAR + 0.006, BAR + 0.006, DEPTH + 0.004, 2, 0.006));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) face.add(mesh(capGeo, capMat, sx * (W / 2 - BAR / 2), sy * (H / 2 - BAR / 2), DEPTH / 2 - 0.012 + CORK_Z));
  }

  // ---- cork face (cork on the front, plain board on the back)
  const cork = corkTexture();
  own(cork.tex);
  const corkMat = own(toon('#ffffff', { map: cork.tex }));
  const backMat = own(toon(mixHex(T.desk.frame, '#ffffff', 0.25)));
  const corkMesh = mesh(own(new THREE.BoxGeometry(CORK_W, CORK_H, 0.012)), [backMat, backMat, backMat, backMat, corkMat, backMat], 0, 0, CORK_Z - 0.006);
  corkMesh.receiveShadow = true;
  face.add(corkMesh);

  // ---- feet and kickstand
  const footGeo = own(new RoundedBoxGeometry(0.05, FOOT + 0.006, 0.08, 2, 0.008));
  for (const sx of [-1, 1]) body.add(mesh(footGeo, frameMat, sx * (W / 2 - 0.05), (FOOT + 0.006) / 2, -0.012));
  {
    // from the back of the board, two-thirds up, down to the desk behind it
    const top = new THREE.Vector3(0, H * 0.62, CORK_Z - 0.014);
    const footBody = new THREE.Vector3(0, 0.004 - FOOT, -0.13); // tilt-pivot space before the lean
    const foot = footBody.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), BOARD.lean); // undo the lean
    const strut = rod(top, foot, 0.007, frameMat);
    own(strut.geometry);
    tilt.add(strut);
  }

  // ---- hover halo: a soft glow just behind the frame
  const halo = haloTexture();
  own(halo.tex);
  const haloMat = own(noOutline(new THREE.MeshBasicMaterial({ map: halo.tex, color: glowHex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })));
  const haloMesh = mesh(own(new THREE.PlaneGeometry(W + 0.07, H + 0.07)), haloMat, 0, 0, CORK_Z - 0.02);
  haloMesh.raycast = () => {};
  haloMesh.visible = false;
  face.add(haloMesh);

  // ---- count badge on the top-right corner
  const badgeTex = canvasTexture(96, 96);
  own(badgeTex.tex);
  const badge = new THREE.Group();
  badge.position.set(W / 2 - 0.004, H / 2 - 0.004, CORK_Z + 0.016);
  const badgeR = 0.032;
  const badgeDisc = mesh(own(new THREE.CylinderGeometry(badgeR, badgeR, 0.008, 24)), own(toon(accent)));
  badgeDisc.rotation.x = Math.PI / 2;
  badge.add(badgeDisc);
  badge.add(mesh(own(new THREE.CircleGeometry(badgeR * 0.98, 24)), own(noOutline(new THREE.MeshBasicMaterial({ map: badgeTex.tex, transparent: true, toneMapped: false }))), 0, 0, 0.0045));
  badge.visible = false;
  face.add(badge);
  function drawBadge(n: number) {
    const { ctx } = badgeTex;
    ctx.clearRect(0, 0, 96, 96);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(48, 48, 46, 0, Math.PI * 2);
    ctx.fill();
    const s = n > 99 ? '99+' : String(n);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${s.length > 2 ? 36 : s.length > 1 ? 52 : 66}px "Segoe UI", sans-serif`;
    ctx.fillText(s, 48, 52);
    badgeTex.tex.needsUpdate = true;
  }

  // ---- shared bits for the pinned papers
  const flatGeo = own(new THREE.PlaneGeometry(STICKY, STICKY));
  const curlGeo = own(curledGeometry());
  const shadowGeo = own(new THREE.PlaneGeometry(STICKY, STICKY));
  const shadowMat = own(noOutline(new THREE.MeshBasicMaterial({ color: '#3a2410', transparent: true, opacity: 0.32, depthWrite: false })));
  const pinGeo = own(new THREE.SphereGeometry(0.0085, 10, 8));
  const pinMats = new Map<string, THREE.MeshToonMaterial>();
  const pinMat = (c: string) => {
    if (!pinMats.has(c)) pinMats.set(c, own(toon(c)));
    return pinMats.get(c)!; // (made just above if it wasn't there)
  };

  // "+N" card and the "all clear" card
  const moreTex = cardTexture(() => {});
  own(moreTex.tex);
  const cardMatOf = (tex: THREE.Texture) => own(noOutline(toon('#ffffff', { map: tex, side: THREE.DoubleSide })));
  const more = paper(own(new THREE.PlaneGeometry(0.075, 0.045)), cardMatOf(moreTex.tex), 0.11, -0.07, -0.1, pinMat(accent), 0.012, 0.026);
  more.visible = false;
  const clear = cardTexture((ctx, w, h) => {
    ctx.fillStyle = '#2fa36b';
    ctx.font = `900 64px "Segoe UI Symbol", "Segoe UI", sans-serif`;
    ctx.fillText('✓', 34, h / 2 + 4);
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.font = `700 34px ${HAND}`;
    for (const [word, y] of [['all', h / 2 - 18], ['clear', h / 2 + 20]] as const) {
      ctx.strokeText(word, 106, y);
      ctx.fillText(word, 106, y);
    }
  });
  own(clear.tex);
  const allClear = paper(own(new THREE.PlaneGeometry(0.16, 0.096)), cardMatOf(clear.tex), 0, 0.0, 0.05, pinMat(accent), 0.006, 0.058);
  allClear.visible = false;
  function drawMore(n: number) {
    const { ctx } = moreTex;
    ctx.fillStyle = '#fffdf5';
    ctx.fillRect(6, 6, 148, 84);
    ctx.fillStyle = INK;
    const label = `+${Math.min(n, 999)}`;
    ctx.font = `900 ${label.length > 3 ? 44 : 58}px "Segoe UI", sans-serif`;
    ctx.fillText(label, 84, 52);
    moreTex.tex.needsUpdate = true;
  }

  // a pinned paper: pivot at the pin, the paper hanging below it, a soft shadow behind
  // (pinX: how far left of the middle the pin goes)
  function paper(geo: THREE.PlaneGeometry, mat: THREE.Material, x: number, y: number, rot: number, pinMaterial: THREE.Material, z = 0.004, pinX = 0) {
    const g = new THREE.Group();
    const hh = geo.parameters?.height ?? STICKY;
    const drop = Math.min(PIN_DROP, hh * 0.3);
    g.position.set(x - pinX, y + hh / 2 - drop, CORK_Z + z);
    g.rotation.z = rot;
    const sheet = mesh(geo, mat, pinX, -(hh / 2 - drop), 0);
    g.add(sheet);
    const sh = mesh(geo === curlGeo ? shadowGeo : geo, shadowMat, pinX + 0.004, -(hh / 2 - drop) - 0.004, -0.0025);
    sh.raycast = () => {};
    sh.renderOrder = -1;
    g.add(sh);
    const pin = mesh(pinGeo, pinMaterial, 0, 0, 0.006);
    g.add(pin);
    g.userData = { sheet, pin, base: rot, phase: hash(x * 13 + y * 7) * 6.28 };
    face.add(g);
    return g;
  }

  // the solid parts cast shadows on the desk (the papers are too thin to bother)
  group.traverse((o) => {
    if (o instanceof THREE.Mesh && (Array.isArray(o.material) || (!(o.material instanceof THREE.MeshBasicMaterial) && !o.material.transparent)) && o.parent !== more && o.parent !== allClear) o.castShadow = true;
  });

  // ---- the notes
  let notes: PinnedNote[] = []; // [{ id, group, sheet, pin, tex, mat }]
  let shownKey: string | null = null;
  const hitOwner = new Map<THREE.Object3D, string | undefined>(); // mesh -> note id
  function clearNotes() {
    for (const n of notes) {
      n.group.removeFromParent();
      n.tex.dispose();
      n.mat.dispose();
      hitOwner.delete(n.sheet);
      hitOwner.delete(n.pin);
    }
    notes = [];
  }
  function setNotes(items: BoardNote[] = [], total = items?.length || 0) {
    const list = (items || []).slice(0, 5);
    total = Math.max(Number(total) || 0, list.length);
    const key = JSON.stringify([total, list.map((x) => [x.id, x.text, !!x.important, (x.age || 0) >= 3, !!x.working])]);
    if (key === shownKey) return;
    shownKey = key;
    clearNotes();
    const spots = LAYOUTS[list.length];
    // each note keeps its own colour (from its id), but no two alike on the board
    const taken = new Set();
    const colourOf = (id: string | number) => {
      let c = Math.floor(hash(id) * PAPER.length) % PAPER.length;
      while (taken.has(c) && taken.size < PAPER.length) c = (c + 1) % PAPER.length;
      taken.add(c);
      return PAPER[c];
    };
    list.forEach((item, i) => {
      const [x, y, s] = spots[i];
      const old = (item.age || 0) >= 3;
      const r = hash(item.id ?? i);
      let paperColor = item.important ? PAPER_IMPORTANT : colourOf(item.id ?? i);
      if (old) paperColor = mixHex(paperColor, PAPER_OLD, 0.55);
      const tex = stickyTexture(item, paperColor);
      const mat = noOutline(toon('#ffffff', { map: tex.tex, side: THREE.DoubleSide }));
      const rot = (r - 0.5) * 0.26 + (i % 2 ? 0.04 : -0.04);
      const pc = item.important ? '#d42a35' : pinColors[i % pinColors.length];
      const g = paper(old ? curlGeo : flatGeo, mat, x, y, rot, pinMat(pc), 0.004 + i * 0.0012);
      g.scale.setScalar(s);
      const { sheet, pin } = g.userData as PaperParts;
      hitOwner.set(sheet, item.id);
      hitOwner.set(pin, item.id);
      notes.push({ id: item.id, group: g, sheet, pin, tex: tex.tex, mat });
    });
    allClear.visible = list.length === 0;
    const extra = total - list.length;
    more.visible = extra > 0 && list.length > 0;
    if (more.visible) drawMore(extra);
    // the "+N" card goes in the emptiest corner for this many
    if (more.visible) more.position.set(0.11 - 0.026, list.length === 4 ? -0.064 : -0.05, CORK_Z + 0.012);
    badge.visible = total > 0;
    if (badge.visible) drawBadge(total);
  }

  // ---- hover / lift
  let hoverTo = 0;
  let hover = 0;
  let liftTo = 0;
  let lift = 0;
  const baseEmissive = new THREE.Color(0, 0, 0);
  const glowColor = new THREE.Color(glowHex);
  // the frame's ink outline turns into a glowing rim on hover (OutlineEffect reads this every render)
  const inkColor = new THREE.Color(0.11, 0.13, 0.2);
  const rim = { color: [inkColor.r, inkColor.g, inkColor.b], thickness: 0.004 };
  frameMat.userData.outlineParameters = rim;
  const rimColor = new THREE.Color();
  function apply(t: number) {
    const k = lift;
    const s = 1 + 0.08 * hover + 0.06 * k;
    body.scale.setScalar(s);
    body.position.set(-0.035 * k, 0.07 * k, 0.03 * k); // up, out and a little left (clear of the chair)
    body.rotation.y = 0.24 * k + Math.sin(t * 2.6) * 0.03 * k;
    body.rotation.z = Math.sin(t * 3.1) * 0.025 * k;
    tilt.rotation.x = -BOARD.lean - 0.24 * k;
    haloMat.opacity = Math.max(hover, k * 0.6) * 0.85;
    haloMesh.visible = haloMat.opacity > 0.01;
    frameMat.emissive.copy(baseEmissive).lerp(glowColor, 0.3 * hover);
    rimColor.copy(inkColor).lerp(glowColor, hover);
    rim.color[0] = rimColor.r;
    rim.color[1] = rimColor.g;
    rim.color[2] = rimColor.b;
    rim.thickness = 0.004 + 0.005 * hover;
  }

  const v = new THREE.Vector3();
  return {
    group,
    setNotes,
    setHover(on) {
      hoverTo = on ? 1 : 0;
    },
    setLift(k) {
      liftTo = Math.max(0, Math.min(1, Number(k) || 0));
    },
    hit(raycaster) {
      group.updateWorldMatrix(true, true); // (stored matrices can be stale between frames)
      const hits = raycaster.intersectObject(group, true);
      for (const h of hits) {
        if (!h.object.visible) continue;
        if (hitOwner.has(h.object)) return { kind: 'note', id: hitOwner.get(h.object) };
        return { kind: 'board' };
      }
      return null;
    },
    stickyAt(id, out = v) {
      const n = notes.find((x) => x.id === id);
      if (!n) return null;
      n.sheet.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(n.sheet.matrixWorld);
    },
    update(t, dt) {
      hover += (hoverTo - hover) * ease(dt, 10);
      lift += (liftTo - lift) * ease(dt, 7);
      if (Math.abs(hover - hoverTo) < 0.001) hover = hoverTo;
      if (Math.abs(lift - liftTo) < 0.001) lift = liftTo;
      apply(t);
      // the stickies stir a little, as if in a draught (more when held up)
      const flap = 1 + 2.5 * lift;
      for (const n of notes) {
        const { base, phase } = n.group.userData as PaperParts;
        n.group.rotation.z = base + Math.sin(t * 1.3 + phase) * 0.018 * flap;
        n.group.rotation.x = -0.05 - (0.5 + 0.5 * Math.sin(t * 0.9 + phase * 1.7)) * 0.07 * flap;
      }
    },
    dispose() {
      clearNotes();
      group.removeFromParent();
      for (const x of owned) x.dispose();
    },
    // for tuning / tests
    _parts: { body, tilt, face, badge, more, allClear },
  };
}
