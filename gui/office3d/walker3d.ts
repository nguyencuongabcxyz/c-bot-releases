import { ease, mix, smooth, wrap } from '@/office3d/core/math';
import type { OfficeData } from './protocol';
import * as THREE from 'three';
import { canvasTexture, noOutline } from './materials';
import type { Rig, RigArm } from './types';
import type { Emit, TickCtx, Vec3Tuple } from './antics/types';
import {
  type LegRig,
  legRig,
  type WalkPose,
  newPose,
  mixPose,
  copyPose,
  arm,
  standPose,
  stridePose,
  hopPose,
  sleepwalkPose,
} from './walkpose';

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

// The solo window shows it just as big as at its desk, seen from the same height (so
// stepping out of the desk into the walker window doesn't change it), with the ground
// (y = 0) `feet` of the way down the picture.
export const SOLO = { feet: 0.9 };
// which way it faces (radians about the vertical; 0 = at the camera): a 3/4 view when
// walking sideways, so the face still shows
const HEADINGS: Partial<Record<string, number>> = { toward: 0, left: -1.0, right: 1.0, away: Math.PI };
// out walking, the empty chair is turned this far from the desk towards you (index.js, antics/walk.js)
export const AWAY_TURN = 0.45;
// (talk, tiptoe, clap: visiting another robot's desk, main social.js)
const GAITS = new Set<string>([
  'stand',
  'walk',
  'sleepwalk',
  'wave',
  'look',
  'sit',
  'dangle',
  'land',
  'talk',
  'tiptoe',
  'clap',
  'dust',
]);
const BLEND = 0.25; // seconds to switch gaits
const LAND = 0.4; // the squash on being put down

// ---------------------------------------------------------------- solo mode

function poseArm(a: RigArm, v: Vec3Tuple, reach: number) {
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
export type SoloView = { height: number; pxPerUnit: number; fov: number; pitch: number };
export function frameSolo(camera: THREE.PerspectiveCamera, { height, pxPerUnit, fov, pitch }: SoloView) {
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
export type WalkerOptions = { world: THREE.Object3D; emit: Emit; worldPoint: TickCtx['worldPoint']; scale: number };
/** What the solo frame hands the walker (update). */
export type WalkerFrame = {
  t: number;
  dt: number;
  d: OfficeData; // stateEl.dataset: gait, heading, speed
  robot: Rig;
  swingDeg: number; // the page's --swing
  look: [number, number]; // cursor offsets, as the desk reads them
};
export function createWalker({ world, emit, worldPoint, scale: deskScale }: WalkerOptions) {
  const ground = new THREE.Group();
  world.add(ground);
  const shadowMat = noOutline(
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
  );
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

  let rig!: LegRig; // (made on update's first frame, before pose() reads it)
  let rigOf: Rig | null = null;
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

  function pose(o: WalkPose, t: number, d: OfficeData) {
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
      case 'talk': {
        // chatting at another robot's desk: hands talking, head bobbing along
        standPose(o, rig, t);
        const g = Math.sin(t * 3.2);
        arm(o.armR, -0.9 + 0.35 * g, 0.35, -1.1 + 0.25 * Math.sin(t * 4.1));
        arm(o.armL, -0.35 + 0.2 * Math.sin(t * 2.3 + 1), 0.2, -0.6);
        o.head[0] = 0.05 * Math.sin(t * 5.3);
        o.head[2] = 0.08 * Math.sin(t * 1.4);
        o.tilt = 0.03 * g;
        break;
      }
      case 'tiptoe': {
        // creeping past a sleeping robot: small high steps on its toes, hands up by its chest
        if (rig.plush) hopPose(o, rig, phase);
        else stridePose(o, rig, phase);
        o.y += 0.025 + 0.01 * Math.abs(Math.sin(phase));
        arm(o.armL, -1.1, 0.25, -1.6);
        arm(o.armR, -1.1, 0.25, -1.6);
        o.lean = 0.12;
        o.head[0] = 0.1;
        break;
      }
      case 'clap': {
        // cheering on a robot at work: little claps in front, a bounce
        standPose(o, rig, t);
        const c = Math.abs(Math.sin(t * 7));
        arm(o.armL, -1.25, 0.18 + 0.32 * c, -1.0);
        arm(o.armR, -1.25, 0.18 + 0.32 * c, -1.0);
        o.y += 0.01 * c;
        o.head[0] = -0.05;
        break;
      }
      case 'dust': {
        // the evening housemaid wiping a desk: standing at its end, reaching up and forward with
        // the duster (left hand) onto the desk top and wiping it in long strokes, in and out,
        // leaning into each one, the other hand on its hip
        standPose(o, rig, t);
        const stroke = Math.sin(t * 4.2); // (out and back, about 1.5 s)
        const reach = 0.5 + 0.5 * stroke;
        arm(o.armL, -2.3 - 0.2 * reach, 0.12 + 0.06 * Math.sin(t * 8.4), -0.3 + 0.25 * reach);
        arm(o.armR, 0.1, 0.65, -1.7);
        o.head[0] = 0.04;
        o.head[1] = 0.06 * stroke;
        o.head[2] = 0.05 * Math.sin(t * 2.1);
        o.twist = 0.12 * stroke;
        o.lean = 0.1 + 0.1 * reach;
        o.y += 0.006 * Math.abs(Math.cos(t * 4.2));
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
    update({ t, dt, d, robot, swingDeg, look }: WalkerFrame) {
      now = t;
      if (robot !== rigOf) {
        rigOf = robot;
        rig = legRig(robot);
        // the same size as at its desk (index.js ROBOT_SCALE)
        scale = deskScale;
        // first frame: straight into whatever it's doing (it's taking over mid-stride from the desk)
        gait = d.gait && GAITS.has(d.gait) ? d.gait : 'stand';
        blend = 1;
      }
      const next = d.gait && GAITS.has(d.gait) ? d.gait : 'stand';
      if (next !== gait) {
        copyPose(from, out);
        const walking = gait === 'walk' || gait === 'sleepwalk' || gait === 'tiptoe';
        gait = next;
        blend = 0;
        changedAt = t;
        if (!walking) phase = 0; // set off from standing, feet together
        if (gait === 'land') from.y = -rig.sole; // put down: on the ground at once (the squash does the rest)
      }
      blend = Math.min(1, blend + dt / BLEND);
      const speed = pose(want, t, d);
      if (gait === 'walk')
        phase += dt * Math.PI * 2 * speed; // a cycle is two steps: 2 steps/s at speed 1
      else if (gait === 'sleepwalk') phase += dt * Math.PI * 2 * 0.5 * speed;
      else if (gait === 'tiptoe') phase += dt * Math.PI * 2 * 0.6 * speed;
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
      const head = HEADINGS[d.heading ?? ''] ?? 0;
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
      // the housemaid's duster: turned round in her hand to reach out along her arm as she wipes
      const duster = arms.armL.elbow.getObjectByName('duster');
      if (duster) duster.rotation.x = mix(duster.rotation.x, gait === 'dust' ? Math.PI : 0, ease(dt, 8));
      torso.rotation.set(out.lean + Math.sin(t * 2.2) * 0.01, out.twist, out.tilt);
      // eyes on the cursor while it faces you
      const facing = Math.max(0, Math.cos(yaw)) * (gait === 'sleepwalk' ? 0 : 1);
      robot.head.rotation.set(
        out.head[0] + look[1] * 0.05 * facing,
        out.head[1] + look[0] * 0.06 * facing,
        out.head[2],
      );
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
      shadow.scale.set(
        height * spread * k * (gait === 'sit' ? 1.35 : 1),
        height * 0.36 * k * (gait === 'sit' ? 1.6 : 1),
        1,
      );
      // (sitting: under it and its legs out in front)
      shadow.position.x = root.position.x + out.back * fx * scale * 0.5 + Math.sin(swing) * pivot * 0.5;
      shadow.position.z = root.position.z + out.back * fz * scale * 0.9;
      shadowMat.opacity = 0.9 * k;

      // a "z" floats up now and then while it sleepwalks
      if (gait === 'sleepwalk' && t > nextZ) {
        nextZ = t + 1.3;
        emit('z', worldPoint(robot.head, 0.25, (robot.headTop ?? 0.6) * 0.95, 0), {
          life: 2,
          vel: new THREE.Vector3(0.12, 0.25, 0),
          size: 0.13,
          grow: 2,
        });
      }
    },
    /** Is it busy moving (the frame loop runs faster)? */
    get lively() {
      return gait === 'land' ? now - changedAt < LAND + BLEND : gait !== 'stand' && gait !== 'sit';
    },
    dispose() {
      ground.removeFromParent();
      shadow.geometry.dispose();
      (shadowMat.map as THREE.Texture).dispose(); // (made with one: blobTexture)
      shadowMat.dispose();
    },
  };
}
export type Walker = ReturnType<typeof createWalker>;
