// The saved chats' list, dropped down from the chat's title bar (🔖, Ctrl+O): type to find one,
// Enter or a click opens it; each can be renamed or unsaved where it is.
import { $, el, iconButton } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { SavedRow } from '@/types/model';
import * as ipc from '@/ipc';
import { findSaved, savedLine } from './match';

export const SavedPicker = ({
  onOpen,
  onAll,
}: {
  /** Open this one (in its tab, or resumed in a new one). */
  onOpen: (s: SavedRow) => void;
  /** "All past chats": the Past chats view. */
  onAll: () => void;
}) => {
  // (its elements: always in the chat's markup, robot/robot.html)
  const root = $('#saved-pop');
  const search = $<HTMLInputElement>('#sv-search');
  const list = $('#sv-list');
  const button = $('#btn-saved');
  let rows: SavedRow[] = [];
  let shown: SavedRow[] = [];
  let sel = 0;
  let renaming: string | null = null; // (the one whose name is being typed)
  let listening: AbortController | null = null;

  function render() {
    shown = findSaved(rows, search.value);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    if (!shown.length) {
      list.appendChild(
        el(
          'p',
          'sv-empty',
          rows.length
            ? `Nothing saved matches “${search.value.trim()}”.`
            : 'Nothing saved yet. Star a tab (or press Ctrl+S) to keep its chat here.',
        ),
      );
      return;
    }
    list.append(...shown.map(row));
  }

  function row(s: SavedRow, i: number) {
    const item = el('div', `sv-item${i === sel ? ' sel' : ''}${s.gone ? ' gone' : ''}`);
    const face = el('span', 'sv-emoji', s.emoji);
    if (!s.emoji) face.innerHTML = Icon('star', 'sm');
    const text = el('div', 'sv-text');
    if (renaming === s.id) text.appendChild(nameField(s));
    else text.appendChild(el('div', 'sv-name', s.name));
    text.appendChild(el('div', 'sv-sub', savedLine(s)));
    // (Alt+1…9 open the first nine as saved, whatever the search shows)
    const n = rows.indexOf(s) + 1;
    const key = el('span', 'sv-key', n <= 9 ? `Alt ${n}` : '');
    const edit = iconButton('sv-act', 'Rename', 'edit');
    const drop = iconButton('sv-act', 'Unsave', 'x');
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      renaming = s.id;
      render();
    });
    drop.addEventListener('click', async (e) => {
      e.stopPropagation();
      changed(await ipc.robotUnsave(s.id));
    });
    item.append(face, text, key, edit, drop);
    item.title = s.title && s.title !== s.name ? s.title : '';
    item.addEventListener('click', () => renaming !== s.id && pick(s));
    item.addEventListener('pointerenter', () => {
      sel = i;
      for (const it of list.querySelectorAll('.sv-item')) it.classList.toggle('sel', it === item);
    });
    return item;
  }

  function nameField(s: SavedRow) {
    const field = el('input', 'sv-rename');
    field.type = 'text';
    field.maxLength = 60;
    field.value = s.name;
    field.setAttribute('aria-label', 'Name');
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = field.value.trim();
      if (keep && name && name !== s.name) {
        changed(await ipc.robotSave({ sessionId: s.id, name, emoji: s.emoji }));
      } else render();
      search.focus();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation(); // (its own Enter and Esc, not the list's)
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    field.addEventListener('blur', () => finish(true));
    setTimeout(() => {
      field.focus();
      field.select();
    });
    return field;
  }

  function changed(next: SavedRow[]) {
    rows = next; // (main sends the robot again too: the tabs' stars follow)
    render();
  }

  function pick(s: SavedRow) {
    close();
    onOpen(s);
  }

  /** The `n`th saved chat (1…9), as Alt+n opens it. */
  async function nth(n: number) {
    const all = root.hidden ? await ipc.robotSaved() : rows;
    const s = all[n - 1];
    if (s) pick(s);
  }

  async function open(query = '') {
    root.hidden = false;
    button.classList.add('on');
    search.value = query;
    sel = 0;
    renaming = null;
    search.focus();
    rows = await ipc.robotSaved();
    if (!root.hidden) render();
    listening?.abort();
    listening = new AbortController();
    const { signal } = listening;
    // (a click outside it, or Esc: it closes)
    document.addEventListener(
      'pointerdown',
      (e) => root.contains(e.target as Node) || button.contains(e.target as Node) || close(),
      { signal },
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || root.hidden) return;
        e.stopPropagation(); // (Esc puts the robot to sleep otherwise)
        close();
      },
      { capture: true, signal },
    );
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    button.classList.remove('on');
    listening?.abort();
    listening = null;
  }

  search.addEventListener('input', () => {
    sel = 0;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      render();
      list.querySelector('.sv-item.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[sel]) pick(shown[sel]);
    }
  });
  $('#sv-all').addEventListener('click', () => {
    close();
    onAll();
  });

  return { open, close, nth, isOpen: () => !root.hidden };
};
