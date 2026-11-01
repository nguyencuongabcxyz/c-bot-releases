// Tabs dragged into another order: the held tab follows the pointer along the strip, the others
// step aside for it, and where it was let go is told to tabs.ts (which tells main).
import { onDrag } from '@/lib/drag';
import { clamp } from '@/lib/math';
import { dropIndex, makeRoom } from './order';

/** What a tab drag needs: the strip, and what to do when one is let go (`to`: its new index). */
export type TabDragNeeds = {
  readonly strip: HTMLElement;
  readonly dropped: (id: string, to: number) => void;
};

export function createTabDrag(n: TabDragNeeds) {
  let dragging = false;

  /** Let this tab (just drawn in the strip) be dragged to another place. */
  function draggable(tab: HTMLElement, id: string) {
    onDrag(
      tab,
      (e) => {
        if ((e.target as Element).closest('button, input')) return; // (its star, its ×, renaming)
        const tabs = [...n.strip.querySelectorAll<HTMLElement>('.tab')];
        const from = tabs.indexOf(tab);
        if (from < 0 || tabs.length < 2) return;
        const rects = tabs.map((t) => t.getBoundingClientRect());
        const mids = rects.map((r) => r.left + r.width / 2);
        const own = rects[from];
        const width = own.width + (Number.parseFloat(getComputedStyle(n.strip).columnGap) || 0);
        // (it stays within the strip's tabs)
        const [lo, hi] = [rects[0].left - own.left, rects[rects.length - 1].right - own.right];
        let to = from;
        return {
          begin: () => {
            dragging = true;
            tab.classList.add('dragging');
            n.strip.classList.add('reordering');
          },
          move: ({ dx }) => {
            const x = clamp(dx, lo, hi);
            tab.style.transform = `translateX(${x}px)`;
            to = dropIndex(mids, from, mids[from] + x);
            makeRoom(tabs.length, from, to, width).forEach((s, i) => {
              if (i !== from) tabs[i].style.transform = s ? `translateX(${s}px)` : '';
            });
          },
          end: ({ moved, letGo }) => {
            if (!moved) return;
            dragging = false;
            n.strip.classList.remove('reordering');
            n.dropped(id, letGo ? to : from); // (taken away: back where it was)
          },
        };
      },
      { threshold: 5 },
    );
  }

  return {
    draggable,
    /** A tab is held: the strip isn't redrawn under it until it's let go. */
    get dragging() {
      return dragging;
    },
  };
}
