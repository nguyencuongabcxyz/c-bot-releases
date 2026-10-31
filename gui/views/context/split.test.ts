import { describe, expect, it } from 'vitest';
import { shareAt } from './split';

describe('a divider dragged', () => {
  it('moves the share by the part of the box dragged across', () => {
    expect(shareAt(0.5, 100, 1000)).toBeCloseTo(0.6);
    expect(shareAt(0.5, -250, 1000)).toBeCloseTo(0.25);
  });
  it('never squeezes either pane out', () => {
    expect(shareAt(0.5, 900, 1000)).toBe(0.85);
    expect(shareAt(0.5, -900, 1000)).toBe(0.15);
  });
  it('stays put in a box of no size', () => {
    expect(shareAt(0.4, 50, 0)).toBe(0.4);
  });
});
