import { mesh } from '@/office3d/core/mesh';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, glow } from './materials';
import type { BodyFit, HeadFit, KitParts, RigArms } from './types';
import { put, flowers, dots, stripes } from './cloth';

// What a robot you built (kit3d.js) wears: clothes, something round its neck, something it
// holds or has on its back, and glasses. Everything is cut to its body and head, and rides
// on the rig: clothes and neckwear on the torso, sleeves on the shoulders, a held thing in the
// left hand (the right one does the antics' phone and mug), wings and capes on its back.
//   buildWear(kit, { torso, head, arms, body, b, h })
//     body: its body part ('box', 'egg'…); b: { top, front, half, mid }; h: { faceY, faceZ, width }

export type WearParts = { torso: THREE.Group; head: THREE.Group; arms: RigArms; body: string; b: BodyFit; h: HeadFit };
type WearCtx = WearParts & { cloth: string };

export const WEAR = {
  clothes: [
    'none',
    'tshirt',
    'hawaiian',
    'santa',
    'elf',
    'suit',
    'vampire',
    'witch',
    'dress',
    'swimsuit',
    'tutu',
    'maid',
  ],
  neck: ['none', 'scarf', 'lei', 'tie', 'bow', 'pearls'],
  extra: [
    'none',
    'candycane',
    'gift',
    'pumpkin',
    'icecream',
    'balloon',
    'cape',
    'wings',
    'batwings',
    'surfboard',
    'backpack',
    'duster',
  ],
  specs: ['none', 'sunglasses', 'heart', 'round', 'star', 'eyepatch'],
};

// ---------------------------------------------------------------- cut to the body

// a shell over the body between heights y0 and y1 (torso space), g bigger than the body
function shell(body: string, y0: number, y1: number, g: number, mat: THREE.Material) {
  const h = y1 - y0;
  const y = (y0 + y1) / 2;
  switch (body) {
    case 'barrel':
      return mesh(new THREE.CylinderGeometry(0.24 + g, 0.24 + g, h, 32), mat, 0, y, 0);
    case 'egg': {
      // a band of the egg: the slice of its sphere between those heights
      const r = 0.27;
      const sy = 1.02;
      const th = (yy: number) => Math.acos(Math.max(-1, Math.min(1, (yy - 0.27) / (r * sy))));
      const t0 = th(y1);
      const m = mesh(new THREE.SphereGeometry(r + g, 32, 16, 0, Math.PI * 2, t0, th(y0) - t0), mat, 0, 0.27, 0);
      m.scale.set(1, sy, 0.85);
      return m;
    }
    case 'slim':
      return mesh(new THREE.CylinderGeometry(0.17 + g, 0.17 + g, h, 28), mat, 0, y, 0);
    case 'chunky':
      return mesh(new RoundedBoxGeometry(0.64 + 2 * g, h, 0.42 + 2 * g, 4, Math.min(0.1, h / 2 - 0.001)), mat, 0, y, 0);
    default:
      return mesh(new RoundedBoxGeometry(0.5 + 2 * g, h, 0.36 + 2 * g, 4, Math.min(0.12, h / 2 - 0.001)), mat, 0, y, 0);
  }
}
// a sleeve on each upper arm (it moves with the arm)
function sleeves(arms: RigArms, mat: THREE.Material, long = false) {
  for (const a of Object.values(arms)) {
    put(
      a.shoulder,
      mesh(new THREE.CylinderGeometry(0.075, 0.07, long ? 0.2 : 0.11, 14), mat, 0, long ? -0.11 : -0.06, 0),
    );
    if (long) put(a.elbow, mesh(new THREE.CylinderGeometry(0.066, 0.07, 0.12, 14), mat, 0, -0.08, 0));
  }
}
// a skirt from the waist, flaring over the lap
function skirt(
  torso: THREE.Object3D,
  b: BodyFit,
  mat: THREE.MeshToonMaterial,
  { drop = 0.17, flare = 0.13, hem = null }: { drop?: number; flare?: number; hem?: THREE.Material | null } = {},
) {
  const sk = put(
    torso,
    mesh(
      new THREE.CylinderGeometry(b.half + 0.03, b.half + flare, drop, 28, 1, true),
      mat,
      0,
      0.04 - drop / 2 + 0.06,
      0,
    ),
  );
  sk.material = mat.clone();
  sk.material.side = THREE.DoubleSide;
  sk.scale.z = 0.9;
  // a zigzag hem: little points all round
  if (hem) {
    const n = 16;
    const r = b.half + flare;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const tip = mesh(
        new THREE.ConeGeometry(0.035, 0.07, 4),
        i % 2 ? hem : mat,
        Math.sin(a) * r,
        0.1 - drop - 0.02,
        Math.cos(a) * r * 0.9,
      );
      tip.rotation.x = Math.PI;
      put(torso, tip);
    }
  }
  return sk;
}

// ---------------------------------------------------------------- clothes

function clothes(kind: string, { torso, arms, body, b, cloth }: WearCtx) {
  const top = b.top - 0.015; // up to the neck
  const g = 0.012;
  switch (kind) {
    case 'tshirt': {
      const m = toon(cloth);
      put(torso, shell(body, b.mid - 0.08, top, g, m));
      sleeves(arms, m);
      break;
    }
    case 'hawaiian': {
      const m = toon('#ffffff', { map: flowers(cloth) });
      put(torso, shell(body, b.mid - 0.1, top, g, m));
      sleeves(arms, m);
      // an open collar
      for (const s of [-1, 1]) {
        const flap = put(
          torso,
          mesh(new THREE.BoxGeometry(0.08, 0.1, 0.012), m, s * 0.05, top - 0.04, b.front + g + 0.01),
        );
        flap.rotation.z = s * 0.5;
      }
      break;
    }
    case 'santa': {
      const red = toon('#d62f3a');
      const white = toon('#ffffff');
      put(torso, shell(body, 0.02, top, g, red));
      sleeves(arms, red, true);
      const trim = put(torso, mesh(new THREE.TorusGeometry(b.half + 0.02, 0.035, 10, 32), white, 0, 0.04, 0));
      trim.rotation.x = Math.PI / 2;
      trim.scale.y = 0.85;
      put(torso, shell(body, b.mid - 0.12, b.mid - 0.07, g + 0.006, toon('#1d2235')));
      put(torso, mesh(new THREE.BoxGeometry(0.1, 0.07, 0.02), toon('#ffd34d'), 0, b.mid - 0.095, b.front + g + 0.012));
      for (const a of Object.values(arms))
        put(a.elbow, mesh(new THREE.TorusGeometry(0.068, 0.025, 8, 18), white, 0, -0.15, 0).rotateX(Math.PI / 2));
      for (const y of [b.mid + 0.08, b.mid])
        put(torso, mesh(new THREE.SphereGeometry(0.018, 8, 6), white, 0, y, b.front + g + 0.006));
      break;
    }
    case 'elf': {
      const green = toon('#2f9e5b');
      put(torso, shell(body, 0.06, top, g, green));
      sleeves(arms, green, true);
      skirt(torso, b, green, { drop: 0.12, flare: 0.08, hem: toon('#d62f3a') });
      put(torso, shell(body, b.mid - 0.1, b.mid - 0.05, g + 0.006, toon('#5a3a22')));
      put(torso, mesh(new THREE.BoxGeometry(0.08, 0.06, 0.02), toon('#ffd34d'), 0, b.mid - 0.075, b.front + g + 0.012));
      break;
    }
    case 'suit': {
      const black = toon('#23262f');
      put(torso, shell(body, 0.02, top, g, black));
      sleeves(arms, black, true);
      // the white shirt in the V of the jacket, and a red bow tie
      const shirt = put(
        torso,
        mesh(new THREE.CircleGeometry(0.12, 3), toon('#ffffff'), 0, top - 0.1, b.front + g + 0.004),
      );
      shirt.rotation.z = -Math.PI / 2;
      shirt.scale.set(1.2, 0.7, 1);
      for (const s of [-1, 1]) {
        const wing = put(
          torso,
          mesh(new THREE.ConeGeometry(0.035, 0.07, 4), toon('#d62f3a'), s * 0.035, top - 0.03, b.front + g + 0.02),
        );
        wing.rotation.z = (s * Math.PI) / 2;
      }
      for (const y of [b.mid - 0.02, b.mid - 0.09])
        put(torso, mesh(new THREE.SphereGeometry(0.015, 8, 6), toon('#c9a46a'), 0, y, b.front + g + 0.006));
      break;
    }
    case 'vampire': {
      const black = toon('#1a1420');
      put(torso, shell(body, 0.02, top, g, black));
      sleeves(arms, black, true);
      const vest = put(
        torso,
        mesh(new THREE.CircleGeometry(0.12, 3), toon('#9b1b30'), 0, top - 0.1, b.front + g + 0.004),
      );
      vest.rotation.z = -Math.PI / 2;
      vest.scale.set(1.2, 0.7, 1);
      // a tall stiff collar standing up behind the neck
      for (const s of [-1, 1]) {
        const c = put(
          torso,
          mesh(new THREE.BoxGeometry(0.16, 0.2, 0.015), toon('#9b1b30'), s * 0.11, top + 0.07, -0.05),
        );
        c.rotation.y = s * 0.6;
        c.rotation.x = -0.2;
      }
      break;
    }
    case 'witch': {
      const purple = toon('#4b2d6e');
      put(torso, shell(body, 0.04, top, g, purple));
      sleeves(arms, purple, true);
      skirt(torso, b, purple, { drop: 0.2, flare: 0.15, hem: toon('#1a1420') });
      put(torso, shell(body, b.mid - 0.11, b.mid - 0.07, g + 0.006, toon('#ff8a1f')));
      break;
    }
    case 'dress': {
      const m = toon(cloth);
      put(torso, shell(body, 0.04, top, g, m));
      sleeves(arms, m);
      skirt(torso, b, toon('#ffffff', { map: dots(cloth, '#ffffff') }));
      // a white collar
      const collar = put(
        torso,
        mesh(new THREE.TorusGeometry(0.1, 0.025, 8, 20, Math.PI), toon('#ffffff'), 0, top - 0.01, b.front * 0.4),
      );
      collar.rotation.x = Math.PI / 2;
      collar.rotation.z = Math.PI;
      break;
    }
    case 'maid': {
      // a dark dress with a frilly white apron and collar (the evening housemaid wears it)
      const dark = toon(cloth);
      const white = toon('#ffffff');
      put(torso, shell(body, 0.04, top, g, dark));
      sleeves(arms, dark);
      for (const a of Object.values(arms))
        put(a.shoulder, mesh(new THREE.TorusGeometry(0.075, 0.016, 6, 16), white, 0, -0.115, 0).rotateX(Math.PI / 2));
      skirt(torso, b, dark, { drop: 0.19, flare: 0.14, hem: white });
      // the apron: a bib up the chest and a skirt panel down the front, edged with frills
      const bib = put(
        torso,
        mesh(new RoundedBoxGeometry(0.22, 0.2, 0.012, 2, 0.02), white, 0, b.mid + 0.02, b.front + g + 0.006),
      );
      bib.rotation.x = -0.06;
      const panel = put(torso, mesh(new THREE.BoxGeometry(0.3, 0.2, 0.012), white, 0, 0.0, b.half + 0.08));
      panel.rotation.x = -0.55;
      for (let i = 0; i < 7; i++)
        put(torso, mesh(new THREE.SphereGeometry(0.022, 8, 6), white, -0.15 + i * 0.05, -0.07, b.half + 0.13));
      // the waist ribbon, tied in a bow at the back
      put(torso, shell(body, b.mid - 0.11, b.mid - 0.08, g + 0.008, white));
      for (const s of [-1, 1]) {
        const loop = put(
          torso,
          mesh(new THREE.SphereGeometry(0.05, 10, 8), white, s * 0.05, b.mid - 0.09, -b.front - 0.04),
        );
        loop.scale.set(1.2, 0.7, 0.4);
      }
      const collar = put(
        torso,
        mesh(new THREE.TorusGeometry(0.1, 0.025, 8, 20, Math.PI), white, 0, top - 0.01, b.front * 0.4),
      );
      collar.rotation.x = Math.PI / 2;
      collar.rotation.z = Math.PI;
      break;
    }
    case 'swimsuit': {
      put(torso, shell(body, 0.02, b.mid + 0.1, g, toon('#ffffff', { map: dots(cloth, '#ffffff') })));
      skirt(torso, b, toon(cloth), { drop: 0.08, flare: 0.05 });
      break;
    }
    case 'tutu': {
      put(torso, shell(body, 0.06, top, g, toon('#ff8fb1')));
      // layers of tulle, see-through
      for (const [i, drop] of [
        [0, 0.1],
        [1, 0.08],
      ]) {
        const tulle = new THREE.MeshToonMaterial({
          color: i ? '#ffd1e6' : '#ffb6d5',
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        });
        const t = put(
          torso,
          mesh(
            new THREE.CylinderGeometry(b.half + 0.03, b.half + 0.18 - i * 0.04, drop, 28, 1, true),
            tulle,
            0,
            0.08 - i * 0.02,
            0,
          ),
        );
        t.scale.z = 0.9;
      }
      for (let i = 0; i < 6; i++)
        put(
          torso,
          mesh(
            new THREE.OctahedronGeometry(0.012),
            glow('#ffffff'),
            Math.sin(i * 1.1) * 0.12,
            top - 0.05 - i * 0.04,
            b.front + g + 0.005,
          ),
        );
      break;
    }
  }
}

// ---------------------------------------------------------------- round its neck

function neck(kind: string, { torso, b, cloth }: WearCtx) {
  const y = b.top + 0.0;
  switch (kind) {
    case 'scarf': {
      const knit = toon('#ffffff', { map: stripes('#d62f3a', '#ffffff', 6) });
      const ring = put(torso, mesh(new THREE.TorusGeometry(0.13, 0.05, 12, 24), knit, 0, y, 0));
      ring.rotation.x = Math.PI / 2;
      const tail = put(
        torso,
        mesh(new RoundedBoxGeometry(0.09, 0.24, 0.03, 2, 0.012), knit, 0.08, y - 0.12, b.front + 0.04),
      );
      tail.rotation.z = 0.12;
      break;
    }
    case 'lei': {
      const colours = ['#ff6fa5', '#ffd34d', '#ffffff', '#ff8a1f', '#c77dff'];
      const n = 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // a ring round the neck that dips down the front
        const dip = Math.max(0, Math.cos(a)) * 0.1;
        put(
          torso,
          mesh(
            new THREE.SphereGeometry(0.035, 10, 8),
            toon(colours[i % colours.length]),
            Math.sin(a) * (b.half * 0.75),
            y - 0.02 - dip,
            Math.cos(a) * (b.front * 0.9 + 0.03),
          ),
        );
      }
      break;
    }
    case 'tie': {
      const tie = toon('#ffffff', { map: stripes('#2b4c9b', '#d62f3a', 10) });
      put(torso, mesh(new THREE.BoxGeometry(0.05, 0.04, 0.03), tie, 0, y - 0.03, b.front + 0.02));
      const blade = put(torso, mesh(new THREE.CylinderGeometry(0.045, 0.02, 0.2, 4), tie, 0, y - 0.15, b.front + 0.02));
      blade.rotation.y = Math.PI / 4;
      blade.rotation.z = Math.PI;
      blade.scale.z = 0.4;
      break;
    }
    case 'bow': {
      const pink = toon(cloth === '#ff8fb1' ? '#e0457f' : '#ff6fa5');
      for (const s of [-1, 1]) {
        const wing = put(
          torso,
          mesh(new THREE.SphereGeometry(0.06, 12, 10), pink, s * 0.065, y - 0.05, b.front + 0.025),
        );
        wing.scale.set(1.2, 0.8, 0.45);
      }
      put(torso, mesh(new THREE.SphereGeometry(0.03, 10, 8), pink, 0, y - 0.05, b.front + 0.04));
      for (const s of [-1, 1]) {
        const ribbon = put(
          torso,
          mesh(new THREE.BoxGeometry(0.03, 0.09, 0.01), pink, s * 0.025, y - 0.11, b.front + 0.03),
        );
        ribbon.rotation.z = s * 0.3;
      }
      break;
    }
    case 'pearls': {
      const n = 13;
      for (let i = 0; i < n; i++) {
        const a = -1.2 + (i / (n - 1)) * 2.4;
        put(
          torso,
          mesh(
            new THREE.SphereGeometry(0.022, 10, 8),
            toon('#f6f1e8'),
            Math.sin(a) * b.half * 0.6,
            y - 0.03 - Math.cos(a) * 0.06,
            b.front * 0.85 + 0.02,
          ),
        );
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- held, or on its back

function extra(kind: string, { torso, arms, b }: WearCtx) {
  const hand = arms.armL.elbow; // (the left hand: the antics' phone and mug go in the right)
  const held = new THREE.Group();
  held.position.set(0, -0.24, 0.05);
  const back = new THREE.Group();
  back.position.set(0, b.mid + 0.05, -b.front - 0.02);
  switch (kind) {
    case 'candycane': {
      const cane = toon('#ffffff', { map: stripes('#d62f3a', '#ffffff', 12) });
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 20; i++) pts.push(new THREE.Vector3(0, -0.12 + i * 0.016, 0));
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI;
        pts.push(new THREE.Vector3(0.05 - Math.cos(a) * 0.05, 0.2 + Math.sin(a) * 0.05, 0));
      }
      held.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.018, 8), cane));
      put(hand, held);
      break;
    }
    case 'gift': {
      held.add(mesh(new RoundedBoxGeometry(0.15, 0.13, 0.15, 2, 0.015), toon('#2f9e5b'), 0, 0.02, 0.04));
      held.add(mesh(new THREE.BoxGeometry(0.155, 0.135, 0.03), toon('#ffd34d'), 0, 0.02, 0.04));
      held.add(mesh(new THREE.BoxGeometry(0.03, 0.135, 0.155), toon('#ffd34d'), 0, 0.02, 0.04));
      for (const s of [-1, 1]) {
        const loop = mesh(new THREE.SphereGeometry(0.03, 10, 8), toon('#ffd34d'), s * 0.03, 0.1, 0.04);
        loop.scale.set(1.2, 0.7, 0.6);
        held.add(loop);
      }
      put(hand, held);
      break;
    }
    case 'pumpkin': {
      // a trick-or-treat pumpkin bucket, with a grin
      const bucket = mesh(new THREE.SphereGeometry(0.1, 16, 12), toon('#ff8a1f'), 0, -0.07, 0.03);
      bucket.scale.set(1.1, 0.85, 1);
      held.add(bucket);
      const face = glow('#3a2210');
      for (const s of [-1, 1]) held.add(mesh(new THREE.ConeGeometry(0.018, 0.03, 3), face, s * 0.035, -0.05, 0.13));
      held.add(mesh(new THREE.BoxGeometry(0.07, 0.015, 0.01), face, 0, -0.1, 0.13));
      const handle = mesh(new THREE.TorusGeometry(0.08, 0.008, 6, 20, Math.PI), toon('#1d2235'), 0, -0.03, 0.03);
      held.add(handle);
      put(hand, held);
      break;
    }
    case 'duster': {
      // a feather duster: a wooden handle and a big fluffy puff of colourful feathers
      held.add(mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.4, 8), toon('#a8743e'), 0, 0.13, 0.04)); // (a long handle: it reaches the desk top)
      held.add(mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.03, 10), toon('#ffd34d'), 0, 0.33, 0.04));
      const colours = ['#ff6fa5', '#ffd34d', '#7bed9f', '#8fc8ff', '#c6a8ff', '#ff9f43'];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const up = i % 2 ? 0.05 : 0.0;
        const f = mesh(
          new THREE.ConeGeometry(0.03, 0.14, 6),
          toon(colours[i % colours.length]),
          Math.cos(a) * 0.04,
          0.41 + up,
          0.04 + Math.sin(a) * 0.04,
        );
        f.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
        held.add(f);
      }
      held.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ffffff'), 0, 0.44, 0.04));
      held.scale.setScalar(1.35); // (big enough to read as a duster from across the desk)
      held.name = 'duster'; // (walker3d.js turns it round to wipe a desk with it)
      put(hand, held);
      break;
    }
    case 'icecream': {
      held.add(mesh(new THREE.ConeGeometry(0.045, 0.12, 14), toon('#d9a35b'), 0, 0.02, 0.04).rotateX(Math.PI));
      held.add(mesh(new THREE.SphereGeometry(0.05, 14, 10), toon('#ffc4dd'), 0, 0.1, 0.04));
      held.add(mesh(new THREE.SphereGeometry(0.045, 14, 10), toon('#fff3c4'), 0, 0.17, 0.04));
      held.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), toon('#d62f3a'), 0, 0.22, 0.04));
      put(hand, held);
      break;
    }
    case 'balloon': {
      held.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.5, 4), toon('#ffffff'), 0, 0.25, 0));
      const balloon = mesh(new THREE.SphereGeometry(0.11, 18, 14), toon('#ff5e62'), 0, 0.58, 0);
      balloon.scale.set(1, 1.15, 1);
      held.add(balloon);
      // (it bobs about on its string)
      balloon.onBeforeRender = () => {
        const t = performance.now() / 1000;
        balloon.position.x = Math.sin(t * 1.3) * 0.03;
      };
      put(hand, held);
      break;
    }
    case 'cape': {
      const cape = new THREE.MeshToonMaterial({ color: '#1a1420', side: THREE.DoubleSide });
      const c = mesh(
        new THREE.CylinderGeometry(b.half + 0.04, b.half + 0.16, 0.6, 20, 1, true, Math.PI * 0.6, Math.PI * 0.8),
        cape,
        0,
        -0.08,
        b.front + 0.02,
      );
      back.add(c);
      const lining = mesh(
        new THREE.CylinderGeometry(b.half + 0.035, b.half + 0.155, 0.6, 20, 1, true, Math.PI * 0.6, Math.PI * 0.8),
        new THREE.MeshToonMaterial({ color: '#9b1b30', side: THREE.BackSide }),
        0,
        -0.08,
        b.front + 0.02,
      );
      back.add(lining);
      put(torso, back);
      break;
    }
    case 'wings':
    case 'batwings': {
      const bat = kind === 'batwings';
      const mat = bat
        ? new THREE.MeshToonMaterial({ color: '#2a2233', side: THREE.DoubleSide })
        : new THREE.MeshToonMaterial({ color: '#d9c7ff', transparent: true, opacity: 0.75, side: THREE.DoubleSide });
      const shape = new THREE.Shape();
      if (bat) {
        shape.moveTo(0, 0);
        shape.lineTo(0.32, 0.18);
        shape.quadraticCurveTo(0.3, 0.02, 0.24, -0.02);
        shape.quadraticCurveTo(0.2, 0.06, 0.16, -0.04);
        shape.quadraticCurveTo(0.1, 0.04, 0, 0);
      } else {
        shape.moveTo(0, 0);
        shape.bezierCurveTo(0.12, 0.3, 0.34, 0.26, 0.26, 0.06);
        shape.bezierCurveTo(0.3, -0.06, 0.12, -0.16, 0, 0);
      }
      const geo = new THREE.ShapeGeometry(shape, 16);
      const pair: [THREE.Group, number][] = [];
      for (const s of [-1, 1]) {
        const w = new THREE.Group();
        w.position.set(s * 0.05, 0.05, 0);
        const m = mesh(geo, mat);
        m.scale.x = s;
        w.add(m);
        w.rotation.y = s * -0.5;
        back.add(w);
        pair.push([w, s]);
      }
      // (a slow flap)
      pair[0][0].children[0].onBeforeRender = () => {
        const t = performance.now() / 1000;
        for (const [w, s] of pair) w.rotation.y = s * (-0.5 + Math.sin(t * (bat ? 2 : 3)) * 0.25);
      };
      put(torso, back);
      break;
    }
    case 'surfboard': {
      const board = mesh(
        new THREE.CapsuleGeometry(0.09, 0.62, 6, 16),
        toon('#ffffff', { map: stripes('#36c2d9', '#ffffff', 6) }),
        0,
        0,
        0,
      );
      board.scale.z = 0.18;
      board.rotation.z = 0.5;
      back.add(board);
      back.position.z -= 0.03;
      put(torso, back);
      break;
    }
    case 'backpack': {
      back.add(mesh(new RoundedBoxGeometry(b.half * 1.4, 0.3, 0.14, 3, 0.05), toon('#e9902f'), 0, 0, -0.05));
      back.add(mesh(new RoundedBoxGeometry(b.half * 1.0, 0.12, 0.05, 2, 0.02), toon('#c87420'), 0, -0.06, -0.13));
      put(torso, back);
      break;
    }
  }
}

// ---------------------------------------------------------------- glasses

function specs(kind: string, { head, h }: WearCtx) {
  const g = new THREE.Group();
  g.position.set(0, h.faceY + 0.02, h.faceZ + 0.03);
  const k = Math.min(1.1, h.width / 0.74);
  g.scale.setScalar(k);
  const frame = toon('#1d2235');
  const gap = 0.14;
  switch (kind) {
    case 'sunglasses': {
      const lens = toon('#14161f');
      for (const s of [-1, 1]) {
        const l = mesh(new RoundedBoxGeometry(0.17, 0.11, 0.02, 2, 0.04), lens, s * gap, 0, 0);
        g.add(l);
      }
      g.add(mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), frame, 0, 0.03, 0));
      g.add(mesh(new THREE.BoxGeometry(0.6, 0.015, 0.015), frame, 0, 0.04, -0.02));
      break;
    }
    case 'heart': {
      const heart = new THREE.Shape();
      heart.moveTo(0, -0.06);
      heart.bezierCurveTo(-0.09, 0, -0.07, 0.07, 0, 0.035);
      heart.bezierCurveTo(0.07, 0.07, 0.09, 0, 0, -0.06);
      const geo = new THREE.ExtrudeGeometry(heart, { depth: 0.015, bevelEnabled: false });
      for (const s of [-1, 1]) g.add(mesh(geo, toon('#ff4f8b'), s * gap, 0, 0));
      g.add(mesh(new THREE.BoxGeometry(0.08, 0.015, 0.015), toon('#ff4f8b'), 0, 0.02, 0.005));
      break;
    }
    case 'round':
      for (const s of [-1, 1])
        g.add(mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 24), toon('#8a5a2b'), s * gap, 0, 0));
      g.add(mesh(new THREE.BoxGeometry(0.07, 0.012, 0.012), toon('#8a5a2b'), 0, 0.02, 0));
      break;
    case 'star': {
      const star = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.04 : 0.09;
        const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
        i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      const geo = new THREE.ExtrudeGeometry(star, { depth: 0.015, bevelEnabled: false });
      for (const s of [-1, 1]) g.add(mesh(geo, toon('#ffd34d'), s * gap, 0, 0));
      g.add(mesh(new THREE.BoxGeometry(0.06, 0.015, 0.015), toon('#ffd34d'), 0, 0.02, 0.005));
      break;
    }
    case 'eyepatch': {
      g.add(mesh(new THREE.CircleGeometry(0.07, 18), toon('#14161f'), gap, 0, 0.01));
      const strap = mesh(new THREE.BoxGeometry(0.62, 0.015, 0.012), toon('#14161f'), 0, 0.05, -0.01);
      strap.rotation.z = -0.25;
      g.add(strap);
      break;
    }
    default:
      return;
  }
  put(head, g);
}

export function buildWear(kit: KitParts, parts: WearParts) {
  const ctx: WearCtx = { ...parts, cloth: kit.cloth };
  if (kit.clothes !== 'none') clothes(kit.clothes, ctx);
  if (kit.neck !== 'none') neck(kit.neck, ctx);
  if (kit.extra !== 'none') extra(kit.extra, ctx);
  if (kit.specs !== 'none') specs(kit.specs, ctx);
}
