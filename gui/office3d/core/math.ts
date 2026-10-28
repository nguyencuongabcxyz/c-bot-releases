// The little numbers every part of the office animates with: blending, easing, angles.
// (Plain functions rather than THREE.MathUtils at each call: these are the exact formulas the
// scenes were tuned with, and the calls stay short.)

/** x kept within [a, b] (the pages' own, @/lib/math). */
export { clamp } from '@/lib/math';

/** From a to b by k (0: a, 1: b). */
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Smoothstep on [0, 1]: eases in and out, flat outside. */
export const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** An angle brought back into [-π, π]. */
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** How much of the way to go this frame, to approach at `rate` whatever the frame rate. */
export const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

/** Fast then slow (quadratic). */
export const easeOutQuad = (x: number) => 1 - (1 - x) * (1 - x);

/** Fast then slow (cubic). */
export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

/** 0 before a, 1 after b, eased in between (s: seconds into an antic). */
export const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a));

/** 0 before a, 1 after b, straight in between. */
export const segLinear = (s: number, a: number, b: number) => Math.min(1, Math.max(0, (s - a) / (b - a)));

/** A sine hump from a to b: 0 outside, 1 in the middle. */
export const bump = (s: number, a: number, b: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
