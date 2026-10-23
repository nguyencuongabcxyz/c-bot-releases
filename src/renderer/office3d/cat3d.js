import * as THREE from 'three';
import { toon } from './materials.js';
import { FACE_W, FACE_H } from './face.js';
import { buildAccessory } from './robot3d.js';
import { mesh, latheHead, noLights, fitAccessory } from './critter.js';

// A cute cat: a big round head with pointy ears (pink inside), big sparkly eyes,
// a pink nose and a ":3" mouth on a white muzzle with whiskers, tabby stripes on
// the forehead, a bell collar, white paws with pink toe beans, and a tail that
// swishes while it thinks. The fur takes the paint colour.
// Same rig and parts as the robot (robot3d.js), so every pose and reaction
// works unchanged.

const WHITE = '#fffaf4';
const PINK = '#ff9db5';
// the head is a lathe: radius prof(t) at height H*t, squashed front-to-back by DZ
const H = 0.64;
const W = 0.46;
const DZ = 0.86;
const prof = (t) => W * Math.sin(Math.PI * Math.min(1, Math.max(0, t)) ** 0.85) ** 0.42;
const FACE = { phi: 2.1, t0: 0.08, t1: 0.86 };
// where things sit on the face canvas (px)
const EYE_X = 52;
const EYE_Y = 70;
const NOSE_Y = 106;

// the robot's accessories, moved onto the cat's head: [up, forward, widen]
const FIT = { glasses: [0.03, 0, 1.35], headphones: [0.07, 0, 1.15], bowtie: [0, 0.05, 1], flower: [0.04, 0, 1.02], hardhat: [0.09, 0, 1.18], tophat: [0.09, 0, 1.1], crown: [0.09, 0, 1.1], pirate: [0.09, 0, 1.18] };

export function buildCat({ color }) {
  let coat = color;
  const fur = toon(color);
  const white = toon(WHITE);
  const pink = toon(PINK);

  const root = new THREE.Group(); // origin: centre of the seat top

  // hind legs: round haunches on the seat, short legs dangling over its edge,
  // and big round feet with toe bumps poking forward
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.x = side * 0.14;
    const haunch = mesh(new THREE.SphereGeometry(0.14, 18, 14), fur, side * 0.01, 0.07, 0.04);
    haunch.scale.set(0.85, 0.62, 1.15);
    leg.add(haunch);
    const thigh = mesh(new THREE.CapsuleGeometry(0.08, 0.12, 4, 12), fur, 0, 0.06, 0.2);
    thigh.rotation.x = Math.PI / 2;
    leg.add(thigh);
    leg.add(mesh(new THREE.CylinderGeometry(0.068, 0.058, 0.14, 14), fur, 0, -0.04, 0.31));
    // the paw is built pointing down (-y) with its sole on +z: turn it toes-forward, sole-down
    const foot = new THREE.Group();
    foot.position.set(0, -0.15, 0.33);
    foot.rotation.y = Math.PI;
    const p = catPaw(0.075, white, pink);
    p.rotation.x = Math.PI / 2;
    foot.add(p);
    leg.add(foot);
    root.add(leg);
  }

  // torso pivots at the hips: a round little body with a white tummy
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  root.add(torso);
  const body = mesh(
    new THREE.LatheGeometry(
      [[0, -0.04], [0.25, -0.04], [0.29, 0.04], [0.29, 0.14], [0.27, 0.26], [0.24, 0.36], [0.15, 0.44], [0, 0.46]].map(([x, y]) => new THREE.Vector2(x, y)),
      30,
    ),
    fur,
  );
  body.scale.z = 0.85;
  torso.add(body);
  const belly = mesh(new THREE.SphereGeometry(1, 24, 18), white, 0, 0.15, 0.18);
  belly.scale.set(0.17, 0.19, 0.08);
  torso.add(belly);
  // a red collar with a golden bell
  const collar = mesh(new THREE.TorusGeometry(0.245, 0.03, 8, 32), toon('#e5484d'), 0, 0.35, 0);
  collar.rotation.x = Math.PI / 2;
  collar.scale.set(1, 0.85, 1);
  torso.add(collar);
  torso.add(mesh(new THREE.SphereGeometry(0.042, 14, 12), toon('#ffcc33'), 0, 0.3, 0.235));
  torso.add(mesh(new THREE.SphereGeometry(0.009, 6, 6), toon('#7a5200'), 0, 0.285, 0.275));

  // the tail curls up beside the chair back; it plays the antenna, so it
  // swishes while the cat thinks
  const antenna = new THREE.Group();
  antenna.position.set(0.16, 0.02, -0.17);
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.16, -0.02, -0.05),
    new THREE.Vector3(0.28, 0.1, -0.05),
    new THREE.Vector3(0.3, 0.28, -0.01),
    new THREE.Vector3(0.22, 0.4, 0.02),
  ]);
  antenna.add(new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 24, 0.042, 10), fur));
  antenna.add(mesh(new THREE.SphereGeometry(0.044, 12, 10), fur, 0.22, 0.4, 0.02));
  torso.add(antenna);

  // head: sits right on the collar
  const head = new THREE.Group();
  head.position.y = 0.36;
  torso.add(head);
  const { skull, shell, face, facePoint } = latheHead({ H, DZ, prof, face: FACE, material: fur });
  head.add(skull, shell);
  // pointy ears, pink inside
  for (const side of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(side * 0.24, H * 0.83, -0.03);
    ear.rotation.set(-0.12, side * -0.25, side * -0.42);
    ear.add(mesh(new THREE.ConeGeometry(0.12, 0.22, 20), fur, 0, 0.09, 0));
    const inner = mesh(new THREE.ConeGeometry(0.075, 0.15, 16), pink, 0, 0.07, 0.055);
    inner.scale.z = 0.45;
    ear.add(inner);
    head.add(ear);
  }

  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(prof(0.74) + 0.01, 0.035, 8, 36), toon('#e5484d'), 0, H * 0.74, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, DZ, 1);
  headband.add(band);
  for (const side of [-1, 1]) {
    const tail = mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), toon('#e5484d'), side * 0.06, H * 0.64, -0.33);
    tail.rotation.z = side * 0.4;
    headband.add(tail);
  }
  headband.visible = false;
  head.add(headband);

  // front legs: shoulder -> tapered upper leg -> elbow -> forearm -> round
  // mitten paw with toe bumps and pink beans
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.26, 0.28, 0.03);
    shoulder.add(mesh(new THREE.SphereGeometry(0.08, 14, 12), fur));
    shoulder.add(mesh(new THREE.CylinderGeometry(0.072, 0.06, 0.16, 14), fur, 0, -0.09, 0));
    const elbow = new THREE.Group();
    elbow.position.y = -0.18;
    elbow.add(mesh(new THREE.SphereGeometry(0.06, 12, 10), fur));
    elbow.add(mesh(new THREE.CylinderGeometry(0.06, 0.052, 0.1, 14), fur, 0, -0.06, 0));
    const p = catPaw(0.068, white, pink);
    p.position.y = -0.15;
    elbow.add(p);
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
    headTop: H, // where the hammer lands (between the ears)
    face,
    drawFace: (ctx, f) => drawCatFace(ctx, f, coat),
    setColor(c) {
      coat = c;
      fur.color.set(c);
    },
    setAccessory(name) {
      fitAccessory(accessory, name, FIT, buildAccessory);
    },
  };
}

// A round cat paw pointing down (-y), its sole facing +z: a mitten with three
// toe bumps at the tip, a pink pad and toe beans on the sole.
function catPaw(size, white, pink) {
  const paw = new THREE.Group();
  const base = mesh(new THREE.SphereGeometry(size, 16, 12), white);
  base.scale.set(1.05, 0.85, 0.95);
  paw.add(base);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * size * 0.62;
    paw.add(mesh(new THREE.SphereGeometry(size * 0.42, 12, 10), white, x, -size * 0.62, size * 0.12));
    const bean = mesh(new THREE.SphereGeometry(size * 0.17, 8, 6), pink, x, -size * 0.66, size * 0.5);
    bean.scale.z = 0.4;
    paw.add(bean);
  }
  const pad = mesh(new THREE.SphereGeometry(size * 0.36, 12, 8), pink, 0, -size * 0.08, size * 0.8);
  pad.scale.set(1.25, 1, 0.35);
  paw.add(pad);
  return paw;
}

// iris colour follows the brain (model), like the robot's eye colour
const IRIS = { default: '#4fc3f7', opus: '#b18cff', fable: '#ffc93c', sonnet: '#4fc3f7', haiku: '#6fdc8c' };
const INK = '#2a1f2b';

/** Same contract as drawFace in face.js, plus the coat colour for the stripes. */
export function drawCatFace(ctx, f, coat) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  const lx = f.lookX * 2;
  const ly = f.lookY * 2;
  const cx = FACE_W / 2;
  const ex = [cx - EYE_X + lx, cx + EYE_X + lx];
  const ey = EYE_Y + ly;

  // tabby stripes on the forehead
  ctx.fillStyle = new THREE.Color(coat).multiplyScalar(0.62).getStyle();
  for (const k of [-1, 0, 1]) {
    const x = cx + k * 21;
    ctx.beginPath();
    ctx.moveTo(x - 7, 0);
    ctx.lineTo(x + 7, 0);
    ctx.lineTo(x + k * 3, 30 - Math.abs(k) * 8);
    ctx.closePath();
    ctx.fill();
  }

  // white muzzle puffs
  const mx = cx + lx * 0.5;
  const my = NOSE_Y + ly * 0.5;
  ctx.fillStyle = WHITE;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(mx + side * 15, my + 12, 21, 15, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // rosy cheeks
  if (f.blush) {
    ctx.fillStyle = 'rgba(255,100,140,0.45)';
    for (const x of [cx - 74, cx + 74]) {
      ctx.beginPath();
      ctx.ellipse(x + lx, my + 2, 17, 10, 0, 0, Math.PI * 2);
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
        ctx.moveTo(x - 15, ey);
        ctx.quadraticCurveTo(x, ey + 11, x + 15, ey);
        ctx.stroke();
      }
      break;
    case 'happy':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 15, ey + 5);
        ctx.quadraticCurveTo(x, ey - 15, x + 15, ey + 5);
        ctx.stroke();
      }
      break;
    case 'dizzy':
      ctx.lineWidth = 3.5;
      for (const x of ex) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 1.5 + a * 1.1;
          const px = x + Math.cos(a + f.t * 8) * r;
          const py = ey + Math.sin(a + f.t * 8) * r;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'flat':
      // unimpressed: heavy lids over half an eye, cross brows
      for (const x of ex) {
        ctx.fillStyle = IRIS[f.model] || IRIS.default;
        ctx.beginPath();
        ctx.ellipse(x, ey + 2, 16, 11, 0, 0, Math.PI);
        ctx.fill();
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(x, ey + 4, 6, 7, 0, 0, Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 17, ey + 2);
        ctx.lineTo(x + 17, ey + 2);
        ctx.stroke();
      }
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ex[0] - 16, ey - 22); ctx.lineTo(ex[0] + 12, ey - 14);
      ctx.moveTo(ex[1] + 16, ey - 22); ctx.lineTo(ex[1] - 12, ey - 14);
      ctx.stroke();
      break;
    default: {
      // big sparkly eyes: coloured iris, a big round pupil, two highlights
      const sy = Math.max(0.08, 1 - f.blink);
      for (const x of ex) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(x, ey, 21, 24 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
        if (sy < 0.5) continue;
        ctx.fillStyle = IRIS[f.model] || IRIS.default;
        ctx.beginPath();
        ctx.ellipse(x, ey + 1, 18, 21 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(x, ey + 2, 10, 14 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x + 6, ey - 8, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x - 7, ey + 9, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // whiskers
  ctx.strokeStyle = 'rgba(42,31,43,0.75)';
  ctx.lineWidth = 2.2;
  for (const side of [-1, 1]) {
    for (const [dy, tilt] of [[-4, -7], [4, 0], [12, 7]]) {
      ctx.beginPath();
      ctx.moveTo(mx + side * 34, my + dy);
      ctx.lineTo(mx + side * 78, my + dy + tilt);
      ctx.stroke();
    }
  }

  // the little pink nose
  ctx.fillStyle = '#ff7f9f';
  ctx.beginPath();
  ctx.moveTo(mx - 8, my - 4);
  ctx.quadraticCurveTo(mx, my - 7, mx + 8, my - 4);
  ctx.quadraticCurveTo(mx + 2, my + 5, mx, my + 5);
  ctx.quadraticCurveTo(mx - 2, my + 5, mx - 8, my - 4);
  ctx.fill();

  // the mouth: a ":3" under the nose, opening below it to talk or eat
  const openMouth = (w, h, tongue = true) => {
    const top = my + 10;
    ctx.fillStyle = '#7a2338';
    ctx.beginPath();
    ctx.ellipse(mx, top + h / 2, w, h / 2 + 2, 0, 0, Math.PI * 2);
    ctx.fill();
    if (tongue && h > 7) {
      ctx.fillStyle = '#ff8fa8';
      ctx.beginPath();
      ctx.ellipse(mx, top + h * 0.8, w * 0.6, h * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const w3 = () => {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mx, my + 5);
    ctx.lineTo(mx, my + 9);
    ctx.arc(mx - 7, my + 9, 7, 0, Math.PI, false);
    ctx.moveTo(mx, my + 9);
    ctx.arc(mx + 7, my + 9, 7, Math.PI, 0, true);
    ctx.stroke();
  };
  switch (f.mouth) {
    case 'talk':
      openMouth(10, 5 + Math.abs(Math.sin(f.t * 18)) * 12);
      w3();
      break;
    case 'o':
      openMouth(6, 9, false);
      w3();
      break;
    case 'wide':
      openMouth(15, 20 + Math.sin(f.t * 9) * 3);
      w3();
      break;
    case 'chomp': {
      const h = Math.abs(Math.sin(f.t * 14)) * 16;
      if (h > 3) openMouth(12, h);
      w3();
      break;
    }
    case 'flat':
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(mx, my + 5);
      ctx.lineTo(mx, my + 10);
      ctx.moveTo(mx - 12, my + 12);
      ctx.lineTo(mx + 12, my + 12);
      ctx.stroke();
      break;
    default:
      w3();
  }
  ctx.restore();
}
