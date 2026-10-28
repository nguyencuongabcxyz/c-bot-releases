// Where the camera looks at the desk from, and how big the robot is drawn out for a walk.
import * as THREE from 'three';
import { LAYOUT } from './scene';
import type { SoloView } from './walker3d';

export const CAMERA = {
  target: new THREE.Vector3(-0.38, 0.7, -0.7),
  dir: new THREE.Vector3(0.62, 0.5, 0.8),
  distance: 5.95,
  fov: 27,
};
// Out walking (solo) it's drawn just as big as at its desk, seen from the same height: the
// desk window is DESK_H CSS px tall (robot.js ROBOT_H), and this is how many of them a world
// unit takes up where it stands up from its chair (antics/walk.js).
const DESK_H = 290;
export function soloView(height: number): SoloView {
  const eye = CAMERA.target.clone().addScaledVector(CAMERA.dir.clone().normalize(), CAMERA.distance);
  const spot = new THREE.Vector3(LAYOUT.chair.x, 0, LAYOUT.chair.z);
  spot.addScaledVector(new THREE.Vector3(eye.x - spot.x, 0, eye.z - spot.z).normalize(), 0.32).setY(0.55);
  // (+3%: by the time the walker takes over it has stepped a little nearer the camera; measured)
  const pxPerUnit = (1.03 * DESK_H) / (2 * eye.distanceTo(spot) * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)));
  const pitch = Math.asin(CAMERA.dir.y / CAMERA.dir.length());
  return { height, pxPerUnit, fov: CAMERA.fov, pitch };
}
