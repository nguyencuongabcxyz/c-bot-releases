// A tab's right-click menu: close it, the others, or all of them.
import { $, el } from '@/lib/dom';
import { Icon } from '@/icons/icons';

/** What the menu needs of tabs.ts: the tabs' ids in strip order, and closing them. */
export type TabMenuNeeds = {
  readonly order: () => string[];
  readonly closeTab: (id: string) => void;
  readonly closeTabs: (ids: string[]) => void;
};

type Item = { icon: string; label: string; hint?: string; off?: boolean; pick: () => void };

export function createTabMenu(n: TabMenuNeeds) {
  const panel = $('#panel');
  const menu = el('div');
  menu.id = 'tab-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  panel.appendChild(menu);
  let open: AbortController | null = null;

  function hide() {
    menu.hidden = true;
    open?.abort();
    open = null;
  }

  function item({ icon, label, hint, off, pick }: Item) {
    const row = el('div', `menu-item has-icon${off ? ' off' : ''}`);
    row.setAttribute('role', 'menuitem');
    row.setAttribute('aria-disabled', String(!!off));
    row.innerHTML = `${Icon(icon)}<b></b>${hint ? '<small></small>' : ''}`;
    $('b', row).textContent = label;
    if (hint) $('small', row).textContent = hint;
    if (!off)
      row.addEventListener('click', () => {
        hide();
        pick();
      });
    return row;
  }

  /** Open the menu for tab `id`, where it was right-clicked. */
  function show(id: string, e: MouseEvent) {
    e.preventDefault();
    hide();
    const all = n.order();
    const others = all.filter((x) => x !== id);
    menu.replaceChildren(
      item({ icon: 'x', label: 'Close tab', hint: 'Ctrl+W', pick: () => n.closeTab(id) }),
      item({ icon: 'tabs', label: 'Close other tabs', off: !others.length, pick: () => n.closeTabs(others) }),
      item({ icon: 'reset', label: 'Close all tabs', pick: () => n.closeTabs(all) }),
    );
    menu.hidden = false;
    const box = panel.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(e.clientX - box.left, box.width - menu.offsetWidth - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(e.clientY - box.top, box.height - menu.offsetHeight - 6))}px`;
    open = new AbortController();
    const { signal } = open;
    document.addEventListener(
      'mousedown',
      (ev) => {
        if (!menu.contains(ev.target as Node)) hide();
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

  return { show };
}
