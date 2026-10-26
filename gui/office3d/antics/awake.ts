import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { toon, spriteTexture } from '@/office3d/materials';
import { FEEDS, FLICKS, FUNNY, LIKE } from '@/office3d/feeds';
import type { Antic, AnticCtx, AnticPose, ParticleKind, TickCtx, Vec3Tuple } from './types';

// Antics while awake and idle (usually turned round to face you, back to the
// desk): sipping coffee (sometimes the mug's empty), tipping the chair back too
// far, tossing paper at the bin, humming, sneezing, fiddling with the lamp,
// drumming on the desk, a bored slump, and watching the DVD screensaver.
// Timings are a contract: robot.js plays sounds and speech at the marked moments.
// Everything moves the shared rig only (root, torso, head, arms), so it works
// for every body, custom models included.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)
const BIN = new THREE.Vector3(0.56, 0, -0.76); // the wastebasket: right of the desk, in frame
const BIN_TOP = 0.24;
// the paper ball's misses: clip the near rim, bounce off towards the camera, roll
const TO_CHAIR = new THREE.Vector3(LAYOUT.chair.x - BIN.x, 0, LAYOUT.chair.z - BIN.z).normalize();
const OUTWARD = new THREE.Vector3(TO_CHAIR.z, 0, -TO_CHAIR.x); // across the throw, towards the camera
const RIM = BIN.clone().addScaledVector(TO_CHAIR, 0.11).setY(BIN_TOP + 0.03);
const MOUTH = BIN.clone().setY(BIN_TOP + 0.08);
const LAND = BIN.clone().addScaledVector(TO_CHAIR, 0.2).addScaledVector(OUTWARD, 0.2).setY(0.045);
const HOP = LAND.clone().addScaledVector(OUTWARD, 0.1).addScaledVector(TO_CHAIR, 0.05);
const REST = HOP.clone().addScaledVector(OUTWARD, 0.09).addScaledVector(TO_CHAIR, 0.04);

type Side = 'L' | 'R';
type PoseKey = 'head' | 'armL' | 'armR';
type Span = [number, number];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a)); // eases 0 -> 1 over [a, b]
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (p: THREE.Vector3) => Math.atan2(p.x - LAYOUT.chair.x, p.z - LAYOUT.chair.z);
// true the first frame at or past `at` (one-shot emits, whatever the frame rate)
const once = (c: AnticCtx, key: string, at: number) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);

// Key-framed values: start from `from`, then ease toward each [t0, t1, to] in turn.
function track(s: number, from: number, keys: [number, number, number][]) {
  let v = from;
  for (const [a, b, to] of keys) v = mix(v, to, seg(s, a, b));
  return v;
}
function pose(out: Vec3Tuple, from: Vec3Tuple, s: number, keys: [number, number, Vec3Tuple][]) {
  for (let i = 0; i < 3; i++) out[i] = from[i];
  for (const [a, b, to] of keys) {
    const k = seg(s, a, b);
    if (k > 0) for (let i = 0; i < 3; i++) out[i] = mix(out[i], to[i], k);
  }
  return out;
}
function blend(A: AnticPose, key: PoseKey, target: Vec3Tuple, w: number) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];
const QL: Vec3Tuple = [0, 0, 0];
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

// A point on a part of the robot, in office space (= the world group the
// particles and the mug live in).
const at = (c: TickCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c: TickCtx, side: Side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
const handAt = (c: TickCtx, side: Side, out: THREE.Vector3) => at(c, armOf(c, side).elbow, 0, -HAND, 0, out);

// Arm angles [pitch, out, elbow] that put a hand on a point (office space): a
// two-bone reach worked out in the torso's frame. Too far for the arm: it points
// straight and the returned stretch (A.reachL/R) makes up the rest; too close:
// the elbow bends. Uses last frame's matrices, close enough while things ease.
function aim(c: TickCtx, side: Side, p: THREE.Vector3, out: Vec3Tuple, most = 1.9) {
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

// chair swivel that brings an object round to `off` radians from straight ahead
function turnTo(c: TickCtx, p: THREE.Vector3, off: number) {
  const rel = wrap(yawOf(p) - c.curYaw);
  return rel - Math.sign(rel) * Math.min(Math.abs(rel), off);
}

function puff(c: TickCtx, kind: ParticleKind, from: THREE.Vector3, dir: THREE.Vector3, n: number, { speed = 1, life = 0.5, size = 0.06, grow = 2.4, spread = 0.25 } = {}) {
  for (let i = 0; i < n; i++) {
    const vel = new THREE.Vector3(dir.x + (Math.random() - 0.5) * spread, dir.y + (Math.random() - 0.5) * spread, dir.z + (Math.random() - 0.5) * spread).multiplyScalar(speed);
    c.emit(kind, from, { life, vel, size, grow });
  }
}

// ------------------------------------------------------------ coffee

type Trip = Record<'grab' | 'lift' | 'back' | 'drop' | 'home', Span>; // when it reaches, lifts, puts back, lets go, comes home

const GRIP = 0.04;
const MUG_MID = 0.07; // the mug's middle, up from its base
// move a point (office space) further from / nearer to the chair, horizontally
function outward(p: THREE.Vector3, d: number) {
  const dx = p.x - LAYOUT.chair.x;
  const dz = p.z - LAYOUT.chair.z;
  const k = d / (Math.hypot(dx, dz) || 1);
  p.x += dx * k;
  p.z += dz * k;
  return p;
}

// Reach round for the mug (right arm), bring it to the face, put it back.
// T: the antic's times; near: where it's held (head space); tilt: how far it tips.
function mugTrip(c: AnticCtx, A: AnticPose, T: Trip, near: THREE.Vector3, tilt: number) {
  const { s } = c;
  const yawReach = turnTo(c, c.mugHome, 1.3);
  const yaw = track(s, 0, [[0, T.grab[1], yawReach], [...T.lift, Math.min(0.3, yawReach)], [...T.back, yawReach], [...T.home, 0]]);
  A.yaw = yaw * c.w;
  // the hand takes the mug by its near side (towards the chair), a little up from its base
  const rMug = aim(c, 'R', outward(V1.copy(c.mugHome), -GRIP).setY(c.mugHome.y + MUG_MID), PR);
  const rFace = aim(c, 'R', at(c, c.robot.head, near.x, near.y, near.z, V1), QR);
  pose(PL, A.armR, s, [[...T.grab, PR], [...T.lift, QR], [...T.back, PR], [...T.home, A.armR]]);
  blend(A, 'armR', PL, c.w);
  A.reachR = mix(1, track(s, 1, [[...T.grab, rMug], [...T.lift, rFace], [...T.back, rMug], [...T.home, 1]]), c.w);
  A.lean += 0.08 * (seg(s, ...T.grab) - seg(s, ...T.lift) + seg(s, ...T.back) - seg(s, ...T.home)) * c.w; // lean into the reach
  // tip the mug's top towards the face (it only tips about the world z axis)
  const toFace = Math.sin(c.curYaw + yaw) >= 0 ? 1 : -1;
  const hold = seg(s, T.grab[1] - 0.05, T.grab[1] + 0.1) * (1 - seg(s, ...T.drop)) * c.w;
  if (hold > 0) {
    const th = tilt * toFace;
    // ...and keeps it just beyond the hand (away from the chair); the mug pivots
    // on its base, so keep its middle there whatever the tilt
    outward(handAt(c, 'R', V2), GRIP);
    V2.x += MUG_MID * Math.sin(th);
    V2.y -= MUG_MID * Math.cos(th);
    A.mug.copy(V2).sub(c.mugHome).multiplyScalar(hold);
    A.mugTilt = th * hold;
  }
}
// the head: glance at the mug while reaching for it / putting it back
const lookAtMug = (c: AnticCtx, T: Trip, s: number) => seg(s, 0, T.grab[1]) * (1 - seg(s, ...T.lift)) + seg(s, ...T.back) * (1 - seg(s, ...T.home));

// (fadeOut is short so the arm doesn't start home before the mug is let go)
const SIP: Trip = { grab: [0.1, 0.85], lift: [0.9, 1.4], back: [2.45, 2.95], drop: [2.95, 3.08], home: [3.08, 3.38] };
const SIP_EMPTY: Trip = { grab: [0.1, 0.85], lift: [0.9, 1.4], back: [3.0, 3.4], drop: [3.4, 3.52], home: [3.52, 3.78] };
// where the hand holds it (head space): the mug's rim at the mouth / lower down to peer in
const AT_MOUTH = new THREE.Vector3(0, 0.13, 0.33);
const PEER = new THREE.Vector3(0, 0.02, 0.4);

const sip: Antic = {
  dur: 3.4,
  fadeOut: 0.25,
  update(c, A) {
    const { s } = c;
    // drink: the head tips back and the mug with it
    const drink = seg(s, 1.4, 1.7) * (1 - seg(s, 2.2, 2.5));
    mugTrip(c, A, SIP, AT_MOUTH, mix(0.25 * seg(s, 1.0, 1.4) * (1 - seg(s, 2.45, 2.9)), 1.0, drink));
    const look = lookAtMug(c, SIP, s);
    HEAD[0] = mix(0.2 * look, -0.35, drink);
    HEAD[1] = 0.4 * look;
    HEAD[2] = 0;
    blend(A, 'head', HEAD, c.w);
    if (once(c, 'steam', 1.6)) puff(c, 'steam', at(c, c.robot.head, 0.05, 0.32, 0.4, V3), V1.set(0, 0.3, 0), 1, { speed: 1, life: 1.1, size: 0.08, spread: 0.05 });
  },
};

const sipEmpty: Antic = {
  dur: 3.8,
  fadeOut: 0.25,
  update(c, A) {
    const { s } = c;
    // ...nothing comes out: tip it right up to the face and peer in (and give it a shake)
    const peer = seg(s, 1.5, 1.8) * (1 - seg(s, 3.0, 3.3));
    const shake = Math.sin(s * 26) * 0.14 * bump(s, 2.0, 2.5);
    mugTrip(c, A, SIP_EMPTY, V3.lerpVectors(AT_MOUTH, PEER, peer), mix(0.25 * seg(s, 1.0, 1.4) * (1 - seg(s, 3.0, 3.4)), 1.15, peer) + shake);
    const look = lookAtMug(c, SIP_EMPTY, s);
    HEAD[0] = mix(0.2 * look, 0.35, peer);
    HEAD[1] = 0.4 * look;
    HEAD[2] = 0.12 * peer;
    blend(A, 'head', HEAD, c.w);
  },
};

// ------------------------------------------------------------ chair

const BEHIND_HEAD: Vec3Tuple = [-2.75, 0.95, -2.3]; // as POSES.slack
const tip: Antic = {
  dur: 3.2,
  update(c, A) {
    const { s } = c;
    // rock back on two legs, hands behind the head... too far... catch it!
    let t = 0.26 * seg(s, 0, 0.7) + Math.sin(s * 5.5) * 0.05 * seg(s, 0.2, 0.6);
    t = mix(t, 0.55, seg(s, 1.35, 1.6));
    t = mix(t, 0, seg(s, 1.8, 1.92));
    if (s > 1.92) t -= 0.05 * Math.exp(-(s - 1.92) * 6) * Math.sin((s - 1.92) * 20); // thunk
    A.tip = t * c.w;
    A.rootY += 0.07 * bump(s, 1.84, 2.1) * c.w;
    // windmilling while it goes
    const flail = seg(s, 1.4, 1.5) * (1 - seg(s, 1.85, 2.0));
    for (const [arr, key, ph] of [[PL, 'armL', 0], [PR, 'armR', 2.1]] as const) {
      pose(arr, A[key], s, [[0, 0.6, BEHIND_HEAD], [1.4, 1.95, A[key]]]);
      if (flail > 0) {
        QL[0] = -2.3 + Math.sin(s * 19 + ph) * 0.65;
        QL[1] = 0.75 + Math.sin(s * 23 + ph) * 0.3;
        QL[2] = -0.6 + Math.sin(s * 17 + ph) * 0.45;
        for (let i = 0; i < 3; i++) arr[i] = mix(arr[i], QL[i], flail);
      }
      blend(A, key, arr, c.w);
    }
    A.lean = mix(A.lean, A.lean - 0.1 * seg(s, 0, 0.7) - 0.12 * flail + 0.1 * bump(s, 1.85, 2.3), c.w);
    // head: lazing back, panic, then a shifty look round ("...nobody saw that")
    HEAD[0] = -0.15 * seg(s, 0, 0.7) - 0.25 * flail + 0.1 * bump(s, 1.9, 2.4);
    HEAD[1] = 0.35 * Math.sin((s - 2.2) * 8) * bump(s, 2.2, 3.05);
    HEAD[2] = 0.05 * seg(s, 0, 0.7) * (1 - flail) + Math.sin(s * 15) * 0.12 * flail;
    blend(A, 'head', HEAD, c.w);
    if (once(c, 'sweat', 1.9)) c.emit('sweat', at(c, c.robot.head, 0.36, 0.5, 0.1, V1), { life: 0.9, vel: new THREE.Vector3(0.05, -0.35, 0), size: 0.09 });
  },
};

// ------------------------------------------------------------ paper toss

// (three's types only put isMesh on a Mesh) the props built here have one material each
type PropMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
const isMesh = (o: THREE.Object3D): o is PropMesh => 'isMesh' in o && !!o.isMesh;

// the wastebasket: a little bin on the floor right of the desk, one per desk
function makeBin() {
  const bin = new THREE.Group();
  bin.position.copy(BIN);
  const grey = toon('#9aa3b8', { side: THREE.DoubleSide });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.085, BIN_TOP, 20, 1, true), grey);
  wall.position.y = BIN_TOP / 2;
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.085, 20), grey);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.005;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.012, 6, 24), toon('#6b7390'));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = BIN_TOP;
  bin.add(wall, floor, rim);
  // earlier attempts that went in
  const paper = toon('#f4f5fa');
  for (const [x, y, z, r] of [[0.025, 0.19, -0.03, 0.045], [-0.035, 0.18, 0.02, 0.04]]) {
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), paper);
    ball.position.set(x, y, z);
    ball.userData.binPaper = true; // (gone once the evening housemaid empties it: index.js)
    bin.add(ball);
  }
  bin.traverse((o) => {
    if (isMesh(o)) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return bin;
}

let ballTex: THREE.CanvasTexture | null = null;
function makeBall(c: TickCtx) {
  ballTex ||= spriteTexture('ball');
  const mat = new THREE.SpriteMaterial({ map: ballTex, transparent: true, depthWrite: false });
  mat.userData.outlineParameters = { visible: false };
  const ball = new THREE.Sprite(mat);
  ball.scale.setScalar(0.001);
  c.set.office.add(ball);
  return ball;
}
// along a straight line from a to b, plus a hop of height h
function arc(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, u: number, h: number) {
  out.lerpVectors(a, b, u);
  out.y += 4 * h * u * (1 - u);
  return out;
}

const WINDUP: Vec3Tuple = [-2.6, 0.35, -1.6]; // hand up behind the head
const THROW: Vec3Tuple = [-2.1, 0.3, -0.25];
const PUMP: Vec3Tuple = [-2.5, 0.25, -1.3];

function toss(hit: boolean): Antic<{ ball?: ReturnType<typeof makeBall>; from?: THREE.Vector3 }> {
  return {
    dur: 2.8,
    fadeOut: 0.45,
    update(c, A) {
      const { s, run } = c;
      const ball = run.ball || (run.ball = makeBall(c));
      // crumple it up in front of the chest, swivel to face the bin a bit, throw at 1.0
      const turn = turnTo(c, BIN, 0.75);
      const sd = Math.sign(turn) || 1;
      A.yaw = track(s, 0, [[0.55, 0.95, turn], [2.2, 2.75, 0]]) * c.w;
      const squeeze = Math.sin(s * 24) * 0.03 * (1 - seg(s, 0.6, 0.8));
      aim(c, 'L', at(c, c.robot.torso, -0.06, 0.3 - squeeze, 0.34, V1), QL);
      aim(c, 'R', at(c, c.robot.torso, 0.06, 0.3 + squeeze, 0.34, V1), QR);
      pose(PL, A.armL, s, [[0, 0.35, QL], [0.8, 1.2, A.armL]]);
      pose(PR, A.armR, s, [[0, 0.35, QR], [0.72, 0.95, WINDUP], [0.97, 1.1, THROW], ...((hit ? [[1.95, 2.12, PUMP]] : []) satisfies [number, number, Vec3Tuple][]), [2.15, 2.6, A.armR]]);
      blend(A, 'armL', PL, c.w);
      blend(A, 'armR', PR, c.w);
      A.lean = mix(A.lean, A.lean + 0.15 * seg(s, 0.95, 1.1) * (1 - seg(s, 1.5, 2.1)), c.w);
      // watch it fly; then proud, or deflated
      HEAD[0] = track(s, 0, [[0, 0.3, 0.3], [0.6, 1.0, 0.1], [1.1, 1.8, 0.35], [1.9, 2.1, hit ? -0.12 : 0.42], [2.3, 2.75, 0]]);
      HEAD[1] = sd * track(s, 0, [[0.6, 1.0, 0.35], [1.1, 1.8, 0.45], [1.9, 2.1, 0.25], [2.3, 2.75, 0]]);
      HEAD[2] = track(s, 0, [[1.9, 2.1, hit ? -0.1 : 0.15], [2.3, 2.75, 0]]);
      blend(A, 'head', HEAD, c.w);

      let size = 0.14;
      ball.visible = true;
      if (s < 1.0) {
        // between the hands, crumpling smaller; into the right hand for the throw
        handAt(c, 'L', V2);
        handAt(c, 'R', V3);
        ball.position.lerpVectors(V2, V3, 0.5 + 0.5 * seg(s, 0.65, 0.85));
        size = mix(0.2, 0.14, seg(s, 0.05, 0.75)) * (1 + squeeze * 2);
      } else {
        run.from ||= ball.position.clone(); // let go where the hand was
        if (s < 1.9) arc(ball.position, run.from, hit ? MOUTH : RIM, (s - 1.0) / 0.9, 0.42);
        else if (hit) {
          // swish: down into the bin
          ball.position.copy(MOUTH).y = mix(MOUTH.y, 0.06, seg(s, 1.9, 2.15));
          ball.visible = s < 2.2;
        } else if (s < 2.2) arc(ball.position, RIM, LAND, (s - 1.9) / 0.3, 0.13); // off the rim...
        else if (s < 2.38) arc(ball.position, LAND, HOP, (s - 2.2) / 0.18, 0.04); // bounce...
        else ball.position.lerpVectors(HOP, REST, 1 - (1 - seg(s, 2.38, 2.62)) ** 2); // ...roll
        if (!hit) size *= 1 - seg(s, 2.55, 2.75);
      }
      ball.scale.setScalar(Math.max(0.001, size));
      ball.material.rotation = s < 1 ? Math.sin(s * 20) * 0.3 : s * 9;
    },
    end(c) {
      const ball = c.run?.ball;
      if (!ball) return;
      ball.removeFromParent();
      ball.material.dispose();
    },
  };
}

// ------------------------------------------------------------ little things

const hum: Antic<{ note?: number; side?: number }> = {
  dur: 4.5,
  update(c, A) {
    const { s, run } = c;
    // swaying along to a tune only it can hear, a note floating up now and then
    const sway = Math.sin(s * Math.PI * 1.6);
    HEAD[0] = A.head[0] - 0.05 + Math.abs(Math.sin(s * Math.PI * 1.6)) * 0.06;
    HEAD[1] = A.head[1] + sway * 0.12;
    HEAD[2] = A.head[2] + sway * 0.2;
    blend(A, 'head', HEAD, c.w);
    A.yaw = sway * 0.07 * c.w;
    A.antenna = -sway * 0.3 * c.w;
    A.lean += Math.sin(s * Math.PI * 3.2) * 0.02 * c.w;
    A.armL[2] += Math.sin(s * Math.PI * 1.6) * 0.15 * c.w;
    A.armR[2] += Math.sin(s * Math.PI * 1.6 + Math.PI) * 0.15 * c.w;
    if (s >= (run.note ?? 0.25) && s < c.dur - 0.6) {
      run.note = s + 0.5;
      const side = (run.side = -(run.side || 1));
      c.emit('note', at(c, c.robot.head, side * 0.22, (c.robot.headTop ?? 0.6) + 0.05, 0.05, V1), { life: 1.4, vel: new THREE.Vector3(side * 0.12, 0.35, 0), size: 0.13, spin: 1.5 });
    }
  },
};

const sneeze: Antic = {
  dur: 2.2,
  update(c, A) {
    const { s } = c;
    // ah... ah... (two hitches) ...ACHOO at 0.9
    const hitch = 0.07 * bump(s, 0.3, 0.42) + 0.09 * bump(s, 0.58, 0.72);
    const lean0 = A.lean;
    A.lean = mix(lean0, track(s, lean0, [[0, 0.3, lean0 - 0.08], [0.4, 0.75, lean0 - 0.16], [0.84, 0.92, lean0 + 0.38], [1.15, 1.8, lean0]]) - hitch, c.w);
    HEAD[0] = track(s, A.head[0], [[0, 0.3, -0.22], [0.4, 0.75, -0.42], [0.84, 0.92, 0.45], [1.15, 1.8, A.head[0]]]) - hitch;
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.1 * seg(s, 0.2, 0.75) * (1 - seg(s, 0.84, 0.92));
    blend(A, 'head', HEAD, c.w);
    QL[0] = -0.7; QL[1] = 0.35; QL[2] = -1.4; // hands come up...
    QR[0] = -1.0; QR[1] = 0.75; QR[2] = -0.4; // ...and fling out
    for (const key of ['armL', 'armR'] as const) {
      pose(PL, A[key], s, [[0.2, 0.8, QL], [0.86, 0.95, QR], [1.2, 1.8, A[key]]]);
      blend(A, key, PL, c.w);
    }
    A.rootY += 0.04 * bump(s, 0.88, 1.08);
    if (s >= 0.9 && s < 1.35) A.shake = 1 - (s - 0.9) / 0.45;
    if (s >= 0.9 && s < 1.4) A.lamp = Math.floor(s * 26) % 3 === 0 ? 1 : 0.1; // flicker
    A.mug.y += 0.05 * bump(s, 0.9, 1.2);
    A.mugTilt += 0.18 * Math.sin((s - 0.9) * 45) * bump(s, 0.9, 1.25);
    if (once(c, 'achoo', 0.9)) {
      const mouth = at(c, c.robot.head, 0, 0.2, 0.32, V1);
      const dir = at(c, c.robot.head, 0, 0.12, 1.32, V2).sub(mouth).normalize();
      puff(c, 'steam', mouth, dir, 5, { speed: 1.3, life: 0.5, size: 0.06, grow: 2.6, spread: 0.45 });
    }
  },
};

const lamp: Antic<{ side?: Side }> = {
  dur: 2.8,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    // swivel partway round and stretch an arm (the nearer one) to the lamp's base
    const turn = turnTo(c, c.lampHome, 1.75);
    run.side ||= wrap(yawOf(c.lampHome) - c.curYaw) < 0 ? 'L' : 'R';
    const sd = run.side === 'L' ? -1 : 1;
    const key = run.side === 'L' ? 'armL' : 'armR';
    A.yaw = track(s, 0, [[0, 0.7, turn], [2.0, 2.45, 0]]) * c.w;
    // click (1.0), click (1.3), click (1.5)... *smack* (1.9)
    const press = 0.035 * (bump(s, 0.92, 1.06) + bump(s, 1.22, 1.36) + bump(s, 1.42, 1.56)) + 0.06 * bump(s, 1.78, 1.96);
    V1.set(LAYOUT.chair.x - c.lampHome.x, 0, LAYOUT.chair.z - c.lampHome.z).setLength(0.07).add(c.lampHome);
    V1.y += 0.09 - press;
    const r = aim(c, run.side, V1, QL, 2.6);
    pose(PL, A[key], s, [[0.2, 0.85, QL], [1.95, 2.4, A[key]]]);
    blend(A, key, PL, c.w);
    A[sd < 0 ? 'reachL' : 'reachR'] = mix(1, track(s, 1, [[0.2, 0.85, r], [1.95, 2.4, 1]]), c.w);
    A.lamp = s < 1.0 ? 1 : s < 1.3 ? 0 : s < 1.5 ? 1 : s < 1.9 ? 0 : 1;
    HEAD[0] = track(s, A.head[0], [[0.1, 0.7, 0.15], [2.0, 2.45, A.head[0]]]);
    HEAD[1] = track(s, A.head[1], [[0.1, 0.7, 0.5 * sd], [2.0, 2.45, A.head[1]]]);
    HEAD[2] = A.head[2] + 0.12 * bump(s, 1.6, 1.95) * sd; // "hm?"
    blend(A, 'head', HEAD, c.w);
  },
};

const drum: Antic = {
  dur: 2.6,
  update(c, A) {
    const { s } = c;
    // still facing you: hunched over, drumming its fingers on its knees, fast
    for (const [side, key, out, ph] of [['L', 'armL', QL, 0], ['R', 'armR', QR, Math.PI]] as const) {
      const sx = side === 'L' ? -0.13 : 0.13;
      at(c, c.robot.root, sx, 0.17 + 0.06 * Math.max(0, Math.sin(s * 30 + ph)), 0.3, V1);
      aim(c, side, V1, out);
      pose(PL, A[key], s, [[0.35, 0.6, out], [1.9, 2.2, A[key]]]);
      blend(A, key, PL, c.w);
    }
    const on = seg(s, 0.3, 0.6) * (1 - seg(s, 1.9, 2.3));
    A.lean = mix(A.lean, mix(A.lean, 0.22, on), c.w);
    HEAD[0] = A.head[0] - 0.1 * on; // chin up, looking at you: well?
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.18 * on; // propped, bored
    blend(A, 'head', HEAD, c.w);
  },
};

const slump: Antic = {
  dur: 2.8,
  update(c, A) {
    const { s } = c;
    // a big breath in... and out, folding over with the arms hanging, then back up
    const up = seg(s, 0, 0.55) * (1 - seg(s, 0.6, 0.9));
    const down = seg(s, 0.6, 1.15) * (1 - seg(s, 2.0, 2.55));
    const lean = A.lean - 0.1 * up + (0.38 - A.lean) * down;
    A.lean = mix(A.lean, lean, c.w);
    HEAD[0] = mix(A.head[0] - 0.2 * up, 0.5, down);
    HEAD[1] = A.head[1];
    HEAD[2] = mix(A.head[2], 0.1, down);
    blend(A, 'head', HEAD, c.w);
    A.rootY += (0.025 * up - 0.025 * down) * c.w;
    // dangling straight down (against the lean), swinging a little
    const swing = Math.sin(s * 3.2) * 0.07 * seg(s, 1.0, 1.3);
    for (const [key, ph] of [['armL', 0], ['armR', 0.6]] as const) {
      PL[0] = -lean + 0.05 + Math.sin(s * 3.2 + ph) * swing;
      PL[1] = 0.32; // clear of the seat
      PL[2] = -0.2;
      for (let i = 0; i < 3; i++) PR[i] = mix(A[key][i], PL[i], down);
      PR[1] += 0.06 * up; // shoulders up with the breath
      blend(A, key, PR, c.w);
    }
    if (once(c, 'sigh', 0.7)) {
      const mouth = at(c, c.robot.head, 0, 0.2, 0.32, V1);
      const dir = at(c, c.robot.head, 0, -0.3, 1.3, V2).sub(mouth).normalize();
      puff(c, 'steam', mouth, dir, 1, { speed: 0.35, life: 1.0, size: 0.08, grow: 2.2, spread: 0.05 });
    }
  },
};

// ------------------------------------------------------------ screensaver

const CHEER: Vec3Tuple = [-2.9, 0.45, -0.25]; // as POSES.cheer
function dvd(lucky: boolean): Antic<{ look?: number }> {
  return {
    dur: 9.0,
    fadeIn: 0.8,
    fadeOut: 0.8,
    update(c, A) {
      const { s, run } = c;
      A.screen = lucky ? 'dvd-lucky' : 'dvd';
      // turn partway to the monitor; the head drifts round after it, lazily
      const turn = wrap(c.monitorYaw - c.curYaw);
      A.yaw = turn * 0.35 * c.w;
      run.look = mix(run.look ?? 0, clamp(turn * 0.3, -0.75, 0.75), 1 - Math.exp(-c.dt * 1.2));
      // the corner! (6.0): up out of the seat, arms in the air
      const yay = seg(s, 6.0, 6.18) * (1 - seg(s, 6.9, 7.2));
      HEAD[0] = mix(-0.06 + Math.sin(s * 0.7) * 0.03, -0.18, yay);
      HEAD[1] = run.look + Math.sin(s * 0.5) * 0.06;
      HEAD[2] = mix(0.06, 0, yay);
      blend(A, 'head', HEAD, c.w);
      A.lean = mix(A.lean, mix(-0.08, -0.04, yay), c.w);
      if (yay > 0) {
        A.rootY += 0.14 * bump(s, 6.0, 6.45) + 0.04 * Math.abs(Math.sin(s * 8)) * yay;
        for (const key of ['armL', 'armR'] as const) {
          for (let i = 0; i < 3; i++) PL[i] = CHEER[i];
          PL[1] += Math.sin(s * 14) * 0.18;
          blend(A, key, PL, yay * c.w);
        }
      }
      if (lucky && once(c, 'stars', 6.0)) {
        const top = at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.05, 0, V1);
        for (let i = 0; i < 5; i++) {
          const a = Math.PI * (0.15 + (i / 4) * 0.7);
          c.emit('star', top, { life: 1.0, vel: new THREE.Vector3(Math.cos(a) * 0.6, Math.sin(a) * 0.55, 0), size: 0.12, gravity: 0.8, spin: 5 });
        }
      }
    },
  };
}

// ------------------------------------------------------------ social feeds

// Swivels round to the monitor and scrolls a feed (c.text: facebook / tiktok /
// youtube, drawn by feeds.js), leaning in, one hand on the mouse and a flick of
// the wrist for every scroll. The funny one (4.8) cracks it up, shoulders
// shaking; it likes it at 6.2. robot.js plays: wheel ticks at FLICKS, giggle at
// FUNNY, pop at LIKE.
const MOUSE_ARM: Vec3Tuple = [-1.0, 0.0, -0.55]; // reaching for the mouse
const DESK_ARM: Vec3Tuple = [-0.95, 0.12, -0.75]; // resting on the desk
function feed(): Antic {
  return {
    dur: 9.6,
    fadeIn: 0.8,
    fadeOut: 0.9,
    update(c, A) {
      const { s } = c;
      A.screen = (FEEDS as Record<string, unknown>)[c.text] ? c.text : 'facebook'; // (any name: is it one of them?)
      // three-quarters round, so you see its face and the screen past its head
      A.yaw = wrap(c.monitorYaw - c.curYaw) * 0.72 * c.w;
      const laugh = seg(s, FUNNY, FUNNY + 0.15) * (1 - seg(s, FUNNY + 1.1, FUNNY + 1.4));
      const shake = Math.sin(s * 28) * laugh;
      A.lean = mix(A.lean, mix(0.1, -0.06, laugh) + 0.03 * shake, c.w);
      // eyes on the screen, nodding along a little; head thrown back to laugh
      HEAD[0] = mix(0.06 + Math.sin(s * 0.8) * 0.025, -0.16 + 0.05 * shake, laugh);
      HEAD[1] = 0.25 + Math.sin(s * 0.45) * 0.04; // the rest of the way round to the screen
      HEAD[2] = 0.08 * laugh;
      blend(A, 'head', HEAD, c.w);
      // the mouse hand: a flick for each scroll, and a tap for the like
      let flick = bump(s, LIKE - 0.1, LIKE + 0.15);
      for (const f of FLICKS) flick += bump(s, f - 0.05, f + 0.3);
      for (let i = 0; i < 3; i++) PR[i] = MOUSE_ARM[i];
      PR[0] -= 0.06 * flick;
      PR[2] += 0.2 * flick;
      blend(A, 'armR', PR, c.w);
      for (let i = 0; i < 3; i++) PL[i] = DESK_ARM[i];
      PL[0] += 0.1 * shake; // slapping the desk
      blend(A, 'armL', PL, c.w);
    },
  };
}

// ------------------------------------------------------------ milk tea

// A bubble tea pops into its hand (0.35); it lifts the straw to its mouth and
// sips, tapioca pearls riding up the straw while the tea goes down (1.2–3.6);
// then 😋, and the cup pops away again. robot.js plays: pop 0.35, slurps 1.3 / 2.3.
const MOUTHS: Record<string, Vec3Tuple> = { robot: [0, 0.2, 0.3], cat: [0, 0.2, 0.42], loopy: [0, 0.2, 0.4], nerd: [0, 0.2, 0.38], girl: [0, 0.2, 0.37] };
const CUP_H = 0.15;
const STRAW = 0.17;
const BOBA_SIZE = 1.35; // a bit bigger than life, so it reads in the small window
const UP = new THREE.Vector3(0, 1, 0);

function buildBoba() {
  const cup = new THREE.Group();
  const clear = toon('#eaf6ff', { transparent: true, opacity: 0.42 });
  clear.userData.outlineParameters = { thickness: 0.003 };
  cup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.044, CUP_H, 20, 1, true), clear));
  const tea = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.041, CUP_H * 0.82, 18), toon('#c99a6b'));
  tea.position.y = -CUP_H * 0.05;
  const teaPivot = new THREE.Group(); // scaled from the bottom as it's drunk
  teaPivot.position.y = -CUP_H * 0.46;
  tea.position.y = CUP_H * 0.41;
  teaPivot.add(tea);
  cup.add(teaPivot);
  const pearl = toon('#2b1d18');
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 * 2.3;
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), pearl);
    p.position.set(Math.cos(a) * 0.026 * (i % 3 ? 1 : 0.4), -CUP_H * 0.43 + (i % 3) * 0.012, Math.sin(a) * 0.026 * (i % 3 ? 1 : 0.4));
    cup.add(p);
  }
  const lid = new THREE.Mesh(new THREE.SphereGeometry(0.056, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), clear);
  lid.position.y = CUP_H / 2;
  lid.scale.y = 0.45;
  cup.add(lid);
  cup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.057, 0.057, 0.012, 20), toon('#ff8fc4')).translateY(CUP_H / 2));
  // the fat boba straw, pivoting on the lid so it can lean towards the mouth
  const straw = new THREE.Group();
  straw.position.y = CUP_H / 2 + 0.02;
  straw.add(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, STRAW, 10), toon('#ff5fa8')).translateY(STRAW / 2 - 0.04));
  const riding = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), pearl); // a pearl on its way up
  riding.visible = false;
  straw.add(riding);
  cup.add(straw);
  return { cup, teaPivot, straw, riding };
}

const milktea: Antic<{ boba?: ReturnType<typeof buildBoba> }> = {
  dur: 5.6,
  fadeOut: 0.5,
  update(c, A) {
    const { s, run } = c;
    if (!run.boba) {
      run.boba = buildBoba();
      c.set.office.add(run.boba.cup);
    }
    const { cup, teaPivot, straw, riding } = run.boba;
    const m = MOUTHS[c.body] || [0, (c.robot.headTop ?? 0.6) * 0.33, (c.robot.headTop ?? 0.6) * 0.5];
    // where the hand goes: in front of its chest, then up so the straw meets the mouth
    at(c, c.robot.head, 0.02, -0.32, 0.42, V1);
    at(c, c.robot.head, m[0] + 0.01, m[1] - BOBA_SIZE * (CUP_H / 2 + STRAW - 0.06), m[2] + 0.09 * BOBA_SIZE, V2);
    const lift = seg(s, 0.6, 1.2) * (1 - seg(s, 3.6, 4.2));
    V3.lerpVectors(V1, V2, lift);
    const r = aim(c, 'R', V3, QR, 2.2);
    const hold = seg(s, 0.05, 0.5) * (1 - seg(s, 4.6, 5.3));
    blend(A, 'armR', QR, hold * c.w);
    A.reachR = mix(A.reachR, r, hold * c.w);

    // the cup sits in its hand; it pops in and pops away again
    handAt(c, 'R', cup.position);
    cup.position.y += 0.01;
    const size = s < 0.35 ? 0 : s < 0.55 ? easeOut((s - 0.35) / 0.2) * 1.15 : s < 0.7 ? 1.15 - 0.15 * ((s - 0.55) / 0.15) : s < 4.6 ? 1 : Math.max(0, 1 - (s - 4.6) / 0.25);
    cup.scale.setScalar(Math.max(0.001, size * BOBA_SIZE * (c.robot.root.scale.x / 0.82)));
    cup.visible = size > 0.01;
    // the straw leans towards the mouth while it's up there
    at(c, c.robot.head, m[0], m[1], m[2], V1);
    straw.getWorldPosition(V2);
    c.set.office.worldToLocal(V2);
    AIM.copy(V1).sub(V2).normalize();
    straw.quaternion.setFromUnitVectors(UP, AIM.lerp(UP, 1 - lift).normalize());

    // sipping: pearls ride up the straw, the tea level drops, little bobs of the head
    const sipping = s > 1.25 && s < 3.6;
    const phase = ((s - 1.25) * 2.2) % 1;
    riding.visible = sipping && phase < 0.85;
    riding.position.y = -0.03 + phase * (STRAW - 0.02);
    teaPivot.scale.y = mix(1, 0.62, seg(s, 1.25, 3.6));
    HEAD[0] = A.head[0] + 0.12 * lift + (sipping ? 0.03 * Math.sin(s * 14) : 0);
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.1 * bump(s, 3.7, 4.6); // happy little tilt
    blend(A, 'head', HEAD, c.w);
    if (s > 3.75 && s < 5.0) c.say('😋');
  },
  end(c) {
    const boba = c.run?.boba;
    if (!boba) return;
    boba.cup.removeFromParent();
    boba.cup.traverse((o) => {
      if (!isMesh(o)) return;
      o.geometry.dispose();
      o.material.dispose();
    });
  },
};
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);

// ------------------------------------------------------------ dumbbell

// A dumbbell pops into its hand: three bicep curls (the third one a real
// struggle: shaking, sweating), then a proud double-biceps flex, and it pops
// away again. robot.js counts the reps at 1.0 / 1.8 / 2.9 and brags at 4.0.
const CURL_DOWN: Vec3Tuple = [-0.15, 0.25, -0.25];
const CURL_UP: Vec3Tuple = [-0.35, 0.25, -2.3];
const FLEX: Vec3Tuple = [-1.57, 1.45, -1.9]; // elbows out at shoulder height, fists up
const DUMBBELL_SIZE = 1.3;
const QT = new THREE.Quaternion();

function buildDumbbell() {
  const g = new THREE.Group();
  const iron = toon('#3a3f52');
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 10), toon('#c9ccd6'));
  bar.rotation.z = Math.PI / 2;
  g.add(bar);
  for (const side of [-1, 1]) {
    for (const [x, r] of [[0.065, 0.045], [0.088, 0.034]]) {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.022, 18), iron);
      plate.rotation.z = Math.PI / 2;
      plate.position.x = side * x;
      g.add(plate);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 12), toon('#ff5e62'));
    cap.rotation.z = Math.PI / 2;
    cap.position.x = side * 0.103;
    g.add(cap);
  }
  g.traverse((o) => isMesh(o) && (o.castShadow = true));
  return g;
}

// how far up the curl is (0 down, 1 up), rep by rep; the third is slow and wobbly
function curlOf(s: number) {
  if (s < 0.6) return 0;
  if (s < 1.4) return bump(s, 0.6, 1.4);
  if (s < 2.2) return bump(s, 1.4, 2.2);
  if (s < 2.9) return seg(s, 2.2, 2.9) * (0.85 + 0.15 * Math.sin(s * 9)); // grinding it up
  return 1 - seg(s, 2.95, 3.5);
}

const dumbbell: Antic<{ bell?: THREE.Group }> = {
  dur: 6.0,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    if (!run.bell) {
      run.bell = buildDumbbell();
      c.set.office.add(run.bell);
    }
    const bell = run.bell;
    // the curls, then both arms up into the flex
    const curl = curlOf(s);
    const flex = seg(s, 3.55, 3.95) * (1 - seg(s, 5.2, 5.6));
    const strain = seg(s, 2.3, 2.5) * (1 - seg(s, 2.9, 3.1));
    for (let i = 0; i < 3; i++) PR[i] = mix(mix(CURL_DOWN[i], CURL_UP[i], curl), FLEX[i], flex);
    PR[2] += strain * Math.sin(s * 40) * 0.08; // the arm trembles
    // the free hand rests on the knee, then joins the flex
    at(c, c.robot.root, -0.13, 0.17, 0.28, V1);
    aim(c, 'L', V1, QL);
    for (let i = 0; i < 3; i++) PL[i] = mix(QL[i], FLEX[i], flex);
    const hold = seg(s, 0.05, 0.45);
    blend(A, 'armR', PR, hold * c.w);
    blend(A, 'armL', PL, hold * c.w);
    A.lean = mix(A.lean, A.lean - 0.06 * curl - 0.08 * flex + 0.05 * strain, c.w);
    // eyes on the dumbbell while curling; chin up and proud for the flex
    HEAD[0] = A.head[0] + 0.18 * curl * (1 - flex) - 0.12 * flex;
    HEAD[1] = A.head[1] + strain * Math.sin(s * 30) * 0.06;
    HEAD[2] = A.head[2] + 0.12 * flex;
    blend(A, 'head', HEAD, c.w);

    // the dumbbell sits across its fist, pops in and pops away
    handAt(c, 'R', bell.position);
    c.robot.torso.getWorldQuaternion(QT);
    bell.quaternion.copy(QT);
    const size = s < 0.15 ? 0 : s < 0.35 ? easeOut((s - 0.15) / 0.2) * 1.15 : s < 0.5 ? 1.15 - 0.15 * ((s - 0.35) / 0.15) : s < 5.5 ? 1 : Math.max(0, 1 - (s - 5.5) / 0.25);
    bell.scale.setScalar(Math.max(0.001, size * DUMBBELL_SIZE * (c.robot.root.scale.x / 0.82)));
    bell.visible = size > 0.01;

    if (once(c, 'sweat', 2.55)) c.emit('sweat', at(c, c.robot.head, 0.3, 0.5, 0.1, V2), { life: 0.9, vel: new THREE.Vector3(0.1, -0.35, 0), size: 0.08 });
    if (once(c, 'sparkle', 4.0)) {
      for (const side of ['L', 'R'] as const) {
        handAt(c, side, V2);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI + 0.4;
          c.emit('star', V2, { life: 0.8, vel: new THREE.Vector3(Math.cos(a) * 0.35, Math.sin(a) * 0.4 + 0.15, 0.1), size: 0.08, spin: 4 });
        }
      }
    }
    if (s > 4.05 && s < 5.1) c.say('💪');
  },
  end(c) {
    const bell = c.run?.bell;
    if (!bell) return;
    bell.removeFromParent();
    bell.traverse((o) => {
      if (!isMesh(o)) return;
      o.geometry.dispose();
      o.material.dispose();
    });
  },
};

// ------------------------------------------------------------ standing desk

// It swivels to the desk's panel and presses ▲ (1.5): the desk motors up. Too
// low now, it pulls the chair's lever and pumps the seat up to match (5.6),
// works up there a while, then presses ▼ (16.3) and both come back down.
// robot.js plays: beep 1.5, motor 1.6, hiss 5.6, beep 16.3, motor 16.4.
const DESK_UP = 0.3; // how far the desk rises (the panel shows 72 -> 102 cm)
const SEAT_UP = 0.27;
const TYPE: Vec3Tuple = [-1.15, -0.05, -0.35]; // typing arms, as in POSES.typing
// the desk's and the seat's heights, kept on set.office.userData.lift (liftTick below)
type Lift = { desk: number; seat: number; deskTo: number; seatTo: number; pressed: string; drawn: string };
const standDesk: Antic<{ panel?: number; screen?: number }> = {
  dur: 21,
  fadeIn: 0.4,
  fadeOut: 0.8,
  update(c, A) {
    const { s, run } = c;
    const L: Lift | undefined = c.set.office.userData.lift;
    if (!L || !c.set.desk) return;
    at(c, c.set.desk.buttons, 0, 0, 0, V2); // the buttons, wherever the desk is now
    run.panel ??= turnTo(c, V2, 0.3);
    run.screen ??= wrap(c.monitorYaw - c.curYaw);
    // face the panel, the screen while it works, the panel again, then back round
    A.yaw = track(s, 0, [[0, 0.8, run.panel], [2.3, 3.2, run.screen], [15.0, 15.8, run.panel], [19.4, 20.5, 0]]) * c.w;

    // ▲ and ▼: the desk (and the seat, once it's pumped) follow
    const up = s >= 1.5 && s < 1.9;
    const down = s >= 16.3 && s < 16.7;
    L.pressed = up ? 'up' : down ? 'down' : '';
    if (s >= 16.3) L.deskTo = L.seatTo = 0;
    else {
      if (s >= 1.5) L.deskTo = DESK_UP;
      if (s >= 5.6) L.seatTo = SEAT_UP;
    }

    // a finger on the buttons (pushed in while pressing)
    V1.copy(V2);
    V1.y += 0.015 - (up || down ? 0.012 : 0);
    const r = aim(c, 'R', V1, QR, 2.6);
    const press = seg(s, 0.6, 1.4) * (1 - seg(s, 1.9, 2.5)) + seg(s, 15.6, 16.2) * (1 - seg(s, 16.7, 17.3));
    // the chair's lever, under the left side of the seat
    at(c, c.set.swivel, -0.31, -0.06, 0.06, V3);
    const rl = aim(c, 'L', V3, QL, 2.2);
    const lever = seg(s, 5.0, 5.6) * (1 - seg(s, 7.0, 7.6));
    // typing up there, a little faster than at a normal desk
    const work = seg(s, 7.6, 8.4) * (1 - seg(s, 15.0, 15.6));
    const tap = Math.sin(s * 26) * 0.06 * work;
    for (const [key, sideTap] of [['armL', tap], ['armR', -tap]] as const) {
      PL[0] = TYPE[0] + sideTap;
      PL[1] = TYPE[1];
      PL[2] = TYPE[2];
      blend(A, key, PL, work * c.w);
    }
    blend(A, 'armR', QR, press * c.w);
    blend(A, 'armL', QL, lever * c.w);
    A.reachR = mix(A.reachR, r, press * c.w);
    A.reachL = mix(A.reachL, rl, lever * c.w);
    A.lean = mix(A.lean, mix(0.22, 0.32, lever), Math.max(work, lever, press * 0.6) * c.w);

    // looks up at the desk rising, down at the lever, at the screen while working
    HEAD[0] = A.head[0] - 0.28 * seg(s, 2.0, 2.6) * (1 - seg(s, 4.4, 5.0)) + 0.35 * lever + 0.08 * work;
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.1 * bump(s, 4.6, 5.4); // hm, too low now
    blend(A, 'head', HEAD, c.w);

    if (s > 2.4 && s < 4.2) c.say('⬆️');
    else if (s > 8.6 && s < 10.4) c.say('Standing desk mode!');
    else if (s > 17.0 && s < 18.6) c.say('Break time.');
  },
  end(c) {
    // cut short (work started, it dozed off): everything glides back down
    const L: Lift | undefined = c.set?.office?.userData?.lift;
    if (L) {
      L.deskTo = L.seatTo = 0;
      L.pressed = '';
    }
  },
};

// Every frame: the desk and the seat motor towards their heights (a real desk's
// pace), and the panel shows the height. Down again whenever the desk antic isn't playing.
function liftTick(c: TickCtx) {
  const { set } = c;
  if (!set?.desk?.top) return;
  const L: Lift = (set.office.userData.lift ||= { desk: 0, seat: 0, deskTo: 0, seatTo: 0, pressed: '', drawn: '' });
  if (c.antic !== 'standdesk') {
    L.deskTo = L.seatTo = 0;
    L.pressed = '';
  }
  const dt = Math.min(c.dt, 0.1);
  L.desk += clamp(L.deskTo - L.desk, -0.11 * dt, 0.11 * dt);
  L.seat += clamp(L.seatTo - L.seat, -0.2 * dt, 0.2 * dt);
  set.desk.top.position.y = L.desk;
  set.chair.lift(L.seat);
  // the whole set sinks a little as it rises, so the monitor stays in the small window
  set.office.position.y = -0.5 * Math.max(L.desk, L.seat);
  const cm = Math.round(72 + L.desk * 100);
  const key = `${cm}|${L.pressed}`;
  if (key !== L.drawn) {
    L.drawn = key;
    set.desk.drawPanel(cm, L.pressed);
  }
}

export const AWAKE: Record<string, Antic> = {
  standdesk: standDesk,
  milktea,
  dumbbell,
  sip,
  'sip-empty': sipEmpty,
  tip,
  toss: toss(false),
  'toss-hit': toss(true),
  hum,
  sneeze,
  lamp,
  drum,
  slump,
  dvd: dvd(false),
  'dvd-lucky': dvd(true),
  feed: feed(),
};

// Every frame: make sure this desk has its wastebasket (a new theme builds a new desk).
export function tick(c: TickCtx) {
  liftTick(c);
  const ud: { bin?: THREE.Group } | undefined = c.set?.office?.userData;
  if (!ud || ud.bin) return;
  ud.bin = makeBin();
  c.set.office.add(ud.bin);
}
