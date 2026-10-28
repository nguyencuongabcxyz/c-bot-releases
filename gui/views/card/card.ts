import { $ } from '@/lib/dom';
import { sayInEnglish as say } from '@/lib/speech';
import { esc } from '@/lib/text';
import type { CardShownWord, CardWord } from '@/types/pages';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './card.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './card.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'Word card' });

(() => {
  // The word card (main/wordCard.js): a captured word, its meanings in
  // Vietnamese and example sentences. It reads its word from card:init and
  // card:word, and puts itself away a while after the meaning came, unless
  // you're hovering it or editing.
  const card = $('#card');
  const CLOSE_AFTER = 45_000;
  let word: CardShownWord | null = null;
  let editing = false;
  let hovered = false;
  let closeTimer: number | undefined;
  let tab = 'meaning';
  const added = new Set<string>(); // synonyms and family words you saved from this card
  // a quiz (word.quiz): the word first, its meaning once you ask; then how it went
  let revealed = false;
  type How = 'knew' | 'forgot' | 'later';
  let result: How | null = null; // 'knew' | 'forgot' | 'later' once answered
  const QUIZ_FRONT_WAIT = 90_000; // left unanswered this long, the robot puts it away
  const DREAM_WAIT = 20_000; // a dream bubble fades after this (not while the mouse is on it)
  let knewIt = false; // ✓ I know this one, pressed on this dream
  const QUIZ_BACK_WAIT = 180_000;
  const quizOn = () => !!word?.quiz && !result;

  // the word highlighted in a sentence: its endings too (meticulously, deciding), and a
  // verb's other forms (went, gone; gave up)
  function marked(sentence: string, w: string) {
    const safe = esc(sentence);
    const pattern = (s: string) =>
      String(s || '')
        .trim()
        .split(/\s+/)
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
    const stem = pattern(w);
    if (!stem) return safe;
    // a long single word matches without its last letter too (decide -> deciding)
    const root = stem.length > 5 && !stem.includes('\\s') ? stem.slice(0, -1) : stem;
    const vf = word?.verbForms;
    const forms = vf
      ? [vf.past, vf.participle, vf.third, vf.ing]
          .flatMap((f) => String(f || '').split('/'))
          .map(pattern)
          .filter(Boolean)
      : [];
    const alts = [...new Set(forms)].sort((a, b) => b.length - a.length);
    return safe.replace(new RegExp(`\\b(${[...alts, `${root}\\w*`].join('|')})`, 'gi'), '<mark>$1</mark>');
  }

  // a synonym, an antonym or a family word: its meaning, a note or an example, 🔊 and ＋ (save it too)
  type Extras = { pos?: string; note?: string; example?: string };
  function wordRow(x: { word: string; vi: string }, { pos = '', note = '', example = '' }: Extras = {}) {
    const saved = added.has(x.word.toLowerCase());
    return (
      `<li><div class="w"><b>${esc(x.word)}</b>${pos ? `<span class="pos">${esc(pos)}</span>` : ''}` +
      `<button class="icon mini" data-say-word="${esc(x.word)}" title="Say it">${Icon('sound', 'sm')}</button>` +
      `<button class="icon mini add${saved ? ' done' : ''}" data-add="${esc(x.word)}" title="${saved ? 'Saved to your words' : 'Save it to my words too'}">${Icon(saved ? 'check' : 'plus', 'sm')}</button></div>` +
      `<div class="vi">${esc(x.vi)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}${example ? `<div class="ex">${marked(example, x.word)}</div>` : ''}</li>`
    );
  }
  const rows = <T extends { word: string; vi: string }>(
    items: T[] | undefined,
    none: string,
    opts: (x: T) => Extras,
  ) => (items?.length ? items.map((x) => wordRow(x, opts(x))).join('') : `<li class="none">${none}</li>`);

  function render() {
    if (!word) return;
    // 'more': the meaning is in, the phrases, synonyms and word family are still coming
    const more = word.status === 'looking' && !!word.senses?.length;
    card.className = more ? 'more' : word.status === 'looking' ? 'looking' : word.status === 'failed' ? 'failed' : '';
    $('#loading').textContent = more ? 'Finding phrases, synonyms and the word family…' : 'Looking it up…';
    if (editing) card.classList.add('editing');
    if (quizOn()) card.classList.add('quiz', revealed ? 'quiz-back' : 'quiz-front');
    $('#quiz-result').hidden = !result && !knewIt;
    if (word.dream) renderDream(word);
    $('#word').textContent = word.word || word.text;
    $('#ipa').textContent = word.ipa || '';
    $('#failed').hidden = word.status !== 'failed';
    $('#failed-why').textContent = `Couldn't look it up: ${word.error || 'no answer came back'}`;
    $('#senses').innerHTML = (word.senses || [])
      .map(
        (s) =>
          `<li><span class="pos">${esc(s.pos)}</span><span class="vi" contenteditable="${editing}">${esc(s.vi)}</span><span class="en">${esc(s.en)}</span></li>`,
      )
      .join('');
    // a verb's five forms, each one said aloud on a click
    const vf = word.verbForms;
    $('#forms-box').classList.toggle('has', !!vf);
    $('#irregular').hidden = !vf?.irregular;
    $('#forms').innerHTML = vf
      ? (
          [
            ['base', 'V'],
            ['third', 'he / she / it'],
            ['past', 'past'],
            ['participle', 'past participle'],
            ['ing', '-ing'],
          ] as const
        )
          .map(
            ([k, label]) =>
              `<button class="form" data-say-text="${esc(vf[k])}" title="Say it"><span class="form-w">${esc(vf[k])}</span><span class="form-l">${label}</span></button>`,
          )
          .join('')
      : '';
    // the phrases it's used in, each with its example (words saved a little earlier have phrases without examples)
    const phrases = word.phrases || (word.usage?.collocations || []).map((c) => ({ ...c, example: '', exampleVi: '' }));
    const headword = word.word; // (the callbacks below run now, on this word)
    $('#phrases-box').classList.toggle('has', phrases.length > 0);
    $('#phrases').innerHTML = phrases
      .map(
        (p) =>
          `<li><span class="phrase">${esc(p.phrase)}</span> <span class="dash">—</span> <span class="ph-vi" contenteditable="${editing}">${esc(p.vi)}</span>` +
          (p.example
            ? `<span class="ph-ex"><span class="ex-en" contenteditable="${editing}">${editing ? esc(p.example) : marked(p.example, headword)}</span> <button class="icon mini" data-say-text="${esc(p.example)}" title="Say it">${Icon('sound', 'sm')}</button></span>` +
              `<span class="ex-vi" contenteditable="${editing}">${esc(p.exampleVi)}</span>`
            : '') +
          '</li>',
      )
      .join('');
    // words saved before the phrases had their own example sentences
    $('#examples-box').classList.toggle('has', !!word.examples?.length);
    $('#examples').innerHTML = (word.examples || [])
      .map(
        (e) =>
          `<li><span class="ex-en" contenteditable="${editing}">${editing ? esc(e.en) : marked(e.en, headword)}</span> <button class="icon mini" data-say-text="${esc(e.en)}" title="Say it">${Icon('sound', 'sm')}</button><span class="ex-vi" contenteditable="${editing}">${esc(e.vi)}</span></li>`,
      )
      .join('');
    $('#synonyms').innerHTML = rows(word.synonyms, more ? 'Finding them…' : 'No close synonyms.', (x) => ({
      note: x.note,
    }));
    $('#antonyms').innerHTML = rows(word.antonyms, more ? 'Finding them…' : 'No real opposite.', (x) => ({
      note: x.note,
    }));
    $('#family').innerHTML = rows(word.family, more ? 'Finding them…' : 'No other forms of this word.', (x) => ({
      pos: x.pos,
      example: x.example,
    }));
    // saved before C-Bot learned synonyms and families: offer to look it up again
    const older = word.status === 'ready' && !word.synonyms;
    $('#older').hidden = !older || tab === 'meaning';
    $('#n-similar').textContent = older
      ? ''
      : more
        ? '…'
        : `${(word.synonyms || []).length} · ${(word.antonyms || []).length}`;
    $('#n-family').textContent = older ? '' : more ? '…' : String((word.family || []).length);
    for (const b of document.querySelectorAll<HTMLElement>('#tabs button'))
      b.classList.toggle('on', b.dataset.tab === tab);
    for (const p of document.querySelectorAll<HTMLElement>('.pane'))
      p.hidden = p.dataset.pane !== tab || (older && tab !== 'meaning');
    const tip = $('#tip');
    if (word.tip) Icon.text(tip, `💡 ${word.tip}`);
    else tip.textContent = '';
    tip.contentEditable = String(editing && !!word.tip);
    const src = word.source && word.source.length > 48 ? `${word.source.slice(0, 47)}…` : word.source || '';
    $('#found').textContent = word.context
      ? `Found in: “${word.context}”${src ? ` · ${src}` : ''}`
      : src
        ? `From: ${src}`
        : '';
    $('#edit').hidden = editing;
    $('#save').hidden = !editing;
    $('#undo').hidden = !!word.known; // an old word: undo would throw away what you had
    $('#note').textContent = word.status !== 'ready' ? '' : word.known ? 'already in my words' : 'saved to my words';
    report();
    armClose();
  }

  // tell the window how tall the card wants to be (a long one scrolls once the window can't grow)
  function report() {
    requestAnimationFrame(() => {
      const borders = card.offsetHeight - card.clientHeight;
      ipc.cardSize(card.scrollHeight + borders + 22 + 6); // + the page's padding and the card's shadow
    });
  }

  // A dream: the meaning, and one example; a different phrase each time it comes back
  // (review.step counts the times you've seen it)
  function renderDream(word: CardShownWord) {
    // (render() calls it, for the word it shows)
    card.classList.add('dream');
    card.classList.toggle('known-it', knewIt);
    $('#dream-vi').textContent = word.senses?.[0]?.vi || '';
    const phrases = (word.phrases || []).filter((p) => p.example);
    const p = phrases.length ? phrases[(word.review?.step || 0) % phrases.length] : null;
    const ex = p ? { en: p.example, vi: p.exampleVi } : word.examples?.[0] || null;
    $('#dream-ex').hidden = !ex;
    $('#dream-ex').innerHTML = ex
      ? (p ? `<span class="phrase">${esc(p.phrase)}</span><br>` : '') +
        `<span class="ex-en">${marked(ex.en, word.word)}</span> <button class="icon mini" data-say-text="${esc(ex.en)}" title="Say it">${Icon('sound', 'sm')}</button>` +
        `<span class="ex-vi">${esc(ex.vi || '')}</span>`
      : '';
  }

  function armClose() {
    clearTimeout(closeTimer);
    if (word?.dream) {
      if (!hovered) closeTimer = setTimeout(() => ipc.cardAct('close'), knewIt ? 2000 : DREAM_WAIT);
      return;
    }
    if (quizOn()) {
      // a quiz waits for you even while you hover, but not for ever
      closeTimer = setTimeout(() => ipc.cardAct('quiz', 'ignored'), revealed ? QUIZ_BACK_WAIT : QUIZ_FRONT_WAIT);
      return;
    }
    if (!word || word.status === 'looking' || editing || hovered) return;
    closeTimer = setTimeout(() => ipc.cardAct('close'), result ? 6000 : CLOSE_AFTER);
  }

  // "back in 3 days", "back in 10 minutes"
  function inWords(ms: number) {
    const m = Math.max(1, Math.round(ms / 60_000));
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  let answering = false;
  async function answer(how: How) {
    if (answering || result || !word?.quiz) return; // once per quiz
    answering = true;
    clearTimeout(closeTimer);
    const res = await ipc.cardAct('quiz', how);
    answering = false;
    result = how;
    const wait = res?.review?.due ? res.review.due - Date.now() : 0;
    const back = wait > 0 ? ` It comes back in ${inWords(wait)}.` : '';
    Icon.text(
      $('#quiz-result'),
      how === 'knew' ? `🎉 Nice!${back}` : how === 'forgot' ? `No worries!${back}` : '⏰ OK, later!',
    );
    revealed = true;
    render();
  }

  function collect(word: CardShownWord) {
    const vi = [...document.querySelectorAll('#senses .vi')].map((el) => el.textContent.trim());
    const en = [...document.querySelectorAll('#examples .ex-en')].map((el) => el.textContent.trim());
    const exVi = [...document.querySelectorAll('#examples .ex-vi')].map((el) => el.textContent.trim());
    const rowsOf = [...document.querySelectorAll('#phrases li')];
    const text = (li: Element | undefined, sel: string) => li?.querySelector(sel)?.textContent.trim();
    return {
      senses: word.senses.map((s, i) => ({ ...s, vi: vi[i] ?? s.vi })).filter((s) => s.vi),
      examples: (word.examples || []).map((e, i) => ({ en: en[i] ?? e.en, vi: exVi[i] ?? e.vi })).filter((e) => e.en),
      ...(word.phrases && {
        phrases: word.phrases.map((p, i) => ({
          ...p,
          vi: text(rowsOf[i], '.ph-vi') ?? p.vi,
          example: text(rowsOf[i], '.ex-en') ?? p.example,
          exampleVi: text(rowsOf[i], '.ex-vi') ?? p.exampleVi,
        })),
      }),
      tip: word.tip ? $('#tip').textContent.trim() : '',
    };
  }

  $('#say').addEventListener('click', () => say(word?.word || word?.text));
  // 🔊 by a phrase's example or an example sentence
  for (const id of ['#forms', '#phrases', '#examples']) {
    $(id).addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-say-text]');
      if (b) say(b.dataset.sayText);
    });
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab ?? tab; // (it has one: [data-tab] matched)
    render();
  });
  // in the word lists: 🔊 says the word, ＋ saves it as a word of its own
  for (const id of ['#synonyms', '#antonyms', '#family']) {
    $(id).addEventListener('click', (e) => {
      const sayIt = (e.target as Element).closest<HTMLElement>('[data-say-word]');
      if (sayIt) return say(sayIt.dataset.sayWord);
      const add = (e.target as Element).closest<HTMLElement>('[data-add]');
      const word = add?.dataset.add;
      if (!add || !word || add.classList.contains('done')) return;
      added.add(word.toLowerCase());
      ipc.cardAct('add', word);
      render();
    });
  }
  $('#refresh').addEventListener('click', () => ipc.cardAct('retry'));
  $('#close').addEventListener('click', () => ipc.cardAct('close'));
  $('#retry').addEventListener('click', () => ipc.cardAct('retry'));
  $('#ask').addEventListener('click', () => ipc.cardAct('ask'));
  $('#edit').addEventListener('click', () => {
    editing = true;
    render();
    document.querySelector<HTMLElement>('#senses .vi')?.focus();
  });
  $('#save').addEventListener('click', async () => {
    if (!word) return; // (saving an edit: the card shows a word)
    const patch = collect(word);
    editing = false;
    const saved = await ipc.cardAct('save', patch);
    // (main gives back the word as stored: it's still the card's known word, quiz or dream)
    if (saved) word = { ...saved, known: word?.known, quiz: word?.quiz, dream: word?.dream };
    render();
  });
  // the dream bubble's buttons
  $('#details').addEventListener('click', () => ipc.cardAct('details'));
  $('#knowit').addEventListener('click', async () => {
    if (knewIt) return;
    knewIt = true;
    Icon.text($('#quiz-result'), "👍 Got it: you'll see it less often.");
    render();
    await ipc.cardAct('know');
  });
  $('#dream-ex').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-say-text]');
    if (b) say(b.dataset.sayText);
  });
  $('#reveal').addEventListener('click', () => {
    revealed = true;
    tab = 'meaning';
    render();
  });
  // a hint: one of its phrases in a sentence (the meaning stays hidden)
  $('#hint').addEventListener('click', () => {
    if (!word) return; // (a quiz shows a word)
    const p = word.phrases?.find((x) => x.example) || null;
    const hint = $('#quiz-hint');
    hint.innerHTML = p ? marked(p.example, word.word) : esc(word.examples?.[0]?.en || word.senses?.[0]?.en || '');
    hint.hidden = !hint.innerHTML;
    $('#hint').hidden = true;
    report();
  });
  $('#knew').addEventListener('click', () => answer('knew'));
  $('#forgot').addEventListener('click', () => answer('forgot'));
  $('#later').addEventListener('click', () => answer('later'));
  $('#undo').addEventListener('click', async () => {
    card.classList.add('removed');
    $('#note').textContent = 'removed';
    await ipc.cardAct('undo');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipc.cardAct('close');
  });
  card.addEventListener('mouseenter', () => {
    hovered = true;
    clearTimeout(closeTimer);
  });
  card.addEventListener('mouseleave', () => {
    hovered = false;
    armClose();
  });
  new ResizeObserver(report).observe(card);

  function show(payload: CardWord | null) {
    if (!payload?.word) return;
    if (payload.fresh) {
      editing = false;
      tab = 'meaning';
      added.clear();
      revealed = false;
      knewIt = false;
      result = null;
      $('#quiz-hint').hidden = true;
      $('#hint').hidden = false;
    }
    word = payload.word;
    document.documentElement.style.setProperty('--paint', payload.paint || '#5ac8fa');
    render();
  }
  ipc.on('card:word', show);
  ipc.cardInit().then(show);
})();
