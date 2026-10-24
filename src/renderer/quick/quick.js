/* global cbot, marked, DOMPurify, Icon */
// Quick actions (main quickWindow.js / quick.js): your selected text, an action (refine with
// a style, translate, explain, summarise) and the answer streaming in. Opening it runs the
// last action you used; another action, style or language runs that (answers are kept, so
// going back to one is instant). Replace puts the answer back over your selection.
(() => {
  const $ = (s) => document.querySelector(s);
  const textEl = $('#text');
  const out = $('#out');
  const status = $('#status');
  let view = null; // from main: { text, source, canReplace, paint, prefs, styles, model, max }
  let prefs = { action: 'refine', style: 'polished', lang: 'en' };
  let to = null; // translate: 'en' | 'vi', or null for "the other language"
  let answer = null; // the answer showing: { key, text, changes, ms, model } (or { key, error })
  let runningKey = null;
  let runId = 0;
  const cache = new Map(); // key -> answer

  const LABELS = { refine: 'Refined', translate: 'Translation', explain: 'Explanation', summarise: 'Summary' };
  const VERBS = { refine: 'Refining', translate: 'Translating', explain: 'Reading it', summarise: 'Summarising' };
  // (as main's quick.js: enough Vietnamese letters and it's Vietnamese)
  const VI_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùýđ]/gi;
  const looksVietnamese = (t) => {
    const letters = (t.match(/\p{L}/gu) || []).length;
    return letters > 0 && (t.match(VI_LETTERS) || []).length / letters > 0.04;
  };
  const target = () => to || (looksVietnamese(textEl.value) ? 'en' : 'vi');
  const NAMES = { en: 'English', vi: 'Tiếng Việt' };

  // what an answer depends on
  function keyOf() {
    const t = textEl.value.trim();
    const custom = $('#custom').value.trim();
    switch (prefs.action) {
      case 'refine':
        return `refine|${prefs.style}|${custom}|${t}`;
      case 'translate':
        return `translate|${target()}|${t}`;
      default:
        return `${prefs.action}|${prefs.lang}|${t}`;
    }
  }

  // ---------------------------------------------------------------- drawing

  function renderControls() {
    for (const b of document.querySelectorAll('#actions button')) {
      b.classList.toggle('on', b.dataset.action === prefs.action);
      b.setAttribute('aria-selected', String(b.dataset.action === prefs.action));
    }
    for (const o of document.querySelectorAll('.opt')) o.hidden = !o.dataset.for.split(' ').includes(prefs.action);
    for (const b of document.querySelectorAll('#styles button')) b.setAttribute('aria-checked', String(b.dataset.style === prefs.style));
    for (const b of document.querySelectorAll('#langs button')) b.setAttribute('aria-checked', String(b.dataset.lang === prefs.lang));
    const t = target();
    $('#dir-from').textContent = NAMES[t === 'en' ? 'vi' : 'en'];
    $('#dir-to').textContent = NAMES[t];
    $('#result-label').textContent = LABELS[prefs.action];
    const n = textEl.value.length;
    $('#count').textContent = n > 200 ? `${n.toLocaleString()} / ${view?.max?.toLocaleString() || ''}` : '';
  }

  function renderAnswer(streaming = '') {
    const md = prefs.action === 'explain' || prefs.action === 'summarise';
    const running = runningKey === keyOf();
    const a = answer && answer.key === keyOf() ? answer : null;
    const text = running ? streaming : a?.text || '';
    out.classList.toggle('md', md);
    out.classList.toggle('cursor', running);
    out.classList.toggle('empty', !text && !running);
    out.classList.toggle('stale', !!answer && !a && !running);
    if (!text && !running) {
      out.textContent = a?.error ? `Couldn't do it: ${a.error}` : textEl.value.trim() ? 'Pick an action, or press Again.' : 'Paste or type some text above.';
    } else if (md) out.innerHTML = DOMPurify.sanitize(marked.parse(text));
    else out.textContent = text;
    if (running) out.scrollTop = out.scrollHeight;
    // what changed (refine)
    const changes = !running && prefs.action === 'refine' ? a?.changes || [] : [];
    $('#changes').hidden = !changes.length;
    $('#changes-n').textContent = changes.length;
    $('#changes-list').replaceChildren(
      ...changes.map((c) => {
        const li = document.createElement('li');
        li.innerHTML = '<del></del><span class="arrow">→</span><ins></ins><span class="why"></span>';
        li.children[0].textContent = c.from;
        li.children[2].textContent = c.to;
        li.children[3].textContent = c.why;
        if (!c.why) li.children[3].remove();
        return li;
      }),
    );
    // the status: working, or how long it took
    status.className = `status${running ? ' busy' : a?.error ? ' bad' : ''}`;
    status.textContent = running ? `${VERBS[prefs.action]}…` : a?.error ? 'failed' : a ? `${a.model} · ${(a.ms / 1000).toFixed(1)}s` : '';
    // the buttons
    const ready = !!a?.text && !running;
    $('#btn-replace').disabled = !ready || !view?.canReplace;
    $('#btn-replace').hidden = !view?.canReplace;
    $('#btn-copy').disabled = !ready;
    $('#btn-copy').classList.toggle('primary', !view?.canReplace);
    $('#btn-ask').disabled = !textEl.value.trim();
    const again = $('#btn-again');
    again.innerHTML = `${Icon(running ? 'stop' : 'refresh')}<span>${running ? 'Stop' : 'Again'}</span>`;
    again.disabled = !textEl.value.trim() && !running;
    reportSize();
  }

  // the window grows and shrinks with what's in it
  let lastH = 0;
  function reportSize() {
    requestAnimationFrame(() => {
      const h = Math.ceil($('#qa').scrollHeight + 22);
      if (Math.abs(h - lastH) > 2) cbot.send('quick:size', (lastH = h));
    });
  }

  // ---------------------------------------------------------------- running

  async function run({ force = false } = {}) {
    const text = textEl.value.trim();
    if (!text) return renderAnswer();
    const key = keyOf();
    if (!force && cache.has(key)) {
      answer = cache.get(key);
      runningKey = null;
      return renderAnswer();
    }
    const id = ++runId;
    runningKey = key;
    renderAnswer('');
    const res = await cbot.invoke('quick:run', { action: prefs.action, text, style: prefs.style, custom: $('#custom').value.trim(), to: target(), lang: prefs.lang });
    if (id !== runId) return; // (a newer one took over)
    runningKey = null;
    if (!res || res.cancelled) return renderAnswer();
    answer = res.error ? { key, error: res.error } : { key, text: res.text, changes: res.changes || [], ms: res.ms, model: res.model };
    if (!res.error) cache.set(key, answer);
    renderAnswer();
  }

  function pick(patch) {
    Object.assign(prefs, patch);
    cbot.invoke('quick:act', 'prefs', patch);
    renderControls();
    run();
  }

  // ---------------------------------------------------------------- controls

  $('#actions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b && b.dataset.action !== prefs.action) pick({ action: b.dataset.action });
  });
  $('#styles').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-style]');
    if (b) pick({ style: b.dataset.style });
  });
  $('#langs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (b) pick({ lang: b.dataset.lang });
  });
  $('#btn-swap').addEventListener('click', () => {
    to = target() === 'en' ? 'vi' : 'en';
    renderControls();
    run();
  });
  $('#custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  // editing the text: the answer is for the old text now (Again, or Ctrl+Enter, runs it)
  textEl.addEventListener('input', () => {
    to = null;
    autosize();
    renderControls();
    renderAnswer();
  });
  function autosize() {
    textEl.style.height = 'auto';
    textEl.style.height = `${Math.min(textEl.scrollHeight + 2, 128)}px`;
  }

  const current = () => (answer && answer.key === keyOf() && !runningKey ? answer : null);
  $('#btn-again').addEventListener('click', () => {
    if (runningKey) {
      runId++;
      runningKey = null;
      cbot.invoke('quick:act', 'stop');
      return renderAnswer();
    }
    run({ force: true });
  });
  $('#btn-copy').addEventListener('click', async () => {
    const a = current();
    if (!a?.text) return;
    await cbot.invoke('quick:act', 'copy', { text: a.text, action: prefs.action });
    const b = $('#btn-copy');
    b.classList.add('done');
    b.lastChild.textContent = 'Copied';
    setTimeout(() => {
      b.classList.remove('done');
      b.lastChild.textContent = 'Copy';
    }, 1400);
  });
  $('#btn-replace').addEventListener('click', () => {
    const a = current();
    if (a?.text && view?.canReplace) cbot.invoke('quick:act', 'replace', { text: a.text, action: prefs.action });
  });
  $('#btn-ask').addEventListener('click', () => {
    const a = current();
    cbot.invoke('quick:act', 'ask', { text: textEl.value.trim(), action: prefs.action, style: prefs.style, result: a?.text || '' });
  });
  $('#btn-close').addEventListener('click', () => cbot.invoke('quick:act', 'close'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return cbot.invoke('quick:act', 'close');
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // in the text box: run it; elsewhere: put the answer back (or copy it)
      if (document.activeElement === textEl && !current()) return run({ force: true });
      return (view?.canReplace ? $('#btn-replace') : $('#btn-copy')).click();
    }
    if (e.key.toLowerCase() === 'c' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      $('#btn-copy').click();
    }
  });

  // ---------------------------------------------------------------- opening

  function show(v) {
    view = v;
    if (!v) return;
    document.documentElement.style.setProperty('--paint', v.paint || '#5ac8fa');
    prefs = { action: 'refine', style: 'polished', lang: 'en', ...v.prefs };
    to = null;
    answer = null;
    runningKey = null;
    runId++;
    cache.clear();
    const src = $('#source');
    src.hidden = !v.source;
    src.textContent = v.source ? `from ${v.source}` : '';
    src.title = v.source || '';
    if (!$('#styles').children.length) {
      $('#styles').replaceChildren(
        ...v.styles.map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.style = s.id;
          b.setAttribute('role', 'radio');
          b.textContent = s.label;
          b.title = s.how[0].toUpperCase() + s.how.slice(1);
          return b;
        }),
      );
    }
    textEl.value = v.text || '';
    $('#custom').value = '';
    autosize();
    renderControls();
    if (textEl.value.trim()) {
      run();
      out.focus();
    } else {
      renderAnswer();
      textEl.focus();
    }
  }

  cbot.on('quick:text', ({ text }) => {
    if (runningKey) renderAnswer(text);
  });
  cbot.on('quick:open', show);
  new ResizeObserver(reportSize).observe($('#qa'));
  cbot.invoke('quick:init').then(show);
})();
