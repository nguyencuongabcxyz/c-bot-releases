import * as THREE from 'three';
import { toon } from '../materials.js';
import { LAYOUT } from '../scene.js';

// The robot's own idle fidgets: it flicks its antenna or defragments.
// See ./index.js for the contract.

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ramp = (s, a, b) => smooth((s - a) / (b - a)); // 0 before a, 1 after b
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const easeOutBack = (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
// a repeatable "random" number in [0, 1)
const hash = (a, b) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// scratch, so the per-frame maths doesn't allocate
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _arm = [0, 0, 0];
const _head = [0, 0, 0];

// elbow to the middle of the hand (the upper arm comes from the rig)
const FOREARM = 0.24;

/**
 * Two-bone IK: the arm angles ([pitch, out, elbow], written into `out`) that put
 * the hand on `target`, a point in scene space. Uses last frame's matrices, which
 * is close enough. Out of reach, the arm goes straight and the returned stretch
 * (for A.reachL / A.reachR) makes up the rest. (The elbow only bends forwards, so
 * a target close by and straight out to the side is only roughly reached.)
 */
function aim(c, side, target, out) {
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
const onHead = (c, x, y, z) => c.robot.head.localToWorld(_t.set(x, y, z));

// ---------------------------------------------------------------- the pencil

// Loopy's snack: a yellow hexagonal pencil, built along y with the grip at the
// origin, the pink eraser just above it and the point down at -y. Built once.
let pencil = null;
function buildPencil() {
  const g = new THREE.Group();
  const add = (geo, color, y, flip = false) => {
    const m = new THREE.Mesh(geo, toon(color));
    m.position.y = y;
    if (flip) m.rotation.x = Math.PI; // cones point down, to the tip
    m.castShadow = true;
    g.add(m);
  };
  add(new THREE.CylinderGeometry(0.021, 0.021, 0.04, 12), '#ff8fb1', 0.075); // eraser
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.03, 12), '#c9ccd6', 0.04); // metal band
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.3, 6), '#ffc62e', -0.125); // body
  add(new THREE.ConeGeometry(0.026, 0.06, 6), '#e8c18f', -0.305, true); // sharpened wood
  add(new THREE.ConeGeometry(0.0095, 0.021, 6), '#2a2a33', -0.3245, true); // lead
  g.matrixAutoUpdate = false; // placed by hand each frame, see loopy-pencil
  return g;
}
// held across the mouth: the pencil's +y (eraser end) along the head's +x
const ACROSS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

// ---------------------------------------------------------------- the antics

const TAIL_LOOK = [0.22, 1.0, 0.18]; // head: back over its right shoulder, at the tail

export const CRITTERS = {
  // the right hand flicks the antenna (0-0.6), which boings back and forth
  'robot-antenna': {
    dur: 2.4,
    fadeIn: 0.2,
    fadeOut: 0.3,
    update(c, A) {
      const { s, w } = c;
      const armW = smooth(s / 0.35) * (1 - ramp(s, 0.75, 1.25)) * w;
      // cocked beside the rod, then swept across it at 0.4-0.6
      const reach = aim(c, 'R', onHead(c, c.mix(0.16, -0.06, ramp(s, 0.4, 0.6)), 0.72, 0.06), _arm);
      c.toward(A.armR, _arm, armW);
      A.reachR = c.mix(1, reach, armW);
      A.head[0] = c.mix(A.head[0], -0.15, armW);
      // bent by the hand, then let go: a damped spring (still from 0.3 rad, but flung)
      if (s < 0.6) A.antenna += 0.3 * ramp(s, 0.45, 0.6);
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
      const j = (k, amount) => (hash(step, k) - 0.5) * 2 * amount * c.w;
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
