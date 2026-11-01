// Where a tab dragged along the strip lands, and how far the others step aside for it.

/** The dragged tab's index once let go. `mids`: each tab's middle (x) before the drag, in order;
 *  `from`: the dragged one's index; `x`: its middle now. It passes a neighbour once its middle
 *  goes past the neighbour's. */
export function dropIndex(mids: number[], from: number, x: number): number {
  let to = from;
  while (to < mids.length - 1 && x > mids[to + 1]) to++;
  while (to > 0 && x < mids[to - 1]) to--;
  return to;
}

/** How far (px) each of `n` tabs moves to make room while the one at `from` is held over `to`
 *  (`width`: the held tab's width and the gap after it). The held tab's own is 0: it follows the
 *  pointer. */
export function makeRoom(n: number, from: number, to: number, width: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    if (from < to && i > from && i <= to) return -width;
    if (to < from && i >= to && i < from) return width;
    return 0;
  });
}
