// Tab groups: a tab another one opened for a job (open_tab: app/src/features/chat/peers.rs) is in
// its group, and the strip folds a group into one chip (its name, a dot per tab, how many), so a
// group takes the room of one tab. Click the chip: its tabs drop down, each with what it's doing.
// Unfolded, its tabs sit side by side after a short label; click the label to fold them again.
import { $, el } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { ChatTab } from '@/views/robot/types';

/** A tab's state, as its dot shows it. */
export type TabStatus = 'terminal' | 'question' | 'busy' | 'helpers' | ChatTab['status'];

/** One place in the strip: a tab of its own, or a group (its tabs, in strip order). */
export type Run = { kind: 'tab'; id: string } | { kind: 'group'; group: string; ids: string[] };

/** The strip's places, from its tabs in order: a group where its first tab is (a group of one
 *  is a tab of its own). */
export function runs(tabs: { id: string; group?: string | null }[]): Run[] {
  const members = new Map<string, string[]>();
  for (const t of tabs) if (t.group) members.set(t.group, [...(members.get(t.group) ?? []), t.id]);
  const placed = new Set<string>();
  const out: Run[] = [];
  for (const t of tabs) {
    const ids = t.group ? (members.get(t.group) ?? []) : [];
    if (!t.group || ids.length < 2) out.push({ kind: 'tab', id: t.id });
    else if (!placed.has(t.group)) {
      placed.add(t.group);
      out.push({ kind: 'group', group: t.group, ids });
    }
  }
  return out;
}

/** The tabs' order once the strip's place `from` is dragged to `to`: each place holds the tabs
 *  it stands for (a folded group, all of its). */
export function dragOrder(places: string[][], from: number, to: number): string[] {
  const next = [...places];
  next.splice(to, 0, ...next.splice(from, 1));
  return next.flat();
}

/** What groups need of tabs.ts: the tabs, which is shown, their states, switching, and taking a
 *  group apart. */
export type TabGroupsNeeds = {
  readonly tabs: Map<string, ChatTab>;
  readonly activeId: () => string | null;
  readonly statusOf: (t: ChatTab) => TabStatus;
  readonly statusLabel: Record<TabStatus, string>;
  readonly activate: (id: string) => void;
  readonly redraw: () => void;
  readonly ungroup: (group: string) => void;
};

export function createTabGroups(n: TabGroupsNeeds) {
  const unfolded = new Set<string>(); // (folded unless you unfold one)
  const panel = $('#panel');
  const list = el('div');
  list.id = 'tab-group-list';
  list.setAttribute('role', 'menu');
  list.hidden = true;
  panel.appendChild(list);
  let open: AbortController | null = null;

  const titleOf = (id: string) => n.tabs.get(id)?.title ?? '';
  const short = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);

  function dots(ids: string[]) {
    const row = el('span', 'tab-group-dots');
    for (const id of ids) {
      const t = n.tabs.get(id);
      if (t) row.appendChild(el('i', `s-${n.statusOf(t)}`));
    }
    return row;
  }

  /** A folded group: one chip, named for the tab of it you're in (else its first). */
  function chip(group: string, ids: string[]) {
    const active = n.activeId();
    const on = active !== null && ids.includes(active);
    const c = el('div', `tab tab-group${on ? ' on' : ''}`);
    c.dataset.ids = ids.join(' ');
    c.setAttribute('role', 'tab');
    c.setAttribute('aria-selected', String(on));
    c.setAttribute('aria-haspopup', 'menu');
    c.title = 'Tab group';
    c.innerHTML = Icon('right', 'sm tab-group-caret');
    c.append(
      el('span', 'tab-title', titleOf(on && active ? active : ids[0])),
      dots(ids),
      el('span', 'tab-group-count', String(ids.length)),
    );
    c.addEventListener('click', () => (list.hidden ? showList(group, ids, c) : hide()));
    return c;
  }

  /** An unfolded group's label, before its tabs: click it to fold them. */
  function label(group: string, ids: string[]) {
    const b = el('button', 'tab-group-label');
    b.type = 'button';
    b.title = 'Fold group';
    b.innerHTML = Icon('down', 'sm');
    b.append(short(titleOf(ids[0])));
    b.addEventListener('click', () => {
      unfolded.delete(group);
      n.redraw();
    });
    return b;
  }

  function hide() {
    list.hidden = true;
    open?.abort();
    open = null;
  }

  function item(icon: string, text: string, pick: () => void) {
    const row = el('div', 'menu-item has-icon');
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `${Icon(icon)}<b></b>`;
    $('b', row).textContent = text;
    row.addEventListener('click', () => {
      hide();
      pick();
    });
    return row;
  }

  /** The group's tabs, under its chip: what each is doing; click one to go to it. */
  function showList(group: string, ids: string[], anchor: HTMLElement) {
    hide();
    const rows = ids.flatMap((id) => {
      const t = n.tabs.get(id);
      if (!t) return [];
      const s = n.statusOf(t);
      const row = el('div', `menu-item tab-group-row${id === n.activeId() ? ' on' : ''}`);
      row.setAttribute('role', 'menuitem');
      row.append(el('i', `s-${s}`), el('b', '', t.title), el('small', '', n.statusLabel[s]));
      row.addEventListener('click', () => {
        hide();
        n.activate(id);
      });
      return [row];
    });
    const unfold = item('tabs', 'Unfold in the strip', () => {
      unfolded.add(group);
      n.redraw();
    });
    const apart = item('x', 'Ungroup', () => n.ungroup(group));
    list.replaceChildren(...rows, el('div', 'tab-group-sep'), unfold, apart);
    list.hidden = false;
    const box = panel.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    list.style.left = `${Math.max(6, Math.min(at.left - box.left, box.width - list.offsetWidth - 6))}px`;
    list.style.top = `${at.bottom - box.top + 4}px`;
    open = new AbortController();
    const { signal } = open;
    document.addEventListener(
      'mousedown',
      (ev) => {
        const t = ev.target as Node;
        if (!list.contains(t) && !(t instanceof Element && t.closest('.tab-group'))) hide();
      },
      { signal },
    );
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape') return;
        ev.stopPropagation();
        hide();
      },
      { signal, capture: true },
    );
    window.addEventListener('blur', hide, { signal });
  }

  return { chip, label, isOpen: (group: string) => unfolded.has(group) };
}
