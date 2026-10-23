import * as THREE from 'three';
import { glow, canvasTexture } from './materials.js';
import { FACE_W, FACE_H } from './face.js';

// Shared bits for the furry characters (Loopy, the cat).

export const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

/**
 * A round head turned on a lathe: radius prof(t) at height H*t (t = 0 bottom,
 * 1 top), squashed front-to-back by DZ. The face (eyes, mouth...) is drawn on a
 * canvas wrapped onto a slice of the same shape covering the front:
 * face = { phi: width in radians, t0, t1: bottom and top of the slice }.
 * facePoint(px, py) is the spot on the head under a canvas pixel.
 */
export function latheHead({ H, DZ, prof, face, material }) {
  const lathe = (t0, t1, grow, phiStart, phiLength) => {
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = t0 + ((t1 - t0) * i) / 48;
      pts.push(new THREE.Vector2(prof(t) * grow, H * t));
    }
    return new THREE.LatheGeometry(pts, 40, phiStart, phiLength);
  };
  const skull = mesh(lathe(0, 1, 1), material);
  skull.scale.z = DZ;
  const tex = canvasTexture(FACE_W, FACE_H);
  const faceMat = glow('#ffffff', { map: tex.tex, transparent: true, depthWrite: false });
  const shell = mesh(lathe(face.t0, face.t1, 1.012, -face.phi / 2, face.phi), faceMat);
  shell.scale.z = DZ;
  const facePoint = (px, py, lift = 0) => {
    const phi = -face.phi / 2 + (px / FACE_W) * face.phi;
    const t = face.t1 - (py / FACE_H) * (face.t1 - face.t0);
    const r = prof(t) + lift;
    return new THREE.Vector3(r * Math.sin(phi), H * t, r * Math.cos(phi) * DZ);
  };
  return { skull, shell, face: { ...tex, material: faceMat }, facePoint };
}

// The robot's antenna and chest lights, for characters that have none.
export const noLights = () => ({ antennaBall: new THREE.MeshBasicMaterial(), chest: new THREE.Mesh(undefined, new THREE.MeshBasicMaterial()) });

// Fit the robot's accessories (made for its boxy head) onto a critter's head:
// fit[name] = [up, forward, widen].
export function fitAccessory(group, name, fit, build) {
  build(group, name);
  const [up, fwd, widen] = fit[name] || [0, 0, 1];
  group.position.set(0, up, fwd);
  group.scale.set(widen, 1, widen);
}
