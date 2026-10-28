// The Robot Workshop: your robots down the side, and the editor for the one picked (or a new
// one): its look (look.ts), its mind and habits, a live preview acting out the desk routine.
// The Settings page takes the editor's place (settings.ts).
import {
  ACCESSORIES,
  CLICK_HINTS,
  CLICK_OPENS,
  COLORS,
  DEMO,
  NAMES,
  PERMISSION_HINTS,
  SIZES,
  THEMES,
  WANDER_HINTS,
  WANDERS,
} from './choices';
import { KIT_DEFAULT } from './kit';
import { createLook, type LookApi } from './look';
import { createSettings, type SettingsApi } from './settings';
import type { Draft, Shown } from './types';
import { $ } from '@/lib/dom';
import { Office3D } from '@/office3d';
import { officeData, type Reaction, writeJson } from '@/office3d/protocol';
import type { PermissionMode, RobotSize, SoundLevel } from '@/types/model';
import { Icon } from '@/icons/icons';
import { showView } from '@/lib/page';
import markup from './workshop.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import './workshop.css';

import * as ipc from '@/ipc';

showView(markup, { title: 'C-Bot · Robot Workshop' });

(() => {
  // (what mgr:state said; till it first answers, these empty ones)
  let state: Shown = { characters: [], personalities: {}, permissionModes: {}, settings: {} };
  let selected: string | null = null; // character id, or null for "new"
  let draft!: Draft; // (blankDraft() or the robot's, before anything reads it)

  Office3D.mount($('#preview'), { stateEl: $('#preview'), moodEl: $('#stage'), width: 300, height: 290 });

  // the Settings page and the look (state and draft: read when used)
  const { renderSettings, showSettings }: SettingsApi = createSettings({
    get state() {
      return state;
    },
  });
  const { renderKit }: LookApi = createLook({
    get draft() {
      return draft;
    },
    update: (patch) => update(patch),
    wiggle: (cls) => wiggle(cls),
  });

  // Show off the desk routine: what the robot does while Claude Code works.
  let demoStep = 0;
  function demo() {
    const d = DEMO[demoStep++ % DEMO.length];
    const p = $('#preview');
    Object.assign(p.dataset, { screen: d.screen, pose: d.pose, mouth: d.mouth, eyes: d.eyes });
    $('#stage').classList.toggle('thinking', d.cls === 'thinking');
    $('#stage').classList.toggle('talking', d.cls === 'talking');
    Icon.text($('#stage-activity'), d.label);
  }
  demo();
  setInterval(demo, 2600);

  function blankDraft(): Draft {
    const used = new Set(state.characters.map((c) => c.name));
    return {
      name: NAMES.find((n) => !used.has(n)) || 'Robo',
      folder: '',
      personality: 'cheerful',
      color: COLORS[state.characters.length % COLORS.length],
      accessory: 'none',
      body: 'kit',
      kit: { ...KIT_DEFAULT },
      theme: 'classic',
      size: 'normal',
      permissionMode: 'default',
      model: '',
      clickOpens: 'chat',
      wanders: true,
    };
  }

  // ---------------------------------------------------------------- render

  function renderList() {
    const ul = $('#robot-list');
    ul.innerHTML = '';
    if (!state.characters.length) {
      ul.innerHTML = '<li class="empty-list">No robots yet. Build your first one! →</li>';
      return;
    }
    for (const c of state.characters) {
      const li = document.createElement('li');
      li.className = c.id === selected ? 'selected' : '';
      const folder = c.folder.split(/[\\/]/).filter(Boolean).pop() || '';
      li.innerHTML = `
        <span class="dot" style="background:${c.color}">${Icon('bot')}</span>
        <span class="meta"><b></b><small></small></span>
        <button class="eye-toggle ${c.visible ? '' : 'off'}" title="${c.visible ? 'Put away' : 'Put on desktop'}">${Icon(c.visible ? 'eye' : 'moon')}</button>
        <button class="bin" title="Delete this robot">${Icon('trash')}</button>`;
      $('b', li).textContent = c.name + (c.busy ? ' · working…' : '');
      $('small', li).textContent = folder;
      li.addEventListener('click', () => select(c.id));
      $('.eye-toggle', li).addEventListener('click', (e) => {
        e.stopPropagation();
        ipc.mgrVisible(c.id, !c.visible);
      });
      $('.bin', li).addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRobot(c.id, c.name);
      });
      ul.appendChild(li);
    }
  }

  function renderChips(
    container: HTMLElement,
    options: Record<string, string>,
    value: string,
    onPick: (key: string) => void,
  ) {
    container.innerHTML = '';
    for (const [key, label] of Object.entries(options)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === value));
      b.textContent = String(label).replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, ''); // (words only: clean chips)
      b.addEventListener('click', () => onPick(key));
      container.appendChild(b);
    }
  }

  function renderEditor() {
    const c = selected ? state.characters.find((x) => x.id === selected) : undefined; // (the robot selected)
    if (selected && !c) throw new Error(`The robot picked (${selected}) isn't in the list.`);
    const isNew = !c;
    $('#editor-title').textContent = isNew ? 'New robot' : `Tuning up ${c.name}`;
    $<HTMLInputElement>('#f-name').value = draft.name;

    const folderEl = $('#f-folder');
    folderEl.textContent = draft.folder || 'No folder yet';
    folderEl.title = draft.folder;
    folderEl.classList.toggle('empty', !draft.folder);

    renderChips(
      $('#f-personality'),
      Object.fromEntries(Object.entries(state.personalities).map(([k, p]) => [k, `${p.emoji} ${p.label}`])),
      draft.personality,
      (k) => update({ personality: k }),
    );
    renderChips($('#f-size'), SIZES, draft.size || 'normal', (k) => update({ size: k as RobotSize }));
    renderChips(
      $('#f-theme'),
      Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label])),
      draft.theme || 'classic',
      (k) => update({ theme: k as Draft['theme'], ...(THEMES[k].paint ? { color: THEMES[k].paint } : {}) }),
    );
    renderKit();
    const unlocked = Object.fromEntries(
      Object.entries(ACCESSORIES).filter(
        ([k]) => k !== 'gradcap' || state.settings.vocabRewards?.gradcap || draft.accessory === k,
      ),
    );
    renderChips($('#f-accessory'), unlocked, draft.accessory || 'none', (k) => update({ accessory: k }));
    renderChips($('#f-click'), CLICK_OPENS, draft.clickOpens || 'chat', (k) =>
      update({ clickOpens: k as Draft['clickOpens'] }),
    );
    $('#click-hint').textContent = CLICK_HINTS[draft.clickOpens || 'chat'];
    const wander = draft.wanders === false ? 'no' : 'yes';
    renderChips($('#f-wander'), WANDERS, wander, (k) => update({ wanders: k === 'yes' }));
    $('#wander-hint').textContent = WANDER_HINTS[wander];

    const sw = $('#f-color');
    sw.innerHTML = '';
    for (const col of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = col;
      b.title = col;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(col.toLowerCase() === draft.color.toLowerCase()));
      b.addEventListener('click', () => update({ color: col }));
      sw.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = draft.color;
    custom.title = 'Custom paint';
    custom.addEventListener('input', () => update({ color: custom.value }, { keepColorInput: true }));
    sw.appendChild(custom);

    const perm = $<HTMLSelectElement>('#f-permission');
    perm.innerHTML = '';
    for (const [k, label] of Object.entries(state.permissionModes))
      perm.add(new Option(label, k, false, k === draft.permissionMode));
    $<HTMLSelectElement>('#f-model').value = draft.model || '';
    const hint = $('#perm-hint');
    hint.textContent = PERMISSION_HINTS[draft.permissionMode] || '';
    hint.classList.toggle('warn', draft.permissionMode === 'bypassPermissions');

    $('#save').textContent = isNew ? 'Build it!' : 'Save changes';
    $('#toggle-visible').hidden = isNew;
    $('#forget').hidden = isNew;
    $('#delete').hidden = isNew;
    $<HTMLElement>('.danger-zone').hidden = isNew;
    if (!isNew) $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';

    $('#stats').textContent = isNew
      ? ''
      : `Asked ${c.stats?.questions || 0} question${c.stats?.questions === 1 ? '' : 's'} · poked ${c.stats?.pokes || 0} time${c.stats?.pokes === 1 ? '' : 's'}` +
        (c.stats?.costUsd ? ` · $${c.stats.costUsd.toFixed(2)} of thinking` : '');
    renderPreview();
  }

  function renderPreview() {
    const stage = $('#stage');
    stage.style.setProperty('--paint', draft.color);
    const shown = officeData($('#preview')); // (what the 3D preview shows: office3d/protocol.ts)
    shown.acc = draft.accessory || 'none';
    shown.body = draft.body || 'loopy';
    writeJson(shown, 'kit', draft.kit || {});
    shown.theme = draft.theme || 'classic';
    shown.name = draft.name;
    const p = state.personalities[draft.personality];
    $('#stage-speech').textContent = draft.name ? `${p?.emoji || ''} Hi, I'm ${draft.name}!` : 'Give me a name!';
  }

  // ---------------------------------------------------------------- actions

  function update(patch: Partial<Draft>, { keepColorInput = false } = {}) {
    Object.assign(draft, patch);
    $('#form-error').textContent = '';
    if (keepColorInput) {
      renderPreview();
      for (const b of document.querySelectorAll('#f-color button')) b.setAttribute('aria-checked', 'false');
    } else {
      renderEditor();
    }
    wiggle();
  }

  // ---------------------------------------------------------------- the editor's panes, and the look

  // Look (the robot itself), Mind (personality, brain, what it may do…), Habits (wandering)
  function showPane(p: string) {
    for (const b of document.querySelectorAll<HTMLElement>('.ed-tabs button'))
      b.setAttribute('aria-selected', String(b.dataset.pane === p));
    for (const s of document.querySelectorAll<HTMLElement>('.pane')) s.hidden = s.dataset.pane !== p;
  }
  for (const b of document.querySelectorAll<HTMLElement>('.ed-tabs button'))
    b.addEventListener('click', () => {
      const pane = b.dataset.pane;
      if (pane) showPane(pane); // (every tab has its data-pane)
    });

  function wiggle(cls: Reaction = 'squish') {
    const r = $('#preview');
    r.classList.remove(cls);
    void r.offsetWidth;
    r.classList.add(cls);
  }

  function select(id: string | null) {
    showSettings(false);
    if (!id) showPane('look'); // (a new robot: name and folder at the top, then how it looks)
    selected = id;
    const c = state.characters.find((x) => x.id === id);
    draft = c
      ? {
          name: c.name,
          folder: c.folder,
          personality: c.personality,
          color: c.color,
          accessory: c.accessory || 'none',
          body: 'kit',
          kit: { ...KIT_DEFAULT, ...(c.kit || {}) },
          theme: c.theme || 'classic',
          size: c.size || 'normal',
          permissionMode: c.permissionMode,
          model: c.model || '',
          clickOpens: c.clickOpens || 'chat',
          wanders: c.wanders !== false,
        }
      : blankDraft();
    $('#form-error').textContent = '';
    renderList();
    renderEditor();
    wiggle('hop');
  }

  async function refresh() {
    state = await ipc.mgrState();
    if (selected && !state.characters.some((c) => c.id === selected)) selected = null;
    if (!draft) draft = blankDraft();
    renderList();
    renderSettings();
    // keep in-progress edits; only refresh the bits that come from the robot (if one is
    // selected, it's still there: checked above)
    const c = selected ? state.characters.find((x) => x.id === selected) : undefined;
    if (c) {
      $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';
      $('#editor-title').textContent = `Tuning up ${c.name}`;
    }
  }

  $('#f-name').addEventListener('input', (e) => {
    draft.name = (e.target as HTMLInputElement).value;
    renderPreview();
  });
  $('#f-permission').addEventListener('change', (e) =>
    update({ permissionMode: (e.target as HTMLSelectElement).value as PermissionMode }),
  );
  $('#f-model').addEventListener('change', (e) => update({ model: (e.target as HTMLSelectElement).value }));
  $('#pick-folder').addEventListener('click', async () => {
    const folder = await ipc.mgrPickFolder(draft.folder);
    if (folder) update({ folder });
  });
  $('#preview').addEventListener(
    'click',
    () => $('#preview').dataset.dragged || wiggle(Math.random() < 0.5 ? 'squish' : 'spin'),
  );
  $('#new-robot').addEventListener('click', () => select(null));
  $('#sounds').addEventListener('change', (e) =>
    ipc.mgrSettings({ sounds: (e.target as HTMLSelectElement).value as SoundLevel }),
  );
  $('#theme').addEventListener('change', (e) => ipc.mgrSettings({ theme: (e.target as HTMLSelectElement).value }));
  $('#theme-mode').addEventListener('change', (e) =>
    ipc.mgrSettings({ themeMode: (e.target as HTMLSelectElement).value }),
  );

  $('#editor').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      $('#f-name').focus();
      $('#form-error').textContent = 'Every robot deserves a name.';
      return;
    }
    if (!draft.folder) {
      $('#pick-folder').focus();
      $('#form-error').textContent = 'Pick a home folder so the robot knows where to work.';
      return;
    }
    if (selected) {
      await ipc.mgrUpdate(selected, draft);
      $('#stage-speech').textContent = 'Ooh, I feel brand new!';
    } else {
      const c = await ipc.mgrCreate(draft);
      selected = c.id;
      await refresh();
      renderEditor();
      $('#stage-speech').textContent = `${draft.name} is on your desktop! Click me there to wake me up.`;
    }
    wiggle('hop');
  });

  $('#toggle-visible').addEventListener('click', () => {
    const c = state.characters.find((x) => x.id === selected);
    if (c) ipc.mgrVisible(c.id, !c.visible);
  });
  $('#forget').addEventListener('click', async () => {
    if (!selected) return; // (only shown for a robot)
    if (!confirm(`Wipe ${draft.name}'s memory of your conversation?`)) return;
    await ipc.mgrReset(selected);
    $('#stage-speech').textContent = 'Wait… who am I? Where am I?';
    wiggle('spin');
  });
  // delete a robot (asks first; its folder and files are left alone)
  async function deleteRobot(id: string, name: string) {
    if (
      !confirm(
        `Delete ${name}? It's gone for good. Its folder, its files and its Claude Code conversations are not touched.`,
      )
    )
      return;
    await ipc.mgrDelete(id);
    if (id === selected) {
      selected = null;
      draft = blankDraft();
    }
    await refresh();
    renderEditor();
  }
  $('#delete').addEventListener('click', () => {
    if (selected) deleteRobot(selected, draft.name); // (only shown for a robot)
  });

  ipc.on('mgr:changed', refresh);
  ipc.on('mgr:focus', (id) => select(id === 'new' ? null : id));

  (async () => {
    await refresh();
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus && focus !== 'new' && state.characters.some((c) => c.id === focus)) select(focus);
    else if (!focus && state.characters.length) select(state.characters[0].id);
    else select(null);
  })();
})();
