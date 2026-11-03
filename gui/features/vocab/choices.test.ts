import { describe, expect, test } from 'vitest';
import type { FindChoice } from '@/types/pages';
import { saveState, withDetail } from './choices';

const choice = (saved: string | null): FindChoice => ({
  word: 'meticulous',
  feel: 'positive',
  tone: 'praise',
  gloss: 'tỉ mỉ',
  ipa: '',
  pos: 'adj',
  vi: '',
  example: '',
  ready: false,
  saved,
});

describe('saveState', () => {
  test('not in My words', () => {
    expect(saveState(choice(null), new Set(['a']))).toBe('new');
  });
  test('saved from this window', () => {
    expect(saveState(choice('a'), new Set(['a']))).toBe('mine');
  });
  test('one you had before', () => {
    expect(saveState(choice('b'), new Set(['a']))).toBe('had');
  });
});

describe('withDetail', () => {
  const found = () => ({ id: 2, choices: [choice('a'), choice(null)], tip: '', complete: false });
  test('into its own search, keeping the saved mark', () => {
    const f = found();
    const detail = { ...choice('stale'), ready: true, example: 'An example.' };
    expect(withDetail(f, { id: 2, index: 0, choice: detail })).toBe(true);
    expect(f.choices[0]).toMatchObject({ ready: true, example: 'An example.', saved: 'a' });
  });
  test("another search's, or no such choice: left alone", () => {
    const f = found();
    expect(withDetail(f, { id: 1, index: 0, choice: choice(null) })).toBe(false);
    expect(withDetail(f, { id: 2, index: 5, choice: choice(null) })).toBe(false);
    expect(withDetail(null, { id: 2, index: 0, choice: choice(null) })).toBe(false);
    expect(f.choices[0].saved).toBe('a');
  });
});
