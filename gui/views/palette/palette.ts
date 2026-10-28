// The action palette (main palette.js): what you selected at the top, the actions below.
// 1–9 or the arrows and Enter pick one, the mouse too; Esc closes.
import { $ } from '@/lib/dom';
import type { PaletteItem, PaletteView } from '@/types/ipc';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './palette.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './palette.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'C-Bot' });

(() => {
  const list = $('#list');
  // (an item is a heading or an action: what's an action is only read from the ones that aren't headings)
  type Item = Extract<PaletteItem, { id: string }> & { heading?: string };
  let items: Item[] = [];
  let index = 0;

  function render(v: PaletteView | null) {
    if (!v) return; // (made ahead of time, nothing to show yet)
    const text = (v?.text || '').replace(/\s+/g, ' ').trim();
    $('#sel').classList.toggle('empty', !text);
    $('#sel-label').textContent = text
      ? v.source
        ? `Selected in ${v.source.split(' - ').pop()}`
        : 'Selected'
      : 'Nothing selected';
    $('#sel-text').textContent = text || 'Select some text first for more actions.';
    items = ((v?.items || []) as Item[]).filter((i) => !i.heading);
    index = 0;
    list.innerHTML = '';
    let n = 0;
    for (const it of (v?.items || []) as Item[]) {
      if (it.heading) {
        const h = document.createElement('div');
        h.className = 'heading';
        h.textContent = it.heading;
        list.append(h);
        continue;
      }
      const i = n++;
      const row = document.createElement('div');
      row.className = 'item';
      row.setAttribute('role', 'option');
      row.dataset.i = String(i);
      row.innerHTML = `<span class="ico">${Icon(it.icon)}</span><span class="lb"></span><kbd></kbd>`;
      $('.lb', row).textContent = it.label;
      if (it.hint) {
        const small = document.createElement('small');
        small.textContent = it.hint;
        $('.lb', row).append(small);
      }
      $('kbd', row).textContent = i < 9 ? String(i + 1) : '';
      row.addEventListener('mousemove', (e) => (e.movementX || e.movementY) && select(i)); // (a real move, not the menu appearing under the mouse)
      row.addEventListener('click', () => pick(i));
      list.append(row);
    }
    select(0);
    // pop in again each time it opens (it's the same window, kept hidden in between)
    const pal = $('#pal');
    pal.classList.toggle('projected', !!v.projected); // (beamed down by the drone)
    pal.style.setProperty('--scan-to', `${pal.offsetHeight}px`);
    pal.style.animation = 'none';
    void pal.offsetWidth;
    pal.style.animation = '';
    ipc.paletteSize(document.body.scrollHeight);
  }

  function select(i: number) {
    index = Math.max(0, Math.min(items.length - 1, i));
    for (const r of list.querySelectorAll<HTMLElement>('.item'))
      r.classList.toggle('on', Number(r.dataset.i) === index);
  }
  function pick(i: number) {
    const it = items[i];
    if (it) ipc.palettePick(it.id);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipc.paletteClose();
    else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey))
      select(index + 1 >= items.length ? 0 : index + 1);
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey))
      select(index - 1 < 0 ? items.length - 1 : index - 1);
    else if (e.key === 'Enter') pick(index);
    else if (/^[1-9]$/.test(e.key)) pick(Number(e.key) - 1);
    else return;
    e.preventDefault();
  });

  ipc.on('palette:open', render);
  ipc.paletteInit().then(render);
})();
