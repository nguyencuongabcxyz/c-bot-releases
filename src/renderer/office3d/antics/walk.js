import * as THREE from 'three';
import { LAYOUT } from '../scene.js';
import { FLOOR } from '../bed.js';
import { legRig, newPose, mixPose, standPose, stridePose, hopPose, sleepwalkPose, AWAY_TURN } from '../walker3d.js';

// Out for a walk: it gets up and leaves the desk (to stroll about the user's screen in
// its own window, walker3d.js), and comes back. Timings are a contract: robot.js cues
// sounds at them, sets data-away as stepout ends and plays stepin as it clears it.
//   stepout  4 s    stands up 0–0.5 (legs straighten, it rises), turns to screen-right
//                   0.4–0.7 and from 0.7 steps out walking (on the spot: from here on it's the
//                   walker window that travels). Asleep, the same sleepwalking (arms out, slower),
//                   from the chair or up off the floor. It doesn't vanish: at 0.7 robot.js hands
//                   it over to the walker window (already loaded, drawn at the same size with its
//                   feet on the same spot) and sets data-away, which hides it here; the length
//                   is just a long enough leash in case the walker is slow to come.
//   stepin   1.4 s  dropped back on the desk: there it stands, where it was dropped (data-antic-text
//                   "x,z" on the office floor; else right of the chair), the walker window gone,
//                   standing or sleepwalking; into the chair 0.3–1.0 (asleep on the
//                   floor: back into bed), settling 1.0–1.4, then exactly as it sits (or lies).
// Neither moves the robot to another parent: each frame it works out where the frame (and
// the bed) just put it, "home", and blends from or to its own path in the room, so the end of
// stepin is exactly home and anything cut short snaps straight back.

const OUT = { up: 0.5, turn: [0.4, 0.7], walk: 0.7 };
const IN = { walk: [0.3, 0.75], turn: [0.6, 0.85], sit: [0.75, 1.0], settle: [1.0, 1.4] };

// The camera looks at the desk along CAMERA.dir (index.js): its right, along the floor
const RIGHT = new THREE.Vector3(0.8, 0, -0.62).normalize();
const ENTRY = 0.72; // and where it pops back in (all of it in the window)
const FACE = 1.0; // walking sideways it turns its face this far back to you (a 3/4 view)

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s, a, b) => Math.min(1, Math.max(0, (s - a) / (b - a)));
const bump = (s, a, b) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const mix = (a, b, k) => a + (b - a) * k;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HALF_PI = Math.PI / 2;
const set3 = (a, x, y, z) => {
  a[0] = x;
  a[1] = y;
  a[2] = z;
};

// scratch, so nothing is allocated per frame
const HP = new THREE.Vector3();
const HQ = new THREE.Quaternion();
const HS = new THREE.Vector3();
const DP = new THREE.Vector3();
const DQ = new THREE.Quaternion();
const OQ = new THREE.Quaternion();
const M = new THREE.Matrix4();
const INV = new THREE.Matrix4();
const V = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// ---- helpers

/** Where the frame put the robot this frame (world), into HP / HQ / HS. */
function home(c) {
  const root = c.robot.root;
  if (root.parent === c.set.swivel) {
    // in the chair the frame sets only its height, slide and wobble: clear what we set last frame
    root.position.x = 0;
    root.rotation.x = root.rotation.y = 0;
  }
  root.updateWorldMatrix(true, false);
  root.matrixWorld.decompose(HP, HQ, HS);
}

/** Which way a quaternion faces along the floor (yaw). */
function yawOf(q) {
  V.copy(Z).applyQuaternion(q);
  return Math.atan2(V.x, V.z);
}

/**
 * Put the root at `w` of the way from home to standing at `at` (office space), facing
 * `yaw`, lifted `lift` (world) and scaled by `k`; home must be fresh (home()).
 */
function placeRoot(c, w, at, yaw, lift, k, squash = 0) {
  const { robot, set } = c;
  const root = robot.root;
  const office = set.office;
  office.updateWorldMatrix(true, false);
  DP.copy(at);
  DP.y += lift;
  office.localToWorld(DP);
  office.getWorldQuaternion(OQ);
  DQ.setFromAxisAngle(Y, yaw).premultiply(OQ);
  HP.lerp(DP, w);
  HQ.slerp(DQ, w);
  V.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6).multiplyScalar(mix(1, k, w));
  HS.multiply(V);
  M.compose(HP, HQ, HS).premultiply(INV.copy(root.parent.matrixWorld).invert());
  M.decompose(root.position, root.quaternion, root.scale);
}

/** Straighten (w = 1) or bend (0) the legs into pose P, and blend the arms and body. */
function poseLimbs(c, P, w) {
  const { robot } = c;
  const rig = c.run.rig;
  for (const l of rig.legs) {
    const left = l.side < 0;
    l.hip.rotation.set(mix(0, HALF_PI - (left ? P.hipL : P.hipR), w), 0, 0);
    l.knee.rotation.set(mix(0, l.straight + (left ? P.kneeL : P.kneeR), w), 0, 0);
  }
  // the arms after the frame (and the bed, which tucks them in) have set them: blend on top
  for (const key of ['armL', 'armR']) {
    const a = robot.arms[key];
    const v = P[key];
    a.shoulder.rotation.set(mix(a.shoulder.rotation.x, v[0], w), 0, mix(a.shoulder.rotation.z, v[1] * a.side, w));
    a.shoulder.scale.y = mix(a.shoulder.scale.y, 1, w);
    a.elbow.rotation.x = mix(a.elbow.rotation.x, v[2], w);
  }
  robot.torso.rotation.y = P.twist * w;
  robot.torso.rotation.z = P.tilt * w;
}

/** Roll the chair (aside for the floor bed) back towards its place: hold it at most `k` aside. */
function holdChair(c, k) {
  const bed = c.bed;
  if (!bed || bed.aside <= k) return;
  bed.aside = k;
  c.set.swivel.parent.position.x = LAYOUT.chair.x + FLOOR.chairAside * smooth(k);
}

/** The run's setup: the legs, how tall it stands, where it gets up from (office space). */
function start(c) {
  const { run, robot } = c;
  run.rig = legRig(robot);
  run.pose = newPose();
  run.stand = newPose();
  // asleep on the floor: up out of bed, or back into it
  run.floor = c.asleep && c.sleepStyle === 'floor' && !!c.bed;
  run.awayYaw = c.monitorYaw + (c.camYaw - c.monitorYaw) * AWAY_TURN;
  run.at = new THREE.Vector3();
  run.spot = new THREE.Vector3();
  run.far = new THREE.Vector3();
}

/** Where it stands as it gets up (office space): just off the front of the seat, facing
 *  you, or up off the floor where it lay; and how far it goes off right (or comes in from)
 *  from the front of the seat either way. */
function spotFrom(c, out, far, by) {
  out.set(LAYOUT.chair.x + Math.sin(c.camYaw) * 0.32, 0, LAYOUT.chair.z + Math.cos(c.camYaw) * 0.32);
  far.copy(out).addScaledVector(RIGHT, by);
  if (c.run.floor) out.set(FLOOR.hips.x + 0.08, 0, FLOOR.hips.z + 0.35); // (clear of the chair's wheels)
}

// ---------------------------------------------------------------- stepout

const stepout = {
  dur: 4,
  fadeIn: 0,
  fadeOut: 0,
  update(c, A) {
    const { s, run } = c;
    if (!run.rig) start(c);
    const P = run.pose;
    const rig = run.rig;
    const up = smooth(seg(s, 0, OUT.up));
    // walking off: awake a brisk walk; asleep a slow shuffle, arms out (the walker's own paces)
    const w = s - OUT.walk;
    const stride = smooth(seg(s, OUT.walk - 0.05, OUT.walk + 0.12));
    if (c.asleep) sleepwalkPose(P, rig, Math.max(0, w) * Math.PI * 2 * 1.0, c.t);
    else if (rig.plush) hopPose(P, rig, Math.max(0, w) * Math.PI * 2);
    else stridePose(P, rig, Math.max(0, w) * Math.PI * 2);
    // before it sets off: just standing (sleepwalkers already have their arms out)
    standPose(run.stand, rig, c.t);
    if (c.asleep) for (const key of ['armL', 'armR', 'head']) set3(run.stand[key], ...P[key]);
    mixPose(P, run.stand, P, stride);
    // getting up: a lean forward to push off the seat
    P.lean += 0.35 * bump(s, 0.02, OUT.up);
    A.lean = mix(A.lean, P.lean, up);
    for (let i = 0; i < 3; i++) A.head[i] = mix(A.head[i], P.head[i], up);
    // the empty chair turns as it goes, to how it'll stand while it's out
    A.yaw += (run.awayYaw - c.curYaw) * smooth(seg(s, OUT.up, OUT.walk + 0.7));
  },

  place(c) {
    const { s, run, robot } = c;
    if (!run.rig) return;
    const root = robot.root;
    home(c);
    if (!run.set) {
      // where it gets up from, and where it walks off to
      run.set = true;
      spotFrom(c, run.spot, run.far, 0);
      run.yaw0 = c.camYaw;
      run.walkYaw = Math.atan2(RIGHT.x, RIGHT.z);
    }
    const up = smooth(seg(s, 0, OUT.up));
    // where it got up: from here it's the walker window that moves
    run.at.copy(run.spot);
    // turn to screen-right, the face still turned a little back your way
    const yaw = run.yaw0 + wrap(run.walkYaw - FACE * 0.55 - run.yaw0) * smooth(seg(s, ...OUT.turn));
    const lift = run.pose.y * HS.y + 0.08 * bump(s, 0.05, OUT.up) * HS.y;
    poseLimbs(c, run.pose, up);
    placeRoot(c, up, run.at, yaw, lift, 1);
    // up off the floor: it kicks the blanket off, and the chair rolls back out of its way
    if (run.floor) {
      const props = c.bed?.props(c.set);
      if (props) props.blanket.scale.y *= 1 - 0.75 * up;
      holdChair(c, 1 - smooth(seg(s, 0.25, OUT.walk + 0.2)));
    }
  },

  end(c) {
    const { run, robot, set } = c;
    if (!run?.rig) return;
    run.rig.restore();
    const root = robot?.root;
    if (!root) return;
    // back in its chair as the frame expects it (by now data-away hides it: the walker has it)
    if (root.parent === set?.swivel) {
      root.position.x = 0;
      root.rotation.set(0, 0, 0);
    }
  },
};

// ---------------------------------------------------------------- stepin

const stepin = {
  dur: 1.4,
  fadeIn: 0,
  fadeOut: 0,
  update(c, A) {
    const { s, run } = c;
    if (!run.rig) start(c);
    const P = run.pose;
    const rig = run.rig;
    const w = s - IN.walk[0];
    if (c.asleep) sleepwalkPose(P, rig, s * Math.PI * 2 * 1.0, c.t);
    else {
      const walking = smooth(seg(s, IN.walk[0] - 0.05, IN.walk[0] + 0.1)) * (1 - smooth(seg(s, IN.walk[1] - 0.05, IN.walk[1] + 0.1)));
      if (rig.plush) hopPose(P, rig, Math.max(0, w) * Math.PI * 2 * 1.8);
      else stridePose(P, rig, Math.max(0, w) * Math.PI * 2 * 1.8);
      standPose(run.stand, rig, c.t);
      mixPose(P, run.stand, P, walking);
      // the hop up into the seat: tuck the legs
      P.kneeL += 0.6 * bump(s, IN.sit[0], IN.sit[1]);
      P.kneeR += 0.6 * bump(s, IN.sit[0], IN.sit[1]);
    }
    const out = 1 - smooth(seg(s, ...IN.sit)); // how much it's still out of the chair
    A.lean = mix(A.lean, P.lean, out);
    for (let i = 0; i < 3; i++) A.head[i] = mix(A.head[i], P.head[i], out);
  },

  place(c) {
    const { s, run, robot } = c;
    if (!run.rig) return;
    const root = robot.root;
    home(c);
    if (!run.set) {
      run.set = true;
      spotFrom(c, run.spot, run.far, ENTRY);
      // put down somewhere on the desk's floor: it walks to its chair from there (not too far off)
      const [x, z] = String(c.text || '').split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(z)) {
        run.far.set(x, 0, z).sub(run.spot);
        run.far.clampLength(0, 1.2).add(run.spot);
      }
      run.walkYaw = Math.atan2(run.spot.x - run.far.x, run.spot.z - run.far.z) || Math.atan2(-RIGHT.x, -RIGHT.z); // towards the chair
    }
    // back into bed: the chair waits where it is till it's at the bed, then rolls aside;
    // the blanket's tucked back over once it's lying down
    if (run.floor) {
      holdChair(c, smooth(seg(s, IN.sit[0] - 0.1, IN.settle[0] + 0.1)));
      const props = c.bed?.props(c.set);
      if (props) {
        const tuck = smooth(seg(s, IN.sit[1] - 0.05, IN.settle[1] - 0.05));
        props.blanket.position.y = 0.45 * (1 - tuck);
        props.blanket.scale.y *= Math.max(0.001, tuck);
        props.blanket.visible = tuck > 0.01;
        props.pillow.scale.setScalar(1);
      }
    }
    const out = 1 - smooth(seg(s, ...IN.sit));
    const go = smooth(seg(s, ...IN.walk));
    run.at.lerpVectors(run.far, run.spot, go);
    // facing back towards the chair (3/4, its face your way), then round to sit down
    const sitYaw = run.floor ? c.camYaw : yawOf(HQ) - yawOf(c.set.office.getWorldQuaternion(OQ));
    const walkYaw = run.walkYaw + FACE * 0.55;
    const yaw = walkYaw + wrap(sitYaw - walkYaw) * smooth(seg(s, ...IN.turn));
    // just put down: a little squash as it lands
    const k = 1;
    const land = s < 0.3 ? 0.18 * Math.exp(-s * 12) * Math.cos(s * 22) : 0;
    // the hop into the seat (or flop into bed), then a bounce settling down
    const hop = 0.16 * bump(s, IN.sit[0], IN.sit[1] + 0.05) * HS.y;
    const u = s - IN.settle[0];
    const settle = u > 0 ? 0.13 * Math.exp(-u * 7) * Math.sin(u * 20) * (1 - smooth(seg(s, IN.settle[1] - 0.15, IN.settle[1]))) : 0;
    const lift = run.pose.y * HS.y * k + hop;
    poseLimbs(c, run.pose, out);
    placeRoot(c, out, run.at, yaw, lift, k, settle + land);
  },

  end(c) {
    const { run, robot, set } = c;
    if (!run?.rig) return;
    run.rig.restore();
    const root = robot?.root;
    if (root && root.parent === set?.swivel) {
      root.position.x = 0;
      root.rotation.set(0, 0, 0);
    }
    const props = c.bed?.props(set);
    if (props) {
      props.blanket.visible = true;
      props.pillow.scale.setScalar(1);
    }
  },
};

export const WALK = { stepout, stepin };
