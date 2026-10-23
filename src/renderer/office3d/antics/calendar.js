import * as THREE from 'three';
import { toon, canvasTexture, roundRect } from '../materials.js';

// Office-calendar gags robot.js picks from the clock: a protest sign on Friday
// afternoon, Monday's coffee on a drip, cup noodles at noon, payday (and where
// the money goes), the hourly stretch-and-look-away eye break. Plus the hood it
// pulls up when it's still coding after 10 pm (tick).
// Timings are a contract: robot.js plays sounds and speech at the marked moments.
// Everything moves the shared rig only (root, torso, head, arms), so it works
// for every body, custom models included; the props all face the camera.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, k) => a + (b - a) * k;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s, a, b) => smooth((s - a) / (b - a)); // eases 0 -> 1 over [a, b]
const bump = (s, a, b) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const easeOut = (x) => 1 - (1 - x) * (1 - x);
// true the first frame at or past `at` (one-shot emits, whatever the frame rate)
const once = (c, key, at) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);
function blend(A, key, target, w) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}
// a prop's size: pops in at a (with a little overshoot), away again at b
function popScale(s, a, b) {
  if (s < a || s > b + 0.25) return 0;
  if (s > b) return 1 - (s - b) / 0.25;
  const u = (s - a) / 0.2;
  return u < 1 ? easeOut(u) * 1.15 : u < 1.75 ? 1.15 - 0.2 * (u - 1) : 1;
}
// props are sized for the default robot; bodies seated bigger or smaller scale them
const propScale = (c) => c.robot.root.scale.x / 0.82;

function disposeTree(obj) {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!o.isMesh && !o.isSprite) return;
    o.geometry?.dispose();
    for (const m of [].concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const QT = new THREE.Quaternion();
const PL = [0, 0, 0];
const PR = [0, 0, 0];
const HEAD = [0, 0, 0];

// A point on a part of the robot, in office space (= the world group the
// particles and the mug live in).
const at = (c, obj, x, y, z, out) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c, side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
const handAt = (c, side, out) => at(c, armOf(c, side).elbow, 0, -HAND, 0, out);

// Arm angles [pitch, out, elbow] that put a hand on a point (office space); as awake.js.
// Returns the stretch (A.reachL/R) needed when it's out of reach.
function aim(c, side, p, out, most = 1.9) {
  const arm = armOf(c, side);
  const v = c.robot.torso.worldToLocal(c.set.office.localToWorld(AIM.copy(p))).sub(arm.shoulder.position);
  const u = Math.abs(arm.elbow.position.y) || 0.2;
  const L = Math.max(1e-4, v.length());
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
// both hands on a pair of points (office space), weighted in by w
function grip(c, A, pl, pr, w) {
  const rl = aim(c, 'L', pl, PL, 2.2);
  const rr = aim(c, 'R', pr, PR, 2.2);
  blend(A, 'armL', PL, w);
  blend(A, 'armR', PR, w);
  A.reachL = mix(A.reachL, rl, w);
  A.reachR = mix(A.reachR, rr, w);
}

// where the mouth is on each head (head space); custom models: guessed from the head height
const MOUTHS = { robot: [0, 0.2, 0.3], cat: [0, 0.2, 0.42], loopy: [0, 0.2, 0.4], nerd: [0, 0.2, 0.38], girl: [0, 0.2, 0.37] };
const mouthOf = (c) => MOUTHS[c.body] || [0, (c.robot.headTop ?? 0.6) * 0.33, (c.robot.headTop ?? 0.6) * 0.5];
const sigh = (c, dir = -0.4) => {
  const m = mouthOf(c);
  const from = at(c, c.robot.head, m[0], m[1], m[2] + 0.02, V3);
  c.emit('steam', from, { life: 1.0, vel: at(c, c.robot.head, m[0], m[1] + dir, m[2] + 1, V4).sub(from).normalize().multiplyScalar(0.35), size: 0.08, grow: 2.2 });
};

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
  const board = new THREE.Mesh(new THREE.BoxGeometry(SIGN_W, SIGN_H, 0.02), [card, card, card, card, toon('#ffffff', { map: face.tex }), card]);
  board.castShadow = true;
  const sign = new THREE.Group();
  sign.add(board);
  return sign;
}

const friday = {
  dur: 4.5,
  update(c, A) {
    const { s, run } = c;
    const { torso, head } = c.robot;
    if (!run.sign) c.set.office.add((run.sign = buildSign()));
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
    grip(c, A, at(c, torso, -hx, cy - 0.04, SIGN_Z + 0.02, V1), at(c, torso, hx, cy - 0.04, SIGN_Z + 0.02, V2), seg(s, 0.15, 0.5) * (1 - seg(s, 3.95, 4.35)) * c.w);
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
  const tag = mesh(new THREE.PlaneGeometry(0.1, 0.1), toon('#ffffff', { map: label.tex, transparent: true }), 0, 0.005, 0.036);
  tag.material.userData.outlineParameters = { visible: false };
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
  g.traverse((o) => o.isMesh && (o.castShadow = true));
  // the tube (office space): short segments, clear until the coffee reaches them
  const tube = new THREE.Group();
  const segGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
  const tubeMat = toon('#dfeaf5');
  const fullMat = toon('#6b3d1e');
  const segs = [];
  for (let i = 0; i < TUBE_N; i++) {
    const m = new THREE.Mesh(segGeo, tubeMat);
    tube.add(m);
    segs.push(m);
  }
  const beads = [];
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
function bez(out, p0, p1, p2, u) {
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const d = u * u;
  return out.set(a * p0.x + b * p1.x + d * p2.x, a * p0.y + b * p1.y + d * p2.y, a * p0.z + b * p1.z + d * p2.z);
}
const P0 = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();

const monday = {
  dur: 6.0,
  update(c, A) {
    const { s, run } = c;
    const k = propScale(c);
    if (!run.drip) {
      run.drip = buildDrip();
      // it stands beside the chair on the robot's left (your right), angled so the label faces you
      at(c, c.robot.root, -0.78, 0, 0.22, run.drip.g.position).setY(0);
      run.drip.g.rotation.y = Math.atan2(-(c.robot.root.getWorldPosition(V1).z - run.drip.g.position.z), V1.x - run.drip.g.position.x);
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
    if (once(c, 'sigh', 1.4)) sigh(c);
    if (once(c, 'sigh2', 3.6)) sigh(c);
    if (once(c, 'zap', 5.2)) {
      const top = at(c, c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.05, 0, V1);
      for (let i = 0; i < 3; i++) {
        const a = Math.PI * (0.25 + i * 0.25);
        c.emit('bolt', top, { life: 0.6, vel: new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0), size: 0.1, spin: 3 });
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
    D.geos.forEach((g) => g.dispose());
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
  cup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.052, CUP_H, 24, 1, true), toon('#ffffff', { map: label.tex, side: THREE.DoubleSide })));
  cup.add(mesh(new THREE.CircleGeometry(0.052, 20), toon('#ffffff'), 0, -CUP_H / 2, 0).rotateX(Math.PI / 2));
  const broth = mesh(new THREE.CircleGeometry(0.067, 24), toon('#e8b45a'), 0, CUP_H / 2 - 0.012, 0);
  broth.rotation.x = -Math.PI / 2;
  cup.add(broth);
  const noodle = toon('#f6d77a');
  for (const [x, z, r] of [[-0.025, 0.012, 0.02], [0.015, -0.02, 0.022], [0.02, 0.022, 0.016], [-0.01, -0.03, 0.015]]) {
    const loop = mesh(new THREE.TorusGeometry(r, 0.006, 6, 16), noodle, x, CUP_H / 2 - 0.008, z);
    loop.rotation.x = Math.PI / 2;
    cup.add(loop);
  }
  // a slice of fishcake and some spring onion
  cup.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 16), toon('#ffffff'), 0.03, CUP_H / 2 - 0.004, 0.01));
  const swirl = mesh(new THREE.TorusGeometry(0.008, 0.0025, 4, 12), toon('#ff6fa0'), 0.03, CUP_H / 2 - 0.0005, 0.01);
  swirl.rotation.x = Math.PI / 2;
  cup.add(swirl);
  for (const [x, z] of [[-0.035, -0.01], [-0.02, 0.035], [0.005, 0.04]]) cup.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 8), toon('#58c06a'), x, CUP_H / 2 - 0.006, z));
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
  const strands = [];
  for (let i = 0; i < 3; i++) {
    const pts = [];
    for (let j = 0; j <= 10; j++) pts.push(new THREE.Vector3(Math.sin(j * 1.9 + i * 2) * 0.012, -j / 10, Math.cos(j * 1.4 + i) * 0.008));
    const strand = new THREE.Group();
    strand.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0055, 5), noodle));
    strands.push(strand);
  }
  for (const g of [cup, chop]) g.traverse((o) => o.isMesh && (o.castShadow = true));
  return { cup, chop, strands };
}

const noodles = {
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
    at(c, torso, mix(0.12, 0.14, lift), mix(0.14, -0.04, lift), mix(-0.06, 0.12, lift), V4).sub(at(c, torso, 0, 0, 0, V1));
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
      c.emit('steam', V1, { life: 1.1, vel: new THREE.Vector3((Math.random() - 0.5) * 0.05, 0.28, 0), size: 0.05, grow: 2.6 });
    }
  },
  end(c) {
    const n = c.run?.n;
    if (!n) return;
    for (const g of [n.cup, n.chop, ...n.strands]) disposeTree(g);
  },
};

// ------------------------------------------------------------ payday

// Payday! Money rains down (0.3–2.8) and it cheers, arms up; then it pulls out
// its tiny wallet (3.0), opens it (3.4) and a moth flutters out (3.6). A long
// sad sigh (4.2–5.8). The monitor shows the bank app the whole time.
// robot.js: ka-ching 0.3, speech 4.2.
const BILLS = 16;
const WALLET_W = 0.085;
const WALLET_H = 0.065;
const WALLET_T = 0.012;
const CHEER = [-2.55, 0.75, -0.3]; // arms up in a V (in front of the head, so you see them)
let billTex = null;
let mothTex = null;
function paydayTextures() {
  billTex ||= canvasTexture(128, 128, (ctx) => {
    ctx.font = '104px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💵', 64, 70);
  }).tex;
  mothTex ||= canvasTexture(64, 64, (ctx) => {
    ctx.strokeStyle = '#1d2235';
    ctx.lineWidth = 2.5;
    for (const side of [-1, 1]) {
      for (const [y, rx, ry, col] of [[26, 18, 13, '#b9ad97'], [40, 12, 9, '#9e917b']]) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.ellipse(32 + side * (rx + 1), y, rx, ry, side * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#6f6452';
      ctx.beginPath();
      ctx.arc(32 + side * 18, 25, 3.5, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(32 + side * 2, 16);
      ctx.quadraticCurveTo(32 + side * 6, 6, 32 + side * 12, 5);
      ctx.stroke();
    }
    ctx.fillStyle = '#5b5143';
    ctx.beginPath();
    ctx.ellipse(32, 32, 4, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }).tex;
}
function sprite(tex) {
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  mat.userData.outlineParameters = { visible: false };
  const sp = new THREE.Sprite(mat);
  sp.visible = false;
  return sp;
}
function buildWallet() {
  const wallet = new THREE.Group();
  const inner = new THREE.Group(); // shifts so it stays centred as it opens
  wallet.add(inner);
  const leather = toon('#8b5a2b');
  const lining = toon('#d9b48a');
  const box = new THREE.BoxGeometry(WALLET_W, WALLET_H, WALLET_T);
  inner.add(mesh(box, [leather, leather, leather, leather, lining, leather], WALLET_W / 2, 0, 0));
  const cover = new THREE.Group(); // the front half, hinged at the spine (x = 0)
  cover.position.z = WALLET_T;
  cover.add(mesh(box, [leather, leather, leather, leather, leather, lining], WALLET_W / 2, 0, 0));
  // an empty card slot inside the cover
  cover.add(mesh(new THREE.BoxGeometry(WALLET_W * 0.75, 0.008, 0.002), toon('#a87a4c'), WALLET_W / 2, 0.01, -WALLET_T / 2 - 0.001));
  inner.add(cover);
  wallet.traverse((o) => o.isMesh && (o.castShadow = true));
  return { wallet, inner, cover };
}

const payday = {
  dur: 6.0,
  update(c, A) {
    const { s, run } = c;
    const { torso, head } = c.robot;
    A.screen = 'payday';
    const k = propScale(c);
    if (!run.bills) {
      paydayTextures();
      run.bills = Array.from({ length: BILLS }, () => sprite(billTex));
      run.moth = sprite(mothTex);
      run.wallet = buildWallet();
      c.set.office.add(...run.bills, run.moth, run.wallet.wallet);
      // the rain falls in a box around the chair, from above the head to below the seat
      run.mid = at(c, c.robot.root, 0, 0, 0.15, new THREE.Vector3());
      run.top = at(c, head, 0, (c.robot.headTop ?? 0.6) + 0.9, 0, new THREE.Vector3()).y;
    }
    // money rain: each bill drops in turn, fluttering and spinning
    run.bills.forEach((b, i) => {
      const t0 = 0.3 + (i / BILLS) * 1.55 + Math.sin(i * 7.3) * 0.06; // all down by 2.8
      const u = (s - t0) / 0.95;
      b.visible = u > 0 && u < 1;
      if (!b.visible) return;
      b.position.set(run.mid.x + (((i * 0.618) % 1) - 0.5) * 1.0 + Math.sin(u * 8 + i) * 0.06, mix(run.top, run.mid.y - 0.25, u), run.mid.z + Math.cos(i * 4.1) * 0.3);
      b.material.rotation = Math.sin(u * 7 + i) * 0.7;
      b.material.opacity = Math.min(1, (1 - u) / 0.2, u / 0.08);
      b.scale.setScalar(0.17 * k);
    });
    // cheering, arms up and bouncing
    const yay = seg(s, 0.3, 0.55) * (1 - seg(s, 2.6, 2.95));
    for (const [key, ph] of [['armL', 0], ['armR', 1.3]]) {
      for (let i = 0; i < 3; i++) PL[i] = CHEER[i];
      PL[1] += Math.sin(s * 14 + ph) * 0.18;
      blend(A, key, PL, yay * c.w);
    }
    A.rootY += 0.05 * Math.abs(Math.sin(s * 8)) * yay * c.w;

    // the wallet: in both hands in front of the chest; lowered to the lap for the sigh
    const { wallet, inner, cover } = run.wallet;
    const hy = head.position.y;
    const sad = seg(s, 4.2, 4.9) * (1 - seg(s, 5.6, 5.9));
    const wy = mix(hy - 0.27, hy - 0.42, sad);
    const wz = mix(0.38, 0.33, sad);
    const size = popScale(s, 3.0, 5.6) * k * 1.9;
    const open = seg(s, 3.4, 3.6);
    at(c, torso, 0, wy + 0.06 * k, wz, wallet.position);
    torso.getWorldQuaternion(wallet.quaternion);
    wallet.quaternion.multiply(QT.setFromAxisAngle(V1.set(1, 0, 0), -0.55)); // tipped up to look into
    wallet.scale.setScalar(Math.max(0.001, size));
    wallet.visible = size > 0;
    cover.rotation.y = -2.9 * open + Math.sin(s * 30) * 0.05 * bump(s, 3.0, 3.35); // a fiddle, then open
    inner.position.x = -WALLET_W / 2 * (1 - open);
    const half = (mix(0.55, 0.95, open) * WALLET_W * size) / c.robot.root.scale.x; // (torso space)
    grip(c, A, at(c, torso, -half, wy, wz + 0.02, V1), at(c, torso, half, wy, wz + 0.02, V2), seg(s, 2.75, 3.05) * (1 - seg(s, 5.5, 5.9)) * c.w);

    // ...and out flutters a moth, up and away to your right
    const fly = s - 3.6;
    const moth = run.moth;
    moth.visible = fly > 0 && fly < 1.8;
    if (moth.visible) {
      moth.position.copy(wallet.position);
      moth.position.x += fly * 0.4 + Math.sin(fly * 9) * 0.07;
      moth.position.y += 0.06 + fly * 0.65 + Math.sin(fly * 13) * 0.04;
      moth.position.z += 0.05 + fly * 0.15;
      const sz = 0.2 * k * Math.min(1, fly / 0.15);
      moth.scale.set(sz * (0.35 + 0.65 * Math.abs(Math.sin(fly * 26))), sz, 1);
      moth.material.opacity = Math.min(1, (1.8 - fly) / 0.4);
    }
    if (once(c, 'dust', 3.45)) {
      for (let i = 0; i < 3; i++) c.emit('steam', wallet.position, { life: 0.7, vel: new THREE.Vector3((i - 1) * 0.15, 0.25, 0.05), size: 0.04, grow: 2.2 });
    }

    // head: up at the money; down into the wallet; after the moth; then hung low
    const peek = seg(s, 3.0, 3.25) * (1 - seg(s, 3.6, 3.8));
    const follow = seg(s, 3.6, 3.8) * (1 - seg(s, 4.2, 4.6));
    // (never so far down that the face goes out of view)
    HEAD[0] = -0.2 * yay + 0.2 * peek - 0.3 * follow + 0.12 * sad;
    HEAD[1] = -0.35 * follow * Math.min(1, fly + 0.3);
    HEAD[2] = 0.24 * sad;
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, mix(-0.04 * yay + 0.06 * peek, 0.1, sad), c.w);
    A.rootY -= 0.03 * sad * c.w;
    if (once(c, 'sigh', 4.35)) sigh(c, -0.7);
  },
  end(c) {
    const { run } = c;
    if (!run?.bills) return;
    for (const sp of [...run.bills, run.moth]) {
      sp.removeFromParent();
      sp.material.dispose(); // (the shared textures are kept for next payday)
    }
    disposeTree(run.wallet.wallet);
  },
};

// ------------------------------------------------------------ eye break

// The hourly break: a big stretch, arms overhead (0.3–1.8), then 20-20-20: it
// gazes far off to one side, a hand shading its eyes like a sailor scanning
// the horizon (2.2–5.0). robot.js: speech at 2.2.
const STRETCH = [-2.75, 0.22, -0.08]; // straight up, a little forward so they show over the head

const eyebreak = {
  dur: 6.0,
  update(c, A) {
    const { s } = c;
    const stretch = seg(s, 0.3, 0.8) * (1 - seg(s, 1.6, 2.0));
    const reach = stretch * (0.85 + 0.15 * Math.sin((s - 0.3) * 4));
    for (const key of ['armL', 'armR']) blend(A, key, STRETCH, stretch * c.w);
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

export const CALENDAR = { friday, monday, noodles, payday, eyebreak };

// ------------------------------------------------------------ the late-night hood

// Still up after 10 pm: a dark hoodie hood pulled up over the head, its face
// opening edged with a thick rim and two drawstrings hanging down. Built in the
// robot's hat space (hats sit at top = 0.59, head from ~0 up) as the nightcap
// is, and fitted to each head from its top-hat fit: up to the hat's height,
// widened as the hats are.
const HOOD_C = new THREE.Vector3(0, 0.29, -0.03); // the shell's centre
const HOOD_R = new THREE.Vector3(0.47, 0.4, 0.38); // ...and radii
const HOOD_N = 2.8; // superellipsoid power: boxy enough to clear the robot's corners
const HOOD_LOW = -0.55; // the shell stops at this elevation (radians), round the neck
// the face opening, an ellipse in (azimuth, elevation) around the front
const OPEN_AZ = 0.98;
const OPEN_EL = [-0.2, 0.62]; // centre, half-height

// a direction on the unit sphere -> a point on the hood (superellipsoid)
const sq = (v) => Math.sign(v) * Math.abs(v) ** (2 / HOOD_N);
function hoodPoint(out, az, el, grow = 1) {
  const ce = Math.cos(el);
  return out.set(sq(Math.sin(az) * ce) * HOOD_R.x * grow, sq(Math.sin(el)) * HOOD_R.y * grow, sq(Math.cos(az) * ce) * HOOD_R.z * grow).add(HOOD_C);
}
const inOpening = (az, el) => (az / OPEN_AZ) ** 2 + ((el - OPEN_EL[0]) / OPEN_EL[1]) ** 2 < 1;

function buildHood() {
  // the shell: a sphere's grid pushed out to the superellipsoid, minus the opening
  const rows = 26;
  const cols = 48;
  const pos = [];
  for (let r = 0; r <= rows; r++) {
    const el = Math.PI / 2 - (r / rows) * (Math.PI / 2 - HOOD_LOW);
    for (let q = 0; q <= cols; q++) {
      hoodPoint(V1, (q / cols) * Math.PI * 2 - Math.PI, el);
      pos.push(V1.x, V1.y, V1.z);
    }
  }
  const index = [];
  for (let r = 0; r < rows; r++) {
    const el = Math.PI / 2 - ((r + 0.5) / rows) * (Math.PI / 2 - HOOD_LOW);
    for (let q = 0; q < cols; q++) {
      if (inOpening(((q + 0.5) / cols) * Math.PI * 2 - Math.PI, el)) continue;
      const a = r * (cols + 1) + q;
      const b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const hood = new THREE.Group();
  const shell = new THREE.Mesh(geo, toon('#3d4359'));
  shell.castShadow = true;
  const lining = new THREE.Mesh(geo, toon('#14161f', { side: THREE.BackSide }));
  lining.material.userData.outlineParameters = { visible: false };
  hood.add(shell, lining);
  // the rim round the opening: a fat tube along its edge
  const edge = [];
  for (let i = 0; i <= 60; i++) {
    // round from the bottom: up one side, over the top, down the other (the bottom's cut off)
    const a = Math.PI / 2 + (i / 60) * Math.PI * 2;
    const el = OPEN_EL[0] - Math.sin(a) * OPEN_EL[1];
    if (el >= HOOD_LOW) edge.push(hoodPoint(new THREE.Vector3(), Math.cos(a) * OPEN_AZ, el, 1.01));
  }
  hood.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 48, 0.04, 8), toon('#555c79')));
  // the seam down the middle, from the brim over the top to the back of the neck
  const seam = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const el = OPEN_EL[0] + OPEN_EL[1] + (Math.PI - OPEN_EL[0] - OPEN_EL[1] - HOOD_LOW) * t; // past the top: down the back
    seam.push(hoodPoint(new THREE.Vector3(), el > Math.PI / 2 ? Math.PI : 0, el > Math.PI / 2 ? Math.PI - el : el, 1.005));
  }
  hood.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seam), 32, 0.014, 6), toon('#2f3447')));
  // the collar it rises out of: round the back and sides of the neck, open at the front
  const collar = mesh(new THREE.TorusGeometry(0.37, 0.065, 8, 28, Math.PI * 1.4), toon('#343a4e'), 0, 0.03, -0.03);
  collar.rotation.set(Math.PI / 2, 0, Math.PI / 2 + Math.PI * 0.3);
  collar.scale.set(1, 0.85, 1);
  hood.add(collar);
  // drawstrings from where the rim meets the bottom, with white tips
  const cordMat = toon('#e9ecf5');
  for (const p of [edge[0], edge[edge.length - 1]]) {
    const cord = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 6), cordMat, p.x * 0.8, p.y - 0.1, p.z + 0.03);
    hood.add(cord);
    hood.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 8), toon('#c3c8d4'), p.x * 0.8, p.y - 0.21, p.z + 0.03));
  }
  hood.traverse((o) => o.isMesh && o !== lining && (o.castShadow = true));
  const fit = new THREE.Group(); // follows the body's hat fit
  fit.add(hood);
  return { fit, hood };
}

// Where hats sit on this head (as asleep.js does for the nightcap): whatever it
// wears is already fitted; with nothing on, try a top hat on once to read the
// body's fit, then take it off again.
const hatFits = new WeakMap();
function hatFit(robot) {
  const acc = robot.accessory;
  if (acc.children.length || !robot.setAccessory) return acc;
  let fit = hatFits.get(robot);
  if (!fit) {
    robot.setAccessory('tophat');
    fit = { position: acc.position.clone(), scale: acc.scale.clone() };
    const tried = [...acc.children];
    robot.setAccessory('none');
    tried.forEach(disposeTree);
    hatFits.set(robot, fit);
  }
  return fit;
}

// Hats and the antenna (the tuft, the cowlick…) go under the hood. Their parts
// are hidden one by one rather than the groups, so this never fights the
// nightcap, which hides the groups (both can change in the same frame at bedtime).
// One hood per robot, built the first time it's needed and kept until that
// body is swapped out (several desks can share this module: the test harness).
const hoods = new Map(); // robot -> { fit, hood, on, grow, hidden }
function hideUnder(h, group) {
  if (!group) return;
  for (const o of group.children) {
    if (!o.visible) continue;
    o.visible = false;
    h.hidden.push(o);
  }
}
function hoodOff(h) {
  if (!h?.on) return;
  for (const o of h.hidden) o.visible = true;
  h.hidden.length = 0;
  h.fit.removeFromParent();
  h.on = false;
}

export function tick(c) {
  const { robot } = c;
  // a body that's been swapped out takes its hood with it
  for (const [r, h] of hoods) {
    if (r === robot || r.root.parent) continue;
    hoodOff(h);
    disposeTree(h.fit);
    hoods.delete(r);
  }
  let h = hoods.get(robot);
  if (!c.lateNight || c.asleep) return hoodOff(h);
  if (!h) hoods.set(robot, (h = { ...buildHood(), on: false, grow: 0, hidden: [] }));
  if (!h.on) {
    h.on = true;
    h.grow = 0;
    robot.head.add(h.fit);
  }
  const fit = hatFit(robot);
  // up to the hat's height, as wide as the hats are made for this head
  const top = fit.position.y + 0.59;
  h.fit.position.set(fit.position.x, 0, fit.position.z);
  h.fit.scale.set(fit.scale.x, top / 0.59, fit.scale.z);
  hideUnder(h, robot.accessory);
  if (robot.antenna?.parent === robot.head) hideUnder(h, robot.antenna);
  // pulled up with a little overshoot
  h.grow = Math.min(1, h.grow + c.dt * 3);
  const x = h.grow - 1;
  const g = 1 + 2.7 * x ** 3 + 1.7 * x ** 2;
  h.hood.scale.setScalar(g);
  h.hood.position.y = (1 - h.grow) * -0.25;
}
