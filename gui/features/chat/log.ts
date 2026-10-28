// The chat's log: your messages and its answers, the steps it took (chips, and their details
// when opened), the files it changed and the pictures it showed.
// (robot.ts calls createChatLog with its hub.)
import { $ } from '@/lib/dom';
import { TOOLS, TOOL_ICONS, fileIcon, skillLabel } from '@/views/robot/constants';
import type { AppViewsApi } from '@/features/mcp/apps';
import type { BriefsApi } from './brief';
import type { CommentaryApi } from './reply/commentary';
import type { ChatMarkdownApi } from './reply/local-files';
import type { ComposerApi } from './composer/composer';
import type { HelpersApi } from './agents';
import type { BotOpts, ChatTab, RobotState, ToolCall } from '@/views/robot/types';
import { stepSummary } from './reply/steps';
import type { Brief, Diff, FileChip, StepCall, ToolImage } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type ChatLogNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly appCard: AppViewsApi['appCard'];
  readonly asideChip: AppViewsApi['asideChip'];
  readonly briefChips: BriefsApi['briefChips'];
  readonly dedupePics: ChatMarkdownApi['dedupePics'];
  readonly deniedNote: CommentaryApi['deniedNote'];
  readonly IMAGE_EXT: ChatMarkdownApi['IMAGE_EXT'];
  readonly imageUrl: ChatMarkdownApi['imageUrl'];
  readonly md: ChatMarkdownApi['md'];
  readonly msgActions: ComposerApi['msgActions'];
  readonly openHelper: HelpersApi['openHelper'];
  readonly openToolView: HelpersApi['openToolView'];
  readonly rawText: ComposerApi['rawText'];
  readonly serverLabel: AppViewsApi['serverLabel'];
  readonly state: RobotState;
};

export function createChatLog(r: ChatLogNeeds) {
  function scrollDown(tab = r.active()) {
    if (tab) tab.log.scrollTop = tab.log.scrollHeight;
  }

  const thumbImg = (src: string) => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = src;
    return img;
  };

  // text with its @mentions (files, and other tabs: @#) picked out
  function withMentions(el: HTMLElement, text: string) {
    const re = /(^|\s)(@#?(?:"[^"\n]+"|[^\s"]+))/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index + m[1].length;
      el.append(text.slice(last, start));
      const span = document.createElement('span');
      span.className = 'mention';
      span.textContent = m[2];
      el.append(span);
      last = start + m[2].length;
    }
    el.append(text.slice(last));
  }

  // (files: the ones fed to it, or as kept with the history: no path or thumbnail)
  function addUser(
    text: string,
    files: (FileChip & { path?: string; thumb?: string })[] = [],
    tab: ChatTab = r.current(),
    tag = '',
    briefs: Brief[] = [],
  ) {
    const el = document.createElement('div');
    el.className = 'msg user';
    withMentions(el, text);
    if (tag) {
      // (sent to everyone on the stage: who got it)
      const t = document.createElement('div');
      t.className = 'stage-tag';
      t.textContent = tag;
      el.prepend(t);
    }
    if (files?.length) {
      const row = document.createElement('div');
      row.className = 'files';
      for (const f of files) {
        const chip = document.createElement('span');
        chip.className = 'file-chip';
        chip.title = f.path ? `${f.path}\nClick to look at it here (Ctrl+click: open it)` : f.name;
        if (f.path) chip.dataset.open = f.path;
        if (f.thumb) chip.appendChild(thumbImg(f.thumb));
        if (!f.thumb) chip.insertAdjacentHTML('beforeend', Icon(fileIcon(f), 'sm'));
        chip.appendChild(document.createElement('span')).textContent = f.name;
        row.appendChild(chip);
      }
      el.appendChild(row);
    }
    if (briefs?.length) {
      const row = document.createElement('div');
      row.className = 'files';
      r.briefChips(row, briefs);
      el.appendChild(row);
    }
    r.msgActions(el, 'user', tab);
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  function addBot(
    text: string,
    {
      error = false,
      denials = [],
      tools = [],
      asides = [],
      edits = [],
      apps = [],
      images = [],
      tab = r.current(),
    }: BotOpts = {},
  ) {
    const el = document.createElement('div');
    el.className = `msg bot${error ? ' error' : ''}`;
    // steps saved with where they came in the words (at) go back there, each followed by what
    // it made; older answers (and anything without a step to follow) keep it all on top
    const placed = (tools || []).filter((t) => t && typeof t === 'object' && Number.isFinite(t.at)) as StepCall[]; // (steps, not names)
    const made = new Map<string, Node[]>(); // step id -> what it made [element]
    const loose: Node[] = []; // made by no step we can place
    const ids = new Set(placed.map((t) => t.id));
    const madeBy = (id: string | undefined, node: Node) =>
      id && ids.has(id) ? made.set(id, [...(made.get(id) || []), node]) : loose.push(node);
    for (const d of edits || []) madeBy(d.id, diffCard(d));
    for (const a of apps || []) madeBy(a.id, r.appCard(a));
    for (const pic of images || []) madeBy(pic.id, toolPics([pic]));
    const words = String(text || '');
    const block = (cls: string, nodes: Node[]) => {
      const box = document.createElement('div');
      box.className = cls;
      box.append(...nodes);
      el.appendChild(box);
    };
    const say = (s: string) => {
      if (!s.trim()) return;
      const box = document.createElement('div');
      box.className = 'content';
      box.innerHTML = r.md(s);
      el.appendChild(box);
    };
    // on top: the steps we can't place, the asides, what no placed step made
    const topSteps = toolChips(
      (tools || []).filter((t) => !(placed as (StepCall | string)[]).includes(t)),
      tab,
    );
    for (const a of asides || []) topSteps.appendChild(r.asideChip(a));
    if (topSteps.children.length) el.appendChild(topSteps);
    if (loose.length) block('edits', loose);
    let pos = 0;
    for (let i = 0; i < placed.length;) {
      const at = Math.min(Math.max(placed[i].at, pos), words.length);
      const group: StepCall[] = [];
      while (i < placed.length && Math.min(Math.max(placed[i].at, pos), words.length) === at) group.push(placed[i++]);
      say(words.slice(pos, at));
      pos = at;
      el.appendChild(toolChips(group, tab));
      const things = group.flatMap((t) => made.get(t.id) || []);
      if (things.length) block('edits', things);
    }
    say(words.slice(pos));
    if (!el.children.length) el.innerHTML = r.md(words || '…');
    if (denials?.length) el.appendChild(r.deniedNote(denials));
    r.dedupePics(el);
    r.rawText.set(el, words);
    r.msgActions(el, 'bot', tab);
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  // the steps of a finished turn: a line each (click one for its details), two or more folded
  // under one line saying what they did ("Read 3 files, ran 2 commands"), as Claude Code
  // desktop does; older history kept just their names, as compact chips: "📖 Read ×3"
  function toolChips(tools: (StepCall | string)[], tab: ChatTab) {
    const row = document.createElement('div');
    row.className = 'tools';
    const counts = new Map<string, number>();
    for (const t of tools) if (t && typeof t === 'object') row.appendChild(callChip({ ...t, running: false }, tab));
    foldSteps(row, true);
    for (const t of tools) if (!(t && typeof t === 'object')) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [entry, n] of counts) {
      // "Skill(anthropic-skills:pptx)" -> 🎓 Skill: pptx (anthropic-skills)
      const [, name, detail] = entry.match(/^(\w+)\((.+)\)$/) || [null, entry, ''];
      const chip = document.createElement('span');
      chip.className = 'tool';
      const kind = TOOLS[name]?.[2] || 'run';
      chip.dataset.kind = kind;
      chip.innerHTML = `${Icon(TOOL_ICONS[kind] || 'wrench')}<span></span>`;
      $(':scope > span:last-child', chip).textContent =
        `${name}${detail ? `: ${skillLabel(detail)}` : ''}${n > 1 ? ` ×${n}` : ''}`;
      row.appendChild(chip);
    }
    return row;
  }

  // a tool step's look: "mcp__claude_ai_Excalidraw__create_view" -> 🧩 Excalidraw: create_view
  function toolLook(name: string, detail?: string) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    const [emoji, verb, activity] =
      TOOLS[name] || (mcp ? ['🧩', `${r.serverLabel(mcp[1])}: ${mcp[2]}`, 'run'] : ['🛠️', `Using ${name}`, 'run']);
    const text = `${verb}${detail ? ` ${detail}` : ''}`;
    return { emoji, verb, activity, mcp: !!mcp, text, label: `${emoji} ${text}` };
  }
  // A step, as a line in the answer (as Claude Code shows it: what it did, and under it what came
  // back: "⎿ Read 120 lines"). Clicking it opens it right there: the command or the file, and
  // what came back (all of it in the helper panel); a helper agent's opens the helper instead.
  const stepCalls = new WeakMap<HTMLElement, ToolCall>();
  function callChip(call: ToolCall, tab: ChatTab): HTMLElement {
    if (call.name === 'Thinking') return thinkRow(call);
    const look = toolLook(call.name, call.detail);
    const row = document.createElement('div');
    row.className = 'step clickable';
    row.dataset.kind = look.activity;
    row.dataset.tool = call.name;
    if (call.id) row.dataset.call = call.id;
    row.classList.toggle('running', call.running);
    row.classList.toggle('failed', !!call.isError);
    row.innerHTML = `<div class="step-head" tabindex="0" role="button" aria-expanded="false"><span class="step-dot"></span>${Icon(TOOL_ICONS[look.activity] || (look.mcp ? 'plug' : 'wrench'))}<span class="step-text"></span><span class="step-caret" aria-hidden="true">›</span></div><div class="step-out" hidden></div>`;
    $('.step-text', row).textContent = look.text;
    setStepOut(row, call);
    stepCalls.set(row, call);
    const head = $<HTMLElement>('.step-head', row);
    head.title = `${look.label} (click for the details)`;
    const toggle = () => {
      if ((call.name === 'Agent' || call.name === 'Task') && tab?.agents?.has(call.id))
        return r.openHelper(tab, call.id);
      const open = row.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      if (open) renderStepDetail(row, tab);
      else row.querySelector(':scope > .step-detail')?.remove();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    });
    return row;
  }

  // A step opened in place: what it ran or looked at (a file opens in the file viewer) and what
  // came back, the start of it; "Full details" shows it all in the helper panel.
  const STEP_OUT_MAX = 4000;
  function renderStepDetail(row: HTMLElement, tab: ChatTab) {
    const call = stepCalls.get(row);
    if (!call) return;
    let box = row.querySelector<HTMLElement>(':scope > .step-detail');
    if (!box) {
      box = document.createElement('div');
      box.className = 'step-detail';
      row.appendChild(box);
    }
    box.replaceChildren();
    const pre = (cls: string, text: string) =>
      Object.assign(document.createElement('pre'), { className: cls, textContent: text });
    const note = (text: string) =>
      Object.assign(document.createElement('div'), { className: 'sd-note', textContent: text });
    const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : null;
    const str = (k: string) => (typeof args?.[k] === 'string' ? (args[k] as string) : '');
    if (str('command')) box.appendChild(pre('sd-in sd-cmd', str('command')));
    const file =
      str('file_path') || str('notebook_path') || (/^([a-zA-Z]:[\\/]|\\\\)/.test(str('path')) ? str('path') : '');
    if (file) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-file';
      b.dataset.open = file;
      b.title = `${file}\nClick to look at it here (Ctrl+click: open it)`;
      b.innerHTML = `${Icon(str('file_path') || str('notebook_path') ? 'file' : 'folder', 'sm')}<span></span>${Icon('right', 'sm')}`;
      $('span', b).textContent = file;
      box.appendChild(b);
    }
    const what = str('pattern') || str('url') || str('query');
    if (what) box.appendChild(pre('sd-in', what));
    else if (!str('command') && !file && args && Object.keys(args).length) {
      const json = JSON.stringify(args, null, 2);
      box.appendChild(pre('sd-in', json.length > 1500 ? `${json.slice(0, 1500)}…` : json));
    }
    if (call.running) box.appendChild(note('Still working on it…'));
    else if (typeof call.output === 'string' && call.output.trim()) {
      const out =
        call.output.length > STEP_OUT_MAX
          ? `${call.output.slice(0, STEP_OUT_MAX)}\n… (${(call.output.length - STEP_OUT_MAX).toLocaleString()} more characters)`
          : call.output;
      box.appendChild(pre(`sd-out${call.isError ? ' error' : ''}`, out));
    } else
      box.appendChild(
        note(call.trimmed ? 'What came back wasn’t kept in the saved history (it was too big).' : 'Nothing came back.'),
      );
    const full = document.createElement('button');
    full.type = 'button';
    full.className = 'sd-full';
    full.dataset.icon = 'expand';
    full.textContent = 'Full details';
    full.addEventListener('click', () => r.openToolView(tab, call));
    box.appendChild(full);
    Icon.fill(box);
  }

  // A run of two or more steps folds under one line saying what they did, as Claude Code
  // desktop does: "› Read 3 files, ran 2 commands · 5 steps". A finished turn's start folded;
  // a turn still going shows its steps as they come (until you fold it).
  const STEP_GROUPS: [RegExp, (n: number) => string][] = [
    [/^Thinking$/, () => 'thought'],
    [/^(Read|NotebookRead)$/, (n) => `read ${n} file${n === 1 ? '' : 's'}`],
    [/^(Grep|Glob|LS|ToolSearch)$/, (n) => (n === 1 ? 'searched once' : `searched ${n} times`)],
    [/^(Bash|PowerShell|BashOutput|KillShell|KillBash)$|terminal_/, (n) => `ran ${n} command${n === 1 ? '' : 's'}`],
    [/^(Edit|MultiEdit|Write|NotebookEdit)$/, (n) => `edited ${n} file${n === 1 ? '' : 's'}`],
    [/^(WebFetch|WebSearch)$/, (n) => `looked up ${n} page${n === 1 ? '' : 's'}`],
    [/^(Agent|Task)$/, (n) => `sent ${n} helper${n === 1 ? '' : 's'}`],
    [/^TodoWrite$/, () => 'updated the plan'],
  ];
  function stepsSummary(steps: HTMLElement[]) {
    const counts = new Map<number, number>();
    let other = 0;
    for (const s of steps) {
      const g = STEP_GROUPS.findIndex(([re]) => re.test(s.dataset.tool || ''));
      if (g < 0) other++;
      else counts.set(g, (counts.get(g) || 0) + 1);
    }
    const bits = [...counts].sort((a, b) => a[0] - b[0]).map(([g, n]) => STEP_GROUPS[g][1](n));
    if (other) bits.push(`used ${other} tool${other === 1 ? '' : 's'}`);
    const text = bits.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function foldSteps(row: HTMLElement, folded?: boolean) {
    const steps = [...row.querySelectorAll<HTMLElement>(':scope > .step')];
    let head = row.querySelector<HTMLButtonElement>(':scope > .steps-head');
    if (steps.length < 2) {
      head?.remove();
      row.classList.remove('foldable', 'folded', 'has-failed');
      return;
    }
    if (!head) {
      head = document.createElement('button');
      head.type = 'button';
      head.className = 'steps-head';
      head.innerHTML =
        '<span class="sh-caret" aria-hidden="true">›</span><span class="sh-text"></span><span class="sh-now"></span><span class="sh-n"></span>';
      head.addEventListener('click', () => {
        const fold = !row.classList.contains('folded');
        row.classList.toggle('folded', fold);
        foldSteps(row);
        if (fold) return;
        // (they come down one after another)
        row.querySelectorAll<HTMLElement>(':scope > .step').forEach((s, i) => {
          s.style.setProperty('--i', String(Math.min(i, 12)));
        });
        row.classList.remove('unfolding');
        void row.offsetWidth;
        row.classList.add('unfolding');
        clearTimeout(Number(row.dataset.unfoldTimer));
        row.dataset.unfoldTimer = String(setTimeout(() => row.classList.remove('unfolding'), 700));
      });
      row.prepend(head);
      folded ??= true; // (folded to start with, even while it works: open it to see them all)
    }
    row.classList.add('foldable');
    if (folded !== undefined) row.classList.toggle('folded', folded);
    head.setAttribute('aria-expanded', String(!row.classList.contains('folded')));
    const failed = steps.filter((s) => s.classList.contains('failed')).length;
    const running = steps.some((s) => s.classList.contains('running'));
    $('.sh-text', head).textContent = stepsSummary(steps);
    // (while it works: what it's on now, so a folded run still shows it going)
    const now = row.classList.contains('live')
      ? (steps.findLast((s) => s.classList.contains('running')) ?? steps[steps.length - 1])
      : null;
    $('.sh-now', head).textContent = now?.querySelector('.step-text, .think-label')?.textContent ?? '';
    $('.sh-n', head).textContent = [
      `${steps.length} steps`,
      failed ? `${failed} failed` : '',
      running ? 'working…' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    head.title = row.classList.contains('folded') ? 'Show the steps' : 'Fold the steps away';
    row.classList.toggle('has-failed', failed > 0);
  }
  // what a step gave back, under it
  function setStepOut(row: HTMLElement, call: ToolCall) {
    const out = row.querySelector<HTMLElement>('.step-out');
    if (!out) return;
    const lines = call.running ? [] : stepSummary(call.name, call.output, call.isError);
    out.replaceChildren(...lines.map((l) => Object.assign(document.createElement('div'), { textContent: l })));
    out.hidden = !lines.length;
  }

  // Its thinking, as a step: "✻ Thinking…" while it thinks, "✻ Thought for 6s" after. Open it to
  // read what it thought (as Claude Code shows it on Ctrl+R).
  function thinkRow(call: ToolCall) {
    const d = document.createElement('details');
    d.className = 'step think';
    d.dataset.tool = 'Thinking';
    if (call.id) d.dataset.call = call.id;
    d.dataset.start = String(Date.now());
    d.innerHTML =
      '<summary><span class="think-star">✻</span><span class="think-label"></span></summary><div class="think-text"></div>';
    $('.think-text', d).textContent = (call.output || '').trim();
    $('.think-label', d).textContent = call.running ? 'Thinking…' : 'Thought';
    d.classList.toggle('running', call.running);
    d.classList.toggle('empty', !call.running && !(call.output || '').trim());
    return d;
  }
  // done thinking (words or a step came next, or the answer's over): how long it took
  function settleThinking(tab: ChatTab) {
    for (const d of tab.log.querySelectorAll<HTMLElement>('.step.think.running')) {
      d.classList.remove('running');
      const s = Math.max(1, Math.round((Date.now() - Number(d.dataset.start)) / 1000));
      $('.think-label', d).textContent = `Thought for ${s}s`;
      d.classList.toggle('empty', !$('.think-text', d).textContent?.trim());
      const call = d.dataset.call ? tab.calls?.get(d.dataset.call) : undefined;
      if (call) call.running = false;
    }
  }

  // A file Claude Code changed, shown the way its terminal does: the file, +/- counts,
  // and the changed lines with line numbers. Long diffs start folded.
  function diffCard(d: Diff & { at?: number }) {
    const card = document.createElement('details');
    card.className = 'diff';
    card.open = d.hunks.reduce((n, h) => n + h.lines.length, 0) <= 40;
    // (what the outputs card lists: chat/outputs.ts)
    Object.assign(card.dataset, {
      file: d.file,
      created: d.created ? '1' : '',
      added: String(d.added || 0),
      removed: String(d.removed || 0),
    });
    const folder = (r.state.character?.folder || '').replace(/[\\/]+$/, '');
    const inside =
      folder && /^[\\/]$/.test(d.file[folder.length] || '') && d.file.toLowerCase().startsWith(folder.toLowerCase());
    const rel = inside ? d.file.slice(folder.length + 1) : d.file;
    const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    const sum = document.createElement('summary');
    sum.title = d.file;
    sum.innerHTML = `<span class="d-verb"></span><b class="d-name"></b><span class="d-dir"></span><span class="d-add"></span><span class="d-del"></span><button class="d-open" type="button" title="Open the file">${Icon('open', 'sm')}</button>`;
    $<HTMLElement>('.d-open', sum).dataset.open = d.file;
    $('.d-verb', sum).textContent = d.created ? 'Created' : 'Updated';
    $('.d-name', sum).textContent = rel.slice(cut + 1);
    $('.d-dir', sum).textContent = cut > 0 ? rel.slice(0, cut) : '';
    $('.d-add', sum).textContent = d.added ? `+${d.added}` : '';
    $('.d-del', sum).textContent = d.removed ? `−${d.removed}` : '';
    card.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'd-body';
    d.hunks.forEach((h, i) => {
      if (i) {
        const gap = document.createElement('div');
        gap.className = 'd-gap';
        gap.textContent = '⋯';
        body.appendChild(gap);
      }
      let oldNo = h.oldStart;
      let newNo = h.newStart;
      for (const line of h.lines) {
        const sign = line[0];
        const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : sign === '\\' ? 'meta' : 'ctx';
        let no: string | number = '';
        if (kind === 'add') no = newNo++;
        else if (kind === 'del') no = oldNo++;
        else if (kind === 'ctx') {
          no = newNo++;
          oldNo++;
        }
        const row = document.createElement('div');
        row.className = `d-line ${kind}`;
        row.innerHTML = '<span class="d-no"></span><span class="d-sign"></span><span class="d-text"></span>';
        row.children[0].textContent = String(no);
        row.children[1].textContent = kind === 'add' || kind === 'del' ? sign : ' ';
        row.children[2].textContent = kind === 'meta' ? line : line.slice(1);
        body.appendChild(row);
      }
    });
    if (d.truncated) {
      const more = document.createElement('div');
      more.className = 'd-gap';
      more.textContent = '… more changes not shown';
      body.appendChild(more);
    }
    if (!r.IMAGE_EXT.test(d.file)) {
      card.appendChild(body);
      return card;
    }
    // a picture (an SVG it drew, a PNG it saved): show it, with its source folded away
    card.open = true;
    const pic = document.createElement('div');
    pic.className = 'd-preview';
    const img = document.createElement('img');
    img.className = 'local-img';
    img.src = r.imageUrl(d.file, d.at || d.id || Date.now()); // (one per edit: re-renders keep it cached)
    img.alt = rel;
    img.dataset.open = d.file;
    img.title = 'Open the picture';
    pic.appendChild(img);
    card.appendChild(pic);
    if (/\.svg$/i.test(d.file)) {
      const src = document.createElement('details');
      src.className = 'd-source';
      src.innerHTML = '<summary>source</summary>';
      src.appendChild(body);
      card.appendChild(src);
    }
    return card;
  }

  // pictures a tool returned, as a strip of thumbnails (click one to see it bigger)
  function toolPics(images: ToolImage[]) {
    const row = document.createElement('div');
    row.className = 'tool-pics';
    for (const pic of images) {
      if (!/^image\/[\w.+-]+$/.test(pic.mimeType || '')) continue;
      const img = document.createElement('img');
      img.src = `data:${pic.mimeType};base64,${pic.data}`;
      img.alt = 'Picture from a tool';
      img.addEventListener('click', () => img.classList.toggle('big'));
      row.appendChild(img);
    }
    return row;
  }
  return {
    addBot,
    addUser,
    callChip,
    diffCard,
    foldSteps,
    renderStepDetail,
    scrollDown,
    setStepOut,
    settleThinking,
    thinkRow,
    thumbImg,
    toolLook,
    toolPics,
  };
}
export type ChatLogApi = ReturnType<typeof createChatLog>;
