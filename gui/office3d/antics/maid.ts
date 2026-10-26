import * as THREE from 'three';
import type { Antic, AnticCtx, AnticPose, Vec3Tuple } from './types';

// The evening housemaid (main maid.js) comes by to tidy the desk:
//   feet-up   4.6 s  c.text 'L' | 'R' (the side she's on): it turns a little her way, lifts its
//                    feet off the floor so she can sweep under the desk (legs out straight 0.5–3.8,
//                    a little kick at 2.2), holds on to the seat, and puts them down again
// The shared rig (yaw, head, arms) and the sitting legs (team.js finds them; a body without
// legs just turns and holds on).

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a));
function blend(A: AnticPose, key: 'armL' | 'armR', target: Vec3Tuple, w: number) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}
// (three's types leave the isMesh flag off Object3D)
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => 'isMesh' in o;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
// both hands down by its hips, gripping the seat's edge
const GRIP_L: Vec3Tuple = [0.35, 0.55, -0.35];
const GRIP_R: Vec3Tuple = [0.35, 0.55, -0.35];

/** A sitting leg: its hip group (and how it was turned), the knee (hip space) and what hangs below it, as built. */
type SeatedLeg = {
  hip: THREE.Object3D;
  q: THREE.Quaternion;
  knee: THREE.Vector3;
  parts: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[];
};
/** feet-up's scratch: the legs, found on its first frame. */
type FeetUpRun = { legs?: SeatedLeg[] };

// The sitting legs, wherever they hang (a built robot's are inside its base group): each hip
// group has its thigh forward and everything below the knee hanging down (as team.js has them)
function seatedLegs(c: AnticCtx<FeetUpRun>) {
  const legs: SeatedLeg[] = [];
  c.robot.root.traverse((hip) => {
    if (isMesh(hip) || hip === c.robot.root || Math.abs(hip.position.x) < 0.05 || !hip.children.length) return;
    let up = hip.parent;
    while (up && up !== c.robot.root) {
      if (up === c.robot.torso) return; // (not an arm)
      up = up.parent;
    }
    const thigh = hip.children.find((o) => isMesh(o) && o.position.y > -0.05 && o.position.z > 0.08);
    const below = hip.children.filter((o) => o.position.y < -0.03);
    if (!thigh || !below.length) return;
    legs.push({
      hip,
      q: hip.quaternion.clone(),
      knee: new THREE.Vector3(0, thigh.position.y, Math.min(...below.map((o) => o.position.z))),
      parts: below.map((o) => ({ o, p: o.position.clone(), q: o.quaternion.clone() })),
    });
  });
  return legs;
}

// lift: 0 sitting .. 1 feet up (thighs tipped up a little, shins swung out level in front)
function lift(legs: SeatedLeg[], k: number, kick = 0) {
  Q1.setFromAxisAngle(X_AXIS, -0.3 * k);
  for (const [i, L] of legs.entries()) {
    L.hip.quaternion.copy(Q1).multiply(L.q);
    // (each foot kicks in turn)
    Q2.setFromAxisAngle(X_AXIS, -(Math.PI / 2 - 0.25) * k - kick * (i % 2 ? -1 : 1) * 0.18);
    for (const { o, p, q } of L.parts) {
      o.position.copy(p).sub(L.knee).applyQuaternion(Q2).add(L.knee);
      o.quaternion.copy(Q2).multiply(q);
    }
  }
}

const feetUp: Antic<FeetUpRun> = {
  dur: 4.6,
  fadeIn: 0.3,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    run.legs ||= seatedLegs(c);
    const up = seg(s, 0.4, 1.0) * (1 - seg(s, 3.7, 4.3));
    const kick = Math.sin(Math.max(0, s - 1.8) * 9) * seg(s, 1.8, 2.1) * (1 - seg(s, 2.7, 3.0));
    lift(run.legs, up, kick);
    // a little turn her way, a look down at the duster, hands on the seat
    const side = c.text === 'L' ? 1 : -1;
    A.yaw += side * 0.35 * up * c.w;
    A.head[0] = mix(A.head[0], 0.32, up * c.w);
    A.head[1] += side * 0.25 * up * c.w;
    blend(A, 'armL', GRIP_L, up * c.w);
    blend(A, 'armR', GRIP_R, up * c.w);
    // (a happy wiggle while she works)
    A.head[2] += 0.06 * Math.sin(s * 5) * up * c.w;
  },
  end(c) {
    if (c.run?.legs) lift(c.run.legs, 0);
  },
};

export const MAID: Record<string, Antic> = { 'feet-up': feetUp };
