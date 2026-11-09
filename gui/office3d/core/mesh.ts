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

// (three's types leave the isSprite / isLight flags off Object3D)
const isSprite = (o: THREE.Object3D): o is THREE.Sprite => 'isSprite' in o && !!o.isSprite;
const isLight = (o: THREE.Object3D): o is THREE.Light => 'isLight' in o && !!o.isLight;
type Mapped = THREE.Material & { map?: THREE.Texture | null }; // (a material, maybe with a picture)

/** Off its parent, and the GPU's copies of everything in it let go: geometries, materials, their
 *  pictures, lights' shadow maps. (Anything still used elsewhere is simply sent to the GPU again
 *  when it's next drawn.) */
export function disposeTree(obj: THREE.Object3D) {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (isLight(o)) o.dispose();
    if (!isMesh<THREE.Mesh<THREE.BufferGeometry, Mapped | Mapped[]>>(o) && !isSprite(o)) return;
    if (isMesh(o)) o.geometry.dispose(); // (sprites share one geometry: leave it)
    for (const m of ([] as Mapped[]).concat(o.material)) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
