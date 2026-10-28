// Dragging with the mouse, the same way everywhere: the press, the moves and the let-go, the
// pointer held for the whole drag, and every listener gone after it.

/** Where a drag has got to. `dx`/`dy` are from the press, in screen px: right even while main
 *  moves the window under it. `moved`: past the threshold yet (a press that never gets there is
 *  a click). `e` is the event (the let-go's in `end`). */
export type DragAt = { dx: number; dy: number; moved: boolean; e: PointerEvent };

/** How a drag ended: `letGo` when the button came up, not when it was taken away (cancelled, or
 *  another window grabbed the mouse). Only a press let go without moving is a click. */
export type DragEnd = DragAt & { letGo: boolean };

/** What a drag does: `begin` once, as it first moves past the threshold, then `move` for every
 *  move after that; `end` when it's over. */
export type Drag = {
  begin?: (d: DragAt) => void;
  move?: (d: DragAt) => void;
  end?: (d: DragEnd) => void;
};

/** Drags that start on `el` with the left button. `start` gets the press and says what this drag
 *  does, or nothing to leave the press alone. `threshold`: how far (px) it travels before it
 *  counts as moved. */
export function onDrag(el: HTMLElement, start: (e: PointerEvent) => Drag | undefined, { threshold = 0 } = {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const drag = start(e);
    if (!drag) return;
    el.setPointerCapture(e.pointerId);
    const [x0, y0] = [e.screenX, e.screenY];
    let moved = false;
    const at = (ev: PointerEvent): DragAt => ({ dx: ev.screenX - x0, dy: ev.screenY - y0, moved, e: ev });
    const done = new AbortController();
    const { signal } = done;
    el.addEventListener(
      'pointermove',
      (ev) => {
        if (!moved) {
          if (Math.hypot(ev.screenX - x0, ev.screenY - y0) < threshold) return;
          moved = true;
          drag.begin?.(at(ev));
        }
        drag.move?.(at(ev));
      },
      { signal },
    );
    const end = (ev: PointerEvent) => {
      done.abort(); // (only once: the let-go is followed by losing the pointer)
      drag.end?.({ ...at(ev), letGo: ev.type === 'pointerup' });
    };
    for (const k of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      el.addEventListener(k, end, { signal });
  });
}
