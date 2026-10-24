(() => {
  // My words (main.js openWords): every English word you've caught, how many times
  // you've seen it and when it comes back in a dream; sorted and grouped your way
  // (newest, A–Z, next dream, progress). Click one to see its card again.
  const $ = (s) => document.querySelector(s);
  const LEARNT = 6; // vocab.js LEARNT_STEP: seen this many times, learnt
  const STEPS = 9; // vocab.js GAP: the dots show how far along its schedule a word is
  let data = { words: [], stats: {}, hours: [9, 18], reminders: true };
  let filter = 'all';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

  // "in 3 days", "now"
  function when(due) {
    const ms = due - Date.now();
    if (ms <= 0) return 'due now';
    const m = Math.round(ms / 60_000);
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `in ${h} h`;
    const d = Math.round(h / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }

  function say(text) {
    if (!text || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => v.lang === 'en-US' && /natural|aria|jenny|guy/i.test(v.name)) || voices.find((v) => v.lang === 'en-US') || null;
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }

  function renderStats() {
    const s = data.stats || {};
    const tiles = [
      [s.total || 0, 'words'],
      [s.learnt || 0, 'learnt'],
      [s.learning || 0, 'learning'],
      [s.due || 0, 'due now'],
      [`${s.streak || 0}`, s.streak === 1 ? 'day streak' : 'days streak', s.streak > 0],
    ];
    $('#stats').innerHTML = tiles.map(([n, l, hot]) => `<div class="stat${hot ? ' hot' : ''}"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('');
  }

  // ---- how the list is organised: sorted, and grouped under headings that fit the sort

  let sort = 'newest';
  const folded = new Set(); // headings you've folded up
  try {
    sort = localStorage.getItem('words.sort') || sort;
    for (const g of JSON.parse(localStorage.getItem('words.folded') || '[]')) folded.add(g);
  } catch {}
  const DAY = 86_400_000;
  const stage = (w) => (w.status !== 'ready' ? 'new' : w.box >= LEARNT ? 'learnt' : w.box >= 2 ? 'learning' : 'new');
  const startOfDay = (t = Date.now()) => new Date(new Date(t).toDateString()).getTime();
  // [heading, its order] for a word, in the current sort
  function groupOf(w, now) {
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
      return s === 'new' ? ['New: seen 0–1 times', 0] : s === 'learning' ? ['Learning: seen 2–5 times', 1] : ['Learnt: seen 6 times or more', 2];
    }
    const today = startOfDay(now);
    if (w.addedAt >= today) return ['Today', 0];
    if (w.addedAt >= today - DAY) return ['Yesterday', 1];
    if (w.addedAt >= today - 6 * DAY) return ['This week', 2];
    if (w.addedAt >= today - 30 * DAY) return ['This month', 3];
    return ['Earlier', 4];
  }
  const ORDER = {
    newest: (a, b) => b.addedAt - a.addedAt,
    az: (a, b) => norm(a.word).localeCompare(norm(b.word)),
    next: (a, b) => (a.due || 0) - (b.due || 0),
    progress: (a, b) => a.box - b.box || b.addedAt - a.addedAt,
  };

  function rowHtml(w) {
    const steps = Array.from({ length: STEPS - 1 }, (_, i) => `<i class="${i < w.box ? 'on' : ''}"></i>`).join('');
    const due = w.status === 'ready' ? when(w.due) : '';
    let vi = '';
    if (w.status === 'looking') vi = '<span class="more">Looking it up…</span>';
    else if (w.status === 'failed') vi = "<span class=\"more\">Couldn't look it up: open it to try again</span>";
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
    const q = norm($('#search').value.trim());
    const now = Date.now();
    const matches = data.words.filter((w) => !q || norm(w.word).includes(q) || norm(w.vi).includes(q));
    const pass = {
      all: () => true,
      due: (w) => w.status === 'ready' && w.due <= now,
      learning: (w) => w.status === 'ready' && w.box < LEARNT,
      learnt: (w) => w.box >= LEARNT,
    };
    // each filter says how many it would show
    for (const b of document.querySelectorAll('#filters button')) b.querySelector('.n').textContent = matches.filter(pass[b.dataset.filter]).length;
    const words = matches.filter(pass[filter]).sort(ORDER[sort] || ORDER.newest);
    const groups = new Map();
    for (const w of words) {
      const [title, order] = groupOf(w, now);
      if (!groups.has(title)) groups.set(title, { order, words: [] });
      groups.get(title).words.push(w);
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
    $('#quiz').disabled = !data.words.some((w) => w.status === 'ready');
  }

  function renderSettings() {
    $('#reminders').checked = data.reminders;
    const [from, to] = data.hours || [9, 18];
    const opts = (sel) => Array.from({ length: 25 }, (_, h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    $('#from').innerHTML = opts(from);
    $('#to').innerHTML = opts(to);
    $('#from').disabled = $('#to').disabled = !data.reminders;
  }

  async function load() {
    data = await cbot.invoke('words:list');
    renderStats();
    renderList();
    renderSettings();
  }

  $('#search').addEventListener('input', renderList);
  $('#sort').value = sort;
  $('#sort').addEventListener('change', () => {
    sort = $('#sort').value;
    try {
      localStorage.setItem('words.sort', sort);
    } catch {}
    renderList();
  });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    for (const x of document.querySelectorAll('#filters button')) x.classList.toggle('on', x === b);
    renderList();
  });
  $('#list').addEventListener('click', async (e) => {
    // a heading folds or unfolds its group (remembered)
    const head = e.target.closest('.group-head');
    if (head) {
      const g = head.parentElement;
      const key = g.dataset.group;
      g.classList.toggle('folded');
      if (g.classList.contains('folded')) folded.add(key);
      else folded.delete(key);
      try {
        localStorage.setItem('words.folded', JSON.stringify([...folded]));
      } catch {}
      return;
    }
    const sayIt = e.target.closest('[data-say]');
    if (sayIt) return say(sayIt.dataset.say);
    const del = e.target.closest('[data-del]');
    if (del) {
      const w = data.words.find((x) => x.id === del.dataset.del);
      if (w && confirm(`Delete “${w.word}” from your words?`)) await cbot.invoke('words:delete', w.id);
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) cbot.invoke('words:open', row.dataset.id);
  });
  $('#quiz').addEventListener('click', async () => {
    const ok = await cbot.invoke('words:quiz');
    if (!ok) alert('No robot is free to quiz you right now (they may all be busy, asleep at a job or out for a walk).');
  });
  $('#export').addEventListener('click', () => cbot.invoke('words:export'));
  $('#reminders').addEventListener('change', (e) => {
    data.reminders = e.target.checked;
    cbot.invoke('words:settings', { reminders: data.reminders });
    renderSettings();
  });
  for (const id of ['#from', '#to']) {
    $(id).addEventListener('change', () => {
      const from = Number($('#from').value);
      const to = Number($('#to').value);
      if (from >= to) return renderSettings(); // (not a real span: put it back)
      data.hours = [from, to];
      cbot.invoke('words:settings', { hours: data.hours });
    });
  }
  cbot.on('words:changed', load);
  setInterval(renderList, 60_000); // "next dream in…" stays true
  load();
  $('#search').focus();
})();
