// The Settings page, in place of the robot editor: where Claude Code is, the shortcuts (click
// one to record new keys), sounds and theme, notes and reminders.
// (workshop.ts calls createSettings.)
import { SOUNDS_HINT } from './choices';
import type { Shown } from './types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { WorkshopHotkey, WorkshopSettings } from '@/types/pages';
import { Icon } from '@/icons/icons';

/** What it uses of the Workshop. */
export type SettingsNeeds = { readonly state: Shown };

export function createSettings(shop: SettingsNeeds) {
  // Where Claude Code is. It's found by itself almost always (main findClaude.js);
  // if not: search again after installing it, an install command to copy, or pick it by hand.
  const WIN = /Windows/i.test(navigator.userAgent);
  const INSTALL = WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  let claudeNote = ''; // what the last search or pick said
  function renderClaude() {
    const el = $('#claude-status');
    const path = shop.state.claudePath;
    const found = !!path;
    el.innerHTML = found
      ? '<span class="ok">● Claude Code found</span><code class="path"></code><small class="from"></small>'
      : `<span class="bad">● Claude Code not found</span>
         <small>I looked everywhere it usually goes. Install it (${WIN ? 'in PowerShell' : 'in a terminal'}), then search again:</small>
         <div class="install"><code></code><button type="button" class="copy" title="Copy">Copy</button></div>`;
    if (path) {
      $('.path', el).textContent = path;
      $('.from', el).textContent = shop.state.claudeSource ? `from: ${shop.state.claudeSource}` : '';
    } else {
      $('.install code', el).textContent = INSTALL;
      $('.copy', el).addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(INSTALL);
          (e.target as Element).textContent = 'Copied!';
        } catch {
          (e.target as Element).textContent = 'Select it ↑';
        }
      });
    }
    const row = document.createElement('div');
    row.className = 'row';
    const search = document.createElement('button');
    search.type = 'button';
    search.textContent = found ? 'Search again' : '🔍 Search again';
    search.addEventListener('click', async () => {
      search.disabled = true;
      search.textContent = 'Searching…';
      const r = await ipc.mgrFindClaude();
      claudeNote = r.claudePath ? '' : 'Still not found. Did the install finish?';
      Object.assign(shop.state, r);
      renderClaude();
    });
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = found ? 'Change…' : 'Locate it myself…';
    pick.addEventListener('click', async () => {
      const r = await ipc.mgrPickClaude();
      if (!r.ok && !r.error) return; // cancelled
      claudeNote = r.ok ? '' : r.error;
      if (r.ok) Object.assign(shop.state, { claudePath: r.path, claudeSource: 'picked by you' });
      renderClaude();
    });
    row.append(search, pick);
    el.appendChild(row);
    if (claudeNote) {
      const note = document.createElement('small');
      note.className = 'bad';
      note.textContent = claudeNote;
      el.appendChild(note);
    }
  }

  function renderSettings() {
    renderClaude();
    renderHotkeys();
    // the sidebar's reminder of the one hotkey to remember
    const menu = (shop.state.hotkeys || []).find((h) => h.setting === 'paletteHotkey');
    if (menu) Icon.text($('#side-hotkey'), `⌨️ ${menu.key}: every action`);
    $('#side-hotkey').classList.toggle('bad', menu?.ok === false);
    $<HTMLInputElement>('#drone').checked = shop.state.settings.paletteDrone !== false;
    // (drawn once main has answered: the settings are all there)
    const level = shop.state.settings.sounds;
    const sounds = level === 'all' || level === 'off' ? level : 'essential';
    $<HTMLSelectElement>('#sounds').value = sounds;
    $('#sounds-hint').textContent = SOUNDS_HINT[sounds];
    $<HTMLSelectElement>('#theme').value = shop.state.settings.theme === 'vintage' ? 'vintage' : 'future';
    const mode = shop.state.settings.themeMode;
    $<HTMLSelectElement>('#theme-mode').value = mode === 'light' || mode === 'dark' ? mode : 'auto';
    renderNotesSettings();
  }

  // ---- the Settings page: opened from the sidebar, it takes the place of the robot editor
  function showSettings(open: boolean) {
    $('main').classList.toggle('settings-open', open);
    $('#app-settings').hidden = !open;
    $('#open-settings').setAttribute('aria-pressed', String(open));
  }
  $('#open-settings').addEventListener('click', () => showSettings($('#app-settings').hidden as boolean)); // (never 'until-found' here)
  $('#close-settings').addEventListener('click', () => showSettings(false));
  $('#side-hotkey').addEventListener('click', () => showSettings(true));
  $('#drone').addEventListener('change', (e) =>
    ipc.mgrSettings({ paletteDrone: (e.target as HTMLInputElement).checked }),
  );

  // ---- shortcuts: every hotkey, its keys (click to record new ones), whether it works
  let recording: { setting: WorkshopHotkey['setting']; button: HTMLElement; was: string } | null = null; // { setting, button } while you're pressing new keys
  const KEY_NAMES: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    '+': 'Plus',
  };
  function renderHotkeys() {
    const box = $('#hotkeys');
    if (recording) return; // (don't redraw under the one you're recording)
    box.innerHTML = '';
    for (const h of shop.state.hotkeys || []) {
      const row = document.createElement('div');
      row.className = 'hk';
      row.innerHTML =
        '<div class="hk-what"><b></b><small></small></div><button type="button" class="hk-key"></button><span class="hk-state"></span><button type="button" class="hk-reset"></button>';
      $('b', row).textContent = h.label;
      $('small', row).textContent = h.what;
      const key = $<HTMLElement>('.hk-key', row);
      key.textContent = h.key;
      key.title = 'Click, then press the new keys';
      key.addEventListener('click', () => startRecording(h, key));
      const st = $('.hk-state', row);
      Icon.text(st, h.ok ? '✅ Works' : '⚠️ Taken by another app');
      st.classList.toggle('bad', !h.ok);
      const reset = $<HTMLElement>('.hk-reset', row);
      reset.innerHTML = Icon('reset', 'sm');
      reset.title = `Back to ${h.def}`;
      reset.hidden = h.key === h.def;
      reset.addEventListener('click', () => ipc.mgrSettings({ [h.setting]: '' }));
      box.append(row);
    }
  }
  function startRecording(h: WorkshopHotkey, button: HTMLElement) {
    stopRecording();
    recording = { setting: h.setting, button, was: button.textContent };
    button.classList.add('recording');
    button.textContent = 'Press the keys…';
  }
  function stopRecording(save?: string) {
    if (!recording) return;
    const { setting, button, was } = recording;
    recording = null;
    button.classList.remove('recording');
    if (save) {
      button.textContent = save;
      ipc.mgrSettings({ [setting]: save });
    } else button.textContent = was;
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stopRecording();
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return; // (wait for the real key)
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
      if (!e.ctrlKey && !e.altKey) {
        recording.button.textContent = 'Use Ctrl or Alt with it…';
        return;
      }
      const k =
        KEY_NAMES[e.key] ||
        (/^F\d{1,2}$/.test(e.key)
          ? e.key
          : e.code.startsWith('Key')
            ? e.code.slice(3)
            : e.code.startsWith('Digit')
              ? e.code.slice(5)
              : e.key.length === 1
                ? e.key.toUpperCase()
                : e.key);
      stopRecording([...mods, k].join('+'));
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => recording && !(e.target as Element).closest('.hk-key') && stopRecording(),
    true,
  );

  // ---- notes & reminders (main notes.js)
  const DAYS: [number, string][] = [
    [1, 'M'],
    [2, 'T'],
    [3, 'W'],
    [4, 'T'],
    [5, 'F'],
    [6, 'S'],
    [0, 'S'],
  ];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const noteSet = (patch: Partial<WorkshopSettings>) => ipc.mgrSettings(patch);
  function renderNotesSettings() {
    const s = { ...(shop.state.notes?.defaults || {}), ...shop.state.settings };
    const typing = (el: HTMLElement) => document.activeElement === el; // (don't fight what you're typing)
    $<HTMLInputElement>('#n-reminders').checked = s.notesReminders !== false;
    if (!typing($('#n-evening'))) $<HTMLInputElement>('#n-evening').value = s.notesEvening || '17:30';
    $<HTMLInputElement>('#n-morning').checked = s.notesMorning !== false;
    $<HTMLInputElement>('#n-carry').checked = s.notesCarry !== false;
    for (const el of ['#n-evening', '#n-morning', '#n-carry'])
      $<HTMLInputElement>(el).disabled = s.notesReminders === false;
    $('#n-days').replaceChildren(
      ...DAYS.map(([d, l]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = l;
        b.setAttribute('aria-label', DAY_NAMES[d]);
        b.setAttribute('aria-pressed', String((s.notesWorkdays || []).includes(d)));
        b.addEventListener('click', () => {
          const days = new Set(s.notesWorkdays || []);
          days.has(d) ? days.delete(d) : days.add(d);
          noteSet({ notesWorkdays: [...days].sort() });
        });
        return b;
      }),
    );
    const robotSel = $<HTMLSelectElement>('#n-robot');
    robotSel.replaceChildren(
      new Option('the nearest robot', ''),
      ...shop.state.characters.map((c) => new Option(c.name, c.id)),
    );
    const robot = s.notesRobot;
    robotSel.value = robot && shop.state.characters.some((c) => c.id === robot) ? robot : '';
    $<HTMLSelectElement>('#n-board').value = s.notesBoard === 'one' ? 'one' : 'all';
    $<HTMLSelectElement>('#n-board').disabled = !robotSel.value;
  }
  $('#n-reminders').addEventListener('change', (e) =>
    noteSet({ notesReminders: (e.target as HTMLInputElement).checked }),
  );
  $('#n-evening').addEventListener(
    'change',
    (e) => (e.target as HTMLInputElement).value && noteSet({ notesEvening: (e.target as HTMLInputElement).value }),
  );
  $('#n-morning').addEventListener('change', (e) => noteSet({ notesMorning: (e.target as HTMLInputElement).checked }));
  $('#n-carry').addEventListener('change', (e) => noteSet({ notesCarry: (e.target as HTMLInputElement).checked }));
  $('#n-robot').addEventListener('change', (e) => noteSet({ notesRobot: (e.target as HTMLSelectElement).value }));
  $('#n-board').addEventListener('change', (e) =>
    noteSet({ notesBoard: (e.target as HTMLSelectElement).value as 'all' | 'one' }),
  );
  return { renderSettings, showSettings };
}
export type SettingsApi = ReturnType<typeof createSettings>;
