import * as THREE from 'three';
import { toon, glow } from '../materials.js';

// Antics while asleep (leaning back in the chair, pose 'sleep'): snot bubbles,
// sleep-talking, dreams, sleep-typing, slipping down the seat, big snores,
// drifting round on the chair, drooling. Plus the nightcap (tick).
// Timings are a contract: robot.js plays sounds at the marked moments.

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s, a, b) => Math.min(1, Math.max(0, (s - a) / (b - a)));
const bump = (s, a, b) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
const set3 = (arr, x, y, z) => {
  arr[0] = x;
  arr[1] = y;
  arr[2] = z;
  return arr;
};
// true the first time it's asked for this run (one-shot emits)
const once = (run, key) => (run[key] ? false : (run[key] = true));
// a smooth curve through [time, value] keys
function keys(s, ks) {
  if (s <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (s < ks[i][0]) {
      const [t0, v0] = ks[i - 1];
      return v0 + (ks[i][1] - v0) * smooth((s - t0) / (ks[i][0] - t0));
    }
  }
  return ks[ks.length - 1][1];
}
function disposeTree(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    o.material.dispose();
  });
}
// scratch pose targets, so nothing is allocated per frame
const T = [0, 0, 0];
const L = [0, 0, 0];
const R = [0, 0, 0];

// Where the nose and the low mouth corner are on each head (head space). The
// sleeping head rolls towards -x, so that corner is the one that drips.
// Custom models: guessed from the head height.
const FACE_SPOTS = {
  robot: { nose: [0.08, 0.25, 0.32], mouth: [-0.1, 0.2, 0.29] },
  cat: { nose: [0.05, 0.23, 0.43], mouth: [-0.06, 0.2, 0.41] },
  loopy: { nose: [0.06, 0.29, 0.44], mouth: [-0.08, 0.2, 0.39] },
  nerd: { nose: [0.05, 0.25, 0.41], mouth: [-0.07, 0.2, 0.37] },
  girl: { nose: [0.04, 0.25, 0.4], mouth: [-0.06, 0.2, 0.37] },
};
function spot(c, which) {
  const f = FACE_SPOTS[c.body];
  if (f) return f[which];
  const h = c.robot.headTop ?? 0.6;
  return which === 'nose' ? [0.05, h * 0.42, h * 0.52] : [-0.06, h * 0.33, h * 0.5];
}
const headTop = (c) => c.robot.headTop ?? 0.6;

// ------------------------------------------------------------ snot bubble

// bubble radius over time: two breaths, the second bigger, a last tremble, pop at 4.4
const BUBBLE_KEYS = [[0, 0], [0.4, 0.025], [1.6, 0.08], [2.4, 0.035], [4.15, 0.15], [4.4, 0.16]];

function snotBubble(head, [x, y, z]) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  // unlit, so it still reads as a bubble in the dimmed night-time lighting
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), glow('#d8f2ff', { transparent: true, opacity: 0.6, depthWrite: false }));
  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), glow('#ffffff'));
  shine.position.set(-0.38, 0.42, 0.72);
  shine.scale.set(1, 1.3, 0.5);
  ball.add(shine);
  group.add(ball);
  group.visible = false;
  head.add(group);
  return { group, ball };
}

// ------------------------------------------------------------ sleep-typing

// slow, uneven finger twitches (seconds in)
const TAPS_L = [0.85, 1.3, 1.95, 2.6, 2.78, 3.35];
const TAPS_R = [1.05, 1.62, 2.2, 2.42, 3.05, 3.5];
const tap = (s, taps) => {
  let m = 0;
  for (const t0 of taps) m = Math.max(m, bump(s, t0, t0 + 0.14));
  return m;
};

export const ASLEEP = {
  // a snot bubble swells and shrinks with two breaths, then pops and wakes it with a start
  bubble: {
    dur: 5.2,
    update(c, A) {
      const { s, run } = c;
      if (!run.bubble) run.bubble = snotBubble(c.robot.head, spot(c, 'nose'));
      const b = run.bubble;
      const r = keys(s, BUBBLE_KEYS);
      if (s < 4.4) {
        // grows out from the nose; wobbles, then trembles just before it goes
        const wob = s > 4.1 ? Math.sin(s * 45) * 0.08 : Math.sin(s * 6) * 0.03;
        b.ball.scale.set(r * (1 + wob), r * (1 - wob), r);
        // blown out of one nostril: forwards, and a little down and to the side, so it clears the nose
        b.ball.position.set(r * 0.45, -r * 0.35, r * 0.8);
        b.group.visible = r > 0.004;
        // the head rocks back a touch as it breathes out into it
        A.head[0] -= 0.06 * (r / 0.16) * c.w;
      } else if (once(run, 'popped')) {
        b.group.visible = false;
        const at = c.worldPoint(b.ball, 0, 0, 0);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          c.emit('star', at, { life: 0.5, vel: new THREE.Vector3(Math.cos(a) * 0.45, Math.sin(a) * 0.45 + 0.1, 0.1), size: 0.06, gravity: 0.6, spin: 4 });
        }
      }
      if (s >= 4.4) {
        // startled: the head jerks up (with a little shiver)
        const k = c.w * smooth(seg(s, 4.4, 4.52));
        const jit = Math.sin(s * 55) * 0.05 * (1 - seg(s, 4.4, 4.9));
        c.toward(A.head, set3(T, 0.02 + jit, 0, 0.04), k);
        A.lean = c.mix(A.lean, -0.14, k);
      }
      if (s >= 4.5) c.say(c.text || 'huh?', 'speech');
    },
    end(c) {
      const b = c.run.bubble;
      if (!b) return;
      b.group.removeFromParent();
      disposeTree(b.group);
    },
  },

  // sleep-talking, with little nods and turns of the head
  mumble: {
    dur: 3.6,
    update(c, A) {
      const { s } = c;
      if (s >= 0.3 && s < 3.3) c.say(c.text, 'speech');
      const talk = c.w * smooth(seg(s, 0.2, 0.6)) * (1 - smooth(seg(s, 3.1, 3.5)));
      A.head[0] += talk * (Math.sin(s * 7) * 0.05 + Math.sin(s * 2.9) * 0.04);
      A.head[1] += talk * Math.sin(s * 1.9) * 0.14;
      A.head[2] -= talk * (0.1 + Math.sin(s * 2.4) * 0.05);
    },
  },

  // a dream in a thought bubble (c.text is an emoji), shown on the dimmed monitor too
  dream: {
    dur: 6.5,
    fadeIn: 0.8,
    fadeOut: 0.8,
    update(c, A) {
      const { s } = c;
      if (s >= 0.4 && s < 6) c.say(c.text, 'thought');
      A.screen = c.run.screen ||= `dream:${c.text}`;
      A.screenDim = 0.55;
      // a contented tilt, swaying slowly
      c.toward(A.head, set3(T, -0.22 + Math.sin(s * 1.3) * 0.03, 0.1, 0.48 + Math.sin(s * 0.9) * 0.06), c.w);
    },
  },

  // dreaming of work: typing arms (from a body still slumped back) with slow twitchy taps
  sleeptype: {
    dur: 4.2,
    fadeIn: 0.7,
    fadeOut: 0.6,
    update(c, A) {
      const { s, w } = c;
      A.screen = 'gibberish';
      A.screenDim = 0.35;
      // the torso leans back ~0.54 more than when typing, so the shoulders pitch
      // less to point the arms the same way; a tap drops the forearm
      const tl = tap(s, TAPS_L);
      const tr = tap(s, TAPS_R);
      c.toward(A.armL, set3(L, -0.85 + tl * 0.05, -0.05, -0.55 + tl * 0.25), w);
      c.toward(A.armR, set3(R, -0.85 + tr * 0.05, -0.05, -0.55 + tr * 0.25), w);
      A.head[0] += w * 0.08; // chin dips, as if at the screen
    },
  },

  // slowly slips down the seat, then jolts back up at 5.4
  slide: {
    dur: 6.5,
    fadeIn: 0.2,
    fadeOut: 0.15,
    update(c, A) {
      const { s, w } = c;
      // creeping slowly at first, faster as it goes; snapped back in 0.15 s
      const slip = s < 5.4 ? seg(s, 0.2, 5.4) ** 1.6 : 1 - smooth(seg(s, 5.4, 5.55));
      A.rootY -= 0.12 * slip * w;
      A.rootZ += 0.18 * slip * w;
      A.lean -= 0.16 * slip * w;
      c.toward(A.head, set3(T, -0.42 + Math.sin(s * 1.1) * 0.04, Math.sin(s * 0.7) * 0.12, 0.55), slip * w);
      if (s >= 5.4) {
        // wide awake for a moment, then nodding off again
        const up = smooth(seg(s, 5.4, 5.5)) * (1 - smooth(seg(s, 5.9, 6.4)));
        c.toward(A.head, set3(T, 0.05, -0.12, -0.05), up * w);
        A.lean = c.mix(A.lean, -0.08, up * w);
        A.shake = Math.max(A.shake, 0.4 * (1 - seg(s, 5.4, 5.8)));
        if (once(c.run, 'sweat')) {
          c.emit('sweat', c.worldPoint(c.robot.head, 0.34, headTop(c) * 0.85, 0.1), { life: 0.9, vel: new THREE.Vector3(0.1, 0.25, 0), size: 0.08, gravity: 1 });
        }
      }
    },
  },

  // a long inhale, then one big snore that rattles the desk
  snore: {
    dur: 2.4,
    update(c, A) {
      const { s, w } = c;
      const inhale = s < 0.6 ? smooth(s / 0.6) : 1 - smooth(seg(s, 0.6, 1.3));
      A.lean -= 0.07 * inhale * w; // chest up
      A.rootY += 0.015 * inhale * w;
      A.head[0] -= 0.14 * inhale * w; // head tips back
      A.head[0] += 0.1 * bump(s, 0.6, 1.0) * w; // the snort
      if (s >= 0.6) {
        const k = s - 0.6;
        if (once(c.run, 'z')) {
          c.emit('z', c.worldPoint(c.robot.head, 0.25, headTop(c) + 0.05, 0.1), { life: 1.8, vel: new THREE.Vector3(0.16, 0.3, 0), size: 0.3, grow: 2.5 });
        }
        A.shake = Math.max(A.shake, Math.max(0, 1 - k / 0.9) ** 2);
        // the mug hops (twice, the second smaller) and rattles
        A.mug.y += (0.05 * bump(k, 0, 0.3) + 0.015 * bump(k, 0.3, 0.45)) * w;
        A.mugTilt += Math.sin(k * 28) * 0.22 * Math.max(0, 1 - k / 0.7) * w;
      }
    },
  },

  // the chair slowly drifts round and back (its own easing, so no fades)
  drift: {
    dur: 10,
    fadeIn: 0,
    fadeOut: 0,
    update(c, A) {
      const { s } = c;
      A.yaw += 0.7 * (s < 6 ? smooth(s / 6) : 1 - smooth((s - 6) / 4));
    },
  },

  // a drop of drool falls from the low corner of the mouth
  drool: {
    dur: 2.6,
    update(c, A) {
      const { s, w } = c;
      A.head[0] += w * (0.05 * bump(s, 0.4, 1.2) + 0.02 * Math.sin(s * 3));
      if (s >= 0.8 && once(c.run, 'drip')) {
        const [x, y, z] = spot(c, 'mouth');
        c.emit('sweat', c.worldPoint(c.robot.head, x, y, z), { life: 1.1, vel: new THREE.Vector3(0, -0.05, 0.04), size: 0.06, gravity: 1.4 });
      }
    },
  },
};

// ------------------------------------------------------------ the nightcap

// A floppy striped nightcap: a furry cuff, then a cone made of short tapered
// segments (one per stripe), each joint bending further so the tip flops over
// to the side (-x, the way the sleeping head rolls) with a pompom on the end.
// Built in the robot's hat space (buildAccessory: hats sit at top = 0.59) and
// fitted to each head the same way its hats are.
const CAP_N = 8;
const CAP_H = 0.085;
const CAP_R = 0.34;
const CAP_DEPTH = 0.78; // heads are shallower front-to-back than wide
const CAP_BEND = [0, 0.08, 0.16, 0.26, 0.36, 0.42, 0.46, 0.5];
const capRadius = (i) => CAP_R * (1 - 0.9 * (i / CAP_N) ** 0.85);

function buildNightcap() {
  const fit = new THREE.Group(); // follows the body's hat fit
  const cap = new THREE.Group();
  cap.position.y = 0.55;
  fit.add(cap);
  const white = toon('#fffaf0');
  const stripes = [toon('#5b7cfa'), white];
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.065, 10, 36), white);
  cuff.rotation.x = Math.PI / 2;
  cap.add(cuff);
  const joints = [];
  let parent = cap;
  for (let i = 0; i < CAP_N; i++) {
    const joint = new THREE.Group();
    joint.position.y = i ? CAP_H : 0;
    joint.rotation.x = i ? -0.04 : 0; // and a little backwards
    parent.add(joint);
    const mat = stripes[i % 2];
    const piece = new THREE.Mesh(new THREE.CylinderGeometry(capRadius(i + 1), capRadius(i), CAP_H, 20), mat);
    piece.position.y = CAP_H / 2;
    joint.add(piece);
    // a ball at each joint fills the gap on the outside of the bend
    if (i) joint.add(new THREE.Mesh(new THREE.SphereGeometry(capRadius(i), 20, 10), mat));
    joints.push(joint);
    parent = joint;
  }
  const pom = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), white);
  pom.position.y = CAP_H + 0.045;
  parent.add(pom);
  fit.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return { fit, cap, joints };
}

// Where hats sit on this head. Whatever it wears is already fitted (exactly, for
// a hat). With nothing on, try a top hat on once to read the body's hat fit,
// then take it off again: nothing else changes for an empty accessory.
const hatFits = new WeakMap();
function hatFit(robot) {
  const acc = robot.accessory;
  if (acc.children.length || !robot.setAccessory) return acc;
  let fit = hatFits.get(robot);
  if (!fit) {
    robot.setAccessory('tophat');
    fit = { position: acc.position.clone(), scale: acc.scale.clone() };
    const tried = [...acc.children];
    robot.setAccessory('none');
    tried.forEach(disposeTree);
    hatFits.set(robot, fit);
  }
  return fit;
}

let cap = null;
const worn = { robot: null, on: false, grow: 0, accVis: true, antenna: null, antVis: true };

function takeOff() {
  if (!worn.on) return;
  worn.robot.accessory.visible = worn.accVis;
  if (worn.antenna) worn.antenna.visible = worn.antVis;
  cap.fit.removeFromParent();
  worn.on = false;
}

export function tick(c) {
  const { robot } = c;
  if (worn.robot !== robot) {
    takeOff();
    worn.robot = robot;
  }
  if (!c.nightcap) return takeOff();
  cap ||= buildNightcap();
  if (!worn.on) {
    worn.on = true;
    worn.grow = 0;
    worn.accVis = robot.accessory.visible;
    // an antenna on the head would poke through it (hats hide it too)
    worn.antenna = robot.antenna?.parent === robot.head ? robot.antenna : null;
    worn.antVis = worn.antenna ? worn.antenna.visible : true;
    robot.head.add(cap.fit);
  }
  const fit = hatFit(robot);
  cap.fit.position.copy(fit.position);
  cap.fit.scale.copy(fit.scale);
  robot.accessory.visible = false;
  if (worn.antenna?.visible) {
    // shown again (a new accessory was put on while it slept): remember, hide
    worn.antVis = true;
    worn.antenna.visible = false;
  }
  // pops on with a little overshoot
  worn.grow = Math.min(1, worn.grow + c.dt * 3.5);
  const x = worn.grow - 1;
  const g = 1 + 2.7 * x ** 3 + 1.7 * x ** 2;
  cap.cap.scale.set(g, g, g * CAP_DEPTH);
  // the tip sways gently with the sleepy breathing
  for (let i = 0; i < CAP_N; i++) {
    cap.joints[i].rotation.z = CAP_BEND[i] + Math.sin(c.t * 1.6 - i * 0.35) * 0.04 * (i / CAP_N);
  }
}
