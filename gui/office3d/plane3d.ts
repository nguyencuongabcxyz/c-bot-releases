import * as THREE from 'three';
import { toon } from './materials';

// A folded paper plane (robots throw them at each other: antics/social.js, and one that
// landed on a busy robot's desk: index.js). Its nose points along +X, wings out to ±Z, a
// keel underneath; about 0.15 long. buildPaperPlane() -> a Group (dispose its children's
// geometry and the material when done; one material is shared by every plane).

let paper: THREE.MeshToonMaterial | null = null;
export function buildPaperPlane() {
  paper ||= toon('#fbfbf6', { side: THREE.DoubleSide });
  const L = 0.15;
  const W = 0.065;
  const geo = new THREE.BufferGeometry();
  // nose, then the two wing tips and the tail middle (a shallow V), then the keel's bottom
  const v = [
    [L / 2, 0.006, 0], // 0 nose
    [-L / 2, 0.018, W], // 1 left wing tip (at the tail)
    [-L / 2, 0.0, 0], // 2 tail, at the fold
    [-L / 2, 0.018, -W], // 3 right wing tip
    [-L / 2, -0.03, 0], // 4 keel bottom at the tail
  ];
  const tris = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 2, 4],
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, paper);
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.dispose = () => geo.dispose();
  return group;
}
