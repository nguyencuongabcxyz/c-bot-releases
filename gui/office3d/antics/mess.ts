// Desk mishaps: yanking a cable out (and the screen with it), and shaking the crumbs (sometimes
// a whole cookie) out of the keyboard.
import * as THREE from 'three';
import { toon, glow } from '@/office3d/materials';
import type { Antic, Vec3Tuple } from './types';
import { turnTo, track, at, aim, blend, onceAt, handAt, type PropMesh, yawOf } from './common';
import { sideOf, win, set3, dispose, puff } from './desk-common';
import { bump, seg, mix, clamp, wrap } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import { LAYOUT } from '@/office3d/scene';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const QL: Vec3Tuple = [0, 0, 0];
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

type Side = 'L' | 'R';

// ------------------------------------------------------------ cable

// Leans down and grabs a cable from under the desk (0.4–1.0), tugs (1.2, 1.6),
// YANKS (2.2): the desk shakes, the lamp and the screen flicker. Freezes, busted
// (2.8–3.8), lets go, and the cable slithers back under the desk.
const PLUG_AT = new THREE.Vector3(0.3, 0, -0.66); // a power strip on the floor, under the desk's front corner
const GRAB_AT = new THREE.Vector3(0.38, 0.3, -0.47); // where it takes hold: down beside the seat, in view
const CABLE_SEGS = 28;
const CABLE_SIDES = 6;
const CABLE_R = 0.016;

function buildCable() {
  const g = new THREE.Group();
  const strip = new THREE.Group();
  strip.position.copy(PLUG_AT);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.07), toon('#e9ecf5'));
  box.position.y = 0.023;
  strip.add(box);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), glow('#ff5e62'));
  led.position.set(0.075, 0.047, 0);
  strip.add(led);
  strip.rotation.y = 0.35;
  g.add(strip);
  // the cable's tube: its rings are moved every frame (no new geometry)
  const geo = new THREE.TubeGeometry(
    new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
    CABLE_SEGS,
    CABLE_R,
    CABLE_SIDES,
    false,
  );
  const cable = new THREE.Mesh(geo, toon('#2b2f3d', { side: THREE.DoubleSide }));
  cable.frustumCulled = false;
  cable.castShadow = true;
  g.add(cable);
  return { g, strip, cable };
}

const BZ = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const T = new THREE.Vector3();
const N = new THREE.Vector3();
const B = new THREE.Vector3();
const REF = new THREE.Vector3();
const bez = (out: THREE.Vector3, k: number, [a, b, c]: THREE.Vector3[]) =>
  out
    .set(0, 0, 0)
    .addScaledVector(a, (1 - k) * (1 - k))
    .addScaledVector(b, 2 * k * (1 - k))
    .addScaledVector(c, k * k);
// lay the tube along a quadratic curve a -> b -> c
function bendCable(cable: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  BZ[0].copy(a);
  BZ[1].copy(b);
  BZ[2].copy(c);
  const pos = cable.geometry.attributes.position;
  const nor = cable.geometry.attributes.normal;
  for (let i = 0; i <= CABLE_SEGS; i++) {
    const k = i / CABLE_SEGS;
    bez(V3, k, BZ);
    // tangent: the curve's derivative
    T.copy(BZ[1])
      .sub(BZ[0])
      .multiplyScalar(2 * (1 - k))
      .addScaledVector(V4.copy(BZ[2]).sub(BZ[1]), 2 * k);
    if (T.lengthSq() < 1e-8) T.set(0, 1, 0);
    T.normalize();
    REF.set(0, 1, 0);
    if (Math.abs(T.y) > 0.9) REF.set(1, 0, 0);
    N.crossVectors(T, REF).normalize();
    B.crossVectors(T, N);
    for (let j = 0; j <= CABLE_SIDES; j++) {
      const v = (j / CABLE_SIDES) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const nx = cos * N.x + sin * B.x;
      const ny = cos * N.y + sin * B.y;
      const nz = cos * N.z + sin * B.z;
      const idx = i * (CABLE_SIDES + 1) + j;
      nor.setXYZ(idx, nx, ny, nz);
      pos.setXYZ(idx, V3.x + CABLE_R * nx, V3.y + CABLE_R * ny, V3.z + CABLE_R * nz);
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

const YANK_TO = new THREE.Vector3(0.58, 0.62, 0); // the yank: the hand flies up above its shoulder (torso space)

// (turn and side are set with the cable, on the first frame)
type CableRun = { cable?: ReturnType<typeof buildCable>; turn: number; side: Side; mid?: THREE.Vector3 };

const cable: Antic<CableRun> = {
  dur: 4.5,
  fadeOut: 0.4,
  update(c, A) {
    const { s, run } = c;
    if (!run.cable) {
      run.cable = buildCable();
      c.set.office.add(run.cable.g);
      run.turn = turnTo(c, GRAB_AT, 1.6); // just a little: bent down, it'd only show the top of its head
      run.side = sideOf(c, GRAB_AT);
    }
    const { strip, cable: tube } = run.cable;
    const sd = run.side === 'L' ? -1 : 1;
    const near = run.side === 'L' ? 'armL' : 'armR';
    A.yaw =
      track(s, 0, [
        [0, 0.5, run.turn],
        [3.8, 4.4, 0],
      ]) * c.w;

    // the hand: down to the cable, little tugs, the big yank, frozen up there, then back
    const tug = 0.07 * (bump(s, 1.1, 1.35) + bump(s, 1.5, 1.75));
    const crouch = 0.05 * win(s, 1.85, 2.1, 2.15, 2.2);
    const yank = seg(s, 2.15, 2.3);
    at(c, c.robot.torso, sd * YANK_TO.x, YANK_TO.y, YANK_TO.z, V3);
    V2.lerpVectors(GRAB_AT, V3, yank);
    V2.y += tug - crouch;
    if (s > 2.3 && s < 2.8) V2.y += 0.03 * Math.sin((s - 2.3) * 30) * (1 - (s - 2.3) / 0.5); // recoil
    const r = aim(c, run.side, V2, QR, 2.6);
    const hold = win(s, 0.4, 1.0, 3.8, 4.3);
    blend(A, near, QR, hold * c.w);
    A[near === 'armL' ? 'reachL' : 'reachR'] = mix(1, r, hold * c.w);
    // the other hand braces on the knee, then flies up in the "oops"
    const other = near === 'armL' ? 'armR' : 'armL';
    set3(PL, -0.55, 0.15, -0.7);
    blend(A, other, PL, win(s, 0.4, 0.9, 2.1, 2.3) * c.w);
    set3(PL, -1.5, 0.65, -1.6);
    blend(A, other, PL, win(s, 2.25, 2.45, 3.8, 4.2) * c.w);
    // bent right down; thrown back by the yank; frozen
    const down = win(s, 0.4, 1.0, 2.15, 2.35);
    A.lean = mix(
      A.lean,
      A.lean + 0.3 * down + (0.08 * crouch) / 0.05 - 0.14 * win(s, 2.2, 2.35, 3.8, 4.3) - (0.04 * tug) / 0.07,
      c.w,
    );
    A.rootY += 0.06 * bump(s, 2.2, 2.55) * c.w;
    // head: down at the cable, then (2.8) slowly round to you: busted
    const busted = win(s, 2.75, 3.05, 3.8, 4.2);
    HEAD[0] = mix(A.head[0] - 0.1 * down - 0.15 * bump(s, 2.2, 2.6), 0.02, busted); // chin up, so the face shows
    HEAD[1] = mix(sd * 0.15 * seg(s, 0.2, 0.7) * (1 - seg(s, 3.8, 4.3)), -run.turn * 0.75, busted);
    HEAD[2] = A.head[2] + 0.08 * Math.sin(s * 40) * bump(s, 2.2, 2.6);
    blend(A, 'head', HEAD, c.w);

    // YANK (2.2): the desk jolts, the mug jumps, the lamp and the screen flicker
    if (s >= 2.2 && s < 2.8) {
      const k = 1 - (s - 2.2) / 0.6;
      A.shake = Math.max(A.shake, k);
      A.mug.y += 0.05 * bump(s, 2.2, 2.45);
      A.mugTilt += 0.22 * Math.sin((s - 2.2) * 38) * k;
      A.lamp = Math.floor(s * 22) % 3 === 0 ? 0.1 : Math.floor(s * 22) % 3 === 1 ? 1 : 0.4;
      A.screen = 'idle';
      A.screenDim = Math.floor(s * 17) % 2 ? 0.85 : 0.1;
    }
    if (onceAt(c, 'sweat', 2.9))
      c.emit('sweat', at(c, c.robot.head, 0.34, 0.5, 0.1, V1), {
        life: 0.9,
        vel: new THREE.Vector3(0.05, -0.35, 0),
        size: 0.08,
      });

    // the cable: from the power strip, along the floor, up into the hand
    strip.position.copy(PLUG_AT);
    strip.position.y = 0.05 * bump(s, 2.2, 2.45);
    strip.position.x -= 0.05 * seg(s, 2.2, 2.3);
    strip.position.z += 0.05 * seg(s, 2.2, 2.3);
    V1.set(-0.06, 0.03, 0.02)
      .applyAxisAngle(V4.set(0, 1, 0), strip.rotation.y)
      .add(strip.position); // its plug
    const floor = V3.set(GRAB_AT.x - 0.04, 0.012, GRAB_AT.z + 0.02);
    handAt(c, run.side, V2);
    let end: THREE.Vector3;
    if (s < 3.85) end = V4.lerpVectors(floor, V2, seg(s, 0.85, 1.0));
    else {
      // dropped... and it slithers back to the power strip
      end = V4.lerpVectors(V2, floor, seg(s, 3.85, 4.0));
      end.lerp(V1, seg(s, 4.0, 4.45) * 0.85);
    }
    // slack on the floor while it lies there, taut as it's pulled
    const taut =
      s < 3.85
        ? 0.25 * seg(s, 0.9, 1.1) + 0.3 * (bump(s, 1.1, 1.35) + bump(s, 1.5, 1.75)) + 0.75 * seg(s, 2.15, 2.25)
        : 0;
    run.mid ||= new THREE.Vector3();
    const mid = run.mid;
    mid.lerpVectors(V1, end, 0.5);
    mid.y = mix(0, mid.y, clamp(taut, 0, 1)); // (pulled down onto the floor while slack)
    bendCable(tube, V1, mid, end);
    tube.visible = s < 4.45;
  },
  end(c) {
    dispose(c.run?.cable?.g);
  },
};

// ------------------------------------------------------------ crumbs

// Lifts the keyboard off the desk (0–0.4), carries it round in front of itself
// turning it upside down (0.4–1.0) and shakes it (1.2–2.8): crumbs rain out (and
// in 'crumbs-cookie' a whole cookie, 2.6, lands on the floor). Puts it back (3.2–4.0).
const KB_HALF = 0.25; // where the hands take it, along the keyboard
const HOLD_R = 0.55; // how far in front of the chair it's held
const HOLD_Y = 0.8; // (below the face)
const TILT = 0.55; // upside down, and tipped so you see the keys
const COOKIE_SIZE = 1.8;
const GRAVITY = 5.5; // a cartoon fall

function buildCookie() {
  const g = new THREE.Group();
  const dough = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 20), toon('#d9a05b'));
  g.add(dough);
  const chip = toon('#4a2c1d');
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4;
    const r = 0.012 + (i % 3) * 0.01;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6), chip);
    m.position.set(Math.cos(a) * r, i % 2 ? 0.007 : -0.007, Math.sin(a) * r);
    m.scale.y = 0.6;
    g.add(m);
  }
  g.traverse((o) => {
    if (isMesh<PropMesh>(o)) o.castShadow = true;
  });
  return g;
}

const EUL = new THREE.Euler(0, 0, 0, 'YXZ');

// (the rest is set with home, on the first frame; c0 and cv with the cookie)
type CrumbsRun = {
  home?: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 };
  base: number;
  relHome: number;
  sd: number;
  rHome: number;
  yHome: number;
  spinHome: number;
  nextCrumb?: number;
  cookie?: THREE.Group;
  c0: THREE.Vector3;
  cv: THREE.Vector3;
};

function crumbs(cookie: boolean): Antic<CrumbsRun> {
  return {
    dur: 5.0,
    fadeOut: 0.4,
    update(c, A) {
      const { s, run } = c;
      const kb = c.set.keyboard;
      if (!run.home) {
        run.home = { pos: kb.position.clone(), quat: kb.quaternion.clone(), scale: kb.scale.clone() };
        at(c, kb, 0, 0, 0, V1);
        run.base = c.curYaw;
        run.relHome = wrap(yawOf(V1) - run.base);
        run.sd = run.relHome < 0 ? -1 : 1;
        run.rHome = Math.hypot(V1.x - LAYOUT.chair.x, V1.z - LAYOUT.chair.z);
        run.yHome = V1.y;
        run.spinHome = wrap(kb.rotation.y - yawOf(V1)); // its own turn, relative to the way round the chair
      }
      const { sd } = run;
      const relFront = sd * 0.42;
      // swivel towards the keyboard to take it, face it while shaking, again to put it back
      A.yaw =
        track(s, 0, [
          [0, 0.35, sd * 0.7],
          [0.45, 1.0, relFront],
          [3.15, 3.6, sd * 0.7],
          [4.0, 4.6, 0],
        ]) * c.w;

      // the keyboard: lifted, carried round the chair to in front, flipped, shaken, back
      const k = seg(s, 0.42, 1.0) - seg(s, 3.2, 3.85);
      const lift = 0.1 * (seg(s, 0.2, 0.42) - seg(s, 3.82, 4.0));
      const roll = (Math.PI + TILT) * (seg(s, 0.5, 1.0) - seg(s, 2.8, 3.2));
      const shake = win(s, 1.15, 1.25, 2.75, 2.85);
      const th = run.base + mix(run.relHome, relFront, k);
      const r = mix(run.rHome, HOLD_R, k);
      V1.set(LAYOUT.chair.x + Math.sin(th) * r, mix(run.yHome, HOLD_Y, k) + lift, LAYOUT.chair.z + Math.cos(th) * r);
      V1.y += 0.045 * Math.sin(s * 34) * shake;
      V1.x += 0.025 * Math.sin(s * 23) * shake * Math.cos(th);
      V1.z -= 0.025 * Math.sin(s * 23) * shake * Math.sin(th);
      if (s < 4.0) {
        c.set.office.localToWorld(kb.position.copy(V1));
        kb.parent?.worldToLocal(kb.position); // (it's on the desk's top)
        EUL.set(
          roll + 0.18 * Math.sin(s * 29) * shake,
          th + mix(run.spinHome, Math.PI, k),
          0.12 * Math.sin(s * 19) * shake,
        );
        kb.quaternion.setFromEuler(EUL);
      } else {
        kb.position.copy(run.home.pos);
        kb.quaternion.copy(run.home.quat);
      }

      // both hands on its ends (held in front, its +x end is on the robot's left)
      const grab = win(s, 0.0, 0.3, 3.95, 4.4);
      for (const [side, out, key, end] of [
        ['L', QL, 'armL', 1],
        ['R', QR, 'armR', -1],
      ] as const) {
        const st = aim(c, side, at(c, kb, end * KB_HALF, 0.0, 0, V2), out, 2.4);
        blend(A, key, out, grab * c.w);
        A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, st, grab * c.w);
      }
      A.lean = mix(A.lean, A.lean + 0.12 * k - 0.04 * shake + 0.02 * Math.sin(s * 34) * shake, c.w);
      A.rootY += 0.012 * Math.sin(s * 34 + 1) * shake * c.w; // the whole body shakes with it
      // head: on the keyboard (down at the floor once the cookie drops)
      HEAD[0] = track(s, A.head[0], [
        [0.1, 0.5, 0.15],
        [1.2, 1.5, 0.05],
        [2.6, 2.8, cookie ? 0.32 : 0.05],
        [3.2, 3.6, 0.15],
        [4.0, 4.6, A.head[0]],
      ]);
      HEAD[1] =
        sd *
        track(s, 0, [
          [0.1, 0.4, 0.35],
          [0.6, 1.0, 0],
          [3.2, 3.6, 0.35],
          [4.0, 4.6, 0],
        ]);
      HEAD[2] = A.head[2] + 0.12 * shake * sd;
      blend(A, 'head', HEAD, c.w);

      // crumbs rain out of the upside-down keyboard
      if (shake > 0.2 && s >= (run.nextCrumb ?? 0)) {
        run.nextCrumb = s + 0.05;
        for (let i = 0; i < 2; i++) {
          at(c, kb, (Math.random() - 0.5) * 0.46, 0.03, (Math.random() - 0.5) * 0.12, V2);
          c.emit('crumb', V2, {
            life: 0.75,
            vel: new THREE.Vector3(
              (Math.random() - 0.5) * 0.4,
              -0.1 - Math.random() * 0.3,
              (Math.random() - 0.5) * 0.4,
            ),
            size: 0.045 + Math.random() * 0.03,
            gravity: 2.4,
            spin: 6,
          });
        }
      }

      // ...and a whole cookie (2.6): falls, bounces, lies there
      if (cookie && s >= 2.6) {
        if (!run.cookie) {
          run.cookie = buildCookie();
          run.cookie.scale.setScalar(COOKIE_SIZE);
          c.set.office.add(run.cookie);
          run.c0 = at(c, kb, 0.05, 0.03, 0, new THREE.Vector3());
          // it skids off sideways (to your right), so it lands in view
          run.cv = new THREE.Vector3(Math.cos(c.camYaw), 0, -Math.sin(c.camYaw)).multiplyScalar(0.3);
        }
        const ck = run.cookie;
        const fall = Math.sqrt((2 * (run.c0.y - 0.012)) / GRAVITY);
        const t = s - 2.6;
        if (t < fall) {
          ck.position.copy(run.c0).addScaledVector(run.cv, t);
          ck.position.y = Math.max(0.012, run.c0.y - 0.5 * GRAVITY * t * t);
          ck.rotation.set(t * 9, 0, t * 5);
        } else {
          // one small bounce, then flat on the floor
          const b = t - fall;
          ck.position.copy(run.c0).addScaledVector(run.cv, fall + Math.min(b, 0.3) * 0.5);
          ck.position.y = COOKIE_SIZE * 0.007 + 0.07 * bump(b, 0, 0.25);
          const flat = seg(b, 0, 0.3);
          ck.rotation.set(
            mix(fall * 9, Math.round((fall * 9) / Math.PI) * Math.PI, flat),
            0,
            mix(fall * 5, Math.round((fall * 5) / Math.PI) * Math.PI, flat),
          );
          if (onceAt(c, 'thud', 2.6 + fall)) puff(c, ck.position, 4, 0.05);
        }
        const size = s < 4.55 ? 1 : Math.max(0, 1 - (s - 4.55) / 0.3);
        ck.scale.setScalar(Math.max(0.001, size * COOKIE_SIZE));
      }
    },
    end(c) {
      const run = c.run;
      if (run?.home) {
        const kb = c.set.keyboard;
        kb.position.copy(run.home.pos);
        kb.quaternion.copy(run.home.quat);
        kb.scale.copy(run.home.scale);
      }
      dispose(run?.cookie);
    },
  };
}

export const MESS: Record<string, Antic> = {
  cable,
  crumbs: crumbs(false),
  'crumbs-cookie': crumbs(true),
};
