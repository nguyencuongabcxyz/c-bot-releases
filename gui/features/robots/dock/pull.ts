// How far a docked chat's title bar is pulled off its edge before it's back at its desk.

/** How far the title bar is pulled off the edge to undock (CSS px). */
export const UNDOCK_PULL = 80;

/** Pulled this far (dx since the press) away from the edge it's docked on: far enough to undock? */
export function pulledOff(edge: 'left' | 'right', dx: number) {
  return edge === 'right' ? dx <= -UNDOCK_PULL : dx >= UNDOCK_PULL;
}
