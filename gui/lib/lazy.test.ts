import { expect, test } from 'vitest';
import { lazy } from './lazy';

test('reads each name when it is read, not before', () => {
  let n = 1;
  const o = lazy({ n: () => n, later: () => later });
  n = 2;
  const later = 'here now';
  expect(o.n).toBe(2);
  expect(o.later).toBe('here now');
});

test('a var is written through its setter', () => {
  let editing: string | null = null;
  const o = lazy({}, { editing: [() => editing, (v: string | null) => (editing = v)] });
  o.editing = 'draft';
  expect(editing).toBe('draft');
  editing = 'changed';
  expect(o.editing).toBe('changed');
});

test('functions keep working when called through it', () => {
  const add = (a: number, b: number) => a + b;
  expect(lazy({ add: () => add }).add(2, 3)).toBe(5);
});
