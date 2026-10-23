import * as THREE from 'three';
import { toon, glow, canvasTexture, noOutline } from './materials.js';
import { FACE_W, FACE_H } from './face.js';
import { buildAccessory } from './robot3d.js';
import { mesh, latheHead, fitAccessory } from './critter.js';

// A cute coder girl, the nerd's desk mate: a big round head with chestnut hair,
// a fringe, side locks and two pigtails with pink scrunchies, an ahoge and a
// glowing heart hair clip; sparkly eyes with lashes and rosy cheeks; a sweater
// with a round white collar and a pink bow, a plaid pleated skirt, knee socks
// and Mary Janes. The sweater takes the paint colour. The ahoge plays the
// antenna (it wiggles while thinking) and the heart clip the antenna light.
// Same rig and parts as the robot (robot3d.js), so every pose and reaction
// works unchanged.

const SKIN = '#ffe0c8';
const HAIR = '#6b3b2a';
const PINK = '#ff7aa8';
const SOCKS = '#fbf8f2';
const SHOES = '#7a2338';
// the head is a lathe: radius prof(t) at height H*t, squashed front-to-back by DZ
const H = 0.66;
const W = 0.41;
const DZ = 0.9;
const prof = (t) => W * Math.sin(Math.PI * Math.min(1, Math.max(0, t)) ** 0.9) ** 0.5;
const FACE = { phi: 2.0, t0: 0.08, t1: 0.84 };
// where things sit on the face canvas (px)
const EYE_X = 48;
const EYE_Y = 78;
const MOUTH_Y = 126;

// the robot's accessories, moved onto her head: [up, forward, widen]
const FIT = { headphones: [0.04, 0, 1.08], glasses: [-0.01, 0.12, 0.9], bowtie: [0, -0.03, 0.9], flower: [0.13, 0, 1], hardhat: [0.15, 0, 1.15], tophat: [0.17, 0, 1.08], crown: [0.17, 0, 1.08], pirate: [0.14, 0, 1.15] };

export function buildGirl({ color }) {
  const sweater = toon(color);
  const sweaterDeep = toon(new THREE.Color(color).multiplyScalar(0.8));
  const skin = toon(SKIN);
  const hair = toon(HAIR);
  const pink = toon(PINK);
  const white = toon('#ffffff');
  const socks = toon(SOCKS);
  const shoes = toon(SHOES);

  const root = new THREE.Group(); // origin: centre of the seat top

  // a plaid skirt, partly sewn onto the thighs so it stays over the lap whatever the legs do
  const plaid = canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#34406b';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(28,34,62,0.75)';
    ctx.fillRect(0, 20, 64, 14);
    ctx.fillRect(20, 0, 14, 64);
    ctx.fillStyle = 'rgba(229,72,77,0.9)';
    ctx.fillRect(0, 50, 64, 3);
    ctx.fillRect(50, 0, 3, 64);
  });
  plaid.tex.wrapS = plaid.tex.wrapT = THREE.RepeatWrapping;
  plaid.tex.repeat.set(6, 1);
  const skirtMat = toon('#ffffff', { map: plaid.tex, side: THREE.DoubleSide });

  // legs: thighs under the skirt, white knee socks, Mary Janes with a strap
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.11, 0.08, 0.02);
    const thigh = mesh(new THREE.CapsuleGeometry(0.075, 0.17, 4, 12), skin, 0, 0, 0.15);
    thigh.rotation.x = Math.PI / 2;
    hip.add(thigh);
    const lap = mesh(new THREE.CapsuleGeometry(0.094, 0.1, 4, 14), skirtMat, side * 0.012, 0.012, 0.1);
    lap.rotation.x = Math.PI / 2;
    lap.scale.x = 1.12;
    hip.add(lap);
    // (everything below the knee sits lower than y -0.1, so push-ups can unfold it)
    hip.add(mesh(new THREE.CapsuleGeometry(0.062, 0.3, 4, 12), skin, 0, -0.24, 0.3));
    hip.add(mesh(new THREE.CylinderGeometry(0.068, 0.066, 0.3, 14), socks, 0, -0.3, 0.3));
    const sockTop = mesh(new THREE.TorusGeometry(0.067, 0.014, 6, 16), socks, 0, -0.15, 0.3);
    sockTop.rotation.x = Math.PI / 2;
    hip.add(sockTop);
    const shoe = mesh(new THREE.SphereGeometry(0.085, 16, 12), shoes, 0, -0.47, 0.35);
    shoe.scale.set(0.95, 0.6, 1.4);
    hip.add(shoe);
    const strap = mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16, Math.PI), shoes, 0, -0.44, 0.33);
    strap.rotation.y = Math.PI / 2;
    hip.add(strap);
    hip.add(mesh(new THREE.SphereGeometry(0.014, 8, 6), toon('#ffd34d'), side * 0.062, -0.45, 0.33));
    root.add(hip);
  }

  // the rest of the skirt: round the hips, every other pleat standing out
  const skirtGeo = new THREE.CylinderGeometry(0.27, 0.35, 0.15, 32, 1, true);
  const pos = skirtGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (pos.getY(i) > 0) continue;
    const pleat = 1 + 0.05 * Math.cos(Math.atan2(x, z) * 16);
    pos.setX(i, x * pleat);
    pos.setZ(i, z * pleat);
  }
  skirtGeo.computeVertexNormals();
  const skirt = mesh(skirtGeo, skirtMat, 0, 0.06, 0.03);
  skirt.scale.z = 1.05;
  root.add(skirt);

  // torso pivots at the hips: a snug sweater
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  root.add(torso);
  const body = mesh(
    new THREE.LatheGeometry(
      [[0, -0.04], [0.25, -0.04], [0.27, 0.04], [0.26, 0.16], [0.24, 0.3], [0.21, 0.4], [0.14, 0.47], [0, 0.48]].map(([x, y]) => new THREE.Vector2(x, y)),
      30,
    ),
    sweater,
  );
  body.scale.z = 0.82;
  torso.add(body);
  const hem = mesh(new THREE.TorusGeometry(0.262, 0.025, 8, 30), sweaterDeep, 0, 0, 0);
  hem.rotation.x = Math.PI / 2;
  hem.scale.set(1, 0.82, 1);
  torso.add(hem);
  // round white collar, and a pink bow at the throat
  for (const side of [-1, 1]) {
    const flap = mesh(new THREE.SphereGeometry(0.085, 16, 10), white, side * 0.075, 0.445, 0.1);
    flap.scale.set(1, 0.28, 0.75);
    flap.rotation.set(0.35, 0, -side * 0.3);
    torso.add(flap);
  }
  const bow = new THREE.Group();
  bow.position.set(0, 0.42, 0.17);
  for (const side of [-1, 1]) {
    const loop = mesh(new THREE.ConeGeometry(0.04, 0.07, 12), pink, side * 0.035, 0, 0);
    loop.rotation.z = side * Math.PI / 2;
    loop.scale.z = 0.5;
    bow.add(loop);
    const tail = mesh(new THREE.BoxGeometry(0.025, 0.06, 0.01), pink, side * 0.018, -0.04, -0.005);
    tail.rotation.z = side * 0.35;
    bow.add(tail);
  }
  bow.add(mesh(new THREE.SphereGeometry(0.02, 10, 8), pink));
  torso.add(bow);
  // a little heart on the chest
  const logo = canvasTexture(128, 64, (ctx) => {
    ctx.translate(64, 32);
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.bezierCurveTo(-30, -2, -18, -26, 0, -10);
    ctx.bezierCurveTo(18, -26, 30, -2, 0, 18);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = PINK;
    ctx.fill();
  });
  const logoMat = noOutline(new THREE.MeshToonMaterial({ map: logo.tex, transparent: true }));
  const logoMesh = mesh(new THREE.PlaneGeometry(0.22, 0.11), logoMat, 0, 0.22, 0.25);
  logoMesh.rotation.x = -0.18;
  torso.add(logoMesh);

  // head on a short neck
  torso.add(mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.1, 12), skin, 0, 0.47, 0));
  const head = new THREE.Group();
  head.position.y = 0.45;
  torso.add(head);
  const { skull, shell, face, facePoint } = latheHead({ H, DZ, prof, face: FACE, material: skin });
  head.add(skull, shell);

  // hair: a cap, the back falling to the shoulders, a fringe, side locks
  const hairShell = (pts, phiStart, phiLength, material = hair) => {
    const m = mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 32, phiStart, phiLength), material);
    m.scale.z = DZ;
    return m;
  };
  const along = (t0, t1, grow) => {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = t0 + ((t1 - t0) * i) / 24;
      pts.push([prof(t) * grow, H * t]);
    }
    return pts;
  };
  head.add(hairShell(along(0.7, 1, 1.06), 0, Math.PI * 2));
  const BACK = [1.15, Math.PI * 2 - 2.3]; // round the back and the sides, up to the cheeks
  head.add(hairShell([[0.31, -0.13], [0.36, -0.06], [0.4, 0.05], ...along(0.25, 0.8, 1.06)], ...BACK));
  // the fringe: a band over the forehead with a scalloped edge of soft tufts
  head.add(hairShell(along(0.68, 0.9, 1.065), -1.15, 2.3));
  for (let i = 0; i < 7; i++) {
    const px = FACE_W / 2 + (i - 3) * 27;
    const p = facePoint(px, 30 + Math.abs(i - 3) * 3, 0.02);
    const tuft = mesh(new THREE.SphereGeometry(0.06, 12, 10), hair, p.x, p.y, p.z);
    tuft.scale.set(1.05, 1.35, 0.5);
    tuft.rotation.set(0, Math.atan2(p.x, p.z / DZ), (i - 3) * 0.12);
    head.add(tuft);
  }
  for (const side of [-1, 1]) {
    const lock = mesh(new THREE.CapsuleGeometry(0.055, 0.22, 4, 10), hair, side * 0.37, H * 0.36, 0.1);
    lock.rotation.set(0.15, 0, side * 0.12);
    lock.scale.z = 0.7;
    head.add(lock);
  }
  // two pigtails, each with a pink scrunchie
  const pigtails = [];
  for (const side of [-1, 1]) {
    const tail = new THREE.Group();
    tail.position.set(side * 0.37, H * 0.66, -0.1);
    tail.rotation.z = side * 0.35;
    const scrunchie = mesh(new THREE.TorusGeometry(0.045, 0.028, 8, 16), pink);
    scrunchie.rotation.y = Math.PI / 2;
    tail.add(scrunchie);
    const lock = mesh(new THREE.CapsuleGeometry(0.075, 0.2, 4, 12), hair, side * 0.05, -0.15, -0.01);
    lock.rotation.z = side * 0.25;
    tail.add(lock);
    const tip = mesh(new THREE.ConeGeometry(0.06, 0.12, 10), hair, side * 0.1, -0.33, -0.01);
    tip.rotation.z = Math.PI + side * 0.3;
    tail.add(tip);
    head.add(tail);
    pigtails.push(tail);
  }
  // the ahoge: plays the antenna, so it wiggles while thinking
  const antenna = new THREE.Group();
  antenna.position.set(0.0, H * 1.02, 0.04);
  const strand = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, 0.09, 0.03), new THREE.Vector3(0.06, 0.15, 0.06), new THREE.Vector3(0.11, 0.12, 0.09)]);
  antenna.add(new THREE.Mesh(new THREE.TubeGeometry(strand, 16, 0.014, 6), hair));
  head.add(antenna);
  // the heart hair clip: plays the antenna light
  const antennaBall = glow('#ff5e62');
  const heart = new THREE.Shape();
  heart.moveTo(0, -0.03);
  heart.bezierCurveTo(-0.05, 0.0, -0.03, 0.04, 0, 0.018);
  heart.bezierCurveTo(0.03, 0.04, 0.05, 0.0, 0, -0.03);
  const clipGeo = new THREE.ExtrudeGeometry(heart, { depth: 0.012, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2 });
  const clipAt = facePoint(FACE_W / 2 + 88, 26, 0.03);
  const clip = mesh(clipGeo, antennaBall, clipAt.x, clipAt.y, clipAt.z);
  clip.rotation.set(-0.2, Math.atan2(clipAt.x, clipAt.z / DZ), -0.35);
  head.add(clip);

  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort, over the hair
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(prof(0.8) * 1.08 + 0.01, 0.035, 8, 36), toon('#e5484d'), 0, H * 0.8, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, DZ, 1);
  headband.add(band);
  for (const side of [-1, 1]) {
    const knot = mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), toon('#e5484d'), side * 0.06, H * 0.7, -0.37);
    knot.rotation.z = side * 0.4;
    headband.add(knot);
  }
  headband.visible = false;
  head.add(headband);

  // arms: sweater sleeves with pink cuffs, hands
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.25, 0.36, 0.02);
    shoulder.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), sweater));
    shoulder.add(mesh(new THREE.CapsuleGeometry(0.062, 0.14, 4, 10), sweater, 0, -0.11, 0));
    const elbow = new THREE.Group();
    elbow.position.y = -0.23;
    elbow.add(mesh(new THREE.CapsuleGeometry(0.058, 0.1, 4, 10), sweater, 0, -0.07, 0));
    elbow.add(mesh(new THREE.CylinderGeometry(0.056, 0.056, 0.04, 14), sweaterDeep, 0, -0.15, 0));
    elbow.add(mesh(new THREE.SphereGeometry(0.05, 12, 10), skin, 0, -0.2, 0));
    shoulder.add(elbow);
    torso.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }

  root.traverse((o) => {
    if (o.isMesh && o !== shell && o !== logoMesh) o.castShadow = true;
  });

  return {
    root, torso, head, antenna, antennaBall, arms, accessory, headband,
    pigtails, // swung by the girl-hair antic
    chest: new THREE.Mesh(undefined, new THREE.MeshBasicMaterial()), // no chest light
    headTop: H * 1.04, // where the hammer lands (on the hair)
    face,
    drawFace: drawGirlFace,
    setColor(c) {
      sweater.color.set(c);
      sweaterDeep.color.set(c).multiplyScalar(0.8);
    },
    setTheme(theme) {
      // a company sweater: its logo instead of the heart
      const brand = theme.brand;
      logoMat.map = brand ? canvasTexture(128, 64, (ctx) => brand.logo(ctx, 33, 4, 62, false)).tex : logo.tex;
      logoMat.needsUpdate = true;
    },
    setAccessory(name) {
      fitAccessory(accessory, name, FIT, buildAccessory);
      antenna.visible = !['tophat', 'crown', 'pirate', 'hardhat'].includes(name);
    },
  };
}

// eye sparkle follows the brain (model), like the robot's eye colour
const SPARKLE = { default: '#7ff3ff', opus: '#c4a8ff', fable: '#ffd34d', sonnet: '#7ff3ff', haiku: '#7bed9f' };
const INK = '#3a2220';

/** Same contract as drawFace in face.js. */
export function drawGirlFace(ctx, f) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  const lx = f.lookX * 2;
  const ly = f.lookY * 2;
  const cx = FACE_W / 2;
  const ex = [cx - EYE_X + lx, cx + EYE_X + lx];
  const ey = EYE_Y + ly;

  // rosy cheeks, rosier when happy or busy
  ctx.fillStyle = f.blush ? 'rgba(255,105,140,0.5)' : 'rgba(255,130,150,0.3)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * 68, ey + 30, 18, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // thin eyebrows (mostly under the fringe): up when surprised, slanted when annoyed
  ctx.lineWidth = 3;
  const browUp = f.mouth === 'o' || f.mouth === 'wide' ? -5 : f.eyes === 'happy' ? -2 : 0;
  for (const [i, x] of ex.entries()) {
    const s = i ? 1 : -1;
    const angry = f.eyes === 'flat';
    ctx.beginPath();
    ctx.moveTo(x - 11 * s, ey - 30 + browUp + (angry ? -4 : 1));
    ctx.quadraticCurveTo(x, ey - 34 + browUp, x + 11 * s, ey - 30 + browUp + (angry ? 5 : 0));
    ctx.stroke();
  }

  // lashes: two flicks off the outer corner
  const lashes = (x, s, y) => {
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 12 * s, y);
    ctx.lineTo(x + 19 * s, y - 6);
    ctx.moveTo(x + 9 * s, y - 5);
    ctx.lineTo(x + 14 * s, y - 12);
    ctx.stroke();
  };

  ctx.lineWidth = 4.5;
  switch (f.eyes) {
    case 'closed':
      for (const [i, x] of ex.entries()) {
        ctx.beginPath();
        ctx.moveTo(x - 13, ey);
        ctx.quadraticCurveTo(x, ey + 10, x + 13, ey);
        ctx.stroke();
        lashes(x, i ? 1 : -1, ey + 1);
      }
      break;
    case 'happy':
      for (const [i, x] of ex.entries()) {
        ctx.beginPath();
        ctx.moveTo(x - 13, ey + 4);
        ctx.quadraticCurveTo(x, ey - 13, x + 13, ey + 4);
        ctx.stroke();
        lashes(x, i ? 1 : -1, ey);
      }
      break;
    case 'dizzy':
      ctx.lineWidth = 3.5;
      for (const x of ex) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 1.5 + a * 0.95;
          const px = x + Math.cos(a + f.t * 8) * r;
          const py = ey + Math.sin(a + f.t * 8) * r;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'flat':
      for (const [i, x] of ex.entries()) {
        ctx.beginPath();
        ctx.ellipse(x, ey + 2, 12, 9, 0, 0, Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 14, ey + 2);
        ctx.lineTo(x + 14, ey + 2);
        ctx.stroke();
        lashes(x, i ? 1 : -1, ey + 1);
      }
      break;
    default: {
      // big glossy eyes: a dark iris, a coloured lower glow, two white sparkles
      const sy = Math.max(0.1, 1 - f.blink);
      for (const [i, x] of ex.entries()) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.ellipse(x, ey, 16, 21 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
        lashes(x + 3 * (i ? 1 : -1), i ? 1 : -1, ey - 14 * sy);
        if (sy > 0.5) {
          ctx.fillStyle = SPARKLE[f.model] || SPARKLE.default;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.ellipse(x, ey + 11 * sy, 11, 7 * sy, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x + 6, ey - 8, 6.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x - 5, ey + 5, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // a small mouth
  const mx = cx + lx * 0.5;
  const my = MOUTH_Y + ly * 0.5;
  const open = (w, h) => {
    ctx.fillStyle = '#9a2f45';
    ctx.beginPath();
    ctx.moveTo(mx - w, my);
    ctx.quadraticCurveTo(mx, my + 2, mx + w, my);
    ctx.bezierCurveTo(mx + w * 0.9, my + h * 1.3, mx - w * 0.9, my + h * 1.3, mx - w, my);
    ctx.fill();
    if (h > 6) {
      ctx.fillStyle = '#f59aaa';
      ctx.beginPath();
      ctx.ellipse(mx, my + h * 0.95, w * 0.5, h * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  ctx.lineWidth = 3;
  switch (f.mouth) {
    case 'talk':
      open(10, 4 + Math.abs(Math.sin(f.t * 18)) * 9);
      break;
    case 'o':
      ctx.fillStyle = '#9a2f45';
      ctx.beginPath();
      ctx.ellipse(mx, my + 5, 5, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'wide':
      open(14, 15 + Math.sin(f.t * 9) * 3);
      break;
    case 'chomp': {
      const h = Math.abs(Math.sin(f.t * 14)) * 12;
      if (h > 2) open(10, h);
      else {
        ctx.beginPath();
        ctx.moveTo(mx - 8, my + 1);
        ctx.lineTo(mx + 8, my + 1);
        ctx.stroke();
      }
      break;
    }
    case 'flat':
      ctx.beginPath();
      ctx.moveTo(mx - 9, my + 2);
      ctx.lineTo(mx + 9, my + 2);
      ctx.stroke();
      break;
    default:
      // a little cat smile
      ctx.beginPath();
      ctx.moveTo(mx - 12, my - 1);
      ctx.quadraticCurveTo(mx - 6, my + 6, mx, my);
      ctx.quadraticCurveTo(mx + 6, my + 6, mx + 12, my - 1);
      ctx.stroke();
  }
  ctx.restore();
}
