import * as THREE from 'three';
import { toon, glow, canvasTexture, roundRect } from '@/office3d/materials';
import { FLOOR } from '@/office3d/bed';
import type { Rig } from '@/office3d/types';
import type { Antic, ParticleKind, ParticleOpts, TickCtx } from './types';

// Night-time antics while it sleeps (either style unless marked):
//   vacuum   a little robot vacuum trundles in, bumps into the chair (or the blanket)
//            three times, hoovers up the crumbs that shook loose, spins for joy and leaves
//   burrito  (floor only) it rolls over and the blanket winds round it into a burrito,
//            then it unrolls back to just how it lay
// Timings are a contract: robot.js plays sounds at the marked moments.

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => Math.min(1, Math.max(0, (s - a) / (b - a)));
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// true the first time it's asked for this run (one-shot emits)
const once = (run: Record<string, unknown>, key: string) => (run[key] ? false : (run[key] = true));
// a smooth curve through [time, value] keys
function keys(s: number, ks: [number, number][]) {
  if (s <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (s < ks[i][0]) {
      const [t0, v0] = ks[i - 1];
      return v0 + (ks[i][1] - v0) * smooth((s - t0) / (ks[i][0] - t0));
    }
  }
  return ks[ks.length - 1][1];
}
// (three's types only put isMesh on a Mesh) the meshes disposed of here are ones built
// here, with one toon or basic material each (or the blanket's, kept); the robot's own
// are only measured
type Built = THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial | THREE.MeshBasicMaterial>;
const isMesh = (o: THREE.Object3D): o is Built => 'isMesh' in o && !!o.isMesh;
// everything under obj, but not a material it borrowed (the blanket's)
function disposeTree(obj: THREE.Object3D, keep?: THREE.Material | THREE.Material[]) {
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    o.geometry.dispose();
    if (o.material === keep) return;
    o.material.map?.dispose();
    o.material.dispose();
  });
}
const mesh = <M extends THREE.Material | THREE.Material[]>(geo: THREE.BufferGeometry, mat: M, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};
// the office sits at the origin of the world group, so emit positions are office positions
const emitAt = (c: TickCtx, kind: ParticleKind, at: THREE.Vector3, opts?: ParticleOpts) => c.emit(kind, at.clone(), opts);

// scratch, so nothing is allocated per frame
const V = new THREE.Vector3();
const W = new THREE.Vector3();
const Q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const BOX = new THREE.Box3();
const BOX2 = new THREE.Box3();
const M = new THREE.Matrix4();
const INV = new THREE.Matrix4();
const LED_OK = new THREE.Color('#5dff9a');
const LED_OW = new THREE.Color('#ffb347');

// ------------------------------------------------------------ robot vacuum

const VAC_R = 0.2; // bigger than life, so it reads in the small window
const VAC_H = 0.095;
const BUMPS = [2.0, 2.8, 3.6]; // nose into the chair / blanket
const SUCK = [4.15, 4.5, 4.85, 5.2, 5.5]; // when each crumb goes in
const SPIN: [number, number] = [5.7, 6.3]; // the happy spin
const LEAVE: [number, number] = [6.5, 8.6]; // turns for the door and drives off

type Route = {
  from: THREE.Vector3; hit: THREE.Vector3; out: THREE.Vector3; crumbs: THREE.Vector3[];
  dir: THREE.Vector3; yaw: number; rest: THREE.Vector3; turns: number[]; exit: number;
};
// (as written in ROUTES, a route has only from, hit, out and the crumbs as [x, z]: the loop
// after it works out the rest, each before it's read, and turns the crumbs into points)
type RouteSoFar = Omit<Route, 'crumbs'> & { crumbs: [number, number][] | THREE.Vector3[] };

// Its route (office space): in from off-frame left along the floor, nose to the
// obstacle, then off out of the bottom-left corner. `hit` is where its middle is when
// it touches: chair style, the chair's left-hand wheel; floor style, the front of the
// blanket by the sleeper's chest. `crumbs` is where the crumbs it shakes loose land
// ([x, z] from where it backs off to): mostly on your side, so it turns its face to you
// to slurp them up.
const ROUTES = {
  chair: {
    from: new THREE.Vector3(-2.2, 0, -0.1), hit: new THREE.Vector3(-0.51, 0, -0.21), out: new THREE.Vector3(-1.15, 0, 1.2),
    crumbs: [[0.26, 0.3], [-0.32, 0.06], [0.04, 0.4], [-0.24, 0.34], [0.36, 0.12]],
  },
  floor: {
    from: new THREE.Vector3(-2.2, 0, 0.5), hit: new THREE.Vector3(-0.42, 0, 0.44), out: new THREE.Vector3(-1.25, 0, 1.25),
    crumbs: [[0.24, 0.22], [-0.26, -0.06], [0.06, 0.3], [-0.22, 0.2], [0.32, 0.08]],
  },
} as Record<'chair' | 'floor', RouteSoFar>;
for (const r of Object.values(ROUTES)) {
  r.dir = r.hit.clone().sub(r.from).normalize();
  r.yaw = Math.atan2(r.dir.x, r.dir.z);
  r.rest = r.hit.clone().addScaledVector(r.dir, -0.2); // backed off after the last bump, among the crumbs
  r.crumbs = r.crumbs.map(([x, z]) => new THREE.Vector3(r.rest.x + x, 0.03, r.rest.z + z));
  // which way it faces to slurp each one (relative to coming in), and to leave
  r.turns = r.crumbs.map((p) => wrap(Math.atan2(p.x - r.rest.x, p.z - r.rest.z) - r.yaw));
  r.exit = wrap(Math.atan2(r.out.x - r.rest.x, r.out.z - r.rest.z) - r.yaw);
}
// its heading over the crumb hunt, relative to coming in: turn to each crumb and hold
// while it goes in, straighten up for the spin, then turn for the way out
function huntKeys(r: Route) {
  const ks: [number, number][] = [[4.0, 0]];
  SUCK.forEach((t, i) => ks.push([t - 0.1, r.turns[i]], [t + 0.2, r.turns[i]]));
  ks.push([SPIN[0], 0], [LEAVE[0], 0], [LEAVE[0] + 0.35, r.exit]);
  return ks;
}

// its face: glowing eyes that squeeze shut on a bump and smile when it's happy
function drawFace(ctx: CanvasRenderingContext2D, w: number, h: number, mood: string) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = ctx.fillStyle = '#7ff3ff';
  ctx.lineWidth = 12;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const side of [-1, 1]) {
    const x = w / 2 + side * 40;
    ctx.beginPath();
    if (mood === 'ow') {
      // > <
      ctx.moveTo(x - side * 14, h * 0.2);
      ctx.lineTo(x + side * 12, h * 0.5);
      ctx.lineTo(x - side * 14, h * 0.8);
      ctx.stroke();
    } else if (mood === 'happy') {
      // ^ ^
      ctx.arc(x, h * 0.7, 18, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      roundRect(ctx, x - 13, h * 0.1, 26, h * 0.8, 13);
      ctx.fill();
    }
  }
  // a little mouth, wider when it's pleased
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.4, mood === 'happy' ? 13 : 9, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();
}

function buildVacuum() {
  const group = new THREE.Group();
  group.name = 'night-vacuum';
  const body = mesh(new THREE.CylinderGeometry(VAC_R, VAC_R * 0.97, VAC_H, 32), toon('#3d4252'), 0, VAC_H / 2 + 0.008, 0);
  const lid = mesh(new THREE.CylinderGeometry(VAC_R * 0.78, VAC_R * 0.8, 0.012, 32), toon('#555c70'), 0, VAC_H + 0.012, 0);
  // the bumper: a pale ring round its front half, low down
  const bumper = mesh(new THREE.TorusGeometry(VAC_R + 0.006, 0.015, 6, 24, Math.PI), toon('#a3abc0'), 0, 0.02, 0);
  bumper.rotation.x = Math.PI / 2;
  // the status LED on top, near the front
  const led = mesh(new THREE.SphereGeometry(0.02, 10, 8), glow('#5dff9a'), 0, VAC_H + 0.016, -VAC_R * 0.5);
  // the face, on top towards the front: from up where you look, its side is only a sliver
  const face = canvasTexture(160, 64);
  drawFace(face.ctx, 160, 64, 'calm');
  const faceMat = glow('#ffffff', { map: face.tex, transparent: true, depthWrite: false });
  const faceGeo = new THREE.PlaneGeometry(VAC_R * 1.3, VAC_R * 0.52);
  faceGeo.rotateX(-Math.PI / 2); // lying on the lid, the top of the picture to its back
  const faceMesh = mesh(faceGeo, faceMat, 0, VAC_H + 0.021, VAC_R * 0.38);
  faceMesh.castShadow = false;
  // a spinning side brush peeking out at the front right
  const brush = new THREE.Group();
  brush.position.set(-VAC_R * 0.62, 0.01, VAC_R * 0.62);
  const bristle = toon('#e6e9f2');
  for (let i = 0; i < 3; i++) {
    const b = mesh(new THREE.BoxGeometry(0.012, 0.006, 0.09), bristle, 0, 0, 0.045);
    const arm = new THREE.Group();
    arm.rotation.y = (i / 3) * Math.PI * 2;
    arm.add(b);
    brush.add(arm);
  }
  group.add(body, lid, bumper, led, faceMesh, brush);
  group.visible = false;
  return { group, body, led, brush, face, mood: 'calm' };
}

const CRUMB_COLORS = ['#d9a066', '#6b3e1f', '#e8c08a', '#d9a066', '#8a5a33'];
function buildCrumbs() {
  const geo = new THREE.IcosahedronGeometry(0.04, 0);
  return CRUMB_COLORS.map((col, i) => {
    const m = mesh(i ? geo.clone() : geo, toon(col));
    m.rotation.set(i, i * 2, 0);
    m.visible = false;
    return m;
  });
}

// how far it has backed off along its way in, s seconds in: a bounce back after each
// bump and on in again for the next; after the last it stays back among the crumbs
function recoil(s: number) {
  let d = 0;
  for (let i = 0; i < BUMPS.length; i++) {
    const k = s - BUMPS[i];
    if (k < 0 || k >= 0.8) continue;
    const back = 0.12 * (1 - (1 - Math.min(1, k / 0.14)) ** 2);
    d = i === BUMPS.length - 1 ? back + 0.08 * smooth(seg(k, 0.15, 0.4)) : back * (1 - smooth(seg(k, 0.35, 0.8)));
  }
  return s >= BUMPS[BUMPS.length - 1] + 0.8 ? 0.2 : d;
}
// the jolt of a bump: a sharp knock that rings out (0 between bumps)
function jolt(s: number) {
  for (const b of BUMPS) {
    const k = s - b;
    if (k >= 0 && k < 0.6) return Math.sin(k * 42) * Math.exp(-k * 8);
  }
  return 0;
}

// (crumbs, hunt and route are set with vac, on the first frame; drop at the last
// knock, before any crumb that's thrown from it shows)
type VacuumRun = {
  vac?: ReturnType<typeof buildVacuum> | null; crumbs: ReturnType<typeof buildCrumbs>;
  hunt: [number, number][]; route?: Route; drop: THREE.Vector3;
};

const vacuum: Antic<VacuumRun> = {
  dur: 9.0,
  fadeIn: 0.2,
  fadeOut: 0.3,
  update(c, A) {
    const { s, run } = c;
    const r = ROUTES[c.sleepStyle === 'floor' ? 'floor' : 'chair'] as Route; // (the loop up top has filled it in)
    if (!run.vac) {
      run.vac = buildVacuum();
      run.crumbs = buildCrumbs();
      run.hunt = huntKeys(r);
      run.route = r;
      c.set.office.add(run.vac.group, ...run.crumbs);
    }
    const v = run.vac;
    const g = v.group;

    // ---- where it is and which way it faces
    let yaw = r.yaw;
    if (s < BUMPS[0]) g.position.lerpVectors(r.from, r.hit, seg(s, 0.3, BUMPS[0]));
    else if (s < LEAVE[0] + 0.3) {
      g.position.copy(r.hit).addScaledVector(r.dir, -recoil(s));
      // a puzzled look left and right after each bump, then the crumb hunt
      for (const b of BUMPS) yaw += 0.35 * Math.sin((s - b) * 14) * bump(s, b + 0.15, b + 0.6);
      if (s >= 4.0) {
        yaw += keys(s, run.hunt);
        // a little lunge at each crumb as it slurps it up
        for (let i = 0; i < SUCK.length; i++) {
          const l = 0.06 * bump(s, SUCK[i] - 0.05, SUCK[i] + 0.3);
          if (l) g.position.addScaledVector(V.subVectors(r.crumbs[i], r.rest).setY(0).normalize(), l);
        }
      }
    } else {
      // off it goes, picking up speed, out of the bottom-left corner
      yaw += r.exit;
      g.position.lerpVectors(r.rest, r.out, seg(s, LEAVE[0] + 0.3, LEAVE[1]) ** 1.6);
    }
    yaw += Math.PI * 2 * smooth(seg(s, SPIN[0], SPIN[1]));
    g.rotation.y = yaw;
    g.position.y = 0.035 * bump(s, SPIN[0] + 0.1, SPIN[1] - 0.05); // a happy little hop mid-spin
    g.visible = s > 0.25 && s < LEAVE[1] + 0.1;
    v.brush.rotation.y = s * 22;
    v.led.material.color.copy(s > BUMPS[0] && s < 4.0 && Math.sin(s * 30) > 0 ? LED_OW : LED_OK); // flashes amber while it's stuck
    // it judders as each crumb goes in
    let gulp = 0;
    for (const t of SUCK) gulp += bump(s, t + 0.12, t + 0.32);
    v.body.scale.set(1 + 0.05 * gulp, 1 - 0.08 * gulp, 1 + 0.05 * gulp);

    const mood = s > SPIN[0] - 0.1 && s < LEAVE[0] + 0.6 ? 'happy' : BUMPS.some((b) => s > b && s < b + 0.45) ? 'ow' : 'calm';
    if (mood !== v.mood) {
      v.mood = mood;
      drawFace(v.face.ctx, 160, 64, mood);
      v.face.tex.needsUpdate = true;
    }

    // ---- the sleeper: a twitch at each knock, a bigger one at the last
    const j = jolt(s);
    const big = s > BUMPS[2] ? 1.6 : 1;
    A.head[0] += 0.1 * j * big;
    A.head[2] += 0.06 * j * big;
    A.yaw += 0.05 * j; // the seat wobbles (chair style)
    A.rootY += 0.012 * Math.abs(j) * big;
    if (s >= BUMPS[2] + 0.5 && s < BUMPS[2] + 1.5 && once(run, 'z')) {
      emitAt(c, 'z', c.worldPoint(c.robot.head, 0.2, c.robot.headTop ?? 0.6, 0.1), { life: 1.6, vel: new THREE.Vector3(0.12, 0.28, 0), size: 0.22, grow: 2 });
    }

    // ---- the crumbs: shaken loose by the last knock, then slurped up one by one
    if (s >= BUMPS[2] && !run.drop) {
      // off its lap (chair), or off the top of the blanket (floor)
      run.drop = c.sleepStyle === 'floor' && c.bed?.props(c.set)
        ? c.bed.props(c.set)!.blanket.position.clone().setY(0.4) // (it just gave them)
        : c.worldPoint(c.robot.torso, 0, 0.12, 0.25);
    }
    run.crumbs.forEach((m, i) => {
      const t0 = BUMPS[2] + i * 0.05;
      const land = r.crumbs[i];
      const t1 = SUCK[i];
      m.visible = s >= t0 && s < t1 + 0.28;
      if (!m.visible) return;
      if (s < t1) {
        // a hop out and down, a tiny bounce, then lying there
        const u = seg(s, t0, t0 + 0.35);
        m.position.lerpVectors(run.drop, land, u);
        m.position.y = land.y + (run.drop.y - land.y) * (1 - u) + 0.25 * u * (1 - u) + 0.03 * bump(s, t0 + 0.35, t0 + 0.5);
        m.scale.setScalar(1);
      } else {
        // whoosh: pulled in under its front edge, spinning and shrinking
        const u = seg(s, t1, t1 + 0.28) ** 2;
        V.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
        W.copy(g.position).addScaledVector(V, VAC_R * 0.7).setY(0.02);
        m.position.lerpVectors(land, W, u);
        m.position.y += 0.05 * Math.sin(u * Math.PI);
        m.scale.setScalar(1 - 0.8 * u);
        m.rotation.y += c.dt * 18;
      }
    });
    if (s >= SPIN[0] + 0.3 && once(run, 'joy')) {
      for (let i = 0; i < 3; i++) {
        emitAt(c, i === 1 ? 'heart' : 'star', V.copy(g.position).setY(0.3), { life: 0.9, vel: new THREE.Vector3((i - 1) * 0.25, 0.5, 0), size: 0.1, spin: 3 });
      }
    }
  },

  // after bed.update has put the chair and blanket where they belong: knock them about
  place(c) {
    const { s, set } = c;
    const j = jolt(s);
    if (!j || !c.run.route) return;
    const { dir } = c.run.route;
    if (c.sleepStyle === 'floor' && c.bed?.onFloor) {
      const props = c.bed.props(set);
      if (props) {
        props.blanket.position.addScaledVector(dir, 0.03 * j);
        props.blanket.scale.y *= 1 + 0.12 * Math.abs(j);
      }
      c.robot.root.position.addScaledVector(dir, 0.015 * j);
    } else {
      // the chair skids a touch (bed.update puts its x back every frame)
      set.swivel.parent!.position.x += 0.03 * j * dir.x; // (the swivel sits on the chair)
    }
  },

  end(c) {
    const { run } = c;
    if (!run?.vac) return;
    for (const o of [run.vac.group, ...run.crumbs]) {
      o.removeFromParent();
      disposeTree(o);
    }
    run.vac = null;
  },
};

// ------------------------------------------------------------ blanket burrito

const ROLL: [number, number] = [0.5, 2.3]; // a full turn over, winding the blanket on
const UNROLL: [number, number] = [6.5, 7.6]; // and back
const TRAVEL = 0.2; // how far the roll carries it towards you
const SEGS = 32; // round the roll (the wrap is drawn a column at a time)
const ROWS = 4;

// Straight legs inside the roll. The legs are built sitting (a hip group with the thigh
// forward, the shin and foot hanging from the knee): swing each hip so the thigh runs
// along the body and fold what hangs from the knee to carry on in line, as pushup.js
// does for its plank. Both poses are kept, so it can ease between them and back.
// Bodies built differently (the cat) keep their knees bent: a roomier burrito.
const UNFOLD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const SWING = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
type LegPose = { o: THREE.Object3D; p0: THREE.Vector3; q0: THREE.Quaternion; p1: THREE.Vector3; q1: THREE.Quaternion };
function legPoses(robot: Rig) {
  const out: LegPose[] = [];
  for (const hip of robot.root.children) {
    if (hip === robot.torso || isMesh(hip) || Math.abs(hip.position.x) < 0.05) continue;
    const below = hip.children.filter((o) => o.position.y < -0.1);
    const thigh = hip.children.find((o) => o.position.y > -0.05 && o.position.z > 0.08);
    if (!below.length || !thigh) continue;
    const knee = Math.min(...below.map((o) => o.position.z));
    out.push({ o: hip, p0: hip.position.clone(), q0: hip.quaternion.clone(), p1: hip.position.clone(), q1: hip.quaternion.clone().premultiply(SWING) });
    for (const o of below) {
      const p1 = new THREE.Vector3(o.position.x, o.position.z - knee, knee - o.position.y);
      out.push({ o, p0: o.position.clone(), q0: o.quaternion.clone(), p1, q1: o.quaternion.clone().premultiply(UNFOLD) });
    }
  }
  return out;
}
function poseLegs(legs: LegPose[], k: number) {
  for (const { o, p0, q0, p1, q1 } of legs) {
    o.position.lerpVectors(p0, p1, k);
    o.quaternion.slerpQuaternions(q0, q1, k);
  }
}
// arms from tucked under its chin (as bed.js has them) down by its sides
function armsDown(robot: Rig, k: number) {
  for (const arm of [robot.arms.armL, robot.arms.armR]) {
    arm.shoulder.rotation.set(-1.35 * (1 - k), 0, (0.12 - 0.08 * k) * arm.side);
    arm.elbow.rotation.x = -1.75 * (1 - k);
  }
}

// the end of the roll: a swirl of blanket, like a cinnamon roll
function swirlTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#5aa9e6';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 7; a += 0.1) {
      const rr = 4 + a * 2.6;
      ctx.lineTo(w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr);
    }
    ctx.stroke();
  }).tex;
}

// Measure it as it'll lie in the roll (legs straight, arms by its sides; its head, and the
// cat's tail, stay out) and build the roll round that: one turn of the blanket, wound on a column at a time.
function fitBurrito(c: TickCtx, blanket: THREE.Mesh) {
  const { robot } = c;
  const root = robot.root;
  const legs = legPoses(robot);
  poseLegs(legs, 1);
  armsDown(robot, 1);
  root.updateMatrixWorld(true);
  INV.copy(root.matrixWorld).invert();
  BOX.makeEmpty();
  (function walk(o: THREE.Object3D) {
    if (o === robot.head || o === robot.antenna || !o.visible) return; // (a tail may poke out)
    if (isMesh(o)) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      BOX.union(BOX2.copy(o.geometry.boundingBox!).applyMatrix4(M.multiplyMatrices(INV, o.matrixWorld))); // (computed just above if it wasn't)
    }
    o.children.forEach(walk);
  })(root);
  const neck = root.worldToLocal(robot.head.getWorldPosition(V)).y;
  poseLegs(legs, 0);
  armsDown(robot, 0);

  const cx = (BOX.min.x + BOX.max.x) / 2;
  const cz = (BOX.min.z + BOX.max.z) / 2;
  const R = Math.max(BOX.max.x - BOX.min.x, BOX.max.z - BOX.min.z) / 2 + 0.04;
  const y0 = BOX.min.y - 0.03;
  const y1 = neck + 0.03;
  const len = y1 - y0;
  // round the body along its spine (root space +y), starting where it touches the floor now
  const geo = new THREE.CylinderGeometry(R, R, len, SEGS, ROWS, true, -Math.PI / 2, Math.PI * 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // plumper in the middle
    const f = 1 + 0.08 * (1 - (pos.getY(i) / (len / 2)) ** 2);
    pos.setX(i, pos.getX(i) * f);
    pos.setZ(i, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();
  const group = new THREE.Group();
  group.name = 'burrito';
  group.position.set(cx, (y0 + y1) / 2, cz);
  const roll = mesh(geo, blanket.material); // the blanket's own pattern and colour
  const cap = mesh(new THREE.CircleGeometry(R, SEGS), toon('#ffffff', { map: swirlTexture() }), 0, -len / 2, 0);
  cap.rotation.x = Math.PI / 2; // the feet end, facing out
  const hem = mesh(new THREE.TorusGeometry(R * 1.01, 0.03, 8, SEGS), blanket.material, 0, len / 2, 0);
  hem.rotation.x = Math.PI / 2; // a rolled edge round its neck
  group.add(roll, cap, hem);
  root.add(group);
  // the axis it rolls about (root space), and where that is in the room as it lies now
  const axis = new THREE.Vector3(cx, 0, cz);
  const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FLOOR.yaw, FLOOR.roll, 'YXZ'));
  return { legs, group, roll, cap, hem, R, axis, base, blanket, toward: new THREE.Vector3(Math.sin(FLOOR.yaw), 0, Math.cos(FLOOR.yaw)) };
}

type BurritoRun = { fit?: ReturnType<typeof fitBurrito> | null };

const burrito: Antic<BurritoRun> = {
  dur: 8.0,
  fadeIn: 0,
  fadeOut: 0,
  update(c, A) {
    const { s, run } = c;
    if (!c.bed?.onFloor) return;
    if (s >= 3.0 && s < 5.5) c.say('🌯', 'thought');
    // snug: it nestles its head in, with a contented little nod now and then
    const snug = smooth(seg(s, 2.3, 2.8)) * (1 - smooth(seg(s, 6.2, 6.6)));
    A.head[0] += snug * (0.08 + 0.05 * Math.sin(s * 2.2));
    A.head[2] += snug * 0.06 * Math.sin(s * 1.3);
    for (const [key, at] of [['z1', 3.3], ['z2', 4.7]] as const) {
      if (s >= at && run.fit && once(run, key)) {
        emitAt(c, 'z', c.worldPoint(c.robot.head, 0, 0, 0).add(V.set(0.12, 0.3, 0.05)), { life: 1.7, vel: new THREE.Vector3(0.14, 0.3, 0), size: 0.24, grow: 2.3 });
      }
    }
  },

  place(c) {
    const { s, robot, set, run } = c;
    if (!c.bed?.onFloor || robot.root.parent !== set.office) return;
    const props = c.bed.props(set);
    if (!props) return;
    run.fit ||= fitBurrito(c, props.blanket);
    const f = run.fit;
    const root = robot.root;

    // how far round it has rolled (0..1 of a turn), and back
    const turn = s < UNROLL[0] ? smooth(seg(s, ...ROLL)) : 1 - smooth(seg(s, ...UNROLL));
    // a happy wriggle while it's wrapped up
    const wiggle = 0.12 * Math.sin((s - 2.6) * 9) * bump(s, 2.6, 3.4) + 0.08 * Math.sin((s - 4.9) * 8) * bump(s, 4.9, 5.6);
    const phi = -Math.PI * 2 * turn + wiggle;
    // legs straighten and arms come down as it starts to roll, and go back once it's out
    const tuck = smooth(seg(s, 0.5, 1.0)) * (1 - smooth(seg(s, 7.3, 7.9)));
    poseLegs(f.legs, tuck);
    armsDown(robot, tuck);

    // roll about its long axis (root +y), carried a little your way, the roll resting on the floor
    const sc = root.scale.x;
    Q.setFromAxisAngle(Y, phi);
    root.quaternion.copy(f.base).multiply(Q);
    V.copy(f.axis).multiplyScalar(sc).applyQuaternion(f.base).add(FLOOR.hips); // the axis now
    const settle = 0.025 * bump(s, ROLL[1] - 0.05, ROLL[1] + 0.25);
    V.y += (f.R * sc * 1.08 - V.y) * turn + settle;
    V.addScaledVector(f.toward, TRAVEL * turn);
    root.position.copy(V).sub(W.copy(f.axis).multiplyScalar(sc).applyQuaternion(root.quaternion));

    // the blanket winds on from where it touches the floor; the flat one is pulled in
    const cols = Math.min(SEGS, Math.ceil(turn * SEGS));
    f.roll.geometry.setDrawRange(0, cols * ROWS * 6);
    f.group.visible = cols > 0;
    const ends = smooth(seg(turn, 0.85, 1));
    f.cap.scale.setScalar(Math.max(0.001, ends));
    f.hem.scale.setScalar(Math.max(0.001, ends));
    const breathe = 1 + 0.03 * Math.sin(s * 3) * ends;
    f.group.scale.set(breathe, 1, breathe);
    const b = props.blanket;
    b.visible = turn < 0.97;
    b.scale.z *= Math.max(0.001, 1 - turn);
    b.scale.y *= 1 - 0.6 * turn;
    b.position.lerp(W.copy(V).setY(0), 0.7 * turn);
  },

  bubbleAt(c) {
    if (!c.run.fit) return null;
    return c.worldPoint(c.robot.head, 0, 0, 0).add(V.set(0.28, 0.5, 0));
  },

  end(c) {
    const f = c.run?.fit;
    if (!f) return;
    // cut short or done: legs bent again, the roll gone, the blanket back, lying as before
    poseLegs(f.legs, 0);
    f.group.removeFromParent();
    disposeTree(f.group, f.blanket.material);
    f.blanket.visible = true;
    const root = c.robot?.root;
    if (root && c.set && root.parent === c.set.office) {
      root.position.copy(FLOOR.hips);
      root.rotation.order = 'YXZ';
      root.rotation.set(0, FLOOR.yaw, FLOOR.roll);
    }
    c.run.fit = null;
  },
};

export const NIGHT: Record<string, Antic> = { vacuum, burrito };
