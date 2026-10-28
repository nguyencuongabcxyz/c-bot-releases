// Making and recognising meshes, the same way in every part of the office.
import * as THREE from 'three';

/** A mesh at (x, y, z). */
export const mesh = <G extends THREE.BufferGeometry, M extends THREE.Material | THREE.Material[]>(
  geo: G,
  mat: M,
  x = 0,
  y = 0,
  z = 0,
) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

/** A mesh at (x, y, z) that casts a shadow. */
export const shadowMesh = <G extends THREE.BufferGeometry, M extends THREE.Material | THREE.Material[]>(
  geo: G,
  mat: M,
  x = 0,
  y = 0,
  z = 0,
) => {
  const m = mesh(geo, mat, x, y, z);
  m.castShadow = true;
  return m;
};

/** Whether it's a mesh (three's types leave the isMesh flag off Object3D). M: what the caller
 *  knows its meshes to be, when it built them. */
export const isMesh = <M extends THREE.Mesh = THREE.Mesh>(o: THREE.Object3D): o is M => 'isMesh' in o && !!o.isMesh;
