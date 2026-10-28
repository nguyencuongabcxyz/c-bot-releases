// A walking robot's legs and poses: the leg rig found on any body (hips, knees, how long the legs
// are), and the poses of a walk (standing, striding, hopping, sleepwalking), blended into one.
import * as THREE from 'three';
import type { Vec3Tuple } from './antics/types';
import { isMesh } from '@/office3d/core/mesh';
import type { Rig } from './types';
import { mix, smooth } from '@/office3d/core/math';

// scratch, so nothing is allocated per frame
const V = new THREE.Vector3();
const BOX = new THREE.Box3();
const BOX2 = new THREE.Box3();
const M = new THREE.Matrix4();
const INV = new THREE.Matrix4();

// Out for a walk: the character stands up and strolls about the user's screen in its
// own little window (index.js mounted with `solo: true`), and gets up from / back
// into its chair at the desk (antics/walk.js). This is the standing and walking rig.
//
// Every body is built sitting (robot3d.js): a hip group per leg with the thigh forward
// (+z) and the shin and foot hanging from the knee. legRig() gives each leg a knee
// pivot, so a hip swings the whole leg and a knee bends what hangs below it:
//   hip.rotation.x  0 = thigh forward (sitting), PI/2 = thigh straight down
//   knee.rotation.x 0 = shin hanging down (sitting), leg.straight = in line with the thigh
// Poses here use friendlier angles (see newPose): hip = how far the leg swings forward
// of straight down, knee = how far it bends back from straight.

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------- the leg rig

/** A leg that can stand: the hip swings it, the knee bends what hangs below it (see legRig). */
export type Leg = { hip: THREE.Object3D; knee: THREE.Object3D; side: number; straight: number };
/** A body's standing rig (legRig): kept on robot.root.userData.legRig. */
export type LegRig = {
  legs: Leg[];
  sole: number;
  top: number;
  brow: Vec3Tuple;
  plush: boolean;
  restore(): void;
};

/** The root-space box round everything under `objs` as posed now. */
function boxOf(root: THREE.Object3D, objs: THREE.Object3D[]) {
  root.updateMatrixWorld(true);
  INV.copy(root.matrixWorld).invert();
  BOX.makeEmpty();
  for (const obj of objs) {
    obj.traverseVisible((o) => {
      if (!isMesh(o) || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      BOX.union(BOX2.copy(o.geometry.boundingBox as THREE.Box3).applyMatrix4(M.multiplyMatrices(INV, o.matrixWorld))); // (computed just above)
    });
  }
  return BOX;
}

/**
 * Legs that can stand, for this body (made once, kept on robot.root.userData):
 *   legs    [{ hip, knee, side, straight }]  (empty for a plush model: it hops)
 *   sole    root-space height of its soles with the legs straight down
 *   top     root-space height of the top of its head
 *   brow    how its right arm reaches its brow ('look'), see browReach
 *   plush   no legs to stand on (a body on a wheel, a jet…)
 *   restore()  back to the body as built, sitting (call before it's seated again at the desk)
 */
export function legRig(robot: Rig): LegRig {
  const ud = robot.root.userData;
  if (ud.legRig) return ud.legRig as LegRig;
  const root = robot.root;
  const legs: Leg[] = [];
  const made: { hip: THREE.Object3D; knee: THREE.Group; q: THREE.Quaternion }[] = []; // knee pivots added to a built-in body: [{ hip, knee }]
  for (const hip of root.children) {
    if (hip === robot.torso || isMesh(hip) || Math.abs(hip.position.x) < 0.05) continue;
    const thigh = hip.children.find((o) => o.position.y > -0.05 && o.position.z > 0.08);
    const below = hip.children.filter((o) => o.position.y < -0.02);
    if (!thigh || !below.length) continue;
    // the knee: at the end of the thigh, where the shin hangs from
    const knee = new THREE.Group();
    knee.name = 'walk-knee';
    knee.position.set(0, thigh.position.y, Math.min(...below.map((o) => o.position.z)));
    for (const o of below) {
      o.position.sub(knee.position);
      knee.add(o);
    }
    hip.add(knee);
    made.push({ hip, knee, q: hip.quaternion.clone() });
    legs.push({ hip, knee, side: Math.sign(hip.position.x), straight: -HALF_PI });
  }
  // measure it standing
  for (const l of legs) {
    l.hip.rotation.x = HALF_PI;
    l.knee.rotation.x = l.straight;
  }
  const sole = legs.length
    ? boxOf(
        root,
        legs.map((l) => l.hip),
      ).min.y
    : 0;
  for (const l of legs) l.hip.rotation.x = l.knee.rotation.x = 0;
  // the top of its head, sitting up straight
  const lean = [robot.torso.rotation.x, robot.head.rotation.x];
  robot.torso.rotation.x = robot.head.rotation.x = 0;
  root.updateMatrixWorld(true);
  INV.copy(root.matrixWorld).invert();
  const top = robot.head.localToWorld(V.set(0, robot.headTop ?? 0.6, 0)).applyMatrix4(INV).y;
  [robot.torso.rotation.x, robot.head.rotation.x] = lean;

  const rig: LegRig = {
    legs,
    sole,
    top,
    brow: browReach(robot),
    plush: !legs.length,
    restore() {
      for (const l of legs) {
        l.hip.quaternion.identity();
        l.knee.quaternion.identity();
      }
      for (const { hip, knee, q } of made) {
        for (const o of [...knee.children]) {
          o.position.add(knee.position);
          hip.add(o);
        }
        knee.removeFromParent();
        hip.quaternion.copy(q);
      }
      robot.torso.rotation.y = robot.torso.rotation.z = 0;
      delete ud.legRig;
    },
  };
  ud.legRig = rig;
  return rig;
}

/**
 * How the right arm reaches its brow, to shade its eyes ('look'): [pitch, out, stretch].
 * Measured on the body: from the shoulder to just in front of its forehead, the arm
 * held (nearly) straight and stretched to get there, cartoon-style.
 */
function browReach(robot: Rig): Vec3Tuple {
  const { shoulder, elbow } = robot.arms.armR;
  // arm length: the upper arm, and on to the middle of the hand
  const hand = boxOf(elbow, elbow.children).min.y + 0.05;
  const len = Math.max(0.15, -elbow.position.y - Math.min(-0.08, hand));
  // its forehead (head space): up the front of the head
  const head = boxOf(
    robot.head,
    robot.head.children.filter((o) => o !== robot.accessory && o !== robot.antenna && o !== robot.headband),
  );
  const top = robot.headTop ?? 0.6;
  if (head.isEmpty()) head.set(V.set(-top * 0.4, 0, -top * 0.4), new THREE.Vector3(top * 0.4, top, top * 0.4));
  V.set(0.1, head.min.y + 0.8 * (head.max.y - head.min.y), head.max.z + 0.06)
    .add(robot.head.position)
    .sub(shoulder.position);
  const reach = Math.min(1.8, Math.max(1, V.length() / len));
  V.normalize();
  return [Math.atan2(-V.z, -V.y), Math.asin(Math.max(-1, Math.min(1, V.x))), reach];
}

// ---------------------------------------------------------------- poses

/**
 * A standing pose, in friendly angles:
 *   hipL/hipR    leg swung forward of straight down (radians; PI/2 = thigh level, sitting)
 *   kneeL/kneeR  bent back from straight (radians)
 *   armL/armR    [shoulder pitch, out, elbow] as in robot3d POSES
 *   lean, twist, tilt  torso: forward, turned (y), sideways (z)
 *   head[3]      head rotation
 *   y            root height (root units; -rig.sole stands it on the ground)
 *   x            sideways sway (root units)
 *   back         shuffled back, away from the camera (root units: sitting, so its feet stay in view)
 *   squash       0 = normal, + squashed down
 *   reachL/R     cartoon arm stretch (1 = as built), so a hand can get to its face
 */
export type WalkPose = {
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
  armL: Vec3Tuple;
  armR: Vec3Tuple;
  lean: number;
  twist: number;
  tilt: number;
  head: Vec3Tuple;
  y: number;
  x: number;
  back: number;
  squash: number;
  reachL: number;
  reachR: number;
};
export function newPose(): WalkPose {
  return {
    hipL: 0,
    hipR: 0,
    kneeL: 0,
    kneeR: 0,
    armL: [0, 0, 0],
    armR: [0, 0, 0],
    lean: 0,
    twist: 0,
    tilt: 0,
    head: [0, 0, 0],
    y: 0,
    x: 0,
    back: 0,
    squash: 0,
    reachL: 1,
    reachR: 1,
  };
}
const KEYS: Exclude<keyof WalkPose, 'armL' | 'armR' | 'head'>[] = [
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
  'lean',
  'twist',
  'tilt',
  'y',
  'x',
  'back',
  'squash',
  'reachL',
  'reachR',
];
export function mixPose(out: WalkPose, a: WalkPose, b: WalkPose, k: number) {
  for (const key of KEYS) out[key] = mix(a[key], b[key], k);
  for (let i = 0; i < 3; i++) {
    out.armL[i] = mix(a.armL[i], b.armL[i], k);
    out.armR[i] = mix(a.armR[i], b.armR[i], k);
    out.head[i] = mix(a.head[i], b.head[i], k);
  }
  return out;
}
export const copyPose = (out: WalkPose, a: WalkPose) => mixPose(out, a, a, 0);
export const arm = (a: Vec3Tuple, p: number, o: number, e: number) => {
  a[0] = p;
  a[1] = o;
  a[2] = e;
};

/** Standing about: breathing, shifting its weight, now and then a glance aside. */
export function standPose(o: WalkPose, rig: LegRig, t: number) {
  const shift = Math.sin(t * 0.55);
  o.hipL = 0.03 + 0.02 * shift;
  o.hipR = 0.03 - 0.02 * shift;
  o.kneeL = 0.06 + 0.05 * Math.max(0, shift);
  o.kneeR = 0.06 + 0.05 * Math.max(0, -shift);
  const breathe = Math.sin(t * 2.2);
  arm(o.armL, 0.06 + 0.03 * breathe, 0.14, -0.2);
  arm(o.armR, 0.06 + 0.03 * breathe, 0.14, -0.2);
  o.lean = 0.02 + 0.015 * breathe;
  o.twist = 0;
  o.tilt = 0.035 * shift;
  // a glance to one side, then the other, every few seconds
  const cyc = t / 6.5;
  const n = Math.floor(cyc);
  const glance = smooth((cyc - n - 0.62) / 0.05) * (1 - smooth((cyc - n - 0.86) / 0.05));
  o.head[0] = -0.02 + 0.01 * breathe;
  o.head[1] = (n % 2 ? 0.5 : -0.5) * glance;
  o.head[2] = -0.04 * shift;
  o.y = -rig.sole - 0.01 * Math.abs(shift);
  o.x = 0.025 * shift;
  o.back = 0;
  o.squash = 0;
  o.reachL = o.reachR = 1;
}

/**
 * A walk cycle at `phase` (radians: one cycle is two steps). Legs swing alternately,
 * the knee bending as each one comes forward; arms counter-swing; the body bobs,
 * its hips dropping as the legs spread so the planted foot stays on the ground.
 */
export function stridePose(
  o: WalkPose,
  rig: LegRig,
  phase: number,
  {
    swing = 0.42,
    bend = 0.8,
    arms = 0.5,
    lean = 0.1,
  }: { swing?: number; bend?: number; arms?: number; lean?: number } = {},
) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  o.hipL = swing * s;
  o.hipR = -swing * s;
  o.kneeL = 0.06 + bend * Math.max(0, c) ** 1.5;
  o.kneeR = 0.06 + bend * Math.max(0, -c) ** 1.5;
  arm(o.armL, arms * s, 0.12, -0.3 - 0.25 * Math.max(0, -s));
  arm(o.armR, -arms * s, 0.12, -0.3 - 0.25 * Math.max(0, s));
  o.lean = lean;
  o.twist = 0.1 * s;
  o.tilt = 0.03 * Math.cos(phase * 2);
  o.head[0] = -0.04;
  o.head[1] = -0.07 * s;
  o.head[2] = -0.02 * s;
  const leg = -rig.sole; // hip above the sole
  o.y = -rig.sole - leg * (1 - Math.cos(swing * Math.abs(s))) + 0.025 * Math.abs(Math.cos(phase));
  o.x = 0.012 * s;
  o.back = 0;
  o.squash = 0;
  o.reachL = o.reachR = 1;
}

/** A hop along, for a plush with no legs: two hops a cycle, squashing as it lands. */
export function hopPose(o: WalkPose, rig: LegRig, phase: number, height = 0.2) {
  const s = Math.abs(Math.sin(phase));
  o.hipL = o.hipR = o.kneeL = o.kneeR = 0;
  arm(o.armL, 0.3 * Math.sin(phase), 0.3, -0.3);
  arm(o.armR, -0.3 * Math.sin(phase), 0.3, -0.3);
  o.lean = 0.12 * s;
  o.twist = 0;
  o.tilt = 0.06 * Math.sin(phase);
  o.head[0] = -0.05 * s;
  o.head[1] = 0;
  o.head[2] = 0;
  o.y = -rig.sole + height * Math.sin(Math.min(1, s * 1.15) * HALF_PI);
  o.x = 0;
  o.back = 0;
  o.squash = 0.14 * Math.max(0, 1 - s * 5) - 0.05 * Math.max(0, s - 0.6);
  o.reachL = o.reachR = 1;
}

/** Sleepwalking: a slow shuffle, arms straight out in front, head drooping and swaying. */
export function sleepwalkPose(o: WalkPose, rig: LegRig, phase: number, t: number) {
  if (rig.plush) hopPose(o, rig, phase, 0.08);
  else stridePose(o, rig, phase, { swing: 0.2, bend: 0.3, arms: 0, lean: -0.04 });
  const bob = 0.04 * Math.sin(t * 2.1);
  arm(o.armL, -1.5 + bob, 0.04, -0.05);
  arm(o.armR, -1.5 - bob, 0.04, -0.05);
  o.twist *= 0.5;
  o.head[0] = 0.32 + 0.05 * Math.sin(t * 1.7);
  o.head[1] = 0.08 * Math.sin(t * 0.9);
  o.head[2] = 0.16 * Math.sin(t * 1.3);
}
