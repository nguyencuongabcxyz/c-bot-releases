import { describe, expect, it } from 'vitest';
import { dropIndex, makeRoom } from './order';

const mids = [50, 150, 250, 350];

describe('dropIndex', () => {
  it('stays put until it passes a neighbour’s middle', () => {
    expect(dropIndex(mids, 1, 150)).toBe(1);
    expect(dropIndex(mids, 1, 249)).toBe(1);
    expect(dropIndex(mids, 1, 51)).toBe(1);
  });
  it('moves right past each middle it crosses', () => {
    expect(dropIndex(mids, 1, 251)).toBe(2);
    expect(dropIndex(mids, 0, 351)).toBe(3);
    expect(dropIndex(mids, 0, 9999)).toBe(3);
  });
  it('moves left past each middle it crosses', () => {
    expect(dropIndex(mids, 3, 249)).toBe(2);
    expect(dropIndex(mids, 3, 49)).toBe(0);
    expect(dropIndex(mids, 2, -9999)).toBe(0);
  });
  it('has nowhere to go alone', () => {
    expect(dropIndex([50], 0, 500)).toBe(0);
  });
});

describe('makeRoom', () => {
  it('moves nothing when held over its own place', () => {
    expect(makeRoom(4, 1, 1, 100)).toEqual([0, 0, 0, 0]);
  });
  it('steps the passed tabs left when it goes right', () => {
    expect(makeRoom(4, 0, 2, 100)).toEqual([0, -100, -100, 0]);
  });
  it('steps the passed tabs right when it goes left', () => {
    expect(makeRoom(4, 3, 1, 100)).toEqual([0, 100, 100, 0]);
  });
});
