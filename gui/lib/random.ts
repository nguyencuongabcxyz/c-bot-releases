// A little randomness, for the robots' antics and lines.

/** One of them, any one. */
export const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];

/** A number from a up to b. */
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
