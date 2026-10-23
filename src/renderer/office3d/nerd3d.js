import * as THREE from 'three';
import { toon, glow, canvasTexture, noOutline } from './materials.js';
import { FACE_W, FACE_H } from './face.js';
import { buildAccessory } from './robot3d.js';
import { mesh, latheHead, fitAccessory } from './critter.js';

// An IT nerd: a big round head with messy hair and a cowlick, thick round
// glasses, freckles and a buck-tooth grin; a hoodie with a </> logo, hood and
// drawstrings, headphones round the neck, jeans and sneakers. The hoodie takes
// the paint colour. The cowlick plays the antenna (it wiggles while thinking)
// and the headphones' little light plays the antenna light.
// Same rig and parts as the robot (robot3d.js), so every pose and reaction
// works unchanged.

const SKIN = '#ffd6b5';
const HAIR = '#3a2a22';
const JEANS = '#3d5f96';
// the head is a lathe: radius prof(t) at height H*t, squashed front-to-back by DZ
const H = 0.66;
const W = 0.4;
const DZ = 0.9;
const prof = (t) => W * Math.sin(Math.PI * Math.min(1, Math.max(0, t)) ** 0.9) ** 0.5;
const FACE = { phi: 2.0, t0: 0.08, t1: 0.84 };
// where things sit on the face canvas (px)
const EYE_X = 46;
const EYE_Y = 70;
const NOSE_Y = 100;
const MOUTH_Y = 124;

// the robot's accessories, moved onto the nerd's head: [up, forward, widen]
const FIT = { headphones: [0.03, 0, 1.0], bowtie: [0, -0.03, 1], flower: [0.12, 0, 1], hardhat: [0.13, 0, 1.1], tophat: [0.15, 0, 1.05], crown: [0.15, 0, 1.05], pirate: [0.13, 0, 1.12] };

export function buildNerd({ color }) {
  const hoodie = toon(color);
  const hoodieDeep = toon(new THREE.Color(color).multiplyScalar(0.8));
  const skin = toon(SKIN);
  const hair = toon(HAIR);
  const jeans = toon(JEANS);
  const white = toon('#f7f7f2');
  const ink = toon('#1d2235');

  const root = new THREE.Group(); // origin: centre of the seat top

  // legs: jeans, and chunky sneakers with a red stripe
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, 0.08, 0.02);
    const thigh = mesh(new THREE.CapsuleGeometry(0.085, 0.17, 4, 12), jeans, 0, 0, 0.15);
    thigh.rotation.x = Math.PI / 2;
    hip.add(thigh);
    hip.add(mesh(new THREE.CapsuleGeometry(0.075, 0.3, 4, 12), jeans, 0, -0.24, 0.3));
    const shoe = mesh(new THREE.SphereGeometry(0.1, 16, 12), white, 0, -0.49, 0.37);
    shoe.scale.set(0.95, 0.55, 1.45);
    hip.add(shoe);
    const sole = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 16), toon('#e5484d'), 0, -0.53, 0.37);
    sole.scale.set(0.95, 1, 1.45);
    hip.add(sole);
    root.add(hip);
  }

  // torso pivots at the hips: a comfy hoodie
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  root.add(torso);
  const body = mesh(
    new THREE.LatheGeometry(
      [[0, -0.04], [0.27, -0.04], [0.3, 0.04], [0.3, 0.16], [0.28, 0.3], [0.24, 0.4], [0.16, 0.47], [0, 0.48]].map(([x, y]) => new THREE.Vector2(x, y)),
      30,
    ),
    hoodie,
  );
  body.scale.z = 0.82;
  torso.add(body);
  // the hood bunched up behind the neck
  const hood = mesh(new THREE.TorusGeometry(0.15, 0.065, 10, 24), hoodieDeep, 0, 0.44, -0.07);
  hood.rotation.x = Math.PI / 2 - 0.5;
  hood.scale.set(1.1, 1, 1);
  torso.add(hood);
  // drawstrings, and the kangaroo pocket
  for (const side of [-1, 1]) {
    const string = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.13, 6), white, side * 0.05, 0.36, 0.19);
    string.rotation.x = -0.35;
    torso.add(string);
    torso.add(mesh(new THREE.SphereGeometry(0.014, 8, 6), white, side * 0.05, 0.3, 0.215));
  }
  const pocket = mesh(new THREE.BoxGeometry(0.3, 0.1, 0.03), hoodieDeep, 0, 0.08, 0.238);
  pocket.rotation.x = 0.08;
  torso.add(pocket);
  // the </> logo
  const logo = canvasTexture(128, 64, (ctx) => {
    ctx.font = '900 46px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#1d2235';
    ctx.strokeText('</>', 64, 34);
    ctx.fillStyle = '#7bed9f';
    ctx.fillText('</>', 64, 34);
  });
  const logoMat = noOutline(new THREE.MeshToonMaterial({ map: logo.tex, transparent: true }));
  const logoMesh = mesh(new THREE.PlaneGeometry(0.22, 0.11), logoMat, 0, 0.21, 0.25);
  logoMesh.rotation.x = -0.18;
  torso.add(logoMesh);
  // headphones round the neck, with a little light
  const phones = new THREE.Group();
  phones.position.set(0, 0.45, 0.02);
  const arc = mesh(new THREE.TorusGeometry(0.2, 0.016, 8, 28, Math.PI * 1.1), toon('#3a3f55'));
  arc.rotation.set(Math.PI / 2, 0, Math.PI * 1.45);
  phones.add(arc);
  const antennaBall = glow('#ff5e62');
  for (const side of [-1, 1]) {
    const cup = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 20), toon('#2b6fe0'), side * 0.16, -0.03, 0.13);
    cup.rotation.set(0.9, 0, side * 0.9);
    phones.add(cup);
    const pad = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 20), ink, side * 0.145, -0.01, 0.115);
    pad.rotation.set(0.9, 0, side * 0.9);
    phones.add(pad);
  }
  phones.add(mesh(new THREE.SphereGeometry(0.016, 8, 6), antennaBall, 0.19, -0.05, 0.17));
  torso.add(phones);

  // head on a short neck
  torso.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 12), skin, 0, 0.47, 0));
  const head = new THREE.Group();
  head.position.y = 0.45;
  torso.add(head);
  const { skull, shell, face, facePoint } = latheHead({ H, DZ, prof, face: FACE, material: skin });
  head.add(skull, shell);
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(0.06, 12, 10), skin, side * 0.39, H * 0.5, -0.02);
    ear.scale.set(0.6, 1, 0.8);
    head.add(ear);
  }
  head.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), toon('#f7b994'), ...facePoint(FACE_W / 2, NOSE_Y, 0.005).toArray()));

  // messy hair: a cap, the back, spikes on top and a fringe
  const hairCap = (t0, t1, grow, phiStart = 0, phiLength = Math.PI * 2) => {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = t0 + ((t1 - t0) * i) / 24;
      pts.push(new THREE.Vector2(prof(t) * grow, H * t));
    }
    const m = mesh(new THREE.LatheGeometry(pts, 32, phiStart, phiLength), hair);
    m.scale.z = DZ;
    return m;
  };
  head.add(hairCap(0.74, 1, 1.06));
  head.add(hairCap(0.28, 0.8, 1.05, Math.PI / 2 + 0.25, Math.PI - 0.5));
  const spikes = [[0, 1.02, -0.05, 0.1, 0], [0.13, 0.98, -0.02, 0.08, -0.5], [-0.14, 0.97, 0.02, 0.09, 0.55], [0.06, 0.96, -0.2, 0.09, -0.2], [-0.08, 0.95, -0.22, 0.08, 0.3], [0.24, 0.86, -0.12, 0.07, -1.0], [-0.25, 0.85, -0.1, 0.07, 1.0]];
  for (const [x, t, z, r, tilt] of spikes) {
    const spike = mesh(new THREE.ConeGeometry(r, r * 2.2, 10), hair, x, H * t, z);
    spike.rotation.set(-0.3, 0, tilt);
    head.add(spike);
  }
  for (let i = 0; i < 5; i++) {
    const p = facePoint(FACE_W / 2 + (i - 2) * 28, 16 + Math.abs(i - 2) * 4, 0.02);
    const tuft = mesh(new THREE.ConeGeometry(0.045, 0.1, 8), hair, p.x, p.y, p.z);
    tuft.rotation.set(Math.PI - 0.5, 0, (i - 2) * 0.3);
    head.add(tuft);
  }
  // the cowlick: plays the antenna, so it wiggles while thinking
  const antenna = new THREE.Group();
  antenna.position.set(0.02, H * 1.02, 0.02);
  const curl = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02, 0.1, 0.03), new THREE.Vector3(0.08, 0.16, 0.06), new THREE.Vector3(0.12, 0.13, 0.08)]);
  antenna.add(new THREE.Mesh(new THREE.TubeGeometry(curl, 16, 0.016, 6), hair));
  head.add(antenna);

  // thick round glasses, with a glint on the lenses
  const glasses = new THREE.Group();
  const rim = toon('#1d2235');
  const glare = canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = 'rgba(190,230,255,0.22)';
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(16, 30);
    ctx.lineTo(30, 16);
    ctx.moveTo(22, 40);
    ctx.lineTo(40, 22);
    ctx.stroke();
  });
  const lensMat = glow('#ffffff', { map: glare.tex, transparent: true, depthWrite: false });
  const lenses = [];
  for (const side of [-1, 1]) {
    const c = facePoint(FACE_W / 2 + side * EYE_X, EYE_Y, 0.05);
    const yaw = Math.atan2(c.x, c.z / DZ);
    const frame = mesh(new THREE.TorusGeometry(0.088, 0.014, 8, 28), rim, c.x, c.y, c.z);
    frame.rotation.y = yaw;
    glasses.add(frame);
    const lens = mesh(new THREE.CircleGeometry(0.084, 28), lensMat, c.x, c.y, c.z);
    lens.rotation.y = yaw;
    glasses.add(lens);
    lenses.push(c);
    // the arm back to the ear
    const ear = new THREE.Vector3(side * 0.37, H * 0.52, -0.02);
    const start = c.clone().add(new THREE.Vector3(side * 0.085, 0, -0.02));
    const armLen = start.distanceTo(ear);
    const arm = mesh(new THREE.CylinderGeometry(0.009, 0.009, armLen, 6), rim);
    arm.position.copy(start).add(ear).multiplyScalar(0.5);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ear.clone().sub(start).normalize());
    glasses.add(arm);
  }
  const bridge = mesh(new THREE.CylinderGeometry(0.011, 0.011, lenses[1].x - lenses[0].x - 0.17, 6), rim, 0, lenses[0].y + 0.01, (lenses[0].z + lenses[1].z) / 2 + 0.02);
  bridge.rotation.z = Math.PI / 2;
  glasses.add(bridge);
  // the classic tape on the bridge
  glasses.add(mesh(new THREE.BoxGeometry(0.035, 0.035, 0.03), white, 0, lenses[0].y + 0.01, (lenses[0].z + lenses[1].z) / 2 + 0.02));
  head.add(glasses);

  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort, over the hair
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(prof(0.8) * 1.08 + 0.01, 0.035, 8, 36), toon('#e5484d'), 0, H * 0.8, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, DZ, 1);
  headband.add(band);
  for (const side of [-1, 1]) {
    const tail = mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), toon('#e5484d'), side * 0.06, H * 0.7, -0.36);
    tail.rotation.z = side * 0.4;
    headband.add(tail);
  }
  headband.visible = false;
  head.add(headband);

  // arms: hoodie sleeves, ribbed cuffs, hands
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27, 0.36, 0.02);
    shoulder.add(mesh(new THREE.SphereGeometry(0.075, 12, 10), hoodie));
    shoulder.add(mesh(new THREE.CapsuleGeometry(0.066, 0.14, 4, 10), hoodie, 0, -0.11, 0));
    const elbow = new THREE.Group();
    elbow.position.y = -0.23;
    elbow.add(mesh(new THREE.CapsuleGeometry(0.062, 0.1, 4, 10), hoodie, 0, -0.07, 0));
    const cuff = mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.04, 14), hoodieDeep, 0, -0.15, 0);
    elbow.add(cuff);
    elbow.add(mesh(new THREE.SphereGeometry(0.055, 12, 10), skin, 0, -0.2, 0));
    shoulder.add(elbow);
    torso.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }

  root.traverse((o) => {
    if (o.isMesh && o !== shell && o.material !== lensMat) o.castShadow = true;
  });

  return {
    root, torso, head, antenna, antennaBall, arms, accessory, headband,
    glasses, // pushed up the nose by the nerd-glasses antic
    chest: new THREE.Mesh(undefined, new THREE.MeshBasicMaterial()), // no chest light
    headTop: H * 1.04, // where the hammer lands (on the hair)
    face,
    drawFace: drawNerdFace,
    setColor(c) {
      hoodie.color.set(c);
      hoodieDeep.color.set(c).multiplyScalar(0.8);
    },
    setTheme(theme) {
      // a company hoodie: its logo instead of </>
      const brand = theme.brand;
      logoMat.map = brand ? canvasTexture(128, 64, (ctx) => brand.logo(ctx, 33, 4, 62, false)).tex : logo.tex;
      logoMat.needsUpdate = true;
    },
    setAccessory(name) {
      // he already wears glasses; headphones go on the head instead of round the neck
      fitAccessory(accessory, name === 'glasses' ? 'none' : name, FIT, buildAccessory);
      phones.visible = name !== 'headphones';
      antenna.visible = !['tophat', 'crown', 'pirate', 'hardhat'].includes(name);
    },
  };
}

// eye glint follows the brain (model), like the robot's eye colour
const GLINT = { default: '#7ff3ff', opus: '#c4a8ff', fable: '#ffd34d', sonnet: '#7ff3ff', haiku: '#7bed9f' };
const INK = '#2a1d1a';

/** Same contract as drawFace in face.js. */
export function drawNerdFace(ctx, f) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  const lx = f.lookX * 2;
  const ly = f.lookY * 2;
  const cx = FACE_W / 2;
  const ex = [cx - EYE_X + lx, cx + EYE_X + lx];
  const ey = EYE_Y + ly;

  // freckles, and blush when happy or busy
  ctx.fillStyle = 'rgba(170,96,64,0.75)';
  for (const side of [-1, 1]) {
    for (const [dx, dy] of [[0, 0], [9, 5], [-7, 6], [3, 11]]) {
      ctx.beginPath();
      ctx.arc(cx + side * (60 + dx), NOSE_Y + 4 + dy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (f.blush) {
    ctx.fillStyle = 'rgba(255,110,130,0.35)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * 66, NOSE_Y + 8, 18, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // eyebrows: up when surprised or happy, cross when annoyed
  ctx.lineWidth = 5;
  const browUp = f.mouth === 'o' || f.mouth === 'wide' ? -5 : f.eyes === 'happy' ? -3 : 0;
  for (const [i, x] of ex.entries()) {
    const s = i ? 1 : -1;
    const angry = f.eyes === 'flat';
    ctx.beginPath();
    ctx.moveTo(x - 13 * s, ey - 30 + browUp + (angry ? -4 : 2));
    ctx.quadraticCurveTo(x, ey - 35 + browUp, x + 13 * s, ey - 30 + browUp + (angry ? 6 : 0));
    ctx.stroke();
  }

  ctx.lineWidth = 5;
  switch (f.eyes) {
    case 'closed':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 12, ey);
        ctx.quadraticCurveTo(x, ey + 9, x + 12, ey);
        ctx.stroke();
      }
      break;
    case 'happy':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 12, ey + 4);
        ctx.quadraticCurveTo(x, ey - 12, x + 12, ey + 4);
        ctx.stroke();
      }
      break;
    case 'dizzy':
      ctx.lineWidth = 3.5;
      for (const x of ex) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 1.5 + a * 0.9;
          const px = x + Math.cos(a + f.t * 8) * r;
          const py = ey + Math.sin(a + f.t * 8) * r;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'flat':
      for (const x of ex) {
        ctx.beginPath();
        ctx.ellipse(x, ey + 2, 10, 7, 0, 0, Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 12, ey + 2);
        ctx.lineTo(x + 12, ey + 2);
        ctx.stroke();
      }
      break;
    default: {
      const sy = Math.max(0.1, 1 - f.blink);
      for (const x of ex) {
        ctx.beginPath();
        ctx.ellipse(x, ey, 11, 14 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sy > 0.5) {
        for (const x of ex) {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x + 4, ey - 5, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = GLINT[f.model] || GLINT.default;
          ctx.beginPath();
          ctx.arc(x - 4, ey + 6, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // the mouth, with two buck teeth
  const mx = cx + lx * 0.5;
  const my = MOUTH_Y + ly * 0.5;
  const teeth = (y, h = 8) => {
    ctx.fillStyle = '#ffffff';
    for (const x of [mx - 7, mx + 0.5]) {
      ctx.beginPath();
      ctx.roundRect(x, y, 6.5, h, 1.5);
      ctx.fill();
    }
  };
  const open = (w, h) => {
    ctx.fillStyle = '#7a2338';
    ctx.beginPath();
    ctx.moveTo(mx - w, my);
    ctx.quadraticCurveTo(mx, my + 3, mx + w, my);
    ctx.bezierCurveTo(mx + w * 0.9, my + h * 1.3, mx - w * 0.9, my + h * 1.3, mx - w, my);
    ctx.fill();
    if (h > 8) {
      ctx.fillStyle = '#f08497';
      ctx.beginPath();
      ctx.ellipse(mx, my + h * 0.95, w * 0.5, h * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    teeth(my + 1, Math.min(8, h * 0.5));
  };
  ctx.lineWidth = 3.5;
  switch (f.mouth) {
    case 'talk':
      open(16, 6 + Math.abs(Math.sin(f.t * 18)) * 12);
      break;
    case 'o':
      ctx.fillStyle = '#7a2338';
      ctx.beginPath();
      ctx.ellipse(mx, my + 6, 7, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'wide':
      open(20, 20 + Math.sin(f.t * 9) * 3);
      break;
    case 'chomp': {
      const h = Math.abs(Math.sin(f.t * 14)) * 16;
      if (h > 3) open(16, h);
      else teeth(my + 1);
      break;
    }
    case 'flat':
      ctx.beginPath();
      ctx.moveTo(mx - 13, my + 2);
      ctx.lineTo(mx + 13, my + 2);
      ctx.stroke();
      break;
    default:
      // a goofy grin
      ctx.beginPath();
      ctx.moveTo(mx - 18, my - 2);
      ctx.quadraticCurveTo(mx, my + 10, mx + 18, my - 2);
      ctx.stroke();
      teeth(my + 2, 8);
  }
  ctx.restore();
}
