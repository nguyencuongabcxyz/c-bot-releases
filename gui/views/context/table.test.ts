import { describe, expect, it } from 'vitest';
import { stepTo } from './table';

describe('the keys move the row picked', () => {
  it('one up or down, staying in the table', () => {
    expect(stepTo('ArrowDown', 3, 10, 5)).toBe(4);
    expect(stepTo('ArrowDown', 9, 10, 5)).toBe(9);
    expect(stepTo('ArrowUp', 0, 10, 5)).toBe(0);
    expect(stepTo('ArrowUp', 4, 10, 5)).toBe(3);
  });
  it('from nothing picked, to the first', () => {
    expect(stepTo('ArrowDown', -1, 10, 5)).toBe(0);
    expect(stepTo('ArrowUp', -1, 10, 5)).toBe(0);
  });
  it('a page at a time, or to either end', () => {
    expect(stepTo('PageDown', 2, 10, 5)).toBe(7);
    expect(stepTo('PageDown', 7, 10, 5)).toBe(9);
    expect(stepTo('PageUp', 2, 10, 5)).toBe(0);
    expect(stepTo('Home', 6, 10, 5)).toBe(0);
    expect(stepTo('End', 0, 10, 5)).toBe(9);
  });
  it('leaves the other keys alone', () => {
    expect(stepTo('a', 2, 10, 5)).toBeNull();
  });
});
