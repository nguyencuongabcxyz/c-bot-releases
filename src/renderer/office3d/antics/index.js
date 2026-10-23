import * as THREE from 'three';
import { canvasTexture, roundRect } from '../materials.js';
import { AWAKE, tick as awakeTick } from './awake.js';
import { ASLEEP, tick as asleepTick } from './asleep.js';
import { CRITTERS, tick as critterTick } from './critters.js';
import { PHONE } from './phone.js';
import { PUSHUP } from './pushup.js';

// Antics: the little things a robot does when nobody's asking it anything
// (sipping coffee, sneezing, snoring a snot bubble…). The page starts one by
// setting on stateEl
//   data-antic       its name (a key of AWAKE / ASLEEP / CRITTERS)
//   data-antic-seq   a fresh value each time, so the same antic can play twice in a row
//   data-antic-text  optional words for it (a mumble, a dream emoji)
// and the 3D view plays it for its `dur` seconds. It's dropped as soon as the
// robot wakes up or falls asleep (or gets a new body), so it never fights the
// real work.
//
// A handler is { dur, fadeIn?, fadeOut?, update(c, A), end?(c), place?(c), bubbleAt?(c) }.
//   place runs after the frame has posed and seated the robot, so it can move the
//   whole robot (c.robot.root) somewhere else; bubbleAt says where its bubble floats then.
//   c  what it may use: t, dt, s (seconds in), p (s / dur), w (0..1 weight that
//      eases in and out), dur, text, body, robot, set, emit, worldPoint, hand(side),
//      mugHome, lampHome, say(text, kind), toward(arr, target, k), mix, THREE,
//      camYaw, monitorYaw, curYaw, nightcap, asleep, plus `run`, a scratch object
//      for the handler's own state (meshes it added, "already emitted" flags…)
//   A  the pose being drawn this frame; change it in place:
//      lean, head[3], armL[3], armR[3]  (absolute, as in robot3d POSES)
//      yaw    extra chair swivel (radians)
//      tip    chair tipped back (radians, + leans back)
//      rootY, rootZ  the robot slides in its seat (+z is towards its knees)
//      mug    Vector3 offset of the mug from where it sits (office space); mugTilt
//      lamp   desk-lamp brightness factor (1 = as normal, 0 = off)
//      screen a monitor scene to show instead (drawn with time = s), screenDim 0..1
//      shake  desk shake strength (0..1)
//      reachL, reachR  cartoon arm stretch (1 = normal length; 1.5 reaches much further)
//      antenna  extra sideways swing of the antenna (the cat's tail, the nerd's cowlick)
// The standing desk's height lives outside antics (awake.js liftTick): an antic
// sets c.set.office.userData.lift.deskTo / seatTo and the desk motors there.
// Modules may also export tick(c) for things that live outside one antic (the nightcap).
const HANDLERS = { ...AWAKE, ...ASLEEP, ...CRITTERS, ...PHONE, ...PUSHUP };
const TICKS = [awakeTick, asleepTick, critterTick].filter(Boolean);

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const mix = (a, b, k) => a + (b - a) * k;
function toward(arr, target, k) {
  for (let i = 0; i < arr.length; i++) arr[i] = mix(arr[i], target[i], k);
  return arr;
}

// One speech / thought bubble drawn in the 3D scene, so it shows even while
// the robot window is just the robot (asleep).
function makeBubble(world) {
  const W = 320;
  const H = 150;
  const { canvas, ctx, tex } = canvasTexture(W, H);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  mat.userData.outlineParameters = { visible: false };
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  sprite.visible = false;
  world.add(sprite);
  let drawn = '';
  let alpha = 0;
  function draw(text, kind) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#1d2235';
    ctx.fillStyle = '#fff';
    const emojiOnly = !/[a-z0-9]/i.test(text);
    ctx.font = emojiOnly ? '64px "Segoe UI Emoji", "Segoe UI", sans-serif' : '700 30px "Segoe UI", sans-serif';
    // wrap to at most two lines
    const words = text.split(/\s+/);
    const lines = [''];
    for (const w of words) {
      const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
      if (ctx.measureText(next).width > W - 60 && lines[lines.length - 1] && lines.length < 2) lines.push(w);
      else lines[lines.length - 1] = next;
    }
    const tw = Math.min(W - 24, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 40);
    const th = emojiOnly ? 92 : lines.length * 34 + 26;
    const x = (W - tw) / 2;
    const y = 8;
    if (kind === 'thought') {
      // a cloud, with two little puffs trailing down to the head
      roundRect(ctx, x, y, tw, th, th / 2);
      ctx.fill();
      ctx.stroke();
      for (const [cx, cy, r] of [[x + 26, y + th + 14, 10], [x + 10, y + th + 32, 6]]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      roundRect(ctx, x, y, tw, th, 18);
      ctx.fill();
      ctx.stroke();
      // the tail, pointing down-left at the head
      ctx.beginPath();
      ctx.moveTo(x + 26, y + th - 3);
      ctx.lineTo(x + 14, y + th + 26);
      ctx.lineTo(x + 50, y + th - 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillRect(x + 24, y + th - 6, 30, 6);
    }
    ctx.fillStyle = '#1d2235';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + th / 2 + (i - (lines.length - 1) / 2) * 34));
    tex.needsUpdate = true;
  }
  return {
    want: null,
    update(dt, at) {
      if (this.want) {
        const key = `${this.want.kind}|${this.want.text}`;
        if (key !== drawn) {
          drawn = key;
          draw(this.want.text, this.want.kind);
        }
        alpha = Math.min(1, alpha + dt * 6);
        sprite.position.copy(at);
      } else alpha = Math.max(0, alpha - dt * 5);
      sprite.visible = alpha > 0.01;
      mat.opacity = alpha;
      const pop = 0.75 + 0.25 * smooth(alpha);
      sprite.scale.set(1.1 * pop, (1.1 * H * pop) / W, 1);
      this.want = null;
    },
  };
}

export function createAntics({ world, emit, worldPoint, camYaw, monitorYaw }) {
  const bubble = makeBubble(world);
  let run = null; // { name, h, start, text, asleep, robot, scratch }
  let lastSeq = '';
  let lastCtx = null;
  const mugHome = new THREE.Vector3();
  const lampHome = new THREE.Vector3();
  let homesOf = null;

  function finish() {
    if (!run) return;
    try {
      run.h.end?.({ ...lastCtx, run: run.scratch, robot: run.robot });
    } catch (err) {
      console.error(`antic ${run.name} end failed`, err);
    }
    run = null;
  }

  return {
    get active() {
      return !!run;
    },
    get name() {
      return run?.name || '';
    },
    // when the playing antic started (its borrowed monitor scene runs from there)
    get startedAt() {
      return run?.start ?? 0;
    },
    mugHome,
    /** Called every frame, after the pose is worked out and before it's applied. */
    update({ t, dt, d, pose, robot, set, curYaw, A, bubbleAt }) {
      if (homesOf !== set) {
        // a new desk (theme change): remember where its mug and lamp sit
        homesOf = set;
        mugHome.copy(set.mug.position);
        lampHome.copy(set.lamp.group.position);
      }
      const asleep = pose === 'sleep';
      const seq = d.anticSeq || '';
      if (seq !== lastSeq) {
        lastSeq = seq;
        finish();
        const h = HANDLERS[d.antic];
        if (h && seq) run = { name: d.antic, h, start: t, text: d.anticText || '', asleep, robot, scratch: {} };
      }
      if (run && (run.asleep !== asleep || run.robot !== robot)) finish();

      const c = {
        t, dt, body: d.body || 'loopy', robot, set, emit, worldPoint, mix, toward, THREE,
        antic: run?.name || '', // what's playing (ticks use it, e.g. the standing desk comes down otherwise)
        camYaw, monitorYaw, curYaw, mugHome, lampHome, asleep, nightcap: d.nightcap === '1',
        hand: (side = 'R') => worldPoint(robot.arms[side === 'L' ? 'armL' : 'armR'].elbow, 0, -0.24, 0),
        say: (text, kind = 'speech') => {
          if (text) bubble.want = { text, kind };
        },
      };
      lastCtx = c;
      for (const tick of TICKS) tick(c, A);
      if (run) {
        const { h } = run;
        const s = t - run.start;
        if (s >= h.dur) finish();
        else {
          const fadeIn = h.fadeIn ?? 0.3;
          const fadeOut = h.fadeOut ?? 0.35;
          Object.assign(c, {
            s, p: s / h.dur, dur: h.dur, text: run.text, run: run.scratch,
            w: smooth(fadeIn ? s / fadeIn : 1) * smooth(fadeOut ? (h.dur - s) / fadeOut : 1),
          });
          try {
            h.update(c, A);
          } catch (err) {
            console.error(`antic ${run.name} failed`, err);
            finish();
          }
        }
      }
      // lying on the floor the head is on its side: float the bubble above it in the room instead
      // (an antic that takes it out of the chair says where, with its own bubbleAt)
      const at = (run?.h.bubbleAt && c.run && run.h.bubbleAt(c)) || bubbleAt?.();
      bubble.update(dt, at || worldPoint(robot.head, 0.62, robot.headTop ?? 0.6, 0));
    },
    /** Called every frame after the robot has been posed and seated: an antic with
     *  place(c) may then put it somewhere else (down on the floor doing push-ups). */
    place() {
      if (!run?.h.place || !lastCtx?.run) return;
      try {
        run.h.place(lastCtx);
      } catch (err) {
        console.error(`antic ${run.name} place failed`, err);
        finish();
      }
    },
  };
}
