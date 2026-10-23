import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, glow, canvasTexture, badgeTexture } from './materials.js';
import { FACE_W, FACE_H, drawFace } from './face.js';

const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

// Target joint angles per pose. Arms are [shoulder pitch, shoulder out, elbow];
// negative pitch swings the arm forward/up.
export const POSES = {
  idle:     { lean: 0.02, head: [0, 0, 0], armL: [-0.35, 0.18, -0.9], armR: [-0.35, 0.18, -0.9] },
  talking:  { lean: 0.0, head: [0, 0, 0], armL: [-0.75, 0.2, -1.1], armR: [-0.75, 0.2, -1.1] },
  typing:   { lean: 0.22, head: [0.1, 0, 0], armL: [-1.15, -0.05, -0.35], armR: [-1.15, -0.05, -0.35] },
  reading:  { lean: 0.28, head: [0.02, 0, 0], armL: [-0.95, 0.05, -0.6], armR: [-0.95, 0.05, -0.6] },
  thinking: { lean: -0.06, head: [-0.3, 0.25, 0.12], armL: [-0.75, -0.25, -1.55], armR: [-1.95, -0.45, -1.75] },
  cheer:    { lean: -0.05, head: [-0.15, 0, 0], armL: [-2.9, 0.45, -0.25], armR: [-2.9, 0.45, -0.25] },
  wave:     { lean: 0, head: [0, 0, 0.08], armL: [-0.35, 0.18, -0.9], armR: [-2.7, 0.55, -0.5] },
  sleep:    { lean: -0.32, head: [-0.3, 0, 0.32], armL: [0.12, 0.3, -0.05], armR: [0.12, 0.3, -0.05] },
  // waiting for an answer: hand up like in class
  raise:    { lean: 0.04, head: [-0.08, 0, -0.12], armL: [-0.35, 0.18, -0.9], armR: [-2.9, 0.3, -0.12] },
  // a file is being dragged over: lean out with grabby arms
  eager:    { lean: 0.32, head: [-0.12, 0, 0], armL: [-1.45, 0.55, -0.35], armR: [-1.45, 0.55, -0.35] },
  // bored: leaning way back, hands behind the head
  slack:    { lean: -0.38, head: [-0.2, 0, 0.05], armL: [-3.05, 0.3, -1.5], armR: [-3.05, 0.3, -1.5] },
};

export function buildRobot({ color, name }) {
  const paint = toon(color);
  const ink = toon('#1d2235');
  const metal = toon('#8a90a6');

  const root = new THREE.Group(); // origin: centre of the seat top

  // legs (sitting: thighs forward, shins down to the floor)
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, 0.07, 0.02);
    const thigh = mesh(new THREE.CapsuleGeometry(0.07, 0.2, 4, 10), metal, 0, 0, 0.15);
    thigh.rotation.x = Math.PI / 2;
    hip.add(thigh);
    const shin = mesh(new THREE.CapsuleGeometry(0.06, 0.32, 4, 10), metal, 0, -0.24, 0.32);
    hip.add(shin);
    hip.add(mesh(new RoundedBoxGeometry(0.15, 0.08, 0.22, 2, 0.03), paint, 0, -0.5, 0.38));
    root.add(hip);
  }

  // torso pivots at the hips so it can lean in towards the screen
  const torso = new THREE.Group();
  torso.position.y = 0.05;
  root.add(torso);
  torso.add(mesh(new RoundedBoxGeometry(0.5, 0.46, 0.36, 4, 0.12), paint, 0, 0.26, 0));
  const chest = mesh(new THREE.SphereGeometry(0.045, 14, 12), glow('#ff5e62'), 0, 0.3, 0.182);
  torso.add(chest);
  torso.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 14), metal, 0, 0.52, 0));

  // engineer's ID badge on a lanyard
  const strapMat = toon('#2b6fe0');
  for (const side of [-1, 1]) {
    const strap = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), strapMat, side * 0.055, 0.36, 0.185);
    strap.rotation.z = side * 0.32;
    torso.add(strap);
  }
  const badge = badgeTexture(name, color);
  const badgeMesh = mesh(new THREE.BoxGeometry(0.095, 0.125, 0.008), [toon('#fff'), toon('#fff'), toon('#fff'), toon('#fff'), new THREE.MeshToonMaterial({ map: badge.tex }), toon('#fff')], 0, 0.17, 0.188);
  badgeMesh.rotation.x = -0.08;
  torso.add(badgeMesh);

  // head
  const head = new THREE.Group();
  head.position.y = 0.56;
  torso.add(head);
  head.add(mesh(new RoundedBoxGeometry(0.74, 0.58, 0.54, 4, 0.16), paint, 0, 0.3, 0));
  const face = canvasTexture(FACE_W, FACE_H);
  const faceMat = glow('#ffffff', { map: face.tex, transparent: true });
  head.add(mesh(new THREE.PlaneGeometry(0.62, 0.426), faceMat, 0, 0.3, 0.273));
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.07, 18), paint, side * 0.39, 0.3, 0);
    ear.rotation.z = Math.PI / 2;
    head.add(ear);
  }
  const antenna = new THREE.Group();
  antenna.position.y = 0.58;
  antenna.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 8), ink, 0, 0.1, 0));
  const antennaBall = glow('#ff5e62');
  antenna.add(mesh(new THREE.SphereGeometry(0.055, 14, 12), antennaBall, 0, 0.22, 0));
  head.add(antenna);
  const accessory = new THREE.Group();
  head.add(accessory);
  // worn at high effort
  const headband = new THREE.Group();
  const band = mesh(new THREE.TorusGeometry(0.385, 0.035, 8, 32), toon('#e5484d'), 0, 0.5, 0);
  band.rotation.x = Math.PI / 2;
  band.scale.set(1.02, 0.77, 1);
  headband.add(band);
  for (const side of [-1, 1]) {
    const tail = mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), toon('#e5484d'), side * 0.06, 0.42, -0.3);
    tail.rotation.z = side * 0.4;
    headband.add(tail);
  }
  headband.visible = false;
  head.add(headband);

  // arms: shoulder -> upper arm -> elbow -> forearm -> hand
  const arms = {};
  for (const [key, side] of [['armL', -1], ['armR', 1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.3, 0.42, 0);
    shoulder.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), metal));
    shoulder.add(mesh(new THREE.CapsuleGeometry(0.052, 0.16, 4, 10), metal, 0, -0.12, 0));
    const elbow = new THREE.Group();
    elbow.position.y = -0.25;
    elbow.add(mesh(new THREE.CapsuleGeometry(0.048, 0.15, 4, 10), metal, 0, -0.11, 0));
    elbow.add(mesh(new THREE.SphereGeometry(0.075, 14, 12), paint, 0, -0.24, 0));
    shoulder.add(elbow);
    torso.add(shoulder);
    arms[key] = { shoulder, elbow, side };
  }

  root.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  return {
    root, torso, head, antenna, antennaBall, chest, arms, accessory, headband,
    headTop: 0.6, // where the hammer lands
    face: { ...face, material: faceMat },
    drawFace,
    setColor(c) {
      paint.color.set(c);
    },
    setAccessory(name) {
      buildAccessory(accessory, name);
      antenna.visible = !['tophat', 'crown', 'pirate', 'hardhat'].includes(name);
    },
    setTheme(theme) {
      strapMat.color.set(theme.robot?.lanyard || '#2b6fe0');
    },
  };
}

export function buildAccessory(group, name) {
  group.clear();
  const add = (m) => {
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const top = 0.59;
  switch (name) {
    case 'hardhat': {
      const y = toon('#ffc21a');
      const dome = add(mesh(new THREE.SphereGeometry(0.36, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), y, 0, top - 0.08, 0));
      dome.scale.set(1.05, 0.75, 0.95);
      add(mesh(new THREE.CylinderGeometry(0.41, 0.41, 0.022, 28), y, 0, top - 0.07, 0.03));
      add(mesh(new THREE.BoxGeometry(0.06, 0.05, 0.6), y, 0, top + 0.18, 0));
      break;
    }
    case 'glasses': {
      const frame = toon('#1d2235');
      for (const x of [-0.13, 0.13]) {
        add(mesh(new THREE.TorusGeometry(0.085, 0.014, 8, 24), frame, x, 0.32, 0.29));
      }
      add(mesh(new THREE.BoxGeometry(0.08, 0.018, 0.018), frame, 0, 0.33, 0.29));
      break;
    }
    case 'tophat': {
      const black = toon('#222');
      add(mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 28), black, 0, top + 0.015, 0));
      add(mesh(new THREE.CylinderGeometry(0.22, 0.23, 0.36, 28), black, 0, top + 0.2, 0));
      add(mesh(new THREE.CylinderGeometry(0.232, 0.232, 0.06, 28), toon('#e5484d'), 0, top + 0.07, 0));
      break;
    }
    case 'crown': {
      const gold = toon('#ffd34d');
      add(mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 24, 1, true), gold, 0, top + 0.05, 0));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(mesh(new THREE.ConeGeometry(0.05, 0.13, 8), gold, Math.sin(a) * 0.22, top + 0.16, Math.cos(a) * 0.22));
      }
      add(mesh(new THREE.SphereGeometry(0.04, 10, 8), toon('#e5484d'), 0, top + 0.05, 0.24));
      break;
    }
    case 'headphones': {
      const band = add(mesh(new THREE.TorusGeometry(0.42, 0.03, 8, 32, Math.PI), toon('#333'), 0, 0.3, 0));
      for (const side of [-1, 1]) {
        const cup = add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 20), toon('#e5484d'), side * 0.42, 0.3, 0));
        cup.rotation.z = Math.PI / 2;
      }
      break;
    }
    case 'flower': {
      const petal = toon('#ff8fb1');
      const center = new THREE.Vector3(0.28, top - 0.02, 0.12);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        add(mesh(new THREE.SphereGeometry(0.06, 10, 8), petal, center.x + Math.sin(a) * 0.07, center.y + Math.cos(a) * 0.07, center.z));
      }
      add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ffd34d'), center.x, center.y, center.z + 0.03));
      break;
    }
    case 'pirate': {
      const hat = add(mesh(new THREE.SphereGeometry(0.4, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), toon('#222'), 0, top - 0.04, 0));
      hat.scale.set(1.15, 0.6, 0.62);
      const brim = add(mesh(new THREE.TorusGeometry(0.4, 0.035, 8, 32), toon('#ffd34d'), 0, top - 0.04, 0));
      brim.rotation.x = Math.PI / 2;
      brim.scale.set(1.15, 0.62, 1);
      add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#fff'), 0, top + 0.1, 0.22));
      break;
    }
    case 'bowtie': {
      const red = toon('#e5484d');
      for (const side of [-1, 1]) {
        const wing = add(mesh(new THREE.ConeGeometry(0.06, 0.12, 4), red, side * 0.06, -0.02, 0.2));
        wing.rotation.z = side * Math.PI / 2;
      }
      add(mesh(new THREE.SphereGeometry(0.03, 8, 8), toon('#b3262b'), 0, -0.02, 0.21));
      break;
    }
  }
}
