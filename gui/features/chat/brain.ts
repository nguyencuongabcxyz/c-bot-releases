// The brain bar under the chat: the model, the effort, the permission mode, and how full its
// memory is (compacting it when it gets full).
// (robot.ts calls createBrain with its hub.)
import { pick } from '@/lib/random';
import type { ChatLogApi } from './log';
import type { CommentaryApi } from './reply/commentary';
import type { FaceApi } from '@/views/robot/life/face';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { AskingApi } from './reply/ask';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import { MODES } from './plan/modes';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { OfficeData } from '@/office3d/protocol';
import type { ModelChoice, PermissionMode } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type BrainNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly addBot: ChatLogApi['addBot'];
  readonly addNote: CommentaryApi['addNote'];
  readonly animates: CommentaryApi['animates'];
  readonly body: HTMLElement;
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly input: HTMLTextAreaElement;
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly setBusy: AskingApi['setBusy'];
  readonly setTabStatus: CommentaryApi['setTabStatus'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly uid: AskingApi['uid'];
};

export function createBrain(rw: BrainNeeds) {
  const brainInfo: { models: ModelChoice[] } = { models: [] };
  const FALLBACK_MODELS: (Omit<ModelChoice, 'efforts'> & { efforts?: string[] })[] = [
    { value: '', displayName: 'Default', description: "Claude Code's recommended model" },
    { value: 'opus', displayName: 'Opus', description: 'For complex work' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
  ];
  const EFFORTS: Record<string, [string, string]> = {
    low: ['☕', 'Taking it easy'],
    medium: ['🙂', 'Normal focus'],
    high: ['💪', 'Thinking harder'],
    xhigh: ['🔥', 'Full focus'],
    max: ['🤯', 'MAXIMUM BRAINPOWER'],
  };
  const EFFORT_ICONS: Record<string, string> = {
    low: 'signal-low',
    medium: 'signal-medium',
    high: 'signal-high',
    xhigh: 'signal',
    max: 'rocket',
  };
  const models = (): (typeof FALLBACK_MODELS)[number][] =>
    brainInfo.models.length ? brainInfo.models : FALLBACK_MODELS;
  const modelName = (v?: string) =>
    (models().find((m) => m.value === (v || '')) || { displayName: v || 'Default' }).displayName.replace(
      /\s*\(recommended\)/i,
      '',
    );

  async function loadBrain(tab: ChatTab) {
    const info = await ipc.robotBrain(tab.id);
    if (!info) return;
    if (info.models?.length) brainInfo.models = info.models;
    tab.model = info.model;
    tab.effort = info.effort;
    tab.mode = info.permissionMode;
    tab.canBypass = info.canBypass;
    if (info.context) tab.context = info.context;
    if (tab === rw.active()) renderBrain();
  }

  function renderBrain() {
    const t = rw.active();
    if (!t) return;
    // (mono readouts: an icon, the value, a caret)
    $('#brain-model').innerHTML = `${Icon('cpu')}<span></span><span class="caret">▼</span>`;
    $('#brain-model').children[1].textContent = modelName(t.model);
    $('#brain-effort').innerHTML = `${Icon('zap')}<span>${t.effort || 'auto'}</span><span class="caret">▼</span>`;
    // its permission mode, plan mode standing out (and the box you type in with it)
    const mode = modeOf(t);
    $('#brain-mode').innerHTML = `${Icon(MODES[mode][0])}<span></span><span class="caret">▼</span>`;
    $('#brain-mode').children[1].textContent = MODES[mode][1];
    $('#brain-mode').dataset.mode = mode;
    rw.body.classList.toggle('plan-mode', mode === 'plan');
    rw.input.placeholder =
      mode === 'plan' ? 'Plan something with me… (Shift+Tab: mode)' : 'Ask me something… (/ for commands, @ for files)';
    const meter = $('#brain-meter');
    const ctx = t.context;
    const pct = ctx ? Math.max(0, Math.min(100, ctx.percentage)) : null;
    $<HTMLElement>('.bm-bar i', meter).style.width = `${pct ?? 0}%`;
    $('.bm-pct', meter).textContent = pct === null ? '–' : `${pct}%`;
    meter.classList.toggle('warm', (pct ?? 0) >= 60 && (pct ?? 0) < 80);
    meter.classList.toggle('full', (pct ?? 0) >= 80);
    meter.title = ctx
      ? `Memory: ${Math.round(ctx.totalTokens / 1000)}k of ${Math.round(ctx.maxTokens / 1000)}k tokens${ctx.autoCompact && ctx.autoCompactAt ? ` · auto-squishes near ${Math.round((ctx.autoCompactAt / ctx.maxTokens) * 100)}%` : ''}\nClick for options`
      : 'Memory: ask me something first';
    // the 3D robot shows its brain: eye colour per model, a headband at high effort, steam when full
    rw.deskState.model = t.model || 'default';
    rw.deskState.effort = t.effort || '';
    rw.deskState.brain = (pct ?? 0) >= 80 ? 'full' : '';
    if ((pct ?? 0) >= 80 && !t.warnedFull && t === rw.active()) {
      t.warnedFull = true;
      rw.showPop('My head is getting full… /compact?', 3000);
    }
    if ((pct ?? 0) < 60) t.warnedFull = false;
  }

  const menuEl = $('#menu');
  function openMenu(
    anchor: HTMLElement,
    title: string,
    items: { icon?: string; label: string; desc?: string; value: string; on?: boolean }[],
    onPick: (value: string) => void,
  ) {
    menuEl.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'menu-title';
    h.textContent = title;
    menuEl.appendChild(h);
    for (const it of items) {
      const el = document.createElement('div');
      el.className = `menu-item${it.on ? ' on' : ''}${it.icon ? ' has-icon' : ''}`;
      el.setAttribute('role', 'menuitem');
      el.innerHTML = `${it.icon ? Icon(it.icon) : ''}<b></b><small></small>`;
      $('b', el).textContent = it.label;
      $('small', el).textContent = it.desc || '';
      el.addEventListener('click', () => {
        closeMenu();
        onPick(it.value);
      });
      menuEl.appendChild(el);
    }
    menuEl.hidden = false;
    const a = anchor.getBoundingClientRect();
    const box = $('#panel').getBoundingClientRect();
    menuEl.style.left = `${Math.min(a.left - box.left, box.width - menuEl.offsetWidth - 10)}px`;
    menuEl.style.top = `${a.top - box.top - menuEl.offsetHeight - 6}px`;
  }
  function closeMenu() {
    menuEl.hidden = true;
  }
  document.addEventListener('mousedown', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target as Element) && !(e.target as Element).closest('#brainbar'))
      closeMenu(); // (a press lands on an element)
  });

  function openModelMenu() {
    const t = rw.current();
    openMenu(
      $('#brain-model'),
      'Brain (model) for this tab',
      models().map((m) => ({
        label: m.displayName,
        desc: m.description,
        value: m.value,
        on: (t.model || '') === m.value,
      })),
      (v) => setBrain(t, { model: v }),
    );
  }
  function openEffortMenu() {
    const t = rw.current();
    const allowed = models().find((m) => m.value === (t.model || ''))?.efforts;
    const levels = Object.keys(EFFORTS).filter((l) => !allowed?.length || allowed.includes(l));
    openMenu(
      $('#brain-effort'),
      'How hard I think (effort)',
      [
        { icon: 'zap', label: 'auto', desc: "Claude Code's default", value: '', on: !t.effort },
        ...levels.map((l) => ({ icon: EFFORT_ICONS[l], label: l, desc: EFFORTS[l][1], value: l, on: t.effort === l })),
      ],
      (v) => setBrain(t, { effort: v }),
    );
  }
  function openMemoryMenu() {
    const t = rw.current();
    openMenu(
      $('#brain-meter'),
      'Memory (context)',
      [
        {
          icon: 'collapse',
          label: 'Compact now',
          desc: 'Squish the conversation into a summary to free up room',
          value: 'compact',
        },
        { icon: 'gauge', label: 'What’s in my head?', desc: 'How full my memory is', value: 'context' },
      ],
      (v) => (v === 'compact' ? compactTab(t) : showContext(t)),
    );
  }
  const modeOf = (t: ChatTab): PermissionMode => t.mode || rw.state.character?.permissionMode || 'default';
  // the modes this tab may switch to, in Shift+Tab order (full access only where the robot is trusted with it)
  const modesFor = (t: ChatTab) =>
    (Object.keys(MODES) as PermissionMode[]).filter((m) => m !== 'bypassPermissions' || t.canBypass || modeOf(t) === m);
  function openModeMenu() {
    const t = rw.current();
    openMenu(
      $('#brain-mode'),
      'Permissions for this tab (Shift+Tab)',
      modesFor(t).map((m) => ({
        icon: MODES[m][0],
        label: MODES[m][1],
        desc: MODES[m][2],
        value: m,
        on: modeOf(t) === m,
      })),
      (v) => setBrain(t, { permissionMode: v as PermissionMode }),
    );
  }
  function cycleMode() {
    const t = rw.current();
    const all = modesFor(t);
    setBrain(t, { permissionMode: all[(all.indexOf(modeOf(t)) + 1) % all.length] });
  }
  $('#brain-mode').addEventListener('click', openModeMenu);
  $('#brain-model').addEventListener('click', openModelMenu);
  $('#brain-effort').addEventListener('click', openEffortMenu);
  $('#brain-meter').addEventListener('click', openMemoryMenu);

  function pickModel(arg: string) {
    const q = arg.toLowerCase();
    const m = models().find(
      (x) => x.value === q || x.displayName.toLowerCase().startsWith(q) || (q === 'default' && !x.value),
    );
    if (m) setBrain(rw.current(), { model: m.value });
    else
      rw.addNote(
        `🧠 I don't know a model called “${arg}”. Try: ${models()
          .map((x) => x.value || 'default')
          .join(', ')}`,
      );
  }
  function pickEffort(arg: string) {
    const l = arg.toLowerCase();
    if (l === 'auto' || EFFORTS[l]) setBrain(rw.current(), { effort: l === 'auto' ? '' : l });
    else rw.addNote(`⚡ Effort can be: auto, ${Object.keys(EFFORTS).join(', ')}`);
  }

  // Swap the brain mid-chat: the robot spins, its monitor reboots and its eyes change colour.
  async function setBrain(
    tab: ChatTab,
    patch: { model: string } | { effort: string } | { permissionMode: PermissionMode },
  ) {
    if ('permissionMode' in patch && patch.permissionMode === modeOf(tab)) return;
    const res = await ipc.robotSetBrain(tab.id, patch);
    if (!res.ok) {
      rw.addNote(`🧠 Couldn't switch: ${res.error || 'unknown problem'}`, '', tab);
      return;
    }
    if ('permissionMode' in patch) tab.mode = patch.permissionMode;
    else Object.assign(tab, patch);
    if (tab === rw.active()) renderBrain();
    if ('permissionMode' in patch) {
      const mode = patch.permissionMode;
      rw.addNote(
        mode === 'plan'
          ? '📋 Plan mode: I look around and write a plan. Nothing changes until you approve it.'
          : `🔒 ${MODES[mode][1]}: ${MODES[mode][2].toLowerCase()}`,
        '',
        tab,
      );
      rw.flash(mode === 'plan' ? 'hop' : 'shake', 500);
      Sfx.swap();
      rw.showPop(
        mode === 'plan' ? pick(['Let me plan first!', 'Thinking cap on!', 'Blueprints out!']) : `${MODES[mode][1]}!`,
        1600,
      );
    }
    if ('model' in patch) {
      rw.addNote(`🧠 Brain swapped to ${modelName(patch.model)} for this tab`, '', tab);
      rw.flash('spin', 950);
      Sfx.swap();
      if (!rw.state.busy) rw.setActivity('boot', 900);
      rw.showPop(`🧠 ${modelName(patch.model)} installed!`, 2000);
    }
    if ('effort' in patch) {
      const [emoji, words] = EFFORTS[patch.effort] || ['⚡', 'Back to auto'];
      rw.addNote(`${emoji} Effort: ${patch.effort || 'auto'}`, '', tab);
      rw.flash(patch.effort === 'max' || patch.effort === 'xhigh' ? 'shake' : 'hop', 600);
      Sfx.swap();
      rw.showPop(`${emoji} ${words}!`, 1800);
    }
  }

  // /compact: the robot squishes its papers into a cube on the monitor.
  async function compactTab(tab: ChatTab | undefined) {
    if (!tab) return;
    if (tab.busy) {
      rw.showPop('Let me finish this first!', 1800);
      return;
    }
    const turnId = rw.uid();
    startCompact(tab);
    const res = await ipc.robotCompact(tab.id, turnId);
    if (!res.ok) finishCompact(tab, res.error);
  }

  function startCompact(tab: ChatTab) {
    if (tab.compacting) return;
    tab.compacting = true;
    tab.compactResult = null;
    if (!tab.busy) rw.setBusy(tab, true);
    rw.addNote('🗜️ Squishing my memory…', '', tab);
    rw.setTabStatus(tab, 'Compacting my memory…');
    tab.activity = 'compact';
    if (rw.animates(tab)) {
      rw.setActivity('compact');
      Sfx.crunch();
    }
  }

  function finishCompact(tab: ChatTab, error?: string) {
    if (!tab.compacting) return;
    tab.compacting = false;
    rw.setBusy(tab, false);
    if (error) {
      rw.addNote(`🗜️ Couldn't compact: ${error}`, '', tab);
      return;
    }
    const r = tab.compactResult;
    // (Claude Code doesn't always say how big it is after)
    const sizes = r?.pre
      ? r.post != null
        ? `: ${Math.round(r.pre / 1000)}k → ${Math.round(r.post / 1000)}k tokens`
        : ` (was ${Math.round(r.pre / 1000)}k tokens)`
      : '';
    rw.addNote(`🗜️ Compacted my memory${sizes}`, '', tab);
    if (rw.animates(tab)) {
      rw.setActivity('done', 2000);
      rw.flash('squish', 500);
      rw.express('happy', 'smile', 1500);
      Sfx.done();
      rw.showPop('Ahh, much lighter!', 2000);
    }
  }

  async function showContext(tab: ChatTab) {
    const info = await ipc.robotBrain(tab.id);
    const c = info?.context;
    if (!c) {
      rw.addNote('📊 My memory is empty so far. Ask me something first!', '', tab);
      return;
    }
    tab.context = c;
    renderBrain();
    rw.addBot(
      `**📊 My memory:** ${Math.round(c.totalTokens / 1000)}k of ${Math.round(c.maxTokens / 1000)}k tokens (${c.percentage}%)` +
        (c.autoCompact && c.autoCompactAt
          ? `\n\nI'll squish it myself near ${Math.round((c.autoCompactAt / c.maxTokens) * 100)}%, or say \`/compact\` to do it now.`
          : ''),
      { tab },
    );
  }
  return {
    closeMenu,
    compactTab,
    cycleMode,
    finishCompact,
    loadBrain,
    menuEl,
    modeOf,
    openEffortMenu,
    openMenu,
    openModelMenu,
    pickEffort,
    pickModel,
    renderBrain,
    setBrain,
    showContext,
    startCompact,
  };
}
export type BrainApi = ReturnType<typeof createBrain>;
