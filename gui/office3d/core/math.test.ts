import { describe, expect, test } from 'vitest';
import { bump, clamp, ease, easeOutCubic, easeOutQuad, mix, seg, segLinear, smooth, wrap } from './math';

describe('blending', () => {
  test('clamp', () => {
    expect([clamp(-1, 0, 1), clamp(0.4, 0, 1), clamp(3, 0, 1)]).toEqual([0, 0.4, 1]);
  });
  test('mix', () => {
    expect([mix(2, 6, 0), mix(2, 6, 0.5), mix(2, 6, 1)]).toEqual([2, 4, 6]);
  });
  test('smooth is flat outside [0, 1] and eases inside', () => {
    expect([smooth(-1), smooth(0), smooth(0.5), smooth(1), smooth(2)]).toEqual([0, 0, 0.5, 1, 1]);
    expect(smooth(0.25)).toBeCloseTo(0.15625);
  });
});

describe('time', () => {
  test('ease: the share of the way covered this frame', () => {
    expect(ease(0, 5)).toBe(0);
    expect(ease(1 / 60, 5)).toBeCloseTo(1 - Math.exp(-5 / 60));
    // two half frames get as far as one whole one
    const half = ease(0.5, 3);
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(ease(1, 3));
  });
  test('easeOut, quadratic and cubic', () => {
    expect([easeOutQuad(0), easeOutQuad(0.5), easeOutQuad(1)]).toEqual([0, 0.75, 1]);
    expect([easeOutCubic(0), easeOutCubic(0.5), easeOutCubic(1)]).toEqual([0, 0.875, 1]);
  });
  test('seg eases from a to b, segLinear goes straight', () => {
    expect([seg(1, 2, 4), seg(3, 2, 4), seg(5, 2, 4)]).toEqual([0, 0.5, 1]);
    expect(seg(2.5, 2, 4)).toBeCloseTo(smooth(0.25));
    expect([segLinear(1, 2, 4), segLinear(2.5, 2, 4), segLinear(5, 2, 4)]).toEqual([0, 0.25, 1]);
  });
  test('bump: a hump between a and b', () => {
    expect([bump(1, 2, 4), bump(2, 2, 4), bump(4, 2, 4), bump(5, 2, 4)]).toEqual([0, 0, 0, 0]);
    expect(bump(3, 2, 4)).toBeCloseTo(1);
  });
});

test('wrap brings an angle into [-π, π]', () => {
  expect(wrap(3 * Math.PI)).toBeCloseTo(Math.PI);
  expect(wrap(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
  expect(wrap(0.3)).toBeCloseTo(0.3);
});
