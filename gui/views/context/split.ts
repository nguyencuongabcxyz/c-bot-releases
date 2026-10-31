// A divider between two panes of the Context engine window: dragged, it sets the first pane's
// share of their box (`--split`, which the box's grid uses), remembered for next time; a
// double-click puts it back. `x`: side by side; `y`: one above the other.
import { el } from '@/lib/dom';
import { onDrag } from '@/lib/drag';

const MIN = 0.15;
const MAX = 0.85;

/** The first pane's share after a drag of `delta` px across a box `size` px long, from `start`
 * (never so far that either pane is squeezed out). */
export function shareAt(start: number, delta: number, size: number): number {
  if (size <= 0) return start;
  return Math.max(MIN, Math.min(MAX, start + delta / size));
}

/** A divider for `box`, its share kept under `key` (`start` till it's moved). */
export function splitter(box: HTMLElement, key: string, start: number, axis: 'x' | 'y' = 'x'): HTMLElement {
  const bar = el('div', `split split-${axis}`);
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  let share = start;
  try {
    const saved = Number(localStorage.getItem(key));
    if (saved >= MIN && saved <= MAX) share = saved;
  } catch {}
  const set = (s: number) => {
    share = s;
    box.style.setProperty('--split', String(s));
  };
  set(share);
  const keep = () => {
    try {
      localStorage.setItem(key, String(share));
    } catch {}
  };
  onDrag(bar, () => {
    const from = share;
    const size = axis === 'x' ? box.clientWidth : box.clientHeight;
    box.classList.add('dragging');
    return {
      move: (d) => set(shareAt(from, axis === 'x' ? d.dx : d.dy, size)),
      end: () => {
        box.classList.remove('dragging');
        keep();
      },
    };
  });
  bar.addEventListener('dblclick', () => {
    set(start);
    keep();
  });
  return bar;
}
