import { expect, test } from 'vitest';
import { pick, rand } from './random';

test('pick: always one of them', () => {
  const list = ['a', 'b', 'c'] as const;
  for (let i = 0; i < 50; i++) expect(list).toContain(pick(list));
});

test('rand: from a up to b', () => {
  for (let i = 0; i < 50; i++) {
    const x = rand(2, 5);
    expect(x).toBeGreaterThanOrEqual(2);
    expect(x).toBeLessThan(5);
  }
});
