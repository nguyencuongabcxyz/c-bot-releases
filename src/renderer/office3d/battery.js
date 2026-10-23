import * as THREE from 'three';
import { toon, glow } from './materials.js';

// A chunky cartoon battery that floats over the robot's head while it charges:
// its level fills from red to green. buildBattery() -> { battery, setLevel(0..1) }.

const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

export function buildBattery() {
  const battery = new THREE.Group();
  const shell = toon('#f4f5fb', { transparent: true, opacity: 0.22, depthWrite: false });
  const ink = toon('#1d2235');
  // the case (see-through, so the level shows), lying on its side
  battery.add(mesh(new THREE.BoxGeometry(0.34, 0.17, 0.12), shell));
  battery.add(mesh(new THREE.BoxGeometry(0.04, 0.08, 0.07), ink, 0.19, 0, 0)); // the + terminal
  for (const x of [-0.172, 0.172]) battery.add(mesh(new THREE.BoxGeometry(0.012, 0.18, 0.13), ink, x, 0, 0));
  // the level: a glowing bar that grows from the left
  const fill = glow('#ff3b30');
  const level = mesh(new THREE.BoxGeometry(0.3, 0.13, 0.09), fill);
  battery.add(level);
  // a lightning bolt on the front
  const bolt = new THREE.Shape();
  bolt.moveTo(0.01, 0.07);
  bolt.lineTo(-0.035, -0.005);
  bolt.lineTo(-0.002, -0.005);
  bolt.lineTo(-0.015, -0.07);
  bolt.lineTo(0.035, 0.01);
  bolt.lineTo(0.003, 0.01);
  bolt.closePath();
  const boltMesh = mesh(new THREE.ShapeGeometry(bolt), glow('#ffd34d'), 0, 0, 0.065);
  battery.add(boltMesh);
  battery.scale.setScalar(1.25);
  battery.visible = false;

  const red = new THREE.Color('#ff3b30');
  const green = new THREE.Color('#18d26e');
  return {
    battery,
    setLevel(k) {
      const p = Math.max(0.02, Math.min(1, k));
      level.scale.x = p;
      level.position.x = -0.15 + 0.15 * p;
      fill.color.copy(red).lerp(green, p);
    },
  };
}
