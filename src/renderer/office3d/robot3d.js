import * as THREE from 'three';
import { toon, canvasTexture } from './materials.js';

// The robot's poses, and the hats every robot can wear (kit3d.js builds the robot itself).

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

// hats the antenna would poke through (it's hidden under them)
export const BIG_HATS = ['tophat', 'crown', 'pirate', 'hardhat', 'gradcap', 'santa', 'elf', 'witch', 'beanie', 'strawhat', 'sunhat', 'partyhat'];

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
    case 'gradcap': {
      // a graduation cap (a vocabulary reward): the skull cap, the flat board on top, a gold tassel
      const navy = toon('#1f2a4d');
      const cap = add(mesh(new THREE.SphereGeometry(0.27, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), navy, 0, top - 0.08, 0)); // (as low as the hard hat, whose fit it borrows)
      cap.scale.set(1, 0.55, 1);
      const board = add(mesh(new THREE.BoxGeometry(0.62, 0.035, 0.62), navy, 0, top + 0.08, 0));
      board.rotation.y = Math.PI / 4;
      add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), toon('#ffd34d'), 0, top + 0.11, 0));
      const tassel = new THREE.Group();
      tassel.position.set(0.28, top + 0.1, 0.12);
      tassel.add(mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.16, 6), toon('#ffd34d'), 0, -0.08, 0));
      tassel.add(mesh(new THREE.ConeGeometry(0.035, 0.07, 10), toon('#ffd34d'), 0, -0.18, 0));
      tassel.traverse((m) => m.isMesh && (m.castShadow = true));
      group.add(tassel);
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
    // ---- seasonal and party hats (the Workshop's themed looks use them too)
    case 'santa': {
      // a floppy red hat with a white fur brim and a pompom
      const red = toon('#d62f3a');
      const white = toon('#ffffff');
      const brim = add(mesh(new THREE.TorusGeometry(0.34, 0.07, 12, 32), white, 0, top - 0.02, 0));
      brim.rotation.x = Math.PI / 2;
      const floppy = new THREE.Group();
      floppy.position.set(0, top, 0);
      floppy.rotation.z = -0.35;
      floppy.add(mesh(new THREE.ConeGeometry(0.32, 0.46, 24), red, 0, 0.21, 0));
      floppy.add(mesh(new THREE.SphereGeometry(0.075, 14, 12), white, 0, 0.45, 0));
      floppy.traverse((m) => m.isMesh && (m.castShadow = true));
      group.add(floppy);
      break;
    }
    case 'elf': {
      const green = toon('#2f9e5b');
      const band = add(mesh(new THREE.CylinderGeometry(0.35, 0.36, 0.08, 28), toon('#d62f3a'), 0, top + 0.01, 0));
      band.castShadow = true;
      const tip = new THREE.Group();
      tip.position.set(0, top + 0.04, 0);
      tip.rotation.z = 0.3;
      tip.add(mesh(new THREE.ConeGeometry(0.3, 0.52, 24), green, 0, 0.26, 0));
      tip.add(mesh(new THREE.SphereGeometry(0.05, 12, 10), toon('#ffd34d'), 0, 0.53, 0));
      tip.traverse((m) => m.isMesh && (m.castShadow = true));
      group.add(tip);
      break;
    }
    case 'antlers': {
      // reindeer antlers on a headband
      const brown = toon('#8a5a2b');
      const band = add(mesh(new THREE.TorusGeometry(0.36, 0.02, 8, 32, Math.PI), toon('#d62f3a'), 0, top - 0.06, 0));
      band.rotation.y = Math.PI / 2;
      for (const side of [-1, 1]) {
        const a = new THREE.Group();
        a.position.set(side * 0.2, top - 0.01, 0);
        a.rotation.z = -side * 0.3;
        a.add(mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.3, 8), brown, 0, 0.15, 0));
        for (const [y, len, tilt] of [[0.12, 0.13, 1.0], [0.22, 0.11, 0.9]]) {
          const tine = mesh(new THREE.CylinderGeometry(0.016, 0.022, len, 8), brown, side * 0.05, y + 0.04, 0);
          tine.rotation.z = -side * tilt;
          a.add(tine);
        }
        a.traverse((m) => m.isMesh && (m.castShadow = true));
        group.add(a);
      }
      break;
    }
    case 'witch': {
      const dark = toon('#3b2a52');
      add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.025, 32), dark, 0, top + 0.01, 0));
      add(mesh(new THREE.CylinderGeometry(0.255, 0.26, 0.07, 28), toon('#9b59d0'), 0, top + 0.06, 0));
      const tip = new THREE.Group();
      tip.position.set(0, top + 0.02, 0);
      tip.add(mesh(new THREE.ConeGeometry(0.25, 0.42, 24), dark, 0, 0.21, 0));
      const bend = mesh(new THREE.ConeGeometry(0.1, 0.18, 16), dark, 0.05, 0.47, 0);
      bend.rotation.z = -0.8;
      tip.add(bend);
      tip.add(mesh(new THREE.BoxGeometry(0.08, 0.07, 0.02), toon('#ffd34d'), 0, 0.05, 0.25));
      tip.traverse((m) => m.isMesh && (m.castShadow = true));
      group.add(tip);
      break;
    }
    case 'horns': {
      const red = toon('#e5484d');
      for (const side of [-1, 1]) {
        const horn = add(mesh(new THREE.ConeGeometry(0.06, 0.2, 14), red, side * 0.2, top + 0.08, 0.02));
        horn.rotation.z = -side * 0.35;
      }
      break;
    }
    case 'sunhat': {
      // a wide straw sun hat with a ribbon and a flower
      const straw = toon('#f2d38b');
      add(mesh(new THREE.CylinderGeometry(0.58, 0.6, 0.025, 36), straw, 0, top - 0.01, 0));
      const crown = add(mesh(new THREE.SphereGeometry(0.3, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), straw, 0, top - 0.02, 0));
      crown.scale.set(1, 0.7, 1);
      add(mesh(new THREE.CylinderGeometry(0.302, 0.302, 0.06, 28, 1, true), toon('#ff8fb1'), 0, top + 0.03, 0));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        add(mesh(new THREE.SphereGeometry(0.035, 10, 8), toon('#ffffff'), 0.25 + Math.sin(a) * 0.04, top + 0.06 + Math.cos(a) * 0.04, 0.16));
      }
      add(mesh(new THREE.SphereGeometry(0.028, 10, 8), toon('#ffd34d'), 0.25, top + 0.06, 0.18));
      break;
    }
    case 'strawhat': {
      const straw = toon('#e9c46a');
      add(mesh(new THREE.CylinderGeometry(0.45, 0.46, 0.025, 32), straw, 0, top, 0));
      add(mesh(new THREE.CylinderGeometry(0.25, 0.28, 0.18, 28), straw, 0, top + 0.09, 0));
      add(mesh(new THREE.CylinderGeometry(0.282, 0.282, 0.05, 28, 1, true), toon('#d62f3a'), 0, top + 0.04, 0));
      break;
    }
    case 'tiara': {
      const silver = toon('#dfe6f0');
      const ring = add(mesh(new THREE.TorusGeometry(0.26, 0.02, 8, 32, Math.PI), silver, 0, top - 0.02, 0.04));
      ring.rotation.x = -Math.PI / 2 + 0.2;
      for (const [x, h] of [[-0.14, 0.08], [0, 0.13], [0.14, 0.08]]) add(mesh(new THREE.ConeGeometry(0.035, h, 6), silver, x, top + h / 2, 0.2 - Math.abs(x) * 0.4));
      add(mesh(new THREE.OctahedronGeometry(0.035), toon('#ff8fb1'), 0, top + 0.05, 0.23));
      break;
    }
    case 'partyhat': {
      // a striped cone, a little to one side, with a pompom
      const stripes = canvasTexture(64, 64, (ctx) => {
        for (let i = 0; i < 8; i++) {
          ctx.fillStyle = i % 2 ? '#ffd34d' : '#7c6cf2';
          ctx.fillRect(0, i * 8, 64, 8);
        }
      });
      const cone = add(mesh(new THREE.ConeGeometry(0.17, 0.36, 24), new THREE.MeshToonMaterial({ map: stripes.tex }), 0.12, top + 0.16, 0));
      cone.rotation.z = -0.25;
      add(mesh(new THREE.SphereGeometry(0.05, 12, 10), toon('#ff5e62'), 0.17, top + 0.34, 0));
      break;
    }
    case 'hairbow': {
      // a big bow on top, a little to one side
      const pink = toon('#ff6fa5');
      for (const side of [-1, 1]) {
        const wing = add(mesh(new THREE.SphereGeometry(0.1, 14, 10), pink, 0.2 + side * 0.1, top + 0.05, 0.04));
        wing.scale.set(1.1, 0.75, 0.4);
        wing.rotation.z = side * 0.4;
      }
      add(mesh(new THREE.SphereGeometry(0.045, 12, 10), toon('#e0457f'), 0.2, top + 0.05, 0.06));
      break;
    }
    case 'beanie': {
      const knit = toon('#3a7bd5');
      const dome = add(mesh(new THREE.SphereGeometry(0.37, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), knit, 0, top - 0.06, 0));
      dome.scale.set(1.02, 0.8, 0.98);
      add(mesh(new THREE.CylinderGeometry(0.385, 0.385, 0.09, 28), toon('#2b5fa8'), 0, top - 0.03, 0));
      add(mesh(new THREE.SphereGeometry(0.08, 14, 12), toon('#ffffff'), 0, top + 0.25, 0));
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
