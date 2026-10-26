import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { toon, glow } from '@/office3d/materials';
import type { Antic, AnticCtx, AnticPose, TickCtx, Vec3Tuple } from './types';

// IT-office antics at the desk: rubber duck debugging, turning the monitor off
// and on again, copying from Stack Overflow, yanking a cable, and shaking the
// crumbs (sometimes a whole cookie) out of the keyboard.
// Timings are a contract: robot.js plays sounds and speech at the marked moments.
// The desk is behind the robot (it faces you), so everything here turns only
// part of the way round and lets the arms stretch the rest, keeping its face in view.
// Only the shared rig (root, torso, head, arms) moves, so it works for every body.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)

type Side = 'L' | 'R';
type PoseKey = 'head' | 'armL' | 'armR';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a)); // eases 0 -> 1 over [a, b]
const win = (s: number, a: number, b: number, c: number, d: number) => seg(s, a, b) * (1 - seg(s, c, d)); // 0 -> 1 -> 0
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (p: THREE.Vector3) => Math.atan2(p.x - LAYOUT.chair.x, p.z - LAYOUT.chair.z);
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
// true the first frame at or past `at` (one-shot emits, whatever the frame rate)
const once = (c: AnticCtx, key: string, at: number) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);

// Key-framed values: start from `from`, then ease toward each [t0, t1, to] in turn.
function track(s: number, from: number, keys: [number, number, number][]) {
  let v = from;
  for (const [a, b, to] of keys) v = mix(v, to, seg(s, a, b));
  return v;
}
function pose(out: Vec3Tuple, from: Vec3Tuple, s: number, keys: [number, number, Vec3Tuple][]) {
  for (let i = 0; i < 3; i++) out[i] = from[i];
  for (const [a, b, to] of keys) {
    const k = seg(s, a, b);
    if (k > 0) for (let i = 0; i < 3; i++) out[i] = mix(out[i], to[i], k);
  }
  return out;
}
function blend(A: AnticPose, key: PoseKey, target: Vec3Tuple, w: number) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}
const set3 = (out: Vec3Tuple, a: number, b: number, c: number) => ((out[0] = a), (out[1] = b), (out[2] = c), out);
function toward3(out: Vec3Tuple, target: Vec3Tuple, k: number) {
  for (let i = 0; i < 3; i++) out[i] = mix(out[i], target[i], k);
}

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];
const QL: Vec3Tuple = [0, 0, 0];
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

// A point on a part of the robot (or the desk), in office space (= the world
// group the particles live in).
const at = (c: TickCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c: TickCtx, side: Side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
const handAt = (c: TickCtx, side: Side, out: THREE.Vector3) => at(c, armOf(c, side).elbow, 0, -HAND, 0, out);

// Arm angles [pitch, out, elbow] that put a hand on a point (office space), and
// the stretch (A.reachL/R) to get there if it's too far (as awake.js).
function aim(c: TickCtx, side: Side, p: THREE.Vector3, out: Vec3Tuple, most = 1.9) {
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

// chair swivel that brings an object round to `off` radians from straight ahead
function turnTo(c: TickCtx, p: THREE.Vector3, off: number) {
  const rel = wrap(yawOf(p) - c.curYaw);
  return rel - Math.sign(rel) * Math.min(Math.abs(rel), off);
}
// which hand is nearer a point ('L' / 'R'), and which way round that is (-1 / 1)
const sideOf = (c: TickCtx, p: THREE.Vector3): Side => (wrap(yawOf(p) - c.curYaw) < 0 ? 'L' : 'R');

// pops in at `a` (with an overshoot), swells and pops away over [b, e]
function pop(s: number, a: number, b: number, e: number) {
  if (s < a) return 0;
  if (s < a + 0.2) return easeOut((s - a) / 0.2) * 1.15;
  if (s < a + 0.35) return 1.15 - 0.15 * ((s - a - 0.2) / 0.15);
  if (s < b) return 1;
  const k = (s - b) / (e - b);
  return k < 0.3 ? 1 + 0.5 * k : Math.max(0, 1.15 * (1 - (k - 0.3) / 0.7));
}

function puff(c: TickCtx, from: THREE.Vector3, n: number, size = 0.07) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.emit('steam', from, { life: 0.45, vel: new THREE.Vector3(Math.cos(a) * 0.35, 0.15 + Math.random() * 0.1, Math.sin(a) * 0.35), size, grow: 2.2 });
  }
}
function stars(c: TickCtx, from: THREE.Vector3, n: number, speed = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.15 + (i / Math.max(1, n - 1)) * 0.7);
    c.emit('star', from, { life: 0.6, vel: new THREE.Vector3(Math.cos(a) * speed, Math.sin(a) * speed, 0), size: 0.08, gravity: 0.6, spin: 5 });
  }
}

// (three's types only put isMesh on a Mesh) the props built here have one material each
type PropMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
const isMesh = (o: THREE.Object3D): o is PropMesh => 'isMesh' in o && !!o.isMesh;

function dispose(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    o.geometry.dispose();
    o.material.dispose();
  });
}

// ------------------------------------------------------------ rubber duck

// A rubber duck pops onto the desk (0.3), it explains its bug to it with big
// gestures (0.8–3.6), the duck squeaks (3.8)... OH! (4.3), and the duck pops away (5.3).
const DUCK_AT = new THREE.Vector3(0.27, LAYOUT.deskTop, -0.69); // front right of the desk, in frame
const DUCK_SIZE = 1.9; // bigger than life, so it reads in the small window

function buildDuck() {
  const duck = new THREE.Group();
  const toy = new THREE.Group(); // squashes from its base
  duck.add(toy);
  const yellow = toon('#ffd23f');
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    toy.add(m);
    return m;
  };
  add(new THREE.SphereGeometry(0.05, 18, 12), yellow, 0, 0.034, 0, 0.9, 0.7, 1.15);
  add(new THREE.ConeGeometry(0.02, 0.045, 10), yellow, 0, 0.055, -0.056).rotation.x = -1.0; // tail
  for (const x of [-1, 1]) add(new THREE.SphereGeometry(0.03, 12, 8), yellow, x * 0.04, 0.04, -0.005, 0.35, 0.6, 1); // wings
  add(new THREE.SphereGeometry(0.033, 16, 12), yellow, 0, 0.088, 0.028);
  add(new THREE.SphereGeometry(0.017, 12, 8), toon('#ff8a1f'), 0, 0.081, 0.06, 1.15, 0.5, 1.3); // beak
  const eye = toon('#1d2235');
  for (const x of [-1, 1]) add(new THREE.SphereGeometry(0.0065, 8, 6), eye, x * 0.016, 0.098, 0.054);
  return { duck, toy };
}

const SO: Vec3Tuple = [-0.95, 0.6, -1.05]; // "so...": both hands open, out to the sides
const SHRUG: Vec3Tuple = [-0.55, 0.7, -1.75]; // palms up
const OH: Vec3Tuple = [-2.75, 0.5, -0.35]; // arms up: eureka!
const LAP: Vec3Tuple = [-0.45, 0.3, -1.3];

// (side is set with the duck, on the first frame)
type DuckRun = { duck?: ReturnType<typeof buildDuck>; side: Side };

const duck: Antic<DuckRun> = {
  dur: 6.0,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    if (!run.duck) {
      run.duck = buildDuck();
      run.duck.duck.position.copy(DUCK_AT);
      (c.set.desk?.top || c.set.office).add(run.duck.duck); // on the desktop (it rides up with a standing desk)
      run.side = sideOf(c, DUCK_AT);
    }
    const { duck: d, toy } = run.duck;
    const sd = run.side === 'L' ? -1 : 1;
    const near = run.side === 'L' ? 'armL' : 'armR';
    const far = run.side === 'L' ? 'armR' : 'armL';

    // the duck: faces between you and the robot; listens with little wobbles
    const size = pop(s, 0.3, 5.3, 5.6);
    d.visible = size > 0.01;
    d.scale.setScalar(Math.max(0.001, size * DUCK_SIZE));
    d.rotation.y = mix(Math.atan2(LAYOUT.chair.x - DUCK_AT.x, LAYOUT.chair.z - DUCK_AT.z), c.camYaw, 0.55);
    toy.rotation.z = 0.08 * Math.sin(s * 3.1) * win(s, 0.8, 1.0, 3.4, 3.7);
    // SQUEAK (3.8): squashed flat, then springs up tall
    const squash = bump(s, 3.75, 3.95);
    const spring = bump(s, 3.95, 4.2);
    toy.scale.set(1 + 0.3 * squash - 0.1 * spring, 1 - 0.4 * squash + 0.28 * spring, 1 + 0.3 * squash - 0.1 * spring);
    if (once(c, 'in', 0.3)) puff(c, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.05), 4);
    if (once(c, 'squeak', 3.8)) c.emit('squeak', V1.set(DUCK_AT.x + 0.15, DUCK_AT.y + 0.27, DUCK_AT.z + 0.1), { life: 0.9, vel: new THREE.Vector3(0, 0.22, 0), size: 0.3, grow: 1.25 });
    if (once(c, 'out', 5.45)) puff(c, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.06), 5);

    // the robot: turns a little towards it, then talks it through with its hands
    A.yaw = sd * track(s, 0, [[0.3, 0.8, 0.25], [5.3, 5.9, 0]]) * c.w;
    const talk = win(s, 0.7, 1.0, 3.45, 3.75);
    // point at the duck (straight arm, no stretch): 1.6–2.4
    aim(c, run.side, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.12), QR);
    QR[2] = -0.15;
    for (const [key, ph, isNear] of [[near, 0, true], [far, 1.7, false]] as const) {
      const out = isNear ? PR : PL;
      for (let i = 0; i < 3; i++) out[i] = A[key][i];
      // "so..." hands out, wiggling (0.8–1.6)
      set3(QL, SO[0] + 0.12 * Math.sin(s * 9 + ph), SO[1] + 0.12 * Math.sin(s * 6 + ph), SO[2] + 0.35 * Math.sin(s * 7 + ph));
      toward3(out, QL, win(s, 0.7, 1.0, 1.5, 1.75));
      // "...and THIS one": the near hand points, the far one beats time (1.6–2.4)
      if (isNear) toward3(out, QR, win(s, 1.5, 1.75, 2.3, 2.55));
      else toward3(out, set3(QL, -1.05 + 0.3 * Math.sin(s * 13), 0.25, -1.3), win(s, 1.5, 1.75, 2.3, 2.55));
      // "...then this, then this": rolling hands (2.4–3.0)
      set3(QL, -1.0 + 0.3 * Math.sin(s * 10 + ph * 1.85), 0.3, -1.35 + 0.35 * Math.cos(s * 10 + ph * 1.85));
      toward3(out, QL, win(s, 2.3, 2.55, 2.9, 3.1));
      // "...and it doesn't work!": shrug (3.0–3.6)
      toward3(out, SHRUG, win(s, 2.9, 3.1, 3.55, 3.8));
      // hands in the lap, waiting for the duck... then OH! arms up (4.3)
      toward3(out, LAP, win(s, 3.55, 3.8, 4.2, 4.32));
      set3(QL, OH[0], OH[1] + Math.sin(s * 14) * 0.15, OH[2]);
      toward3(out, QL, win(s, 4.22, 4.36, 4.9, 5.35));
      blend(A, key, out, c.w);
    }
    // the shrug lifts the shoulders; OH! is a hop
    A.rootY += (0.025 * win(s, 2.9, 3.1, 3.55, 3.8) + 0.13 * bump(s, 4.3, 4.7)) * c.w;
    A.lean = mix(A.lean, A.lean + 0.08 * talk + 0.04 * Math.sin(s * 6) * talk - 0.08 * bump(s, 3.8, 4.1) - 0.06 * win(s, 4.3, 4.4, 4.9, 5.3), c.w);
    // head: down at the duck, bobbing as it talks; startled by the squeak; chin up for OH!
    const oh = win(s, 4.25, 4.4, 4.9, 5.3);
    HEAD[0] = track(s, A.head[0], [[0.3, 0.8, 0.22], [5.3, 5.9, A.head[0]]]) + 0.06 * Math.sin(s * 8) * talk - 0.12 * bump(s, 3.8, 4.15);
    HEAD[0] = mix(HEAD[0], -0.22, oh);
    HEAD[1] = sd * track(s, 0, [[0.3, 0.8, 0.32], [1.0, 1.4, 0.05], [1.6, 1.9, 0.32], [2.5, 2.8, 0], [3.6, 3.8, 0.35], [4.25, 4.45, -0.05], [5.3, 5.8, 0]]);
    HEAD[2] = 0.14 * win(s, 2.9, 3.1, 3.55, 3.8) * sd + 0.1 * bump(s, 3.8, 4.25) * -sd;
    blend(A, 'head', HEAD, c.w);
    if (once(c, 'oh', 4.3)) c.emit('bulb', at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.22, 0, V1), { life: 1.3, vel: new THREE.Vector3(0, 0.12, 0), size: 0.24 });
  },
  end(c) {
    dispose(c.run?.duck?.duck);
  },
};

// ------------------------------------------------------------ reboot

// The screen's frozen. Glares at it (0.3), taps it (1.4, 1.7), reaches round the
// back and presses power (3.0): black (3.0–3.6), boots (3.6–5.6), thumbs up (5.8).
const CROSS_NEAR = new THREE.Vector3(0.12, 0.22, 0.22); // arms folded (torso space, x towards the far side)
const THUMB_ARM: Vec3Tuple = [-1.3, 0.5, -1.3]; // out to the side, forearm up: fist by its shoulder

// a mesh with a coloured material: what the hand is (the next line checks it has a colour)
type Tinted = THREE.Mesh<THREE.BufferGeometry, THREE.Material & { color: THREE.Color }>;

// a stubby thumb in the colour of its hand (custom models: none)
function buildThumb(c: TickCtx, side: Side) {
  let best: Tinted | null = null;
  let bestR = 0;
  for (const o of armOf(c, side).elbow.children) {
    const m = (isMesh(o) ? o : o.children.find((k) => isMesh(k))) as Tinted | undefined;
    if (!m?.material?.color || o.position.y > -0.12) continue;
    m.geometry.boundingSphere || m.geometry.computeBoundingSphere();
    const r = m.geometry.boundingSphere!.radius * m.scale.x; // (computed just above if it wasn't)
    if (r > bestR) {
      best = m;
      bestR = r;
    }
  }
  if (!best) return null;
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.06, 4, 10), toon(best.material.color.clone()));
  thumb.castShadow = true;
  return thumb;
}

// (turn is set with side, on the first frame)
type RebootRun = { side?: Side; turn: number; thumb?: ReturnType<typeof buildThumb> };

const reboot: Antic<RebootRun> = {
  dur: 7.0,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    A.screen = s < 3.6 ? 'frozen' : s < 5.6 ? 'boot' : null;
    if (s >= 3.0 && s < 3.6) A.screenDim = 1;
    const mon = c.set.screen.light.parent!; // the monitor (the screen's light hangs off it)
    if (run.side === undefined) {
      // the right-hand part of the screen, which shows over its shoulder: it stays
      // facing you (a quarter turn at most) and reaches back over the shoulder
      run.side = sideOf(c, at(c, mon, 0.3, 0.68, 0, V1));
      run.turn = (run.side === 'L' ? -1 : 1) * 0.35;
    }
    const sd = run.side === 'L' ? -1 : 1;
    const near = run.side === 'L' ? 'armL' : 'armR';
    const far = run.side === 'L' ? 'armR' : 'armL';
    const farSide = run.side === 'L' ? 'R' : 'L';
    A.yaw = track(s, 0, [[0.1, 0.6, run.turn], [5.2, 5.8, 0]]) * c.w;

    // the near hand: taps on the screen (1.4, 1.7), round the side, the button on the back (3.0)
    const gap = 0.09 * (1 - bump(s, 1.27, 1.53) - bump(s, 1.57, 1.83));
    at(c, mon, 0.26, 0.66, 0.035 + gap, V2);
    at(c, mon, 0.58, 0.6, 0.03, V3);
    V2.lerp(V3, seg(s, 2.05, 2.45));
    at(c, mon, 0.4, 0.48, -0.08 + 0.022 * bump(s, 2.9, 3.12), V3);
    V2.lerp(V3, seg(s, 2.45, 2.85));
    const r = aim(c, run.side, V2, QR, 3.0);
    const reach = win(s, 1.0, 1.25, 3.15, 3.7);
    // folded arms while glaring (and the far one until it's booted)
    at(c, c.robot.torso, -sd * CROSS_NEAR.x, CROSS_NEAR.y, CROSS_NEAR.z, V3);
    aim(c, run.side, V3, PR);
    at(c, c.robot.torso, sd * CROSS_NEAR.x, CROSS_NEAR.y + 0.05, CROSS_NEAR.z + 0.02, V3);
    aim(c, farSide, V3, PL);
    blend(A, near, PR, (win(s, 0.15, 0.5, 1.0, 1.25) + win(s, 3.4, 3.8, 5.0, 5.5)) * c.w);
    blend(A, far, PL, win(s, 0.15, 0.5, 5.0, 5.5) * c.w);
    blend(A, near, QR, reach * c.w);
    A[near === 'armL' ? 'reachL' : 'reachR'] = mix(1, r, reach * c.w);
    // ...then a thumbs up, to you (5.8–6.8)
    const thumbs = win(s, 5.65, 5.95, 6.75, 7.0);
    set3(PL, THUMB_ARM[0], THUMB_ARM[1], THUMB_ARM[2] + 0.12 * bump(s, 5.95, 6.25));
    blend(A, 'armR', PL, thumbs * c.w);

    // leans back towards the monitor behind it (tipping the chair) to reach
    A.lean = mix(A.lean, A.lean + 0.08 * win(s, 0.3, 0.6, 1.0, 1.2) - 0.1 * reach + 0.06 * bump(s, 5.0, 5.6), c.w);
    A.tip += (0.08 * reach + 0.04 * win(s, 2.1, 2.6, 3.1, 3.6)) * c.w;
    // head: up and round at the screen (glaring, then following the hand round the back,
    // then watching it boot), then you
    HEAD[0] = track(s, A.head[0], [[0.2, 0.5, -0.22], [1.0, 1.3, -0.32], [2.2, 2.6, -0.22], [3.2, 3.6, -0.28], [5.3, 5.8, -0.08]]);
    HEAD[1] = sd * track(s, 0, [[0.2, 0.5, 0.45], [1.0, 1.3, 0.4], [2.2, 2.6, 0.55], [3.2, 3.6, 0.4], [5.3, 5.8, 0]]);
    HEAD[2] = -sd * 0.14 * win(s, 0.2, 0.5, 1.0, 1.3) + 0.12 * win(s, 5.8, 6.0, 6.6, 6.9); // annoyed tilt; a proud one
    blend(A, 'head', HEAD, c.w);

    // the thumb sits on top of the fist
    if (s >= 5.7 && run.thumb === undefined) {
      run.thumb = buildThumb(c, 'R');
      if (run.thumb) c.set.office.add(run.thumb);
    }
    if (run.thumb) {
      const k = c.robot.root.scale.x / 0.82;
      const size = pop(s, 5.85, 6.7, 6.95);
      handAt(c, 'R', run.thumb.position);
      run.thumb.position.y += 0.09 * k;
      run.thumb.scale.setScalar(Math.max(0.001, size * k));
      run.thumb.visible = size > 0.01;
    }
    if (once(c, 'ding', 6.0)) stars(c, handAt(c, 'R', V1).setY(V1.y + 0.12), 3, 0.45);
  },
  end(c) {
    dispose(c.run?.thumb);
  },
};

// ------------------------------------------------------------ stack overflow

// Pulls the keyboard over (so its end shows past its shoulder) and reads the
// answer leaning in (0–1.6); a dramatic Ctrl+C (1.8) and Ctrl+V (2.9), each one a
// hand raised high and slammed on the keyboard; then a guilty look round (3.6–4.8)
// while it pushes the keyboard back.
const UP_HIGH: Vec3Tuple = [-3.05, 0.2, -0.1];
const REST: Vec3Tuple = [-0.7, 0.25, -1.25];
const KB_SLIDE = 0.28; // along the keyboard, towards its right-hand end
const KB_X = new THREE.Vector3();

// (side and turn are set with home, on the first frame)
type StackRun = { home?: { pos: THREE.Vector3; quat: THREE.Quaternion }; side: Side; turn: number };

const stackoverflow: Antic<StackRun> = {
  dur: 5.0,
  update(c, A) {
    const { s, run } = c;
    A.screen = 'stackoverflow';
    const kb = c.set.keyboard;
    if (!run.home) {
      run.home = { pos: kb.position.clone(), quat: kb.quaternion.clone() };
      // the keyboard's right-hand end: past its shoulder once slid over; half turned towards it
      run.side = sideOf(c, at(c, kb, 0.25, 0, 0, V1));
      run.turn = (run.side === 'L' ? -1 : 1) * 0.3;
    }
    const sd = run.side === 'L' ? -1 : 1;
    const near = run.side === 'L' ? 'armL' : 'armR';
    const other = run.side === 'L' ? 'armR' : 'armL';
    A.yaw = track(s, 0, [[0, 0.6, run.turn], [3.4, 3.9, run.turn * 0.5], [4.5, 4.95, 0]]) * c.w;
    // slid over (0.4–0.85) and back again (4.05–4.55)
    KB_X.set(1, 0, 0).applyQuaternion(run.home.quat);
    kb.position.copy(run.home.pos).addScaledVector(KB_X, KB_SLIDE * (seg(s, 0.4, 0.85) - seg(s, 4.05, 4.55)));
    // the hand: on the keyboard's end to slide it, up high, SLAM on a key (pressed in), ...
    const rk = aim(c, run.side, at(c, kb, 0.27, 0.03, 0, V1), QL, 2.6);
    at(c, kb, 0.2, 0.035 - 0.012 * (win(s, 1.76, 1.8, 2.0, 2.1) + win(s, 2.86, 2.9, 3.1, 3.2)), 0, V2);
    const r = aim(c, run.side, V2, QR, 2.6);
    pose(PR, A[near], s, [[0.15, 0.4, QL], [0.85, 1.1, REST], [1.3, 1.68, UP_HIGH], [1.72, 1.8, QR], [2.4, 2.78, UP_HIGH], [2.82, 2.9, QR], [3.3, 3.7, REST], [3.8, 4.05, QL], [4.55, 4.9, A[near]]]);
    PR[1] += 0.1 * Math.sin(s * 30) * (bump(s, 1.45, 1.72) + bump(s, 2.55, 2.82)); // trembling with drama
    blend(A, near, PR, c.w);
    A[near === 'armL' ? 'reachL' : 'reachR'] = mix(1, track(s, 1, [[0.15, 0.4, rk], [0.85, 1.1, 1], [1.3, 1.68, 1.45], [1.72, 1.8, r], [2.4, 2.78, 1.45], [2.82, 2.9, r], [3.3, 3.7, 1], [3.8, 4.05, rk], [4.55, 4.9, 1]]), c.w);
    pose(PL, A[other], s, [[0.1, 0.6, REST], [4.5, 4.95, A[other]]]);
    blend(A, other, PL, c.w);

    // leaning in (back, towards the screen behind it) to read; up for the wind-up; hunched after
    const raise = win(s, 1.3, 1.68, 1.72, 1.8) + win(s, 2.4, 2.78, 2.82, 2.9);
    const lean = track(s, A.lean, [[0, 0.8, -0.04], [3.3, 3.8, 0.16], [4.5, 4.95, A.lean]]) - 0.1 * raise; // (not bent over on the slam: the head would hide the hand)
    A.lean = mix(A.lean, lean, c.w);
    A.tip += 0.09 * win(s, 0, 0.8, 1.35, 1.7) * c.w;
    A.rootY += (0.04 * raise - 0.03 * (bump(s, 1.78, 2.05) + bump(s, 2.88, 3.15)) - 0.025 * win(s, 3.5, 3.7, 4.6, 4.9)) * c.w; // up for the drama, down with the slam, hunched after
    if (s >= 1.8 && s < 2.15) A.shake = Math.max(A.shake, 0.6 * (1 - (s - 1.8) / 0.35));
    if (s >= 2.9 && s < 3.25) A.shake = Math.max(A.shake, 0.6 * (1 - (s - 2.9) / 0.35));

    // head: on the screen, scanning down the answer; chin up for the drama; then shifty
    const guilty = win(s, 3.5, 3.65, 4.7, 4.95);
    HEAD[0] = track(s, A.head[0], [[0, 0.6, -0.25], [1.5, 1.8, -0.05], [3.4, 3.7, 0.12], [4.6, 4.95, A.head[0]]]) + 0.06 * Math.sin(s * 2.5) * win(s, 0.2, 0.5, 1.4, 1.6) - 0.12 * raise;
    HEAD[1] = sd * track(s, 0, [[0, 0.6, 0.42], [3.4, 3.7, 0]]) + 0.65 * Math.sin(((s - 3.6) / 1.2) * Math.PI * 2) * guilty;
    HEAD[2] = A.head[2] + 0.06 * Math.sin(s * 1.7) * win(s, 0.2, 0.5, 1.4, 1.6);
    blend(A, 'head', HEAD, c.w);

    if (once(c, 'c', 1.8)) stars(c, V2, 4, 0.8);
    if (once(c, 'v', 2.9)) stars(c, V2, 4, 0.8);
    if (once(c, 'sweat', 3.7)) c.emit('sweat', at(c, c.robot.head, 0.34, 0.5, 0.1, V1), { life: 0.9, vel: new THREE.Vector3(0.05, -0.35, 0), size: 0.08 });
    if (s >= 1.8 && s < 2.5) c.say('Ctrl+C');
    else if (s >= 2.9 && s < 3.5) c.say('Ctrl+V');
  },
  end(c) {
    const home = c.run?.home;
    if (!home) return;
    c.set.keyboard.position.copy(home.pos);
    c.set.keyboard.quaternion.copy(home.quat);
  },
};

// ------------------------------------------------------------ cable

// Leans down and grabs a cable from under the desk (0.4–1.0), tugs (1.2, 1.6),
// YANKS (2.2): the desk shakes, the lamp and the screen flicker. Freezes, busted
// (2.8–3.8), lets go, and the cable slithers back under the desk.
const PLUG_AT = new THREE.Vector3(0.3, 0, -0.66); // a power strip on the floor, under the desk's front corner
const GRAB_AT = new THREE.Vector3(0.38, 0.3, -0.47); // where it takes hold: down beside the seat, in view
const CABLE_SEGS = 28;
const CABLE_SIDES = 6;
const CABLE_R = 0.016;

function buildCable() {
  const g = new THREE.Group();
  const strip = new THREE.Group();
  strip.position.copy(PLUG_AT);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.07), toon('#e9ecf5'));
  box.position.y = 0.023;
  strip.add(box);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), glow('#ff5e62'));
  led.position.set(0.075, 0.047, 0);
  strip.add(led);
  strip.rotation.y = 0.35;
  g.add(strip);
  // the cable's tube: its rings are moved every frame (no new geometry)
  const geo = new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3(0, 1, 0)), CABLE_SEGS, CABLE_R, CABLE_SIDES, false);
  const cable = new THREE.Mesh(geo, toon('#2b2f3d', { side: THREE.DoubleSide }));
  cable.frustumCulled = false;
  cable.castShadow = true;
  g.add(cable);
  return { g, strip, cable };
}

const BZ = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const T = new THREE.Vector3();
const N = new THREE.Vector3();
const B = new THREE.Vector3();
const REF = new THREE.Vector3();
const bez = (out: THREE.Vector3, k: number, [a, b, c]: THREE.Vector3[]) => out.set(0, 0, 0).addScaledVector(a, (1 - k) * (1 - k)).addScaledVector(b, 2 * k * (1 - k)).addScaledVector(c, k * k);
// lay the tube along a quadratic curve a -> b -> c
function bendCable(cable: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  BZ[0].copy(a);
  BZ[1].copy(b);
  BZ[2].copy(c);
  const pos = cable.geometry.attributes.position;
  const nor = cable.geometry.attributes.normal;
  for (let i = 0; i <= CABLE_SEGS; i++) {
    const k = i / CABLE_SEGS;
    bez(V3, k, BZ);
    // tangent: the curve's derivative
    T.copy(BZ[1]).sub(BZ[0]).multiplyScalar(2 * (1 - k)).addScaledVector(V4.copy(BZ[2]).sub(BZ[1]), 2 * k);
    if (T.lengthSq() < 1e-8) T.set(0, 1, 0);
    T.normalize();
    REF.set(0, 1, 0);
    if (Math.abs(T.y) > 0.9) REF.set(1, 0, 0);
    N.crossVectors(T, REF).normalize();
    B.crossVectors(T, N);
    for (let j = 0; j <= CABLE_SIDES; j++) {
      const v = (j / CABLE_SIDES) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const nx = cos * N.x + sin * B.x;
      const ny = cos * N.y + sin * B.y;
      const nz = cos * N.z + sin * B.z;
      const idx = i * (CABLE_SIDES + 1) + j;
      nor.setXYZ(idx, nx, ny, nz);
      pos.setXYZ(idx, V3.x + CABLE_R * nx, V3.y + CABLE_R * ny, V3.z + CABLE_R * nz);
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

const YANK_TO = new THREE.Vector3(0.58, 0.62, 0); // the yank: the hand flies up above its shoulder (torso space)

// (turn and side are set with the cable, on the first frame)
type CableRun = { cable?: ReturnType<typeof buildCable>; turn: number; side: Side; mid?: THREE.Vector3 };

const cable: Antic<CableRun> = {
  dur: 4.5,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    if (!run.cable) {
      run.cable = buildCable();
      c.set.office.add(run.cable.g);
      run.turn = turnTo(c, GRAB_AT, 1.6); // just a little: bent down, it'd only show the top of its head
      run.side = sideOf(c, GRAB_AT);
    }
    const { strip, cable: tube } = run.cable;
    const sd = run.side === 'L' ? -1 : 1;
    const near = run.side === 'L' ? 'armL' : 'armR';
    A.yaw = track(s, 0, [[0, 0.5, run.turn], [3.8, 4.4, 0]]) * c.w;

    // the hand: down to the cable, little tugs, the big yank, frozen up there, then back
    const tug = 0.07 * (bump(s, 1.1, 1.35) + bump(s, 1.5, 1.75));
    const crouch = 0.05 * win(s, 1.85, 2.1, 2.15, 2.2);
    const yank = seg(s, 2.15, 2.3);
    at(c, c.robot.torso, sd * YANK_TO.x, YANK_TO.y, YANK_TO.z, V3);
    V2.lerpVectors(GRAB_AT, V3, yank);
    V2.y += tug - crouch;
    if (s > 2.3 && s < 2.8) V2.y += 0.03 * Math.sin((s - 2.3) * 30) * (1 - (s - 2.3) / 0.5); // recoil
    const r = aim(c, run.side, V2, QR, 2.6);
    const hold = win(s, 0.4, 1.0, 3.8, 4.3);
    blend(A, near, QR, hold * c.w);
    A[near === 'armL' ? 'reachL' : 'reachR'] = mix(1, r, hold * c.w);
    // the other hand braces on the knee, then flies up in the "oops"
    const other = near === 'armL' ? 'armR' : 'armL';
    set3(PL, -0.55, 0.15, -0.7);
    blend(A, other, PL, win(s, 0.4, 0.9, 2.1, 2.3) * c.w);
    set3(PL, -1.5, 0.65, -1.6);
    blend(A, other, PL, win(s, 2.25, 2.45, 3.8, 4.2) * c.w);
    // bent right down; thrown back by the yank; frozen
    const down = win(s, 0.4, 1.0, 2.15, 2.35);
    A.lean = mix(A.lean, A.lean + 0.3 * down + 0.08 * crouch / 0.05 - 0.14 * win(s, 2.2, 2.35, 3.8, 4.3) - 0.04 * tug / 0.07, c.w);
    A.rootY += 0.06 * bump(s, 2.2, 2.55) * c.w;
    // head: down at the cable, then (2.8) slowly round to you: busted
    const busted = win(s, 2.75, 3.05, 3.8, 4.2);
    HEAD[0] = mix(A.head[0] - 0.1 * down - 0.15 * bump(s, 2.2, 2.6), 0.02, busted); // chin up, so the face shows
    HEAD[1] = mix(sd * 0.15 * seg(s, 0.2, 0.7) * (1 - seg(s, 3.8, 4.3)), -run.turn * 0.75, busted);
    HEAD[2] = A.head[2] + 0.08 * Math.sin(s * 40) * bump(s, 2.2, 2.6);
    blend(A, 'head', HEAD, c.w);

    // YANK (2.2): the desk jolts, the mug jumps, the lamp and the screen flicker
    if (s >= 2.2 && s < 2.8) {
      const k = 1 - (s - 2.2) / 0.6;
      A.shake = Math.max(A.shake, k);
      A.mug.y += 0.05 * bump(s, 2.2, 2.45);
      A.mugTilt += 0.22 * Math.sin((s - 2.2) * 38) * k;
      A.lamp = Math.floor(s * 22) % 3 === 0 ? 0.1 : Math.floor(s * 22) % 3 === 1 ? 1 : 0.4;
      A.screen = 'idle';
      A.screenDim = Math.floor(s * 17) % 2 ? 0.85 : 0.1;
    }
    if (once(c, 'sweat', 2.9)) c.emit('sweat', at(c, c.robot.head, 0.34, 0.5, 0.1, V1), { life: 0.9, vel: new THREE.Vector3(0.05, -0.35, 0), size: 0.08 });

    // the cable: from the power strip, along the floor, up into the hand
    strip.position.copy(PLUG_AT);
    strip.position.y = 0.05 * bump(s, 2.2, 2.45);
    strip.position.x -= 0.05 * seg(s, 2.2, 2.3);
    strip.position.z += 0.05 * seg(s, 2.2, 2.3);
    V1.set(-0.06, 0.03, 0.02).applyAxisAngle(V4.set(0, 1, 0), strip.rotation.y).add(strip.position); // its plug
    const floor = V3.set(GRAB_AT.x - 0.04, 0.012, GRAB_AT.z + 0.02);
    handAt(c, run.side, V2);
    let end;
    if (s < 3.85) end = V4.lerpVectors(floor, V2, seg(s, 0.85, 1.0));
    else {
      // dropped... and it slithers back to the power strip
      end = V4.lerpVectors(V2, floor, seg(s, 3.85, 4.0));
      end.lerp(V1, seg(s, 4.0, 4.45) * 0.85);
    }
    // slack on the floor while it lies there, taut as it's pulled
    const taut = s < 3.85 ? 0.25 * seg(s, 0.9, 1.1) + 0.3 * (bump(s, 1.1, 1.35) + bump(s, 1.5, 1.75)) + 0.75 * seg(s, 2.15, 2.25) : 0;
    const mid = (run.mid ||= new THREE.Vector3());
    mid.lerpVectors(V1, end, 0.5);
    mid.y = mix(0, mid.y, clamp(taut, 0, 1)); // (pulled down onto the floor while slack)
    bendCable(tube, V1, mid, end);
    tube.visible = s < 4.45;
  },
  end(c) {
    dispose(c.run?.cable?.g);
  },
};

// ------------------------------------------------------------ crumbs

// Lifts the keyboard off the desk (0–0.4), carries it round in front of itself
// turning it upside down (0.4–1.0) and shakes it (1.2–2.8): crumbs rain out (and
// in 'crumbs-cookie' a whole cookie, 2.6, lands on the floor). Puts it back (3.2–4.0).
const KB_HALF = 0.25; // where the hands take it, along the keyboard
const HOLD_R = 0.55; // how far in front of the chair it's held
const HOLD_Y = 0.8; // (below the face)
const TILT = 0.55; // upside down, and tipped so you see the keys
const COOKIE_SIZE = 1.8;
const GRAVITY = 5.5; // a cartoon fall

function buildCookie() {
  const g = new THREE.Group();
  const dough = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 20), toon('#d9a05b'));
  g.add(dough);
  const chip = toon('#4a2c1d');
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4;
    const r = 0.012 + (i % 3) * 0.01;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6), chip);
    m.position.set(Math.cos(a) * r, i % 2 ? 0.007 : -0.007, Math.sin(a) * r);
    m.scale.y = 0.6;
    g.add(m);
  }
  g.traverse((o) => isMesh(o) && (o.castShadow = true));
  return g;
}

const EUL = new THREE.Euler(0, 0, 0, 'YXZ');

// (the rest is set with home, on the first frame; c0 and cv with the cookie)
type CrumbsRun = {
  home?: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 };
  base: number; relHome: number; sd: number; rHome: number; yHome: number; spinHome: number;
  nextCrumb?: number; cookie?: THREE.Group; c0: THREE.Vector3; cv: THREE.Vector3;
};

function crumbs(cookie: boolean): Antic<CrumbsRun> {
  return {
    dur: 5.0,
    fadeOut: 0.4,
    update(c, A) {
      const { s, run } = c;
      const kb = c.set.keyboard;
      if (!run.home) {
        run.home = { pos: kb.position.clone(), quat: kb.quaternion.clone(), scale: kb.scale.clone() };
        at(c, kb, 0, 0, 0, V1);
        run.base = c.curYaw;
        run.relHome = wrap(yawOf(V1) - run.base);
        run.sd = run.relHome < 0 ? -1 : 1;
        run.rHome = Math.hypot(V1.x - LAYOUT.chair.x, V1.z - LAYOUT.chair.z);
        run.yHome = V1.y;
        run.spinHome = wrap(kb.rotation.y - yawOf(V1)); // its own turn, relative to the way round the chair
      }
      const { sd } = run;
      const relFront = sd * 0.42;
      // swivel towards the keyboard to take it, face it while shaking, again to put it back
      A.yaw = track(s, 0, [[0, 0.35, sd * 0.7], [0.45, 1.0, relFront], [3.15, 3.6, sd * 0.7], [4.0, 4.6, 0]]) * c.w;

      // the keyboard: lifted, carried round the chair to in front, flipped, shaken, back
      const k = seg(s, 0.42, 1.0) - seg(s, 3.2, 3.85);
      const lift = 0.1 * (seg(s, 0.2, 0.42) - seg(s, 3.82, 4.0));
      const roll = (Math.PI + TILT) * (seg(s, 0.5, 1.0) - seg(s, 2.8, 3.2));
      const shake = win(s, 1.15, 1.25, 2.75, 2.85);
      const th = run.base + mix(run.relHome, relFront, k);
      const r = mix(run.rHome, HOLD_R, k);
      V1.set(LAYOUT.chair.x + Math.sin(th) * r, mix(run.yHome, HOLD_Y, k) + lift, LAYOUT.chair.z + Math.cos(th) * r);
      V1.y += 0.045 * Math.sin(s * 34) * shake;
      V1.x += 0.025 * Math.sin(s * 23) * shake * Math.cos(th);
      V1.z -= 0.025 * Math.sin(s * 23) * shake * Math.sin(th);
      if (s < 4.0) {
        kb.parent!.worldToLocal(c.set.office.localToWorld(kb.position.copy(V1))); // (it's on the desk's top)
        EUL.set(roll + 0.18 * Math.sin(s * 29) * shake, th + mix(run.spinHome, Math.PI, k), 0.12 * Math.sin(s * 19) * shake);
        kb.quaternion.setFromEuler(EUL);
      } else {
        kb.position.copy(run.home.pos);
        kb.quaternion.copy(run.home.quat);
      }

      // both hands on its ends (held in front, its +x end is on the robot's left)
      const grab = win(s, 0.0, 0.3, 3.95, 4.4);
      for (const [side, out, key, end] of [['L', QL, 'armL', 1], ['R', QR, 'armR', -1]] as const) {
        const st = aim(c, side, at(c, kb, end * KB_HALF, 0.0, 0, V2), out, 2.4);
        blend(A, key, out, grab * c.w);
        A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, st, grab * c.w);
      }
      A.lean = mix(A.lean, A.lean + 0.12 * k - 0.04 * shake + 0.02 * Math.sin(s * 34) * shake, c.w);
      A.rootY += 0.012 * Math.sin(s * 34 + 1) * shake * c.w; // the whole body shakes with it
      // head: on the keyboard (down at the floor once the cookie drops)
      HEAD[0] = track(s, A.head[0], [[0.1, 0.5, 0.15], [1.2, 1.5, 0.05], [2.6, 2.8, cookie ? 0.32 : 0.05], [3.2, 3.6, 0.15], [4.0, 4.6, A.head[0]]]);
      HEAD[1] = sd * track(s, 0, [[0.1, 0.4, 0.35], [0.6, 1.0, 0], [3.2, 3.6, 0.35], [4.0, 4.6, 0]]);
      HEAD[2] = A.head[2] + 0.12 * shake * sd;
      blend(A, 'head', HEAD, c.w);

      // crumbs rain out of the upside-down keyboard
      if (shake > 0.2 && s >= (run.nextCrumb ?? 0)) {
        run.nextCrumb = s + 0.05;
        for (let i = 0; i < 2; i++) {
          at(c, kb, (Math.random() - 0.5) * 0.46, 0.03, (Math.random() - 0.5) * 0.12, V2);
          c.emit('crumb', V2, { life: 0.75, vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, -0.1 - Math.random() * 0.3, (Math.random() - 0.5) * 0.4), size: 0.045 + Math.random() * 0.03, gravity: 2.4, spin: 6 });
        }
      }

      // ...and a whole cookie (2.6): falls, bounces, lies there
      if (cookie && s >= 2.6) {
        if (!run.cookie) {
          run.cookie = buildCookie();
          run.cookie.scale.setScalar(COOKIE_SIZE);
          c.set.office.add(run.cookie);
          run.c0 = at(c, kb, 0.05, 0.03, 0, new THREE.Vector3());
          // it skids off sideways (to your right), so it lands in view
          run.cv = new THREE.Vector3(Math.cos(c.camYaw), 0, -Math.sin(c.camYaw)).multiplyScalar(0.3);
        }
        const ck = run.cookie;
        const fall = Math.sqrt((2 * (run.c0.y - 0.012)) / GRAVITY);
        const t = s - 2.6;
        if (t < fall) {
          ck.position.copy(run.c0).addScaledVector(run.cv, t);
          ck.position.y = Math.max(0.012, run.c0.y - 0.5 * GRAVITY * t * t);
          ck.rotation.set(t * 9, 0, t * 5);
        } else {
          // one small bounce, then flat on the floor
          const b = t - fall;
          ck.position.copy(run.c0).addScaledVector(run.cv, fall + Math.min(b, 0.3) * 0.5);
          ck.position.y = COOKIE_SIZE * 0.007 + 0.07 * bump(b, 0, 0.25);
          const flat = seg(b, 0, 0.3);
          ck.rotation.set(mix(fall * 9, Math.round(fall * 9 / Math.PI) * Math.PI, flat), 0, mix(fall * 5, Math.round(fall * 5 / Math.PI) * Math.PI, flat));
          if (once(c, 'thud', 2.6 + fall)) puff(c, ck.position, 4, 0.05);
        }
        const size = s < 4.55 ? 1 : Math.max(0, 1 - (s - 4.55) / 0.3);
        ck.scale.setScalar(Math.max(0.001, size * COOKIE_SIZE));
      }
    },
    end(c) {
      const run = c.run;
      if (run?.home) {
        const kb = c.set.keyboard;
        kb.position.copy(run.home.pos);
        kb.quaternion.copy(run.home.quat);
        kb.scale.copy(run.home.scale);
      }
      dispose(run?.cookie);
    },
  };
}

export const DESK: Record<string, Antic> = {
  duck,
  reboot,
  stackoverflow,
  cable,
  crumbs: crumbs(false),
  'crumbs-cookie': crumbs(true),
};
