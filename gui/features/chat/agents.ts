// Helper agents (sub-agents) Claude Code sends out, each with its own card:
// what it's doing right now, how far it got, and its report when it's back.
// (robot.ts calls createHelpers with its hub.)
import type { PastChatsApi } from './past/resume';
import { TOOLS } from '@/views/robot/constants';
import type { CommentaryApi } from './reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { ChatMarkdownApi } from './reply/local-files';
import type { TabsApi } from './tabs';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { ChatLogApi } from './log';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, Helper, RobotState, ToolCall } from '@/views/robot/types';
import { fileIcon as viewIcon, renderFileView } from '@/features/workbench/files/viewer';
import { collectOutputs, renderOutputsPanel, renderOutputsStrip } from './outputs';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { plural, samePath } from '@/lib/text';
import type { ChatEvent, StepMedia } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type HelpersNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly animates: CommentaryApi['animates'];
  readonly express: FaceApi['express'];
  readonly FILE_URL: ChatMarkdownApi['FILE_URL'];
  readonly flash: FaceApi['flash'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly history: PastChatsApi['history'];
  readonly imageUrl: ChatMarkdownApi['imageUrl'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly openInApp: ChatMarkdownApi['openInApp'];
  readonly renderFace: FaceApi['renderFace'];
  readonly renderTabs: TabsApi['renderTabs'];
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly restingActivity: DeskActivityApi['restingActivity'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly toolLook: ChatLogApi['toolLook'];
};

export function createHelpers(r: HelpersNeeds) {
  // (chat/todo.ts)

  // Helper agents (sub-agents) Claude Code sends out, each with its own card:
  // what it's doing right now, how far it got, and its report when it's back.
  const helpersEl = $('#helpers');
  // (call: a tool step's details instead; file: a file or folder, trail: the ones opened before it, for Back)
  const helperView: {
    id: string | null;
    call: ToolCall | null;
    tab: ChatTab | null;
    timer: number;
    file: string | null;
    trail: string[];
  } = { id: null, call: null, tab: null, timer: 0, file: null, trail: [] };
  const AGENT_ICON: Record<string, string> = { completed: 'check', failed: 'alert', killed: 'stop', stopped: 'stop' };
  const elapsed = (a: Helper) => {
    const s = Math.max(0, Math.round(((a.ended || Date.now()) - a.started) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const stepLabel = (s: { tool: string; detail: string }) => {
    const [emoji, verb] = TOOLS[s.tool] || ['🛠️', `Using ${s.tool}`];
    return `${emoji} ${verb}${s.detail ? ` ${s.detail}` : ''}`;
  };
  const helperMeta = (a: Helper) =>
    [
      (a.toolsUsed ?? a.steps.length) ? plural(a.toolsUsed ?? a.steps.length, 'step') : '',
      a.tokens ? `${Math.round(a.tokens / 1000)}k tokens` : '',
      elapsed(a),
    ]
      .filter(Boolean)
      .join(' · ');

  function onAgent(tab: ChatTab, ev: Extract<ChatEvent, { type: 'agent' }>) {
    tab.agents ||= new Map<string, Helper>();
    const fresh = !tab.agents.has(ev.id);
    const a: Helper = tab.agents.get(ev.id) || {
      id: ev.id,
      description: 'Helper',
      status: 'running',
      steps: [],
      text: '',
      started: Date.now(),
    };
    tab.agents.set(ev.id, a);
    switch (ev.op) {
      case 'start':
        Object.assign(a, {
          description: ev.description || a.description,
          kind: ev.kind || a.kind,
          prompt: ev.prompt || a.prompt,
          background: ev.background || a.background,
          parent: ev.parent ?? a.parent,
        });
        if (fresh) tab.helpersCollapsed = false;
        break;
      case 'progress':
        Object.assign(a, {
          activity: ev.activity || a.activity,
          tokens: ev.tokens ?? a.tokens,
          toolsUsed: ev.tools ?? a.toolsUsed,
        });
        break;
      case 'step':
        a.steps.push({ tool: ev.tool, detail: ev.detail, at: Date.now() });
        a.activity = stepLabel(a.steps[a.steps.length - 1]);
        break;
      case 'text':
        a.text += (a.text ? '\n\n' : '') + ev.text;
        break;
      case 'status':
        if (ev.status !== 'running') a.status = ev.status;
        break;
      case 'done': {
        const wasRunning = a.status === 'running' || !a.ended;
        Object.assign(a, {
          status: ev.status || 'completed',
          summary: ev.summary || a.summary,
          report: ev.report || a.report,
          ended: a.ended || Date.now(),
        });
        if (ev.tokens) a.tokens = ev.tokens;
        if (ev.tools !== undefined) a.toolsUsed = ev.tools;
        if (wasRunning) {
          tab.justBack = a.id;
          if (r.animates(tab)) {
            Sfx.tick();
            r.flash('hop', 600);
            const name = a.description.length > 30 ? `${a.description.slice(0, 29)}…` : a.description;
            r.showPop(a.status === 'completed' ? `🤖 “${name}” is back!` : `🤖 “${name}” ran into trouble`, 2200);
          }
        }
        break;
      }
    }
    if (tab === r.active()) renderHelpers();
    if (helperView.id === a.id) renderHelperView();
    actOutHelper(tab, ev, fresh);
  }

  // the robot acts out its helpers: a whee as one flies off, a hop when one takes
  // a step, and supervising (chin in hand, watching them circle) while any are out
  function actOutHelper(tab: ChatTab, ev: Extract<ChatEvent, { type: 'agent' }>, fresh: boolean) {
    r.renderTabs(); // tab dot, and the count of little bots
    r.renderWorking();
    if (!r.animates(tab)) return;
    if (ev.op === 'start' && fresh) {
      Sfx.whee();
      r.flash('hop', 600);
    } else if (ev.op === 'step') {
      r.flash('helper-step', 400);
      Sfx.tool();
    }
    if (ev.op === 'done' && !r.helpersOut() && !r.state.busy) {
      // the last one is back
      r.setActivity('done', 2600);
      r.express('happy', 'smile', 2000);
      return;
    }
    const rest = r.restingActivity();
    // don't cut short a tool or talking scene of the answer in progress
    if (!r.state.busy && r.state.activity !== rest && r.state.activity !== 'done') r.setActivity(rest);
    else if (r.state.busy && rest === 'helpers' && (r.state.activity === 'think' || r.state.activity === 'agent'))
      r.setActivity(rest);
    r.renderFace();
  }

  function clearFinishedHelpers(tab: ChatTab) {
    if (!tab.agents?.size || [...tab.agents.values()].some((a) => a.status === 'running')) return;
    tab.agents.clear();
    if (tab === r.active()) renderHelpers();
  }

  function renderHelpers() {
    const t = r.current(); // (it has helpers only with a tab open)
    const list = [...(t?.agents?.values() || [])];
    helpersEl.hidden = !list.length;
    if (!list.length) return;
    const back = list.filter((a) => a.status !== 'running').length;
    helpersEl.classList.toggle('collapsed', !!t.helpersCollapsed);
    helpersEl.innerHTML =
      '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="helper-list"></ul>';
    $('.todo-title', helpersEl).textContent =
      back === list.length ? `${plural(list.length, 'helper')}  all back` : `Helpers  ${back}/${list.length} back`;
    $<HTMLElement>('.todo-bar i', helpersEl).style.width = `${(back / list.length) * 100}%`;
    $('.todo-chev', helpersEl).textContent = t.helpersCollapsed ? 'show' : 'hide';
    $('.todo-head', helpersEl).addEventListener('click', () => {
      t.helpersCollapsed = !t.helpersCollapsed;
      renderHelpers();
    });
    const ul = $('.helper-list', helpersEl);
    for (const a of list) {
      const li = document.createElement('li');
      li.className = `${a.status}${a.id === t.justBack ? ' just-back' : ''}`;
      li.title = 'Click to watch it work';
      li.innerHTML = '<span class="hi"></span><span class="hn"></span><span class="hm"></span><span class="hs"></span>';
      $('.hi', li).innerHTML = AGENT_ICON[a.status] ? Icon(AGENT_ICON[a.status], 'sm') : '';
      $('.hn', li).textContent = `${a.parent ? '↳ ' : ''}${a.description}`;
      $('.hm', li).textContent = helperMeta(a);
      const firstLine = (a.summary || a.report || '').split('\n').find((l) => l.trim()) || '';
      $('.hs', li).textContent = a.status === 'running' ? a.activity || 'Getting started…' : firstLine || 'Done';
      li.addEventListener('click', () => openHelper(t, a.id));
      ul.appendChild(li);
    }
    t.justBack = null;
  }
  // The outputs (chat/outputs.ts): what the conversation in front made or changed, an "Outputs"
  // button over the chat box that shows them all in the helper panel. Read off its log
  // whenever the logs change (an answer, a rewind, a tab switch), a frame later.
  const outputsEl = $('#outputs');
  let outputsQueued = false;
  let outputsDrawn = '';
  function renderOutputsSoon() {
    if (outputsQueued) return;
    outputsQueued = true;
    requestAnimationFrame(() => {
      outputsQueued = false;
      const t = r.active();
      if (!t) {
        outputsEl.hidden = true;
        return;
      }
      const outputs = collectOutputs(t.log);
      // (redrawn only when it changes: not under the mouse every frame the words stream in)
      const drawn = JSON.stringify([t.id, outputs]);
      if (drawn === outputsDrawn) return;
      outputsDrawn = drawn;
      renderOutputsStrip(outputsEl, outputs, { openPanel: () => openOutputsView() });
      if (helperView.file === OUTPUTS_VIEW) showOutputsPanel(outputs);
    });
  }
  new MutationObserver(renderOutputsSoon).observe($('#logs'), {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });

  // all of them, in the helper panel (a file opened from there comes Back to it)
  const OUTPUTS_VIEW = 'outputs:';
  function openOutputsView({ back = false } = {}) {
    if (r.history.isOpen()) r.history.close();
    clearInterval(helperView.timer);
    if (!back) helperView.trail = [];
    Object.assign(helperView, { id: null, call: null, tab: r.active() ?? null, file: OUTPUTS_VIEW });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    const title = $('#hv-title');
    title.innerHTML = Icon('box', 'sm lead');
    title.append('Outputs');
    title.title = 'What this conversation made and changed';
    showOutputsPanel(r.active() ? collectOutputs(r.current().log) : []);
    $('#hv-body').scrollTop = 0;
  }
  function showOutputsPanel(outputs: ReturnType<typeof collectOutputs>) {
    renderOutputsPanel($('#hv-body'), outputs, {
      folder: r.state.character?.folder || '',
      thumb: r.imageUrl,
      openInApp: r.openInApp,
      reveal: (p) => ipc.robotOpenFile(p, { reveal: true }),
    });
  }

  // running helpers' clocks keep ticking on the card
  setInterval(() => {
    const t = r.active();
    if (!helpersEl.hidden && [...(t?.agents?.values() || [])].some((a) => a.status === 'running')) renderHelpers();
  }, 1000);

  function openHelper(tab: ChatTab, id: string) {
    if (!tab.agents?.has(id)) return;
    if (r.history.isOpen()) r.history.close();
    Object.assign(helperView, { id, tab, call: null, file: null, trail: [] });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    renderHelperView(true);
    clearInterval(helperView.timer);
    helperView.timer = setInterval(() => {
      if (viewedHelper()?.status === 'running') renderHelperView();
    }, 1000);
  }
  // the helper the panel shows (none: it shows something else)
  function viewedHelper() {
    return helperView.id === null ? undefined : helperView.tab?.agents?.get(helperView.id);
  }

  // One tool step up close (the same panel as a helper): what it was called with, field by
  // field, and what it gave back. Asking another robot shows the whole question and answer.
  function openToolView(tab: ChatTab, call: ToolCall) {
    if (r.history.isOpen()) r.history.close();
    clearInterval(helperView.timer);
    Object.assign(helperView, { id: null, call, tab, file: null, trail: [] });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    renderToolView();
    $('#hv-body').scrollTop = 0;
  }
  // (the fields that are prose: shown as markdown)
  const PROSE = new Set(['message', 'details', 'prompt', 'description', 'question', 'title']);
  function renderToolView() {
    const c = helperView.call;
    if (!c) return closeHelper();
    const look = r.toolLook(c.name, c.detail);
    Icon.text($('#hv-title'), look.label);
    const bodyEl = $('#hv-body');
    const status = c.running ? 'running' : c.isError ? 'failed' : 'completed';
    const missing = c.trimmed ? 'Not kept in the saved history (it was too big).' : 'Not recorded for this step.';
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${status}"></span><span class="hv-kind"></span></div>
      <div class="tv-head"><h4>Input</h4><button type="button" class="tv-copy" data-copy="args" data-icon="copy">Copy</button></div>
      <div class="tv-args"></div>
      <div class="tv-head"><h4>${c.isError ? 'Error' : 'Result'}</h4><button type="button" class="tv-copy" data-copy="output" data-icon="copy" hidden>Copy</button></div>
      <div class="tv-out"></div>`;
    Icon.text(
      $(`.pill-${status}`, bodyEl),
      { running: '⏳ Working', failed: '⚠️ Error', completed: '✅ Done' }[status],
    );
    $('.hv-kind', bodyEl).textContent = c.name;
    // the input, field by field
    const argsEl = $('.tv-args', bodyEl);
    const args = c.args && typeof c.args === 'object' ? (c.args as Record<string, unknown>) : null;
    if (!args) argsEl.innerHTML = `<p class="hv-empty">${missing}</p>`;
    else if (!Object.keys(args).length) argsEl.innerHTML = '<p class="hv-empty">(none)</p>';
    else {
      for (const [k, v] of Object.entries(args)) {
        const row = document.createElement('div');
        row.className = 'tv-field';
        const key = document.createElement('div');
        key.className = 'tv-key';
        key.textContent = k.replace(/_/g, ' ');
        const val = document.createElement('div');
        if (typeof v === 'string' && PROSE.has(k) && v.length > 40) {
          val.className = 'tv-val hv-words';
          val.innerHTML = r.md(v);
        } else if (typeof v !== 'object' && String(v).length <= 120 && !String(v).includes('\n')) {
          val.className = 'tv-val inline';
          val.textContent = String(v);
        } else {
          val.className = 'tv-val block';
          val.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        }
        row.append(key, val);
        argsEl.appendChild(row);
      }
    }
    // what it gave back
    const outEl = $<HTMLElement>('.tv-out', bodyEl);
    const media = Array.isArray(c.media) ? c.media : [];
    if (media.length && !c.running) outEl.after(stepMedia(media, args));
    if (c.running) outEl.innerHTML = '<p class="hv-empty">Still working on it…</p>';
    else if (c.output === undefined || c.output === null)
      outEl.innerHTML = media.length ? '' : `<p class="hv-empty">${missing}</p>`;
    else if (!c.output) outEl.innerHTML = media.length ? '' : '<p class="hv-empty">(nothing)</p>';
    else {
      $<HTMLElement>('[data-copy="output"]', bodyEl).hidden = false;
      // another robot's answer reads as its message; everything else as the tool gave it
      if (/^mcp__cbot__/.test(c.name) && !c.isError) {
        outEl.className = 'tv-out hv-words';
        outEl.innerHTML = r.md(c.output);
      } else {
        outEl.className = `tv-out block${c.isError ? ' error' : ''}`;
        outEl.textContent = c.output;
      }
    }
    for (const b of bodyEl.querySelectorAll<HTMLElement>('.tv-copy')) {
      b.addEventListener('click', () => {
        const text = b.dataset.copy === 'args' ? JSON.stringify(c.args ?? {}, null, 2) : String(c.output ?? '');
        navigator.clipboard.writeText(text).then(
          () => r.showPop('Copied! 📋', 1200),
          () => {},
        );
      });
    }
    Icon.fill(bodyEl);
  }

  // what a step gave back besides words (main stepMedia): its pictures, shown (click one to
  // see it full size), and its documents (a PDF it read), as a card that opens the file
  function stepMedia(media: StepMedia[], args: Record<string, unknown> | null) {
    const box = document.createElement('div');
    box.className = 'tv-media';
    const file = typeof args?.file_path === 'string' ? args.file_path : '';
    const fileName = file.split(/[\\/]/).pop();
    const card = (icon: string, title: string, sub: string) => {
      const el = document.createElement(file ? 'button' : 'div');
      el.className = 'tv-doc';
      if (file) {
        (el as HTMLButtonElement).type = 'button'; // (with a file it's a button)
        el.dataset.open = file;
        el.title = `Open ${file}`;
      }
      el.innerHTML = `${Icon(icon)}<span><b></b><small></small></span>${file ? Icon('open', 'sm') : ''}`;
      $('b', el).textContent = title;
      $('small', el).textContent = sub;
      return el;
    };
    for (const m of media) {
      if (m.kind === 'image' && m.data && /^image\/[\w.+-]+$/.test(m.mimeType || '')) {
        const img = document.createElement('img');
        img.className = 'tv-pic';
        img.src = `data:${m.mimeType};base64,${m.data}`;
        img.alt = fileName || 'Picture';
        img.title = 'Click to see it full size';
        img.addEventListener('click', () => img.classList.toggle('big'));
        box.appendChild(img);
      } else if (m.kind === 'image') {
        box.appendChild(
          card(
            'image',
            fileName || 'A picture',
            file
              ? 'Not kept in the saved history (too big): click to open the file'
              : 'Not kept in the saved history (too big)',
          ),
        );
      } else if (m.kind === 'document') {
        const kind = /pdf/i.test(m.mimeType || '')
          ? 'PDF'
          : (m.mimeType || 'Document').replace(/^application\//, '').toUpperCase();
        const size = m.size
          ? ` · ${m.size < 1024 ? `${m.size} B` : m.size < 1048576 ? `${Math.round(m.size / 1024)} KB` : `${(m.size / 1048576).toFixed(1)} MB`}`
          : '';
        box.appendChild(
          card('file', fileName || `A ${kind} document`, `${kind}${size}${file ? ' · click to open' : ''}`),
        );
      }
    }
    return box;
  }

  function closeHelper() {
    clearInterval(helperView.timer);
    Object.assign(helperView, { id: null, call: null, tab: null, file: null, trail: [] });
    $('#helper-view').hidden = true;
    document.body.classList.remove('helper-open');
    r.scrollDown();
    r.input.focus();
  }
  // Back: to the file or folder opened before this one, or out to the chat
  function backFromView() {
    const prev = helperView.file && helperView.trail.pop();
    if (prev === OUTPUTS_VIEW) openOutputsView({ back: true });
    else if (prev) openFileView(prev, { back: true });
    else closeHelper();
  }
  $('#hv-back').addEventListener('click', backFromView);

  // A file or folder up close, in the chat (workbench/files/viewer.ts): clicking a file in the chat
  // shows it here; a file in a folder's list (or the folder a file is in) opens in its place.
  let fileViewSeq = 0;
  async function openFileView(path: string, { back = false, start = undefined as string | undefined } = {}) {
    if (r.history.isOpen()) r.history.close();
    clearInterval(helperView.timer);
    if (!back && helperView.file && helperView.file !== path) helperView.trail.push(helperView.file);
    if (!helperView.file) helperView.trail = [];
    Object.assign(helperView, { id: null, call: null, tab: r.active() ?? null, file: path });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    const name =
      path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || path;
    const title = $('#hv-title');
    title.textContent = name;
    title.title = path;
    const bodyEl = $('#hv-body');
    const seq = ++fileViewSeq;
    const res = await ipc.robotReadFile(path).catch((err) => ({ ok: false as const, error: String(err) }));
    if (seq !== fileViewSeq || helperView.file !== path) return; // (another was opened meanwhile)
    if (!res.ok) {
      bodyEl.innerHTML =
        '<div class="fv-card"><div class="fv-card-what"></div><button type="button" class="fv-card-open" data-icon="open">Open in its app</button></div>';
      $('.fv-card-what', bodyEl).textContent = res.error;
      $('.fv-card-open', bodyEl).addEventListener('click', () => r.openInApp(path));
      Icon.fill(bodyEl);
      return;
    }
    title.innerHTML = Icon(viewIcon(res), 'sm lead');
    title.append(res.name);
    // what this conversation changed in it: its diff cards, oldest first (copies: they stay put)
    const changes = [...(helperView.tab?.log.querySelectorAll<HTMLElement>('details.diff[data-file]') || [])]
      .filter((card) => samePath(card.dataset.file) === samePath(path))
      .flatMap((card) => {
        const diff = card.querySelector('.d-body');
        if (!diff) return [];
        return [
          {
            body: diff.cloneNode(true) as HTMLElement, // (cloneNode answers a Node)
            created: !!card.dataset.created,
            added: Number(card.dataset.added) || 0,
            removed: Number(card.dataset.removed) || 0,
          },
        ];
      });
    renderFileView(
      bodyEl,
      res,
      {
        md: r.md,
        fileUrl: r.FILE_URL,
        open: (p) => openFileView(p),
        openInApp: r.openInApp,
        reveal: (p) => ipc.robotOpenFile(p, { reveal: true }),
        copy: (text, btn) =>
          navigator.clipboard.writeText(text).then(
            () => {
              btn.classList.add('done');
              setTimeout(() => btn.classList.remove('done'), 1400);
              r.showPop('Copied! 📋', 1200);
            },
            () => {},
          ),
      },
      { changes, start },
    );
    Icon.fill(bodyEl);
    bodyEl.scrollTop = 0;
  }

  function renderHelperView(top = false) {
    const a = viewedHelper();
    if (!a) return closeHelper();
    const bodyEl = $('#hv-body');
    const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
    const open = bodyEl.querySelector('details')?.open;
    Icon.text($('#hv-title'), `🤖 ${a.description}`);
    const status =
      (
        {
          running: '⏳ Working',
          completed: '✅ Done',
          failed: '⚠️ Failed',
          killed: '🛑 Stopped',
          stopped: '🛑 Stopped',
        } as Record<string, string>
      )[a.status] || a.status;
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${a.status}"></span><span class="hv-kind"></span><span class="hv-stats"></span></div>
      <details><summary>Its job (what it was asked)</summary><div class="hv-prompt"></div></details>
      <h4>Steps</h4><ul class="hv-steps"></ul>
      <div class="hv-said" hidden><h4>What it says</h4><div class="hv-words md-said"></div></div>
      <div class="hv-rep" hidden><h4>Report</h4><div class="hv-words md-rep"></div></div>`;
    Icon.text($(`.pill-${a.status}`, bodyEl), status);
    $('.hv-kind', bodyEl).textContent = `${a.kind || 'helper'}${a.background ? ' · in the background' : ''}`;
    $('.hv-stats', bodyEl).textContent = helperMeta(a);
    $('.hv-prompt', bodyEl).textContent = a.prompt || '(not shared)';
    if (open) $<HTMLDetailsElement>('details', bodyEl).open = true;
    const steps = $('.hv-steps', bodyEl);
    if (!a.steps.length)
      steps.innerHTML = `<li class="hv-empty">${a.status === 'running' ? (a.activity ? '' : 'Getting started…') : 'No steps reported.'}</li>`;
    if (!a.steps.length && a.status === 'running' && a.activity) $('.hv-empty', steps).textContent = a.activity;
    a.steps.forEach((s, i) => {
      const li = document.createElement('li');
      if (a.status === 'running' && i === a.steps.length - 1) li.className = 'now';
      li.innerHTML = '<span class="st"></span><span class="sw"></span>';
      Icon.text($('.st', li), stepLabel(s));
      $<HTMLElement>('.st', li).title = stepLabel(s);
      $('.sw', li).textContent = `+${Math.max(0, Math.round((s.at - a.started) / 1000))}s`;
      steps.appendChild(li);
    });
    const report = a.report || a.summary || '';
    if (a.text && a.text.trim() !== report.trim()) {
      $<HTMLElement>('.hv-said', bodyEl).hidden = false;
      $('.md-said', bodyEl).innerHTML = r.md(a.text);
    }
    if (report) {
      $<HTMLElement>('.hv-rep', bodyEl).hidden = false;
      $('.md-rep', bodyEl).innerHTML = r.md(report);
    }
    if (top) bodyEl.scrollTop = 0;
    else if (nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  return {
    backFromView,
    clearFinishedHelpers,
    closeHelper,
    helperView,
    onAgent,
    openFileView,
    openHelper,
    openToolView,
    renderHelpers,
    renderToolView,
  };
}
export type HelpersApi = ReturnType<typeof createHelpers>;
