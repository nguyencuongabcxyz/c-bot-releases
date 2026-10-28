import { clamp, seg, smooth } from '@/office3d/core/math';
import * as THREE from 'three';
import type { Antic, AnticCtx, Vec3Tuple } from './types';

// The robot's own idle fidgets: it flicks its antenna or defragments.
// See ./index.js for the contract.

// a repeatable "random" number in [0, 1)
const hash = (a: number, b: number) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// scratch, so the per-frame maths doesn't allocate
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _arm: Vec3Tuple = [0, 0, 0];

// elbow to the middle of the hand (the upper arm comes from the rig)
const FOREARM = 0.24;

/**
 * Two-bone IK: the arm angles ([pitch, out, elbow], written into `out`) that put
 * the hand on `target`, a point in scene space. Uses last frame's matrices, which
 * is close enough. Out of reach, the arm goes straight and the returned stretch
 * (for A.reachL / A.reachR) makes up the rest. (The elbow only bends forwards, so
 * a target close by and straight out to the side is only roughly reached.)
 */
function aim(c: AnticCtx, side: 'L' | 'R', target: THREE.Vector3, out: Vec3Tuple) {
  const arm = c.robot.arms[side === 'L' ? 'armL' : 'armR'];
  const l1 = -arm.elbow.position.y;
  const l2 = FOREARM;
  c.robot.torso.worldToLocal(_v.copy(target)).sub(arm.shoulder.position);
  const d = Math.max(_v.length(), 1e-4);
  _v.divideScalar(d);
  // bend the elbow (forwards) until the hand is d away; phi: how far that swings the hand forward
  let bend = 0;
  let phi = 0;
  if (d < l1 + l2) {
    bend = -Math.acos(clamp((d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1));
    phi = Math.atan2(-l2 * Math.sin(bend), l1 + l2 * Math.cos(bend));
  }
  // shoulder: Rx(pitch) * Rz(out) must turn the hand's direction onto _v
  const theta = Math.asin(clamp(_v.x / Math.cos(phi), -1, 1));
  let pitch = Math.atan2(_v.z, _v.y) - Math.atan2(Math.sin(phi), -Math.cos(phi) * Math.cos(theta));
  if (pitch > Math.PI / 2) pitch -= Math.PI * 2;
  if (pitch < -Math.PI * 1.5) pitch += Math.PI * 2;
  out[0] = pitch;
  out[1] = theta * arm.side;
  out[2] = bend;
  return clamp(d / (l1 + l2), 1, 2.2);
}

// a point on the head, in scene space (into _t)
const onHead = (c: AnticCtx, x: number, y: number, z: number) => c.robot.head.localToWorld(_t.set(x, y, z));

// ---------------------------------------------------------------- the antics

export const CRITTERS: Record<string, Antic> = {
  // the right hand flicks the antenna (0-0.6), which boings back and forth
  'robot-antenna': {
    dur: 2.4,
    fadeIn: 0.2,
    fadeOut: 0.3,
    update(c, A) {
      const { s, w } = c;
      const armW = smooth(s / 0.35) * (1 - seg(s, 0.75, 1.25)) * w;
      // cocked beside the rod, then swept across it at 0.4-0.6
      const reach = aim(c, 'R', onHead(c, c.mix(0.16, -0.06, seg(s, 0.4, 0.6)), 0.72, 0.06), _arm);
      c.toward(A.armR, _arm, armW);
      A.reachR = c.mix(1, reach, armW);
      A.head[0] = c.mix(A.head[0], -0.15, armW);
      // bent by the hand, then let go: a damped spring (still from 0.3 rad, but flung)
      if (s < 0.6) A.antenna += 0.3 * seg(s, 0.45, 0.6);
      else {
        const k = s - 0.6;
        A.antenna += Math.exp(-k * 2.2) * (0.3 * Math.cos(k * 20) + 0.6 * Math.sin(k * 20));
      }
    },
  },

  // defragmenting: jerky little twitches, stepping at 12 Hz
  'robot-defrag': {
    dur: 1.8,
    fadeIn: 0.1,
    fadeOut: 0.2,
    update(c, A) {
      const step = Math.floor(c.s * 12);
      const j = (k: number, amount: number) => (hash(step, k) - 0.5) * 2 * amount * c.w;
      A.head[0] += j(1, 0.14);
      A.head[1] += j(2, 0.22);
      A.head[2] += j(3, 0.16);
      A.lean += j(4, 0.04);
      A.yaw += j(5, 0.05);
      A.rootY += Math.abs(j(6, 0.015));
      A.armL[0] += j(7, 0.12);
      A.armR[0] += j(8, 0.12);
      A.armL[2] += j(9, 0.15);
      A.armR[2] += j(10, 0.15);
      A.antenna += j(11, 0.3);
    },
  },
};

export function tick() {}
