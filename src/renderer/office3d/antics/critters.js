import * as THREE from 'three';
import { toon } from '../materials.js';
import { LAYOUT } from '../scene.js';

// Each character's own idle fidget: the cat chases its tail and tests your
// patience with the mug, Loopy gnaws a pencil, the nerd pushes up his glasses or
// shreds an air guitar, the girl twirls a pigtail or makes a finger heart, the
// robot flicks its antenna or defragments.
// robot.js only plays them for the matching body. See ./index.js for the contract.

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

// elbow to the middle of the hand, per body (the upper arm comes from the rig)
const FOREARM = { loopy: 0.18, cat: 0.15, nerd: 0.2, girl: 0.2, robot: 0.24 };

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
  const l2 = FOREARM[c.body] ?? 0.24;
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
  // the cat chases its own tail: one slow lap of the chair, looking back, swatting
  'cat-tail': {
    dur: 4.5,
    update(c, A) {
      const { s, w } = c;
      // eased so the lap ends exactly where it began (no w: 2π is home anyway)
      A.yaw += Math.PI * 2 * ramp(s, 0.2, 4.2);
      A.antenna += Math.sin(s * 16) * 0.55 * w;
      c.toward(A.head, TAIL_LOOK, w);
      A.lean = c.mix(A.lean, 0.12, w);
      // the paw swats back at it, again and again
      const swat = Math.max(0, Math.sin(s * 7));
      _arm[0] = 0.15 + swat * 0.55;
      _arm[1] = 0.75 + swat * 0.25;
      _arm[2] = -1.1 + swat * 0.7;
      c.toward(A.armR, _arm, w);
    },
  },

  // pushes the mug, slowly, towards the edge of the desk... stares at you... "just kidding"
  'cat-mug': {
    dur: 4.2,
    fadeIn: 0.5,
    fadeOut: 0.3,
    update(c, A) {
      const { s, w } = c;
      // half-turn towards the mug (the right paw's side), but keep the face to you: the
      // joke is the stare, and the stretchy paw can do the reaching
      const toMug = Math.atan2(c.mugHome.x - LAYOUT.chair.x, c.mugHome.z - LAYOUT.chair.z);
      const turn = clamp(wrap(toMug - 0.75 - c.camYaw), -0.9, 0.9);
      A.yaw += wrap(c.camYaw + turn - c.curYaw) * w;
      A.lean = c.mix(A.lean, 0.12, w);
      A.rootZ += 0.08 * w;
      // out towards the desk's right edge (it teeters there), then back
      const out = 0.1 * ramp(s, 0.8, 2.2) * (1 - ramp(s, 3.6, 4.0));
      A.mug.x += out;
      A.mugTilt = -out * (1.2 + Math.sin(s * 11) * 0.5) * ramp(s, 1.6, 2.2);
      // the paw rides along on the mug: behind it to push, hopping over it to pull it back
      const over = ramp(s, 3.35, 3.6);
      _t.set(c.mix(-0.1, 0.1, over), 0.07 + Math.sin(over * Math.PI) * 0.12, 0.02).add(c.mugHome).add(A.mug);
      c.set.office.localToWorld(_t);
      const reach = aim(c, 'R', _t, _arm);
      c.toward(A.armR, _arm, w);
      A.reachR = c.mix(1, reach, w);
      // eyes on the mug, then on you (robot.js gives it the flat stare at 2.2)
      const stare = ramp(s, 2.2, 2.5) * (1 - ramp(s, 3.7, 4.0));
      _head[0] = c.mix(0.15, -0.05, stare);
      _head[1] = c.mix(0.45, clamp(wrap(c.camYaw - c.curYaw - A.yaw), -1.3, 1.3), stare);
      _head[2] = 0.1 * stare;
      c.toward(A.head, _head, w);
    },
  },

  // Loopy gnaws a pencil, corn-on-the-cob style
  'loopy-pencil': {
    dur: 3.8,
    fadeIn: 0.5,
    fadeOut: 0.5,
    update(c, A) {
      const { s, w, robot, run } = c;
      const elbow = robot.arms.armR.elbow;
      pencil ||= buildPencil();
      if (pencil.parent !== elbow) elbow.add(pencil);
      const gnaw = ramp(s, 0.6, 0.8) * (1 - ramp(s, 3.0, 3.2));
      const slide = Math.sin((s - 0.7) * 2.6) * 0.05 * gnaw; // working along it like a typewriter
      // hand up to the mouth
      const reach = aim(c, 'R', onHead(c, 0.15 + slide, 0.17, 0.43), _arm);
      c.toward(A.armR, _arm, w);
      A.reachR = c.mix(1, reach, w);
      // chewing: the head bobs like the 'chomp' reaction
      A.head[0] = c.mix(A.head[0], 0.12, w) + Math.sin(s * 22) * 0.1 * gnaw;
      // the pencil: pops into the paw, goes across the mouth, gets shorter, pops away
      const toMouth = ramp(s, 0.25, 0.7) * (1 - ramp(s, 3.1, 3.5));
      elbow.localToWorld(_p.set(0, -0.18, 0));
      _p.lerp(onHead(c, 0.13 + slide, 0.2, 0.41), toMouth);
      robot.head.getWorldQuaternion(_q).multiply(ACROSS);
      const pop = easeOutBack(clamp(s / 0.3, 0, 1)) * (1 - ramp(s, 3.45, 3.8));
      robot.head.getWorldScale(_sc).multiplyScalar(Math.max(0.001, pop));
      _sc.y *= 1 - 0.22 * ramp(s, 0.8, 3.0);
      // set in scene space, then expressed in the elbow's frame (so the arm's stretch can't skew it)
      pencil.matrix.copy(elbow.matrixWorld).invert().multiply(_m.compose(_p, _q, _sc));
      pencil.matrixWorldNeedsUpdate = true;
      // wood chips
      if (gnaw > 0.5 && s >= (run.nextChip ?? 0)) {
        run.nextChip = s + 0.12 + Math.random() * 0.12;
        const a = Math.random() * Math.PI * 2;
        c.emit('crumb', c.worldPoint(robot.head, slide + (Math.random() - 0.5) * 0.12, 0.2, 0.45), {
          life: 0.7, vel: new THREE.Vector3(Math.cos(a) * 0.45, 0.35 + Math.random() * 0.35, 0.25), size: 0.045, gravity: 2.2, spin: 5,
        });
      }
    },
    end() {
      pencil?.parent?.remove(pencil);
    },
  },

  // a finger to the bridge of the glasses, push them up the nose, *glint*
  'nerd-glasses': {
    dur: 2.0,
    fadeIn: 0.45,
    fadeOut: 0.55,
    update(c, A) {
      const { s, w, robot, run } = c;
      const glasses = robot.glasses;
      run.gy ??= glasses?.position.y ?? 0;
      const lift = 0.035 * ramp(s, 0.5, 0.8) * (1 - ramp(s, 1.3, 1.9));
      if (glasses) glasses.position.y = run.gy + lift;
      const reach = aim(c, 'R', onHead(c, 0, 0.33 + lift, 0.47), _arm);
      c.toward(A.armR, _arm, w);
      A.reachR = c.mix(1, reach, w);
      // chin down to meet the finger, then up, smugly
      A.head[0] = c.mix(A.head[0], 0.08 - 0.16 * ramp(s, 0.6, 0.9), w);
      if (!run.glint && s >= 0.85) {
        run.glint = true;
        c.emit('star', c.worldPoint(robot.head, 0.16, 0.38, 0.44), { life: 0.55, vel: new THREE.Vector3(0.04, 0.06, 0), size: 0.1, grow: 0.2, spin: 6 });
      }
    },
    end(c) {
      if (c.robot.glasses && c.run.gy !== undefined) c.robot.glasses.position.y = c.run.gy;
    },
  },

  // air guitar: left hand on the neck, right hand strumming, head-banging
  'nerd-guitar': {
    dur: 4.5,
    fadeIn: 0.4,
    fadeOut: 0.5,
    update(c, A) {
      const { s, w, run } = c;
      const beat = Math.abs(Math.sin(s * 6.5));
      _arm[0] = -1.25;
      _arm[1] = 0.95;
      _arm[2] = -0.45 + Math.sin(s * 5) * 0.12; // sliding along the frets
      c.toward(A.armL, _arm, w);
      const strum = Math.sin(s * 26);
      _arm[0] = -0.75 + strum * 0.22;
      _arm[1] = -0.3;
      _arm[2] = -1.45 + strum * 0.25;
      c.toward(A.armR, _arm, w);
      A.head[0] = c.mix(A.head[0], -0.05 + beat * 0.32, w);
      A.head[2] = c.mix(A.head[2], Math.sin(s * 3.25) * 0.12, w);
      A.lean = c.mix(A.lean, 0.08 + beat * 0.1, w);
      A.antenna += Math.sin(s * 13) * 0.4 * w; // the cowlick flaps along
      A.yaw += Math.sin(s * 2.2) * 0.12 * w;
      if (s > 0.4 && s < 4.0 && s >= (run.nextNote ?? 0)) {
        run.nextNote = s + 0.3 + Math.random() * 0.15;
        c.emit('note', c.hand('R'), { life: 1.1, vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.45, 0.15), size: 0.12, spin: (Math.random() - 0.5) * 3 });
      }
    },
  },

  // twirls a pigtail round a finger, head tipped towards it, the lock bouncing along
  'girl-hair': {
    dur: 3.2,
    fadeIn: 0.4,
    fadeOut: 0.5,
    update(c, A) {
      const { s, w, robot, run } = c;
      const tail = robot.pigtails?.[1];
      if (tail) {
        run.rot ??= tail.rotation.clone();
        const twirl = ramp(s, 0.5, 0.8) * (1 - ramp(s, 2.5, 3.0));
        tail.rotation.x = run.rot.x + Math.sin(s * 9) * 0.25 * twirl;
        tail.rotation.z = run.rot.z + Math.cos(s * 9) * 0.12 * twirl;
      }
      const a = s * 9;
      const reach = aim(c, 'R', onHead(c, 0.43 + Math.cos(a) * 0.025, 0.28 + Math.sin(a) * 0.03, -0.04), _arm);
      c.toward(A.armR, _arm, w);
      A.reachR = c.mix(1, reach, w);
      A.head[2] = c.mix(A.head[2], -0.2, w);
      A.head[1] = c.mix(A.head[1], 0.15, w);
      A.antenna += Math.sin(s * 4.5) * 0.15 * w;
    },
    end(c) {
      const tail = c.robot.pigtails?.[1];
      if (tail && c.run.rot) tail.rotation.copy(c.run.rot);
    },
  },

  // a finger heart in front of the chin, a head tilt, and little hearts float up
  'girl-heart': {
    dur: 2.6,
    fadeIn: 0.4,
    fadeOut: 0.5,
    update(c, A) {
      const { s, w, robot, run } = c;
      for (const [side, x] of [['L', -0.03], ['R', 0.03]]) {
        const reach = aim(c, side, robot.torso.localToWorld(_p.set(x, 0.62, 0.36)), _arm);
        c.toward(side === 'L' ? A.armL : A.armR, _arm, w);
        A[side === 'L' ? 'reachL' : 'reachR'] = c.mix(1, reach, w);
      }
      A.head[2] = c.mix(A.head[2], 0.22, w);
      A.head[0] = c.mix(A.head[0], -0.06, w);
      A.lean = c.mix(A.lean, 0.06, w);
      if (s > 0.8 && s < 2.0 && s >= (run.nextHeart ?? 0)) {
        run.nextHeart = s + 0.35;
        c.emit('heart', robot.torso.localToWorld(_p.set(0, 0.7, 0.38)), { life: 1.1, vel: new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.45, 0.1), size: 0.11 });
      }
    },
  },

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
