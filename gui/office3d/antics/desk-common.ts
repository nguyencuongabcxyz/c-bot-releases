// What the desk gags share: which hand is nearer, a window of an antic's time, a puff of dust or
// stars, and tidying up after.
import type { TickCtx, Vec3Tuple } from './types';
import * as THREE from 'three';
import { wrap, seg, easeOutQuad, mix } from '@/office3d/core/math';
import { yawOf, type PropMesh } from './common';
import { isMesh } from '@/office3d/core/mesh';

type Side = 'L' | 'R';

export const win = (s: number, a: number, b: number, c: number, d: number) => seg(s, a, b) * (1 - seg(s, c, d));
export const set3 = (out: Vec3Tuple, a: number, b: number, c: number) => {
  out[0] = a;
  out[1] = b;
  out[2] = c;
  return out;
};
export function toward3(out: Vec3Tuple, target: Vec3Tuple, k: number) {
  for (let i = 0; i < 3; i++) out[i] = mix(out[i], target[i], k);
}
// which hand is nearer a point ('L' / 'R'), and which way round that is (-1 / 1)
export const sideOf = (c: TickCtx, p: THREE.Vector3): Side => (wrap(yawOf(p) - c.curYaw) < 0 ? 'L' : 'R');

// pops in at `a` (with an overshoot), swells and pops away over [b, e]
export function pop(s: number, a: number, b: number, e: number) {
  if (s < a) return 0;
  if (s < a + 0.2) return easeOutQuad((s - a) / 0.2) * 1.15;
  if (s < a + 0.35) return 1.15 - 0.15 * ((s - a - 0.2) / 0.15);
  if (s < b) return 1;
  const k = (s - b) / (e - b);
  return k < 0.3 ? 1 + 0.5 * k : Math.max(0, 1.15 * (1 - (k - 0.3) / 0.7));
}

export function puff(c: TickCtx, from: THREE.Vector3, n: number, size = 0.07) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.emit('steam', from, {
      life: 0.45,
      vel: new THREE.Vector3(Math.cos(a) * 0.35, 0.15 + Math.random() * 0.1, Math.sin(a) * 0.35),
      size,
      grow: 2.2,
    });
  }
}
export function stars(c: TickCtx, from: THREE.Vector3, n: number, speed = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (0.15 + (i / Math.max(1, n - 1)) * 0.7);
    c.emit('star', from, {
      life: 0.6,
      vel: new THREE.Vector3(Math.cos(a) * speed, Math.sin(a) * speed, 0),
      size: 0.08,
      gravity: 0.6,
      spin: 5,
    });
  }
}

export function dispose(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh<PropMesh>(o)) return;
    o.geometry.dispose();
    o.material.dispose();
  });
}
