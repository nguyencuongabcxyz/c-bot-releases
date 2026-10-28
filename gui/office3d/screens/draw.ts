// What the monitor scenes draw with: the background, lines of text or code as they type in, and
// repeatable noise.
import { SCREEN_W, SCREEN_H } from '@/office3d/core/constants';

export const pageWidths = [0.7, 0.85, 0.5, 0.78, 0.4, 0.82, 0.62];

export function bg(ctx: CanvasRenderingContext2D, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
}

/** Lines of text, as grey bars (scrolled up by `offset` px). */
export type LinesOpts = {
  x: number;
  y: number;
  gap: number;
  height: number;
  color: string;
  offset?: number;
  count?: number;
  widths?: number[];
  maxW?: number;
};
export function lines(
  ctx: CanvasRenderingContext2D,
  { x, y, gap, height, color, offset = 0, count = 12, widths = pageWidths, maxW = 240 }: LinesOpts,
) {
  ctx.fillStyle = color;
  for (let i = -1; i < count; i++) {
    const yy = y + i * gap - (offset % (gap * widths.length));
    const idx = ((i % widths.length) + widths.length) % widths.length;
    ctx.fillRect(x, yy, maxW * widths[idx], height);
  }
}

// ---- helpers for the dream screens

// a cheap repeatable "random" number in [0, 1) for a pair of integers
export function hash(a: number, b: number) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
