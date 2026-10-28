// Helpers the antics share: one-shot moments, bending the pose over time, where things are from
// the chair, where its hands are.
import * as THREE from 'three';
import { clamp, mix, seg, wrap } from '@/office3d/core/math';
import { LAYOUT } from '@/office3d/scene';
import type { AnticCtx, AnticPose, TickCtx } from './types';

/** How far down the forearm the hand is (as c.hand() has it). */
export const HAND = 0.24;

/** A value through keyframes [from s, to s, value], eased between, starting at `from`. */
export function track(s: number, from: number, keys: [number, number, number][]) {
  let v = from;
  for (const [a, b, to] of keys) v = mix(v, to, seg(s, a, b));
  return v;
}

/** The same for a pose triple, written into `out`. */
export function pose<T extends number[]>(
  out: T,
  from: readonly number[],
  s: number,
  keys: [number, number, readonly number[]][],
) {
  for (let i = 0; i < 3; i++) out[i] = from[i];
  for (const [a, b, to] of keys) {
    const k = seg(s, a, b);
    if (k > 0) for (let i = 0; i < 3; i++) out[i] = mix(out[i], to[i], k);
  }
  return out;
}

/** A point given in obj's space, in the office's (into `out`). */
export const at = (c: TickCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) =>
  c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
/** Its left or right arm. */
export const armOf = (c: TickCtx, side: 'L' | 'R') => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
/** Where that hand is now, in the office's space. */
export const handAt = (c: TickCtx, side: 'L' | 'R', out: THREE.Vector3) =>
  at(c, armOf(c, side).elbow, 0, -HAND, 0, out);

/** p moved d further out from the chair (in place). */
export function outward(p: THREE.Vector3, d: number) {
  const dx = p.x - LAYOUT.chair.x;
  const dz = p.z - LAYOUT.chair.z;
  const k = d / (Math.hypot(dx, dz) || 1);
  p.x += dx * k;
  p.z += dz * k;
  return p;
}

/** How high the top of its head is (a model may not say). */
export const headTop = (c: TickCtx) => c.robot.headTop ?? 0.6;

/** True the first frame at or past `at` (one-shot emits, whatever the frame rate). */
export const onceAt = (c: Pick<AnticCtx, 's' | 'run'>, key: string, at: number) => {
  if (c.s >= at && !c.run[key]) {
    c.run[key] = true;
    return true;
  }
  return false;
};

/** True the first time it's asked for this run (one-shot emits). */
export const once = (run: Record<string, unknown>, key: string) => {
  if (run[key]) return false;
  run[key] = true;
  return true;
};

/** The head or an arm moved toward `target` by w. */
export function blend(
  A: Pick<AnticPose, 'head' | 'armL' | 'armR'>,
  key: 'head' | 'armL' | 'armR',
  target: readonly number[],
  w: number,
) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}

/** Which way p is from the chair, as a swivel angle. */
export const yawOf = (p: THREE.Vector3) => Math.atan2(p.x - LAYOUT.chair.x, p.z - LAYOUT.chair.z);

/** A mesh an antic builds as a prop. */
export type PropMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

const AIM = new THREE.Vector3(); // (scratch)
/** The arm angles that reach for p (office space), into `out`: shoulder pitch, shoulder out, elbow.
 *  Out of reach, it reaches as far as it can; the answer is how much longer the arm would have to
 *  be (1 when it's in reach, at most `most`). */
export function aim(c: TickCtx, side: 'L' | 'R', p: THREE.Vector3, out: number[], most = 1.9) {
  const arm = armOf(c, side);
  const v = c.robot.torso.worldToLocal(c.set.office.localToWorld(AIM.copy(p))).sub(arm.shoulder.position);
  const u = Math.abs(arm.elbow.position.y) || 0.2;
  const L = Math.max(1e-4, v.length());
  // the arm hangs along -y: pitch swings it forward (-) / back (+), out swings it sideways
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

/** The chair swivel that brings p round to `off` radians from straight ahead. */
export function turnTo(c: TickCtx, p: THREE.Vector3, off: number) {
  const rel = wrap(yawOf(p) - c.curYaw);
  return rel - Math.sign(rel) * Math.min(Math.abs(rel), off);
}
