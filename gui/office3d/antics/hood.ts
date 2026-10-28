// The hood it pulls up when it's still coding after 10 pm: built to fit its head, on while it
// works late, off when it stops (tick, every frame; worn out for a walk too).
import * as THREE from 'three';
import { toon, noOutline } from '@/office3d/materials';
import { mesh, isMesh } from '@/office3d/core/mesh';
import { type Mat, disposeTree } from './calendar-common';
import type { Rig } from '@/office3d/types';
import type { WearCtx } from './types';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();

// ------------------------------------------------------------ the late-night hood

// Still up after 10 pm: a dark hoodie hood pulled up over the head, its face
// opening edged with a thick rim and two drawstrings hanging down. Built in the
// robot's hat space (hats sit at top = 0.59, head from ~0 up) as the nightcap
// is, and fitted to each head from its top-hat fit: up to the hat's height,
// widened as the hats are.
const HOOD_C = new THREE.Vector3(0, 0.29, -0.03); // the shell's centre
const HOOD_R = new THREE.Vector3(0.47, 0.4, 0.38); // ...and radii
const HOOD_N = 2.8; // superellipsoid power: boxy enough to clear the robot's corners
const HOOD_LOW = -0.55; // the shell stops at this elevation (radians), round the neck
// the face opening, an ellipse in (azimuth, elevation) around the front
const OPEN_AZ = 0.98;
const OPEN_EL = [-0.2, 0.62]; // centre, half-height

// a direction on the unit sphere -> a point on the hood (superellipsoid)
const sq = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / HOOD_N);
function hoodPoint(out: THREE.Vector3, az: number, el: number, grow = 1) {
  const ce = Math.cos(el);
  return out
    .set(
      sq(Math.sin(az) * ce) * HOOD_R.x * grow,
      sq(Math.sin(el)) * HOOD_R.y * grow,
      sq(Math.cos(az) * ce) * HOOD_R.z * grow,
    )
    .add(HOOD_C);
}
const inOpening = (az: number, el: number) => (az / OPEN_AZ) ** 2 + ((el - OPEN_EL[0]) / OPEN_EL[1]) ** 2 < 1;

function buildHood() {
  // the shell: a sphere's grid pushed out to the superellipsoid, minus the opening
  const rows = 26;
  const cols = 48;
  const pos: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const el = Math.PI / 2 - (r / rows) * (Math.PI / 2 - HOOD_LOW);
    for (let q = 0; q <= cols; q++) {
      hoodPoint(V1, (q / cols) * Math.PI * 2 - Math.PI, el);
      pos.push(V1.x, V1.y, V1.z);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    const el = Math.PI / 2 - ((r + 0.5) / rows) * (Math.PI / 2 - HOOD_LOW);
    for (let q = 0; q < cols; q++) {
      if (inOpening(((q + 0.5) / cols) * Math.PI * 2 - Math.PI, el)) continue;
      const a = r * (cols + 1) + q;
      const b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const hood = new THREE.Group();
  const shell = new THREE.Mesh(geo, toon('#3d4359'));
  shell.castShadow = true;
  const lining = new THREE.Mesh(geo, toon('#14161f', { side: THREE.BackSide }));
  noOutline(lining.material);
  hood.add(shell, lining);
  // the rim round the opening: a fat tube along its edge
  const edge: THREE.Vector3[] = [];
  for (let i = 0; i <= 60; i++) {
    // round from the bottom: up one side, over the top, down the other (the bottom's cut off)
    const a = Math.PI / 2 + (i / 60) * Math.PI * 2;
    const el = OPEN_EL[0] - Math.sin(a) * OPEN_EL[1];
    if (el >= HOOD_LOW) edge.push(hoodPoint(new THREE.Vector3(), Math.cos(a) * OPEN_AZ, el, 1.01));
  }
  hood.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 48, 0.04, 8), toon('#555c79')));
  // the seam down the middle, from the brim over the top to the back of the neck
  const seam: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const el = OPEN_EL[0] + OPEN_EL[1] + (Math.PI - OPEN_EL[0] - OPEN_EL[1] - HOOD_LOW) * t; // past the top: down the back
    seam.push(
      hoodPoint(new THREE.Vector3(), el > Math.PI / 2 ? Math.PI : 0, el > Math.PI / 2 ? Math.PI - el : el, 1.005),
    );
  }
  hood.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(seam), 32, 0.014, 6), toon('#2f3447')));
  // the collar it rises out of: round the back and sides of the neck, open at the front
  const collar = mesh(new THREE.TorusGeometry(0.37, 0.065, 8, 28, Math.PI * 1.4), toon('#343a4e'), 0, 0.03, -0.03);
  collar.rotation.set(Math.PI / 2, 0, Math.PI / 2 + Math.PI * 0.3);
  collar.scale.set(1, 0.85, 1);
  hood.add(collar);
  // drawstrings from where the rim meets the bottom, with white tips
  const cordMat = toon('#e9ecf5');
  for (const p of [edge[0], edge[edge.length - 1]]) {
    const cord = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 6), cordMat, p.x * 0.8, p.y - 0.1, p.z + 0.03);
    hood.add(cord);
    hood.add(
      mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 8), toon('#c3c8d4'), p.x * 0.8, p.y - 0.21, p.z + 0.03),
    );
  }
  hood.traverse((o) => {
    if (isMesh<THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>>(o) && o !== lining) o.castShadow = true;
  });
  const fit = new THREE.Group(); // follows the body's hat fit
  fit.add(hood);
  return { fit, hood };
}

// Where hats sit on this head (as asleep.js does for the nightcap): whatever it
// wears is already fitted; with nothing on, try a top hat on once to read the
// body's fit, then take it off again.
const hatFits = new WeakMap<Rig, { position: THREE.Vector3; scale: THREE.Vector3 }>();
function hatFit(robot: Rig) {
  const acc = robot.accessory;
  if (acc.children.length || !robot.setAccessory) return acc;
  let fit = hatFits.get(robot);
  if (!fit) {
    robot.setAccessory('tophat');
    fit = { position: acc.position.clone(), scale: acc.scale.clone() };
    const tried = [...acc.children];
    robot.setAccessory('none');
    tried.forEach(disposeTree);
    hatFits.set(robot, fit);
  }
  return fit;
}

// Hats and the antenna (the tuft, the cowlick…) go under the hood. Their parts
// are hidden one by one rather than the groups, so this never fights the
// nightcap, which hides the groups (both can change in the same frame at bedtime).
// One hood per robot, built the first time it's needed and kept until that
// body is swapped out (several desks can share this module: the test harness).
type Hood = ReturnType<typeof buildHood> & { on: boolean; grow: number; hidden: THREE.Object3D[] };
const hoods = new Map<Rig, Hood>(); // robot -> { fit, hood, on, grow, hidden }
function hideUnder(h: Hood, group: THREE.Object3D) {
  if (!group) return;
  for (const o of group.children) {
    if (!o.visible) continue;
    o.visible = false;
    h.hidden.push(o);
  }
}
function hoodOff(h: Hood | undefined) {
  if (!h?.on) return;
  for (const o of h.hidden) o.visible = true;
  h.hidden.length = 0;
  h.fit.removeFromParent();
  h.on = false;
}

export function tick(c: WearCtx) {
  const { robot } = c;
  // a body that's been swapped out takes its hood with it
  for (const [r, h] of hoods) {
    if (r === robot || r.root.parent) continue;
    hoodOff(h);
    disposeTree(h.fit);
    hoods.delete(r);
  }
  let h = hoods.get(robot);
  if (!c.lateNight || c.asleep) return hoodOff(h);
  if (!h) {
    h = { ...buildHood(), on: false, grow: 0, hidden: [] };
    hoods.set(robot, h);
  }
  if (!h.on) {
    h.on = true;
    h.grow = 0;
    robot.head.add(h.fit);
  }
  const fit = hatFit(robot);
  // up to the hat's height, as wide as the hats are made for this head
  const top = fit.position.y + 0.59;
  h.fit.position.set(fit.position.x, 0, fit.position.z);
  h.fit.scale.set(fit.scale.x, top / 0.59, fit.scale.z);
  hideUnder(h, robot.accessory);
  if (robot.antenna?.parent === robot.head) hideUnder(h, robot.antenna);
  // pulled up with a little overshoot
  h.grow = Math.min(1, h.grow + c.dt * 3);
  const x = h.grow - 1;
  const g = 1 + 2.7 * x ** 3 + 1.7 * x ** 2;
  h.hood.scale.setScalar(g);
  h.hood.position.y = (1 - h.grow) * -0.25;
}
