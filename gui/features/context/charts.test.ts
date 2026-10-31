import { describe, expect, it } from 'vitest';
import { shares } from './charts';

describe('a whole cut into its parts', () => {
  it('puts the biggest first, each with its share and its tone', () => {
    const got = shares([
      { name: 'Go', value: 1 },
      { name: 'Rust', value: 3 },
    ]);
    expect(got).toEqual([
      { name: 'Rust', value: 3, pct: 75, tone: 0 },
      { name: 'Go', value: 1, pct: 25, tone: 1 },
    ]);
  });
  it('gathers the smallest into one muted Other past the most it shows', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ name, value: 10 - i }));
    const got = shares(items, 4);
    expect(got.map((s) => s.name)).toEqual(['a', 'b', 'c', 'Other']);
    expect(got[3]).toMatchObject({ value: 7 + 6 + 5, tone: 5 });
    expect(got.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100);
  });
  it('leaves out what has no value, and has nothing of nothing', () => {
    expect(shares([{ name: 'a', value: 0 }])).toEqual([]);
    expect(
      shares([
        { name: 'a', value: 2 },
        { name: 'b', value: 0 },
      ]).map((s) => s.name),
    ).toEqual(['a']);
  });
});
