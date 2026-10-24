import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, glow, canvasTexture, badgeTexture } from './materials.js';
import { buildAccessory, BIG_HATS } from './robot3d.js';
import { kitFace } from './kitface.js';
import { buildWear, WEAR } from './kitwear.js';

// A robot you build from parts in the Workshop: a head, a face, something on top, a body,
// arms and what it stands on, in three colours and a finish. Whatever you pick, it's the same
// rig as the classic robot (robot3d.js): torso, head, arms (shoulder > elbow), the face screen,
// the antenna and its glowing ball, the chest light, the accessory slot, so every pose and
// antic works on it. With legs it walks when it's out (walker3d.js finds the legs by their
// shape); on a wheel, treads, a jet or a spring it hops along.
//   buildKit(kit, { color, name })   kit: { head, face, top, body, arms, base, finish, second, accent, eye }
//                                    (the main colour is the robot's paint: color)
//   parseKit(json) -> a whole kit (anything missing or unknown is the default)

export const KIT_PARTS = {
  head: ['box', 'ball', 'dome', 'capsule', 'tv', 'bucket'],
  face: ['dots', 'cute', 'visor', 'cyclops', 'pixel'],
  top: ['antenna', 'twin', 'ears', 'propeller', 'dish', 'bulb', 'pigtails', 'ponytail', 'spiky', 'curly', 'none'],
  body: ['box', 'barrel', 'egg', 'slim', 'chunky'],
  arms: ['classic', 'noodle', 'mitten', 'claw'],
  base: ['legs', 'wheel', 'treads', 'hover', 'spring'],
  finish: ['matte', 'glossy', 'metal', 'wood'],
  ...WEAR, // what it wears: clothes, neck, extra, specs
};
const HAIR = ['pigtails', 'ponytail', 'spiky', 'curly'];
export const KIT_DEFAULT = {
  head: 'box', face: 'dots', top: 'antenna', body: 'box', arms: 'classic', base: 'legs', finish: 'matte',
  clothes: 'none', neck: 'none', extra: 'none', specs: 'none',
  second: '#8a90a6', accent: '#ff5e62', eye: '', cloth: '#4a90e2', hair: '#5a3a22',
};
const HEX = /^#[0-9a-f]{6}$/i;
export function parseKit(json) {
  let k = {};
  try {
    k = typeof json === 'string' ? JSON.parse(json || '{}') : json || {};
  } catch {}
  const out = { ...KIT_DEFAULT };
  for (const [slot, options] of Object.entries(KIT_PARTS)) if (options.includes(k[slot])) out[slot] = k[slot];
  for (const c of ['second', 'accent', 'cloth', 'hair']) if (HEX.test(k[c] || '')) out[c] = k[c];
  if (HEX.test(k.eye || '')) out.eye = k.eye;
  return out;
}

const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};
const INK = '#1d2235';

// ---------------------------------------------------------------- finishes

// cel shading with a fourth, bright band: a shiny highlight
let glossRamp = null;
function glossGradient() {
  if (glossRamp) return glossRamp;
  glossRamp = new THREE.DataTexture(new Uint8Array([100, 175, 228, 255]), 4, 1, THREE.RedFormat);
  glossRamp.minFilter = glossRamp.magFilter = THREE.NearestFilter;
  glossRamp.needsUpdate = true;
  return glossRamp;
}
// pale wood grain, tinted by the paint
let grain = null;
function woodGrain() {
  if (grain) return grain;
  grain = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#f3e6cf';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 46; i++) {
      const y = (i / 46) * 256 + Math.sin(i * 1.7) * 4;
      ctx.strokeStyle = `rgba(120, 82, 40, ${0.08 + (i % 3) * 0.05})`;
      ctx.lineWidth = 1 + (i % 4);
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= 256; x += 16) ctx.lineTo(x, y + Math.sin(x / 30 + i) * 3);
      ctx.stroke();
    }
  }).tex;
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  return grain;
}
function finishMat(color, finish) {
  switch (finish) {
    case 'glossy':
      return toon(color, { gradientMap: glossGradient() });
    case 'metal':
      return new THREE.MeshPhongMaterial({ color, shininess: 70, specular: new THREE.Color('#d8deea') });
    case 'wood':
      return toon(color, { map: woodGrain() });
    default:
      return toon(color);
  }
}

// ---------------------------------------------------------------- heads
// Each puts its shell and its face screen in head (origin: the neck) and says how it's
// shaped: top (its crown), width, faceZ (how far forward the face is), for the hats.

const FACE_TEX = (face) => glow('#ffffff', { map: face.tex, transparent: true });
// the face on a sphere (r), w radians wide and h tall, centred a little below its middle
function spherePatch(r, w, h, mid = Math.PI / 2 + 0.06) {
  return new THREE.SphereGeometry(r, 40, 24, Math.PI / 2 - w / 2, w, mid - h / 2, h);
}
// the face on a cylinder (or cone) wall: w radians wide, height tall
function wallPatch(rTop, rBottom, height, w) {
  return new THREE.CylinderGeometry(rTop, rBottom, height, 40, 1, true, -w / 2, w);
}

const HEADS = {
  box(head, paint, faceMat) {
    head.add(mesh(new RoundedBoxGeometry(0.74, 0.58, 0.54, 4, 0.16), paint, 0, 0.3, 0));
    head.add(mesh(new THREE.PlaneGeometry(0.62, 0.426), faceMat, 0, 0.3, 0.273));
    return { top: 0.59, width: 0.74, faceZ: 0.273, faceY: 0.3, earY: 0.3, earX: 0.39 };
  },
  ball(head, paint, faceMat) {
    head.add(mesh(new THREE.SphereGeometry(0.37, 36, 26), paint, 0, 0.34, 0));
    head.add(mesh(spherePatch(0.374, 1.5, 1.0), faceMat, 0, 0.34, 0));
    return { top: 0.71, width: 0.74, faceZ: 0.36, faceY: 0.3, earY: 0.34, earX: 0.37 };
  },
  dome(head, paint, faceMat, second) {
    head.add(mesh(new THREE.SphereGeometry(0.36, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2), paint, 0, 0.34, 0));
    head.add(mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.32, 36), paint, 0, 0.18, 0));
    head.add(mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.035, 36), second, 0, 0.02, 0));
    head.add(mesh(wallPatch(0.364, 0.364, 0.28, 1.35), faceMat, 0, 0.2, 0));
    return { top: 0.7, width: 0.72, faceZ: 0.36, faceY: 0.2, earY: 0.2, earX: 0.36 };
  },
  capsule(head, paint, faceMat) {
    head.add(mesh(new THREE.CapsuleGeometry(0.27, 0.3, 10, 32), paint, 0, 0.42, 0));
    head.add(mesh(wallPatch(0.274, 0.274, 0.3, 1.55), faceMat, 0, 0.42, 0));
    return { top: 0.84, width: 0.54, faceZ: 0.27, faceY: 0.42, earY: 0.42, earX: 0.27 };
  },
  tv(head, paint, faceMat, second) {
    head.add(mesh(new RoundedBoxGeometry(0.8, 0.6, 0.5, 3, 0.06), paint, 0, 0.31, 0));
    // the screen sits in a dark frame, with two knobs beside it
    head.add(mesh(new RoundedBoxGeometry(0.62, 0.46, 0.04, 2, 0.04), toon(INK), -0.06, 0.31, 0.24));
    head.add(mesh(new THREE.PlaneGeometry(0.56, 0.4), faceMat, -0.06, 0.31, 0.262));
    for (const y of [0.42, 0.24]) {
      const knob = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 16), second, 0.32, y, 0.26);
      knob.rotation.x = Math.PI / 2;
      head.add(knob);
    }
    return { top: 0.61, width: 0.8, faceZ: 0.262, faceY: 0.31, earY: 0.31, earX: 0.4 };
  },
  bucket(head, paint, faceMat) {
    head.add(mesh(new THREE.CylinderGeometry(0.36, 0.28, 0.56, 36), paint, 0, 0.3, 0));
    const rim = mesh(new THREE.TorusGeometry(0.36, 0.03, 10, 36), paint, 0, 0.58, 0);
    rim.rotation.x = Math.PI / 2;
    head.add(rim);
    head.add(mesh(new THREE.CircleGeometry(0.35, 36), toon(INK), 0, 0.575, 0).rotateX(-Math.PI / 2));
    // (the wall's radius where the face is: 0.10 to 0.46 up a cone from 0.02 to 0.58)
    head.add(mesh(wallPatch(0.343 + 0.006, 0.291 + 0.006, 0.36, 1.4), faceMat, 0, 0.28, 0));
    return { top: 0.6, width: 0.72, faceZ: 0.32, faceY: 0.28, earY: 0.3, earX: 0.33 };
  },
};

// ---------------------------------------------------------------- what's on top

function buildTop(kind, at, { paint, second, accent, ink, hair, width = 0.74 }) {
  const g = new THREE.Group();
  g.position.y = at;
  const ball = glow(accent);
  // hair: a cap over the top of the head, then the style (bows and bands glow in its light colour)
  if (HAIR.includes(kind)) {
    const locks = toon(hair);
    const r = width / 2 + 0.03;
    const cap = mesh(new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), locks, 0, -0.11, -0.01);
    cap.scale.set(1, 0.5, 0.82);
    g.add(cap);
    switch (kind) {
      case 'pigtails':
        for (const side of [-1, 1]) {
          const puff = mesh(new THREE.SphereGeometry(0.12, 18, 14), locks, side * (r + 0.04), -0.12, -0.02);
          puff.scale.set(0.85, 1.15, 0.85);
          g.add(puff);
          g.add(mesh(new THREE.TorusGeometry(0.05, 0.022, 8, 16), ball, side * (r - 0.03), -0.05, -0.02).rotateY(Math.PI / 2));
        }
        break;
      case 'ponytail': {
        g.add(mesh(new THREE.TorusGeometry(0.05, 0.022, 8, 16), ball, 0, -0.02, -r * 0.8));
        const tail = mesh(new THREE.CapsuleGeometry(0.08, 0.2, 6, 14), locks, 0, -0.16, -r * 0.92);
        tail.rotation.x = 0.35;
        g.add(tail);
        break;
      }
      case 'spiky':
        for (let i = 0; i < 7; i++) {
          const a = -1.2 + (i / 6) * 2.4;
          const spike = mesh(new THREE.ConeGeometry(0.07, 0.18, 8), locks, Math.sin(a) * r * 0.62, 0.02 + Math.cos(a) * 0.04, Math.cos(a) * 0.04 - 0.02);
          spike.rotation.z = -a * 0.45;
          spike.rotation.x = -0.25;
          g.add(spike);
        }
        break;
      case 'curly':
        for (let i = 0; i < 11; i++) {
          const a = (i / 11) * Math.PI * 2;
          g.add(mesh(new THREE.SphereGeometry(0.085, 12, 10), locks, Math.sin(a) * r * 0.75, -0.02 + (i % 2) * 0.04, Math.cos(a) * r * 0.62));
        }
        g.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), locks, 0, 0.05, 0));
        break;
    }
    return { group: g, ball };
  }
  const stick = (x = 0, tilt = 0, len = 0.2) => {
    const s = new THREE.Group();
    s.position.x = x;
    s.rotation.z = tilt;
    s.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 8), ink, 0, len / 2, 0));
    g.add(s);
    return s;
  };
  switch (kind) {
    case 'twin':
      for (const side of [-1, 1]) stick(side * 0.14, -side * 0.35, 0.22).add(mesh(new THREE.SphereGeometry(0.04, 12, 10), ball, 0, 0.24, 0));
      break;
    case 'ears':
      // cat-ear antennas: a cone each side, glowing inside
      for (const side of [-1, 1]) {
        const ear = new THREE.Group();
        ear.position.set(side * 0.2, -0.04, 0);
        ear.rotation.z = -side * 0.32;
        ear.add(mesh(new THREE.ConeGeometry(0.12, 0.22, 4), paint, 0, 0.1, 0).rotateY(Math.PI / 4));
        const inner = mesh(new THREE.ConeGeometry(0.06, 0.13, 3), ball, 0, 0.08, 0.06);
        ear.add(inner);
        g.add(ear);
      }
      break;
    case 'propeller': {
      stick(0, 0, 0.12);
      g.add(mesh(new THREE.SphereGeometry(0.035, 12, 10), ball, 0, 0.13, 0));
      const blades = new THREE.Group();
      blades.position.y = 0.15;
      for (const a of [0, Math.PI]) {
        const b = mesh(new THREE.BoxGeometry(0.34, 0.012, 0.07), second, Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17);
        b.rotation.y = a;
        b.rotation.x = 0.25;
        blades.add(b);
      }
      g.add(blades);
      // (it turns lazily, whatever the robot's doing)
      blades.children[0].onBeforeRender = () => (blades.rotation.y += 0.09);
      break;
    }
    case 'dish': {
      stick(0, 0, 0.14);
      const dish = mesh(new THREE.SphereGeometry(0.13, 24, 10, 0, Math.PI * 2, 0, 1.0), second, 0, 0.22, 0);
      dish.material = second.clone();
      dish.material.side = THREE.DoubleSide;
      dish.rotation.x = Math.PI + 0.5;
      g.add(dish);
      g.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 6), ink, 0, 0.2, 0.05).rotateX(0.5));
      g.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), ball, 0, 0.25, 0.08));
      break;
    }
    case 'bulb': {
      g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 16), second, 0, 0.04, 0));
      const glass = glow(new THREE.Color(accent).lerp(new THREE.Color('#fff6c8'), 0.55));
      g.add(mesh(new THREE.SphereGeometry(0.1, 20, 16), glass, 0, 0.16, 0));
      return { group: g, ball: glass };
    }
    case 'none':
      break;
    default:
      stick(0, 0, 0.2);
      g.add(mesh(new THREE.SphereGeometry(0.055, 14, 12), ball, 0, 0.22, 0));
  }
  return { group: g, ball };
}

// ---------------------------------------------------------------- bodies
// Each puts its shell in the torso (origin: the hips) and says where things go: top (the
// neck), front (its chest's depth), half (half its width), mid (its middle's height).

const BODIES = {
  box(torso, paint) {
    torso.add(mesh(new RoundedBoxGeometry(0.5, 0.46, 0.36, 4, 0.12), paint, 0, 0.26, 0));
    return { top: 0.49, front: 0.18, half: 0.25, mid: 0.26 };
  },
  barrel(torso, paint) {
    torso.add(mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.42, 32), paint, 0, 0.26, 0));
    for (const y of [0.05, 0.47]) {
      const rim = mesh(new THREE.TorusGeometry(0.235, 0.03, 10, 32), paint, 0, y, 0);
      rim.rotation.x = Math.PI / 2;
      torso.add(rim);
    }
    return { top: 0.49, front: 0.24, half: 0.25, mid: 0.26 };
  },
  egg(torso, paint) {
    const egg = mesh(new THREE.SphereGeometry(0.27, 32, 22), paint, 0, 0.27, 0);
    egg.scale.set(1, 1.02, 0.85);
    torso.add(egg);
    return { top: 0.53, front: 0.23, half: 0.26, mid: 0.27 };
  },
  slim(torso, paint) {
    torso.add(mesh(new THREE.CapsuleGeometry(0.17, 0.2, 8, 24), paint, 0, 0.28, 0));
    return { top: 0.53, front: 0.17, half: 0.17, mid: 0.28 };
  },
  chunky(torso, paint, second) {
    torso.add(mesh(new RoundedBoxGeometry(0.64, 0.48, 0.42, 4, 0.1), paint, 0, 0.27, 0));
    for (const side of [-1, 1]) torso.add(mesh(new THREE.SphereGeometry(0.11, 16, 12), second, side * 0.33, 0.44, 0));
    return { top: 0.51, front: 0.21, half: 0.33, mid: 0.27 };
  },
};

// ---------------------------------------------------------------- arms
// The classic arm's joints and lengths, so poses reach the keyboard and the hand is where
// antics hold things (0.24 below the elbow).

function buildArm(kind, side, { paint, second, accent }) {
  const shoulder = new THREE.Group();
  const elbow = new THREE.Group();
  elbow.position.y = -0.25;
  shoulder.add(elbow);
  const limb = kind === 'noodle' ? 0.03 : 0.05;
  if (kind !== 'noodle') shoulder.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), second));
  shoulder.add(mesh(new THREE.CapsuleGeometry(limb, 0.16, 4, 10), second, 0, -0.12, 0));
  elbow.add(mesh(new THREE.CapsuleGeometry(limb * 0.95, 0.15, 4, 10), second, 0, -0.11, 0));
  switch (kind) {
    case 'noodle':
      elbow.add(mesh(new THREE.SphereGeometry(0.05, 12, 10), glow(accent), 0, -0.24, 0));
      break;
    case 'mitten': {
      const mitt = mesh(new THREE.SphereGeometry(0.1, 16, 12), paint, 0, -0.25, 0);
      mitt.scale.set(1, 0.9, 0.78);
      elbow.add(mitt);
      elbow.add(mesh(new THREE.SphereGeometry(0.04, 10, 8), paint, side * -0.08, -0.22, 0.03));
      break;
    }
    case 'claw':
      elbow.add(mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.05, 14), second, 0, -0.21, 0));
      for (const s of [-1, 1]) {
        const finger = new THREE.Group();
        finger.position.set(0, -0.23, s * 0.025);
        finger.rotation.x = s * 0.35;
        finger.add(mesh(new RoundedBoxGeometry(0.035, 0.1, 0.03, 2, 0.01), toon(INK), 0, -0.05, 0));
        elbow.add(finger);
      }
      break;
    default:
      elbow.add(mesh(new THREE.SphereGeometry(0.075, 14, 12), paint, 0, -0.24, 0));
  }
  return { shoulder, elbow };
}

// ---------------------------------------------------------------- what it stands on
// Sitting: the seat top is the root's origin; legs go forward and down to the floor (-0.5).
// Standing (out for a walk, on anything but legs): the same, straight under the body.

function buildBase(kind, root, { paint, second, accent, ink }, standing = false) {
  const fwd = (z) => (standing ? 0 : z); // (forward, under the knees, only when sitting)
  switch (kind) {
    case 'wheel': {
      const fork = new THREE.Group();
      fork.position.set(0, 0.02, fwd(0.2));
      for (const s of [-1, 1]) {
        const strut = mesh(new THREE.BoxGeometry(0.025, 0.36, 0.04), second, s * 0.07, -0.2, fwd(0.08));
        strut.rotation.x = standing ? 0 : -0.35;
        fork.add(strut);
      }
      const wheel = new THREE.Group();
      wheel.position.set(0, -0.36, fwd(0.16));
      const tire = mesh(new THREE.TorusGeometry(0.11, 0.045, 12, 28), toon(INK));
      tire.rotation.y = Math.PI / 2;
      wheel.add(tire);
      const hub = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 20), paint);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      fork.add(wheel);
      root.add(fork);
      break;
    }
    case 'treads':
      for (const s of [-1, 1]) {
        const t = new THREE.Group();
        t.position.set(s * 0.14, 0.02, fwd(0.14));
        const strut = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 10), second, 0, -0.18, fwd(0.12));
        strut.rotation.x = standing ? 0 : -0.4;
        t.add(strut);
        t.add(mesh(new RoundedBoxGeometry(0.14, 0.13, 0.32, 3, 0.06), toon(INK), 0, -0.42, fwd(0.26)));
        t.add(mesh(new RoundedBoxGeometry(0.15, 0.06, 0.2, 2, 0.03), paint, 0, -0.34, fwd(0.26)));
        root.add(t);
      }
      break;
    case 'hover': {
      const pod = new THREE.Group();
      pod.position.set(0, -0.05, fwd(0.22));
      pod.add(mesh(new THREE.SphereGeometry(0.16, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), second, 0, 0, 0));
      pod.add(mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.08, 16), toon(INK), 0, -0.17, 0));
      const flame = mesh(new THREE.ConeGeometry(0.07, 0.22, 16), glow(new THREE.Color(accent).lerp(new THREE.Color('#ffd27a'), 0.5)), 0, -0.32, 0);
      flame.rotation.x = Math.PI;
      // (a flicker)
      flame.onBeforeRender = () => flame.scale.set(1, 0.8 + Math.random() * 0.4, 1);
      pod.add(flame);
      root.add(pod);
      break;
    }
    case 'spring': {
      const coil = [];
      for (let i = 0; i <= 80; i++) {
        const a = (i / 80) * Math.PI * 2 * 6;
        coil.push(new THREE.Vector3(Math.cos(a) * 0.07, -0.04 - (i / 80) * 0.4, fwd(0.26) + Math.sin(a) * 0.07));
      }
      const spring = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coil), 200, 0.014, 6), second);
      const g = new THREE.Group();
      g.add(spring);
      g.add(mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.05, 24), paint, 0, -0.47, fwd(0.26)));
      root.add(g);
      break;
    }
    default:
      // legs, like the classic robot's: walker3d.js finds them (a hip, its thigh, what hangs below)
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.13, 0.07, 0.02);
        const thigh = mesh(new THREE.CapsuleGeometry(0.07, 0.2, 4, 10), second, 0, 0, 0.15);
        thigh.rotation.x = Math.PI / 2;
        hip.add(thigh);
        hip.add(mesh(new THREE.CapsuleGeometry(0.06, 0.32, 4, 10), second, 0, -0.24, 0.32));
        hip.add(mesh(new RoundedBoxGeometry(0.15, 0.08, 0.22, 2, 0.03), paint, 0, -0.5, 0.38));
        root.add(hip);
      }
  }
}

// ---------------------------------------------------------------- the robot

export function buildKit(kitIn, { color, name, standing = false }) {
  const kit = parseKit(kitIn);
  const paint = finishMat(color, kit.finish);
  const second = kit.finish === 'metal' ? finishMat(kit.second, 'metal') : toon(kit.second);
  const ink = toon(INK);
  const parts = { paint, second, accent: kit.accent, ink };

  const root = new THREE.Group(); // origin: centre of the seat top
  // out for a walk on a wheel, a jet…: no legs, so walker3d.js stands its root on the ground and
  // it hops along; lift it all by the seat's height so it stands on its base
  const lifted = standing && kit.base !== 'legs';
  const frame = lifted ? new THREE.Group() : root;
  if (lifted) {
    frame.position.y = 0.5;
    root.add(frame);
  }
  buildBase(kit.base, frame, parts, lifted);

  // torso pivots at the hips so it can lean in towards the screen
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  frame.add(torso);
  const b = (BODIES[kit.body] || BODIES.box)(torso, paint, second);
  const chest = mesh(new THREE.SphereGeometry(0.045, 14, 12), glow(kit.accent), 0, b.mid + 0.04, b.front + 0.002);
  torso.add(chest);
  torso.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 14), second, 0, b.top + 0.03, 0));

  // engineer's ID badge on a lanyard
  const strapMat = toon('#2b6fe0');
  const straps = [];
  for (const side of [-1, 1]) {
    const strap = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), strapMat, side * 0.055, b.mid + 0.1, b.front + 0.005);
    strap.rotation.z = side * 0.32;
    torso.add(strap);
    straps.push(strap);
  }
  const badge = badgeTexture(name, color);
  const white = toon('#fff');
  const badgeMesh = mesh(new THREE.BoxGeometry(0.095, 0.125, 0.008), [white, white, white, white, new THREE.MeshToonMaterial({ map: badge.tex }), white], 0, b.mid - 0.09, b.front + 0.008);
  badgeMesh.rotation.x = -0.08;
  torso.add(badgeMesh);

  // head
  const head = new THREE.Group();
  head.position.y = b.top + 0.07;
  torso.add(head);
  const face = canvasTexture(256, 176);
  const faceMat = FACE_TEX(face);
  const h = (HEADS[kit.head] || HEADS.box)(head, paint, faceMat, second);
  // ear bolts, on the heads with room for them
  if (kit.head !== 'tv' && kit.top !== 'ears' && kit.top !== 'pigtails') {
    for (const side of [-1, 1]) {
      const ear = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 18), second, side * (h.earX + 0.01), h.earY, 0);
      ear.rotation.z = Math.PI / 2;
      head.add(ear);
    }
  }
  const top = buildTop(kit.top, h.top - 0.01, { paint, second, accent: kit.accent, ink, hair: kit.hair, width: h.width });
  const antenna = top.group;
  head.add(antenna);
  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(h.width / 2 + 0.015, 0.035, 8, 32), toon('#e5484d'), 0, h.top - 0.09, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1.02, 0.77, 1);
  headband.add(band);
  headband.visible = false;
  head.add(headband);

  // arms
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const { shoulder, elbow } = buildArm(kit.arms, side, parts);
    shoulder.position.set(side * (b.half + 0.05), b.top - 0.07, 0);
    torso.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }

  buildWear(kit, { torso, head, arms, body: kit.body, b, h });
  if (kit.clothes !== 'none' || kit.neck !== 'none') for (const m of [badgeMesh, ...straps]) m.visible = false;

  root.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  return {
    root, torso, head, antenna, antennaBall: top.ball, chest, arms, accessory, headband,
    headTop: h.top, // where the hammer lands
    light: kit.accent, // its antenna and chest light (index.js lights them in this colour)
    face: { ...face, material: faceMat },
    drawFace: kitFace(kit.face, kit.eye),
    setColor(c) {
      paint.color.set(c);
    },
    setAccessory(name) {
      buildAccessory(accessory, name);
      // hats sized and set for this head (they're made for the classic one: 0.74 wide, crown at 0.59)
      const k = h.width / 0.74;
      accessory.scale.setScalar(k);
      accessory.position.set(0, h.top - 0.59 * k, name === 'glasses' ? h.faceZ - 0.273 * k : 0);
      // (pigtails and a ponytail still show under a hat; spikes and curls would poke through)
      antenna.visible = !BIG_HATS.includes(name) || ['pigtails', 'ponytail'].includes(kit.top);
      // on hair that shows, it sits on the hair
      if (antenna.visible && HAIR.includes(kit.top) && !['glasses', 'bowtie', 'headphones', 'none'].includes(name)) accessory.position.y += kit.top === 'curly' ? 0.12 : kit.top === 'spiky' ? 0.08 : 0.05;
    },
    setTheme(theme) {
      strapMat.color.set(theme.robot?.lanyard || '#2b6fe0');
    },
  };
}
