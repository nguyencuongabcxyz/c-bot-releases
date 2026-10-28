// What the office-calendar gags share: props sized with the robot, popping in and out, both hands
// on something, a sigh, and tidying up after.
import * as THREE from 'three';
import { isMesh } from '@/office3d/core/mesh';
import type { TickCtx, AnticPose, Vec3Tuple } from './types';
import { easeOutQuad, mix } from '@/office3d/core/math';
import { aim, blend, at } from './common';

const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];

// a prop's size: pops in at a (with a little overshoot), away again at b
export function popScale(s: number, a: number, b: number) {
  if (s < a || s > b + 0.25) return 0;
  if (s > b) return 1 - (s - b) / 0.25;
  const u = (s - a) / 0.2;
  return u < 1 ? easeOutQuad(u) * 1.15 : u < 1.75 ? 1.15 - 0.2 * (u - 1) : 1;
}
// props are sized for the default robot; bodies seated bigger or smaller scale them
export const propScale = (c: TickCtx) => c.robot.root.scale.x / 0.82;

// (three's types only put isMesh / isSprite on those) what's disposed of here was built
// here, or by setAccessory: toon, basic or sprite materials, some meshes with several
export type Mat = THREE.MeshToonMaterial | THREE.MeshBasicMaterial | THREE.SpriteMaterial;
const isSprite = (o: THREE.Object3D): o is THREE.Sprite => 'isSprite' in o && !!o.isSprite;

export function disposeTree(obj: THREE.Object3D) {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh<THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>>(o) && !isSprite(o)) return;
    o.geometry?.dispose();
    for (const m of ([] as Mat[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
// both hands on a pair of points (office space), weighted in by w
export function grip(c: TickCtx, A: AnticPose, pl: THREE.Vector3, pr: THREE.Vector3, w: number) {
  const rl = aim(c, 'L', pl, PL, 2.2);
  const rr = aim(c, 'R', pr, PR, 2.2);
  blend(A, 'armL', PL, w);
  blend(A, 'armR', PR, w);
  A.reachL = mix(A.reachL, rl, w);
  A.reachR = mix(A.reachR, rr, w);
}

// where the mouth is on each head (head space); custom models: guessed from the head height
const MOUTHS: Record<string, Vec3Tuple> = {
  robot: [0, 0.2, 0.3],
  cat: [0, 0.2, 0.42],
  loopy: [0, 0.2, 0.4],
  nerd: [0, 0.2, 0.38],
  girl: [0, 0.2, 0.37],
};
export const mouthOf = (c: TickCtx): Vec3Tuple =>
  MOUTHS[c.body] || [0, (c.robot.headTop ?? 0.6) * 0.33, (c.robot.headTop ?? 0.6) * 0.5];
export const sigh = (c: TickCtx, dir = -0.4) => {
  const m = mouthOf(c);
  const from = at(c, c.robot.head, m[0], m[1], m[2] + 0.02, V3);
  c.emit('steam', from, {
    life: 1.0,
    vel: at(c, c.robot.head, m[0], m[1] + dir, m[2] + 1, V4)
      .sub(from)
      .normalize()
      .multiplyScalar(0.35),
    size: 0.08,
    grow: 2.2,
  });
};
