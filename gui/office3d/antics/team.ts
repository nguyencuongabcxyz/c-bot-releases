import { bump, mix, seg, smooth } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import { aim, at, blend, handAt, onceAt } from './common';
import * as THREE from 'three';
import { toon, glow, canvasTexture, roundRect } from '@/office3d/materials';
import type { Antic, AnticCtx } from './types';
import { type HeadBox, headBox, towardScreen, scaleOf, dispose, popIn, lerp3, M1, B2, M2 } from './team-common';
import { JITTER } from './jitter';
import { JIRA } from './jira';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const PL = [0, 0, 0];
const PR = [0, 0, 0];
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const BOX = new THREE.Box3();
const X_AXIS = new THREE.Vector3(1, 0, 0);

// The monitor is right behind the chair as you see it, so facing it means showing
// you its back: turn at most `most` towards it (the short way round) and let the
// head look the rest of the way, at most `look`. Returns [body, head] yaw.
type Leg = {
  hip: THREE.Object3D;
  q: THREE.Quaternion;
  knee: THREE.Vector3;
  parts: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[];
};
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
      const box = o.geometry.boundingBox; // (computed just above if it wasn't, so always there)
      if (box) BOX.union(B2.copy(box).applyMatrix4(M2.multiplyMatrices(M1, o.matrixWorld)));
    });
  }
  return BOX.isEmpty() ? -0.55 : BOX.min.y;
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
    run.hb ||= headBox(c);
    const hb = run.hb;
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
    for (const [side, key, out, sd] of [
      ['L', 'armL', QL, -1],
      ['R', 'armR', QR, 1],
    ] as const) {
      const head = aim(c, side, at(c, c.robot.head, sd * (hb.hw + 0.03), hb.cy, hb.cz + 0.1, V1), out, 1.5);
      for (let i = 0; i < 3; i++) PL[i] = mix(A[key][i], out[i], clutch);
      aim(c, side, at(c, c.robot.root, sd * 0.2, 0.2 + 0.03 * breath, 0.3, V1), PR);
      PR[1] += 0.12; // elbows out a little
      for (let i = 0; i < 3; i++) PL[i] = mix(PL[i], PR[i], zen);
      blend(A, key, PL, c.w);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, head, clutch * c.w);
    }
    if (onceAt(c, 'exhale', 4.6)) {
      // a long breath out, away from the face
      const mouth = at(c, c.robot.head, 0, hb.cy * 0.6, hb.front + 0.05, V1);
      const dir = at(c, c.robot.head, 0, hb.cy * 0.6 - 0.3, hb.front + 1.0, V2)
        .sub(mouth)
        .normalize();
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
  lid.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.17, 0.008), [
      shell,
      shell,
      shell,
      shell,
      face,
      glow('#ffffff', { map: screen.tex }),
    ]).translateY(0.085),
  );
  g.add(lid);
  g.traverse((o) => {
    if (isMesh(o)) o.castShadow = true;
  });
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
      const m = c.set.screen.light.parent; // the monitor group
      const desk = m?.parent; // (what it stands on)
      const chair = c.set.swivel.parent;
      if (!m || !desk || !chair) return; // (the set always has them)
      run.hb = headBox(c);
      const hb = run.hb;
      // where it's hugged: beside its head as it sits up (on your left of it), a bit
      // towards you, screen out (worked out from the chair, not the pose it's in now)
      const S = c.robot.root.scale.x;
      const side = 0.53 + hb.hw * S;
      const to = chair.position.clone();
      to.x += -Math.cos(c.camYaw) * side + Math.sin(c.camYaw) * 0.12;
      to.z += Math.sin(c.camYaw) * side + Math.cos(c.camYaw) * 0.12;
      to.y = c.set.swivel.position.y + 0.09 + S * (c.robot.torso.position.y + c.robot.head.position.y + hb.cy) - 0.7;
      run.mon = {
        m,
        p: m.position.clone(),
        r: m.rotation.clone(),
        to: desk.worldToLocal(c.set.office.localToWorld(to)),
      };
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
    if (onceAt(c, 'hearts', 2.5)) {
      const top = at(c, c.robot.head, -hb.hw * 0.5, hb.top, 0, V1);
      for (let i = 0; i < 3; i++)
        c.emit('heart', top, { life: 1.3, vel: new THREE.Vector3((i - 1) * 0.15, 0.5, 0.05), size: 0.13 });
    }
  },
  end(c) {
    const mon = c.run?.mon;
    if (!mon) return;
    mon.m.position.copy(mon.p);
    mon.m.rotation.copy(mon.r);
  },
};

export const TEAM: Record<string, Antic> = { merge, standup, ...JIRA, works, ...JITTER };
