import { describe, expect, it } from 'vitest';
import { pulledOff, UNDOCK_PULL } from './pull';

describe('pulledOff', () => {
  it('undocks once the title bar is pulled far enough away from its edge', () => {
    expect(pulledOff('right', -UNDOCK_PULL)).toBe(true);
    expect(pulledOff('right', -UNDOCK_PULL + 1)).toBe(false);
    expect(pulledOff('left', UNDOCK_PULL)).toBe(true);
    expect(pulledOff('left', UNDOCK_PULL - 1)).toBe(false);
  });

  it('not when pulled toward the edge', () => {
    expect(pulledOff('right', 200)).toBe(false);
    expect(pulledOff('left', -200)).toBe(false);
  });
});
