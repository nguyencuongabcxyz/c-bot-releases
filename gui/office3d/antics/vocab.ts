import * as THREE from 'three';
import { toon, canvasTexture, noOutline } from '@/office3d/materials';
import type { Antic, AnticCtx, AnticPose } from './types';

// The vocabulary antics (main/vocab.js): you caught a word with the hotkey.
//   dictionary  a fat dictionary pops into its hands and it leafs through it,
//               nose in the book, while the monitor searches for the word
//               (c.text); it keeps at it until word-show takes over (or 30 s)
//   word-show   the book goes, and it holds up a flash card with the word on it
//               (c.text), then pops the card into the word box on the desk
//               (3.3–3.9). robot.js plays: card up 0.3, into the box 3.9.
// Only the shared rig (root, torso, head, arms) moves, so it works for every body.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)

type Side = 'L' | 'R';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a)); // eases 0 -> 1 over [a, b]
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
const once = (c: AnticCtx, key: string, at: number) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);
function blend(A: AnticPose, key: 'armL' | 'armR' | 'head', target: readonly number[], w: number) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const X = new THREE.Vector3(1, 0, 0);

// a point on a part of the robot, in office space (where the props live)
const at = (c: AnticCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c: AnticCtx, side: Side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];

// arm angles [pitch, out, elbow] that put a hand on a point (office space), and the
// stretch (A.reachL/R) to get there if it's too far (as awake.js)
function aim(c: AnticCtx, side: Side, p: THREE.Vector3, out: number[], most = 1.9) {
  const arm = armOf(c, side);
  const v = c.robot.torso.worldToLocal(c.set.office.localToWorld(AIM.copy(p))).sub(arm.shoulder.position);
  const u = Math.abs(arm.elbow.position.y) || 0.2;
  const L = Math.max(1e-4, v.length());
  out[0] = Math.atan2(-v.z, -v.y);
  out[1] = Math.asin(clamp(v.x / L, -1, 1)) * arm.side;
  if (L >= u + HAND) {
    out[2] = 0;
    return clamp(L / (u + HAND), 1, most);
  }
  out[2] = -(Math.PI - Math.acos(clamp((u * u + HAND * HAND - L * L) / (2 * u * HAND), -1, 1)));
  out[0] += Math.acos(clamp((u * u + L * L - HAND * HAND) / (2 * u * L), -1, 1));
  return 1;
}

// the robot's torso orientation in office space, tipped forward by `tip` (radians)
function facing(c: AnticCtx, out: THREE.Quaternion, tip = 0) {
  c.robot.torso.getWorldQuaternion(out);
  c.set.office.getWorldQuaternion(Q2).invert();
  out.premultiply(Q2);
  if (tip) out.multiply(Q2.setFromAxisAngle(X, tip));
  return out;
}

// pops in at `a` (with an overshoot) and away over [b, e]
function pop(s: number, a: number, b: number, e: number) {
  if (s < a) return 0;
  if (s < a + 0.2) return easeOut((s - a) / 0.2) * 1.15;
  if (s < a + 0.35) return 1.15 - 0.15 * ((s - a - 0.2) / 0.15);
  if (s < b) return 1;
  return Math.max(0, 1 - (s - b) / (e - b));
}

const sizeOf = (c: AnticCtx) => c.robot.root.scale.x / 0.82; // props grow with the robot

// (three's types leave the isMesh flag off Object3D)
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => 'isMesh' in o;
type Mapped = THREE.Material & { map?: THREE.Texture | null }; // (a material, maybe with a texture)
function dispose(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    o.geometry.dispose();
    for (const m of ([] as Mapped[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------- the dictionary

// An open hardback held up to read: the spine towards you (that's the side you
// see), the two halves opening back towards the robot, a page flipping over.
const BOOK = { w: 0.13, h: 0.19, d: 0.022, open: 0.62 };
function buildBook() {
  const book = new THREE.Group();
  const cover = toon('#b3261e');
  const paper = toon('#fbf5e6');
  const gold = toon('#f2c14e');
  const halves: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const half = new THREE.Group();
    half.rotation.y = side * BOOK.open; // swung back towards the reader
    const block = new THREE.Mesh(new THREE.BoxGeometry(BOOK.w, BOOK.h, BOOK.d), paper);
    block.position.set((side * BOOK.w) / 2, 0, -BOOK.d / 2);
    half.add(block);
    const board = new THREE.Mesh(new THREE.BoxGeometry(BOOK.w + 0.01, BOOK.h + 0.012, 0.008), cover);
    board.position.set((side * (BOOK.w + 0.01)) / 2, 0, 0.004);
    half.add(board);
    const band = new THREE.Mesh(new THREE.BoxGeometry(BOOK.w * 0.8, 0.012, 0.002), gold);
    band.position.set((side * BOOK.w) / 2, BOOK.h * 0.3, 0.009);
    half.add(band);
    book.add(half);
    halves.push(half);
  }
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, BOOK.h + 0.012, 10, 1, false, -Math.PI / 2, Math.PI), cover);
  spine.position.z = 0.002;
  book.add(spine);
  // the spine's title, on a label facing you
  const label = canvasTexture(32, 128, (ctx) => {
    ctx.fillStyle = '#f2c14e';
    ctx.translate(16, 64);
    ctx.rotate(-Math.PI / 2);
    ctx.font = '900 20px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A–Z', 0, 0);
  });
  const title = new THREE.Mesh(new THREE.PlaneGeometry(0.03, BOOK.h * 0.7), noOutline(new THREE.MeshToonMaterial({ map: label.tex, transparent: true })));
  title.position.z = 0.0185;
  book.add(title);
  // the page that flips over, from one half to the other
  const leaf = new THREE.Group();
  const page = new THREE.Mesh(new THREE.PlaneGeometry(BOOK.w * 0.96, BOOK.h * 0.94), toon('#fffaf0', { side: THREE.DoubleSide }));
  page.position.x = (BOOK.w * 0.96) / 2;
  leaf.add(page);
  leaf.position.z = -BOOK.d;
  book.add(leaf);
  return { book, leaf };
}

type BookRun = { book?: ReturnType<typeof buildBook> };

const dictionary: Antic<BookRun> = {
  dur: 30,
  fadeIn: 0.35,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run, w } = c;
    if (!run.book) {
      run.book = buildBook();
      c.set.office.add(run.book.book);
    }
    const { book, leaf } = run.book;
    const k = sizeOf(c);
    // held in front of its chest, tipped back towards its face
    at(c, c.robot.torso, 0, 0.36, 0.36, V3);
    book.position.copy(V3);
    facing(c, book.quaternion, -0.55);
    const size = pop(s, 0.05, 99, 100);
    book.scale.setScalar(Math.max(0.001, size * 1.25 * k));
    book.visible = size > 0.01;
    // a hand on each cover
    for (const [side, out] of [['L', QL], ['R', QR]] as const) {
      const sx = side === 'L' ? -1 : 1;
      V1.set(sx * Math.cos(BOOK.open) * BOOK.w * 0.9, -BOOK.h * 0.15, -Math.sin(BOOK.open) * BOOK.w * 0.9 + 0.02);
      book.localToWorld(V1);
      c.set.office.worldToLocal(V1);
      const r = aim(c, side, V1, out, 2.2);
      blend(A, side === 'L' ? 'armL' : 'armR', out, w * seg(s, 0, 0.35));
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, w);
    }
    // leafing through: a page every ~1.2 s, flipping right to left
    const flip = ((s - 0.6) / 1.2) % 1;
    const turning = s > 0.6 ? seg(flip, 0.1, 0.6) : 0;
    leaf.rotation.y = mix(BOOK.open, Math.PI - BOOK.open, turning);
    leaf.visible = s > 0.6 && flip > 0.08 && flip < 0.66;
    // nose in the book, a puzzled tilt now and then, the antenna (cowlick, ahoge…) wiggling as it thinks
    HEAD[0] = A.head[0] + 0.28;
    HEAD[1] = A.head[1] + Math.sin(s * 0.9) * 0.12;
    HEAD[2] = A.head[2] + Math.sin(s * 0.45) * 0.1;
    blend(A, 'head', HEAD, w);
    A.lean = mix(A.lean, 0.1, w);
    A.antenna += Math.sin(s * 9) * 0.25 * w;
    // the monitor searches for the word
    A.screen = `define:${c.text}`;
  },
  end(c) {
    dispose(c.run?.book?.book);
  },
};

// ---------------------------------------------------------------- the flash card

const CARD = { w: 0.36, h: 0.22, scale: 1.45 };
function buildCard(text: string) {
  const card = new THREE.Group();
  const face = canvasTexture(360, 220, (ctx, W, H) => {
    ctx.fillStyle = '#fffdf5';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff8fab';
    ctx.fillRect(0, 0, W, 22);
    ctx.strokeStyle = 'rgba(90,160,255,0.35)';
    ctx.lineWidth = 2;
    for (let y = 70; y < H; y += 34) {
      ctx.beginPath();
      ctx.moveTo(14, y);
      ctx.lineTo(W - 14, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#1d2235';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 64;
    ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    while (size > 22 && ctx.measureText(text).width > W - 36) {
      size -= 4;
      ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    }
    ctx.fillText(text, W / 2, H / 2 + 12);
  });
  const paper = toon('#fffdf5');
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(CARD.w, CARD.h, 0.006), paper);
  card.add(sheet);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(CARD.w, CARD.h), noOutline(new THREE.MeshToonMaterial({ map: face.tex })));
  front.position.z = 0.0035;
  card.add(front);
  return card;
}

type CardRun = { card?: THREE.Group };

const wordShow: Antic<CardRun> = {
  dur: 4.2,
  fadeIn: 0.3,
  fadeOut: 0.45,
  update(c, A) {
    const { s, run, w } = c;
    if (!run.card) {
      run.card = buildCard(c.text || '?');
      c.set.office.add(run.card);
    }
    const card = run.card;
    const k = sizeOf(c);
    // held up under its chin, a little bounce, then popped into the word box
    at(c, c.robot.torso, 0, 0.46 + 0.02 * Math.sin(s * 7) * seg(s, 0.4, 0.7) * (1 - seg(s, 2.6, 3.1)), 0.42, V3);
    facing(c, Q1, 0.12);
    const toBox = seg(s, 3.3, 3.9);
    const box = c.set.wordBox?.group;
    if (box && toBox > 0) {
      box.getWorldPosition(V2);
      c.set.office.worldToLocal(V2);
      V2.y += 0.12;
      V3.lerp(V2, toBox);
      V3.y += Math.sin(Math.PI * toBox) * 0.25; // an arc
    }
    card.position.copy(V3);
    card.quaternion.copy(Q1);
    if (toBox > 0) card.rotateX(-toBox * 1.2);
    const size = pop(s, 0.25, 3.4, box ? 3.95 : 3.7) * (box ? mix(1, 0.4, toBox) : 1);
    card.scale.setScalar(Math.max(0.001, size * k * CARD.scale));
    card.visible = size > 0.01;
    // both hands on its edges, letting go as it flies off
    const hold = seg(s, 0.05, 0.3) * (1 - seg(s, 3.1, 3.5));
    for (const [side, out] of [['L', QL], ['R', QR]] as const) {
      const sx = side === 'L' ? -1 : 1;
      at(c, c.robot.torso, sx * CARD.w * 0.45 * k * CARD.scale, 0.42, 0.42, V1);
      const r = aim(c, side, V1, out, 2.2);
      blend(A, side === 'L' ? 'armL' : 'armR', out, w * hold);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, w * hold);
    }
    // peeking over the card, proud; watching it go into the box
    HEAD[0] = A.head[0] + 0.06 + 0.2 * toBox;
    HEAD[1] = A.head[1] + 0.35 * toBox;
    HEAD[2] = A.head[2] + 0.14 * Math.sin(Math.min(1, s / 0.8) * Math.PI) * (1 - toBox);
    blend(A, 'head', HEAD, w);
    if (once(c, 'sparkle', 0.45)) {
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * (0.2 + i * 0.2);
        c.emit('star', V3, { life: 0.6, vel: new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0), size: 0.08, gravity: 0.6, spin: 5 });
      }
    }
  },
  end(c) {
    dispose(c.run?.card);
  },
};

// ---------------------------------------------------------------- the quiz

// A quiz (main/reminders.js): it holds up a flash card of the word (c.text) and
// waits, head tilted, bobbing a little, until you answer on the word card
// (robot.js then stops it) or two minutes are up.
const quizCard: Antic<CardRun> = {
  dur: 120,
  fadeIn: 0.35,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run, w } = c;
    if (!run.card) {
      run.card = buildCard(c.text || '?');
      c.set.office.add(run.card);
    }
    const card = run.card;
    const k = sizeOf(c);
    const bob = Math.sin(s * 2.2) * 0.012;
    at(c, c.robot.torso, 0, 0.5 + bob, 0.42, V3);
    card.position.copy(V3);
    facing(c, card.quaternion, 0.12);
    card.rotateZ(Math.sin(s * 1.1) * 0.05);
    const size = pop(s, 0.2, 999, 1000);
    card.scale.setScalar(Math.max(0.001, size * k * CARD.scale));
    card.visible = size > 0.01;
    const hold = seg(s, 0.05, 0.3);
    for (const [side, out] of [['L', QL], ['R', QR]] as const) {
      const sx = side === 'L' ? -1 : 1;
      at(c, c.robot.torso, sx * CARD.w * 0.45 * k * CARD.scale, 0.46 + bob, 0.42, V1);
      const r = aim(c, side, V1, out, 2.2);
      blend(A, side === 'L' ? 'armL' : 'armR', out, w * hold);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, w * hold);
    }
    // peeking over the top of it at you, curious
    HEAD[0] = A.head[0] + 0.04;
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.16 * Math.sin(s * 0.7);
    blend(A, 'head', HEAD, w);
    A.antenna += Math.sin(s * 3) * 0.12 * w;
  },
  end(c) {
    dispose(c.run?.card);
  },
};

// A glance at your words: it swivels round to its monitor, which shows one of the
// words you're learning ("wordcard:word|meaning|phrase"), and reads it with a nod.
// robot.js says the word and its meaning at 3.5.
const wordGlance: Antic = {
  dur: 7,
  fadeIn: 0.7,
  fadeOut: 0.8,
  update(c, A) {
    const { s, w } = c;
    A.screen = `wordcard:${c.text}`;
    A.yaw = wrap(c.monitorYaw - c.curYaw) * 0.3 * w; // a look over its shoulder: its face and the screen both in view
    HEAD[0] = A.head[0] + 0.05 + 0.06 * Math.max(0, Math.sin((s - 2.5) * 5)) * seg(s, 2.4, 2.6) * (1 - seg(s, 3.4, 3.6));
    HEAD[1] = A.head[1] + 0.25;
    HEAD[2] = A.head[2] + 0.06 * Math.sin(s * 0.8);
    blend(A, 'head', HEAD, w);
    A.lean = mix(A.lean, 0.08, w);
  },
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export const VOCAB: Record<string, Antic> = { dictionary, 'word-show': wordShow, 'quiz-card': quizCard, 'word-glance': wordGlance };
