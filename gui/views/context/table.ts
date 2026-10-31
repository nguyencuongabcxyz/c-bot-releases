// A table for the Context engine window's long lists (files, definitions, chunks): its header
// (a column that sorts is a button, with an arrow for the way it's sorted), and its rows drawn
// only as they come into view (lib/virtual.ts), all the same height. A row clicked is picked;
// with the table focused, the arrows, Page Up/Down, Home and End pick the row they go to.
import { el } from '@/lib/dom';
import { type VirtualList, virtualList } from '@/lib/virtual';

/** A column: its key, its heading, its width (a grid track), whether it holds numbers (right
 * aligned), whether it sorts, and whether it goes while the table is compact (short of room). */
export type Column<K extends string> = {
  key: K;
  label: string;
  width: string;
  num?: boolean;
  sorts?: boolean;
  spare?: boolean;
};

export type TableOpts<K extends string> = {
  readonly columns: Column<K>[];
  readonly rowHeight: number;
  /** What row `i` shows in a column. */
  readonly cell: (i: number, key: K) => string | Node;
  /** The row picked now (-1: none). */
  readonly current?: () => number;
  readonly onPick?: (i: number) => void;
  readonly onSort?: (key: K) => void;
};

/** The row a key goes to from row `now` (-1: none yet) of `count`, `page` rows a page; null: a
 * key that doesn't move. */
export function stepTo(key: string, now: number, count: number, page: number): number | null {
  const last = count - 1;
  const clamp = (i: number) => Math.max(0, Math.min(last, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(now + 1);
    case 'ArrowUp':
      return now < 0 ? 0 : clamp(now - 1);
    case 'PageDown':
      return clamp(now + page);
    case 'PageUp':
      return clamp(now - page);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

export function createTable<K extends string>(o: TableOpts<K>) {
  const root = el('div', 'vt');
  const cls = (c: Column<K>) => `${c.num ? ' num' : ''}${c.spare ? ' spare' : ''}`;
  root.style.setProperty('--cols-all', o.columns.map((c) => c.width).join(' '));
  root.style.setProperty(
    '--cols-compact',
    o.columns
      .filter((c) => !c.spare)
      .map((c) => c.width)
      .join(' '),
  );
  const head = el('div', 'vt-head');
  const heads = new Map<K, HTMLElement>();
  for (const c of o.columns) {
    const th = el(c.sorts ? 'button' : 'div', `vt-th${cls(c)}`, c.label);
    if (th instanceof HTMLButtonElement) {
      th.type = 'button';
      th.addEventListener('click', () => o.onSort?.(c.key));
    }
    heads.set(c.key, th);
    head.append(th);
  }
  const body = el('div', 'vt-body');
  const empty = el('p', 'vt-empty');
  empty.hidden = true;
  root.append(head, body, empty);

  const list: VirtualList = virtualList(body, o.rowHeight, (i) => {
    const row = el('div', `vt-row${o.current?.() === i ? ' on' : ''}`);
    row.dataset.i = String(i);
    for (const c of o.columns) {
      const td = el('div', `vt-td${cls(c)}`);
      const v = o.cell(i, c.key);
      if (typeof v === 'string') td.textContent = v;
      else td.append(v);
      row.append(td);
    }
    return row;
  });
  let count = 0;
  const pick = (i: number) => {
    o.onPick?.(i);
    list.reveal(i);
  };
  body.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.vt-row');
    if (row?.dataset.i) pick(Number(row.dataset.i));
  });
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (!count || !o.onPick) return;
    const now = o.current?.() ?? -1;
    const page = Math.max(1, Math.floor(body.clientHeight / o.rowHeight) - 1);
    const to = stepTo(e.key, now, count, page);
    if (to === null) return;
    e.preventDefault();
    if (to !== now) pick(to);
  });

  return {
    root,
    /** How many rows there are (none: `nothing` says so). */
    setCount(n: number, nothing = 'Nothing here.') {
      count = n;
      empty.hidden = n > 0;
      empty.textContent = nothing;
      list.setCount(n);
    },
    redraw: list.redraw,
    reveal: list.reveal,
    /** Short of room: the spare columns go. */
    compact(on: boolean) {
      root.classList.toggle('compact', on);
    },
    /** Back at the top (a list of something else). */
    top() {
      body.scrollTop = 0;
    },
    /** Which column it's sorted by, and which way. */
    setOrder(key: K, desc: boolean) {
      for (const [k, th] of heads) {
        th.classList.toggle('sorted', k === key);
        th.classList.toggle('desc', k === key && desc);
      }
    },
  };
}
export type Table<K extends string> = ReturnType<typeof createTable<K>>;
