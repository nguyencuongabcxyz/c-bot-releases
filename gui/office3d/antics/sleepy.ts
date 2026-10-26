import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, canvasTexture, noOutline, roundRect } from '@/office3d/materials';
import { LAYOUT } from '@/office3d/scene';
import type { RigArm } from '@/office3d/types';
import type { Antic, AnticCtx, ParticleKind } from './types';

// More antics while asleep, in the chair (eye mask) or curled up on the floor:
//   nightmare  tosses and turns dreaming that prod is down, jolts awake (2.6),
//              looks round panting, "…just a dream" (4.2), back to sleep from 5.2
//   snorebar   its snoring fills a progress bar over its head: four big snores
//              (0.6, 2.4, 4.2, 6.0) of +25% each, "Sleep.exe ✓ 100%" at 6.2, rolls over at 7.6
//   ping       a 3 am message lights up a phone beside it (0.2) and buzzes (0.3, 0.9, 1.5);
//              without waking, an arm swings out and slaps it face-down (2.8), then snuggles back
// Timings are a contract: robot.js plays sounds and sets the face at the marked moments.

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a));
const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
// overshoots a little, then settles (the bar's fill bouncing in)
const backOut = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2);
const once = (run: Record<string, unknown>, key: string) => (run[key] ? false : (run[key] = true));
const floor = (c: AnticCtx) => c.bed?.onFloor ?? c.sleepStyle === 'floor'; // lying in bed on the floor
const headTop = (c: AnticCtx) => c.robot.headTop ?? 0.6;
const size = (c: AnticCtx) => c.robot.root.scale.x / 0.82; // custom models are scaled differently
// a smooth curve through [time, value] keys
function keys(s: number, ks: [number, number][]) {
  if (s <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (s < ks[i][0]) return mix(ks[i - 1][1], ks[i][1], smooth((s - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0])));
  }
  return ks[ks.length - 1][1];
}

// scratch, so nothing is allocated per frame
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const AX = new THREE.Vector3();
const Q = new THREE.Quaternion();
const QW = [0, 0, 0];
const QS = [0, 0, 0];

// a point on obj, in office space
const at = (c: AnticCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));
// the camera's right, flat on the floor (office space)
const camRight = (c: AnticCtx, out: THREE.Vector3) => out.set(Math.cos(c.camYaw), 0, -Math.sin(c.camYaw));

// Arm angles [pitch, out, elbow] that put the hand on a point (office space), as in phone.js;
// returns the stretch needed if it's too far.
const HAND = 0.24;
function aim(c: AnticCtx, side: 'L' | 'R', p: THREE.Vector3, out: number[], most = 1.9) {
  const arm = c.robot.arms[side === 'L' ? 'armL' : 'armR'];
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

// On the floor the bed poses the arms after update(), so place() sets them itself:
// blends the arm from where the bed put it towards [pitch, out, elbow].
function poseArm(arm: RigArm, q: number[], k: number) {
  const sh = arm.shoulder.rotation;
  sh.set(mix(sh.x, q[0], k), mix(sh.y, 0, k), mix(sh.z, q[1] * arm.side, k));
  arm.elbow.rotation.x = mix(arm.elbow.rotation.x, q[2], k);
}

// Lying on its side: tip it about an axis through its hips (office space). The bed has
// just placed it, so this is on top of that, and the bed puts it back next frame.
// along: 'U' its length (rolls it), 'V' across it (+ lifts its head and shoulders).
function tilt(c: AnticCtx, along: 'U' | 'V', angle: number, lift = 0) {
  const root = c.robot.root;
  if (along === 'U') AX.set(0, 1, 0).applyQuaternion(root.quaternion); // its head end
  else {
    // across the body, horizontal: tipping about it lifts the head end up off the pillow
    AX.set(0, 1, 0).applyQuaternion(root.quaternion);
    AX.set(-AX.z, 0, AX.x).normalize();
  }
  root.quaternion.premultiply(Q.setFromAxisAngle(AX, angle));
  root.position.y += lift;
}

function sprite(w: number, h: number) {
  const tex = canvasTexture(w, h);
  const mat = new THREE.SpriteMaterial({ map: tex.tex, transparent: true, depthWrite: false, depthTest: false });
  noOutline(mat);
  const s = new THREE.Sprite(mat);
  s.renderOrder = 10; // over the desk and the robot, like the speech bubble
  return { s, mat, ...tex };
}

// (three's types leave the isMesh / isSprite / isLight flags off Object3D)
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => 'isMesh' in o;
const isSprite = (o: THREE.Object3D): o is THREE.Sprite => 'isSprite' in o;
const isLight = (o: THREE.Object3D): o is THREE.Light => 'isLight' in o;
type Mapped = THREE.Material & { map?: THREE.Texture | null }; // (a material, maybe with a texture)
function dispose(obj: THREE.Object3D) {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (isLight(o)) o.dispose();
    if (!isMesh(o) && !isSprite(o)) return;
    if (isMesh(o)) o.geometry.dispose(); // sprites share one geometry
    // (one material each: the phone's parts, the sprites)
    (o.material as Mapped).map?.dispose();
    (o.material as Mapped).dispose();
  });
}

const sweat = (c: AnticCtx) => c.emit('sweat', c.worldPoint(c.robot.head, 0.32, headTop(c) * 0.85, 0.12), { life: 0.8, vel: new THREE.Vector3(0.15 + Math.random() * 0.1, 0.3, 0), size: 0.08, gravity: 1.1 });
function puff(c: AnticCtx, where: THREE.Vector3, n = 5, kind: ParticleKind = 'star') {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    c.emit(kind, where, { life: 0.5, vel: new THREE.Vector3(Math.cos(a) * 0.45, Math.sin(a) * 0.3 + 0.35, 0.1), size: 0.07, gravity: 0.6, spin: 4 });
  }
}

// ------------------------------------------------------------ nightmare

// how far it looks left / right once it's up (head yaw)
const LOOK: [number, number][] = [[2.8, 0], [3.1, 0.65], [3.5, 0.65], [3.85, -0.65], [4.15, -0.5], [4.4, 0]];

type NightmareRun = { mask?: THREE.Object3D | null; nextSweat?: number; up?: number };

const nightmare: Antic<NightmareRun> = {
  dur: 6.5,
  fadeIn: 0.4,
  fadeOut: 0.3,
  update(c, A) {
    const { s, w, run } = c;
    if (run.mask === undefined) run.mask = floor(c) ? null : c.robot.head.getObjectByName('sleep-mask');
    // 0–2.4 tossing and turning, fading as the jolt comes
    const toss = w * seg(s, 0, 0.4) * (1 - seg(s, 2.3, 2.6));
    A.head[1] += toss * Math.sin(s * 4.4) * 0.5;
    A.head[2] += toss * Math.sin(s * 4.4 + 1.2) * 0.12;
    A.head[0] += toss * Math.abs(Math.sin(s * 8.8)) * 0.06;
    A.armL[1] += toss * Math.max(0, Math.sin(s * 11)) ** 4 * 0.5;
    A.armR[1] += toss * Math.max(0, Math.sin(s * 9 + 2)) ** 4 * 0.5;
    A.armR[0] -= toss * Math.max(0, Math.sin(s * 7 + 1)) ** 6 * 0.4;
    if (!floor(c)) A.yaw += toss * Math.sin(s * 2.2) * 0.12;
    if (s > 0.4 && s < 2.5) c.say('🔥PROD DOWN🔥', 'thought');
    if (s > 0.3 && s < 2.6) {
      A.screen = 'dream:🔥';
      A.screenDim = 0.55;
    }
    if (s > 0.6 && s < 2.4 && s >= (run.nextSweat || 0)) {
      run.nextSweat = s + 0.45;
      sweat(c);
    }

    // 2.6 the jolt: bolt upright (the floor lifts its shoulders in place()), until it settles at 5.2–6.5
    run.up = smooth((s - 2.6) / 0.12) * (1 - seg(s, 5.2, 6.5));
    const up = run.up;
    if (s >= 2.6 && once(run, 'jolt')) {
      sweat(c);
      sweat(c);
    }
    if (s >= 2.6) A.shake = Math.max(A.shake, 0.5 * (1 - seg(s, 2.6, 3.0)));
    // panting, 2.8–4.4
    const pant = up * seg(s, 2.7, 2.9) * (1 - seg(s, 4.2, 4.6));
    const heave = Math.sin(s * 15) * pant;
    if (!floor(c)) {
      A.lean = mix(A.lean, 0.06 + heave * 0.035, up);
      A.rootY += 0.03 * up;
      // arms flung up at the jolt, down again by 3.6
      const fling = up * (1 - seg(s, 3.0, 3.6));
      A.armL[0] = mix(A.armL[0], -2.8, fling);
      A.armL[1] = mix(A.armL[1], 0.6, fling);
      A.armL[2] = mix(A.armL[2], -0.25, fling);
      A.armR[0] = mix(A.armR[0], -2.8, fling);
      A.armR[1] = mix(A.armR[1], 0.6, fling);
      A.armR[2] = mix(A.armR[2], -0.25, fling);
    }
    A.head[0] = mix(A.head[0], (floor(c) ? -0.25 : 0) + heave * 0.04, up);
    A.head[1] = mix(A.head[1], keys(s, LOOK), up);
    A.head[2] = mix(A.head[2], 0, up);
    if (s > 4.2 && s < 5.5) c.say(c.text || '…just a dream', 'speech');
    // the eye mask flies up onto its forehead, and comes back down as it dozes off
    if (run.mask) run.mask.position.y = 0.24 * headTop(c) * smooth((s - 2.6) / 0.1) * (1 - seg(s, 5.6, 6.2));
  },
  place(c) {
    if (!floor(c)) return;
    const { s, w, run } = c;
    // tossing: rolls a little back and forth; the hands twitch under its chin
    const toss = w * seg(s, 0, 0.4) * (1 - seg(s, 2.3, 2.6));
    tilt(c, 'U', Math.sin(s * 4.4) * 0.1 * toss);
    const arms = c.robot.arms;
    arms.armR.shoulder.rotation.x += toss * Math.max(0, Math.sin(s * 9 + 2)) ** 4 * 0.5;
    arms.armL.shoulder.rotation.x += toss * Math.max(0, Math.sin(s * 11)) ** 4 * 0.4;
    // the jolt: head and shoulders shoot up off the pillow, propped on its elbow, panting
    const up = run.up || 0;
    const heave = Math.sin(s * 15) * up * (1 - seg(s, 4.2, 4.6));
    tilt(c, 'V', (0.7 + heave * 0.03) * up * w, 0.06 * up * w);
  },
  end(c) {
    if (c.run?.mask) c.run.mask.position.y = 0;
  },
};

// ------------------------------------------------------------ snorebar

const SNORES = [0.6, 2.4, 4.2, 6.0];
const ZS = SNORES.map((t, i) => `z${i}`); // their one-shot keys
const BAR_W = 320;
const BAR_H = 112;

type Bar = ReturnType<typeof sprite> & { drawn?: string };
// (barY is set along with the bar, on the first frame)
type SnoreRun = { bar?: Bar; barY: number; inhale?: number };

function drawBar(b: Bar, fill: number, done: boolean) {
  const { ctx } = b;
  ctx.clearRect(0, 0, BAR_W, BAR_H);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#1d2235';
  ctx.fillStyle = '#fff';
  roundRect(ctx, 4, 4, BAR_W - 8, BAR_H - 8, 22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1d2235';
  ctx.textBaseline = 'middle';
  ctx.font = '800 30px "Segoe UI", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(done ? 'Sleep.exe ✓' : 'Sleep.exe', 20, 33);
  ctx.textAlign = 'right';
  ctx.fillStyle = done ? '#1f9d4c' : '#1d2235';
  ctx.fillText(`${Math.round(clamp(fill, 0, 1) * 100)}%`, BAR_W - 20, 33);
  // the track, and its fill (a highlight along the top so it reads as a bar)
  ctx.lineWidth = 4;
  ctx.fillStyle = '#e3e7f2';
  roundRect(ctx, 18, 58, BAR_W - 36, 36, 18);
  ctx.fill();
  const fw = (BAR_W - 36) * clamp(fill, 0, 1.03);
  if (fw > 2) {
    ctx.fillStyle = done ? '#34c759' : '#7c6cf0';
    roundRect(ctx, 18, 58, Math.max(36, fw), 36, 18);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(ctx, 26, 63, Math.max(20, fw - 16), 9, 4.5);
    ctx.fill();
  }
  ctx.strokeStyle = '#1d2235';
  roundRect(ctx, 18, 58, BAR_W - 36, 36, 18);
  ctx.stroke();
  b.tex.needsUpdate = true;
}

const snorebar: Antic<SnoreRun> = {
  dur: 9.0,
  fadeIn: 0.3,
  fadeOut: 0.5,
  update(c, A) {
    const { s, w, run } = c;
    if (!run.bar) {
      run.bar = sprite(BAR_W, BAR_H);
      run.bar.drawn = '';
      c.set.office.add(run.bar.s);
      // where it floats: over its head (lying down: above it, nudged in from the window's edge)
      const top = headTop(c);
      // (a little to one side, so the z's float up past it)
      if (floor(c)) at(c, c.robot.head, 0, top * 0.4, 0, run.bar.s.position).add(camRight(c, V1).multiplyScalar(0.5)).y += 0.72 * size(c);
      else at(c, c.robot.head, 0, top * 0.8, 0, run.bar.s.position).add(camRight(c, V1).multiplyScalar(-0.16)).y += 0.42 * size(c);
      run.barY = run.bar.s.position.y;
    }
    const bar = run.bar;

    // each snore: a long inhale, the snort (a big z, the desk rattles), the bar fills +25%
    let inhale = 0;
    let fill = 0;
    let pop = 0;
    for (let i = 0; i < SNORES.length; i++) {
      const t0 = SNORES[i];
      inhale = Math.max(inhale, s < t0 ? seg(s, t0 - 0.6, t0) : 1 - seg(s, t0, t0 + 0.6));
      fill += 0.25 * backOut((s - t0 - 0.05) / 0.4);
      pop = Math.max(pop, bump(s, t0 + 0.05, t0 + 0.35));
      if (s >= t0 && once(run, ZS[i])) {
        // lying down it drifts up past the bar's left end; in the chair, out to the right of it
        const at0 = floor(c) ? c.worldPoint(c.robot.head, 0, headTop(c) * 0.45, 0.25) : c.worldPoint(c.robot.head, 0, headTop(c) * 0.6, 0.2);
        const vel = camRight(c, new THREE.Vector3()).multiplyScalar(floor(c) ? -0.12 : 0.32);
        if (!floor(c)) at0.addScaledVector(vel, 0.9);
        vel.y = floor(c) ? 0.4 : 0.16;
        c.emit('z', at0, { life: 1.6, vel, size: 0.24, grow: 2.4 });
      }
      if (s >= t0) A.shake = Math.max(A.shake, 0.7 * Math.max(0, 1 - (s - t0) / 0.7) ** 2);
    }
    inhale *= w;
    run.inhale = inhale;
    A.lean -= 0.07 * inhale; // chest up
    A.rootY += 0.015 * inhale;
    A.head[0] -= 0.14 * inhale; // head tips back
    if (!floor(c)) {
      // the mug hops with every snort
      let hop = 0;
      for (const t0 of SNORES) hop += bump(s, t0, t0 + 0.3);
      A.mug.y += 0.04 * hop * w;
    }
    // done at 6.2; it rolls over at 7.6 and the bar runs back to 0% and fades away
    const done = s >= 6.2 && s < 7.7;
    // (the office sits in the scene's world group)
    if (done && once(run, 'done')) puff(c, c.set.office.parent!.worldToLocal(c.set.office.localToWorld(V2.copy(bar.s.position))), 6);
    fill *= 1 - seg(s, 7.8, 8.4);
    if (done) fill = 1;
    const key = `${Math.round(clamp(fill, 0, 1.03) * 100)}|${done}`;
    if (key !== bar.drawn) {
      bar.drawn = key;
      drawBar(bar, fill, done);
    }
    const k = seg(s, 0, 0.4) * (1 - seg(s, 8.4, 9.0));
    bar.mat.opacity = k;
    bar.s.visible = k > 0.01;
    const sc = (0.75 + 0.25 * k) * (1 + 0.14 * pop) * 1.1 * size(c);
    bar.s.scale.set(sc, (sc * BAR_H) / BAR_W, 1);
    bar.s.position.y = run.barY + Math.sin(s * 1.6) * 0.012;

    // 7.6–8.4 rolls over: shifts in the chair, its head lolling over the other way
    const roll = w * seg(s, 7.6, 8.3);
    if (!floor(c)) {
      A.yaw -= 0.22 * roll;
      A.lean -= 0.06 * bump(s, 7.6, 8.3) * w;
      A.rootZ += 0.03 * bump(s, 7.6, 8.3) * w;
      A.head[2] = mix(A.head[2], -A.head[2], roll);
      A.head[1] -= 0.2 * roll;
    } else A.head[1] -= 0.3 * roll;
  },
  place(c) {
    if (!floor(c)) return;
    const { s, w, run } = c;
    // breathing in lifts its shoulders; at 7.6 a little roll, and it resettles
    tilt(c, 'V', 0.08 * (run.inhale || 0), 0.01 * (run.inhale || 0));
    tilt(c, 'U', -0.35 * bump(s, 7.6, 8.4) * w, 0.03 * bump(s, 7.6, 8.4) * w);
  },
  end(c) {
    if (c.run?.bar) dispose(c.run.bar.s);
  },
};

// ------------------------------------------------------------ ping

const PHONE = 1.7; // bigger than life, so it reads in the small window
const SCR_W = 64;
const SCR_H = 128;
const CARD_W = 320;
const CARD_H = 136;

function buildPhone() {
  const holder = new THREE.Group(); // sits on the desk / floor, turned; the phone flips inside it
  const phone = new THREE.Group();
  phone.rotation.order = 'XYZ';
  holder.add(phone);
  phone.add(new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.145, 0.012, 2, 0.01), toon('#1d2235')));
  // the lock screen: 3 am, and a message
  const scr = canvasTexture(SCR_W, SCR_H, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3b4fd8');
    g.addColorStop(1, '#a14fd0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '700 17px "Segoe UI", sans-serif';
    ctx.fillText('3:07', w / 2, 34);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    roundRect(ctx, 5, 50, w - 10, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#34c759';
    roundRect(ctx, 8, 54, 14, 14, 4);
    ctx.fill();
    ctx.fillStyle = '#9aa1b8';
    ctx.fillRect(26, 56, 30, 3);
    ctx.fillRect(26, 63, 22, 3);
  });
  const screenMat = noOutline(new THREE.MeshBasicMaterial({ map: scr.tex }));
  screenMat.color.setScalar(0.06);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.066, 0.132), screenMat);
  screen.position.z = 0.0065;
  phone.add(screen);
  const light = new THREE.PointLight('#a9b8ff', 0, 0.9, 1.5);
  light.position.z = 0.12;
  phone.add(light);
  return { holder, phone, screenMat, light };
}

// the notification: "💬" and who it's from, then what they want (up to two lines)
type Card = ReturnType<typeof sprite>;
function drawCard(card: Card, text: string) {
  const { ctx } = card;
  const i = text.indexOf(': ');
  const [from, msg] = i > 0 ? [text.slice(0, i), text.slice(i + 2)] : ['Messages', text];
  const room = CARD_W - 40;
  ctx.font = '700 31px "Segoe UI", sans-serif';
  const lines = [''];
  for (const wd of msg.split(/\s+/)) {
    const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${wd}` : wd;
    if (ctx.measureText(next).width > room && lines[lines.length - 1] && lines.length < 2) lines.push(wd);
    else lines[lines.length - 1] = next;
  }
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#1d2235';
  ctx.fillStyle = '#fff';
  roundRect(ctx, 4, 4, CARD_W - 8, 62 + lines.length * 34, 22);
  ctx.fill();
  ctx.stroke();
  // a green app badge with the speech balloon on it (the emoji is white)
  ctx.fillStyle = '#34c759';
  ctx.beginPath();
  ctx.arc(40, 36, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = '28px "Segoe UI Emoji", "Segoe UI", sans-serif';
  ctx.fillText('💬', 40, 38);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d2235';
  ctx.font = '800 32px "Segoe UI", sans-serif';
  ctx.fillText(fit(ctx, from, CARD_W - 92), 72, 37);
  ctx.font = '700 31px "Segoe UI", sans-serif';
  ctx.fillStyle = '#3d4460';
  lines.forEach((l, j) => ctx.fillText(fit(ctx, l, room), 20, 82 + j * 34));
  card.tex.needsUpdate = true;
}
function fit(ctx: CanvasRenderingContext2D, s: string, room: number) {
  if (ctx.measureText(s).width <= room) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > room) s = s.slice(0, -1);
  return `${s}…`;
}

const BUZZ = [0.3, 0.9, 1.5];
const SLAP = 2.8;

// (card is made along with p, on the first frame; slap: the swing's progress, slapped: its once() flag)
type PingRun = { p?: ReturnType<typeof buildPhone>; home?: number; card: Card; reach?: number; slap?: number; slapped?: boolean };

const ping: Antic<PingRun> = {
  dur: 5.0,
  fadeIn: 0.3,
  fadeOut: 0.4,
  update(c, A) {
    const { s, w, run } = c;
    const k = size(c) * PHONE;
    if (!run.p) {
      run.p = buildPhone();
      const { holder } = run.p;
      if (floor(c)) {
        // on the floor, in front of its face by the pillow
        const root = c.robot.root;
        V1.set(0, 1, 0).applyQuaternion(root.quaternion); // its head end
        V2.set(0, 0, 1).applyQuaternion(root.quaternion).setY(0).normalize(); // the way it faces
        const pillow: THREE.Vector3 | undefined = c.set.office.userData.bed?.pillow.position;
        if (pillow) holder.position.copy(pillow);
        else holder.position.copy(root.position).addScaledVector(V1, 0.6);
        holder.position.addScaledVector(V2, 0.34).addScaledVector(V1, 0.04).setY(0);
        holder.rotation.y = Math.atan2(V1.x, V1.z);
        c.set.office.add(holder);
      } else {
        // on the desk, just right of the mouse (behind its shoulder, but in sight)
        holder.position.set(0.22, LAYOUT.deskTop, -0.74);
        holder.rotation.y = 0.5;
        (c.set.desk?.top || c.set.office).add(holder);
      }
      run.home = holder.position.y;
      run.card = sprite(CARD_W, CARD_H);
      drawCard(run.card, c.text || 'Boss: quick question?');
      c.set.office.add(run.card.s);
    }
    const { holder, phone, screenMat, light } = run.p;

    // 0.2 it lights up; 2.8 slapped face-down (flips over, with a little hop), dark again
    const lit = s >= 0.2 && s < SLAP;
    screenMat.color.setScalar(lit ? 1 : 0.06);
    light.intensity = lit ? 0.5 : 0;
    const flip = seg(s, SLAP, SLAP + 0.16);
    const buzz = BUZZ.reduce((m, t0) => Math.max(m, s > t0 && s < t0 + 0.28 ? 1 : 0), 0);
    phone.rotation.set(-Math.PI / 2, Math.PI * flip, Math.sin(s * 95) * 0.12 * buzz);
    phone.position.set(Math.sin(s * 120) * 0.004 * buzz, 0.0065 + 0.03 * bump(s, SLAP, SLAP + 0.22), 0);
    // pops in, and fades away face-down at the end
    const show = seg(s, 0, 0.2) * (1 - seg(s, 4.6, 5.0));
    holder.scale.setScalar(Math.max(0.001, show * k));
    holder.visible = show > 0.01;
    if (s >= SLAP && once(run, 'slapped')) {
      puff(c, c.worldPoint(phone, 0, 0, 0).add(V1.set(0, 0.06, 0)), 6);
      A.shake = Math.max(A.shake, 0.4);
    }
    if (s >= SLAP) A.shake = Math.max(A.shake, 0.4 * (1 - seg(s, SLAP, SLAP + 0.3)));

    // the card over it: pops up at 0.2, jiggles with each buzz, gone at the slap
    const card = run.card;
    const ck = s < SLAP ? backOut((s - 0.2) / 0.3) : 1 - seg(s, SLAP, SLAP + 0.1);
    card.s.visible = ck > 0.01 && s < SLAP + 0.1;
    card.mat.opacity = clamp(ck, 0, 1);
    at(c, holder, 0, 0, 0, card.s.position);
    // above it, nudged clear of its face (lying down) and in from the window's right edge (in the chair)
    card.s.position.add(camRight(c, V1).multiplyScalar(floor(c) ? 0.62 : -0.18));
    card.s.position.y += (floor(c) ? 0.85 : 0.6) + 0.02 * buzz * Math.sin(s * 60);
    const cs = Math.max(0.001, ck) * 1.05;
    card.s.scale.set(cs, (cs * CARD_H) / CARD_W, 1);

    // each buzz: a grumpy little flinch, still asleep
    A.head[2] += 0.06 * buzz * Math.sin(s * 40) * w;
    // 2.0–2.8 an arm swings out (up over the phone, then down on it), 3.0–4.0 back
    run.reach = w * seg(s, 2.0, 2.45) * (1 - seg(s, 3.0, 3.9));
    run.slap = seg(s, 2.5, SLAP);
    at(c, holder, 0, 0.32 / k, 0, V2);
    at(c, holder, 0, 0.03 / k, 0, V3);
    const r1 = aim(c, 'R', V2, QW, 2.2);
    const r2 = aim(c, 'R', V3, QS, 2.2);
    for (let i = 0; i < 3; i++) QW[i] = mix(QW[i], QS[i], run.slap);
    if (!floor(c)) {
      for (let i = 0; i < 3; i++) A.armR[i] = mix(A.armR[i], QW[i], run.reach);
      A.yaw -= 0.15 * run.reach; // the chair swivels a touch with the swing
    }
    A.reachR = mix(A.reachR, mix(r1, r2, run.slap), run.reach);
    // 3.0–4.6 snuggles back down: a nuzzle and a contented wriggle
    const snug = w * bump(s, 3.0, 4.6);
    A.head[2] += 0.12 * snug * Math.sin(s * 5);
    A.head[0] += 0.08 * snug;
    A.lean -= 0.04 * snug;
  },
  place(c) {
    if (!floor(c) || !c.run.reach) return;
    poseArm(c.robot.arms.armR, QW, c.run.reach);
  },
  end(c) {
    if (c.run?.p) dispose(c.run.p.holder);
    if (c.run?.card) dispose(c.run.card.s);
  },
};

export const SLEEPY: Record<string, Antic> = { nightmare, snorebar, ping };
