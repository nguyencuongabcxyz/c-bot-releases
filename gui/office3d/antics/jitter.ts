// Coffee-driven development: three coffees chugged in a row, then typing at warp speed, buzzing.
import * as THREE from 'three';
import type { AnticCtx, AnticPose, Antic } from './types';
import { turnTo, track, aim, outward, at, pose, blend, handAt, onceAt } from './common';
import { mix, seg, bump } from '@/office3d/core/math';
import { canvasTexture, noOutline } from '@/office3d/materials';
import { type HeadBox, headBox, towardScreen, scaleOf, dispose } from './team-common';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const PL = [0, 0, 0];
const PR = [0, 0, 0];
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const Q1 = new THREE.Quaternion();

// ------------------------------------------------------------ coffee-driven development

// Three quick chugs from the mug (gulps at 0.8, 1.5, 2.2), then the caffeine
// hits: buzzing all over (2.4–6.2), and it swivels partway round, pulls the keyboard
// onto its lap and types at warp speed (3.4–6.0) on the editor, sweating, keys smoking.
const GRIP = 0.04;
const MUG_MID = 0.07;
type Chug = Record<'grab' | 'lift' | 'back' | 'drop' | 'home', [number, number]>;
const CHUG: Chug = { grab: [0.0, 0.42], lift: [0.42, 0.62], back: [2.3, 2.55], drop: [2.55, 2.65], home: [2.65, 2.95] };
const GULPS = [0.8, 1.5, 2.2];
const AT_MOUTH = new THREE.Vector3(0, 0.13, 0.33);
const BELOW = new THREE.Vector3(0, -0.02, 0.4);
// awake.js's mug trip: reach round for the mug (right arm), to the face, put it back
function mugTrip(c: AnticCtx, A: AnticPose, T: Chug, near: THREE.Vector3, tilt: number) {
  const { s } = c;
  const yawReach = turnTo(c, c.mugHome, 1.3);
  const yaw = track(s, 0, [
    [0, T.grab[1], yawReach],
    [...T.lift, Math.min(0.3, yawReach)],
    [...T.back, yawReach],
    [...T.home, 0],
  ]);
  A.yaw = yaw * c.w;
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
  A.lean += 0.08 * (seg(s, ...T.grab) - seg(s, ...T.lift) + seg(s, ...T.back) - seg(s, ...T.home)) * c.w;
  const toFace = Math.sin(c.curYaw + yaw) >= 0 ? 1 : -1;
  const hold = seg(s, T.grab[1] - 0.05, T.grab[1] + 0.1) * (1 - seg(s, ...T.drop)) * c.w;
  if (hold > 0) {
    const th = tilt * toFace;
    outward(handAt(c, 'R', V2), GRIP);
    V2.x += MUG_MID * Math.sin(th);
    V2.y -= MUG_MID * Math.cos(th);
    A.mug.copy(V2).sub(c.mugHome).multiplyScalar(hold);
    A.mugTilt = th * hold;
  }
}

// cartoon motion marks: ((  )) either side of whatever's buzzing
function buildBuzz() {
  const { tex } = canvasTexture(256, 128, (ctx, w, h) => {
    ctx.strokeStyle = '#1d2235';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (const sd of [-1, 1]) {
      for (const [r, a] of [
        [60, 0.5],
        [86, 0.42],
      ]) {
        ctx.beginPath();
        ctx.arc(w / 2 + sd * (r - 116), h / 2, r, sd > 0 ? -a : Math.PI - a, sd > 0 ? a : Math.PI + a);
        ctx.stroke();
      }
    }
  });
  const mat = noOutline(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  return new THREE.Sprite(mat);
}

// (buzz, keys and hb are made together, on the first frame)
type Keyboard = { k: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; sc: number };
type JitterRun = {
  buzz: THREE.Sprite;
  keys: THREE.Sprite;
  hb: HeadBox;
  kb?: Keyboard;
  sweat?: number;
  sd?: number;
  smoke?: number;
};

const jitter: Antic<JitterRun> = {
  dur: 6.5,
  fadeOut: 0.3,
  update(c, A) {
    const { s, run } = c;
    if (!run.buzz) {
      run.hb = headBox(c);
      run.buzz = buildBuzz();
      run.keys = buildBuzz();
      c.set.office.add(run.buzz, run.keys);
    }
    const { hb } = run;
    // the chugs: up to the mouth, a gulp (head back, mug tipped up), down a little, again
    let drink = 0;
    for (const g of GULPS) drink = Math.max(drink, seg(s, g - 0.16, g) * (1 - seg(s, g + 0.08, g + 0.26)));
    V3.lerpVectors(BELOW, AT_MOUTH, drink);
    mugTrip(c, A, CHUG, V3, mix(0.3 * seg(s, 0.4, 0.62) * (1 - seg(s, 2.3, 2.55)), 1.2, drink));
    const look = seg(s, 0, 0.42) * (1 - seg(s, ...CHUG.lift)) + seg(s, ...CHUG.back) * (1 - seg(s, ...CHUG.home));

    // wired: swivels partway to the screen, yanks the keyboard onto its lap and types
    // like mad, eyes on the screen over its shoulder
    const buzz = seg(s, 2.35, 2.5) * (1 - seg(s, 6.2, 6.45));
    const type = seg(s, 3.0, 3.4) * (1 - seg(s, 6.0, 6.3));
    const lap = seg(s, 3.0, 3.35) * (1 - seg(s, 6.0, 6.35));
    if (s >= 3.2) A.screen = 'edit';
    const [body, peek] = towardScreen(c, 0.7, 0.55);
    A.yaw += body * type * c.w;
    run.kb ||= {
      k: c.set.keyboard,
      p: c.set.keyboard.position.clone(),
      q: c.set.keyboard.quaternion.clone(),
      sc: c.set.keyboard.scale.x,
    };
    const kb = run.kb;
    at(c, c.robot.root, 0, 0.26, 0.34, V1);
    kb.k.parent?.worldToLocal(c.set.office.localToWorld(V1)); // (the desk top)
    kb.k.position.lerpVectors(kb.p, V1, lap);
    kb.k.position.y += 0.25 * bump(lap, 0, 1);
    c.robot.root.getWorldQuaternion(Q1);
    kb.k.quaternion.slerpQuaternions(kb.q, Q1, lap);
    kb.k.scale.setScalar(mix(kb.sc, 0.75 * scaleOf(c), lap));
    for (const [side, key, out, sd, ph] of [
      ['L', 'armL', QL, -1, 0],
      ['R', 'armR', QR, 1, Math.PI],
    ] as const) {
      at(
        c,
        kb.k,
        sd * (0.12 + 0.05 * Math.sin(s * 19 + ph)),
        0.05 + 0.07 * Math.max(0, Math.sin(s * 44 + ph)),
        0.02,
        V1,
      );
      const r = aim(c, side, V1, out, 1.6);
      blend(A, key, out, type * c.w);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, type * c.w);
    }
    const v = Math.sin(s * 61);
    A.lean = mix(A.lean, A.lean + 0.12 * type + 0.03 * v * buzz, c.w);
    A.rootY += Math.abs(Math.sin(s * 47)) * 0.014 * buzz * c.w;
    A.antenna += Math.sin(s * 40) * 0.6 * buzz * c.w;
    A.shake = Math.max(A.shake, 0.12 * type);
    HEAD[0] = mix(0.2 * look, -0.42, drink) + 0.05 * type + Math.sin(s * 57) * 0.04 * buzz;
    HEAD[1] = peek * type + Math.sin(s * 53) * 0.07 * buzz;
    HEAD[2] = Math.sin(s * 67) * 0.06 * buzz;
    blend(A, 'head', HEAD, c.w);

    // the motion marks: round its head while it buzzes, over its hands while it types
    const { buzz: bz, keys } = run;
    bz.visible = buzz > 0.5 && Math.sin(s * 30) > -0.6;
    at(c, c.robot.head, 0, hb.cy, 0, bz.position);
    bz.scale.set((hb.hw * 2 + 0.3) * scaleOf(c) * 1.1, (hb.hw + 0.15) * scaleOf(c) * 1.1, 1);
    bz.material.rotation = Math.sin(s * 37) * 0.06;
    keys.visible = type > 0.5 && Math.sin(s * 25) > -0.5;
    handAt(c, 'L', V1);
    handAt(c, 'R', V2);
    keys.position.lerpVectors(V1, V2, 0.5);
    keys.position.y += 0.06;
    keys.scale.set(0.75 * scaleOf(c), 0.32 * scaleOf(c), 1);
    keys.material.rotation = Math.sin(s * 31) * 0.1;

    for (const g of GULPS) {
      if (onceAt(c, `gulp${g}`, g))
        c.emit('steam', at(c, c.robot.head, 0.05, 0.32, 0.42, V1), {
          life: 0.7,
          vel: new THREE.Vector3(0, 0.35, 0),
          size: 0.07,
          grow: 2,
        });
    }
    if (onceAt(c, 'zap', 2.4)) {
      for (const sd of [-1, 1])
        c.emit('bolt', at(c, c.robot.head, sd * (hb.hw + 0.1), hb.top * 0.8, 0, V1), {
          life: 0.8,
          vel: new THREE.Vector3(sd * 0.3, 0.3, 0),
          size: 0.14,
          spin: 3,
        });
    }
    // sweat flying off, and the keyboard smoking
    if (type > 0.5 && s >= (run.sweat ?? 3.6)) {
      run.sweat = s + 0.38;
      run.sd = -(run.sd || 1);
      const sd = run.sd;
      c.emit('sweat', at(c, c.robot.head, sd * hb.hw * 0.8, hb.top * 0.75, 0.1, V1), {
        life: 0.7,
        vel: new THREE.Vector3(sd * 0.35, 0.25, 0),
        size: 0.08,
        gravity: 1.2,
      });
    }
    if (type > 0.5 && s >= (run.smoke ?? 4.2)) {
      run.smoke = s + 0.45;
      c.emit('steam', at(c, run.kb.k, (Math.random() - 0.5) * 0.3, 0.04, 0, V3), {
        life: 0.9,
        vel: new THREE.Vector3(0, 0.3, 0),
        size: 0.08,
        grow: 2.6,
      });
    }
  },
  end(c) {
    dispose(c.run?.buzz);
    dispose(c.run?.keys);
    const kb = c.run?.kb;
    if (!kb) return;
    kb.k.position.copy(kb.p);
    kb.k.quaternion.copy(kb.q);
    kb.k.scale.setScalar(kb.sc);
  },
};

export const JITTER: Record<string, Antic> = { jitter };
