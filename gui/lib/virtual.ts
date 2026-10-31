// A long list that draws only the rows in view (and a few either side), so thousands of rows
// scroll as smoothly as ten: every row is the same height, a spacer gives the scrollbar the
// whole list's height, and the rows drawn sit where they belong in it. They're drawn again as it
// scrolls (once a frame at most) and when it changes size.
import { el } from './dom';

/** The rows to draw, [from, to), for a scroll position: those in view and `extra` either side. */
export function visibleRange(
  top: number,
  height: number,
  rowHeight: number,
  count: number,
  extra = 8,
): { from: number; to: number } {
  if (count <= 0 || rowHeight <= 0) return { from: 0, to: 0 };
  const first = Math.floor(Math.max(0, top) / rowHeight);
  const shown = Math.ceil(Math.max(0, height) / rowHeight) + 1;
  return { from: Math.max(0, first - extra), to: Math.min(count, first + shown + extra) };
}

/** The list in `scroller` (which scrolls; the list is all it holds). */
export type VirtualList = {
  /** How many rows there are now (the ones drawn are drawn again). */
  setCount: (n: number) => void;
  /** Every row in view drawn again (what they show changed). */
  redraw: () => void;
  /** Row `i` scrolled into view. */
  reveal: (i: number) => void;
};

/** A list of rows `rowHeight` px high, each made by `draw` as it comes into view. */
export function virtualList(scroller: HTMLElement, rowHeight: number, draw: (i: number) => HTMLElement): VirtualList {
  const space = el('div', 'vl-space');
  const rows = el('div', 'vl-rows');
  space.style.position = 'relative';
  rows.style.position = 'absolute';
  rows.style.inset = '0 0 auto 0';
  space.append(rows);
  scroller.replaceChildren(space);
  let count = 0;
  let drawn = { from: -1, to: -1 };
  let frame = 0;

  function paint(force: boolean) {
    frame = 0;
    const r = visibleRange(scroller.scrollTop, scroller.clientHeight, rowHeight, count);
    if (!force && r.from === drawn.from && r.to === drawn.to) return;
    drawn = r;
    rows.style.transform = `translateY(${r.from * rowHeight}px)`;
    const made: HTMLElement[] = [];
    for (let i = r.from; i < r.to; i++) {
      const row = draw(i);
      row.style.height = `${rowHeight}px`;
      made.push(row);
    }
    rows.replaceChildren(...made);
  }
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(() => paint(false));
  };
  scroller.addEventListener('scroll', soon, { passive: true });
  new ResizeObserver(soon).observe(scroller);

  return {
    setCount(n) {
      count = n;
      space.style.height = `${n * rowHeight}px`;
      paint(true);
    },
    redraw: () => paint(true),
    reveal(i) {
      const top = i * rowHeight;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = top + rowHeight - scroller.clientHeight;
    },
  };
}
