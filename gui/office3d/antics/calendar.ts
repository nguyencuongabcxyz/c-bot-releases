import { bump, mix, seg } from '@/office3d/core/math';
import { isMesh, mesh } from '@/office3d/core/mesh';
import { aim, armOf, at, blend, handAt, onceAt } from './common';
import * as THREE from 'three';
import { toon, canvasTexture, roundRect, noOutline } from '@/office3d/materials';
import type { Antic, Vec3Tuple } from './types';
import { type Mat, disposeTree, propScale, popScale, grip, sigh, mouthOf } from './calendar-common';
import { PAYDAY } from './payday';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const PL: Vec3Tuple = [0, 0, 0];
const PR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

// ------------------------------------------------------------ friday

// It holds up a protest sign with both hands (0.4–4.0), shaking its head "no"
// (1.0–3.5). robot.js: speech at 0.5.
const SIGN_W = 1.0;
const SIGN_H = 0.58;
const SIGN_Z = 0.44; // in front of the chest (torso space)

function buildSign() {
  const face = canvasTexture(512, 300, (ctx, w, h) => {
    ctx.fillStyle = '#f6e7c8';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c9a36b';
    ctx.lineWidth = 16;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // marker lettering, as big as fits
    ctx.font = '900 100px "Segoe UI", sans-serif';
    const k = Math.min(1, 470 / ctx.measureText('NO DEPLOYS').width);
    ctx.font = `900 ${Math.floor(100 * k)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#d62f3a';
    ctx.fillText('NO DEPLOYS', (w - ctx.measureText('NO DEPLOYS').width) / 2, 88);
    ctx.font = `900 ${Math.floor(84 * k)}px "Segoe UI", sans-serif`;
    const a = ctx.measureText('ON FRIDAY').width;
    const x = (w - a - 128) / 2;
    ctx.fillStyle = '#1d2235';
    ctx.fillText('ON FRIDAY', x, 206);
    ctx.fillStyle = '#d62f3a';
    ctx.fillRect(x, 252, a, 9); // underlined, for emphasis
    ctx.font = '112px "Segoe UI Emoji", sans-serif';
    ctx.fillText('🙅', x + a + 12, 200);
  });
  const card = toon('#e8cf9f');
  const board = new THREE.Mesh(new THREE.BoxGeometry(SIGN_W, SIGN_H, 0.02), [
    card,
    card,
    card,
    card,
    toon('#ffffff', { map: face.tex }),
    card,
  ]);
  board.castShadow = true;
  const sign = new THREE.Group();
  sign.add(board);
  return sign;
}

const friday: Antic<{ sign?: THREE.Group }> = {
  dur: 4.5,
  update(c, A) {
    const { s, run } = c;
    const { torso, head } = c.robot;
    if (!run.sign) {
      run.sign = buildSign();
      c.set.office.add(run.sign);
    }
    const sign = run.sign;
    // brought up in front of the chest, its top edge just under the chin; a
    // jab up and down now and then for emphasis
    const up = seg(s, 0.3, 0.7) * (1 - seg(s, 3.9, 4.3));
    const jab = 0.035 * (bump(s, 0.9, 1.2) + bump(s, 2.0, 2.3) + bump(s, 3.1, 3.4));
    const cy = head.position.y - 0.05 - SIGN_H / 2 - 0.2 * (1 - up) + jab;
    at(c, torso, 0, cy, SIGN_Z, sign.position);
    torso.getWorldQuaternion(sign.quaternion);
    sign.scale.setScalar(Math.max(0.001, popScale(s, 0.4, 4.0) * c.robot.root.scale.x));
    sign.visible = s >= 0.4;
    // a hand on each side of it
    const hx = SIGN_W / 2 + 0.01;
    grip(
      c,
      A,
      at(c, torso, -hx, cy - 0.04, SIGN_Z + 0.02, V1),
      at(c, torso, hx, cy - 0.04, SIGN_Z + 0.02, V2),
      seg(s, 0.15, 0.5) * (1 - seg(s, 3.95, 4.35)) * c.w,
    );
    A.lean = mix(A.lean, 0.04, c.w);
    // no. no. no.
    const no = seg(s, 1.0, 1.15) * (1 - seg(s, 3.3, 3.5));
    HEAD[0] = 0.04;
    HEAD[1] = Math.sin((s - 1.0) * Math.PI * 2 * 1.7) * 0.42 * no;
    HEAD[2] = 0;
    blend(A, 'head', HEAD, c.w);
  },
  end(c) {
    if (c.run?.sign) disposeTree(c.run.sign);
  },
};

// ------------------------------------------------------------ monday

// A drip stand rolls up beside the chair (0.3) with a bag of coffee, its tube
// taped to the robot's arm; it slumps, grumpy, while coffee drips down the tube
// (0.8–5.2) — then a little jolt as it kicks in. robot.js: speech at 1.0.
const POLE_H = 1.55;
const TUBE_N = 14;
const BEADS = 4;

function buildDrip() {
  const g = new THREE.Group();
  const steel = toon('#c3c8d4');
  const dark = toon('#3a3f52');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.03, 0.02, 0.2), steel, Math.sin(a) * 0.1, 0.05, Math.cos(a) * 0.1);
    leg.rotation.y = a;
    g.add(leg);
    g.add(mesh(new THREE.SphereGeometry(0.022, 10, 8), dark, Math.sin(a) * 0.2, 0.025, Math.cos(a) * 0.2));
  }
  g.add(mesh(new THREE.CylinderGeometry(0.013, 0.016, POLE_H, 10), steel, 0, POLE_H / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(0.26, 0.014, 0.014), steel, 0.07, POLE_H, 0));
  // the bag hangs off the end towards the chair (+x)
  const bag = new THREE.Group(); // (turned to face you, in update)
  bag.position.set(0.17, POLE_H - 0.2, 0);
  bag.scale.setScalar(1.35);
  g.add(bag);
  bag.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 6), steel, 0, 0.16, 0));
  const pouch = mesh(new THREE.SphereGeometry(1, 20, 14), toon('#7a4a2a'));
  pouch.scale.set(0.085, 0.13, 0.035);
  bag.add(pouch);
  const label = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#fffaf0';
    roundRect(ctx, 6, 6, 116, 116, 22);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '62px "Segoe UI Emoji", sans-serif';
    ctx.fillText('☕', 64, 52);
    ctx.fillStyle = '#5a3416';
    ctx.font = '900 22px "Segoe UI", sans-serif';
    ctx.fillText('COFFEE', 64, 102);
  });
  const tag = mesh(
    new THREE.PlaneGeometry(0.1, 0.1),
    toon('#ffffff', { map: label.tex, transparent: true }),
    0,
    0.005,
    0.036,
  );
  noOutline(tag.material);
  bag.add(tag);
  bag.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 8), steel, 0, -0.14, 0));
  // the drip chamber: a drop falls through it every half second
  const clear = toon('#e8f4ff', { transparent: true, opacity: 0.45 });
  clear.userData.outlineParameters = { thickness: 0.002 };
  bag.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.07, 12), clear, 0, -0.19, 0));
  const coffee = toon('#4a2a14');
  const drop = mesh(new THREE.SphereGeometry(0.009, 8, 6), coffee, 0, -0.17, 0);
  bag.add(drop);
  const outlet = new THREE.Object3D(); // where the tube leaves the chamber
  outlet.position.set(0, -0.225, 0);
  bag.add(outlet);
  g.traverse((o) => {
    if (isMesh<THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>>(o)) o.castShadow = true;
  });
  // the tube (office space): short segments, clear until the coffee reaches them
  const tube = new THREE.Group();
  const segGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
  const tubeMat = toon('#dfeaf5');
  const fullMat = toon('#6b3d1e');
  const segs: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshToonMaterial>[] = [];
  for (let i = 0; i < TUBE_N; i++) {
    const m = new THREE.Mesh(segGeo, tubeMat);
    tube.add(m);
    segs.push(m);
  }
  const beads: THREE.Mesh<THREE.SphereGeometry, THREE.MeshToonMaterial>[] = [];
  for (let i = 0; i < BEADS; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), coffee);
    tube.add(b);
    beads.push(b);
  }
  // white tape where it goes into the arm
  const tape = mesh(new THREE.BoxGeometry(0.07, 0.045, 0.012), toon('#ffffff'));
  tube.add(tape);
  return { g, bag, drop, outlet, tube, segs, beads, tape, tubeMat, fullMat, geos: [segGeo] };
}
// a point on the tube's sagging curve (quadratic Bézier p0 -> p1 -> p2)
function bez(out: THREE.Vector3, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, u: number) {
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const d = u * u;
  return out.set(a * p0.x + b * p1.x + d * p2.x, a * p0.y + b * p1.y + d * p2.y, a * p0.z + b * p1.z + d * p2.z);
}
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();

const monday: Antic<{ drip?: ReturnType<typeof buildDrip> }> = {
  dur: 6.0,
  update(c, A) {
    const { s, run } = c;
    const k = propScale(c);
    if (!run.drip) {
      run.drip = buildDrip();
      // it stands beside the chair on the robot's left (your right), angled so the label faces you
      at(c, c.robot.root, -0.78, 0, 0.22, run.drip.g.position).setY(0);
      run.drip.g.rotation.y = Math.atan2(
        -(c.robot.root.getWorldPosition(V1).z - run.drip.g.position.z),
        V1.x - run.drip.g.position.x,
      );
      run.drip.bag.rotation.y = c.camYaw - run.drip.g.rotation.y;
      c.set.office.add(run.drip.g, run.drip.tube);
    }
    const D = run.drip;
    const size = popScale(s, 0.3, 5.5);
    D.g.scale.setScalar(Math.max(0.001, size * k));
    D.g.visible = size > 0;
    // the tube, from the drip chamber to the left forearm, sagging between
    D.tube.visible = s > 0.5 && s < 5.5;
    if (D.tube.visible) {
      D.g.updateMatrixWorld(true);
      c.set.office.worldToLocal(D.outlet.getWorldPosition(P0));
      at(c, armOf(c, 'L').elbow, 0, -0.1, 0.06 * k, P2);
      P1.lerpVectors(P0, P2, 0.5);
      P1.y = Math.min(P0.y, P2.y) - 0.18;
      const fill = seg(s, 0.8, 1.7); // how far down the coffee has got
      for (let i = 0; i < TUBE_N; i++) {
        const m = D.segs[i];
        bez(V1, P0, P1, P2, i / TUBE_N);
        bez(V2, P0, P1, P2, (i + 1) / TUBE_N);
        m.position.lerpVectors(V1, V2, 0.5);
        V3.subVectors(V2, V1);
        m.scale.set(k, V3.length() + 0.004, k);
        m.quaternion.setFromUnitVectors(UP, V3.normalize());
        m.material = (i + 0.5) / TUBE_N < fill ? D.fullMat : D.tubeMat;
      }
      // drops of coffee sliding down it
      for (let i = 0; i < BEADS; i++) {
        const u = ((s - 0.8) * 0.55 + i / BEADS) % 1;
        const b = D.beads[i];
        b.visible = s > 0.8 && s < 5.2 && u < fill;
        bez(b.position, P0, P1, P2, u);
        b.scale.setScalar(k);
      }
      at(c, armOf(c, 'L').elbow, 0, -0.1, 0.075 * k, D.tape.position);
      armOf(c, 'L').elbow.getWorldQuaternion(D.tape.quaternion);
      D.tape.scale.setScalar(k);
    }
    // a drop through the chamber every half second
    const ph = ((s - 0.8) / 0.5) % 1;
    D.drop.visible = s > 0.8 && s < 5.2;
    D.drop.position.y = -0.165 - 0.045 * ph * ph;
    D.drop.scale.setScalar(ph < 0.15 ? ph / 0.15 : 1);

    // grumpy slump: folded forward, cheek on a fist, the drip arm limp on its knee
    const slump = seg(s, 0.2, 1.0);
    const jolt = seg(s, 5.15, 5.3) * (1 - seg(s, 5.6, 5.9)); // ...and there it is
    const w = slump * c.w;
    // (not too far over: the face has to stay in view)
    A.lean = mix(A.lean, mix(0.14, 0.02, jolt), w);
    A.rootY -= 0.03 * w;
    A.rootZ += 0.05 * w;
    HEAD[0] = mix(0.1 + 0.03 * Math.sin(s * 1.3), -0.12, jolt);
    HEAD[1] = -0.08 * (1 - jolt);
    HEAD[2] = 0.24 * (1 - jolt) + 0.06 * Math.sin(s * 40) * jolt;
    blend(A, 'head', HEAD, w);
    const rl = aim(c, 'L', at(c, c.robot.root, -0.14, 0.2, 0.32, V1), PL);
    blend(A, 'armL', PL, w);
    A.reachL = mix(A.reachL, rl, w);
    const m = mouthOf(c);
    const rr = aim(c, 'R', at(c, c.robot.head, 0.13, m[1] - 0.06, m[2] - 0.02, V1), PR, 2.2);
    blend(A, 'armR', PR, w * (1 - jolt));
    A.reachR = mix(A.reachR, rr, w * (1 - jolt));
    A.antenna = Math.sin(s * 38) * 0.5 * jolt * c.w;
    if (onceAt(c, 'sigh', 1.4)) sigh(c);
    if (onceAt(c, 'sigh2', 3.6)) sigh(c);
    if (onceAt(c, 'zap', 5.2)) {
      const top = at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.05, 0, V1);
      for (let i = 0; i < 3; i++) {
        const a = Math.PI * (0.25 + i * 0.25);
        c.emit('bolt', top, {
          life: 0.6,
          vel: new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0),
          size: 0.1,
          spin: 3,
        });
      }
    }
  },
  end(c) {
    const D = c.run?.drip;
    if (!D) return;
    disposeTree(D.g);
    D.tube.removeFromParent();
    for (const b of D.beads) b.geometry.dispose();
    D.tape.geometry.dispose();
    D.tape.material.dispose();
    for (const g of D.geos) g.dispose();
    D.tubeMat.dispose();
    D.fullMat.dispose();
  },
};

// ------------------------------------------------------------ noodles

// Cup noodles at the desk: the cup pops into its left hand (0.3); chopsticks
// lift noodles to its mouth and they're slurped up (1.5, 2.7, 3.9), steam
// rising all the while; 😋, and the cup pops away (6.3). robot.js: pop 0.3,
// slurps 1.5 / 2.7 / 3.9.
const SLURPS = [1.5, 2.7, 3.9];
const CUP_H = 0.13;
const CHOP_L = 0.24;
const NOODLE_SIZE = 1.25;

function buildNoodles() {
  const cup = new THREE.Group();
  const label = canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(0, 14, w, 34);
    ctx.fillStyle = '#ffd34d';
    ctx.font = '900 26px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RAMEN', w / 4, 32);
    ctx.fillText('RAMEN', (3 * w) / 4, 32);
  });
  cup.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.052, CUP_H, 24, 1, true),
      toon('#ffffff', { map: label.tex, side: THREE.DoubleSide }),
    ),
  );
  cup.add(mesh(new THREE.CircleGeometry(0.052, 20), toon('#ffffff'), 0, -CUP_H / 2, 0).rotateX(Math.PI / 2));
  const broth = mesh(new THREE.CircleGeometry(0.067, 24), toon('#e8b45a'), 0, CUP_H / 2 - 0.012, 0);
  broth.rotation.x = -Math.PI / 2;
  cup.add(broth);
  const noodle = toon('#f6d77a');
  for (const [x, z, r] of [
    [-0.025, 0.012, 0.02],
    [0.015, -0.02, 0.022],
    [0.02, 0.022, 0.016],
    [-0.01, -0.03, 0.015],
  ]) {
    const loop = mesh(new THREE.TorusGeometry(r, 0.006, 6, 16), noodle, x, CUP_H / 2 - 0.008, z);
    loop.rotation.x = Math.PI / 2;
    cup.add(loop);
  }
  // a slice of fishcake and some spring onion
  cup.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 16), toon('#ffffff'), 0.03, CUP_H / 2 - 0.004, 0.01));
  const swirl = mesh(new THREE.TorusGeometry(0.008, 0.0025, 4, 12), toon('#ff6fa0'), 0.03, CUP_H / 2 - 0.0005, 0.01);
  swirl.rotation.x = Math.PI / 2;
  cup.add(swirl);
  for (const [x, z] of [
    [-0.035, -0.01],
    [-0.02, 0.035],
    [0.005, 0.04],
  ])
    cup.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 8), toon('#58c06a'), x, CUP_H / 2 - 0.006, z));
  // the lid, peeled back (it's at the back: the cup turns its front to you)
  const lid = new THREE.Group();
  lid.position.set(0, CUP_H / 2, -0.068);
  lid.rotation.x = -1.95;
  lid.add(mesh(new THREE.CylinderGeometry(0.071, 0.071, 0.004, 24), toon('#d9dde6'), 0, 0, 0.068));
  cup.add(lid);
  // chopsticks: their own group, from the hand (origin) along +y to the tips
  const chop = new THREE.Group();
  const wood = toon('#d8a35d');
  for (const x of [-0.009, 0.009]) {
    const stick = mesh(new THREE.CylinderGeometry(0.0035, 0.006, CHOP_L, 8), wood, x, CHOP_L / 2 - 0.05, 0);
    stick.rotation.z = -x * 2; // they meet at the tips
    chop.add(stick);
  }
  // noodle strands, hanging from the tips: one unit long down -y, stretched to fit
  const strands: THREE.Group[] = [];
  for (let i = 0; i < 3; i++) {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 10; j++)
      pts.push(new THREE.Vector3(Math.sin(j * 1.9 + i * 2) * 0.012, -j / 10, Math.cos(j * 1.4 + i) * 0.008));
    const strand = new THREE.Group();
    strand.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0055, 5), noodle));
    strands.push(strand);
  }
  for (const g of [cup, chop])
    g.traverse((o) => {
      if (isMesh<THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>>(o)) o.castShadow = true;
    });
  return { cup, chop, strands };
}

const noodles: Antic<{ n?: ReturnType<typeof buildNoodles>; steam?: number }> = {
  dur: 7.0,
  fadeOut: 0.5,
  update(c, A) {
    const { s, run } = c;
    const { torso, head } = c.robot;
    if (!run.n) {
      run.n = buildNoodles();
      c.set.office.add(run.n.cup, run.n.chop, ...run.n.strands);
    }
    const { cup, chop, strands } = run.n;
    const k = propScale(c) * NOODLE_SIZE;
    const size = popScale(s, 0.3, 6.3) * k;
    const hold = seg(s, 0.05, 0.4) * (1 - seg(s, 6.2, 6.8)) * c.w;
    // the cup sits on its left hand, in front of its chest
    const hy = head.position.y;
    const rl = aim(c, 'L', at(c, torso, -0.03, hy - 0.36, 0.36, V1), PL);
    blend(A, 'armL', PL, hold);
    A.reachL = mix(A.reachL, rl, hold);
    handAt(c, 'L', cup.position);
    cup.position.y += 0.05 * k + (CUP_H / 2) * size;
    cup.rotation.y = c.camYaw;
    cup.scale.setScalar(Math.max(0.001, size));
    cup.visible = chop.visible = size > 0;

    // each slurp: dip in (T-0.95), lift to the mouth (T-0.75..T-0.2), slurp (T), back down
    let lift = 0;
    let suck = 1;
    let dip = 0;
    for (const T of SLURPS) {
      lift = Math.max(lift, seg(s, T - 0.75, T - 0.2) * (1 - seg(s, T + 0.3, T + 0.6)));
      dip = Math.max(dip, bump(s, T - 1.05, T - 0.7));
      if (s > T - 0.8 && s < T + 0.35) suck = seg(s, T, T + 0.25);
    }
    const m = mouthOf(c);
    V1.copy(cup.position).y += (CUP_H / 2) * size - 0.01 * k - 0.03 * dip * k; // in the broth
    at(c, head, m[0] + 0.01, m[1] + 0.01, m[2] + 0.03, V2); // at the lips
    const tip = V3.lerpVectors(V1, V2, lift);
    // the hand rides up and to the right of the tips (torso space -> office)
    at(c, torso, mix(0.12, 0.14, lift), mix(0.14, -0.04, lift), mix(-0.06, 0.12, lift), V4).sub(
      at(c, torso, 0, 0, 0, V1),
    );
    const rr = aim(c, 'R', V4.add(tip), PR, 2.2);
    blend(A, 'armR', PR, hold);
    A.reachR = mix(A.reachR, rr, hold);
    // chopsticks from the hand to the tips
    handAt(c, 'R', chop.position);
    V4.subVectors(tip, chop.position);
    chop.quaternion.setFromUnitVectors(UP, V4.normalize());
    chop.scale.setScalar(Math.max(0.001, size));
    // the strands: from the tips down into the cup, sucked up from the bottom
    V1.copy(chop.position).addScaledVector(V4, (CHOP_L - 0.05) * size); // the tips, as drawn
    V2.copy(cup.position).y += (CUP_H / 2) * size - 0.01 * k;
    V2.lerp(V1, suck);
    V3.subVectors(V2, V1);
    const len = V3.length();
    strands.forEach((st, i) => {
      st.visible = cup.visible && suck < 0.97 && lift > 0.02;
      st.position.copy(V1);
      st.position.x += (i - 1) * 0.006 * k;
      st.quaternion.setFromUnitVectors(DOWN, V3.normalize());
      st.scale.set(k, Math.max(0.001, len), k);
    });

    // eyes on the noodles, chin up for the slurp, chewing after; then content
    let chew = 0;
    for (const T of SLURPS) chew += bump(s, T + 0.25, T + 0.95);
    const happy = seg(s, 4.5, 4.8) * (1 - seg(s, 5.9, 6.3));
    HEAD[0] = 0.22 * (1 - lift) * seg(s, 0.3, 0.6) - 0.06 * lift + 0.05 * Math.sin(s * 20) * chew - 0.08 * happy;
    HEAD[1] = 0.08 * Math.sin(s * 2) * happy;
    HEAD[2] = 0.14 * happy;
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, 0.1 - 0.06 * happy, c.w);
    if (s > 4.5 && s < 5.9) c.say('😋');
    // steam off the top
    if (cup.visible && s >= (run.steam ?? 0.6) && s < 6.2) {
      run.steam = s + 0.28;
      V1.copy(cup.position).y += (CUP_H / 2) * size;
      V1.x += (Math.random() - 0.5) * 0.06 * k;
      c.emit('steam', V1, {
        life: 1.1,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.05, 0.28, 0),
        size: 0.05,
        grow: 2.6,
      });
    }
  },
  end(c) {
    const n = c.run?.n;
    if (!n) return;
    for (const g of [n.cup, n.chop, ...n.strands]) disposeTree(g);
  },
};

// ------------------------------------------------------------ eye break

// The hourly break: a big stretch, arms overhead (0.3–1.8), then 20-20-20: it
// gazes far off to one side, a hand shading its eyes like a sailor scanning
// the horizon (2.2–5.0). robot.js: speech at 2.2.
const STRETCH: Vec3Tuple = [-2.75, 0.22, -0.08]; // straight up, a little forward so they show over the head

const eyebreak: Antic = {
  dur: 6.0,
  update(c, A) {
    const { s } = c;
    const stretch = seg(s, 0.3, 0.8) * (1 - seg(s, 1.6, 2.0));
    const reach = stretch * (0.85 + 0.15 * Math.sin((s - 0.3) * 4));
    for (const key of ['armL', 'armR'] as const) blend(A, key, STRETCH, stretch * c.w);
    A.reachL = mix(A.reachL, 1.3, reach * c.w);
    A.reachR = mix(A.reachR, 1.3, reach * c.w);
    A.rootY += 0.04 * reach * c.w;
    // the gaze: turned well round to its right (your left), scanning slowly
    const look = seg(s, 2.2, 2.7) * (1 - seg(s, 4.85, 5.35));
    const scan = 0.42 + 0.12 * Math.sin((s - 2.4) * 1.7); // (not so far round that the face goes)
    HEAD[0] = -0.28 * stretch - 0.06 * look;
    HEAD[1] = scan * look;
    HEAD[2] = 0.18 * Math.sin((s - 0.6) * 3) * stretch;
    blend(A, 'head', HEAD, c.w);
    A.yaw = 0.1 * look * c.w;
    A.lean = mix(A.lean, -0.1 * stretch + 0.08 * look, c.w);
    // the right hand flat over the brow (head space, so it follows the gaze)
    const ht = c.robot.headTop ?? 0.6;
    const brow = at(c, c.robot.head, 0.04, ht * 0.9, mouthOf(c)[2] + 0.1, V1);
    const shade = seg(s, 2.1, 2.5) * (1 - seg(s, 4.9, 5.3));
    const r = aim(c, 'R', brow, PR, 2.2);
    blend(A, 'armR', PR, shade * c.w);
    A.reachR = mix(A.reachR, r, shade * c.w);
  },
};

export const CALENDAR: Record<string, Antic> = { friday, monday, noodles, ...PAYDAY, eyebreak };
