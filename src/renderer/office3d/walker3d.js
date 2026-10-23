import * as THREE from 'three';
import { canvasTexture, noOutline } from './materials.js';

// Out for a walk: the character stands up and strolls about the user's screen in its
// own little window (index.js mounted with `solo: true`), and gets up from / back
// into its chair at the desk (antics/walk.js). This is the standing and walking rig.
//
// Every body is built sitting (robot3d.js): a hip group per leg with the thigh forward
// (+z) and the shin and foot hanging from the knee. legRig() gives each leg a knee
// pivot, so a hip swings the whole leg and a knee bends what hangs below it:
//   hip.rotation.x  0 = thigh forward (sitting), PI/2 = thigh straight down
//   knee.rotation.x 0 = shin hanging down (sitting), leg.straight = in line with the thigh
// Poses here use friendlier angles (see newPose): hip = how far the leg swings forward
// of straight down, knee = how far it bends back from straight.

const HALF_PI = Math.PI / 2;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const mix = (a, b, k) => a + (b - a) * k;
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const bump = (s, a, b) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);

// The solo window shows it just as big as at its desk, seen from the same height (so
// stepping out of the desk into the walker window doesn't change it), with the ground
// (y = 0) `feet` of the way down the picture.
export const SOLO = { feet: 0.9 };
// which way it faces (radians about the vertical; 0 = at the camera): a 3/4 view when
// walking sideways, so the face still shows
const HEADINGS = { toward: 0, left: -1.0, right: 1.0, away: Math.PI };
// out walking, the empty chair is turned this far from the desk towards you (index.js, antics/walk.js)
export const AWAY_TURN = 0.45;
const GAITS = new Set(['stand', 'walk', 'sleepwalk', 'wave', 'look', 'sit', 'dangle', 'land']);
const BLEND = 0.25; // seconds to switch gaits
const LAND = 0.4; // the squash on being put down

// scratch, so nothing is allocated per frame
const V = new THREE.Vector3();
const BOX = new THREE.Box3();
const BOX2 = new THREE.Box3();
const M = new THREE.Matrix4();
const INV = new THREE.Matrix4();

// ---------------------------------------------------------------- the leg rig

/** The root-space box round everything under `objs` as posed now. */
function boxOf(root, objs) {
  root.updateMatrixWorld(true);
  INV.copy(root.matrixWorld).invert();
  BOX.makeEmpty();
  for (const obj of objs) {
    obj.traverseVisible((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      BOX.union(BOX2.copy(o.geometry.boundingBox).applyMatrix4(M.multiplyMatrices(INV, o.matrixWorld)));
    });
  }
  return BOX;
}

/**
 * Legs that can stand, for this body (made once, kept on robot.root.userData):
 *   legs    [{ hip, knee, side, straight }]  (empty for a plush model: it hops)
 *   sole    root-space height of its soles with the legs straight down
 *   top     root-space height of the top of its head
 *   brow    how its right arm reaches its brow ('look'), see browReach
 *   plush   no legs to stand on (a custom model without a skeleton)
 *   restore()  back to the body as built, sitting (call before it's seated again at the desk)
 */
export function legRig(robot) {
  const ud = robot.root.userData;
  if (ud.legRig) return ud.legRig;
  const root = robot.root;
  const legs = [];
  const made = []; // knee pivots added to a built-in body: [{ hip, knee }]
  let sole = 0;
  if (robot.status) {
    // your own model: custom3d.js has leg stand-ins if it has legs to stand on
    for (const l of robot.legs || []) legs.push(l);
    sole = robot.legs ? robot.standSole : 0;
  } else {
    for (const hip of root.children) {
      if (hip === robot.torso || hip.isMesh || Math.abs(hip.position.x) < 0.05) continue;
      const thigh = hip.children.find((o) => o.position.y > -0.05 && o.position.z > 0.08);
      const below = hip.children.filter((o) => o.position.y < -0.02);
      if (!thigh || !below.length) continue;
      // the knee: at the end of the thigh, where the shin hangs from
      const knee = new THREE.Group();
      knee.name = 'walk-knee';
      knee.position.set(0, thigh.position.y, Math.min(...below.map((o) => o.position.z)));
      for (const o of below) {
        o.position.sub(knee.position);
        knee.add(o);
      }
      hip.add(knee);
      made.push({ hip, knee, q: hip.quaternion.clone() });
      legs.push({ hip, knee, side: Math.sign(hip.position.x), straight: -HALF_PI });
    }
    // measure it standing
    for (const l of legs) {
      l.hip.rotation.x = HALF_PI;
      l.knee.rotation.x = l.straight;
    }
    sole = legs.length ? boxOf(root, legs.map((l) => l.hip)).min.y : 0;
    for (const l of legs) l.hip.rotation.x = l.knee.rotation.x = 0;
  }
  // the top of its head, sitting up straight
  const lean = [robot.torso.rotation.x, robot.head.rotation.x];
  robot.torso.rotation.x = robot.head.rotation.x = 0;
  root.updateMatrixWorld(true);
  INV.copy(root.matrixWorld).invert();
  const top = robot.head.localToWorld(V.set(0, robot.headTop ?? 0.6, 0)).applyMatrix4(INV).y;
  [robot.torso.rotation.x, robot.head.rotation.x] = lean;

  const rig = {
    legs,
    sole,
    top,
    brow: browReach(robot),
    plush: !legs.length,
    restore() {
      for (const l of legs) {
        l.hip.quaternion.identity();
        l.knee.quaternion.identity();
      }
      for (const { hip, knee, q } of made) {
        for (const o of [...knee.children]) {
          o.position.add(knee.position);
          hip.add(o);
        }
        knee.removeFromParent();
        hip.quaternion.copy(q);
      }
      robot.torso.rotation.y = robot.torso.rotation.z = 0;
      delete ud.legRig;
    },
  };
  ud.legRig = rig;
  return rig;
}

/**
 * How the right arm reaches its brow, to shade its eyes ('look'): [pitch, out, stretch].
 * Measured on the body: from the shoulder to just in front of its forehead, the arm
 * held (nearly) straight and stretched to get there, cartoon-style.
 */
function browReach(robot) {
  const { shoulder, elbow } = robot.arms.armR;
  // arm length: the upper arm, and on to the middle of the hand
  const hand = robot.status ? elbow.position.y : boxOf(elbow, elbow.children).min.y + 0.05;
  const len = Math.max(0.15, -elbow.position.y - Math.min(-0.08, hand));
  // its forehead (head space): up the front of the head
  const head = boxOf(robot.head, robot.head.children.filter((o) => o !== robot.accessory && o !== robot.antenna && o !== robot.headband));
  const top = robot.headTop ?? 0.6;
  if (head.isEmpty()) head.set(V.set(-top * 0.4, 0, -top * 0.4), new THREE.Vector3(top * 0.4, top, top * 0.4));
  V.set(0.1, head.min.y + 0.8 * (head.max.y - head.min.y), head.max.z + 0.06).add(robot.head.position).sub(shoulder.position);
  const reach = Math.min(1.8, Math.max(1, V.length() / len));
  V.normalize();
  return [Math.atan2(-V.z, -V.y), Math.asin(Math.max(-1, Math.min(1, V.x))), reach];
}

// ---------------------------------------------------------------- poses

/**
 * A standing pose, in friendly angles:
 *   hipL/hipR    leg swung forward of straight down (radians; PI/2 = thigh level, sitting)
 *   kneeL/kneeR  bent back from straight (radians)
 *   armL/armR    [shoulder pitch, out, elbow] as in robot3d POSES
 *   lean, twist, tilt  torso: forward, turned (y), sideways (z)
 *   head[3]      head rotation
 *   y            root height (root units; -rig.sole stands it on the ground)
 *   x            sideways sway (root units)
 *   back         shuffled back, away from the camera (root units: sitting, so its feet stay in view)
 *   squash       0 = normal, + squashed down
 *   reachL/R     cartoon arm stretch (1 = as built), so a hand can get to its face
 */
export function newPose() {
  return { hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, armL: [0, 0, 0], armR: [0, 0, 0], lean: 0, twist: 0, tilt: 0, head: [0, 0, 0], y: 0, x: 0, back: 0, squash: 0, reachL: 1, reachR: 1 };
}
const KEYS = ['hipL', 'hipR', 'kneeL', 'kneeR', 'lean', 'twist', 'tilt', 'y', 'x', 'back', 'squash', 'reachL', 'reachR'];
export function mixPose(out, a, b, k) {
  for (const key of KEYS) out[key] = mix(a[key], b[key], k);
  for (let i = 0; i < 3; i++) {
    out.armL[i] = mix(a.armL[i], b.armL[i], k);
    out.armR[i] = mix(a.armR[i], b.armR[i], k);
    out.head[i] = mix(a.head[i], b.head[i], k);
  }
  return out;
}
const copyPose = (out, a) => mixPose(out, a, a, 0);
const arm = (a, p, o, e) => {
  a[0] = p;
  a[1] = o;
  a[2] = e;
};

/** Standing about: breathing, shifting its weight, now and then a glance aside. */
export function standPose(o, rig, t) {
  const shift = Math.sin(t * 0.55);
  o.hipL = 0.03 + 0.02 * shift;
  o.hipR = 0.03 - 0.02 * shift;
  o.kneeL = 0.06 + 0.05 * Math.max(0, shift);
  o.kneeR = 0.06 + 0.05 * Math.max(0, -shift);
  const breathe = Math.sin(t * 2.2);
  arm(o.armL, 0.06 + 0.03 * breathe, 0.14, -0.2);
  arm(o.armR, 0.06 + 0.03 * breathe, 0.14, -0.2);
  o.lean = 0.02 + 0.015 * breathe;
  o.twist = 0;
  o.tilt = 0.035 * shift;
  // a glance to one side, then the other, every few seconds
  const cyc = t / 6.5;
  const n = Math.floor(cyc);
  const glance = smooth((cyc - n - 0.62) / 0.05) * (1 - smooth((cyc - n - 0.86) / 0.05));
  o.head[0] = -0.02 + 0.01 * breathe;
  o.head[1] = (n % 2 ? 0.5 : -0.5) * glance;
  o.head[2] = -0.04 * shift;
  o.y = -rig.sole - 0.01 * Math.abs(shift);
  o.x = 0.025 * shift;
  o.back = 0;
  o.squash = 0;
  o.reachL = o.reachR = 1;
}

/**
 * A walk cycle at `phase` (radians: one cycle is two steps). Legs swing alternately,
 * the knee bending as each one comes forward; arms counter-swing; the body bobs,
 * its hips dropping as the legs spread so the planted foot stays on the ground.
 */
export function stridePose(o, rig, phase, { swing = 0.42, bend = 0.8, arms = 0.5, lean = 0.1 } = {}) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  o.hipL = swing * s;
  o.hipR = -swing * s;
  o.kneeL = 0.06 + bend * Math.max(0, c) ** 1.5;
  o.kneeR = 0.06 + bend * Math.max(0, -c) ** 1.5;
  arm(o.armL, arms * s, 0.12, -0.3 - 0.25 * Math.max(0, -s));
  arm(o.armR, -arms * s, 0.12, -0.3 - 0.25 * Math.max(0, s));
  o.lean = lean;
  o.twist = 0.1 * s;
  o.tilt = 0.03 * Math.cos(phase * 2);
  o.head[0] = -0.04;
  o.head[1] = -0.07 * s;
  o.head[2] = -0.02 * s;
  const leg = -rig.sole; // hip above the sole
  o.y = -rig.sole - leg * (1 - Math.cos(swing * Math.abs(s))) + 0.025 * Math.abs(Math.cos(phase));
  o.x = 0.012 * s;
  o.back = 0;
  o.squash = 0;
  o.reachL = o.reachR = 1;
}

/** A hop along, for a plush with no legs: two hops a cycle, squashing as it lands. */
export function hopPose(o, rig, phase, height = 0.2) {
  const s = Math.abs(Math.sin(phase));
  o.hipL = o.hipR = o.kneeL = o.kneeR = 0;
  arm(o.armL, 0.3 * Math.sin(phase), 0.3, -0.3);
  arm(o.armR, -0.3 * Math.sin(phase), 0.3, -0.3);
  o.lean = 0.12 * s;
  o.twist = 0;
  o.tilt = 0.06 * Math.sin(phase);
  o.head[0] = -0.05 * s;
  o.head[1] = 0;
  o.head[2] = 0;
  o.y = -rig.sole + height * Math.sin(Math.min(1, s * 1.15) * HALF_PI);
  o.x = 0;
  o.back = 0;
  o.squash = 0.14 * Math.max(0, 1 - s * 5) - 0.05 * Math.max(0, s - 0.6);
  o.reachL = o.reachR = 1;
}

/** Sleepwalking: a slow shuffle, arms straight out in front, head drooping and swaying. */
export function sleepwalkPose(o, rig, phase, t) {
  if (rig.plush) hopPose(o, rig, phase, 0.08);
  else stridePose(o, rig, phase, { swing: 0.2, bend: 0.3, arms: 0, lean: -0.04 });
  const bob = 0.04 * Math.sin(t * 2.1);
  arm(o.armL, -1.5 + bob, 0.04, -0.05);
  arm(o.armR, -1.5 - bob, 0.04, -0.05);
  o.twist *= 0.5;
  o.head[0] = 0.32 + 0.05 * Math.sin(t * 1.7);
  o.head[1] = 0.08 * Math.sin(t * 0.9);
  o.head[2] = 0.16 * Math.sin(t * 1.3);
}

// ---------------------------------------------------------------- solo mode

function poseArm(a, v, reach) {
  a.shoulder.rotation.set(v[0], 0, v[1] * a.side);
  a.shoulder.scale.y = reach;
  a.elbow.rotation.x = v[2];
}

function blobTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(29,34,53,0.55)');
    g.addColorStop(0.45, 'rgba(29,34,53,0.32)');
    g.addColorStop(1, 'rgba(29,34,53,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }).tex;
}

/**
 * Aim the solo camera like the desk's: the same field of view and height (`pitch` above the
 * floor), and as far away as makes `pxPerUnit` CSS px per world unit in a picture `height`
 * px tall, the ground `SOLO.feet` of the way down it.
 */
export function frameSolo(camera, { height, pxPerUnit, fov, pitch }) {
  camera.fov = fov;
  camera.updateProjectionMatrix();
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const dist = height / (2 * pxPerUnit * tan);
  const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
  const v = new THREE.Vector3();
  const lo = 1 - 2 * SOLO.feet;
  let aim = 0.6;
  for (let i = 0; i < 40; i++) {
    camera.position.set(0, aim, 0).addScaledVector(dir, dist);
    camera.lookAt(0, aim, 0);
    camera.updateMatrixWorld();
    aim += (v.set(0, 0, 0).project(camera).y - lo) * dist * tan;
  }
  camera.position.set(0, aim, 0).addScaledVector(dir, dist);
  camera.lookAt(0, aim, 0);
  camera.updateMatrixWorld();
}

/**
 * The walker: the character alone, standing on an invisible ground with a soft
 * shadow under its feet. `stage` is where the robot root goes. update() poses it
 * from stateEl.dataset: gait, heading, speed (see the contract in index.js).
 */
export function createWalker({ world, emit, worldPoint, scale: deskScale }) {
  const ground = new THREE.Group();
  world.add(ground);
  const shadowMat = noOutline(new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadow.rotation.x = -HALF_PI;
  shadow.position.y = 0.003;
  shadow.renderOrder = -1;
  ground.add(shadow);
  // carried: it swings from about the top of its head
  const carry = new THREE.Group();
  ground.add(carry);
  const stage = new THREE.Group();
  carry.add(stage);

  let rig = null;
  let rigOf = null;
  let scale = 1;
  let gait = 'stand';
  let blend = 1;
  let changedAt = 0;
  let phase = 0;
  let yaw = 0;
  let swing = 0;
  let nextZ = 0;
  let now = 0;
  const from = newPose(); // what it was doing when the gait changed
  const want = newPose();
  const out = newPose();

  function pose(o, t, d) {
    const speed = Math.max(0.2, Math.min(3, Number(d.speed) || 1));
    switch (gait) {
      case 'walk':
        if (rig.plush) hopPose(o, rig, phase);
        else stridePose(o, rig, phase);
        break;
      case 'sleepwalk':
        sleepwalkPose(o, rig, phase, t);
        break;
      case 'wave': {
        standPose(o, rig, t);
        const w = Math.sin(t * 11);
        arm(o.armR, -2.7 + 0.08 * w, 0.62 + 0.14 * w, -0.5 + 0.38 * w); // (the hand waggles, clear of its head)
        o.head[2] = 0.1;
        o.head[1] = 0;
        o.tilt = -0.05;
        o.y += 0.012 * Math.abs(Math.sin(t * 5.5));
        break;
      }
      case 'look': {
        // a hand shading its eyes, scanning the horizon left and right
        standPose(o, rig, t);
        const scan = Math.sin(t * 1.1);
        arm(o.armR, rig.brow[0], rig.brow[1], -0.15);
        o.reachR = rig.brow[2];
        o.head[0] = -0.05;
        o.head[1] = 0.12 * scan;
        o.head[2] = 0;
        o.twist = 0.4 * scan; // (turning from the waist, so the hand stays at its brow)
        o.lean = 0.08;
        break;
      }
      case 'sit': {
        // on the ground, legs out in front, leaning back on its hands
        const breathe = Math.sin(t * 1.8);
        o.hipL = o.hipR = 1.42;
        o.kneeL = 0.06 + 0.04 * Math.max(0, Math.sin(t * 0.7));
        o.kneeR = 0.1;
        arm(o.armL, 0.55, 0.85, -0.1);
        arm(o.armR, 0.55, 0.85, -0.1);
        o.reachL = o.reachR = 1;
        o.lean = -0.32 + 0.015 * breathe;
        o.twist = 0;
        o.tilt = 0.03 * Math.sin(t * 0.5);
        o.head[0] = 0.12;
        o.head[1] = 0.25 * Math.sin(t * 0.4);
        o.head[2] = 0.08 * Math.sin(t * 0.5);
        o.y = rig.plush ? -0.06 : 0.03;
        o.x = 0;
        o.back = rig.plush ? 0 : -rig.sole * 0.9;
        o.squash = rig.plush ? 0.08 : 0;
        break;
      }
      case 'dangle': {
        // held up: legs dangle and kick, arms up, flailing a little
        const k = Math.sin(t * 9);
        o.hipL = 0.12 + 0.3 * k;
        o.hipR = 0.12 - 0.3 * k;
        o.kneeL = 0.35 + 0.3 * Math.max(0, -k);
        o.kneeR = 0.35 + 0.3 * Math.max(0, k);
        arm(o.armL, -2.75 + 0.18 * Math.sin(t * 13), 0.45 + 0.15 * Math.sin(t * 11), -0.3);
        arm(o.armR, -2.75 + 0.18 * Math.sin(t * 13 + 2), 0.45 + 0.15 * Math.sin(t * 11 + 1), -0.3);
        o.lean = -0.05;
        o.twist = 0.08 * Math.sin(t * 4);
        o.tilt = 0.04 * k;
        o.head[0] = -0.12;
        o.head[1] = 0.1 * Math.sin(t * 3);
        o.head[2] = 0.06 * k;
        o.y = -rig.sole + 0.12;
        o.x = 0;
        o.back = 0;
        o.squash = -0.04;
        o.reachL = o.reachR = 1.1;
        break;
      }
      default: // (and 'land': standing, with a squash on top; see update)
        standPose(o, rig, t);
    }
    return speed;
  }

  return {
    stage,
    /** Pose the character for this frame. look = [x, y] cursor offsets (as the desk reads them). */
    update({ t, dt, d, robot, swingDeg, look }) {
      now = t;
      if (robot !== rigOf) {
        rigOf = robot;
        rig = legRig(robot);
        // the same size as at its desk (index.js ROBOT_SCALE)
        scale = deskScale;
        // first frame: straight into whatever it's doing (it's taking over mid-stride from the desk)
        gait = GAITS.has(d.gait) ? d.gait : 'stand';
        blend = 1;
      }
      const next = GAITS.has(d.gait) ? d.gait : 'stand';
      if (next !== gait) {
        copyPose(from, out);
        const walking = gait === 'walk' || gait === 'sleepwalk';
        gait = next;
        blend = 0;
        changedAt = t;
        if (!walking) phase = 0; // set off from standing, feet together
        if (gait === 'land') from.y = -rig.sole; // put down: on the ground at once (the squash does the rest)
      }
      blend = Math.min(1, blend + dt / BLEND);
      const speed = pose(want, t, d);
      if (gait === 'walk') phase += dt * Math.PI * 2 * speed; // a cycle is two steps: 2 steps/s at speed 1
      else if (gait === 'sleepwalk') phase += dt * Math.PI * 2 * 0.5 * speed;
      mixPose(out, from, want, smooth(blend));
      if (gait === 'land') {
        // put down: squash on touching down, spring back up and settle (on top of the blend,
        // so it shows straight away)
        const s = t - changedAt;
        const q = s < LAND ? 0.28 * Math.exp(-s * 8) * Math.cos(s * 17) : 0;
        out.squash += q;
        out.kneeL += Math.max(0, q) * 1.5;
        out.kneeR += Math.max(0, q) * 1.5;
        out.y -= Math.max(0, q) * 0.25;
        out.armL[1] += Math.max(0, q) * 1.2;
        out.armR[1] += Math.max(0, q) * 1.2;
      }

      // turn to face its heading
      const head = HEADINGS[d.heading] ?? 0;
      yaw += wrap(head - yaw) * ease(dt, 11);
      // swung by the drag (the page's --swing, as the desk reads it)
      const held = gait === 'dangle';
      swing = mix(swing, held ? THREE.MathUtils.degToRad(swingDeg) * 0.8 : 0, ease(dt, held ? 14 : 6));

      // ---- apply it
      const { root, torso, arms } = robot;
      for (const l of rig.legs) {
        const left = l.side < 0;
        l.hip.rotation.set(HALF_PI - (left ? out.hipL : out.hipR), 0, 0);
        l.knee.rotation.set(l.straight + (left ? out.kneeL : out.kneeR), 0, 0);
      }
      poseArm(arms.armL, out.armL, out.reachL);
      poseArm(arms.armR, out.armR, out.reachR);
      torso.rotation.set(out.lean + Math.sin(t * 2.2) * 0.01, out.twist, out.tilt);
      // eyes on the cursor while it faces you
      const facing = Math.max(0, Math.cos(yaw)) * (gait === 'sleepwalk' ? 0 : 1);
      robot.head.rotation.set(out.head[0] + look[1] * 0.05 * facing, out.head[1] + look[0] * 0.06 * facing, out.head[2]);
      robot.head.scale.setScalar(1);
      const height = (rig.top - rig.sole) * scale;
      const pivot = height * 0.9; // held by the scruff
      carry.position.y = pivot;
      carry.rotation.z = swing;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      root.position.set(out.x * fz * scale, out.y * scale - pivot, (-out.x * fx - out.back * Math.max(0, fz)) * scale);
      root.rotation.order = 'YXZ';
      root.rotation.set(0, yaw, 0);
      const sq = out.squash;
      root.scale.set(scale * (1 + sq * 0.6), scale * (1 - sq), scale * (1 + sq * 0.6));
      root.visible = true;

      // the shadow: under its feet, smaller and fainter as it's lifted off the ground
      const lift = Math.max(0, (out.y + rig.sole) * scale);
      const spread = rig.plush ? 0.8 : 0.62;
      const k = Math.max(0.35, 1 - lift * 2.5);
      shadow.scale.set(height * spread * k * (gait === 'sit' ? 1.35 : 1), height * 0.36 * k * (gait === 'sit' ? 1.6 : 1), 1);
      // (sitting: under it and its legs out in front)
      shadow.position.x = root.position.x + out.back * fx * scale * 0.5 + Math.sin(swing) * pivot * 0.5;
      shadow.position.z = root.position.z + out.back * fz * scale * 0.9;
      shadowMat.opacity = 0.9 * k;

      // a "z" floats up now and then while it sleepwalks
      if (gait === 'sleepwalk' && t > nextZ) {
        nextZ = t + 1.3;
        emit('z', worldPoint(robot.head, 0.25, (robot.headTop ?? 0.6) * 0.95, 0), { life: 2, vel: new THREE.Vector3(0.12, 0.25, 0), size: 0.13, grow: 2 });
      }
    },
    /** Is it busy moving (the frame loop runs faster)? */
    get lively() {
      return gait === 'land' ? now - changedAt < LAND + BLEND : gait !== 'stand' && gait !== 'sit';
    },
    dispose() {
      ground.removeFromParent();
      shadow.geometry.dispose();
      shadowMat.map.dispose();
      shadowMat.dispose();
    },
  };
}
