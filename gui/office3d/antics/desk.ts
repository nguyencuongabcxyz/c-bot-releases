import { bump, mix, seg } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import { type PropMesh, aim, armOf, at, blend, handAt, onceAt, pose, track } from './common';
import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { toon } from '@/office3d/materials';
import type { Antic, TickCtx, Vec3Tuple } from './types';
import { sideOf, win, set3, dispose, puff, stars, pop, toward3 } from './desk-common';
import { MESS } from './mess';

type Side = 'L' | 'R';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];
const QL: Vec3Tuple = [0, 0, 0];
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

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
  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
  ) => {
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
    if (onceAt(c, 'in', 0.3)) puff(c, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.05), 4);
    if (onceAt(c, 'squeak', 3.8))
      c.emit('squeak', V1.set(DUCK_AT.x + 0.15, DUCK_AT.y + 0.27, DUCK_AT.z + 0.1), {
        life: 0.9,
        vel: new THREE.Vector3(0, 0.22, 0),
        size: 0.3,
        grow: 1.25,
      });
    if (onceAt(c, 'out', 5.45)) puff(c, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.06), 5);

    // the robot: turns a little towards it, then talks it through with its hands
    A.yaw =
      sd *
      track(s, 0, [
        [0.3, 0.8, 0.25],
        [5.3, 5.9, 0],
      ]) *
      c.w;
    const talk = win(s, 0.7, 1.0, 3.45, 3.75);
    // point at the duck (straight arm, no stretch): 1.6–2.4
    aim(c, run.side, V1.copy(DUCK_AT).setY(DUCK_AT.y + 0.12), QR);
    QR[2] = -0.15;
    for (const [key, ph, isNear] of [
      [near, 0, true],
      [far, 1.7, false],
    ] as const) {
      const out = isNear ? PR : PL;
      for (let i = 0; i < 3; i++) out[i] = A[key][i];
      // "so..." hands out, wiggling (0.8–1.6)
      set3(
        QL,
        SO[0] + 0.12 * Math.sin(s * 9 + ph),
        SO[1] + 0.12 * Math.sin(s * 6 + ph),
        SO[2] + 0.35 * Math.sin(s * 7 + ph),
      );
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
    A.lean = mix(
      A.lean,
      A.lean +
        0.08 * talk +
        0.04 * Math.sin(s * 6) * talk -
        0.08 * bump(s, 3.8, 4.1) -
        0.06 * win(s, 4.3, 4.4, 4.9, 5.3),
      c.w,
    );
    // head: down at the duck, bobbing as it talks; startled by the squeak; chin up for OH!
    const oh = win(s, 4.25, 4.4, 4.9, 5.3);
    HEAD[0] =
      track(s, A.head[0], [
        [0.3, 0.8, 0.22],
        [5.3, 5.9, A.head[0]],
      ]) +
      0.06 * Math.sin(s * 8) * talk -
      0.12 * bump(s, 3.8, 4.15);
    HEAD[0] = mix(HEAD[0], -0.22, oh);
    HEAD[1] =
      sd *
      track(s, 0, [
        [0.3, 0.8, 0.32],
        [1.0, 1.4, 0.05],
        [1.6, 1.9, 0.32],
        [2.5, 2.8, 0],
        [3.6, 3.8, 0.35],
        [4.25, 4.45, -0.05],
        [5.3, 5.8, 0],
      ]);
    HEAD[2] = 0.14 * win(s, 2.9, 3.1, 3.55, 3.8) * sd + 0.1 * bump(s, 3.8, 4.25) * -sd;
    blend(A, 'head', HEAD, c.w);
    if (onceAt(c, 'oh', 4.3))
      c.emit('bulb', at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.22, 0, V1), {
        life: 1.3,
        vel: new THREE.Vector3(0, 0.12, 0),
        size: 0.24,
      });
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
    const m = (isMesh<PropMesh>(o) ? o : o.children.find((k) => isMesh<PropMesh>(k))) as Tinted | undefined;
    if (!m?.material?.color || o.position.y > -0.12) continue;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const sphere = m.geometry.boundingSphere;
    if (!sphere) continue; // (computed just above if it wasn't, so always there)
    const r = sphere.radius * m.scale.x;
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
    const mon = c.set.screen.light.parent; // the monitor (the screen's light hangs off it)
    if (!mon) return;
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
    A.yaw =
      track(s, 0, [
        [0.1, 0.6, run.turn],
        [5.2, 5.8, 0],
      ]) * c.w;

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
    HEAD[0] = track(s, A.head[0], [
      [0.2, 0.5, -0.22],
      [1.0, 1.3, -0.32],
      [2.2, 2.6, -0.22],
      [3.2, 3.6, -0.28],
      [5.3, 5.8, -0.08],
    ]);
    HEAD[1] =
      sd *
      track(s, 0, [
        [0.2, 0.5, 0.45],
        [1.0, 1.3, 0.4],
        [2.2, 2.6, 0.55],
        [3.2, 3.6, 0.4],
        [5.3, 5.8, 0],
      ]);
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
    if (onceAt(c, 'ding', 6.0)) stars(c, handAt(c, 'R', V1).setY(V1.y + 0.12), 3, 0.45);
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
    A.yaw =
      track(s, 0, [
        [0, 0.6, run.turn],
        [3.4, 3.9, run.turn * 0.5],
        [4.5, 4.95, 0],
      ]) * c.w;
    // slid over (0.4–0.85) and back again (4.05–4.55)
    KB_X.set(1, 0, 0).applyQuaternion(run.home.quat);
    kb.position.copy(run.home.pos).addScaledVector(KB_X, KB_SLIDE * (seg(s, 0.4, 0.85) - seg(s, 4.05, 4.55)));
    // the hand: on the keyboard's end to slide it, up high, SLAM on a key (pressed in), ...
    const rk = aim(c, run.side, at(c, kb, 0.27, 0.03, 0, V1), QL, 2.6);
    at(c, kb, 0.2, 0.035 - 0.012 * (win(s, 1.76, 1.8, 2.0, 2.1) + win(s, 2.86, 2.9, 3.1, 3.2)), 0, V2);
    const r = aim(c, run.side, V2, QR, 2.6);
    pose(PR, A[near], s, [
      [0.15, 0.4, QL],
      [0.85, 1.1, REST],
      [1.3, 1.68, UP_HIGH],
      [1.72, 1.8, QR],
      [2.4, 2.78, UP_HIGH],
      [2.82, 2.9, QR],
      [3.3, 3.7, REST],
      [3.8, 4.05, QL],
      [4.55, 4.9, A[near]],
    ]);
    PR[1] += 0.1 * Math.sin(s * 30) * (bump(s, 1.45, 1.72) + bump(s, 2.55, 2.82)); // trembling with drama
    blend(A, near, PR, c.w);
    A[near === 'armL' ? 'reachL' : 'reachR'] = mix(
      1,
      track(s, 1, [
        [0.15, 0.4, rk],
        [0.85, 1.1, 1],
        [1.3, 1.68, 1.45],
        [1.72, 1.8, r],
        [2.4, 2.78, 1.45],
        [2.82, 2.9, r],
        [3.3, 3.7, 1],
        [3.8, 4.05, rk],
        [4.55, 4.9, 1],
      ]),
      c.w,
    );
    pose(PL, A[other], s, [
      [0.1, 0.6, REST],
      [4.5, 4.95, A[other]],
    ]);
    blend(A, other, PL, c.w);

    // leaning in (back, towards the screen behind it) to read; up for the wind-up; hunched after
    const raise = win(s, 1.3, 1.68, 1.72, 1.8) + win(s, 2.4, 2.78, 2.82, 2.9);
    const lean =
      track(s, A.lean, [
        [0, 0.8, -0.04],
        [3.3, 3.8, 0.16],
        [4.5, 4.95, A.lean],
      ]) -
      0.1 * raise; // (not bent over on the slam: the head would hide the hand)
    A.lean = mix(A.lean, lean, c.w);
    A.tip += 0.09 * win(s, 0, 0.8, 1.35, 1.7) * c.w;
    A.rootY +=
      (0.04 * raise - 0.03 * (bump(s, 1.78, 2.05) + bump(s, 2.88, 3.15)) - 0.025 * win(s, 3.5, 3.7, 4.6, 4.9)) * c.w; // up for the drama, down with the slam, hunched after
    if (s >= 1.8 && s < 2.15) A.shake = Math.max(A.shake, 0.6 * (1 - (s - 1.8) / 0.35));
    if (s >= 2.9 && s < 3.25) A.shake = Math.max(A.shake, 0.6 * (1 - (s - 2.9) / 0.35));

    // head: on the screen, scanning down the answer; chin up for the drama; then shifty
    const guilty = win(s, 3.5, 3.65, 4.7, 4.95);
    HEAD[0] =
      track(s, A.head[0], [
        [0, 0.6, -0.25],
        [1.5, 1.8, -0.05],
        [3.4, 3.7, 0.12],
        [4.6, 4.95, A.head[0]],
      ]) +
      0.06 * Math.sin(s * 2.5) * win(s, 0.2, 0.5, 1.4, 1.6) -
      0.12 * raise;
    HEAD[1] =
      sd *
        track(s, 0, [
          [0, 0.6, 0.42],
          [3.4, 3.7, 0],
        ]) +
      0.65 * Math.sin(((s - 3.6) / 1.2) * Math.PI * 2) * guilty;
    HEAD[2] = A.head[2] + 0.06 * Math.sin(s * 1.7) * win(s, 0.2, 0.5, 1.4, 1.6);
    blend(A, 'head', HEAD, c.w);

    if (onceAt(c, 'c', 1.8)) stars(c, V2, 4, 0.8);
    if (onceAt(c, 'v', 2.9)) stars(c, V2, 4, 0.8);
    if (onceAt(c, 'sweat', 3.7))
      c.emit('sweat', at(c, c.robot.head, 0.34, 0.5, 0.1, V1), {
        life: 0.9,
        vel: new THREE.Vector3(0.05, -0.35, 0),
        size: 0.08,
      });
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

export const DESK: Record<string, Antic> = {
  duck,
  reboot,
  stackoverflow,
  ...MESS,
};
