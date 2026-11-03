import { describe, expect, test } from 'vitest';
import type { FindChoice } from '@/types/pages';
import { saveState } from './choices';

const choice = (saved: string | null): FindChoice => ({
  word: 'meticulous',
  ipa: '',
  pos: 'adj',
  feel: 'positive',
  tone: 'praise',
  vi: 'tỉ mỉ',
  en: '',
  example: '',
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
