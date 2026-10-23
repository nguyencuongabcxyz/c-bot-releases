import * as THREE from 'three';
import { toon, glow } from './materials.js';
import { FACE_W, FACE_H } from './face.js';
import { buildAccessory } from './robot3d.js';
import { mesh, latheHead, noLights, fitAccessory } from './critter.js';

// Loopy, the pink beaver: a huge egg-shaped head (widest at the cheeks) sitting
// right on a pear-shaped body with a white belly, small round black eyes, a big
// purple nose, an open mouth with two buck teeth, round white-lined ears, an
// orange tuft, stubby paws with dark claws and dark feet.
// Same rig and parts as the robot (robot3d.js), so every pose and reaction
// works unchanged.

const FUR = '#ff9c96';
const FUR_DEEP = '#f58a86';
const DARK = '#4e1f3d'; // claws and feet
// the head is a lathe: radius prof(t) at height H*t, squashed front-to-back by DZ
const H = 0.82;
const W = 0.43;
const DZ = 0.86;
const prof = (t) => W * Math.sin(Math.PI * Math.min(1, Math.max(0, t)) ** 0.72) ** 0.3;
// the face is drawn on a slice of the same shape covering the front of the head
const FACE = { phi: 2.1, t0: 0.06, t1: 0.86 };
// where things sit on the face canvas (px)
const EYE_X = 55;
const EYE_Y = 64;
const NOSE_Y = 104;
const MOUTH_Y = 136;

// the robot's accessories, moved onto Loopy's head: [up, forward, widen]
const FIT = { glasses: [0.16, 0.07, 1.05], headphones: [0.22, 0, 1.12], bowtie: [0.04, 0.06, 1], flower: [0.2, 0, 1.05], hardhat: [0.22, 0, 1.15], tophat: [0.23, 0, 1.1], crown: [0.23, 0, 1.1], pirate: [0.22, 0, 1.15] };

export function buildLoopy() {
  const fur = toon(FUR);
  const furDeep = toon(FUR_DEEP);
  const white = toon('#fbf4f2');
  const dark = toon(DARK);

  const root = new THREE.Group(); // origin: centre of the seat top

  // short legs: thighs forward, shins down, big dark feet
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, 0.08, 0.02);
    const thigh = mesh(new THREE.CapsuleGeometry(0.11, 0.14, 4, 12), fur, 0, 0, 0.15);
    thigh.rotation.x = Math.PI / 2;
    hip.add(thigh);
    hip.add(mesh(new THREE.CapsuleGeometry(0.1, 0.26, 4, 12), fur, 0, -0.24, 0.3));
    const foot = mesh(new THREE.SphereGeometry(0.11, 16, 12), dark, 0, -0.5, 0.38);
    foot.scale.set(1.05, 0.5, 1.5);
    hip.add(foot);
    root.add(hip);
  }

  // torso pivots at the hips: a pear-shaped body with a white belly
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  root.add(torso);
  const body = mesh(
    new THREE.LatheGeometry(
      [[0, -0.04], [0.27, -0.04], [0.32, 0.04], [0.32, 0.14], [0.29, 0.28], [0.24, 0.4], [0.17, 0.48], [0, 0.5]].map(([x, y]) => new THREE.Vector2(x, y)),
      30,
    ),
    fur,
  );
  body.scale.z = 0.85;
  torso.add(body);
  const belly = mesh(new THREE.SphereGeometry(1, 24, 18), white, 0, 0.17, 0.2);
  belly.scale.set(0.2, 0.23, 0.085);
  torso.add(belly);

  // head: sits straight on the body, no neck
  const head = new THREE.Group();
  head.position.y = 0.34;
  torso.add(head);
  // the face: eyes, mouth and teeth drawn on a canvas wrapped round the front
  const { skull, shell, face, facePoint } = latheHead({ H, DZ, prof, face: FACE, material: fur });
  head.add(skull, shell);
  // the big purple nose, with a soft magenta shine
  const nose = mesh(new THREE.SphereGeometry(0.115, 24, 18), toon('#57104a'));
  nose.position.copy(facePoint(FACE_W / 2, NOSE_Y, -0.03));
  nose.scale.set(1.05, 0.74, 0.62);
  head.add(nose);
  const shine = mesh(new THREE.SphereGeometry(0.05, 14, 10), glow('#9b2a7c'));
  shine.position.copy(nose.position).add(new THREE.Vector3(0, 0.005, 0.045));
  shine.scale.set(1.1, 0.75, 0.4);
  head.add(shine);
  // round ears with white insides, high on the sides
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(0.085, 16, 12), fur, side * 0.27, H * 0.88, -0.03);
    ear.scale.set(1, 1, 0.65);
    head.add(ear);
    const inner = mesh(new THREE.SphereGeometry(0.052, 14, 10), white, side * 0.275, H * 0.88, 0.012);
    inner.scale.set(1, 1, 0.35);
    head.add(inner);
  }
  // an orange tuft on top: plays the antenna, so it wiggles while thinking
  const antenna = new THREE.Group();
  antenna.position.set(0.02, H - 0.015, 0);
  const tuftMat = toon('#f7a04a');
  for (const [lean, len, fwd] of [[0.3, 0.2, 0.02], [0.75, 0.12, 0.0], [-0.2, 0.13, -0.02]]) {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.03, len * 0.6, fwd), new THREE.Vector3(lean * 0.16, len, fwd * 2));
    antenna.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.012, 6), tuftMat));
  }
  head.add(antenna);

  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(prof(0.76) + 0.01, 0.035, 8, 36), toon('#e5484d'), 0, H * 0.76, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, DZ, 1);
  headband.add(band);
  for (const side of [-1, 1]) {
    const tail = mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), toon('#e5484d'), side * 0.06, H * 0.68, -0.32);
    tail.rotation.z = side * 0.4;
    headband.add(tail);
  }
  headband.visible = false;
  head.add(headband);

  // stubby arms: shoulder -> upper arm -> elbow -> forearm -> paw with dark claws
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.29, 0.3, 0.04);
    shoulder.add(mesh(new THREE.SphereGeometry(0.08, 12, 10), fur));
    shoulder.add(mesh(new THREE.CapsuleGeometry(0.07, 0.13, 4, 10), fur, 0, -0.11, 0));
    const elbow = new THREE.Group();
    elbow.position.y = -0.22;
    elbow.add(mesh(new THREE.CapsuleGeometry(0.066, 0.1, 4, 10), fur, 0, -0.08, 0));
    const paw = mesh(new THREE.SphereGeometry(0.075, 14, 12), furDeep, 0, -0.18, 0);
    paw.scale.set(1, 0.95, 0.85);
    elbow.add(paw);
    const pad = mesh(new THREE.SphereGeometry(0.035, 12, 10), white, 0, -0.18, 0.058);
    pad.scale.set(1, 1, 0.35);
    elbow.add(pad);
    for (let i = 0; i < 4; i++) {
      const claw = mesh(new THREE.SphereGeometry(0.015, 8, 6), dark, (i - 1.5) * 0.028, -0.25, 0.025);
      claw.scale.set(0.9, 1.4, 0.9);
      elbow.add(claw);
    }
    shoulder.add(elbow);
    torso.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }

  root.traverse((o) => {
    if (o.isMesh && o !== shell) o.castShadow = true;
  });

  return {
    root, torso, head, antenna, arms, accessory, headband,
    ...noLights(),
    headTop: H, // where the hammer lands
    face,
    drawFace: drawLoopyFace,
    setColor() {}, // Loopy is always pink
    setAccessory(name) {
      fitAccessory(accessory, name, FIT, buildAccessory);
      antenna.visible = !['tophat', 'crown', 'pirate', 'hardhat'].includes(name);
    },
  };
}

// eye glint follows the brain (model), like the robot's eye colour
const GLINT = { default: '#7ff3ff', opus: '#c4a8ff', fable: '#ffd34d', sonnet: '#7ff3ff', haiku: '#7bed9f' };
const INK = '#17121a';
const MOUTH = '#6e1a33';
const TONGUE = '#f08497';

/** Same contract as drawFace in face.js: f = { eyes, mouth, lookX, lookY, blink, blush, asleep, model, t } */
export function drawLoopyFace(ctx, f) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  const lx = f.lookX * 2;
  const ly = f.lookY * 2;
  const ex = [FACE_W / 2 - EYE_X + lx, FACE_W / 2 + EYE_X + lx];
  const ey = EYE_Y + ly;

  // rosy cheeks
  if (f.blush) {
    ctx.fillStyle = 'rgba(255,70,110,0.35)';
    for (const x of [FACE_W / 2 - 78, FACE_W / 2 + 78]) {
      ctx.beginPath();
      ctx.ellipse(x, NOSE_Y + 10, 20, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  switch (f.eyes) {
    case 'closed':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 11, ey);
        ctx.quadraticCurveTo(x, ey + 9, x + 11, ey);
        ctx.stroke();
      }
      break;
    case 'happy':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 11, ey + 4);
        ctx.quadraticCurveTo(x, ey - 12, x + 11, ey + 4);
        ctx.stroke();
      }
      break;
    case 'dizzy':
      ctx.lineWidth = 3.5;
      for (const x of ex) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 1.5 + a * 0.85;
          const px = x + Math.cos(a + f.t * 8) * r;
          const py = ey + Math.sin(a + f.t * 8) * r;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'flat':
      // unimpressed: half-closed eyes under cross brows
      for (const x of ex) {
        ctx.beginPath();
        ctx.ellipse(x, ey + 2, 10, 6, 0, 0, Math.PI);
        ctx.fill();
      }
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ex[0] - 14, ey - 17); ctx.lineTo(ex[0] + 10, ey - 10);
      ctx.moveTo(ex[1] + 14, ey - 17); ctx.lineTo(ex[1] - 10, ey - 10);
      ctx.stroke();
      break;
    default: {
      const sy = Math.max(0.1, 1 - f.blink);
      for (const x of ex) {
        ctx.beginPath();
        ctx.ellipse(x, ey, 12, 13.5 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sy > 0.5) {
        for (const x of ex) {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x + 3.5, ey - 4.5, 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = GLINT[f.model] || GLINT.default;
          ctx.beginPath();
          ctx.arc(x - 3.5, ey + 5, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // the mouth: an open "D" with an upper buck tooth, a little lower tooth and a tongue
  const mx = FACE_W / 2 + lx * 0.5;
  const my = MOUTH_Y + ly * 0.5;
  const tooth = (x, y, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y, w, h, 2.5);
    ctx.fill();
  };
  const open = (w, h, { tongue = true, lower = true } = {}) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(mx - w, my);
    ctx.quadraticCurveTo(mx, my + 4, mx + w, my);
    ctx.bezierCurveTo(mx + w * 0.95, my + h * 1.3, mx - w * 0.95, my + h * 1.3, mx - w, my);
    ctx.closePath();
    ctx.fillStyle = MOUTH;
    ctx.fill();
    ctx.clip();
    if (tongue && h > 8) {
      ctx.fillStyle = TONGUE;
      ctx.beginPath();
      ctx.ellipse(mx, my + h * 1.05, w * 0.6, h * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    tooth(mx, my, Math.min(17, w * 0.6), Math.min(9, h * 0.45));
    if (lower && h > 12) tooth(mx, my + h * 0.98 - 7, 13, 9);
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - w, my);
    ctx.quadraticCurveTo(mx, my + 4, mx + w, my);
    ctx.bezierCurveTo(mx + w * 0.95, my + h * 1.3, mx - w * 0.95, my + h * 1.3, mx - w, my);
    ctx.stroke();
  };
  // a closed mouth: a little line with the buck tooth peeking out
  const shut = (w) => {
    tooth(mx, my + 1, 15, 9);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mx - w, my - 2);
    ctx.quadraticCurveTo(mx, my + 3, mx + w, my - 2);
    ctx.stroke();
  };
  switch (f.mouth) {
    case 'talk':
      open(31, 10 + Math.abs(Math.sin(f.t * 18)) * 16);
      break;
    case 'o':
      open(12, 14, { tongue: false, lower: false });
      break;
    case 'wide':
      open(33, 27 + Math.sin(f.t * 9) * 3);
      break;
    case 'chomp': {
      const h = Math.abs(Math.sin(f.t * 14)) * 20;
      if (h > 4) open(24, h);
      else shut(20);
      break;
    }
    case 'flat':
      shut(16);
      break;
    default:
      open(30, 19, { lower: false });
  }
  ctx.restore();
}
