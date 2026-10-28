// The notebook (main notebook.js / notes.js): your notes, to add, tick off, edit and
// delete, and the daily reminder's banner. Every change comes back as notebook:notes,
// so the list is always what's saved.
import { $ } from '@/lib/dom';
import { clock as time } from '@/lib/time';
import type { Note } from '@/types/model';
import type { NotebookOpen, NotebookReminder } from '@/types/pages';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './notebook.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './notebook.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'Notes' });

(() => {
  const list = $('#list');
  const addText = $<HTMLTextAreaElement>('#add-text');
  const filter = $<HTMLInputElement>('#filter');
  const toast = $('#toast');
  const DAY = 24 * 60 * 60 * 1000;
  let notes: Note[] = [];
  let showDone = false;
  let editing: string | null = null; // the id being edited
  let menuFor: string | null = null; // the id whose ⋯ menu is open
  let toastTimer = 0;

  const act = ipc.notebookAct;
  const startOfDay = (t: number) =>
    new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();
  const ageOf = (n: Note) => Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(n.createdAt)) / DAY));
  const date = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  // ---------------------------------------------------------------- the list

  function groups() {
    const q = filter.value.trim().toLowerCase();
    const shown = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
    const open = shown.filter((n) => !n.doneAt);
    const today = startOfDay(Date.now());
    const out: [string, Note[]][] = [
      ['Important', open.filter((n) => n.important)],
      ['Today', open.filter((n) => !n.important && n.createdAt >= today)],
      ['Yesterday', open.filter((n) => !n.important && n.createdAt < today && n.createdAt >= today - DAY)],
      ['Earlier', open.filter((n) => !n.important && n.createdAt < today - DAY)],
    ];
    const done = shown.filter((n) => n.doneAt).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)); // (done ones: doneAt is set)
    return { out, done };
  }

  function render() {
    const { out, done } = groups();
    const open = notes.filter((n) => !n.doneAt).length;
    $('#count').hidden = !open;
    $('#count').textContent = String(open);
    filter.hidden = notes.length < 9 && !filter.value;
    list.innerHTML = '';
    for (const [title, items] of out) {
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = title;
      list.append(h);
      for (const n of items) list.append(row(n));
    }
    if (done.length) {
      const h = document.createElement('div');
      h.className = 'group';
      const b = document.createElement('button');
      b.textContent = `${showDone ? '▾' : '▸'} Done (${done.length})`;
      b.onclick = () => {
        showDone = !showDone;
        render();
      };
      h.append(b);
      list.append(h);
      if (showDone) for (const n of done) list.append(row(n));
    }
    $('#empty').hidden = !!open || !!filter.value;
    $('[data-act="toggle-done"] span').textContent = showDone ? 'Hide done notes' : 'Show done notes';
  }

  function row(n: Note) {
    const el = document.createElement('div');
    el.className = `note${n.important ? ' important' : ''}${n.doneAt ? ' done' : ''}${menuFor === n.id ? ' menu-open' : ''}`;
    el.dataset.id = n.id;
    el.setAttribute('role', 'listitem');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!n.doneAt;
    box.title = n.doneAt ? 'Not done after all' : 'Done';
    box.onchange = () => act('done', { id: n.id, done: box.checked });
    const body = document.createElement('div');
    body.className = 'body';
    if (editing === n.id) {
      const ta = document.createElement('textarea');
      ta.value = n.text;
      ta.rows = Math.min(6, n.text.split('\n').length + 1);
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          editing = null;
          act('edit', { id: n.id, text: ta.value });
          render();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          editing = null;
          render();
        }
      };
      ta.onblur = () => {
        if (editing !== n.id) return;
        editing = null;
        act('edit', { id: n.id, text: ta.value });
      };
      body.append(ta);
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    } else {
      const t = document.createElement('div');
      t.className = 'text';
      t.textContent = n.text;
      t.title = 'Double-click to edit';
      t.ondblclick = () => {
        editing = n.id;
        render();
      };
      body.append(t);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const when =
      startOfDay(n.createdAt) === startOfDay(Date.now())
        ? time(n.createdAt)
        : `${date(n.createdAt)}, ${time(n.createdAt)}`;
    meta.append(span(n.doneAt ? `✓ ${date(n.doneAt)}` : when));
    if (n.source) meta.append(span(`from ${n.source}`));
    const age = ageOf(n);
    if (!n.doneAt && age >= 3) meta.append(span(`${age} days old`, 'old'));
    if (n.working) meta.append(span('● Claude is on it', 'work'));
    body.append(meta);
    const more = document.createElement('button');
    more.className = 'more';
    more.innerHTML = Icon('more');
    more.title = 'More';
    more.onclick = (e) => {
      e.stopPropagation();
      menuFor = menuFor === n.id ? null : n.id;
      render();
    };
    el.append(box, body, more);
    if (menuFor === n.id) el.append(noteMenu(n));
    return el;
  }

  function span(text: string, cls = '') {
    const s = document.createElement('span');
    s.textContent = text;
    if (cls) s.className = cls;
    return s;
  }

  function noteMenu(n: Note) {
    const m = document.createElement('div');
    m.className = 'note-menu';
    m.onclick = (e) => e.stopPropagation();
    const item = (icon: string, label: string, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.innerHTML = Icon(icon);
      b.append(span(label));
      if (cls) b.className = cls;
      b.onclick = () => {
        menuFor = null;
        fn();
        render();
      };
      m.append(b);
    };
    if (!n.doneAt) item('bot', 'Ask Claude about it', () => act('ask', { id: n.id }));
    item('zap', n.important ? 'Not important' : 'Important', () => act('edit', { id: n.id, important: !n.important }));
    item('edit', 'Edit', () => (editing = n.id));
    item('copy', 'Copy', () => act('copy', { id: n.id }));
    item('trash', 'Delete', () => remove(n), 'danger');
    return m;
  }

  async function remove(n: Note) {
    await act('delete', { id: n.id });
    $('#toast-text').textContent = 'Note deleted';
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 5000);
  }
  $('#toast-undo').onclick = () => {
    act('undo-delete');
    toast.hidden = true;
  };

  // ---------------------------------------------------------------- adding

  function autosize() {
    addText.style.height = 'auto';
    addText.style.height = `${Math.min(addText.scrollHeight + 4, 120)}px`;
    addText.style.overflowY = addText.scrollHeight + 4 > 120 ? 'auto' : 'hidden';
  }
  autosize();
  addText.addEventListener('input', autosize);
  // while you type a note the robot writes it down on a sticky pad: tell it when you start
  // and when you stop (the box emptied, a pause of a few seconds, or you're out of the box)
  let typing = false;
  let typingIdle: number | undefined;
  function setTyping(on: boolean) {
    clearTimeout(typingIdle);
    if (on) typingIdle = setTimeout(() => setTyping(false), 6000);
    if (on === typing) return;
    typing = on;
    act('typing', { on });
  }
  addText.addEventListener('input', () => setTyping(!!addText.value.trim()));
  addText.addEventListener('blur', () => setTyping(false));
  addText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      add();
    }
  });
  $('#add').addEventListener('submit', (e) => {
    e.preventDefault();
    add();
  });
  async function add() {
    const text = addText.value.trim();
    if (!text) return;
    addText.value = '';
    autosize();
    clearTimeout(typingIdle);
    typing = false; // (the robot goes from writing it to pinning it up)
    const note = await act('add', { text, source: pendingSource });
    pendingSource = '';
    if (note) flash(note.id);
  }
  let pendingSource = ''; // where pre-filled text came from (the hotkey with a selection)

  function flash(id: string) {
    requestAnimationFrame(() => {
      const el = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  // ---------------------------------------------------------------- header, menus, keys

  filter.addEventListener('input', render);
  $('#btn-close').onclick = () => act('close');
  $('#btn-more').onclick = (e) => {
    e.stopPropagation();
    $('#more').hidden = !$('#more').hidden;
  };
  $('#more').addEventListener('click', async (e) => {
    const b = (e.target as Element).closest('button');
    if (!b) return;
    $('#more').hidden = true;
    if (b.dataset.act === 'toggle-done') {
      showDone = !showDone;
      render();
    } else if (b.dataset.act === 'copy-all') {
      const n = await act('copy-all');
      $('#toast-text').textContent = `Copied ${n} note${n === 1 ? '' : 's'}`;
      $('#toast-undo').hidden = true;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.hidden = true;
        $('#toast-undo').hidden = false;
      }, 2500);
    } else if (b.dataset.act === 'clear-done') act('clear-done');
  });
  document.addEventListener('click', () => {
    $('#more').hidden = true;
    if (menuFor) {
      menuFor = null;
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#more').hidden || menuFor) {
      $('#more').hidden = true;
      menuFor = null;
      render();
    } else act('close');
  });

  // ---------------------------------------------------------------- the reminder banner

  function showReminder(r: NotebookReminder | null | undefined) {
    const box = $('#reminder');
    if (!r) {
      box.hidden = true;
      return;
    }
    const { kind, info = {} } = r;
    const open = info.open || 0;
    let text: string;
    if (kind === 'morning') {
      const monday = new Date().getDay() === 1;
      text = `Good morning! ${info.taken ? `You noted ${info.taken} thing${info.taken === 1 ? '' : 's'} ${monday ? 'last week' : 'yesterday'}` : 'Here are your notes'}${open ? `, ${open} still to do.` : '.'}`;
    } else {
      text = `Before you go: ${info.today ? `${info.today} note${info.today === 1 ? '' : 's'} today` : 'your notes'}${open ? `, ${open} still open.` : ', all done!'}`;
    }
    // (the robot's line comes in info: robot.ts notes:remind-open)
    const line = r.line || info.line;
    $('#reminder-text').textContent = line ? `${text} ${line}` : text;
    $('#btn-summary').hidden = kind !== 'evening' || !info.today;
    box.hidden = false;
  }
  $('#btn-snooze').onclick = () => act('snooze', { minutes: 15 });
  $('#btn-today').onclick = () => act('done-for-today');
  $('#btn-summary').onclick = () => act('summary');

  // ---------------------------------------------------------------- talking to main

  function opened({ focus, reminder, text, source }: Partial<NotebookOpen> = {}) {
    showReminder(reminder);
    if (text) {
      // the hotkey with something selected: ready to save as it is
      addText.value = text;
      pendingSource = source || '';
      autosize();
    }
    if (focus === 'add')
      setTimeout(() => {
        addText.focus();
        addText.setSelectionRange(addText.value.length, addText.value.length);
      }, 30);
    else if (focus) flash(focus);
  }

  ipc.on('notebook:notes', (v) => {
    notes = v.notes || [];
    if (!editing) render();
  });
  ipc.on('notebook:open', opened);

  (async () => {
    const init = await ipc.notebookInit();
    if (!init) return;
    notes = init.notes || [];
    render();
    opened(init);
  })();
})();
