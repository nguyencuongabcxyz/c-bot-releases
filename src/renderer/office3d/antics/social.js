import * as THREE from 'three';
import { LAYOUT } from '../scene.js';
import { buildPaperPlane } from '../plane3d.js';

// Robots noticing each other (main social.js decides when; robot.js plays these):
//   turn-to   2.6 s  c.text 'L' | 'R': turns in its chair towards the robot on that side of the
//                    screen and looks over (robot.js adds the wave or the cheer pose on top)
//   listen    10 s   c.text 'L' | 'R': a visitor is chatting beside its desk: it turns that
//                    way and nods along now and then; robot.js stops it when the visitor goes
//   clap-at   2.2 s  c.text 'L' | 'R': turns a little that way and claps (hands meet at 0.35,
//                    0.75, 1.15, 1.55; robot.js plays the claps)
//   plane-throw 1.8 s  c.text 'L' | 'R': turns that way with a paper plane in its hand, winds
//                    up and throws it at 1.0 (the plane leaves its hand: main's plane window
//                    flies it across the screen from there)
//   plane-catch 2.6 s  c.text 'L' | 'R': a hand up that way, catches the plane at 0.3, unfolds
//                    it in front of its face and reads it 0.6-2.1 (robot.js says what's on it)
//   plane-read  2.6 s  the plane that landed on its desk: turns back to pick it up (0.2-0.6, the
//                    desk's plane goes then), reads it 0.8-2.1
// The shared rig only (yaw, head, arms), so every body does them.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)
// screen-left / screen-right in office space (the camera looks in from +x +z: index.js CAMERA),
// pulled a little towards the camera so it turns to the neighbour rather than side-on
const SIDE = { L: new THREE.Vector3(-0.79, 0, 0.61), R: new THREE.Vector3(0.79, 0, -0.61) };
const TO_CAMERA = new THREE.Vector3(0.62, 0, 0.8).normalize();

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, k) => a + (b - a) * k;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s, a, b) => smooth((s - a) / (b - a));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function blend(A, key, target, w) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}

const V1 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const QL = [0, 0, 0];
const QR = [0, 0, 0];

// how far to swivel (relative to now) to face the robot on that side
function turnTowards(c, side, most) {
  const p = V1.copy(LAYOUT.chair).addScaledVector(SIDE[side === 'L' ? 'L' : 'R'], 3).addScaledVector(TO_CAMERA, 1.6);
  const want = Math.atan2(p.x - LAYOUT.chair.x, p.z - LAYOUT.chair.z);
  return clamp(wrap(want - c.curYaw), -most, most);
}

const at = (c, obj, x, y, z, out) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c, side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
// arm angles that put a hand on a point (office space), as awake.js / notes.js
function aim(c, side, p, out) {
  const arm = armOf(c, side);
  const v = c.robot.torso.worldToLocal(c.set.office.localToWorld(AIM.copy(p))).sub(arm.shoulder.position);
  const u = Math.abs(arm.elbow.position.y) || 0.2;
  const L = Math.max(1e-4, v.length());
  out[0] = Math.atan2(-v.z, -v.y);
  out[1] = Math.asin(clamp(v.x / L, -1, 1)) * arm.side;
  if (L >= u + HAND) {
    out[2] = 0;
    return;
  }
  out[2] = -(Math.PI - Math.acos(clamp((u * u + HAND * HAND - L * L) / (2 * u * HAND), -1, 1)));
  out[0] += Math.acos(clamp((u * u + L * L - HAND * HAND) / (2 * u * L), -1, 1));
}

const turnTo = {
  dur: 2.6,
  fadeIn: 0.3,
  fadeOut: 0.4,
  update(c, A) {
    const { s } = c;
    const k = seg(s, 0, 0.45) * (1 - seg(s, 2.1, 2.6));
    A.yaw += turnTowards(c, c.text, 0.9) * k * c.w;
    // and the head a bit further, a friendly tilt
    A.head[1] += (c.text === 'L' ? 1 : -1) * 0.18 * k * c.w;
    A.head[2] += 0.1 * k * c.w;
  },
};

const listen = {
  dur: 10,
  fadeIn: 0.4,
  fadeOut: 0.5,
  update(c, A) {
    const { s } = c;
    const k = seg(s, 0, 0.6);
    A.yaw += turnTowards(c, c.text, 0.75) * k * c.w;
    A.head[1] += (c.text === 'L' ? 1 : -1) * 0.2 * k * c.w;
    // nodding along now and then
    const nod = Math.max(0, Math.sin(s * 1.7)) ** 6;
    A.head[0] += 0.16 * nod * Math.abs(Math.sin(s * 9)) * k * c.w;
    A.lean += 0.04 * k * c.w;
  },
};

const clapAt = {
  dur: 2.2,
  fadeIn: 0.25,
  fadeOut: 0.35,
  update(c, A) {
    const { s } = c;
    const k = seg(s, 0, 0.3) * (1 - seg(s, 1.75, 2.2));
    A.yaw += turnTowards(c, c.text, 0.5) * k * c.w;
    A.head[1] += (c.text === 'L' ? 1 : -1) * 0.15 * k * c.w;
    // hands in front of the chest, coming together on each clap
    const apart = 0.07 + 0.09 * Math.abs(Math.cos(((s - 0.35) / 0.4) * Math.PI));
    at(c, c.robot.torso, -apart, 0.34, 0.32, V1);
    aim(c, 'L', V1, QL);
    blend(A, 'armL', QL, k * c.w);
    at(c, c.robot.torso, apart, 0.34, 0.32, V1);
    aim(c, 'R', V1, QR);
    blend(A, 'armR', QR, k * c.w);
    A.head[0] -= 0.05 * k * c.w;
  },
};

// ---------------------------------------------------------------- paper planes

// the arm on that side of the screen once it's turned that way
const armFor = (side) => (side === 'L' ? 'L' : 'R');
const PLANE_SIZE = 1.7; // (held up close, it's drawn bigger than the one on the desk)
const handAt = (c, armSide, out) => at(c, armOf(c, armSide).elbow, 0, -HAND, 0, out);
// a plane in its hand (made the first time it's asked for, freed in end())
function planeIn(c) {
  if (!c.run.plane) {
    c.run.plane = buildPaperPlane();
    c.set.office.add(c.run.plane);
  }
  return c.run.plane;
}
function dropPlane(c) {
  const pl = c.run?.plane;
  if (!pl) return;
  pl.removeFromParent();
  pl.userData.dispose?.();
  c.run.plane = null;
}
const WIND = [-2.6, 0.3, -1.5]; // the arm back and up, ready to throw
const OUT = [-1.75, 0.25, -0.15]; // the arm out after the throw
const UP = [-2.75, 0.4, -0.35]; // a hand up high, catching
// the plane held in front of its face to read (torso space)
const READ_AT = new THREE.Vector3(0, 0.56, 0.3);

const planeThrow = {
  dur: 1.8,
  fadeIn: 0.25,
  fadeOut: 0.35,
  update(c, A) {
    const { s } = c;
    const side = c.text === 'L' ? 'L' : 'R';
    const arm = armFor(side);
    const turn = seg(s, 0, 0.35) * (1 - seg(s, 1.3, 1.8));
    A.yaw += turnTowards(c, side, 0.8) * turn * c.w;
    A.head[1] += (side === 'L' ? 1 : -1) * 0.15 * turn * c.w;
    const key = arm === 'L' ? 'armL' : 'armR';
    blend(A, key, WIND, seg(s, 0.3, 0.8) * (1 - seg(s, 0.85, 1.0)) * c.w);
    blend(A, key, OUT, seg(s, 0.85, 1.0) * (1 - seg(s, 1.3, 1.8)) * c.w);
    A.lean += 0.08 * (seg(s, 0.85, 1.0) - seg(s, 1.2, 1.6)) * c.w;
    // the plane, in its hand till it lets go
    if (s >= 0.1 && s < 1.0) {
      const pl = planeIn(c);
      handAt(c, arm, pl.position);
      pl.scale.setScalar(PLANE_SIZE * Math.min(1, (s - 0.1) / 0.15));
      pl.rotation.set(0, side === 'L' ? Math.PI * 0.75 : -Math.PI * 0.25, -0.35 * seg(s, 0.3, 0.8));
    } else if (s >= 1.0) dropPlane(c);
  },
  end: dropPlane,
};

const planeCatch = {
  dur: 2.6,
  fadeIn: 0.2,
  fadeOut: 0.4,
  update(c, A) {
    const { s } = c;
    const side = c.text === 'L' ? 'L' : 'R';
    const arm = armFor(side);
    const key = arm === 'L' ? 'armL' : 'armR';
    const turn = seg(s, 0, 0.3) * (1 - seg(s, 0.6, 1.0));
    A.yaw += turnTowards(c, side, 0.7) * turn * c.w;
    blend(A, key, UP, seg(s, 0, 0.25) * (1 - seg(s, 0.45, 0.7)) * c.w);
    // then both hands bring it in front of its face, and it reads
    const read = seg(s, 0.5, 0.8) * (1 - seg(s, 2.1, 2.5));
    if (read > 0) {
      at(c, c.robot.torso, -0.08, READ_AT.y, READ_AT.z, V1);
      aim(c, 'L', V1, QL);
      blend(A, 'armL', QL, read * c.w);
      at(c, c.robot.torso, 0.08, READ_AT.y, READ_AT.z, V1);
      aim(c, 'R', V1, QR);
      blend(A, 'armR', QR, read * c.w);
      A.head[0] += 0.12 * read * c.w; // eyes down to it
    }
    if (s >= 0.3 && s < 2.35) {
      const pl = planeIn(c);
      if (s < 0.6) handAt(c, arm, pl.position);
      else at(c, c.robot.torso, 0, READ_AT.y, READ_AT.z + 0.04, pl.position);
      pl.scale.setScalar(PLANE_SIZE * (s > 2.2 ? Math.max(0.001, (2.35 - s) / 0.15) : 1));
      // unfolded to read: flat, facing it
      const open = seg(s, 0.6, 0.8);
      pl.rotation.set(-Math.PI / 2 * open, c.curYaw + A.yaw, 0);
    } else if (s >= 2.35) dropPlane(c);
  },
  end: dropPlane,
};

const planeRead = {
  dur: 2.6,
  fadeIn: 0.2,
  fadeOut: 0.4,
  update(c, A) {
    const { s } = c;
    // a quick turn back to the desk to pick it up
    const back = seg(s, 0, 0.3) * (1 - seg(s, 0.5, 0.8));
    A.yaw += wrap(c.monitorYaw - c.curYaw) * 0.55 * back * c.w;
    blend(A, 'armR', [-0.9, 0.2, -0.6], back * c.w);
    const read = seg(s, 0.6, 0.9) * (1 - seg(s, 2.1, 2.5));
    if (read > 0) {
      at(c, c.robot.torso, -0.08, READ_AT.y, READ_AT.z, V1);
      aim(c, 'L', V1, QL);
      blend(A, 'armL', QL, read * c.w);
      at(c, c.robot.torso, 0.08, READ_AT.y, READ_AT.z, V1);
      aim(c, 'R', V1, QR);
      blend(A, 'armR', QR, read * c.w);
      A.head[0] += 0.12 * read * c.w;
    }
    if (s >= 0.45 && s < 2.35) {
      const pl = planeIn(c);
      if (s < 0.7) handAt(c, 'R', pl.position);
      else at(c, c.robot.torso, 0, READ_AT.y, READ_AT.z + 0.04, pl.position);
      pl.scale.setScalar(PLANE_SIZE * (s > 2.2 ? Math.max(0.001, (2.35 - s) / 0.15) : 1));
      pl.rotation.set(-Math.PI / 2 * seg(s, 0.7, 0.9), c.curYaw + A.yaw, 0);
    } else if (s >= 2.35) dropPlane(c);
  },
  end: dropPlane,
};

export const SOCIAL = { 'turn-to': turnTo, listen, 'clap-at': clapAt, 'plane-throw': planeThrow, 'plane-catch': planeCatch, 'plane-read': planeRead };
