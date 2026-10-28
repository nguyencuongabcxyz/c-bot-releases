// Numbers kept in bounds (the pages, and the 3D office: office3d/core/math.ts).

/** x kept within [a, b]. */
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
