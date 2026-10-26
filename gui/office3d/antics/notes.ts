import * as THREE from 'three';
import { LAYOUT } from '@/office3d/scene';
import { spriteTexture, toon, glow, canvasTexture } from '@/office3d/materials';
import type { CanvasTex } from '@/office3d/materials';
import type { Antic, AnticCtx, AnticPose } from './types';

// Your notes and the robot (the corkboard on the desk's left end: board.js, set.board).
// Timings are a contract: robot.js cues the sounds, the words and the board's own
// changes (a sticky appearing or coming off) at the marked moments.
//   notewrite   30 s   while you type a note: a sticky pad in one hand, a pen in the other,
//                      writing (squiggly lines fill the paper), now and then a pause to think;
//                      robot.js stops it when you stop typing, or plays notepin on Enter.
//   notepin     2.4 s  finishes writing on the sticky 0–0.6, tears it off and turns and reaches
//                      to the board 0.6–1.2, presses it on at 1.25 (robot.js adds it to the board
//                      then), back by 2.4. Asleep: the same, eyes shut and slow, mumbling c.text.
//   notetoss    2.8 s  c.text = the note's id: reaches to its sticky 0–0.6 and grabs it at 0.6
//                      (robot.js takes it off the board then), crumples it 0.7–1.2, throws it
//                      at 1.4, in the wastebasket at 2.1, a little cheer 2.1–2.6.
//   boardlift   3.4 s  the reminder: reaches to the board and holds it up 0.5–2.7 (A.boardLift),
//                      pointing at you with its other hand 0.9–2.6 (robot.js speaks at 0.9).
//   boardglance 2.6 s  idle: looks over at the board, straightens a pin (a tap at 1.2), then
//                      gives you a meaningful look 1.5–2.6.
//   allclear    1.8 s  the last note's done: a happy spin and a hop, stars at 0.2.
//   clockout    2.6 s  the end of the day: a big stretch 0–1.2 (robot.js yawns), then a
//                      slump 1.4–2.6; robot.js puts it to sleep as it ends.
// The shared rig only (root, torso, head, arms), so every body does them.

const HAND = 0.24; // how far down the forearm the hand is (as c.hand() has it)
const BIN = new THREE.Vector3(0.56, 0, -0.76); // the wastebasket (awake.js)
const BIN_MOUTH = BIN.clone().setY(0.32);

type Side = 'L' | 'R';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a));
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const once = (c: AnticCtx, key: string, at: number) => (c.s >= at && !c.run[key] ? (c.run[key] = true) : false);
function blend(A: AnticPose, key: 'armL' | 'armR' | 'head', target: readonly number[], w: number) {
  for (let i = 0; i < 3; i++) A[key][i] = mix(A[key][i], target[i], w);
}

// scratch
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const POINT = [-1.6, 0.2, -0.3]; // an arm straight out at you
const STRETCH = [-2.9, 0.45, -0.25]; // both arms up (as POSES.cheer)

const at = (c: AnticCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
const armOf = (c: AnticCtx, side: Side) => c.robot.arms[side === 'L' ? 'armL' : 'armR'];
const handAt = (c: AnticCtx, side: Side, out: THREE.Vector3) => at(c, armOf(c, side).elbow, 0, -HAND, 0, out);

// Arm angles that put a hand on a point (office space); returns the stretch it needs (as awake.js)
function aim(c: AnticCtx, side: Side, p: THREE.Vector3, out: number[], most = 2.4) {
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

/** The board's middle (or one sticky on it), in office space, into out; null if there's no board. */
function boardPoint(c: AnticCtx, id: string | null, out: THREE.Vector3) {
  const board = c.set.board;
  if (!board) return null;
  if (id && board.stickyAt(id, out)) return c.set.office.worldToLocal(out);
  board.group.getWorldPosition(out);
  c.set.office.worldToLocal(out);
  out.y += 0.14; // (the group stands on the desk: up to the middle of the cork)
  return out;
}

/** How far to swivel toward the board: part of the way, so it still faces you a bit. */
function turnToBoard(c: AnticCtx) {
  const g = c.set.board?.group;
  if (!g) return 0;
  g.getWorldPosition(V2);
  c.set.office.worldToLocal(V2);
  const want = Math.atan2(V2.x - LAYOUT.chair.x, V2.z - LAYOUT.chair.z);
  return clamp(wrap(want - c.curYaw), -0.8, 0.8);
}

/** Reach the right hand (the board's side as it faces you) to p over [a, b], hold, and back over [c0, d]. */
function reachTo(c: AnticCtx, A: AnticPose, p: THREE.Vector3, s: number, [a, b, c0, d]: number[], side: Side = 'R') {
  const k = seg(s, a, b) * (1 - seg(s, c0, d));
  if (k <= 0) return 0;
  const out = side === 'L' ? QL : QR;
  const r = aim(c, side, p, out);
  blend(A, side === 'L' ? 'armL' : 'armR', out, k * c.w);
  A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, k * c.w);
  return k;
}

// ---------------------------------------------------------------- the paper ball (notetoss)

let ballTex: THREE.Texture | null = null;
function makeBall(c: AnticCtx) {
  ballTex ||= spriteTexture('ball');
  const mat = new THREE.SpriteMaterial({ map: ballTex, transparent: true, depthWrite: false });
  mat.userData.outlineParameters = { visible: false };
  const ball = new THREE.Sprite(mat);
  ball.scale.setScalar(0.001);
  c.set.office.add(ball);
  return ball;
}
function arc(out: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3, u: number, h: number) {
  out.lerpVectors(from, to, u);
  out.y += 4 * h * u * (1 - u);
  return out;
}

// ---------------------------------------------------------------- the pad and the pen

// A sticky pad (writing appears on its top sheet, line by line) and a pen, in office space.
const PAD = 0.17;
const TIP = new THREE.Vector3();
const PEN_UP = new THREE.Vector3(0, 1, 0);
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
// (three's types leave the isMesh flag off Object3D)
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => 'isMesh' in o;
type Pad = { group: THREE.Group; block: THREE.Object3D; sheet: THREE.Object3D; tex: CanvasTex; lines: number };
function makePad(c: AnticCtx, lines = 0) {
  const tex = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#ffe873';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, 0, 128, 14);
  });
  const group = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(PAD, 0.022, PAD), toon('#f2cf3d'));
  block.position.y = -0.011;
  group.add(block);
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(PAD, PAD), glow('#ffffff', { map: tex.tex, side: THREE.DoubleSide })); // lit, so the writing shows in its shade
  sheet.rotation.x = -Math.PI / 2; // lying on top of the pad, its writing facing up
  sheet.position.y = 0.001;
  group.add(sheet);
  group.traverse((o) => isMesh(o) && (o.castShadow = true));
  c.set.office.add(group);
  const pad: Pad = { group, block, sheet, tex, lines: 0 };
  writeLines(pad, lines);
  return pad;
}
// the written lines on the top sheet, up to n (squiggles, like a quick scrawl)
function writeLines(pad: Pad, n: number) {
  const ctx = pad.tex.ctx;
  let drew = false;
  while (pad.lines < Math.min(n, 7)) {
    const y = 28 + pad.lines * 14;
    const end = 108 - ((pad.lines * 37) % 40);
    ctx.strokeStyle = '#26356b';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(14, y);
    for (let x = 14; x <= end; x += 5) ctx.lineTo(x, y + Math.sin(x * 0.7 + pad.lines * 2) * 2.5 + (Math.random() - 0.5) * 1.5);
    ctx.stroke();
    pad.lines++;
    drew = true;
  }
  if (drew) pad.tex.tex.needsUpdate = true;
}
function makePen(c: AnticCtx) {
  const pen = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.11, 8), toon('#2b6fe0'));
  body.position.y = 0.055;
  pen.add(body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.02, 8), toon('#1d2235'));
  tip.rotation.x = Math.PI;
  tip.position.y = -0.01;
  pen.add(tip);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.02, 8), toon('#e5484d'));
  cap.position.y = 0.11;
  pen.add(cap);
  pen.traverse((o) => isMesh(o) && (o.castShadow = true));
  c.set.office.add(pen);
  return pen;
}
type Mapped = THREE.Material & { map?: THREE.Texture | null }; // (a material, maybe with a texture)
function disposeProp(obj: THREE.Object3D | null | undefined) {
  if (!obj) return;
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    o.geometry.dispose();
    for (const m of ([] as Mapped[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

// Write on the pad: it's held in front of its chest (left hand), tipped up so you see
// the page; the pen (right hand) scrawls along a line (across 0..1), or rests at the
// pad's corner while it thinks (pause 0..1).
function writePose(c: AnticCtx, A: AnticPose, pad: Pad, pen: THREE.Object3D, k: number, line: number, across: number, pause = 0) {
  const size = c.robot.root.scale.x / 0.82;
  at(c, c.robot.torso, -0.02, 0.25, 0.37, pad.group.position);
  c.robot.torso.getWorldQuaternion(Q1);
  c.set.office.getWorldQuaternion(Q2).invert();
  pad.group.quaternion.copy(Q1).premultiply(Q2).multiply(Q2.setFromAxisAngle(X_AXIS, 1.15)); // its page up and towards you
  pad.group.scale.setScalar(Math.max(0.001, size * k));
  // left hand under the pad
  at(c, c.robot.torso, -0.08, 0.22, 0.35, V1);
  aim(c, 'L', V1, QL);
  blend(A, 'armL', QL, k * c.w);
  // the pen's tip on the page: along the line, or lifted at the corner to think
  const px = mix(-0.065 + 0.13 * across, 0.065, pause);
  const pz = mix(-0.05 + Math.min(6, line) * 0.018, -0.065, pause);
  TIP.set(px, 0.004 + 0.03 * pause, pz);
  pad.group.localToWorld(TIP);
  c.set.office.worldToLocal(TIP);
  // the hand a pen's length up from the tip, a little to its right
  V1.copy(TIP).add(V2.set(0.03, 0.08, 0.02).multiplyScalar(size));
  aim(c, 'R', V1, QR);
  blend(A, 'armR', QR, k * c.w);
  pen.position.copy(TIP);
  pen.quaternion.setFromUnitVectors(PEN_UP, V2.copy(V1).sub(TIP).normalize());
  pen.scale.setScalar(Math.max(0.001, size * k));
}

// ---------------------------------------------------------------- the antics

// the pad antics' own scratch (c.run)
type PadRun = { pad?: Pad; pen?: THREE.Group };

// While you type a note: it writes it down on a sticky pad, nose in the page.
const notewrite: Antic<PadRun> = {
  dur: 30,
  fadeIn: 0.4,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    run.pad ||= makePad(c);
    run.pen ||= makePen(c);
    const k = seg(s, 0, 0.35);
    // a line every ~2 s, and every 7 s a little pause to think (pen up, head tilted)
    const pause = bump(s % 7, 5.4, 6.6);
    const line = Math.floor(s / 2);
    const across = (s % 2) / 2;
    writePose(c, A, run.pad, run.pen, k, line % 7, across, pause);
    if (pause < 0.3) writeLines(run.pad, line + (across > 0.5 ? 1 : 0));
    HEAD[0] = A.head[0] + 0.3 * k - 0.15 * pause;
    HEAD[1] = A.head[1] + 0.05 * Math.sin(s * 1.3);
    HEAD[2] = A.head[2] + 0.12 * pause + 0.04 * Math.sin(s * 3.1) * (1 - pause);
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, 0.08, c.w);
    A.antenna += Math.sin(s * 7) * 0.12 * c.w;
  },
  end(c) {
    disposeProp(c.run?.pad?.group);
    disposeProp(c.run?.pen);
  },
};

// ---------------------------------------------------------------- the antics (the board)

const notepin: Antic<PadRun> = {
  dur: 2.4,
  update(c, A) {
    const { s } = c;
    const slow = c.asleep ? 0.7 : 1;
    const { run } = c;
    // finishing the note on its sticky pad (the last line of writing), then the pad goes away
    run.pad ||= makePad(c, 3);
    run.pen ||= makePen(c);
    const write = seg(s, 0, 0.15) * (1 - seg(s, 0.55, 0.7));
    if (write > 0) {
      writePose(c, A, run.pad, run.pen, write, 3, Math.min(1, (s / 0.55) * slow));
      writeLines(run.pad, s > 0.3 ? 4 : 3);
      HEAD[0] = A.head[0] + 0.25 * write;
      HEAD[1] = A.head[1];
      HEAD[2] = A.head[2];
      blend(A, 'head', HEAD, c.w);
    }
    run.pen.visible = s < 0.62;
    run.pad.block.visible = s < 0.62;
    // the written sheet, torn off: in its right hand to the board, gone once it's pressed on
    if (s >= 0.55 && s < 1.27) {
      handAt(c, 'R', run.pad.group.position);
      run.pad.group.scale.setScalar(c.robot.root.scale.x / 0.82);
    }
    run.pad.group.visible = s < 1.27;
    // round to the board, press it on, and back
    const turn = turnToBoard(c);
    A.yaw += turn * seg(s, 0.55, 0.95) * (1 - seg(s, 1.7, 2.3)) * c.w;
    const p = boardPoint(c, null, V1);
    if (p) {
      p.y += 0.02 * bump(s, 1.15, 1.35); // (a little push as it presses)
      reachTo(c, A, p, s, [0.65, 1.15, 1.6, 2.2]);
    }
    if (c.asleep && c.text && s > 0.4 && s < 1.9) c.say(c.text, 'speech');
  },
  end(c) {
    disposeProp(c.run?.pad?.group);
    disposeProp(c.run?.pen);
  },
};

type TossRun = { ball?: THREE.Sprite; spot?: THREE.Vector3; from?: THREE.Vector3 };

const notetoss: Antic<TossRun> = {
  dur: 2.8,
  fadeOut: 0.3,
  update(c, A) {
    const { s, run } = c;
    const ball = run.ball || (run.ball = makeBall(c));
    const turn = turnToBoard(c);
    // grab its sticky: reach, then back in front of it to crumple
    A.yaw += turn * seg(s, 0, 0.45) * (1 - seg(s, 0.6, 1.0)) * c.w;
    if (!run.spot) run.spot = boardPoint(c, c.text, new THREE.Vector3()) || new THREE.Vector3(-1, 1, -0.7);
    reachTo(c, A, run.spot, s, [0.05, 0.55, 0.65, 0.95]);
    // crumple it with both hands in front of the chest
    const crumple = seg(s, 0.7, 0.9) * (1 - seg(s, 1.15, 1.3));
    if (crumple > 0) {
      const sq = Math.sin(s * 28) * 0.03;
      at(c, c.robot.torso, -0.06, 0.3 - sq, 0.34, V1);
      aim(c, 'L', V1, QL);
      blend(A, 'armL', QL, crumple * c.w);
      at(c, c.robot.torso, 0.06, 0.3 + sq, 0.34, V1);
      aim(c, 'R', V1, QR);
      blend(A, 'armR', QR, crumple * c.w);
    }
    // wind up and throw (towards the wastebasket, on its other side)
    const wind = seg(s, 1.2, 1.35) * (1 - seg(s, 1.4, 1.55));
    if (wind > 0) blend(A, 'armR', [-2.6, 0.35, -1.6], wind * c.w);
    const pump = bump(s, 2.15, 2.7);
    if (pump > 0) blend(A, 'armR', [-2.5, 0.25, -1.3], pump * c.w);
    A.rootY += 0.03 * bump(s, 2.15, 2.45);
    // the ball: in its hand while crumpled, then an arc into the bin
    let size = 0;
    if (s >= 0.6 && s < 1.4) {
      handAt(c, 'R', ball.position);
      size = mix(0.16, 0.1, seg(s, 0.7, 1.2));
      run.from = ball.position.clone();
    } else if (s >= 1.4 && s < 2.15) {
      arc(ball.position, run.from || BIN_MOUTH, BIN_MOUTH, seg(s, 1.4, 2.1), 0.4);
      ball.position.y -= 0.18 * seg(s, 2.05, 2.15);
      size = 0.1;
    }
    ball.scale.setScalar(Math.max(0.001, size));
    ball.visible = size > 0;
    ball.material.rotation = s * 9;
    if (once(c, 'swish', 2.1)) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI + 0.4;
        c.emit('star', c.worldPoint(c.set.office, BIN_MOUTH.x, BIN_MOUTH.y, BIN_MOUTH.z), { life: 0.6, vel: new THREE.Vector3(Math.cos(a) * 0.3, 0.35, 0.1), size: 0.07, spin: 4 });
      }
    }
  },
  end(c) {
    const ball = c.run?.ball;
    if (!ball) return;
    ball.removeFromParent();
    ball.material.dispose();
  },
};

const boardlift: Antic = {
  dur: 3.4,
  update(c, A) {
    const { s } = c;
    const turn = turnToBoard(c);
    A.yaw += turn * 0.6 * seg(s, 0, 0.45) * (1 - seg(s, 2.7, 3.2)) * c.w;
    const p = boardPoint(c, null, V1);
    if (p) reachTo(c, A, p, s, [0.05, 0.5, 2.7, 3.2]);
    A.boardLift = Math.max(A.boardLift || 0, seg(s, 0.45, 0.9) * (1 - seg(s, 2.6, 3.0)));
    // the other hand points at you, the face your way
    const point = seg(s, 0.8, 1.05) * (1 - seg(s, 2.5, 2.8));
    if (point > 0) {
      blend(A, 'armL', POINT, point * c.w);
      A.armL[0] += Math.sin(s * 9) * 0.04 * point; // a little jab, jab
    }
    HEAD[0] = A.head[0] - 0.05;
    HEAD[1] = wrap(c.camYaw - c.curYaw - A.yaw) * 0.6;
    HEAD[2] = A.head[2] + 0.08 * point;
    blend(A, 'head', HEAD, seg(s, 0.7, 1.0) * (1 - seg(s, 2.8, 3.3)) * c.w);
  },
};

const boardglance: Antic = {
  dur: 2.6,
  update(c, A) {
    const { s } = c;
    const turn = turnToBoard(c);
    A.yaw += turn * 0.5 * seg(s, 0.15, 0.6) * (1 - seg(s, 1.4, 1.9)) * c.w;
    const look = seg(s, 0.1, 0.5) * (1 - seg(s, 1.35, 1.6));
    HEAD[0] = A.head[0] + 0.08;
    HEAD[1] = A.head[1] + Math.sign(turn || 1) * 0.5;
    HEAD[2] = A.head[2];
    blend(A, 'head', HEAD, look * c.w);
    const p = boardPoint(c, null, V1);
    if (p) {
      p.y += 0.04 * bump(s, 1.1, 1.3);
      reachTo(c, A, p, s, [0.7, 1.05, 1.3, 1.6]);
    }
    // and a meaningful look at you, head on one side
    const meaning = seg(s, 1.5, 1.8) * (1 - seg(s, 2.3, 2.6));
    HEAD[0] = A.head[0] - 0.08;
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.22;
    blend(A, 'head', HEAD, meaning * c.w);
  },
};

const allclear: Antic = {
  dur: 1.8,
  update(c, A) {
    const { s } = c;
    A.yaw += Math.PI * 2 * smooth(seg(s, 0.1, 1.2));
    A.rootY += 0.06 * bump(s, 1.15, 1.55);
    const up = seg(s, 0.05, 0.3) * (1 - seg(s, 1.4, 1.75));
    blend(A, 'armL', STRETCH, up * c.w);
    blend(A, 'armR', STRETCH, up * c.w);
    if (once(c, 'stars', 0.2)) {
      const top = c.worldPoint(c.robot.head, 0, (c.robot.headTop ?? 0.6) + 0.1, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        c.emit('star', top.clone(), { life: 0.9, vel: new THREE.Vector3(Math.cos(a) * 0.5, 0.45 + Math.random() * 0.2, Math.sin(a) * 0.5), size: 0.1, gravity: 0.8, spin: 5 });
      }
    }
  },
};

const clockout: Antic = {
  dur: 2.6,
  fadeOut: 0.4,
  update(c, A) {
    const { s } = c;
    const stretch = seg(s, 0, 0.45) * (1 - seg(s, 1.1, 1.5));
    blend(A, 'armL', STRETCH, stretch * c.w);
    blend(A, 'armR', STRETCH, stretch * c.w);
    A.lean = mix(A.lean, A.lean - 0.15, stretch * c.w);
    HEAD[0] = A.head[0] - 0.3 * stretch + 0.25 * seg(s, 1.4, 2.2);
    HEAD[1] = A.head[1];
    HEAD[2] = A.head[2] + 0.2 * seg(s, 1.5, 2.3);
    blend(A, 'head', HEAD, c.w);
    // then sinks back into the chair, done for the day
    A.lean = mix(A.lean, -0.25, seg(s, 1.4, 2.4) * c.w);
    A.rootY -= 0.03 * seg(s, 1.5, 2.4);
  },
};

export const NOTES: Record<string, Antic> = { notewrite, notepin, notetoss, boardlift, boardglance, allclear, clockout };
