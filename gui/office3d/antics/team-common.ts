// What the team gags share: where its head is (to hit it), turning toward the screen, props sized
// with the robot, popping in, and tidying up after.
import type { AnticCtx } from './types';
import * as THREE from 'three';
import { isMesh } from '@/office3d/core/mesh';
import { wrap, clamp, easeOutQuad, mix } from '@/office3d/core/math';

const BOX = new THREE.Box3();
const SKULL = new THREE.Box3();

// The monitor is right behind the chair as you see it, so facing it means showing
// you its back: turn at most `most` towards it (the short way round) and let the
// head look the rest of the way, at most `look`. Returns [body, head] yaw.
const TURN = [0, 0];

// a prop popping in (a little overshoot) at a and away again at b
export const popIn = (s: number, a: number, b: number) =>
  s < a
    ? 0
    : s < a + 0.15
      ? easeOutQuad((s - a) / 0.15) * 1.15
      : s < a + 0.25
        ? 1.15 - 1.5 * (s - a - 0.15)
        : s < b
          ? 1
          : Math.max(0, 1 - (s - b) / 0.15);
export function lerp3(out: number[], target: readonly number[], k: number) {
  for (let i = 0; i < 3; i++) out[i] = mix(out[i], target[i], k);
}
export const E1 = new THREE.Euler();
export const M1 = new THREE.Matrix4();
export const M2 = new THREE.Matrix4();
export const B2 = new THREE.Box3();
export const scaleOf = (c: AnticCtx) => c.robot.root.scale.x / 0.82;
export function towardScreen(c: AnticCtx, most: number, look: number) {
  const rel = wrap(c.monitorYaw - c.curYaw);
  TURN[0] = clamp(rel, -most, most);
  TURN[1] = clamp(rel - TURN[0], -look, look);
  return TURN;
}

// The head's size, in head space (left/right of it, its middle, its front), from its
// meshes; hats, antennae and the hidden headband don't count. Bodies differ a lot.
export function headBox(c: AnticCtx) {
  const { head } = c.robot;
  head.updateWorldMatrix(true, true);
  M1.copy(head.matrixWorld).invert();
  BOX.makeEmpty();
  SKULL.makeEmpty();
  let most = 0;
  const skip: THREE.Object3D[] = [c.robot.antenna, c.robot.accessory, c.robot.headband];
  (function walk(o: THREE.Object3D) {
    if (!o.visible || skip.includes(o)) return;
    if (isMesh(o) && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const box = o.geometry.boundingBox; // (computed just above if it wasn't, so always there)
      if (box) {
        B2.copy(box).applyMatrix4(M2.multiplyMatrices(M1, o.matrixWorld));
        BOX.union(B2);
        // the skull: the biggest single piece (not the hair's pigtails, the ears)
        const vol = (B2.max.x - B2.min.x) * (B2.max.y - B2.min.y) * (B2.max.z - B2.min.z);
        if (vol > most) {
          most = vol;
          SKULL.copy(B2);
        }
      }
    }
    for (const k of o.children) walk(k);
  })(head);
  const top = c.robot.headTop ?? 0.6;
  if (BOX.isEmpty()) return { hw: 0.36, cy: top * 0.5, cz: 0, front: 0.3, top };
  return {
    hw: Math.max(-SKULL.min.x, SKULL.max.x),
    cy: (SKULL.min.y + SKULL.max.y) / 2,
    cz: (SKULL.min.z + SKULL.max.z) / 2,
    front: BOX.max.z,
    top,
  };
}

// The sitting legs (as pushup.js finds them): each hip group has its thigh forward
// and everything below the knee hanging down. bendLegs(k) swings the thighs down
// and unfolds the knees together (the shins stay upright), 0 sitting .. 1 standing.
export type HeadBox = ReturnType<typeof headBox>;

// (meshes and sprites carry a material, maybe with a texture; three's Object3D type doesn't say so)
type Mapped = THREE.Material & { map?: THREE.Texture | null };
type Dressed = THREE.Object3D & { material?: Mapped | Mapped[] };
export function dispose(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o: Dressed) => {
    if (isMesh(o)) o.geometry.dispose(); // (sprites share one geometry: leave it)
    if (!o.material) return;
    for (const m of ([] as Mapped[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
