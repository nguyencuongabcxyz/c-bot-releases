import { describe, expect, it } from 'vitest';
import { outlineCache, UNUSED_FRAMES } from './outline';

describe('outlineCache', () => {
  const setup = () => {
    const disposed: number[] = [];
    let made = 0;
    const cache = outlineCache<string, number>(
      () => ++made,
      (m) => disposed.push(m),
    );
    return { cache, disposed, made: () => made };
  };

  it('makes one outline per material and reuses it', () => {
    const { cache, made } = setup();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(made()).toBe(2);
  });

  it('keeps an outline drawn every frame', () => {
    const { cache, disposed } = setup();
    for (let i = 0; i < UNUSED_FRAMES * 3; i++) {
      cache.get('a');
      cache.sweep();
    }
    expect(cache.size).toBe(1);
    expect(disposed).toEqual([]);
  });

  it('forgets and disposes the outlines of objects gone from the scene', () => {
    const { cache, disposed } = setup();
    for (let n = 0; n < 500; n++) {
      cache.get(`prop-${n}`); // (an antic's prop, drawn once and gone)
      cache.sweep();
    }
    for (let i = 0; i <= UNUSED_FRAMES; i++) cache.sweep();
    expect(cache.size).toBe(0);
    expect(disposed).toHaveLength(500);
  });

  it('keeps one kept alive', () => {
    const { cache, disposed } = setup();
    cache.get('a');
    cache.keepAlive('a', true);
    for (let i = 0; i <= UNUSED_FRAMES + 5; i++) cache.sweep();
    expect(cache.size).toBe(1);
    expect(disposed).toEqual([]);
  });
});
