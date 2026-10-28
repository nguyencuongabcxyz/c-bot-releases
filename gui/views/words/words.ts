import { $ } from '@/lib/dom';
import { sayInEnglish as say } from '@/lib/speech';
import { esc } from '@/lib/text';
import type { WordRow, WordsList, WordsStats } from '@/types/pages';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './words.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './words.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'My words — C-Bot' });

(() => {
  // My words (main.js openWords): every English word you've caught, how many times
  // you've seen it and when it comes back in a dream; sorted and grouped your way
  // (newest, A–Z, next dream, progress). Click one to see its card again.
  const LEARNT = 6; // vocab.js LEARNT_STEP: seen this many times, learnt
  const STEPS = 9; // vocab.js GAP: the dots show how far along its schedule a word is
  let data: Omit<WordsList, 'stats' | 'hotkey'> & { stats: Partial<WordsStats>; hotkey?: string } = {
    words: [],
    stats: {},
    hours: [9, 18],
    reminders: true,
  };
  let filter = 'all';

  const norm = (s: unknown) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd');

  // "in 3 days", "now"
  function when(due: number) {
    const ms = due - Date.now();
    if (ms <= 0) return 'due now';
    const m = Math.round(ms / 60_000);
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `in ${h} h`;
    const d = Math.round(h / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }

  function renderStats() {
    const s = data.stats || {};
    const tiles = [
      [s.total || 0, 'words'],
      [s.learnt || 0, 'learnt'],
      [s.learning || 0, 'learning'],
      [s.due || 0, 'due now'],
      [`${s.streak || 0}`, s.streak === 1 ? 'day streak' : 'days streak', (s.streak ?? 0) > 0],
    ];
    $('#stats').innerHTML = tiles
      .map(([n, l, hot]) => `<div class="stat${hot ? ' hot' : ''}"><b>${esc(n)}</b><span>${esc(l)}</span></div>`)
      .join('');
  }

  // ---- how the list is organised: sorted, and grouped under headings that fit the sort

  let sort = 'newest';
  const folded = new Set(); // headings you've folded up
  try {
    sort = localStorage.getItem('words.sort') || sort;
    for (const g of JSON.parse(localStorage.getItem('words.folded') || '[]')) folded.add(g);
  } catch {}
  const DAY = 86_400_000;
  const stage = (w: WordRow) =>
    w.status !== 'ready' ? 'new' : w.box >= LEARNT ? 'learnt' : w.box >= 2 ? 'learning' : 'new';
  const startOfDay = (t = Date.now()) => new Date(new Date(t).toDateString()).getTime();
  // [heading, its order] for a word, in the current sort
  function groupOf(w: WordRow, now: number): [string, string | number] {
    if (sort === 'az') {
      const first = norm(w.word).charAt(0).toUpperCase();
      return /[A-Z]/.test(first) ? [first, first] : ['#', '~'];
    }
    if (sort === 'next') {
      if (w.status !== 'ready') return ['Being looked up', 0];
      if (w.due <= now) return ['Due now', 1];
      if (w.due < startOfDay(now) + DAY) return ['Later today', 2];
      if (w.due < startOfDay(now) + 7 * DAY) return ['This week', 3];
      return ['Later', 4];
    }
    if (sort === 'progress') {
      const s = stage(w);
      return s === 'new'
        ? ['New: seen 0–1 times', 0]
        : s === 'learning'
          ? ['Learning: seen 2–5 times', 1]
          : ['Learnt: seen 6 times or more', 2];
    }
    const today = startOfDay(now);
    if (w.addedAt >= today) return ['Today', 0];
    if (w.addedAt >= today - DAY) return ['Yesterday', 1];
    if (w.addedAt >= today - 6 * DAY) return ['This week', 2];
    if (w.addedAt >= today - 30 * DAY) return ['This month', 3];
    return ['Earlier', 4];
  }
  const ORDER: Record<string, (a: WordRow, b: WordRow) => number> = {
    newest: (a, b) => b.addedAt - a.addedAt,
    az: (a, b) => norm(a.word).localeCompare(norm(b.word)),
    next: (a, b) => (a.due || 0) - (b.due || 0),
    progress: (a, b) => a.box - b.box || b.addedAt - a.addedAt,
  };

  function rowHtml(w: WordRow) {
    const steps = Array.from({ length: STEPS - 1 }, (_, i) => `<i class="${i < w.box ? 'on' : ''}"></i>`).join('');
    const due = w.status === 'ready' ? when(w.due) : '';
    let vi = '';
    if (w.status === 'looking') vi = '<span class="more">Looking it up…</span>';
    else if (w.status === 'failed') vi = '<span class="more">Couldn\'t look it up: open it to try again</span>';
    else {
      const [main, ...more] = String(w.vi || '').split('; ');
      vi = `<span class="main">${esc(main)}</span>${more.length ? `<span class="more"> · ${esc(more.join(' · '))}</span>` : ''}`;
    }
    return (
      `<li class="row ${esc(w.status)} stage-${stage(w)}" data-id="${esc(w.id)}" title="Open its card">` +
      `<div><span class="w">${esc(w.word)}</span><span class="pos">${esc(w.pos)}</span><span class="ipa">${esc(w.ipa)}</span></div>` +
      `<div class="side"><div class="acts"><button data-say="${esc(w.word)}" title="Say it">${Icon('sound')}</button><button data-del="${esc(w.id)}" title="Delete this word">${Icon('trash')}</button></div>` +
      `<span class="bar" title="Seen ${w.box} time${w.box === 1 ? '' : 's'}${w.box >= LEARNT ? ': learnt' : ''}">${steps}</span>` +
      `<span class="when${due === 'due now' ? ' due' : ''}">${due ? (due === 'due now' ? 'next dream: soon' : `next dream ${due}`) : ''}</span></div>` +
      `<div class="vi">${vi}</div></li>`
    );
  }

  function renderList() {
    const q = norm($<HTMLInputElement>('#search').value.trim());
    const now = Date.now();
    const matches = data.words.filter((w) => !q || norm(w.word).includes(q) || norm(w.vi).includes(q));
    const pass: Record<string, (w: WordRow) => boolean> = {
      all: () => true,
      due: (w) => w.status === 'ready' && w.due <= now,
      learning: (w) => w.status === 'ready' && w.box < LEARNT,
      learnt: (w) => w.box >= LEARNT,
    };
    // each filter says how many it would show
    for (const b of document.querySelectorAll<HTMLElement>('#filters button'))
      $('.n', b).textContent = String(matches.filter(pass[b.dataset.filter ?? 'all']).length); // (each has its data-filter)
    const words = matches.filter(pass[filter]).sort(ORDER[sort] || ORDER.newest);
    const groups = new Map<string, { order: string | number; words: WordRow[] }>();
    for (const w of words) {
      const [title, order] = groupOf(w, now);
      let group = groups.get(title);
      if (!group) {
        group = { order, words: [] };
        groups.set(title, group);
      }
      group.words.push(w);
    }
    $('#list').innerHTML = [...groups.entries()]
      .sort((a, b) => (a[1].order < b[1].order ? -1 : a[1].order > b[1].order ? 1 : 0))
      .map(([title, g]) => {
        const key = `${sort}:${title}`;
        return (
          `<li class="group${folded.has(key) && !q ? ' folded' : ''}" data-group="${esc(key)}">` +
          `<button class="group-head" title="Fold or unfold"><span class="chev">▾</span>${esc(title)}<span class="count">${g.words.length}</span></button>` +
          `<ul>${g.words.map(rowHtml).join('')}</ul></li>`
        );
      })
      .join('');
    const empty = $('#empty');
    empty.hidden = words.length > 0;
    empty.textContent = data.words.length
      ? 'No words match.'
      : `No words yet. Select a word anywhere and press ${data.hotkey || 'Ctrl+Alt+W'}.`;
    $<HTMLButtonElement>('#quiz').disabled = !data.words.some((w) => w.status === 'ready');
  }

  function renderSettings() {
    $<HTMLInputElement>('#reminders').checked = data.reminders;
    const [from, to] = data.hours || [9, 18];
    const opts = (sel: number) =>
      Array.from(
        { length: 25 },
        (_, h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`,
      ).join('');
    $('#from').innerHTML = opts(from);
    $('#to').innerHTML = opts(to);
    $<HTMLSelectElement>('#from').disabled = $<HTMLSelectElement>('#to').disabled = !data.reminders;
  }

  async function load() {
    data = await ipc.wordsList();
    renderStats();
    renderList();
    renderSettings();
  }

  $('#search').addEventListener('input', renderList);
  $<HTMLSelectElement>('#sort').value = sort;
  $('#sort').addEventListener('change', () => {
    sort = $<HTMLSelectElement>('#sort').value;
    try {
      localStorage.setItem('words.sort', sort);
    } catch {}
    renderList();
  });
  $('#filters').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter ?? filter; // (it has one: [data-filter] matched)
    for (const x of document.querySelectorAll('#filters button')) x.classList.toggle('on', x === b);
    renderList();
  });
  $('#list').addEventListener('click', async (e) => {
    // a heading folds or unfolds its group (remembered)
    const head = (e.target as Element).closest<HTMLElement>('.group-head');
    if (head) {
      const g = head.closest<HTMLElement>('[data-group]'); // (its group, the li round it)
      const key = g?.dataset.group;
      if (!g || key === undefined) return;
      g.classList.toggle('folded');
      if (g.classList.contains('folded')) folded.add(key);
      else folded.delete(key);
      try {
        localStorage.setItem('words.folded', JSON.stringify([...folded]));
      } catch {}
      return;
    }
    const sayIt = (e.target as Element).closest<HTMLElement>('[data-say]');
    if (sayIt) return say(sayIt.dataset.say);
    const del = (e.target as Element).closest<HTMLElement>('[data-del]');
    if (del) {
      const w = data.words.find((x) => x.id === del.dataset.del);
      if (w && confirm(`Delete “${w.word}” from your words?`)) await ipc.wordsDelete(w.id);
      return;
    }
    const id = (e.target as Element).closest<HTMLElement>('[data-id]')?.dataset.id;
    if (id !== undefined) ipc.wordsOpen(id);
  });
  $('#quiz').addEventListener('click', async () => {
    const ok = await ipc.wordsQuiz();
    if (!ok) alert('No robot is free to quiz you right now (they may all be busy, asleep at a job or out for a walk).');
  });
  $('#export').addEventListener('click', () => ipc.wordsExport());
  $('#reminders').addEventListener('change', (e) => {
    data.reminders = (e.target as HTMLInputElement).checked;
    ipc.wordsSettings({ reminders: data.reminders });
    renderSettings();
  });
  for (const id of ['#from', '#to']) {
    $(id).addEventListener('change', () => {
      const from = Number($<HTMLSelectElement>('#from').value);
      const to = Number($<HTMLSelectElement>('#to').value);
      if (from >= to) return renderSettings(); // (not a real span: put it back)
      data.hours = [from, to];
      ipc.wordsSettings({ hours: data.hours });
    });
  }
  ipc.on('words:changed', load);
  setInterval(renderList, 60_000); // "next dream in…" stays true
  load();
  $('#search').focus();
})();
