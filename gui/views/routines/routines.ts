// The Routines window (main features/routines/): prompts a robot runs on a schedule, to add,
// change, switch on or off and run now, and a run's result. Every change comes back as
// routines:list, so the list is always what's saved.
import { $, el } from '@/lib/dom';
import { markdown } from '@/lib/markdown';
import { esc } from '@/lib/text';
import type { RoutineShow, RoutineWhen } from '@/types/model';
import type { RoutinesFocus, RoutineView } from '@/types/pages';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './routines.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './routines.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'Routines' });

(() => {
  const act = ipc.routinesAct;
  const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // a start for the prompt: [label, emoji, name, prompt]
  const TEMPLATES: [string, string, string, string][] = [
    [
      'News',
      '📰',
      'Morning news',
      "Search the web for today's news on <topic>. Give me the top 5 stories: one line each, with the source and a link. Skip anything older than a day.",
    ],
    [
      'Pull requests',
      '🔀',
      'PR check',
      'Check my open pull requests on GitHub (with the gh CLI): which need my review, which have failing checks, which are waiting on someone else. Short, with links.',
    ],
    [
      'My notes',
      '📒',
      'Plan my day',
      'Look at my open notes (list_notes) and tell me the three I should do first today, and why. Keep it short.',
    ],
    [
      'Weather',
      '🌤️',
      'Weather',
      "Look up today's weather forecast for <city>: the temperature, the chance of rain, and whether I need an umbrella. Two lines.",
    ],
  ];

  const md = markdown().html;

  let routines: RoutineView[] = [];
  let robots: { id: string; name: string }[] = [];
  let here: string | null = null; // the robot it's beside
  let focus: RoutinesFocus = { view: 'list' };
  // the editor's picks
  let kind: RoutineWhen['kind'] = 'daily';
  let days = new Set<number>();
  let times: string[] = [];
  let show: RoutineShow = 'card';
  let toastTimer = 0;

  const byId = (id?: string) => routines.find((r) => r.id === id);
  const when = (t: number) =>
    new Date(t).toLocaleString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  function toast(text: string) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.hidden = true), 2400);
  }

  function go(f: RoutinesFocus) {
    // (a routine that's gone: the list)
    focus = f.view !== 'list' && f.id && !byId(f.id) ? { view: 'list' } : f;
    if (focus.view === 'edit') fill(byId(focus.id));
    render();
  }

  function render() {
    const r = byId(focus.id);
    $('#btn-back').hidden = focus.view === 'list';
    $('#v-list').hidden = focus.view !== 'list';
    $('#v-edit').hidden = focus.view !== 'edit';
    $('#v-result').hidden = focus.view !== 'result';
    const title =
      focus.view === 'list'
        ? 'Routines'
        : focus.view === 'edit' && !r
          ? 'New routine'
          : `${r?.emoji || '⏰'} ${r?.name ?? ''}`;
    const h1 = $('#title');
    h1.innerHTML = `${focus.view === 'list' ? Icon('clock') : ''}<span>${esc(title)}</span>`;
    const on = routines.filter((x) => x.on).length;
    $('#count').hidden = focus.view !== 'list' || !on;
    $('#count').textContent = String(on);
    if (focus.view === 'list') renderList();
    if (focus.view === 'result' && r) renderResult(r);
  }

  // ---------------------------------------------------------------- the list

  function lastLine(r: RoutineView) {
    if (r.running) return `<span class="busy">⏳ Running…</span>`;
    const parts: string[] = [];
    if (r.last?.outcome === 'done')
      parts.push(`<span class="ok">✓ ${esc(when(r.last.at))}</span><button type="button" data-result>Result</button>`);
    else if (r.last)
      parts.push(
        `<span class="bad" title="${esc(r.last.text)}">✗ ${esc(when(r.last.at))}: didn't run</span><button type="button" data-result>Why</button>`,
      );
    if (r.on && r.next[0]) parts.push(`<span>next ${esc(r.next[0])}</span>`);
    if (!r.on) parts.push('<span>Off</span>');
    return parts.join('');
  }

  function renderList() {
    const list = $('#list');
    list.replaceChildren(
      ...routines.map((r) => {
        const row = el('li', `routine${r.on ? '' : ' off'}`);
        row.innerHTML = `
          <span class="emoji">${esc(r.emoji || '⏰')}</span>
          <span class="name">${esc(r.name)}</span>
          <span class="ctl">
            <button type="button" class="run" title="Run now" ${r.running ? 'disabled' : ''}>${Icon('zap')}</button>
            <button type="button" class="switch${r.on ? ' on' : ''}" role="switch" aria-checked="${r.on}" title="On"></button>
          </span>
          <span class="when"><span class="chip">${esc(r.whenLabel)}</span><span>${esc(r.robotName || 'no robot')}</span></span>
          <span class="last">${lastLine(r)}</span>`;
        $('.run', row).onclick = (e) => {
          e.stopPropagation();
          runNow(r.id);
        };
        $('.switch', row).onclick = (e) => {
          e.stopPropagation();
          act('toggle', { id: r.id, on: !r.on });
        };
        row.querySelector<HTMLButtonElement>('[data-result]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          go({ view: 'result', id: r.id });
        });
        row.onclick = () => go({ view: 'edit', id: r.id });
        return row;
      }),
    );
    $('#empty').hidden = routines.length > 0;
  }

  async function runNow(id: string) {
    try {
      await act('run', { id });
      toast('Running it now…');
    } catch (err) {
      toast(String(err));
    }
  }

  // ---------------------------------------------------------------- the editor

  function seg(id: string, value: string) {
    for (const b of document.querySelectorAll<HTMLButtonElement>(`#${id} button`))
      b.classList.toggle('on', b.dataset.v === value);
  }

  function renderWhen() {
    seg('f-kind', kind);
    $('#k-daily').hidden = kind !== 'daily';
    $('#k-every').hidden = kind !== 'every';
    $('#k-once').hidden = kind !== 'once';
    $('#f-days').hidden = kind === 'once';
    $('#f-days').innerHTML = DAYS.map(
      (d, i) =>
        `<button type="button" class="${days.has(i + 1) ? 'on' : ''}" data-day="${i + 1}" title="${DAY_NAMES[i]}">${d}</button>`,
    ).join('');
    $('#f-times').innerHTML = times
      .map(
        (t) =>
          `<span class="time">${esc(t)}<button type="button" data-time="${esc(t)}" title="Remove">${Icon('x')}</button></span>`,
      )
      .join('');
  }

  /** The editor, on this routine (none: a new one). */
  function fill(r?: RoutineView) {
    const w: RoutineWhen = r?.when ?? { kind: 'daily', days: [1, 2, 3, 4, 5], times: ['08:00'] };
    kind = w.kind;
    days = new Set(w.kind === 'once' ? [] : w.days.length ? w.days : [1, 2, 3, 4, 5, 6, 7]);
    times = w.kind === 'daily' ? [...w.times].sort() : ['08:00'];
    if (w.kind === 'every') {
      $<HTMLInputElement>('#f-hours').value = String(w.hours);
      $<HTMLInputElement>('#f-from').value = w.from;
      $<HTMLInputElement>('#f-to').value = w.to;
    }
    const tomorrow = new Date(Date.now() + 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    $<HTMLInputElement>('#f-at').value =
      w.kind === 'once'
        ? w.at
        : `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T09:00`;
    show = r?.show ?? 'card';
    seg('f-show', show);
    $<HTMLInputElement>('#f-name').value = r?.name ?? '';
    $<HTMLInputElement>('#f-emoji').value = r?.emoji ?? '';
    $<HTMLTextAreaElement>('#f-prompt').value = r?.prompt ?? '';
    $<HTMLInputElement>('#f-catchup').checked = r?.catchUp ?? true;
    $<HTMLInputElement>('#f-limit').value = String(r?.limitMin ?? 10);
    const pick = $<HTMLSelectElement>('#f-robot');
    pick.innerHTML = robots.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
    pick.value = r?.robot ?? here ?? robots[0]?.id ?? '';
    $('#btn-delete').hidden = !r;
    $('#btn-delete span').textContent = 'Delete';
    $('#error').hidden = true;
    renderWhen();
    if (!r) setTimeout(() => $('#f-name').focus());
  }

  function draft() {
    const d = [...days].sort();
    const w: RoutineWhen =
      kind === 'once'
        ? { kind, at: $<HTMLInputElement>('#f-at').value }
        : kind === 'every'
          ? {
              kind,
              hours: Number($<HTMLInputElement>('#f-hours').value) || 0,
              from: $<HTMLInputElement>('#f-from').value,
              to: $<HTMLInputElement>('#f-to').value,
              days: d.length === 7 ? [] : d,
            }
          : { kind, times, days: d.length === 7 ? [] : d };
    return {
      id: focus.id ?? null,
      name: $<HTMLInputElement>('#f-name').value,
      emoji: $<HTMLInputElement>('#f-emoji').value,
      robot: $<HTMLSelectElement>('#f-robot').value,
      prompt: $<HTMLTextAreaElement>('#f-prompt').value,
      when: w,
      show,
      catchUp: $<HTMLInputElement>('#f-catchup').checked,
      limitMin: Number($<HTMLInputElement>('#f-limit').value) || 10,
    };
  }

  async function save(run: boolean) {
    if (kind !== 'once' && !days.size) return showError('Pick at least one day.');
    try {
      const id = await act('save', draft());
      if (run) await act('run', { id });
      toast(run ? 'Saved. Running it now…' : 'Saved.');
      go({ view: 'list' });
    } catch (err) {
      showError(String(err));
    }
  }

  function showError(text: string) {
    $('#error').textContent = text;
    $('#error').hidden = false;
  }

  function addTime() {
    const box = $<HTMLInputElement>('#f-time');
    if (box.value && !times.includes(box.value)) times = [...times, box.value].sort();
    box.value = '';
    renderWhen();
  }

  $('#f-kind').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    kind = b.dataset.v as RoutineWhen['kind']; // (the markup's data-v are the kinds)
    renderWhen();
  };
  $('#f-show').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    show = b.dataset.v as RoutineShow; // (the markup's data-v are the ways to show it)
    seg('f-show', show);
  };
  $('#f-days').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
    if (!b) return;
    const d = Number(b.dataset.day);
    if (!days.delete(d)) days.add(d);
    renderWhen();
  };
  $('#f-times').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-time]');
    if (!b) return;
    times = times.filter((t) => t !== b.dataset.time);
    renderWhen();
  };
  $('#btn-time').onclick = addTime;
  $('#f-time').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTime();
  };
  $('#templates').innerHTML = TEMPLATES.map(
    ([label, emoji], i) => `<button type="button" data-t="${i}">${emoji} ${esc(label)}</button>`,
  ).join('');
  $('#templates').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-t]');
    if (!b) return;
    const [, emoji, name, prompt] = TEMPLATES[Number(b.dataset.t)];
    $<HTMLTextAreaElement>('#f-prompt').value = prompt;
    if (!$<HTMLInputElement>('#f-name').value) $<HTMLInputElement>('#f-name').value = name;
    if (!$<HTMLInputElement>('#f-emoji').value) $<HTMLInputElement>('#f-emoji').value = emoji;
    // (the part to fill in, selected)
    const box = $<HTMLTextAreaElement>('#f-prompt');
    const at = prompt.indexOf('<');
    box.focus();
    if (at >= 0) box.setSelectionRange(at, prompt.indexOf('>', at) + 1);
  };
  $('#v-edit').onsubmit = (e) => {
    e.preventDefault();
    save(false);
  };
  $('#btn-save-run').onclick = () => save(true);
  $('#btn-cancel').onclick = () => go({ view: 'list' });
  // (a second click deletes)
  $('#btn-delete').onclick = async () => {
    const label = $('#btn-delete span');
    if (!focus.id) return;
    if (label.textContent !== 'Delete it?') {
      label.textContent = 'Delete it?';
      return;
    }
    await act('delete', { id: focus.id });
    go({ view: 'list' });
  };

  // ---------------------------------------------------------------- a result

  function renderResult(r: RoutineView) {
    const box = $('#r-text');
    const failed = r.last?.outcome === 'failed';
    box.classList.toggle('failed', failed);
    if (r.running) {
      $('#r-when').textContent = `⏳ ${r.robotName} is running it now…`;
      box.innerHTML = r.last ? md(r.last.text) : '';
    } else if (!r.last) {
      $('#r-when').textContent = "It hasn't run yet.";
      box.innerHTML = '';
    } else {
      $('#r-when').textContent =
        `${failed ? "Didn't run" : 'Ran'} ${when(r.last.at)}${r.robotName ? ` · ${r.robotName}` : ''}`;
      box.innerHTML = failed ? `<p>${esc(r.last.text)}</p>` : md(r.last.text);
    }
    $<HTMLButtonElement>('#btn-note').disabled = !r.last || failed;
    $<HTMLButtonElement>('#btn-again').disabled = r.running;
  }

  $('#btn-chat').onclick = () => {
    if (focus.id) act('chat', { id: focus.id });
  };
  $('#btn-note').onclick = async () => {
    if (!focus.id) return;
    try {
      await act('note', { id: focus.id });
      toast('📝 Noted down.');
    } catch (err) {
      toast(String(err));
    }
  };
  $('#btn-again').onclick = () => {
    if (focus.id) runNow(focus.id);
  };

  // ---------------------------------------------------------------- the window

  $('#btn-new').onclick = () => go({ view: 'edit' });
  $('#btn-back').onclick = () => go({ view: 'list' });
  $('#btn-close').onclick = () => act('close');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (focus.view === 'edit') go({ view: 'list' });
    else act('close');
  });

  ipc.on('routines:list', (v) => {
    routines = v.routines || [];
    robots = v.robots || [];
    if (focus.view !== 'edit') go(focus); // (the editor keeps what you're typing)
  });
  ipc.on('routines:open', go);

  (async () => {
    const init = await ipc.routinesInit();
    if (!init) return;
    routines = init.routines || [];
    robots = init.robots || [];
    here = init.robot;
    go(init.focus || { view: 'list' });
  })();
})();
