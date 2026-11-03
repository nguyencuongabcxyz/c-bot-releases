// Find the English (features/vocab/find.rs): type something in Vietnamese and get the
// English for it, a few choices with their tone, meaning and an example. The words come first;
// each one's details follow as they're written (find:detail, find:done). ☆ saves one to My
// words (as a word of its own, looked up there); nothing else is kept.
import { $ } from '@/lib/dom';
import { sayInEnglish as say } from '@/lib/speech';
import { esc } from '@/lib/text';
import { marked } from '@/features/vocab/marked';
import { SAVE_LABEL, saveState, withDetail } from '@/features/vocab/choices';
import type { FindChoice, FindDetail, FindDone, FindEnglish, FindInit } from '@/types/pages';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './find.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './find.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'Find the English' });

(() => {
  const box = $('#find');
  const q = $<HTMLInputElement>('#q');
  const list = $('#choices');
  let found: FindEnglish | null = null;
  let asking = 0; // (only the latest search's answer is shown)
  let early: FindDetail[] = []; // details that came before their search's words were shown
  const savedHere = new Set<string>(); // ids saved from this window (☆ again takes one back)

  // ---------------------------------------------------------------- drawing

  function choiceRow(c: FindChoice, i: number) {
    const state = saveState(c, savedHere);
    const on = state === 'new' ? '' : ' on';
    return (
      `<li class="choice"><div class="top"><b class="w">${esc(c.word)}</b>` +
      (c.ipa ? `<span class="ipa">${esc(c.ipa)}</span>` : '') +
      `<button type="button" class="icon mini" data-say="${esc(c.word)}" title="Say it">${Icon('sound')}</button>` +
      (c.tone ? `<span class="tag feel-${esc(c.feel)}">${esc(c.tone)}</span>` : '') +
      `</div><div class="gloss">${c.pos ? `<span class="pos">${esc(c.pos)}</span>` : ''}${esc(c.gloss)}</div>` +
      (c.vi ? `<div class="vi">${esc(c.vi)}</div>` : '') +
      (c.example
        ? `<div class="ex">${marked(c.example, c.word)} <button type="button" class="icon mini" data-say="${esc(c.example)}" title="Say it">${Icon('sound')}</button></div>`
        : !c.ready && !found?.complete
          ? '<div class="ex wait"></div>'
          : '') +
      `<div class="acts"><button type="button" class="save${on}${state === 'had' ? ' had' : ''}" data-save="${i}" title="Save to My words">${Icon('star')}<span>${SAVE_LABEL[state]}</span></button>` +
      `<button type="button" data-copy="${i}" title="Copy">${Icon('copy')}<span>Copy</span></button></div></li>`
    );
  }

  function render() {
    list.hidden = !found;
    list.innerHTML = found ? found.choices.map(choiceRow).join('') : '';
    const tip = $('#tip');
    tip.textContent = found?.tip ? `💡 ${found.tip}` : '';
    tip.hidden = !found?.tip;
    report();
  }

  // tell the window how tall it wants to be (a long list scrolls once the window can't grow)
  function report() {
    requestAnimationFrame(() => {
      const borders = box.offsetHeight - box.clientHeight;
      ipc.findSize(box.scrollHeight + borders + 22 + 6); // + the page's padding and the shadow
    });
  }

  // ---------------------------------------------------------------- looking it up

  async function search() {
    const text = q.value.trim();
    if (!text) return;
    const mine = ++asking;
    found = null;
    $('#hint').hidden = true;
    $('#failed').hidden = true;
    $('#looking').hidden = false;
    render();
    try {
      const answer = await ipc.findSearch(text);
      if (mine !== asking) return;
      found = answer;
      for (const d of early) withDetail(found, d);
      early = [];
    } catch (err) {
      if (mine !== asking) return;
      $('#failed').textContent = String(err);
      $('#failed').hidden = false;
    }
    $('#looking').hidden = true;
    render();
  }

  // ☆: into My words; ★ (saved from here) takes it back; one you had stays
  async function toggleSave(i: number) {
    const c = found?.choices[i];
    if (!c) return;
    const state = saveState(c, savedHere);
    if (state === 'had') return;
    if (state === 'mine' && c.saved) {
      const id = c.saved;
      if (await ipc.findAct('unsave', { id })) {
        savedHere.delete(id);
        c.saved = null;
      }
    } else {
      const id = await ipc.findAct('save', { word: c.word, example: c.example });
      if (id) {
        savedHere.add(id);
        c.saved = id;
      }
    }
    render();
  }

  async function copy(i: number, b: HTMLElement) {
    const c = found?.choices[i];
    if (!c || !(await ipc.findAct('copy', { text: c.word }))) return;
    const label = b.querySelector('span');
    if (!label) return;
    label.textContent = 'Copied';
    setTimeout(() => {
      label.textContent = 'Copy';
    }, 1200);
  }

  // ---------------------------------------------------------------- wiring

  $('#ask').addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
  $('#close').addEventListener('click', () => ipc.findAct('close'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipc.findAct('close');
  });
  list.addEventListener('click', (e) => {
    const t = e.target as Element;
    const sayIt = t.closest<HTMLElement>('[data-say]');
    if (sayIt) return say(sayIt.dataset.say);
    const save = t.closest<HTMLElement>('[data-save]');
    if (save) return void toggleSave(Number(save.dataset.save));
    const copyIt = t.closest<HTMLElement>('[data-copy]');
    if (copyIt) return void copy(Number(copyIt.dataset.copy), copyIt);
  });
  new ResizeObserver(report).observe(box);

  // a word's details as they're written (the first may beat its words here: kept till then)
  ipc.on('find:detail', (d: FindDetail) => {
    if (withDetail(found, d)) return render();
    if (!found || d.id > found.id) early = [...early, d].slice(-20);
  });
  ipc.on('find:done', ({ id, tip, error }: FindDone) => {
    if (!found || found.id !== id) return;
    found.complete = true;
    found.tip = tip;
    if (error && !found.choices.some((c) => c.ready)) $('#failed').textContent = `No examples this time: ${error}`;
    $('#failed').hidden = !error;
    render();
  });

  // opened (or the hotkey again): with text, look it up at once; without, the box is yours
  function open(view: FindInit | null) {
    if (!view) return;
    document.documentElement.style.setProperty('--paint', view.paint || '#5ac8fa');
    q.focus();
    if (view.text) {
      q.value = view.text;
      search();
    } else {
      q.select();
    }
  }
  ipc.on('find:open', open);
  ipc.findInit().then(open);
})();
