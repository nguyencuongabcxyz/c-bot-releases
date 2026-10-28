import { mix, smooth } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import type { Antic, AnticCtx, AnticEndCtx } from './types';

// Push-ups. It hops off the chair (poof), drops into a plank on the floor beside it,
// legs straight out, and does five push-ups side-on to you, counting them out and sweating more
// each time; the last one is slow and wobbly. A flop on the floor, then it hops back
// into the chair, proud. Timings are a contract: robot.js plays the hop, a grunt per
// rep and the brag at the marked moments (see REPS and the times below).

const DOWN_AT = 0.45; // hops down
const UP_AT = 8.9; // hops back up
const REPS = [1.3, 2.4, 3.5, 4.6, 5.7]; // when each push-up starts
const REP = 1.1; // seconds a push-up takes (the last one takes longer)
const LAST = 1.8;

// The camera looks at the desk from here (CAMERA.dir in index.js), along the floor.
const TOWARD_YOU = new THREE.Vector3(0.62, 0, 0.8).normalize();
const U = new THREE.Vector3(-TOWARD_YOU.z, 0, TOWARD_YOU.x); // its head points to your left: you see it side-on
const F = new THREE.Vector3(0, -1, 0); // face down
const X = new THREE.Vector3().crossVectors(U, F); // its side axis
const PLANK = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, U, F));
const HIPS = new THREE.Vector3(0.0, 0, -0.14); // where its hips are (office space): in front of the desk, toes clear of the bin
const CHAIR_ASIDE = new THREE.Vector3(1.0, 0, -0.5); // the chair rolls out of the way, clear of its toes

// Saved leg parts (straightenLegs), and its own scratch (c.run)
type Saved = { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion };
type PushRun = { legs?: Saved[] | null; onFloor?: boolean; lift?: number | null; nextSweat?: number };

const TILT = new THREE.Quaternion();
const BOX = new THREE.Box3();
const M = new THREE.Matrix4();
const V = new THREE.Vector3();

// how far down it is (0 = arms straight, 1 = chest to the floor) s seconds in, and which rep
function depth(s: number) {
  for (let i = REPS.length - 1; i >= 0; i--) {
    if (s < REPS[i]) continue;
    const len = i === REPS.length - 1 ? LAST : REP;
    const p = (s - REPS[i]) / len;
    if (p >= 1) return { d: 0, rep: i, done: true };
    // down, a pause at the bottom, up (the last one stalls halfway, trembling)
    let d = p < 0.42 ? smooth(p / 0.42) : p < 0.52 ? 1 : 1 - smooth((p - 0.52) / 0.48);
    if (i === REPS.length - 1 && p > 0.5 && p < 0.8) d = 0.55 + 0.05 * Math.sin(s * 40);
    return { d, rep: i, done: false };
  }
  return { d: 0, rep: -1, done: false };
}

function poof(c: AnticCtx, at: THREE.Vector3) {
  const world = c.set.office.parent; // (the office sits in the scene's world group)
  if (!world) return;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    V.copy(at).add(new THREE.Vector3(Math.cos(a) * 0.1, 0.05, Math.sin(a) * 0.1));
    c.emit('steam', world.worldToLocal(c.set.office.localToWorld(V.clone())), {
      life: 0.6,
      vel: new THREE.Vector3(Math.cos(a) * 0.3, 0.25, Math.sin(a) * 0.3),
      size: 0.15,
      grow: 2.2,
    });
  }
}

// Straight legs for the plank. The legs are built sitting: a hip group with the thigh
// forward (+z) and the shin and foot hanging down from the knee. Swing each hip so the
// thigh runs along the body, and fold the shin and foot round the knee so they carry on
// in line (their toes end up tucked under, on the floor). Saved, so seat() can undo it.
// Bodies built differently (the cat) keep their knees bent: knee push-ups.
const UNFOLD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const SWING = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
function straightenLegs(c: AnticCtx) {
  const saved: Saved[] = [];
  for (const hip of c.robot.root.children) {
    if (hip === c.robot.torso || isMesh(hip) || Math.abs(hip.position.x) < 0.05) continue;
    const below = hip.children.filter((o) => o.position.y < -0.1);
    const thigh = hip.children.find((o) => o.position.y > -0.05 && o.position.z > 0.08);
    if (!below.length || !thigh) continue;
    const knee = Math.min(...below.map((o) => o.position.z));
    saved.push({ o: hip, p: hip.position.clone(), q: hip.quaternion.clone() });
    for (const o of below) {
      saved.push({ o, p: o.position.clone(), q: o.quaternion.clone() });
      const dy = o.position.y;
      const dz = o.position.z - knee;
      o.position.set(o.position.x, dz, knee - dy);
      o.quaternion.premultiply(UNFOLD);
    }
    hip.quaternion.premultiply(SWING);
  }
  return saved;
}
function restoreLegs(saved: Saved[] = []) {
  for (const { o, p, q } of saved) {
    o.position.copy(p);
    o.quaternion.copy(q);
  }
}

// back in its chair, as the frame expects it
function seat(c: AnticEndCtx<PushRun>) {
  const { robot, set } = c;
  restoreLegs(c.run.legs as Saved[]); // (only ever seated from the floor, legs straightened)
  c.run.legs = null;
  if (robot.root.parent === set.swivel) return;
  set.swivel.add(robot.root);
  robot.root.position.x = 0;
  robot.root.rotation.set(0, 0, 0);
  robot.root.rotation.order = 'XYZ';
}

const pushup: Antic<PushRun> = {
  dur: 10,
  fadeIn: 0.25,
  fadeOut: 0.5,
  update(c, A) {
    const { s } = c;
    const down = s >= DOWN_AT && s < UP_AT;
    if (!down) {
      // getting ready (a little bounce), and the proud fists-up once it's back in the chair
      const proud = smooth((s - UP_AT - 0.1) / 0.3) * (1 - smooth((s - 9.6) / 0.35));
      for (const key of ['armL', 'armR'] as const) {
        A[key][0] = mix(A[key][0], -2.7, proud * c.w);
        A[key][1] = mix(A[key][1], 0.5, proud * c.w);
        A[key][2] = mix(A[key][2], -1.3, proud * c.w);
      }
      return;
    }
    // in the plank: arms straight down to the floor, bending as it goes down; head up, looking ahead
    const { d, rep } = depth(s);
    for (const key of ['armL', 'armR'] as const) {
      A[key][0] = -1.55 + 0.35 * d;
      A[key][1] = 0.28;
      A[key][2] = -1.25 * d;
    }
    A.reachL = A.reachR = 1;
    A.lean = 0;
    // its head turned your way (its side axis points at you), chin up a little
    A.head[0] = -0.4 + 0.12 * d;
    A.head[1] = 0.85;
    A.head[2] = 0;
    // sweat, more with every rep
    const every = rep < 1 ? 0 : 0.9 - rep * 0.12;
    if (every > 0 && s >= (c.run.nextSweat || 0)) {
      c.run.nextSweat = s + every;
      c.emit('sweat', c.worldPoint(c.robot.head, 0.3, (c.robot.headTop ?? 0.6) * 0.7, 0.1), {
        life: 0.8,
        vel: new THREE.Vector3(0.05, -0.4, 0),
        size: 0.07,
        gravity: 0.6,
      });
    }
    // count them out as it comes back up; a "phew" on the floor after the last one
    const top = rep >= 0 && depth(s).d < 0.5 && s > REPS[rep] + (rep === REPS.length - 1 ? LAST : REP) * 0.6;
    if (rep >= 0 && top && s < REPS[rep] + (rep === REPS.length - 1 ? LAST : REP) + 0.35)
      c.say(rep === REPS.length - 1 ? `${rep + 1}!!` : String(rep + 1));
    if (s > 7.7 && s < 8.7) c.say('phew…');
  },

  place(c) {
    const { s, robot, set } = c;
    const down = s >= DOWN_AT && s < UP_AT;
    const chair = set.swivel.parent; // (the chair's base)
    const aside = smooth((s - DOWN_AT + 0.15) / 0.35) * (1 - smooth((s - UP_AT + 0.25) / 0.3));
    chair?.position.copy(LAYOUT.chair).addScaledVector(CHAIR_ASIDE, aside);
    if (!down) {
      if (c.run.onFloor) {
        c.run.onFloor = false;
        seat(c);
        poof(c, HIPS);
      }
      return;
    }
    if (!c.run.onFloor) {
      c.run.onFloor = true;
      poof(c, V.copy(LAYOUT.chair).setY(0.5));
      set.office.add(robot.root);
      c.run.legs = straightenLegs(c);
      c.run.lift = null;
    }
    // a plank, tipping head-down as it lowers (about its knees), flat on the floor for the "phew"
    const { d } = depth(s);
    const flop = smooth((s - 7.6) / 0.25) * (1 - smooth((s - 8.6) / 0.25));
    const tilt = mix(-0.2, 0.12, Math.max(d, flop));
    robot.root.quaternion.copy(TILT.setFromAxisAngle(X, tilt).multiply(PLANK));
    robot.root.position.copy(HIPS);
    if (c.run.lift === null) {
      // stand it on its knees and hands: lift until its lowest point touches the floor
      robot.root.updateMatrixWorld(true);
      BOX.setFromObject(robot.root);
      BOX.min.applyMatrix4(M.copy(set.office.matrixWorld).invert());
      c.run.lift = -BOX.min.y;
    }
    robot.root.position.y += (c.run.lift as number) - 0.04 * d; // (measured above)
  },

  bubbleAt(c) {
    if (!c.run.onFloor) return null;
    return c.worldPoint(c.robot.head, 0, 0, 0).add(V.set(0.25, 0.45, 0));
  },

  end(c) {
    // cut short (work came in, it dozed off): legs back, straight back into the chair
    if (c.run?.onFloor && c.robot && c.set) seat(c);
    c.set?.swivel.parent?.position.copy(LAYOUT.chair);
  },
};

export const PUSHUP: Record<string, Antic> = { pushup };
