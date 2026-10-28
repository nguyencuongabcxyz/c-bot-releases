// Awake antics with something it fetches or works: a boba milk tea, a dumbbell, the standing desk
// (its height motors on in liftTick, every frame, whatever plays).
import type { Vec3Tuple, Antic, TickCtx } from './types';
import * as THREE from 'three';
import { toon } from '@/office3d/materials';
import { at, aim, blend, handAt, type PropMesh, onceAt, turnTo, track } from './common';
import { seg, mix, easeOutQuad, bump, wrap, clamp } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';

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

// ------------------------------------------------------------ milk tea

// A bubble tea pops into its hand (0.35); it lifts the straw to its mouth and
// sips, tapioca pearls riding up the straw while the tea goes down (1.2–3.6);
// then 😋, and the cup pops away again. robot.js plays: pop 0.35, slurps 1.3 / 2.3.
const MOUTHS: Record<string, Vec3Tuple> = {
  robot: [0, 0.2, 0.3],
  cat: [0, 0.2, 0.42],
  loopy: [0, 0.2, 0.4],
  nerd: [0, 0.2, 0.38],
  girl: [0, 0.2, 0.37],
};
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
    p.position.set(
      Math.cos(a) * 0.026 * (i % 3 ? 1 : 0.4),
      -CUP_H * 0.43 + (i % 3) * 0.012,
      Math.sin(a) * 0.026 * (i % 3 ? 1 : 0.4),
    );
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
  straw.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, STRAW, 10), toon('#ff5fa8')).translateY(STRAW / 2 - 0.04),
  );
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
    const size =
      s < 0.35
        ? 0
        : s < 0.55
          ? easeOutQuad((s - 0.35) / 0.2) * 1.15
          : s < 0.7
            ? 1.15 - 0.15 * ((s - 0.55) / 0.15)
            : s < 4.6
              ? 1
              : Math.max(0, 1 - (s - 4.6) / 0.25);
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
      if (!isMesh<PropMesh>(o)) return;
      o.geometry.dispose();
      o.material.dispose();
    });
  },
};

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
    for (const [x, r] of [
      [0.065, 0.045],
      [0.088, 0.034],
    ]) {
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
  g.traverse((o) => {
    if (isMesh<PropMesh>(o)) o.castShadow = true;
  });
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
    const size =
      s < 0.15
        ? 0
        : s < 0.35
          ? easeOutQuad((s - 0.15) / 0.2) * 1.15
          : s < 0.5
            ? 1.15 - 0.15 * ((s - 0.35) / 0.15)
            : s < 5.5
              ? 1
              : Math.max(0, 1 - (s - 5.5) / 0.25);
    bell.scale.setScalar(Math.max(0.001, size * DUMBBELL_SIZE * (c.robot.root.scale.x / 0.82)));
    bell.visible = size > 0.01;

    if (onceAt(c, 'sweat', 2.55))
      c.emit('sweat', at(c, c.robot.head, 0.3, 0.5, 0.1, V2), {
        life: 0.9,
        vel: new THREE.Vector3(0.1, -0.35, 0),
        size: 0.08,
      });
    if (onceAt(c, 'sparkle', 4.0)) {
      for (const side of ['L', 'R'] as const) {
        handAt(c, side, V2);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI + 0.4;
          c.emit('star', V2, {
            life: 0.8,
            vel: new THREE.Vector3(Math.cos(a) * 0.35, Math.sin(a) * 0.4 + 0.15, 0.1),
            size: 0.08,
            spin: 4,
          });
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
      if (!isMesh<PropMesh>(o)) return;
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
    A.yaw =
      track(s, 0, [
        [0, 0.8, run.panel],
        [2.3, 3.2, run.screen],
        [15.0, 15.8, run.panel],
        [19.4, 20.5, 0],
      ]) * c.w;

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
    for (const [key, sideTap] of [
      ['armL', tap],
      ['armR', -tap],
    ] as const) {
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
export function liftTick(c: TickCtx) {
  const { set } = c;
  if (!set?.desk?.top) return;
  set.office.userData.lift ||= { desk: 0, seat: 0, deskTo: 0, seatTo: 0, pressed: '', drawn: '' };
  const L: Lift = set.office.userData.lift;
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

export const GEAR: Record<string, Antic> = {
  standdesk: standDesk,
  milktea,
  dumbbell,
};
