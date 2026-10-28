// Pointing at the 3D office from the page: what's under a point (a sticky note, the corkboard, the
// hammer, the monitor), the floor under it, and where the robot's feet and head are on the page.
// Points are CSS px.
import * as THREE from 'three';
import type { buildProps } from './props';
import type { Board, BoardHit, OfficeSet, Rig } from './types';

/** Something you can click round the desk (propAt), nearest first. */
export type PropHit = BoardHit | { kind: 'hammer' } | { kind: 'plug' };

/** What it reads of the office (a getter for what a new theme or body replaces). */
export type PickingParts = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  solo: boolean;
  set: () => OfficeSet | null;
  robot: () => Rig;
  board: () => Board | null;
  props: () => ReturnType<typeof buildProps> | null;
};

const isUnder = (o: THREE.Object3D | null, root: THREE.Object3D) => {
  for (; o; o = o.parent) if (o === root) return true;
  return false;
};

export function createPicking({
  renderer,
  camera,
  solo,
  set: setOf,
  robot: robotOf,
  board: boardOf,
  props: propsOf,
}: PickingParts) {
  /** A ray from the camera through a page point. */
  function rayAt(clientX: number, clientY: number) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
    const ray = new THREE.Raycaster();
    camera.updateMatrixWorld(); // (its stored matrices can be stale between frames)
    ray.setFromCamera(ndc, camera);
    return ray;
  }
  /** The nearest thing the ray hits round the desk (not the robot while it's hidden, out for a walk). */
  const deskHit = (ray: THREE.Raycaster, set: OfficeSet, robot: Rig) =>
    ray
      .intersectObjects([set.office, robot.root], true)
      .find((h) => robot.root.visible || !isUnder(h.object, robot.root));
  /** A point in the world, on the page (relative to the canvas, or to the page with `onPage`). */
  function toPage(v: THREE.Vector3, onPage: boolean) {
    camera.updateMatrixWorld();
    v.project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    const x = ((v.x + 1) / 2) * r.width;
    const y = ((1 - v.y) / 2) * r.height;
    return onPage ? { x: r.left + x, y: r.top + y } : { x, y };
  }

  /** The sticky note under a page point: { kind, id } or null (scene.ts stickies). */
  function stickyAt(clientX: number, clientY: number) {
    const set = setOf();
    if (solo || !set?.stickies?.objects.length) return null;
    const hit = deskHit(rayAt(clientX, clientY), set, robotOf());
    return hit ? set.stickies.lookup(hit.object) : null;
  }

  /** What you can click round the desk under a page point, nearest first: a note or the
   *  corkboard, the hammer, the plug; null also when the robot's in front of it. */
  function propAt(clientX: number, clientY: number): PropHit | null {
    const set = setOf();
    if (solo || !set) return null;
    const ray = rayAt(clientX, clientY);
    const board = boardOf();
    const robot = robotOf();
    let best: (PropHit & { distance: number }) | null = propsOf()?.hit(ray) || null;
    const onBoard = board?.group.visible && ray.intersectObject(board.group, true)[0];
    // (a ray through a hidden part of the board isn't on it: board.hit says what is)
    const boardHit = onBoard && board ? board.hit(ray) : null;
    if (onBoard && boardHit && (!best || onBoard.distance < best.distance))
      best = { ...boardHit, distance: onBoard.distance };
    if (!best) return null;
    const inFront = robot.root.visible && ray.intersectObject(robot.root, true)[0];
    if (inFront && inFront.distance < best.distance) return null;
    const { distance, ...hit } = best;
    void distance;
    return hit;
  }

  /** The corkboard only. */
  function boardAt(clientX: number, clientY: number) {
    const hit = propAt(clientX, clientY);
    return hit && (hit.kind === 'note' || hit.kind === 'board') ? hit : null;
  }

  /** Is this point on the monitor's screen? (double-clicking it crashes the computer) */
  function hitsMonitor(clientX: number, clientY: number) {
    const set = setOf();
    if (solo || !set) return false;
    const hit = deskHit(rayAt(clientX, clientY), set, robotOf());
    return (hit?.object as { material?: unknown } | undefined)?.material === set.screen.material; // (whatever it hit: a mesh, a sprite…)
  }

  /** The point on the floor (office space, {x, z}) under a page point: where a walker put down on
   *  the desk is standing (antics/walk.ts stepin). */
  function floorAt(clientX: number, clientY: number) {
    const set = setOf();
    if (!set) return null;
    const ray = rayAt(clientX, clientY);
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -set.office.getWorldPosition(new THREE.Vector3()).y);
    const hit = ray.ray.intersectPlane(floor, new THREE.Vector3());
    if (!hit) return null;
    set.office.worldToLocal(hit);
    return { x: hit.x, z: hit.z };
  }

  /** Where its feet are, on the page: stepping out, the walker window takes over with its feet on
   *  this very spot. */
  function feetPosition() {
    const set = setOf();
    const v = new THREE.Vector3();
    robotOf().root.getWorldPosition(v);
    v.y = set ? set.office.getWorldPosition(new THREE.Vector3()).y : 0; // down on the floor
    return toPage(v, true);
  }

  /** Where the robot's head is, within the canvas. */
  function headPosition() {
    const v = new THREE.Vector3(0, 0.3, 0);
    robotOf().head.localToWorld(v);
    return toPage(v, false);
  }

  return { stickyAt, propAt, boardAt, hitsMonitor, floorAt, feetPosition, headPosition };
}
