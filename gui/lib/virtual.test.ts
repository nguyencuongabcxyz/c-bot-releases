import { describe, expect, it } from 'vitest';
import { visibleRange } from './virtual';

describe('a long list draws only the rows in view', () => {
  it('draws the rows in view and a few either side', () => {
    expect(visibleRange(0, 300, 30, 1000, 5)).toEqual({ from: 0, to: 16 });
    expect(visibleRange(3000, 300, 30, 1000, 5)).toEqual({ from: 95, to: 116 });
  });
  it('stops at the end of the list', () => {
    expect(visibleRange(29_900, 300, 30, 1000, 5)).toEqual({ from: 991, to: 1000 });
    expect(visibleRange(0, 300, 30, 4)).toEqual({ from: 0, to: 4 });
  });
  it('draws nothing of nothing', () => {
    expect(visibleRange(0, 300, 30, 0)).toEqual({ from: 0, to: 0 });
    expect(visibleRange(-50, 300, 30, 10, 0)).toEqual({ from: 0, to: 10 });
  });
});
