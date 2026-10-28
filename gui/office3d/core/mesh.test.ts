import * as THREE from 'three';
import { expect, test } from 'vitest';
import { isMesh, mesh, shadowMesh } from './mesh';

const box = () => new THREE.BoxGeometry(1, 1, 1);
const paint = () => new THREE.MeshBasicMaterial();

test('mesh: where it was put, no shadow', () => {
  const m = mesh(box(), paint(), 1, 2, 3);
  expect(m.position.toArray()).toEqual([1, 2, 3]);
  expect(m.castShadow).toBe(false);
});

test('shadowMesh casts a shadow', () => {
  const m = shadowMesh(box(), paint());
  expect(m.position.toArray()).toEqual([0, 0, 0]);
  expect(m.castShadow).toBe(true);
});

test('isMesh tells meshes from groups and sprites', () => {
  expect(isMesh(mesh(box(), paint()))).toBe(true);
  expect(isMesh(new THREE.Group())).toBe(false);
  expect(isMesh(new THREE.Sprite())).toBe(false);
});
