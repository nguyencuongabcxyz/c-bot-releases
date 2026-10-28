import { bump, clamp, mix, seg, wrap } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import { type PropMesh, aim, at, blend, handAt, onceAt, outward, pose, track, turnTo, yawOf } from './common';
import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { toon, spriteTexture, noOutline } from '@/office3d/materials';
import { FEEDS, FLICKS, FUNNY, LIKE } from '@/office3d/feeds';
import type { Antic, AnticCtx, AnticPose, ParticleKind, TickCtx, Vec3Tuple } from './types';
import { liftTick, GEAR } from './gear';
const BIN = new THREE.Vector3(0.56, 0, -0.76); // the wastebasket: right of the desk, in frame
const BIN_TOP = 0.24;
// the paper ball's misses: clip the near rim, bounce off towards the camera, roll
const TO_CHAIR = new THREE.Vector3(LAYOUT.chair.x - BIN.x, 0, LAYOUT.chair.z - BIN.z).normalize();
const OUTWARD = new THREE.Vector3(TO_CHAIR.z, 0, -TO_CHAIR.x); // across the throw, towards the camera
const RIM = BIN.clone()
  .addScaledVector(TO_CHAIR, 0.11)
  .setY(BIN_TOP + 0.03);
const MOUTH = BIN.clone().setY(BIN_TOP + 0.08);
const LAND = BIN.clone().addScaledVector(TO_CHAIR, 0.2).addScaledVector(OUTWARD, 0.2).setY(0.045);
const HOP = LAND.clone().addScaledVector(OUTWARD, 0.1).addScaledVector(TO_CHAIR, 0.05);
const REST = HOP.clone().addScaledVector(OUTWARD, 0.09).addScaledVector(TO_CHAIR, 0.04);

type Side = 'L' | 'R';
type Span = [number, number];

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];
const QL: Vec3Tuple = [0, 0, 0];
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

function puff(
  c: TickCtx,
  kind: ParticleKind,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  n: number,
  { speed = 1, life = 0.5, size = 0.06, grow = 2.4, spread = 0.25 } = {},
) {
  for (let i = 0; i < n; i++) {
    const vel = new THREE.Vector3(
      dir.x + (Math.random() - 0.5) * spread,
      dir.y + (Math.random() - 0.5) * spread,
      dir.z + (Math.random() - 0.5) * spread,
    ).multiplyScalar(speed);
    c.emit(kind, from, { life, vel, size, grow });
  }
}

// ------------------------------------------------------------ coffee

type Trip = Record<'grab' | 'lift' | 'back' | 'drop' | 'home', Span>; // when it reaches, lifts, puts back, lets go, comes home

const GRIP = 0.04;
const MUG_MID = 0.07;

// Reach round for the mug (right arm), bring it to the face, put it back.
// T: the antic's times; near: where it's held (head space); tilt: how far it tips.
function mugTrip(c: AnticCtx, A: AnticPose, T: Trip, near: THREE.Vector3, tilt: number) {
  const { s } = c;
  const yawReach = turnTo(c, c.mugHome, 1.3);
  const yaw = track(s, 0, [
    [0, T.grab[1], yawReach],
    [...T.lift, Math.min(0.3, yawReach)],
    [...T.back, yawReach],
    [...T.home, 0],
  ]);
  A.yaw = yaw * c.w;
  // the hand takes the mug by its near side (towards the chair), a little up from its base
  const rMug = aim(c, 'R', outward(V1.copy(c.mugHome), -GRIP).setY(c.mugHome.y + MUG_MID), PR);
  const rFace = aim(c, 'R', at(c, c.robot.head, near.x, near.y, near.z, V1), QR);
  pose(PL, A.armR, s, [
    [...T.grab, PR],
    [...T.lift, QR],
    [...T.back, PR],
    [...T.home, A.armR],
  ]);
  blend(A, 'armR', PL, c.w);
  A.reachR = mix(
    1,
    track(s, 1, [
      [...T.grab, rMug],
      [...T.lift, rFace],
      [...T.back, rMug],
      [...T.home, 1],
    ]),
    c.w,
  );
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
const lookAtMug = (T: Trip, s: number) =>
  seg(s, 0, T.grab[1]) * (1 - seg(s, ...T.lift)) + seg(s, ...T.back) * (1 - seg(s, ...T.home));

// (fadeOut is short so the arm doesn't start home before the mug is let go)
const SIP: Trip = { grab: [0.1, 0.85], lift: [0.9, 1.4], back: [2.45, 2.95], drop: [2.95, 3.08], home: [3.08, 3.38] };
const SIP_EMPTY: Trip = {
  grab: [0.1, 0.85],
  lift: [0.9, 1.4],
  back: [3.0, 3.4],
  drop: [3.4, 3.52],
  home: [3.52, 3.78],
};
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
    const look = lookAtMug(SIP, s);
    HEAD[0] = mix(0.2 * look, -0.35, drink);
    HEAD[1] = 0.4 * look;
    HEAD[2] = 0;
    blend(A, 'head', HEAD, c.w);
    if (onceAt(c, 'steam', 1.6))
      puff(c, 'steam', at(c, c.robot.head, 0.05, 0.32, 0.4, V3), V1.set(0, 0.3, 0), 1, {
        speed: 1,
        life: 1.1,
        size: 0.08,
        spread: 0.05,
      });
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
    mugTrip(
      c,
      A,
      SIP_EMPTY,
      V3.lerpVectors(AT_MOUTH, PEER, peer),
      mix(0.25 * seg(s, 1.0, 1.4) * (1 - seg(s, 3.0, 3.4)), 1.15, peer) + shake,
    );
    const look = lookAtMug(SIP_EMPTY, s);
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
    for (const [arr, key, ph] of [
      [PL, 'armL', 0],
      [PR, 'armR', 2.1],
    ] as const) {
      pose(arr, A[key], s, [
        [0, 0.6, BEHIND_HEAD],
        [1.4, 1.95, A[key]],
      ]);
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
    if (onceAt(c, 'sweat', 1.9))
      c.emit('sweat', at(c, c.robot.head, 0.36, 0.5, 0.1, V1), {
        life: 0.9,
        vel: new THREE.Vector3(0.05, -0.35, 0),
        size: 0.09,
      });
  },
};

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
  for (const [x, y, z, r] of [
    [0.025, 0.19, -0.03, 0.045],
    [-0.035, 0.18, 0.02, 0.04],
  ]) {
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), paper);
    ball.position.set(x, y, z);
    ball.userData.binPaper = true; // (gone once the evening housemaid empties it: index.js)
    bin.add(ball);
  }
  bin.traverse((o) => {
    if (isMesh<PropMesh>(o)) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return bin;
}

let ballTex: THREE.CanvasTexture | null = null;
function makeBall(c: TickCtx) {
  ballTex ||= spriteTexture('ball');
  const mat = noOutline(new THREE.SpriteMaterial({ map: ballTex, transparent: true, depthWrite: false }));
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
      run.ball ||= makeBall(c);
      const ball = run.ball;
      // crumple it up in front of the chest, swivel to face the bin a bit, throw at 1.0
      const turn = turnTo(c, BIN, 0.75);
      const sd = Math.sign(turn) || 1;
      A.yaw =
        track(s, 0, [
          [0.55, 0.95, turn],
          [2.2, 2.75, 0],
        ]) * c.w;
      const squeeze = Math.sin(s * 24) * 0.03 * (1 - seg(s, 0.6, 0.8));
      aim(c, 'L', at(c, c.robot.torso, -0.06, 0.3 - squeeze, 0.34, V1), QL);
      aim(c, 'R', at(c, c.robot.torso, 0.06, 0.3 + squeeze, 0.34, V1), QR);
      pose(PL, A.armL, s, [
        [0, 0.35, QL],
        [0.8, 1.2, A.armL],
      ]);
      pose(PR, A.armR, s, [
        [0, 0.35, QR],
        [0.72, 0.95, WINDUP],
        [0.97, 1.1, THROW],
        ...((hit ? [[1.95, 2.12, PUMP]] : []) satisfies [number, number, Vec3Tuple][]),
        [2.15, 2.6, A.armR],
      ]);
      blend(A, 'armL', PL, c.w);
      blend(A, 'armR', PR, c.w);
      A.lean = mix(A.lean, A.lean + 0.15 * seg(s, 0.95, 1.1) * (1 - seg(s, 1.5, 2.1)), c.w);
      // watch it fly; then proud, or deflated
      HEAD[0] = track(s, 0, [
        [0, 0.3, 0.3],
        [0.6, 1.0, 0.1],
        [1.1, 1.8, 0.35],
        [1.9, 2.1, hit ? -0.12 : 0.42],
        [2.3, 2.75, 0],
      ]);
      HEAD[1] =
        sd *
        track(s, 0, [
          [0.6, 1.0, 0.35],
          [1.1, 1.8, 0.45],
          [1.9, 2.1, 0.25],
          [2.3, 2.75, 0],
        ]);
      HEAD[2] = track(s, 0, [
        [1.9, 2.1, hit ? -0.1 : 0.15],
        [2.3, 2.75, 0],
      ]);
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
        } else if (s < 2.2)
          arc(ball.position, RIM, LAND, (s - 1.9) / 0.3, 0.13); // off the rim...
        else if (s < 2.38)
          arc(ball.position, LAND, HOP, (s - 2.2) / 0.18, 0.04); // bounce...
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
      run.side = -(run.side || 1);
      const side = run.side;
      c.emit('note', at(c, c.robot.head, side * 0.22, (c.robot.headTop ?? 0.6) + 0.05, 0.05, V1), {
        life: 1.4,
        vel: new THREE.Vector3(side * 0.12, 0.35, 0),
        size: 0.13,
        spin: 1.5,
      });
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
    A.lean = mix(
      lean0,
      track(s, lean0, [
        [0, 0.3, lean0 - 0.08],
        [0.4, 0.75, lean0 - 0.16],
        [0.84, 0.92, lean0 + 0.38],
        [1.15, 1.8, lean0],
      ]) - hitch,
      c.w,
    );
    HEAD[0] =
      track(s, A.head[0], [
        [0, 0.3, -0.22],
        [0.4, 0.75, -0.42],
        [0.84, 0.92, 0.45],
        [1.15, 1.8, A.head[0]],
      ]) - hitch;
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.1 * seg(s, 0.2, 0.75) * (1 - seg(s, 0.84, 0.92));
    blend(A, 'head', HEAD, c.w);
    QL[0] = -0.7;
    QL[1] = 0.35;
    QL[2] = -1.4; // hands come up...
    QR[0] = -1.0;
    QR[1] = 0.75;
    QR[2] = -0.4; // ...and fling out
    for (const key of ['armL', 'armR'] as const) {
      pose(PL, A[key], s, [
        [0.2, 0.8, QL],
        [0.86, 0.95, QR],
        [1.2, 1.8, A[key]],
      ]);
      blend(A, key, PL, c.w);
    }
    A.rootY += 0.04 * bump(s, 0.88, 1.08);
    if (s >= 0.9 && s < 1.35) A.shake = 1 - (s - 0.9) / 0.45;
    if (s >= 0.9 && s < 1.4) A.lamp = Math.floor(s * 26) % 3 === 0 ? 1 : 0.1; // flicker
    A.mug.y += 0.05 * bump(s, 0.9, 1.2);
    A.mugTilt += 0.18 * Math.sin((s - 0.9) * 45) * bump(s, 0.9, 1.25);
    if (onceAt(c, 'achoo', 0.9)) {
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
    A.yaw =
      track(s, 0, [
        [0, 0.7, turn],
        [2.0, 2.45, 0],
      ]) * c.w;
    // click (1.0), click (1.3), click (1.5)... *smack* (1.9)
    const press =
      0.035 * (bump(s, 0.92, 1.06) + bump(s, 1.22, 1.36) + bump(s, 1.42, 1.56)) + 0.06 * bump(s, 1.78, 1.96);
    V1.set(LAYOUT.chair.x - c.lampHome.x, 0, LAYOUT.chair.z - c.lampHome.z)
      .setLength(0.07)
      .add(c.lampHome);
    V1.y += 0.09 - press;
    const r = aim(c, run.side, V1, QL, 2.6);
    pose(PL, A[key], s, [
      [0.2, 0.85, QL],
      [1.95, 2.4, A[key]],
    ]);
    blend(A, key, PL, c.w);
    A[sd < 0 ? 'reachL' : 'reachR'] = mix(
      1,
      track(s, 1, [
        [0.2, 0.85, r],
        [1.95, 2.4, 1],
      ]),
      c.w,
    );
    A.lamp = s < 1.0 ? 1 : s < 1.3 ? 0 : s < 1.5 ? 1 : s < 1.9 ? 0 : 1;
    HEAD[0] = track(s, A.head[0], [
      [0.1, 0.7, 0.15],
      [2.0, 2.45, A.head[0]],
    ]);
    HEAD[1] = track(s, A.head[1], [
      [0.1, 0.7, 0.5 * sd],
      [2.0, 2.45, A.head[1]],
    ]);
    HEAD[2] = A.head[2] + 0.12 * bump(s, 1.6, 1.95) * sd; // "hm?"
    blend(A, 'head', HEAD, c.w);
  },
};

const drum: Antic = {
  dur: 2.6,
  update(c, A) {
    const { s } = c;
    // still facing you: hunched over, drumming its fingers on its knees, fast
    for (const [side, key, out, ph] of [
      ['L', 'armL', QL, 0],
      ['R', 'armR', QR, Math.PI],
    ] as const) {
      const sx = side === 'L' ? -0.13 : 0.13;
      at(c, c.robot.root, sx, 0.17 + 0.06 * Math.max(0, Math.sin(s * 30 + ph)), 0.3, V1);
      aim(c, side, V1, out);
      pose(PL, A[key], s, [
        [0.35, 0.6, out],
        [1.9, 2.2, A[key]],
      ]);
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
    for (const [key, ph] of [
      ['armL', 0],
      ['armR', 0.6],
    ] as const) {
      PL[0] = -lean + 0.05 + Math.sin(s * 3.2 + ph) * swing;
      PL[1] = 0.32; // clear of the seat
      PL[2] = -0.2;
      for (let i = 0; i < 3; i++) PR[i] = mix(A[key][i], PL[i], down);
      PR[1] += 0.06 * up; // shoulders up with the breath
      blend(A, key, PR, c.w);
    }
    if (onceAt(c, 'sigh', 0.7)) {
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
      if (lucky && onceAt(c, 'stars', 6.0)) {
        const top = at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.05, 0, V1);
        for (let i = 0; i < 5; i++) {
          const a = Math.PI * (0.15 + (i / 4) * 0.7);
          c.emit('star', top, {
            life: 1.0,
            vel: new THREE.Vector3(Math.cos(a) * 0.6, Math.sin(a) * 0.55, 0),
            size: 0.12,
            gravity: 0.8,
            spin: 5,
          });
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

export const AWAKE: Record<string, Antic> = {
  ...GEAR,
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
