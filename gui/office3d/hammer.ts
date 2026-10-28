import { shadowMesh } from '@/office3d/core/mesh';
import * as THREE from 'three';
import { toon, glow, canvasTexture } from './materials';

// A squeaky toy hammer: pink accordion heads on a yellow body, a ridged handle
// with a bead knob. The group's origin is the end of the handle (where a hand
// would hold it); the handle runs along -X and the head's striking faces point
// along ±Y, so at rest the bottom face hits whatever is below the head.
export const HAMMER = { reach: 0.6, faceDrop: 0.205 }; // handle-end to head centre; head centre to striking face

export function buildHammer() {
  const yellow = toon('#ffd23f');
  const pink = toon('#ff4f9a');
  const pinkLight = toon('#ff86bf');
  const hammer = new THREE.Group();

  // handle along -X, with grip rings and a two-bead knob at the end
  const handle = shadowMesh(new THREE.CylinderGeometry(0.03, 0.036, 0.42, 14), yellow, -0.25, 0, 0);
  handle.rotation.z = Math.PI / 2;
  hammer.add(handle);
  for (const x of [-0.1, -0.15, -0.2]) {
    const ring = shadowMesh(new THREE.TorusGeometry(0.037, 0.008, 6, 16), yellow, x, 0, 0);
    ring.rotation.y = Math.PI / 2;
    hammer.add(ring);
  }
  hammer.add(shadowMesh(new THREE.SphereGeometry(0.045, 14, 12), yellow, -0.02, 0, 0));
  hammer.add(shadowMesh(new THREE.SphereGeometry(0.03, 12, 10), yellow, 0.045, 0, 0));
  // a little cage-like neck up into the head
  const neck = shadowMesh(new THREE.CylinderGeometry(0.06, 0.035, 0.08, 14), yellow, -0.49, 0, 0);
  neck.rotation.z = Math.PI / 2;
  hammer.add(neck);

  // the head: its own group so it can squish along its axis on impact
  const head = new THREE.Group();
  head.position.x = -HAMMER.reach;
  hammer.add(head);
  head.add(shadowMesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 22), yellow));
  // the cartoon sticker on the front
  const sticker = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 ? 46 : 62;
      ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
    }
    ctx.fill();
    ctx.fillStyle = '#ff4f9a';
    ctx.font = '900 30px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BONK', 64, 74);
  });
  const decal = shadowMesh(
    new THREE.CircleGeometry(0.07, 20),
    glow('#ffffff', { map: sticker.tex, transparent: true }),
    0,
    0,
    0.101,
  );
  head.add(decal);
  // accordion ends: ribs of alternating size, then a flat cap
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const r = i % 2 ? 0.128 : 0.142;
      head.add(
        shadowMesh(
          new THREE.CylinderGeometry(r, r, 0.024, 26),
          i % 2 ? pinkLight : pink,
          0,
          side * (0.092 + i * 0.024),
          0,
        ),
      );
    }
    head.add(shadowMesh(new THREE.CylinderGeometry(0.13, 0.13, 0.012, 26), pinkLight, 0, side * 0.2, 0));
  }

  hammer.visible = false;
  return { hammer, head };
}
