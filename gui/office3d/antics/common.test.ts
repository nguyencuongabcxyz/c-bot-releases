import * as THREE from 'three';
import { expect, test } from 'vitest';
import { LAYOUT } from '@/office3d/scene';
import { blend, once, onceAt, yawOf } from './common';
import type { AnticPose } from './types';

test('onceAt: true on the first frame at or past its moment, then never', () => {
  const c = { s: 0.9, run: {} };
  expect(onceAt(c, 'pop', 1)).toBe(false);
  c.s = 1.02;
  expect(onceAt(c, 'pop', 1)).toBe(true);
  c.s = 1.5;
  expect(onceAt(c, 'pop', 1)).toBe(false);
});

test('once: true the first time for its key', () => {
  const run = {};
  expect([once(run, 'a'), once(run, 'a'), once(run, 'b')]).toEqual([true, false, true]);
});

test('blend moves only that part of the pose', () => {
  const A: Pick<AnticPose, 'head' | 'armL' | 'armR'> = { head: [0, 0, 0], armL: [1, 1, 1], armR: [0, 0, 0] };
  blend(A, 'armL', [3, 5, 1], 0.5);
  expect(A.armL).toEqual([2, 3, 1]);
  expect(A.head).toEqual([0, 0, 0]);
});

test('yawOf: straight ahead of the chair is 0', () => {
  expect(yawOf(new THREE.Vector3(LAYOUT.chair.x, 0, LAYOUT.chair.z + 1))).toBeCloseTo(0);
  expect(yawOf(new THREE.Vector3(LAYOUT.chair.x + 1, 0, LAYOUT.chair.z))).toBeCloseTo(Math.PI / 2);
});
