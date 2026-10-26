import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { toon, glow, canvasTexture, roundRect } from '@/office3d/materials';
import type { Antic, AnticCtx, AnticPose } from './types';

// IT-office antics, awake and idle: meditating through a merge conflict, the
// daily stand-up (it really stands up), juggling Jira tickets, "works on my
// machine" (and a hug for the machine), and one coffee too many.
// Timings are a contract: robot.js plays sounds and speech at the marked moments.
// Everything moves the shared rig only (root, torso, head, arms; the legs only
// as push-ups do), so it works for every body.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)

type Side = 'L' | 'R';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a)); // eases 0 -> 1 over [a, b]
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (p: THREE.Vector3) => Math.atan2(p.x - LAYOUT.chair.x, p.z - LAYOUT.chair.z);
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);
// true the first frame at or past `at` (one-shot emits, whatever the frame rate)
const once = (c: AnticCtx, key: string, at: number) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);
// a prop popping in (a little overshoot) at a and away again at b
const popIn = (s: number, a: number, b: number) => (s < a ? 0 : s < a + 0.15 ? easeOut((s - a) / 0.15) * 1.15 : s < a + 0.25 ? 1.15 - 1.5 * (s - a - 0.15) : s < b ? 1 : Math.max(0, 1 - (s - b) / 0.15));

// Key-framed values: start from `from`, then ease toward each [t0, t1, to] in turn.
function track(s: number, from: number, keys: [number, number, number][]) {
  let v = from;
  for (const [a, b, to] of keys) v = mix(v, to, seg(s, a, b));
  return v;
}
function pose(out: number[], from: readonly number[], s: number, keys: [number, number, readonly number[]][]) {
  for (let i = 0; i < 3; i++) out[i] = from[i];
  for (const [a, b, to] of keys) {
    const k = seg(s, a, b);
    if (k > 0) for (let i = 0; i < 3; i++) out[i] = mix(out[i], to[i], k);
  }
  return out;
}
function lerp3(out: number[], target: readonly number[], k: number) {
  for (let i = 0; i < 3; i++) out[i] = mix(out[i], target[i], k);
}
const blend = (A: AnticPose, key: 'armL' | 'armR' | 'head', target: readonly number[], w: number) => lerp3(A[key], target, w);

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const PL = [0, 0, 0];
const PR = [0, 0, 0];
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const E1 = new THREE.Euler();
const M1 = new THREE.Matrix4();
const M2 = new THREE.Matrix4();
const BOX = new THREE.Box3();
const B2 = new THREE.Box3();
const SKULL = new THREE.Box3();
const X_AXIS = new THREE.Vector3(1, 0, 0);

// A point on a part of the robot, in office space (= the world group the
// particles and the mug live in).
const at = (c: AnticCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c: AnticCtx, side: Side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
const handAt = (c: AnticCtx, side: Side, out: THREE.Vector3) => at(c, armOf(c, side).elbow, 0, -HAND, 0, out);
const scaleOf = (c: AnticCtx) => c.robot.root.scale.x / 0.82; // props grow with the robot

// Arm angles [pitch, out, elbow] that put a hand on a point (office space): a
// two-bone reach worked out in the torso's frame (as awake.js). Returns the
// stretch (A.reachL/R) that makes up what the arm can't reach.
function aim(c: AnticCtx, side: Side, p: THREE.Vector3, out: number[], most = 1.9) {
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

// The monitor is right behind the chair as you see it, so facing it means showing
// you its back: turn at most `most` towards it (the short way round) and let the
// head look the rest of the way, at most `look`. Returns [body, head] yaw.
const TURN = [0, 0];
function towardScreen(c: AnticCtx, most: number, look: number) {
  const rel = wrap(c.monitorYaw - c.curYaw);
  TURN[0] = clamp(rel, -most, most);
  TURN[1] = clamp(rel - TURN[0], -look, look);
  return TURN;
}

// The head's size, in head space (left/right of it, its middle, its front), from its
// meshes; hats, antennae and the hidden headband don't count. Bodies differ a lot.
// (three's types leave the isMesh flag off Object3D)
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => 'isMesh' in o;
function headBox(c: AnticCtx) {
  const { head } = c.robot;
  head.updateWorldMatrix(true, true);
  M1.copy(head.matrixWorld).invert();
  BOX.makeEmpty();
  SKULL.makeEmpty();
  let most = 0;
  const skip: THREE.Object3D[] = [c.robot.antenna, c.robot.accessory, c.robot.headband];
  (function walk(o: THREE.Object3D) {
    if (!o.visible || skip.includes(o)) return;
    if (isMesh(o) && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      B2.copy(o.geometry.boundingBox!).applyMatrix4(M2.multiplyMatrices(M1, o.matrixWorld)); // (computed just above)
      BOX.union(B2);
      // the skull: the biggest single piece (not the hair's pigtails, the ears)
      const vol = (B2.max.x - B2.min.x) * (B2.max.y - B2.min.y) * (B2.max.z - B2.min.z);
      if (vol > most) {
        most = vol;
        SKULL.copy(B2);
      }
    }
    for (const k of o.children) walk(k);
  })(head);
  const top = c.robot.headTop ?? 0.6;
  if (BOX.isEmpty()) return { hw: 0.36, cy: top * 0.5, cz: 0, front: 0.3, top };
  return { hw: Math.max(-SKULL.min.x, SKULL.max.x), cy: (SKULL.min.y + SKULL.max.y) / 2, cz: (SKULL.min.z + SKULL.max.z) / 2, front: BOX.max.z, top };
}

// The sitting legs (as pushup.js finds them): each hip group has its thigh forward
// and everything below the knee hanging down. bendLegs(k) swings the thighs down
// and unfolds the knees together (the shins stay upright), 0 sitting .. 1 standing.
type HeadBox = ReturnType<typeof headBox>;
type Leg = { hip: THREE.Object3D; q: THREE.Quaternion; knee: THREE.Vector3; parts: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[] };
function legRig(c: AnticCtx) {
  const legs: Leg[] = [];
  for (const hip of c.robot.root.children) {
    if (hip === c.robot.torso || isMesh(hip) || Math.abs(hip.position.x) < 0.05) continue;
    const thigh = hip.children.find((o) => o.position.y > -0.05 && o.position.z > 0.08);
    const below = hip.children.filter((o) => o.position.y < -0.03);
    if (!thigh || !below.length) continue;
    legs.push({
      hip,
      q: hip.quaternion.clone(),
      knee: new THREE.Vector3(0, thigh.position.y, Math.min(...below.map((o) => o.position.z))),
      parts: below.map((o) => ({ o, p: o.position.clone(), q: o.quaternion.clone() })),
    });
  }
  return legs;
}
function bendLegs(legs: Leg[], k: number) {
  Q1.setFromAxisAngle(X_AXIS, (k * Math.PI) / 2);
  Q2.setFromAxisAngle(X_AXIS, (-k * Math.PI) / 2);
  for (const L of legs) {
    L.hip.quaternion.copy(Q1).multiply(L.q);
    for (const { o, p, q } of L.parts) {
      o.position.copy(p).sub(L.knee).applyQuaternion(Q2).add(L.knee);
      o.quaternion.copy(Q2).multiply(q);
    }
  }
}
// the lowest point of the legs, in root space
function legsBottom(c: AnticCtx, legs: Leg[]) {
  const { root } = c.robot;
  root.updateMatrixWorld(true);
  M1.copy(root.matrixWorld).invert();
  BOX.makeEmpty();
  for (const { hip } of legs) {
    hip.traverse((o) => {
      if (!isMesh(o) || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      BOX.union(B2.copy(o.geometry.boundingBox!).applyMatrix4(M2.multiplyMatrices(M1, o.matrixWorld))); // (computed just above)
    });
  }
  return BOX.isEmpty() ? -0.55 : BOX.min.y;
}

// (meshes and sprites carry a material, maybe with a texture; three's Object3D type doesn't say so)
type Mapped = THREE.Material & { map?: THREE.Texture | null };
type Dressed = THREE.Object3D & { material?: Mapped | Mapped[] };
function dispose(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o: Dressed) => {
    if (isMesh(o)) o.geometry.dispose(); // (sprites share one geometry: leave it)
    if (!o.material) return;
    for (const m of ([] as Mapped[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

// ------------------------------------------------------------ merge conflict

// Leans in to the screen (0–1.0): <<<<<<< HEAD. Clutches its head and shakes it
// (1.2–3.0). Then lets it go: upright, hands on its knees, a slow breath in and
// out with its eyes shut (3.2–5.6; robot.js does the face).
type MergeRun = { hb?: HeadBox };

const merge: Antic<MergeRun> = {
  dur: 6.0,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    A.screen = 'merge';
    const hb = (run.hb ||= headBox(c));
    const peer = seg(s, 0, 1.0) * (1 - seg(s, 1.05, 1.45));
    const clutch = seg(s, 1.0, 1.25) * (1 - seg(s, 2.95, 3.25));
    const zen = seg(s, 3.1, 3.5);
    // side-on to the screen, peering round at it over its shoulder, then back round to you
    const [body, look] = towardScreen(c, 0.65, 0.4);
    A.yaw = body * peer * c.w;
    // the breath: in (3.3–4.45), out (–5.6)
    const breath = s > 3.3 && s < 5.6 ? Math.sin(((s - 3.3) / 2.3) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5 : 0;
    const shake = Math.sin((s - 1.25) * 15) * 0.38 * seg(s, 1.2, 1.4) * (1 - seg(s, 2.75, 3.0));
    A.lean = mix(A.lean, A.lean + 0.2 * peer + 0.14 * clutch + (-0.04 - A.lean - 0.1 * breath) * zen, c.w);
    A.rootY += 0.05 * breath * zen * c.w;
    HEAD[0] = A.head[0] + 0.12 * peer + 0.12 * clutch - (0.08 + 0.12 * breath) * zen;
    HEAD[1] = A.head[1] + look * peer + shake;
    HEAD[2] = A.head[2] + 0.06 * clutch;
    blend(A, 'head', HEAD, c.w);
    // hands: on the sides of its head, then resting on its knees, palms up
    for (const [side, key, out, sd] of [['L', 'armL', QL, -1], ['R', 'armR', QR, 1]] as const) {
      const head = aim(c, side, at(c, c.robot.head, sd * (hb.hw + 0.03), hb.cy, hb.cz + 0.1, V1), out, 1.5);
      for (let i = 0; i < 3; i++) PL[i] = mix(A[key][i], out[i], clutch);
      aim(c, side, at(c, c.robot.root, sd * 0.2, 0.2 + 0.03 * breath, 0.3, V1), PR);
      PR[1] += 0.12; // elbows out a little
      for (let i = 0; i < 3; i++) PL[i] = mix(PL[i], PR[i], zen);
      blend(A, key, PL, c.w);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, head, clutch * c.w);
    }
    if (once(c, 'exhale', 4.6)) {
      // a long breath out, away from the face
      const mouth = at(c, c.robot.head, 0, hb.cy * 0.6, hb.front + 0.05, V1);
      const dir = at(c, c.robot.head, 0, hb.cy * 0.6 - 0.3, hb.front + 1.0, V2).sub(mouth).normalize();
      c.emit('steam', mouth, { life: 0.9, vel: dir.multiplyScalar(0.4).clone(), size: 0.07, grow: 2.2 });
    }
  },
};

// ------------------------------------------------------------ stand-up

// Gets up out of the chair (0.3–1.0) and stands in front of it, a tiny laptop
// open on its left hand, talking with its right: robot.js says three lines at
// 1.0, 2.8 and 4.6. Sits back down 5.8–6.8.
const LAPTOP_SIZE = 1.5;

function buildLaptop() {
  const g = new THREE.Group(); // origin: the middle of the base's underside
  const shell = toon('#c9ced9');
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.014, 0.17), shell);
  base.position.y = 0.007;
  g.add(base);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.09), toon('#3a3f52'));
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(0, 0.0145, 0.015);
  g.add(deck);
  // the lid, hinged at the far edge, screen towards the robot, stickers towards you
  const back = canvasTexture(256, 170, (ctx, w, h) => {
    ctx.fillStyle = '#c9ced9';
    ctx.fillRect(0, 0, w, h);
    const sticker = (x: number, y: number, r: number, fill: string, text: string, ink = '#fff', rot = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = fill;
      roundRect(ctx, -r, -r * 0.62, r * 2, r * 1.24, 12);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.font = `800 ${Math.round(r * 0.62)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 2);
      ctx.restore();
    };
    sticker(70, 52, 48, '#2b6fe0', '</>', '#fff', -0.15);
    sticker(184, 64, 46, '#5dd39e', 'LGTM', '#1d2235', 0.12);
    sticker(118, 124, 44, '#ff5e62', 'NO BUGS', '#fff', -0.05);
  });
  const screen = canvasTexture(256, 170, (ctx, w, h) => {
    ctx.fillStyle = '#1d2235';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9fb0ff';
    ctx.font = '700 20px "Segoe UI", sans-serif';
    ctx.fillText('SPRINT 42', 12, 26);
    const cards = ['#ffe066', '#ff9ec7', '#7bed9f'];
    for (let col = 0; col < 3; col++) {
      ctx.fillStyle = '#2c3350';
      ctx.fillRect(10 + col * 82, 38, 74, 124);
      for (let i = 0; i < 3 - col; i++) {
        ctx.fillStyle = cards[(col + i) % 3];
        ctx.fillRect(16 + col * 82, 46 + i * 36, 62, 28);
      }
    }
  });
  const lid = new THREE.Group();
  lid.position.set(0, 0.014, 0.085);
  lid.rotation.x = 0.2; // opened a little past upright
  const face = new THREE.MeshToonMaterial({ map: back.tex });
  lid.add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.17, 0.008), [shell, shell, shell, shell, face, glow('#ffffff', { map: screen.tex })]).translateY(0.085));
  g.add(lid);
  g.traverse((o) => isMesh(o) && (o.castShadow = true));
  return g;
}

const TALK = [-0.95, 0.3, -1.25]; // forearm up, hand open, about chest height
const OUT_THERE = [-1.25, 0.95, -0.35]; // "yesterday…": a sweep out to the side
const ONE_THING = [-2.55, 0.25, -0.55]; // "…one blocker": a finger up
const ROOT_FWD = 0.36; // stands in front of the seat, not on it

// (standY, fwd and the laptop are made along with legs, on the first frame)
type StandRun = { legs?: Leg[]; standY: number; fwd: number; laptop: THREE.Group };

const standup: Antic<StandRun> = {
  dur: 7.0,
  fadeIn: 0.3,
  fadeOut: 0.3,
  update(c, A) {
    const { s, run } = c;
    if (!run.legs) {
      // measure once: how far the root must rise for its feet to touch the floor
      run.legs = legRig(c);
      bendLegs(run.legs, 1);
      const bottom = legsBottom(c, run.legs);
      bendLegs(run.legs, 0);
      c.set.swivel.getWorldPosition(V1);
      const seatY = c.set.office.worldToLocal(V1).y;
      // (a body without legs it can straighten, a custom model, just rises a little)
      run.standY = run.legs.length ? Math.max(0, -seatY - 0.09 - c.robot.root.scale.y * bottom) : 0.08;
      run.fwd = run.legs.length ? ROOT_FWD : 0;
      run.laptop = buildLaptop();
      c.set.office.add(run.laptop);
    }
    // up 0.3–1.0 (a lean forward to get going), down 5.8–6.8 (a lean to sit)
    const up = seg(s, 0.3, 1.0) * (1 - seg(s, 5.8, 6.8));
    bendLegs(run.legs, up);
    A.rootY += run.standY * up;
    A.rootZ += run.fwd * smooth(up * 1.4);
    const heave = bump(s, 0.2, 1.0) + bump(s, 5.75, 6.75);
    A.lean = mix(A.lean, mix(A.lean, 0.02, up) + 0.3 * heave, c.w);

    // talking: a beat for each line, glancing down at the laptop now and then
    const talk = seg(s, 0.9, 1.2) * (1 - seg(s, 5.6, 5.9));
    const sweep = seg(s, 1.0, 1.3) * (1 - seg(s, 2.1, 2.5));
    const tap = seg(s, 2.8, 3.05) * (1 - seg(s, 3.6, 3.9));
    const one = seg(s, 4.6, 4.85) * (1 - seg(s, 5.4, 5.7));
    for (let i = 0; i < 3; i++) PR[i] = TALK[i];
    PR[2] += Math.sin(s * 5.2) * 0.3;
    PR[1] += Math.sin(s * 3.1) * 0.12;
    lerp3(PR, OUT_THERE, sweep);
    // "as you can see…": points at its screen
    const r = aim(c, 'R', at(c, run.laptop, 0.09, 0.22, 0.06, V1), QR, 1.4);
    lerp3(PR, QR, tap);
    lerp3(PR, ONE_THING, one);
    PR[1] += Math.sin(s * 9) * 0.08 * one; // wagging it
    blend(A, 'armR', PR, talk * c.w);
    A.reachR = mix(A.reachR, r, tap * talk * c.w);
    // the left hand holds the laptop out in front of its tummy
    at(c, c.robot.torso, -0.06, 0.13, 0.36, V1);
    aim(c, 'L', V1, QL);
    const hold = seg(s, 0.75, 1.0) * (1 - seg(s, 5.65, 5.95));
    blend(A, 'armL', QL, hold * c.w);
    // looking round the team, down at the laptop for the second line
    HEAD[0] = A.head[0] - 0.08 * up + 0.32 * bump(s, 2.75, 3.75) + 0.15 * heave;
    HEAD[1] = A.head[1] + Math.sin((s - 1.0) * 1.3) * 0.28 * talk;
    HEAD[2] = A.head[2] + 0.08 * one;
    blend(A, 'head', HEAD, c.w);

    // the laptop sits on its hand (pops in once it's up, away as it sits)
    const { laptop } = run;
    const size = popIn(s, 0.85, 5.7);
    laptop.visible = size > 0.01;
    handAt(c, 'L', laptop.position);
    c.robot.torso.getWorldQuaternion(laptop.quaternion);
    laptop.translateY(0.06 * scaleOf(c));
    laptop.translateZ(0.02 * scaleOf(c));
    laptop.scale.setScalar(Math.max(0.001, size * LAPTOP_SIZE * scaleOf(c)));
  },
  end(c) {
    const run = c.run;
    if (!run) return;
    if (run.legs) bendLegs(run.legs, 0);
    dispose(run.laptop);
  },
};

// ------------------------------------------------------------ jira juggling

// Three tickets pop into its hands (0.1–0.4) and it juggles them over its head,
// a hand going up with each throw (0.5–4.0). The last throw goes wrong: URGENT!
// slaps flat onto its face at 4.0 (the other two drop in its lap), stays there
// till 5.0, then it peels it off (5.0–5.4) and the lot pop away.
const NOTES = [['URGENT!', '#ffb347'], ['TODO', '#ff9ec7'], ['BUG-404', '#ffe066']];
// with notes of your own (robot.js passes up to three titles as "a|b|c" in data-antic-text),
// it juggles those instead: the first word or two of each
const shortTitle = (t: string) => {
  const words = t.replace(/\s+/g, ' ').trim().split(' ');
  const two = words.slice(0, 2).join(' ');
  return (two.length <= 14 ? two : words[0]).slice(0, 14);
};
const NOTE = 0.23;
const T0 = 0.5; // the first throw
const BEAT = 3.5 / 11; // a throw every beat, two beats in the air: the face one lands at 4.0
const LAST = [9, 7, 8]; // each ticket's last throw (beats); 9 is the one that hits the face
const HIT = 4.0;
const throwSide = (k: number) => (k % 2 ? 1 : -1); // even beats from the left hand, odd from the right

function buildNote(text: string, color: string) {
  const tex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; // the sticky strip
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#1d2235';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 92;
    do ctx.font = `900 ${size--}px "Segoe UI", sans-serif`;
    while (size > 30 && ctx.measureText(text).width > w - 28);
    ctx.fillText(text, w / 2, h / 2 + 10);
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(29,34,53,0.45)';
    ctx.beginPath();
    ctx.moveTo(40, 200);
    ctx.lineTo(w - 70, 200);
    ctx.stroke();
  });
  const paper = toon(color);
  const note = new THREE.Mesh(new THREE.BoxGeometry(NOTE, NOTE, 0.004), [paper, paper, paper, paper, new THREE.MeshToonMaterial({ map: tex.tex }), paper]);
  note.castShadow = true;
  return note;
}

// where a ticket is at time s: 'hand' (and which), 'air' (thrown at beat k, f of the way), or the face
type AirState = { mode: 'air'; k: number; f: number };
type NoteState = { mode: 'hand'; side: number } | AirState | { mode: 'face'; side: number };
function noteState(i: number, s: number): NoteState {
  const u = (s - T0) / BEAT;
  if (u < i) return { mode: 'hand', side: throwSide(i) };
  let k = i;
  while (k + 3 <= LAST[i] && k + 3 <= u) k += 3;
  const f = (u - k) / 2;
  if (f < 1) return { mode: 'air', k, f };
  return { mode: k === 9 ? 'face' : 'hand', side: -throwSide(k) };
}

// (hb and dropFrom are made along with the notes, on the first frame)
type JiraRun = { notes?: ReturnType<typeof buildNote>[]; hb: HeadBox; dropFrom: THREE.Vector3[] };

const jira: Antic<JiraRun> = {
  dur: 5.5,
  fadeOut: 0.2,
  update(c, A) {
    const { s, run } = c;
    const sc = scaleOf(c);
    if (!run.notes) {
      run.hb = headBox(c);
      const titles = String(c.text || '').split('|').map((t) => t.trim()).filter(Boolean);
      run.notes = NOTES.map(([text, color], i) => buildNote(titles[i] ? shortTitle(titles[i]) : text, color));
      for (const n of run.notes) c.set.office.add(n);
      run.dropFrom = [];
    }
    const { hb } = run;
    const { torso, head, root } = c.robot;
    // in torso space: the hands' spots either side, the top of the loop over its head
    const R = hb.hw + 0.17;
    const yH = armOf(c, 'R').shoulder.position.y - 0.08;
    const zH = 0.34;
    const apex = head.position.y + hb.top + 0.3;
    const u = (s - T0) / BEAT;
    const juggling = seg(s, 0.1, 0.45) * (1 - seg(s, HIT, HIT + 0.15));

    // the hands: up with each throw, a little give with each catch
    for (const [side, key, out, sd] of [['L', 'armL', QL, -1], ['R', 'armR', QR, 1]] as const) {
      let lift = 0;
      for (let k = sd < 0 ? 0 : 1; k <= 9; k += 2) lift += bump(u, k - 0.55, k + 0.45);
      at(c, torso, sd * (R - 0.06 * lift), yH + 0.17 * lift, zH, V1);
      const r = aim(c, side, V1, out, 1.5);
      // after the splat: a startled flinch, then the arms drop (the right one peels it off)
      const flinch = bump(s, HIT, HIT + 0.45);
      out[0] -= 0.5 * flinch;
      out[1] += 0.4 * flinch;
      pose(PL, A[key], s, [[0.1, 0.45, out]]);
      if (s > HIT) for (let i = 0; i < 3; i++) PL[i] = mix(out[i], A[key][i], seg(s, HIT + 0.3, HIT + 0.8));
      blend(A, key, PL, c.w);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, juggling * c.w);
    }
    // peel: the right hand to the note's corner, then away with it
    const peel = seg(s, 5.0, 5.15) * (1 - seg(s, 5.3, 5.5));
    if (peel > 0) {
      at(c, head, hb.hw * 0.25, hb.cy + NOTE * 0.35, hb.front + 0.03 + 0.25 * seg(s, 5.15, 5.35), V1);
      const r = aim(c, 'R', V1, QR, 1.6);
      blend(A, 'armR', QR, peel * c.w);
      A.reachR = mix(A.reachR, r, peel * c.w);
    }
    // eyes up on the tickets; knocked back by the splat
    HEAD[0] = A.head[0] - 0.22 * juggling - 0.25 * bump(s, HIT, HIT + 0.35) + 0.04 * Math.sin(u * Math.PI) * juggling;
    HEAD[1] = A.head[1] + Math.sin(u * Math.PI) * 0.1 * juggling;
    HEAD[2] = A.head[2] + 0.12 * seg(s, HIT + 0.3, HIT + 0.6) * (1 - seg(s, 5.0, 5.3)); // "…really?"
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, A.lean - 0.08 * juggling - 0.1 * bump(s, HIT, HIT + 0.4), c.w);

    // the tickets
    const size = popIn(s, 0.1, 5.38);
    for (let i = 0; i < 3; i++) {
      const n = run.notes[i];
      n.visible = size > 0.01;
      n.scale.setScalar(Math.max(0.001, size * sc));
      const st = noteState(i, s);
      if (st.mode === 'face' || (st.mode === 'air' && st.k === 9)) {
        if (s < HIT) {
          // the bad throw: up and over, straight onto its face
          const { f } = st as AirState; // (still in the air till it hits)
          at(c, torso, R, yH, zH, V1);
          at(c, head, 0, hb.cy, hb.front + 0.012, V2);
          n.position.lerpVectors(V1, V2, f);
          n.position.y += 4 * 0.42 * f * (1 - f);
          E1.set(0, c.camYaw, f * Math.PI * 2);
          Q1.setFromEuler(E1);
          head.getWorldQuaternion(Q2);
          n.quaternion.slerpQuaternions(Q1, Q2, seg(f, 0.55, 0.95));
        } else if (s < 5.15) {
          at(c, head, 0, hb.cy, hb.front + 0.012, n.position); // stuck
          head.getWorldQuaternion(n.quaternion);
        } else {
          // peeled off: hangs from the fingers by its corner
          handAt(c, 'R', n.position);
          head.getWorldQuaternion(n.quaternion);
          n.rotateZ(-0.6 * seg(s, 5.15, 5.35));
          n.rotateX(-0.5 * seg(s, 5.15, 5.35));
          n.translateY(-NOTE * 0.4 * sc);
        }
        continue;
      }
      if (s >= HIT) {
        // dropped in its lap when the other one hit
        run.dropFrom[i] ||= n.position.clone();
        const fall = seg(s, HIT, HIT + 0.45);
        at(c, root, (i === 1 ? -0.14 : 0.12), 0.24, 0.3, V1);
        n.position.lerpVectors(run.dropFrom[i], V1, fall);
        n.position.y += 0.08 * bump(fall, 0, 1);
        E1.set(-1.35 * fall + Math.sin(s * 14) * 0.3 * (1 - fall), c.camYaw + (i === 1 ? 0.4 : -0.3) * fall, 0.25 * fall, 'YXZ');
        n.quaternion.setFromEuler(E1);
        continue;
      }
      if (st.mode === 'hand') {
        handAt(c, st.side < 0 ? 'L' : 'R', n.position);
        n.position.y += NOTE * 0.45 * sc;
        n.position.x += 0.03 * i;
        E1.set(0, c.camYaw, st.side * 0.2);
      } else {
        // over the top: from one hand round to the other
        const sd = throwSide(st.k);
        const a = Math.PI * st.f;
        at(c, torso, sd * R * Math.cos(a), yH + (apex - yH) * Math.sin(a), zH + 0.06 * Math.sin(a), n.position);
        E1.set(0, c.camYaw, -sd * a * 1.4);
      }
      n.quaternion.setFromEuler(E1);
    }
    if (once(c, 'splat', HIT)) {
      at(c, head, 0, hb.cy, hb.front + 0.05, V1);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        c.emit('star', V1, { life: 0.5, vel: new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.2), size: 0.08, spin: 6 });
      }
    }
    if (once(c, 'pop', 5.4)) {
      for (const n of run.notes) {
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          c.emit('star', n.position, { life: 0.45, vel: new THREE.Vector3(Math.cos(a) * 0.4, 0.3 + Math.sin(a) * 0.3, 0), size: 0.06, spin: 5 });
        }
      }
    }
  },
  end(c) {
    for (const n of c.run?.notes || []) dispose(n);
  },
};

// ------------------------------------------------------------ works on my machine

// A big shrug, palms up (0.3–1.3): works for me. Then it grabs the monitor off
// the desk (1.5–1.95) and hugs it beside its head (1.8–4.2): cheek on its edge,
// face still turned your way, the screen out so you can read it; hearts at 2.5.
// The screen says so from 1.5 (✅ stamp at 1.8, screens.js). Back on the desk by 4.85.
const SHRUG = [-0.4, 1.1, -1.9];

// (hb is measured along with mon, on the first frame)
type WorksRun = { mon?: { m: THREE.Object3D; p: THREE.Vector3; r: THREE.Euler; to: THREE.Vector3 }; hb: HeadBox };

const works: Antic<WorksRun> = {
  dur: 5.0,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    if (s >= 1.5) A.screen = 'works';
    if (!run.mon) {
      const m = c.set.screen.light.parent!; // the monitor group
      const hb = (run.hb = headBox(c));
      // where it's hugged: beside its head as it sits up (on your left of it), a bit
      // towards you, screen out (worked out from the chair, not the pose it's in now)
      const S = c.robot.root.scale.x;
      const side = 0.53 + hb.hw * S;
      const to = c.set.swivel.parent!.position.clone(); // (the chair)
      to.x += -Math.cos(c.camYaw) * side + Math.sin(c.camYaw) * 0.12;
      to.z += Math.sin(c.camYaw) * side + Math.cos(c.camYaw) * 0.12;
      to.y = c.set.swivel.position.y + 0.09 + S * (c.robot.torso.position.y + c.robot.head.position.y + hb.cy) - 0.7;
      run.mon = { m, p: m.position.clone(), r: m.rotation.clone(), to: m.parent!.worldToLocal(c.set.office.localToWorld(to)) };
    }
    const { m, p, r, to } = run.mon;
    const { hb } = run;
    const shrug = seg(s, 0.3, 0.6) * (1 - seg(s, 1.05, 1.45));
    const grab = seg(s, 1.5, 1.95) * (1 - seg(s, 4.3, 4.85));
    const hug = seg(s, 1.75, 2.15) * (1 - seg(s, 4.2, 4.6));
    // the monitor swoops over (a little hop on the way), turns its screen to you, leans in
    m.position.lerpVectors(p, to, grab);
    m.position.y += 0.18 * bump(grab, 0, 1);
    m.rotation.set(r.x, mix(r.y, c.camYaw - 0.1, grab), r.z - 0.1 * hug);
    m.updateMatrixWorld(true);

    // shrug: palms up, everything up, head on one side
    for (const key of ['armL', 'armR'] as const) {
      for (let i = 0; i < 3; i++) PL[i] = SHRUG[i];
      PL[2] += 0.15 * Math.sin(s * 9) * shrug;
      blend(A, key, PL, shrug * c.w);
    }
    A.rootY += (0.05 * shrug + 0.03 * hug) * c.w;
    // the hug: a little turn towards it, the near arm round its back, the far one across the front
    A.yaw = -0.45 * hug * c.w;
    A.lean = mix(A.lean, A.lean - 0.08 * shrug + (0.1 - A.lean) * hug, c.w);
    const rl = aim(c, 'L', at(c, m, 0.08, 0.72, -0.12, V1), QL, 2.2);
    const rr = aim(c, 'R', at(c, m, 0.4, 0.45, 0.08, V1), QR, 2.2);
    const squeeze = Math.sin(s * 9) * 0.05 * seg(s, 2.3, 2.5);
    QL[2] += squeeze;
    QR[2] -= squeeze;
    blend(A, 'armL', QL, hug * c.w);
    blend(A, 'armR', QR, hug * c.w);
    A.reachL = mix(A.reachL, rl, hug * c.w);
    A.reachR = mix(A.reachR, rr, hug * c.w);
    // head: tilted for the shrug; cheek on the monitor and face round to you for the hug
    HEAD[0] = A.head[0] - 0.06 * shrug + 0.05 * hug;
    HEAD[1] = A.head[1] + 0.4 * hug + Math.sin(s * 3) * 0.05 * hug;
    HEAD[2] = A.head[2] + 0.3 * shrug + 0.28 * hug;
    blend(A, 'head', HEAD, c.w);
    if (once(c, 'hearts', 2.5)) {
      const top = at(c, c.robot.head, -hb.hw * 0.5, hb.top, 0, V1);
      for (let i = 0; i < 3; i++) c.emit('heart', top, { life: 1.3, vel: new THREE.Vector3((i - 1) * 0.15, 0.5, 0.05), size: 0.13 });
    }
  },
  end(c) {
    const mon = c.run?.mon;
    if (!mon) return;
    mon.m.position.copy(mon.p);
    mon.m.rotation.copy(mon.r);
  },
};

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
const BELOW = new THREE.Vector3(0, -0.02, 0.4); // between gulps, just under the chin

function outward(p: THREE.Vector3, d: number) {
  const dx = p.x - LAYOUT.chair.x;
  const dz = p.z - LAYOUT.chair.z;
  const k = d / (Math.hypot(dx, dz) || 1);
  p.x += dx * k;
  p.z += dz * k;
  return p;
}
function turnTo(c: AnticCtx, p: THREE.Vector3, off: number) {
  const rel = wrap(yawOf(p) - c.curYaw);
  return rel - Math.sign(rel) * Math.min(Math.abs(rel), off);
}
// awake.js's mug trip: reach round for the mug (right arm), to the face, put it back
function mugTrip(c: AnticCtx, A: AnticPose, T: Chug, near: THREE.Vector3, tilt: number) {
  const { s } = c;
  const yawReach = turnTo(c, c.mugHome, 1.3);
  const yaw = track(s, 0, [[0, T.grab[1], yawReach], [...T.lift, Math.min(0.3, yawReach)], [...T.back, yawReach], [...T.home, 0]]);
  A.yaw = yaw * c.w;
  const rMug = aim(c, 'R', outward(V1.copy(c.mugHome), -GRIP).setY(c.mugHome.y + MUG_MID), PR);
  const rFace = aim(c, 'R', at(c, c.robot.head, near.x, near.y, near.z, V1), QR);
  pose(PL, A.armR, s, [[...T.grab, PR], [...T.lift, QR], [...T.back, PR], [...T.home, A.armR]]);
  blend(A, 'armR', PL, c.w);
  A.reachR = mix(1, track(s, 1, [[...T.grab, rMug], [...T.lift, rFace], [...T.back, rMug], [...T.home, 1]]), c.w);
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
      for (const [r, a] of [[60, 0.5], [86, 0.42]]) {
        ctx.beginPath();
        ctx.arc(w / 2 + sd * (r - 116), h / 2, r, sd > 0 ? -a : Math.PI - a, sd > 0 ? a : Math.PI + a);
        ctx.stroke();
      }
    }
  });
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  mat.userData.outlineParameters = { visible: false };
  return new THREE.Sprite(mat);
}

// (buzz, keys and hb are made together, on the first frame)
type Keyboard = { k: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; sc: number };
type JitterRun = { buzz: THREE.Sprite; keys: THREE.Sprite; hb: HeadBox; kb?: Keyboard; sweat?: number; sd?: number; smoke?: number };

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
    const kb = (run.kb ||= { k: c.set.keyboard, p: c.set.keyboard.position.clone(), q: c.set.keyboard.quaternion.clone(), sc: c.set.keyboard.scale.x });
    at(c, c.robot.root, 0, 0.26, 0.34, V1);
    kb.k.parent!.worldToLocal(c.set.office.localToWorld(V1)); // (the desk top)
    kb.k.position.lerpVectors(kb.p, V1, lap);
    kb.k.position.y += 0.25 * bump(lap, 0, 1);
    c.robot.root.getWorldQuaternion(Q1);
    kb.k.quaternion.slerpQuaternions(kb.q, Q1, lap);
    kb.k.scale.setScalar(mix(kb.sc, 0.75 * scaleOf(c), lap));
    for (const [side, key, out, sd, ph] of [['L', 'armL', QL, -1, 0], ['R', 'armR', QR, 1, Math.PI]] as const) {
      at(c, kb.k, sd * (0.12 + 0.05 * Math.sin(s * 19 + ph)), 0.05 + 0.07 * Math.max(0, Math.sin(s * 44 + ph)), 0.02, V1);
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
      if (once(c, `gulp${g}`, g)) c.emit('steam', at(c, c.robot.head, 0.05, 0.32, 0.42, V1), { life: 0.7, vel: new THREE.Vector3(0, 0.35, 0), size: 0.07, grow: 2 });
    }
    if (once(c, 'zap', 2.4)) {
      for (const sd of [-1, 1]) c.emit('bolt', at(c, c.robot.head, sd * (hb.hw + 0.1), hb.top * 0.8, 0, V1), { life: 0.8, vel: new THREE.Vector3(sd * 0.3, 0.3, 0), size: 0.14, spin: 3 });
    }
    // sweat flying off, and the keyboard smoking
    if (type > 0.5 && s >= (run.sweat ?? 3.6)) {
      run.sweat = s + 0.38;
      const sd = (run.sd = -(run.sd || 1));
      c.emit('sweat', at(c, c.robot.head, sd * hb.hw * 0.8, hb.top * 0.75, 0.1, V1), { life: 0.7, vel: new THREE.Vector3(sd * 0.35, 0.25, 0), size: 0.08, gravity: 1.2 });
    }
    if (type > 0.5 && s >= (run.smoke ?? 4.2)) {
      run.smoke = s + 0.45;
      c.emit('steam', at(c, run.kb.k, (Math.random() - 0.5) * 0.3, 0.04, 0, V3), { life: 0.9, vel: new THREE.Vector3(0, 0.3, 0), size: 0.08, grow: 2.6 });
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

export const TEAM: Record<string, Antic> = { merge, standup, jira, works, jitter };
