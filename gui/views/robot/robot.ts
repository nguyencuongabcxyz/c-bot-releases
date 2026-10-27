import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Office3D } from '@/office3d/index';
import { McpAppHost } from '@/mcp/appHost';
import { Icon } from '@/ui/icons';
import { Sfx } from './sound';
import { HistoryView } from './chat/history';
import { ShellDrawer } from './chat/shell';
import { dressCode } from './chat/code';
import { fileIcon as viewIcon, renderFileView } from './chat/fileview';
import { collectOutputs, renderOutputsPanel, renderOutputsStrip } from './chat/outputs';
import { GO_LABEL, MODES, planNotes, planSummary } from './chat/plan';
import { SideQuestions } from './chat/sides';
import { tooltips } from './chat/tips';
import { stepSummary, tokens as fmtTokens } from './chat/steps';
import { codeBlock, link, prefixLines, transform, TRANSFORMS, wrap } from './chat/format';
import { showView } from '@/ui/view';
import { headSvg } from '@/ui/head';
import markup from './robot.html?raw';
import '@/ui/theme.css';
import './robot.css';
import './chat/chat.css';
import './chat/stage.css';
import type { McpAppHostHandle } from '@/mcp/appHost';
import type {
  AppCall,
  AppViewCall,
  ChatEvent,
  ClaudeCommand,
  ContextUse,
  Diff,
  FileChip,
  FileInfo,
  Layout,
  LinkEvent,
  LinkTask,
  ModelChoice,
  NotesBoard,
  NotesEvent,
  NotesReminder,
  PermissionMode,
  Personality,
  Point,
  QAItem,
  Question,
  Quips,
  RobotEvent,
  RobotSize,
  RobotView,
  Settings,
  Side,
  SightWord,
  SocialEvent,
  StageTileInfo,
  StepCall,
  StepMedia,
  Task,
  ToolImage,
  VocabEvent,
  VocabWord,
} from '@/types/model';
import type { Events, IslandNews, IslandReport, SocialReport, StageEvent } from '@/types/ipc';
import * as ipc from '@/ipc';

// ---- what the window keeps track of, beside what main tells it (../types/model.ts)

/** A question as it was asked: its words and the files that went with it (asked again when bonked). */
type Ask = { question: string; paths: string[] };

/** A piece of the answer being streamed (see partFor): words (its slice of the answer's text),
 *  a row of step chips, or what the steps made. */
type TextPart = { kind: 'text'; el: HTMLElement; from: number; to?: number };
type Part = TextPart | { kind: 'steps' | 'made'; el: HTMLElement; from?: number };

/** The answer being streamed into its bubble. */
type Reply = {
  el: HTMLElement;
  parts: Part[];
  text: string;
  offset?: number; // (after a question card: its words from here on, in a fresh bubble)
  asked?: boolean;
  turnId?: string;
  ask?: Ask;
  toolStatus?: string;
};

/** An answer's bubble, as kept with the history (addBot). */
type BotOpts = {
  error?: boolean;
  denials?: string[];
  tools?: (StepCall | string)[];
  asides?: string[];
  edits?: Diff[];
  apps?: AppCall[];
  images?: ToolImage[];
  tab?: ChatTab;
};

/** An MCP tool's view in the chat, with the call it shows (handed to the big window). */
type AppHost = McpAppHostHandle & { call: AppViewCall };

/** A line in the composer's pop-up list: a command (/…), or a file to mention (@…). */
type PaletteCommand = { kind: 'local' | 'claude'; name: string; description: string; args?: string };
type PaletteFile = { kind: 'file'; rel: string; dir: boolean };

/** A message typed while it was still answering, waiting its turn. */
type Queued = { turnId: string; el: HTMLElement; ask: Ask };

/** Claude's question card, waiting for your answer. */
type PendingQuestion = { sent: boolean; card: HTMLElement; requestId?: string; closed?: string; typed(text: string): void; pickByNumber(n: number): void };

/** A step it took, as its chip shows it (live, or kept with the answer). */
type ToolCall = Omit<StepCall, 'at'> & { at?: number; running: boolean };

/** A helper agent at work, as its card shows it. */
type Helper = {
  id: string;
  description: string;
  status: string; // 'running', 'completed', 'failed', 'killed', 'stopped'…
  steps: { tool: string; detail: string; at: number }[];
  text: string;
  started: number;
  kind?: string;
  prompt?: string;
  background?: boolean;
  parent?: string | null;
  activity?: string;
  tokens?: number;
  toolsUsed?: number;
  summary?: string;
  report?: string;
  ended?: number;
};

/** A tab: one Claude Code conversation, its log, and how it's doing. */
type ChatTab = {
  id: string;
  log: HTMLElement;
  busy: boolean;
  current: Reply | null;
  question: PendingQuestion | null;
  statusText: string;
  status: 'idle' | 'done' | 'error'; // (done, error: not seen yet)
  activity: string; // what the robot does at its desk for it
  draft: string;
  queue: Queued[];
  data: RobotView['tabs'][number];
  key: string;
  title: string;
  custom: boolean;
  tasks: Task[];
  context?: ContextUse | null;
  model?: string;
  effort?: string;
  mode?: PermissionMode; // its permission mode (plan mode while it plans)
  canBypass?: boolean; // (the robot may be switched to full access: the Workshop's choice)
  verbs?: number;
  renderQueued?: boolean;
  calls?: Map<string, ToolCall>;
  agents?: Map<string, Helper>;
  justBack?: string | null;
  justDone?: string | null;
  todoCollapsed?: boolean;
  helpersCollapsed?: boolean;
  compacting?: boolean;
  compactResult?: Extract<ChatEvent, { type: 'compact' }> | null;
  warnedFull?: boolean;
  terminal?: boolean;
  remoteState?: string; // Remote Control's link to claude.ai: connecting, ready, connected…
  remoteAsked?: boolean; // (turned on from here: say how to reach it once it's on)
  bonk?: { turnId: string; ask: Ask } | null;
  hurried?: boolean;
  vocabWord?: string;
  noteId?: string;
  linkReq?: string;
  exchange?: string;
  task?: string;
  // the status line while it works: since when, and how much it has written
  turnStart?: number;
  outTokens?: number; // (as Claude Code counts them, when it says)
  outChars?: number; // (else estimated from what streamed in)
  sent?: string[]; // what you asked in it, for ↑ / ↓ in the composer
  rewinding?: boolean; // (its last question is being taken back, to edit or ask again)
};

/** What the robot's up to: its window's state. */
type RobotState = {
  character: RobotView | null;
  personalities: Record<string, Personality>;
  user: string;
  awake: boolean;
  collapsed: boolean;
  news: string;
  readonly busy: boolean;
  placement: Layout['placement'];
  robotX: number;
  robotY: number;
  pokes: number[];
  face: { eyes: string; mouth: string; until: number } | null;
  activity: string;
  pose: { name: string; until: number } | null;
  lookOverride: { dx: number; dy: number; until: number } | null;
  lastCursor: { dx: number; dy: number };
  lastActivity: number;
  attachments: FileInfo[];
  // (and as it goes)
  scale?: number;
  mirroring?: boolean;
  away?: boolean;
  leaving?: boolean;
  meeting?: boolean;
  visiting?: { host: string; mode: Extract<SocialEvent, { phase: 'visit' }>['mode'] | 'lunch' } | null;
  hosting?: boolean;
  awayNews?: string;
  playing?: string | null;
  playingByUser?: boolean;
  waking?: boolean;
  lastBonk?: number;
  slacking?: number;
  claudeCommands?: ClaudeCommand[];
  peek?: boolean;
};

showView(markup, { title: 'C-Bot', bodyClass: 'asleep' });
tooltips(document.querySelector<HTMLElement>('#panel')!); // (the chat's buttons say what they do)
tooltips(document.querySelector<HTMLElement>('#side-panel')!);

(() => {
  // (the view's elements: always in its markup, robot.html)
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
  const body = document.body;
  const robot = $('#robot');
  // The 3D office renders whatever state this script puts on #robot and <body>.
  const ROBOT_W = 300;
  const ROBOT_H = 290;
  // (its canvas gone for good: main builds the window again, app/src/revive.rs)
  const office = Office3D.mount($('#bot-host'), { stateEl: robot, moodEl: body, width: ROBOT_W, height: ROBOT_H, onLost: ipc.robotRevive });
  // Check in with main every so often, and say when the page is hidden: one that goes quiet
  // is built again, one hidden while its window shows is nudged to draw (revive.rs).
  const ALIVE_EVERY = 10000;
  const alive = () => ipc.robotAlive(document.visibilityState === 'hidden');
  alive();
  setInterval(alive, ALIVE_EVERY);
  document.addEventListener('visibilitychange', alive);
  const logs = $('#logs');
  const tabStrip = $('#tabs');
  const input = $<HTMLTextAreaElement & { t?: number }>('#input'); // (t: its typing timer)

  // Each tab is its own Claude Code conversation (they can run at the same
  // time). Per tab: its log, the reply being streamed, an open question, the
  // status line and a badge state.
  const tabs = new Map<string, ChatTab>(); // id -> tab
  let activeId: string | null = null;
  let lastMainActive: string | null = null;
  const active = () => tabs.get(activeId!); // (none yet: undefined)
  const statusRow = $('#status');
  const statusText = $('#status-text');
  const statusMeta = $('#status-meta');
  const pop = $('#pop');

  const AUTO_SLEEP_MS = 3 * 60 * 1000;
  const THINKING_VERBS = [
    'Thinking', 'Pondering', 'Crunching bits', 'Consulting my circuits', 'Rummaging around',
    'Warming up the neurons', 'Beep-booping', 'Reticulating splines', 'Oiling the gears',
  ];
  // tool name -> [chip emoji, verb, what the robot does at its desk]
  const TOOLS: Record<string, [string, string, string]> = {
    Read: ['📖', 'Reading', 'read'],
    Glob: ['🗂️', 'Looking for', 'search'],
    Grep: ['🔍', 'Searching for', 'search'],
    Bash: ['⚙️', 'Running', 'run'],
    PowerShell: ['⚙️', 'Running', 'run'],
    Edit: ['✏️', 'Editing', 'edit'],
    MultiEdit: ['✏️', 'Editing', 'edit'],
    Write: ['📝', 'Writing', 'edit'],
    NotebookEdit: ['📓', 'Editing', 'edit'],
    WebSearch: ['🌐', 'Searching the web for', 'web'],
    WebFetch: ['🌐', 'Visiting', 'web'],
    Task: ['🤖', 'Sending a helper bot:', 'agent'],
    Agent: ['🤖', 'Sending a helper bot:', 'agent'],
    TodoWrite: ['✅', 'Planning', 'plan'],
    AskUserQuestion: ['✋', 'Asking you', 'ask'],
    ToolSearch: ['🧰', 'Looking up tools:', 'think'],
    TaskCreate: ['📋', 'Adding a task:', 'plan'],
    TaskUpdate: ['✅', 'Updating task', 'plan'],
    TaskList: ['📋', 'Checking the plan', 'plan'],
    TaskGet: ['📋', 'Checking a task', 'plan'],
    Skill: ['🎓', 'Using the skill', 'read'],
    // asking another robot (main robotLink.js)
    mcp__cbot__ask_robot: ['🤖', 'Asking', 'agent'],
    mcp__cbot__list_robots: ['🤖', 'Looking for the other robots', 'agent'],
    mcp__cbot__hand_off_task: ['📋', 'Handing off', 'agent'],
    // your words and notebook
    mcp__cbot__list_words: ['📚', 'Checking your words', 'read'],
    mcp__cbot__save_words: ['📚', 'Saving the words', 'edit'],
    mcp__cbot__list_notes: ['🗒️', 'Reading your notes', 'read'],
    mcp__cbot__add_note: ['🗒️', 'Noting down', 'edit'],
    // the shells in its conversation's drawer
    mcp__cbot__terminal_read: ['💻', 'Reading the terminal', 'read'],
    mcp__cbot__terminal_type: ['💻', 'Typing in the terminal:', 'run'],
    mcp__cbot__terminal_run: ['💻', 'Running in the terminal:', 'run'],
  };
  // a tool chip's line icon, by the kind of step (../ui/icons.js)
  const TOOL_ICONS: Record<string, string> = { read: 'file', search: 'search', run: 'terminal', edit: 'edit', web: 'globe', agent: 'bot', plan: 'plan', ask: 'help', think: 'wrench' };
  // monitor scene -> how the robot sits while it's on screen
  const POSES: Record<string, string> = {
    off: 'sleep', boot: 'idle', idle: 'idle', think: 'thinking', talk: 'talking',
    read: 'reading', search: 'reading', web: 'reading', agent: 'reading',
    edit: 'typing', run: 'typing', plan: 'typing',
    done: 'cheer', error: 'idle', locked: 'idle', ask: 'raise', compact: 'typing',
    helpers: 'thinking', // supervising its helper agents: chin in hand, watching them circle
    dance: 'cheer',
  };
  // where the monitor is, relative to the robot's face, for eye tracking
  const MONITOR = { dx: 200, dy: 50 };

  const state: RobotState = {
    character: null,
    personalities: {},
    user: 'friend',
    awake: false,
    collapsed: false, // awake, but you tucked the chat away to watch it work
    news: '', // what happened while the chat was tucked away (shown on the status bubble)
    // the robot is "busy" while any of its tabs is working
    get busy() {
      return [...tabs.values()].some((t) => t.busy);
    },
    placement: 'none',
    robotX: 0,
    robotY: 0,
    pokes: [],
    face: null, // temporary expression override
    activity: 'off', // what's on the monitor
    pose: null, // temporary pose override
    lookOverride: null,
    lastCursor: { dx: 0, dy: 0 },
    lastActivity: Date.now(),
    attachments: [], // (the files fed to it: see feeding files)
  };

  const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const persona = () => state.personalities[state.character?.personality ?? ''] || Object.values(state.personalities)[0];
  const folderName = () => (state.character?.folder || '').split(/[\\/]/).filter(Boolean).pop() || 'this folder';
  const fill = (line: string) =>
    line.replaceAll('{name}', state.character!.name).replaceAll('{folder}', folderName()).replaceAll('{user}', state.user);
  const fileIcon = (f: { isDir: boolean; isImage: boolean }) => (f.isDir ? 'folder' : f.isImage ? 'image' : 'file'); // (a ui/icons.js name)
  // "anthropic-skills:pptx" -> "pptx (anthropic-skills)", as the bridge describes it live
  const skillLabel = (s: string) => {
    const i = s.lastIndexOf(':');
    return i > 0 ? `${s.slice(i + 1)} (${s.slice(0, i)})` : s;
  };

  // ------------------------------------------------------------ markdown

  marked.setOptions({ gfm: true, breaks: true });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Local files in answers. Pictures Claude made or points at are shown (through
  // main's cbot-file: protocol), and file links or `C:\…\file.ext` paths open the file.
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
  // an absolute local path from "C:\…", "/…", "\\server\…", "file:///…", or a path inside the robot's folder
  function localPath(href: string | null | undefined) {
    let p = String(href || '').trim();
    if (!p || p.startsWith('#')) return null;
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(new URL(p).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
      } catch {
        return null;
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
      return null; // a web link or another scheme
    } else if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)) {
      const folder = state.character?.folder;
      if (!folder || /^[a-z]+\.[a-z]{2,}\//i.test(p)) return null; // "example.com/…" is not a file
      p = `${folder.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '')}`;
    }
    return p;
  }
  // (under Tauri the protocol is served from http://cbot-file.localhost/: its bridge says so)
  const FILE_URL = ipc.fileUrl;
  const imageUrl = (p: string, v: string | number = '') => `${FILE_URL}img/?path=${encodeURIComponent(p)}${v ? `&v=${v}` : ''}`;
  const openUrl = (p: string) => `${FILE_URL}open/?path=${encodeURIComponent(p)}`;
  marked.use({
    walkTokens(t) {
      if (t.type !== 'image' && t.type !== 'link') return;
      const p = localPath(t.href);
      if (!p) return;
      t.href = t.type === 'image' && IMAGE_EXT.test(p) ? imageUrl(p) : openUrl(p);
    },
  });
  const PURIFY = { ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cbot-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i, RETURN_DOM_FRAGMENT: true } as const;
  const ABS_FILE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|mnt)\/)[^\n<>"|?*]*\.[A-Za-z0-9]{1,8}$/;
  function md(text: string) {
    const frag = DOMPurify.sanitize(marked.parse(text || '') as string, PURIFY); // (no async extensions: parsed straight away)
    // `C:\…\rocket.svg` in code: clickable, and pictures show right under it
    for (const code of frag.querySelectorAll('code')) {
      if (code.closest('pre')) continue;
      const p = code.textContent.trim().replace(/^["']|["']$/g, '');
      if (!ABS_FILE.test(p)) continue;
      code.classList.add('file-path');
      code.dataset.open = p;
      code.title = 'Open this file';
      if (!IMAGE_EXT.test(p)) continue;
      const img = document.createElement('img');
      img.className = 'local-img';
      img.src = imageUrl(p);
      img.alt = p.split(/[\\/]/).pop()!;
      img.dataset.open = p;
      (code.closest('p, li') || code).after(img);
    }
    for (const img of frag.querySelectorAll<HTMLImageElement>(`img[src^="${FILE_URL}img/"]`)) {
      img.classList.add('local-img');
      img.dataset.open = new URL(img.src).searchParams.get('path')!; // (our picture links carry their path)
    }
    const box = document.createElement('div');
    box.appendChild(frag);
    dressCode(box); // (highlighted, with a Copy button)
    return box.innerHTML;
  }

  // a code block's Copy button (code.ts)
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.code-copy');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('pre')?.textContent ?? '';
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => ((btn.textContent = 'Copy'), btn.classList.remove('done')), 1400);
    }, () => {});
  });

  // a picture its file card already shows isn't shown again under its path in the text
  const samePath = (p: string | undefined) => String(p || '').replace(/\//g, '\\').toLowerCase();
  function dedupePics(el: HTMLElement) {
    const shown = new Set([...el.querySelectorAll<HTMLImageElement>('.d-preview img')].map((i) => samePath(i.dataset.open)));
    if (!shown.size) return;
    for (const img of el.querySelectorAll<HTMLImageElement>('img.local-img')) {
      if (!img.closest('.d-preview') && shown.has(samePath(img.dataset.open))) img.remove();
    }
  }

  // clicking a local file (a link, a path, a picture) shows it in the chat; Ctrl+click opens
  // it in its app (programs are only shown in their folder)
  const openInApp = (p: string) => ipc.robotOpenFile(p).then((res) => res && !res.ok && showPop(res.error, 2400));
  document.addEventListener('click', (e) => {
    // (a click lands on an element; the link's href is read only when it has no data-open)
    const link = (e.target as Element).closest<HTMLAnchorElement>(`a[href^="${FILE_URL}open/"], [data-open]`);
    if (!link) {
      // a web link opens in the browser (the webview won't open a new window for target=_blank)
      const web = (e.target as Element).closest<HTMLAnchorElement>('a[href^="http://"], a[href^="https://"]');
      if (web && !web.href.startsWith(FILE_URL)) {
        e.preventDefault();
        ipc.robotOpenLink(web.href);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const p = link.dataset.open || new URL(link.href).searchParams.get('path')!; // (our file links carry their path)
    if (e.ctrlKey || e.metaKey) openInApp(p);
    else openFileView(p);
  });
  // a picture that isn't there (yet, or anymore) just disappears
  document.addEventListener('error', (e) => (e.target as Element).matches?.('img.local-img') && (e.target as Element).remove(), true);

  // ------------------------------------------------------------ face

  function baseFace() {
    if (!state.awake && !state.busy && !state.mirroring && !helpersOut()) return { eyes: 'closed', mouth: 'flat' };
    if (body.classList.contains('talking')) return { eyes: 'open', mouth: 'talk' };
    if (state.busy || helpersOut()) return { eyes: 'open', mouth: 'o' };
    return { eyes: 'open', mouth: 'smile' };
  }

  function renderFace() {
    const f = state.face && state.face.until > Date.now() ? state.face : baseFace();
    robot.dataset.eyes = f.eyes;
    robot.dataset.mouth = f.mouth;
  }

  function express(eyes: string, mouth: string, ms = 1500) {
    state.face = { eyes, mouth, until: Date.now() + ms };
    renderFace();
    setTimeout(renderFace, ms + 20);
  }

  function flash(cls: string, ms = 600) {
    robot.classList.remove(cls);
    void robot.offsetWidth; // restart the animation
    robot.classList.add(cls);
    setTimeout(() => robot.classList.remove(cls), ms);
  }

  // ------------------------------------------------------------ desk activity

  // helper agents still at work, in one tab or all of them
  function helpersOut(tab?: ChatTab) {
    let n = 0;
    for (const t of tab ? [tab] : tabs.values()) for (const a of t.agents?.values() || []) if (a.status === 'running') n++;
    return n;
  }

  function restingActivity() {
    if (helpersOut() && !body.classList.contains('talking')) return 'helpers';
    if (state.busy) return 'think';
    if (state.mirroring) return 'idle';
    return state.awake ? 'idle' : 'off';
  }

  // Switch what the monitor shows (and with it how the robot sits). With `ms`
  // the scene is temporary and falls back to the resting one afterwards.
  function setActivity(activity: string, ms?: number) {
    clearTimeout(setActivity.t);
    if (activity !== 'idle' && activity !== 'off' && activity !== 'edit') stopAntic();
    state.activity = activity;
    robot.dataset.screen = activity;
    renderPose();
    if (ms) setActivity.t = setTimeout(() => setActivity(restingActivity()), ms);
  }
  setActivity.t = 0; // (its timer back to the resting scene)

  function renderPose() {
    const override = state.pose && state.pose.until > Date.now() ? state.pose.name : null;
    let pose = override || POSES[state.activity] || 'idle';
    if (!override && !state.awake && !state.busy && !helpersOut()) pose = 'sleep'; // a strike (e.g. reaching for food) wakes it briefly
    // nodding off: in the chair with an eye mask, or on the floor under a blanket (a coin toss each time)
    if (pose === 'sleep' && robot.dataset.pose !== 'sleep') robot.dataset.sleepStyle = Math.random() < 0.5 ? 'chair' : 'floor';
    robot.dataset.pose = pose;
    nightcap();
    look();
  }

  function strikePose(name: string, ms: number) {
    // keep the hand up while a question waits (only reaching for a dropped file may interrupt)
    if (pendingQuestion() && name !== 'eager') return;
    state.pose = { name, until: Date.now() + ms };
    renderPose();
    setTimeout(renderPose, ms + 20);
  }

  function look() {
    if (state.peek) return; // (away on the island: nobody to look at)
    let { dx, dy } = state.lastCursor;
    const pose = robot.dataset.pose;
    let follow = pose === 'idle' || pose === 'talking' || pose === 'wave' || pose === 'cheer' || pose === 'eager';
    if (state.lookOverride && state.lookOverride.until > Date.now()) {
      ({ dx, dy } = state.lookOverride);
      follow = false;
    } else if (pose === 'reading' || pose === 'typing') ({ dx, dy } = MONITOR);
    else if (pose === 'thinking') ({ dx, dy } = { dx: -80, dy: -200 });
    else if (pose === 'sleep') ({ dx, dy } = { dx: 0, dy: 0 });
    const dist = Math.hypot(dx, dy) || 1;
    const reach = clamp(dist / 120, 0, 1);
    const lx = (dx / dist) * 6 * reach;
    const ly = (dy / dist) * 4 * reach;
    const root = document.documentElement.style;
    root.setProperty('--look-x', `${lx.toFixed(2)}px`);
    root.setProperty('--look-y', `${ly.toFixed(2)}px`);
    root.setProperty('--tilt', `${(follow && state.awake ? lx * 0.8 : 0).toFixed(2)}deg`);
  }

  function lookAt(dx: number, dy: number, ms: number) {
    state.lookOverride = { dx, dy, until: Date.now() + ms };
    look();
    setTimeout(look, ms + 20);
  }

  function showPop(text: string, ms = 2400) {
    if (!state.awake) return;
    // prefer the open side of the robot's head (the monitor sits on its right)
    pop.classList.toggle('right', state.robotX + 60 < 130);
    pop.textContent = text;
    pop.classList.add('show');
    clearTimeout(showPop.t);
    showPop.t = setTimeout(() => pop.classList.remove('show'), ms);
  }
  showPop.t = 0;

  // ------------------------------------------------------------ life cycle

  function applyCharacter(c: RobotView) {
    state.character = c;
    if (!body.classList.contains('resizing-v') && (c.chatHeight ?? null) !== chatH) {
      chatH = c.chatHeight ?? null; // (how tall you made its chat)
      if (body.classList.contains('expanded')) placePanel();
    }
    document.documentElement.style.setProperty('--paint', c.color || '#5ac8fa');
    const face = $('#stage-face');
    if (!face.firstChild) face.innerHTML = headSvg();
    face.style.color = c.color || '#5ac8fa';
    $('#name').textContent = c.name;
    $('#nametag').textContent = c.name;
    const chip = $('#folder');
    chip.innerHTML = `${Icon('folder', 'sm')}<span></span>`;
    chip.lastChild!.textContent = folderName();
    chip.title = c.folder;
    robot.dataset.acc = c.accessory || 'none';
    // its size: the robot box scales as one, the 3D view renders sharp at that size
    const k = ({ small: 0.7, large: 1.35, huge: 1.7 } as Partial<Record<RobotSize, number>>)[c.size ?? 'normal'] || 1;
    document.documentElement.style.setProperty('--s', String(k));
    state.scale = k;
    office.setScale(k);
    robot.dataset.body = 'kit';
    robot.dataset.kit = JSON.stringify(c.kit || {}); // (its parts: office3d/kit3d.js)
    robot.dataset.theme = c.theme || 'classic';
    robot.dataset.name = c.name;
    document.title = c.name;
  }

  function renderHistory(tab: ChatTab = active()!) {
    tab.log.innerHTML = '';
    if (tab.data?.temporary) addNote('🕶️ Temporary chat: nothing here is kept. It’s gone, Claude Code’s transcript too, when you close this tab.', 'temp-note', tab);
    for (const h of (tab.data.history || []).slice(-30)) {
      if (h.role === 'qa') addQaSummary(h.items, tab);
      else if (h.role === 'plan') tab.log.appendChild(planSummary(md, h));
      else if (h.role === 'note') addNote(h.text, '', tab);
      else if (h.role === 'user') addUser(h.text, h.files, tab, h.tag);
      else sides.attach(addBot(h.interrupted ? `${h.text || ''}\n\n_…(stopped)_` : h.text, { error: h.isError, denials: h.denials, tools: h.tools, asides: h.asides, edits: h.edits, apps: h.apps, images: h.images, tab }), h.at, tab);
    }
  }

  // tucked: just awake enough to show something (a word you caught), the chat stays tucked away
  function wake({ sayHi = true, tucked = false } = {}) {
    if (state.away) return awayClick(); // it's out: drag it back first
    if (state.awake) return;
    unpeek(); // (away on the island: it comes back out first)
    state.awake = true;
    stopAntic();
    state.lastActivity = Date.now();
    body.classList.remove('asleep');
    body.classList.add('awake');
    (tucked ? Sfx : Sfx.key).wake(); // (woken for something it shows by itself: an extra)
    flash('shake', 500);
    express('open', 'o', 700);
    // jolt awake and boot the computer (unless it's already busy working)
    if (!state.busy) setActivity('boot', 1000);
    else renderPose();
    if (tucked) {
      state.collapsed = true;
      body.classList.add('collapsed');
      renderWorking();
      ipc.robotExpand(false, { tucked: true });
    } else ipc.robotExpand(true);
    const hadBadge = body.classList.contains('has-badge');
    body.classList.remove('has-badge');
    readVisitNote();
    setTimeout(() => {
      flash('hop', 600);
      if (!hadBadge && !state.busy && sayHi) greet();
      scrollDown();
      if (!tucked) input.focus();
    }, 300);
  }

  // The chat stays open while the robot works, unless you tuck it away (🔽) to
  // watch the robot instead: a status bubble says what it's up to. It stays
  // tucked away until you click the bubble or the robot, even when the task is
  // done or Claude needs you; the bubble says so instead.
  function collapse() {
    if (!state.awake || state.collapsed || state.mirroring) return;
    state.collapsed = true;
    hidePalette();
    panelOut(() => {
      if (!state.collapsed || !state.awake) return; // (opened again meanwhile)
      body.classList.add('collapsed');
      renderWorking();
      ipc.robotExpand(false, { tucked: true });
    });
  }

  // The chat panel shrinks away before the window does (then main hides the window's resize)
  const PANEL_OUT = 140;
  function panelOut(then: () => void) {
    if (!body.classList.contains('expanded')) return then();
    body.classList.add('panel-out');
    setTimeout(() => {
      body.classList.remove('panel-out');
      then();
    }, PANEL_OUT);
  }

  function openChat({ focus = true } = {}) {
    if (state.away) return awayClick(); // it's out for a walk: drag it back first
    if (!state.collapsed) return;
    state.collapsed = false;
    state.news = '';
    body.classList.remove('collapsed');
    renderWorking();
    ipc.robotExpand(true, { focus });
    if (focus) input.focus();
  }

  const workingEl = $('#working');
  function renderWorking() {
    islandReport(); // (the island hears what it's up to, too)
    workingEl.hidden = !state.collapsed;
    if (!state.collapsed) return;
    const asking = [...tabs.values()].some((x) => x.question);
    const t = active()?.busy ? active() : [...tabs.values()].find((x) => x.busy);
    const out = helpersOut();
    $('#working-text').textContent = plain(asking
      ? '✋ I have a question for you. Click to answer'
      : t
        ? t.statusText || 'Working on it…'
        : out
          ? `🤖 ${out === 1 ? 'A helper is' : `${out} helpers are`} still working…`
          : state.news || 'Waiting for a question');
    workingEl.classList.toggle('news', asking || (!t && !!state.news));
    workingEl.classList.toggle('idle', !asking && !t && !out && !state.news); // (its dots keep still)
  }
  workingEl.addEventListener('click', () => openChat());

  function sleep({ auto = false } = {}) {
    if (!state.awake) return;
    if (auto && shell.running()) return; // (dozing off would end them: a dev server, say)
    shell.end(); // (its shell goes to bed too, with whatever was running in it)
    if (state.away) ipc.robotWalker('asleep'); // dozes off out there: it sleepwalks
    state.awake = false;
    stopAntic();
    state.collapsed = false;
    state.news = '';
    body.classList.remove('collapsed');
    renderWorking();
    (auto ? Sfx : Sfx.key).sleep(); // (dozing off by itself: an extra)
    express('closed', 'o', 900);
    body.classList.remove('awake');
    body.classList.add('asleep');
    panelOut(() => {
      if (state.awake) return; // (woken again meanwhile)
      body.classList.remove('expanded');
      ipc.robotExpand(false);
    });
    // a busy robot keeps working at its desk; otherwise the monitor goes dark
    if (!state.busy) setActivity('off');
    else renderPose();
    renderFace();
    socialReport({ kind: 'slept' });
  }

  // ---- away on the robot island
  // Out of your way: its window is veiled (main, robots.rs, with the "hidden" layout) and
  // its face waits on the robot island at the screen's edge (island.rs), which says what
  // it's up to and shows its news. It keeps working meanwhile; the 3D desk stops drawing.
  // Bringing it out from the island (or anything that wakes it) brings it back.
  function peek() {
    if (state.peek || state.away || state.leaving || state.mirroring) return;
    if (state.awake) {
      sleep(); // (busy, it keeps working away)
      return void setTimeout(() => state.awake || peek(), PANEL_OUT + 60);
    }
    state.peek = true;
    stopAntic();
    Sfx.swish();
    robot.dataset.peek = '1';
    ipc.robotPeek(true);
    socialReport();
    islandReport();
  }
  function unpeek() {
    if (!state.peek) return;
    state.peek = false;
    robot.dataset.peek = '';
    ipc.robotPeek(false);
    islandReport();
    Sfx.pop();
    setTimeout(() => flash('hop', 600), 120);
  }

  // How it is, for the island: said whenever it changes (renderWorking hears most of it),
  // and every few seconds. Straight away, not on a timer: a veiled page's timers may be slow.
  let islandSaid = '';
  let islandQueued = false;
  function islandReport(news?: IslandNews) {
    if (news) return ipc.robotIsland(islandNow(), news);
    if (islandQueued) return;
    islandQueued = true;
    queueMicrotask(() => {
      islandQueued = false;
      const now = islandNow();
      const said = JSON.stringify(now);
      if (said === islandSaid) return;
      islandSaid = said;
      ipc.robotIsland(now);
    });
  }
  islandReport.again = () => {
    islandSaid = '';
    islandReport();
  };
  function islandNow(): IslandReport {
    const t = active()?.busy ? active() : [...tabs.values()].find((x) => x.busy);
    const out = helpersOut();
    const text = t ? plain(t.statusText || 'Working on it…') : out ? `${out === 1 ? 'A helper is' : `${out} helpers are`} still working…` : '';
    return { awake: state.awake, busy: !!t || out > 0, text, since: t?.turnStart || null, asking: !!pendingQuestion() };
  }
  // its news, while it's away: what it said, in a line
  function islandNews(kind: IslandNews['kind'], text: string) {
    if (!state.peek) return; // (out on the desk, its own bubble says it)
    const line = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|[\]]/g, '').replace(/\s+/g, ' ').trim();
    islandReport({ kind, text: line.length > 140 ? `${line.slice(0, 139)}…` : line });
  }

  function greet() {
    active()!.log.querySelectorAll('.greet').forEach((el) => el.remove());
    const el = addBot(fill(pick(persona().greetings)));
    el.classList.add('greet');
    setTimeout(() => strikePose('wave', 1600), 700);
  }

  // ------------------------------------------------------------ chat log

  function scrollDown(tab = active()) {
    if (tab) tab.log.scrollTop = tab.log.scrollHeight;
  }

  const thumbImg = (src: string) => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = src;
    return img;
  };

  // text with its @mentions picked out
  function withMentions(el: HTMLElement, text: string) {
    const re = /(^|\s)(@(?:"[^"\n]+"|[^\s"]+))/g;
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
  function addUser(text: string, files: (FileChip & { path?: string; thumb?: string })[] = [], tab: ChatTab = active()!, tag = '') {
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
    msgActions(el, 'user', tab);
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  function addBot(text: string, { error = false, denials = [], tools = [], asides = [], edits = [], apps = [], images = [], tab = active()! }: BotOpts = {}) {
    const el = document.createElement('div');
    el.className = `msg bot${error ? ' error' : ''}`;
    // steps saved with where they came in the words (at) go back there, each followed by what
    // it made; older answers (and anything without a step to follow) keep it all on top
    const placed = (tools || []).filter((t) => t && typeof t === 'object' && Number.isFinite(t.at)) as StepCall[]; // (steps, not names)
    const made = new Map<string, Node[]>(); // step id -> what it made [element]
    const loose: Node[] = []; // made by no step we can place
    const ids = new Set(placed.map((t) => t.id));
    const madeBy = (id: string | undefined, node: Node) => (id && ids.has(id) ? made.set(id, [...(made.get(id) || []), node]) : loose.push(node));
    for (const d of edits || []) madeBy(d.id, diffCard(d));
    for (const a of apps || []) madeBy(a.id, appCard(a));
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
      box.innerHTML = md(s);
      el.appendChild(box);
    };
    // on top: the steps we can't place, the asides, what no placed step made
    const topSteps = toolChips((tools || []).filter((t) => !(placed as (StepCall | string)[]).includes(t)), tab);
    for (const a of asides || []) topSteps.appendChild(asideChip(a));
    if (topSteps.children.length) el.appendChild(topSteps);
    if (loose.length) block('edits', loose);
    let pos = 0;
    for (let i = 0; i < placed.length; ) {
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
    if (!el.children.length) el.innerHTML = md(words || '…');
    if (denials?.length) el.appendChild(deniedNote(denials));
    dedupePics(el);
    rawText.set(el, words);
    msgActions(el, 'bot', tab);
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
      chip.lastChild!.textContent = `${name}${detail ? `: ${skillLabel(detail)}` : ''}${n > 1 ? ` ×${n}` : ''}`;
      row.appendChild(chip);
    }
    return row;
  }

  // a tool step's look: "mcp__claude_ai_Excalidraw__create_view" -> 🧩 Excalidraw: create_view
  function toolLook(name: string, detail?: string) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    const [emoji, verb, activity] = TOOLS[name] || (mcp ? ['🧩', `${serverLabel(mcp[1])}: ${mcp[2]}`, 'run'] : ['🛠️', `Using ${name}`, 'run']);
    const text = `${verb}${detail ? ' ' + detail : ''}`;
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
    row.querySelector('.step-text')!.textContent = look.text;
    setStepOut(row, call);
    stepCalls.set(row, call);
    const head = row.querySelector<HTMLElement>('.step-head')!;
    head.title = `${look.label} (click for the details)`;
    const toggle = () => {
      if ((call.name === 'Agent' || call.name === 'Task') && tab?.agents?.has(call.id)) return openHelper(tab, call.id);
      const open = row.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      if (open) renderStepDetail(row, tab);
      else row.querySelector(':scope > .step-detail')?.remove();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
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
    const pre = (cls: string, text: string) => Object.assign(document.createElement('pre'), { className: cls, textContent: text });
    const note = (text: string) => Object.assign(document.createElement('div'), { className: 'sd-note', textContent: text });
    const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : null;
    const str = (k: string) => (typeof args?.[k] === 'string' ? (args[k] as string) : '');
    if (str('command')) box.appendChild(pre('sd-in sd-cmd', str('command')));
    const file = str('file_path') || str('notebook_path') || (/^([a-zA-Z]:[\\/]|\\\\)/.test(str('path')) ? str('path') : '');
    if (file) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-file';
      b.dataset.open = file;
      b.title = `${file}\nClick to look at it here (Ctrl+click: open it)`;
      b.innerHTML = `${Icon(str('file_path') || str('notebook_path') ? 'file' : 'folder', 'sm')}<span></span>${Icon('right', 'sm')}`;
      b.querySelector('span')!.textContent = file;
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
      const out = call.output.length > STEP_OUT_MAX ? `${call.output.slice(0, STEP_OUT_MAX)}\n… (${(call.output.length - STEP_OUT_MAX).toLocaleString()} more characters)` : call.output;
      box.appendChild(pre(`sd-out${call.isError ? ' error' : ''}`, out));
    } else box.appendChild(note(call.trimmed ? 'What came back wasn’t kept in the saved history (it was too big).' : 'Nothing came back.'));
    const full = document.createElement('button');
    full.type = 'button';
    full.className = 'sd-full';
    full.dataset.icon = 'expand';
    full.textContent = 'Full details';
    full.addEventListener('click', () => openToolView(tab, call));
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
      head.innerHTML = '<span class="sh-caret" aria-hidden="true">›</span><span class="sh-text"></span><span class="sh-now"></span><span class="sh-n"></span>';
      head.addEventListener('click', () => {
        const fold = !row.classList.contains('folded');
        row.classList.toggle('folded', fold);
        foldSteps(row);
        if (fold) return;
        // (they come down one after another)
        row.querySelectorAll<HTMLElement>(':scope > .step').forEach((s, i) => s.style.setProperty('--i', String(Math.min(i, 12))));
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
    head.querySelector('.sh-text')!.textContent = stepsSummary(steps);
    // (while it works: what it's on now, so a folded run still shows it going)
    const now = row.classList.contains('live') ? (steps.findLast((s) => s.classList.contains('running')) ?? steps[steps.length - 1]) : null;
    head.querySelector('.sh-now')!.textContent = now?.querySelector('.step-text, .think-label')?.textContent ?? '';
    head.querySelector('.sh-n')!.textContent = [`${steps.length} steps`, failed ? `${failed} failed` : '', running ? 'working…' : ''].filter(Boolean).join(' · ');
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
    d.innerHTML = '<summary><span class="think-star">✻</span><span class="think-label"></span></summary><div class="think-text"></div>';
    d.querySelector('.think-text')!.textContent = (call.output || '').trim();
    d.querySelector('.think-label')!.textContent = call.running ? 'Thinking…' : 'Thought';
    d.classList.toggle('running', call.running);
    d.classList.toggle('empty', !call.running && !(call.output || '').trim());
    return d;
  }
  // done thinking (words or a step came next, or the answer's over): how long it took
  function settleThinking(tab: ChatTab) {
    for (const d of tab.log.querySelectorAll<HTMLElement>('.step.think.running')) {
      d.classList.remove('running');
      const s = Math.max(1, Math.round((Date.now() - Number(d.dataset.start)) / 1000));
      d.querySelector('.think-label')!.textContent = `Thought for ${s}s`;
      d.classList.toggle('empty', !d.querySelector('.think-text')!.textContent!.trim());
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
    Object.assign(card.dataset, { file: d.file, created: d.created ? '1' : '', added: String(d.added || 0), removed: String(d.removed || 0) });
    const folder = (state.character?.folder || '').replace(/[\\/]+$/, '');
    const inside = folder && /^[\\/]$/.test(d.file[folder.length] || '') && d.file.toLowerCase().startsWith(folder.toLowerCase());
    const rel = inside ? d.file.slice(folder.length + 1) : d.file;
    const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    const sum = document.createElement('summary');
    sum.title = d.file;
    sum.innerHTML = `<span class="d-verb"></span><b class="d-name"></b><span class="d-dir"></span><span class="d-add"></span><span class="d-del"></span><button class="d-open" type="button" title="Open the file">${Icon('open', 'sm')}</button>`;
    sum.querySelector<HTMLElement>('.d-open')!.dataset.open = d.file;
    sum.querySelector('.d-verb')!.textContent = d.created ? 'Created' : 'Updated';
    sum.querySelector('.d-name')!.textContent = rel.slice(cut + 1);
    sum.querySelector('.d-dir')!.textContent = cut > 0 ? rel.slice(0, cut) : '';
    sum.querySelector('.d-add')!.textContent = d.added ? `+${d.added}` : '';
    sum.querySelector('.d-del')!.textContent = d.removed ? `−${d.removed}` : '';
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
    if (!IMAGE_EXT.test(d.file)) {
      card.appendChild(body);
      return card;
    }
    // a picture (an SVG it drew, a PNG it saved): show it, with its source folded away
    card.open = true;
    const pic = document.createElement('div');
    pic.className = 'd-preview';
    const img = document.createElement('img');
    img.className = 'local-img';
    img.src = imageUrl(d.file, d.at || d.id || Date.now()); // (one per edit: re-renders keep it cached)
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

  // ------------------------------------------------------------ MCP tool views

  // Some MCP tools (Excalidraw's create_view…) come with their own page that shows
  // what they did: an MCP App, hosted by McpAppHost (appHost.js). Its fullscreen
  // button opens the same view in a big window of its own.
  const APP_MAX_H = 560;
  const appsById = new Map<string, AppHost>(); // tool call id -> host (for results that arrive later)
  const serverLabel = (s: string) => s.replace(/^claude_ai_/, '').replace(/_/g, ' ');

  // a: { id, input, result } plus either the view ({ server, tool, uri }) or the tool's name to look it up
  function appCard(a: (AppCall & { uri?: undefined }) | AppViewCall) {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.innerHTML = `<div class="app-head"><span class="app-title"></span><span class="app-state">loading…</span><button class="app-big" type="button" title="Open in a big window" hidden>${Icon('expand', 'sm')}</button></div>`;
    const title = card.querySelector<HTMLElement>('.app-title')!;
    const status = card.querySelector<HTMLElement>('.app-state')!;
    const bigBtn = card.querySelector<HTMLButtonElement>('.app-big')!;
    Icon.text(title, '🧩 Tool view');
    (async () => {
      const view = a.uri ? a : await ipc.robotAppView((a as AppCall).name); // (no view: kept with its answer, with its tool's name)
      if (!view) return card.remove(); // no view after all (or its server is out of reach)
      Icon.text(title, `🧩 ${serverLabel(view.server)} · ${view.tool}`);
      const page = await ipc.robotAppPage(view.server, view.uri);
      if (!page.ok) {
        status.textContent = `couldn't load: ${page.error}`;
        return;
      }
      const frame = McpAppHost.frameFor(page, title.textContent);
      frame.style.height = '360px';
      card.classList.toggle('bordered', page.prefersBorder);
      card.appendChild(frame);
      frame.src = page.url;
      const call = { id: a.id, server: view.server, tool: view.tool, uri: view.uri, input: a.input, result: a.result };
      const openBig = () => ipc.robotAppWindow({ ...call, title: title.textContent.replace(/^🧩 /, '') });
      const host = McpAppHost.create({ // (its call goes on it below)
        frame,
        ...call,
        displayMode: 'inline',
        maxHeight: APP_MAX_H,
        onReady: () => {
          status.textContent = '';
          bigBtn.hidden = false;
        },
        onSize: (h) => (frame.style.height = `${clamp(h, 80, APP_MAX_H)}px`),
        // its own fullscreen button: the view opens big in its own window, this one stays inline
        onDisplayMode: (mode) => {
          if (mode === 'fullscreen') openBig();
          return 'inline';
        },
        // the view wants to say something in the chat: put it in the box, you send it
        onMessage: (text) => {
          openChat();
          input.value = text;
          autosize();
          input.focus();
        },
      }) as AppHost;
      bigBtn.addEventListener('click', openBig);
      host.call = call;
      appsById.set(a.id, host);
      if (appsById.size > 60) appsById.delete(appsById.keys().next().value!);
      setTimeout(() => !host.ready && (status.textContent = "didn't start"), 20000);
    })();
    return card;
  }

  function appResult(id: string, result: unknown) {
    const host = appsById.get(id);
    if (!host) return;
    host.call.result = result; // for the big window
    host.setResult(result);
  }

  function asideChip(text: string) {
    const chip = document.createElement('span');
    chip.className = 'tool aside';
    Icon.text(chip, `💭 ${text}`);
    return chip;
  }

  // ------------------------------------------------------------ running commentary

  const asideEl = $('#aside');
  function showAside(text: string) {
    asideEl.textContent = text;
    asideEl.hidden = false;
    asideEl.classList.remove('show', 'right', 'compact');
    void asideEl.offsetWidth;
    const robotH = ROBOT_H * (state.scale || 1);
    if (state.collapsed) {
      // chat tucked away: in the strip above (or below) the robot, clear of the desk
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = '8px';
      // next to the status bubble, which sits right against the robot
      asideEl.style.top = `${state.placement === 'tuck-below' ? state.robotY + robotH + 50 : Math.max(2, state.robotY - h - 56)}px`;
    } else if (!body.classList.contains('expanded')) {
      // a small window with no room around the robot: the remark is in the chat anyway
      asideEl.hidden = true;
      return;
    } else {
      // above the robot's head, clear of the chat beside it (or tucked into the
      // robot's corner when the robot is right at the top of the screen)
      const w = asideEl.offsetWidth;
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = `${Math.max(8, Math.min(state.robotX + 20, innerWidth - w - 8))}px`;
      asideEl.style.top = `${state.robotY - h - 30 >= 8 ? state.robotY - h - 30 : state.robotY + robotH + 12}px`; // below it at the top of the screen
    }
    asideEl.classList.add('show');
    clearTimeout(showAside.t);
    showAside.t = setTimeout(() => {
      asideEl.classList.remove('show');
      setTimeout(() => (asideEl.hidden = !asideEl.classList.contains('show')), 300);
    }, 3800 + text.length * 45);
  }
  showAside.t = 0;

  function addNote(text: string, cls = '', tab: ChatTab = active()!) {
    const el = document.createElement('div');
    el.className = `msg note ${cls}`;
    Icon.text(el, text);
    tab.log.appendChild(el);
    scrollDown(tab);
  }

  function deniedNote(denials: string[]) {
    const el = document.createElement('div');
    el.className = 'denied';
    Icon.text(el, `🔒 I wasn't allowed to use ${[...new Set(denials)].join(', ')}. Right-click me → Permissions to give me more power.`);
    return el;
  }

  // (the status line and strip are plain mono text: no leading emoji)
  function plain(text: string) {
    return String(text || '').replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '');
  }
  function setStatus(text: string) {
    statusRow.hidden = !text;
    statusText.textContent = plain(text);
    renderMeta();
  }
  // after what it's doing, as Claude Code shows it: "(12s · ↓ 1.2k tokens · esc to stop)"
  function renderMeta() {
    const t = active();
    if (!t?.busy || !t.turnStart || t.question) {
      statusMeta.textContent = '';
      return;
    }
    const s = Math.max(0, Math.round((Date.now() - t.turnStart) / 1000));
    const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const n = Math.max(t.outTokens || 0, Math.round((t.outChars || 0) / 4)); // (what it says, or an estimate as it streams)
    statusMeta.textContent = `(${time}${n ? ` · ↓ ${fmtTokens(n)} tokens` : ''} · esc to stop)`;
  }
  setInterval(() => !statusRow.hidden && renderMeta(), 1000);

  // each tab keeps its own status line; only the visible one is shown
  function setTabStatus(tab: ChatTab, text: string) {
    tab.statusText = text || '';
    if (tab === active()) setStatus(text);
    renderWorking();
  }

  // does the robot act out this tab's events? The tab you're looking at always;
  // a background tab only while the visible one is idle.
  const animates = (tab: ChatTab) => tab === active() || !active()?.busy;

  // ------------------------------------------------------------ asking

  function setBusy(tab: ChatTab, busy: boolean) {
    tab.busy = busy;
    clearInterval(tab.verbs);
    if (busy) {
      Object.assign(tab, { turnStart: Date.now(), outTokens: 0, outChars: 0 });
      tab.activity = 'think';
      if (animates(tab)) setActivity(helpersOut() ? 'helpers' : 'think'); // keep supervising helpers still out
      setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      tab.verbs = setInterval(() => {
        if (!tab.current?.toolStatus) setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      }, 2800);
    } else {
      setTabStatus(tab, '');
    }
    syncChrome();
    renderTabs();
    renderFace();
  }

  // composer, send button and antenna follow the tabs' state
  function syncChrome() {
    const t = active();
    body.classList.toggle('busy', !!t?.busy);
    $('#send').innerHTML = Icon(t?.busy ? 'stop' : 'send');
    $('#send').title = t?.busy ? 'Stop' : 'Send (Enter)';
    if (!state.busy) body.classList.remove('thinking', 'talking');
    else if (!body.classList.contains('talking')) body.classList.add('thinking');
    setStatus(t?.statusText || '');
  }

  async function submit({ again = false, tag = '' } = {}) {
    const tab = active()!;
    const text = input.value.trim();
    // an edited question: the old one (and its answer) goes first, then this is asked in its place
    if (editing && editing.tab === tab && !tab.busy && !again) {
      if (!text) return;
      if (!(await takeBack(tab))) return;
      const draft = editing?.draft ?? '';
      editing = null;
      editBanner.hidden = true;
      tab.draft = draft;
    }
    if (tab.busy) {
      // while working: app commands still run, empty Enter stops, anything else waits its turn
      if (!text && !state.attachments.length) ipc.robotCancel(tab.id);
      else if (runLocalCommand(text)) {
        input.value = '';
        autosize();
        hidePalette();
      } else if (tab.question && !tab.question.sent) {
        answerFromComposer(text);
      } else queueQuestion(tab, text, tag);
      return;
    }
    if (!text && !state.attachments.length) return;
    state.lastActivity = Date.now();
    input.value = '';
    autosize();

    hidePalette();
    if (runLocalCommand(text)) return;

    const files = state.attachments;
    state.attachments = [];
    renderAttachments();
    const question = text || (files.length === 1 ? 'Take a look at this.' : 'Take a look at these.');
    tab.vocabWord = askedWord(text); // "what does X mean?": offer to save X under the answer
    tab.log.querySelectorAll('.greet').forEach((el) => el.remove());
    clearFinishedHelpers(tab);
    addUser(question, files, tab, tag).classList.add('enter');
    sentOf(tab).push(question);
    tab.rewinding = false;
    recallAt = -1;
    if (!tab.custom && tab.title === 'New chat') {
      const t = question.replace(/\s+/g, ' ').trim();
      tab.title = t.length > 28 ? t.slice(0, 27) + '…' : t;
    }
    Sfx.key.send();
    flash('hop', 600);
    const turnId = uid();
    startReply(tab);
    tab.current.turnId = turnId;
    tab.current.ask = { question, paths: files.map((f) => f.path) };
    setBusy(tab, true);

    const res = await ipc.robotAsk(tab.id, question, files.map((f) => f.path), turnId, undefined, tag || undefined);
    if (!res.ok) onEvent({ type: 'fail', tabId: tab.id, turnId, message: res.error });
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Typed while the robot is still answering: it waits its turn (or jumps the queue with ⚡).
  async function queueQuestion(tab: ChatTab, text: string, tag = '') {
    const files = state.attachments;
    state.attachments = [];
    renderAttachments();
    input.value = '';
    autosize();
    hidePalette();
    const question = text || 'Take a look at this.';
    const turnId = uid();
    const el = addUser(question, files, tab, tag);
    sentOf(tab).push(question);
    recallAt = -1;
    el.classList.add('queued', 'enter');
    const bar = document.createElement('div');
    bar.className = 'queue-actions';
    bar.innerHTML = `<span>${Icon('inbox', 'sm lead')}next up</span><button type="button" title="Stop the current answer and do this now">${Icon('zap', 'sm lead')}Send now</button><button type="button" title="Don't send">${Icon('x', 'sm')}</button>`;
    const [now, cancel] = bar.querySelectorAll('button');
    now.addEventListener('click', () => ipc.robotSendNow(tab.id, turnId));
    cancel.addEventListener('click', async () => {
      if (await ipc.robotUnqueue(tab.id, turnId)) dropQueued(tab, turnId, 'not sent');
    });
    el.appendChild(bar);
    tab.queue.push({ turnId, el, ask: { question, paths: files.map((f) => f.path) } });
    Sfx.key.send();
    flash('hop', 600);
    express('happy', 'o', 900);
    showPop(pick(['📨 Noted! Next up.', 'Got it, right after this!', 'Queued! ✍️']), 1800);
    const res = await ipc.robotAsk(tab.id, question, files.map((f) => f.path), turnId, undefined, tag || undefined);
    if (!res.ok) {
      dropQueued(tab, turnId, 'not sent');
      addNote(`📨 ${res.error}`, '', tab);
    }
  }

  function dropQueued(tab: ChatTab, turnId: string, why: string) {
    const i = tab.queue.findIndex((q) => q.turnId === turnId);
    if (i < 0) return;
    const [q] = tab.queue.splice(i, 1);
    q.el.classList.remove('queued');
    q.el.classList.add('dropped');
    Icon.text(q.el.querySelector('.queue-actions')!, `📭 ${why}`);
  }

  // Stop: interrupt the answer (the conversation carries on); queued messages are returned
  function stopTab(tab: ChatTab | undefined) {
    if (!tab?.busy) return;
    ipc.robotCancel(tab.id);
    express('o', 'o', 900);
    showPop(pick(['Okay, stopping!', 'Halting!', 'Brakes on! 🛑']), 1500);
  }

  // an empty bot bubble that the next streamed reply fills in
  function startReply(tab: ChatTab): asserts tab is ChatTab & { current: Reply } {
    const el = document.createElement('div');
    el.className = 'msg bot enter';
    tab.log.appendChild(el);
    tab.current = { el, parts: [], text: '' };
    partFor(tab.current, 'text'); // (its blinking caret, until the first words or step)
    scrollDown(tab);
  }
  // (after a question card the answer carries on in a fresh bubble: its words from `offset` on)
  function moveReply(cur: Reply, el: HTMLElement, offset: number) {
    Object.assign(cur, { el, parts: [], offset, asked: true });
    partFor(cur, 'text');
  }

  // The answer as it streams, in the order it happened: words, then the steps it took, the
  // files they changed, more words… Each part is { kind: 'text', el, from, to } (its slice of
  // cur.text), { kind: 'steps', el } (a row of step chips) or { kind: 'made', el } (diffs,
  // tool views, pictures). partFor gives the part to add to, starting a new one when the kind
  // changes; a text part ends where the next part begins.
  const PART_CLASS = { text: 'content', steps: 'tools', made: 'edits' };
  function partFor(cur: Reply, kind: Part['kind']): Part {
    const last = cur.parts[cur.parts.length - 1];
    if (last?.kind === kind) return last;
    if (last?.kind === 'text') {
      last.to = cur.text.length;
      last.el.classList.remove('cursor');
      if (!partText(cur, last).trim()) {
        last.el.remove();
        cur.parts.pop();
        const prev = cur.parts[cur.parts.length - 1];
        if (prev?.kind === kind) return prev;
      }
    }
    const el = document.createElement('div');
    el.className = PART_CLASS[kind] + (kind === 'text' ? ' cursor' : '');
    cur.el.appendChild(el);
    const part = { kind, el, from: cur.text.length };
    cur.parts.push(part);
    return part;
  }
  const partText = (cur: Reply, p: TextPart) => cur.text.slice(Math.max(p.from, cur.offset || 0), p.to ?? cur.text.length);
  const hasSteps = (cur: Reply) => cur.parts.some((p) => p.kind !== 'text' && p.el.children.length);
  // a remark it made in passing: with the steps just before the words it's saying (not in the
  // middle of a sentence)
  function asideRow(cur: Reply) {
    const last = cur.parts[cur.parts.length - 1];
    if (last?.kind !== 'text') return partFor(cur, 'steps').el;
    const prev = cur.parts[cur.parts.length - 2];
    if (prev?.kind === 'steps') return prev.el;
    const el = document.createElement('div');
    el.className = 'tools';
    last.el.before(el);
    cur.parts.splice(cur.parts.length - 1, 0, { kind: 'steps', el });
    return el;
  }

  // the answer's words, finished: every text part redrawn. `text` stands in when nothing was
  // streamed, `note` goes after the last words ("…(stopped)"), `empty` shows when there's
  // nothing else to say
  function finishText(cur: Reply, { text = '', note = '', empty = '' }: { text?: string; note?: string; empty?: string } = {}) {
    for (const p of cur.parts) if (p.kind === 'text') p.el.innerHTML = md(partText(cur, p));
    const said = cur.parts.filter((p) => p.kind === 'text' && partText(cur, p).trim()) as TextPart[]; // (text parts only)
    const lastText = said[said.length - 1];
    if (!said.length && (text || note || empty)) {
      const p = partFor(cur, 'text');
      p.el.innerHTML = md(text ? `${text}${note ? `\n\n${note}` : ''}` : note || empty);
    } else if (note && lastText) lastText.el.innerHTML = md(`${partText(cur, lastText)}\n\n${note}`);
    for (const p of cur.parts) p.el.classList.remove('cursor');
    dedupePics(cur.el);
  }

  function renderCurrent(tab: ChatTab) {
    if (tab.renderQueued) return;
    tab.renderQueued = true;
    requestAnimationFrame(() => {
      tab.renderQueued = false;
      const cur = tab.current;
      if (!cur) return;
      const L = tab.log;
      const nearBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 60;
      // (only the words still coming: the parts before them are done)
      const last = cur.parts[cur.parts.length - 1];
      if (last?.kind === 'text') last.el.innerHTML = md(partText(cur, last));
      dedupePics(cur.el);
      if (nearBottom) scrollDown(tab);
    });
  }

  function finishCurrent(tab: ChatTab) {
    const cur = tab.current;
    tab.current = null;
    settleThinking(tab);
    // (a step still showing as running when the answer ended: it was cut short)
    for (const row of tab.log.querySelectorAll<HTMLElement>('.step.running')) row.classList.remove('running');
    // (and its runs of steps are done: as they were, folded unless you opened one)
    for (const run of tab.log.querySelectorAll<HTMLElement>('.tools.live')) {
      run.classList.remove('live');
      foldSteps(run);
    }
    if (cur) for (const p of cur.parts) p.el.classList.remove('cursor');
    setBusy(tab, false);
    // the task you sent is over: if you tucked the chat away, the status bubble says so — unless a bonk restarts it
    if (state.collapsed && !tab.bonk) {
      state.news = '✅ Done! Click to read the answer';
      renderWorking();
    }
    if (!tab.bonk) {
      tab.hurried = false;
      if (![...tabs.values()].some((t) => t.hurried)) robot.dataset.hurry = '';
    }
    return cur;
  }

  function onEvent(ev: RobotEvent) {
    if (ev.type === 'side') return sides.onEvent(ev); // (a side question's answer: chat/sides.ts)
    const tab = tabs.get(ev.tabId);
    if (!tab) return;
    const cur = tab.current;
    const show = animates(tab);
    state.lastActivity = Date.now();
    switch (ev.type) {
      case 'turn-start': {
        // a queued message's turn has come
        const qi = tab.queue.findIndex((q) => q.turnId === ev.turnId);
        let asked: Ask | null = null;
        if (qi >= 0) {
          const [q] = tab.queue.splice(qi, 1);
          q.el.classList.remove('queued');
          q.el.querySelector('.queue-actions')?.remove();
          asked = q.ask;
        }
        if (tab.bonk?.turnId === ev.turnId) {
          asked = tab.bonk.ask;
          tab.bonk = null; // the hurried rerun is under way
        }
        if (ev.kind === 'compact') {
          startCompact(tab);
          break;
        }
        if (tab.current?.turnId !== ev.turnId) {
          startReply(tab);
          tab.current.turnId = ev.turnId;
          if (asked) tab.current.ask = asked;
        }
        if (!tab.busy) setBusy(tab, true);
        Object.assign(tab, { turnStart: Date.now(), outTokens: 0, outChars: 0 }); // (the status line counts this turn)
        if (tab.hurried) setTabStatus(tab, '🔨 Hurrying…');
        break;
      }

      case 'dropped':
        for (const t of ev.turnIds) dropQueued(tab, t, 'not sent (stopped)');
        break;

      case 'tasks':
        onTasks(tab, ev);
        break;

      case 'agent':
        onAgent(tab, ev);
        break;

      case 'context':
        tab.context = ev.context;
        if (tab === active()) renderBrain();
        break;

      case 'compact':
        if (ev.phase === 'start') startCompact(tab);
        else tab.compactResult = ev;
        break;

      case 'thinking':
        tab.activity = 'think';
        if (!show) break;
        body.classList.add('thinking');
        if (state.activity !== 'talk') setActivity('think');
        break;

      case 'thinking-text': {
        const call = tab.calls?.get(ev.id);
        if (call) call.output = (call.output || '') + ev.delta;
        const box = [...tab.log.querySelectorAll<HTMLElement>('.step.think')].find((d) => d.dataset.call === ev.id)?.querySelector('.think-text');
        if (box) box.textContent += ev.delta;
        tab.outChars = (tab.outChars || 0) + ev.delta.length;
        break;
      }

      case 'usage':
        tab.outTokens = ev.outputTokens;
        if (tab === active()) renderMeta();
        break;

      case 'request-cancelled':
        if (tab.question?.requestId === ev.requestId) expireQuestion(tab);
        break;

      case 'text':
        if (!cur) return;
        settleThinking(tab);
        tab.outChars = (tab.outChars || 0) + ev.delta.length;
        // the moment words start flowing after some work: lightbulb!
        if (show && state.activity !== 'talk' && !cur.text.trim()) flash('idea', 1100);
        if (tab.activity !== 'talk') {
          cur.toolStatus = '💬 Writing it up';
          setTabStatus(tab, '💬 Writing it up…');
        }
        partFor(cur, 'text'); // (after some steps, the words carry on below them)
        cur.text += ev.delta;
        tab.activity = 'talk';
        if (show) {
          if (state.activity !== 'talk') setActivity('talk');
          body.classList.add('talking');
          body.classList.remove('thinking');
          renderFace();
          Sfx.chirp();
          clearTimeout(onEvent.quiet);
          onEvent.quiet = setTimeout(() => {
            body.classList.remove('talking');
            if (state.busy) {
              body.classList.add('thinking');
              if (state.activity === 'talk') setActivity('think');
            }
            renderFace();
          }, 700);
        }
        renderCurrent(tab);
        break;

      case 'tool': {
        if (!cur) return;
        settleThinking(tab);
        if (ev.name === 'Thinking') {
          const call = { id: ev.id, name: ev.name, detail: '', running: true };
          (tab.calls ||= new Map<string, ToolCall>()).set(ev.id, call);
          const steps = partFor(cur, 'steps').el;
          steps.appendChild(thinkRow(call));
          steps.classList.add('live');
          foldSteps(steps);
          scrollDown(tab);
          break;
        }
        const { label, activity } = toolLook(ev.name, ev.detail);
        // (the chip: a line icon for the kind of step, then what it did; click it for the details)
        const call = { id: ev.id, name: ev.name, detail: ev.detail, args: ev.args, running: true };
        if (ev.id) (tab.calls ||= new Map<string, ToolCall>()).set(ev.id, call);
        const chip = callChip(call, tab);
        if ((ev.name === 'Agent' || ev.name === 'Task') && ev.id) {
          chip.classList.add('agent-chip');
          chip.title = `${label} (click to watch it work)`;
        }
        const steps = partFor(cur, 'steps').el;
        steps.appendChild(chip); // (where it happened: after the words so far)
        steps.classList.add('live');
        foldSteps(steps);
        cur.toolStatus = label;
        tab.activity = activity;
        setTabStatus(tab, `${label}…`);
        if (show) {
          setActivity(activity);
          body.classList.add('thinking');
          body.classList.remove('talking');
          clearTimeout(onEvent.quiet);
          renderFace();
          Sfx.tool();
        }
        scrollDown(tab);
        break;
      }

      case 'tool-output': {
        // what a step gave back: on its chip (an error shows), and in its details if they're open
        const call = tab.calls?.get(ev.id);
        if (!call) break;
        Object.assign(call, { output: ev.text, media: ev.media, isError: ev.isError, running: false });
        for (const row of tab.log.querySelectorAll<HTMLElement>('.step[data-call]')) {
          if (row.dataset.call !== ev.id) continue;
          row.classList.remove('running');
          row.classList.toggle('failed', !!ev.isError);
          setStepOut(row, call);
          if (row.classList.contains('open')) renderStepDetail(row, tab);
          if (row.parentElement) foldSteps(row.parentElement);
        }
        if (helperView.call === call) renderToolView();
        break;
      }

      case 'edit':
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(diffCard(ev));
        scrollDown(tab);
        break;

      case 'app': // an MCP tool's own view (e.g. an Excalidraw drawing)
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(appCard(ev));
        scrollDown(tab);
        break;

      case 'app-result':
        appResult(ev.id, ev.result);
        break;

      case 'tool-images': // pictures an MCP tool returned (a screenshot, a rendered chart)
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(toolPics(ev.images));
        scrollDown(tab);
        break;

      case 'terminal':
        terminalState(ev.state, tab);
        break;

      case 'mirror':
        mirror(ev);
        break;

      case 'remote':
        onRemote(ev, tab);
        break;

      case 'remote-state':
        tab.remoteState = ev.state;
        renderRemote();
        break;

      // a message typed on claude.ai/code or in the Claude app: yours, from afar
      case 'remote-prompt':
        addUser(ev.text, [], tab, ev.tag);
        if (show) {
          flash('hop', 600);
          express('happy', 'o', 1200);
        }
        break;

      case 'question':
        askUser(ev, tab);
        break;

      case 'plan':
        reviewPlan(ev, tab);
        break;

      // it went into plan mode by itself, a plan was approved, or the Workshop changed its permissions
      case 'mode':
        if (!tab.busy) loadBrain(tab); // (and whether full access is on offer now)
        if (ev.mode === tab.mode) break;
        tab.mode = ev.mode;
        if (ev.mode === 'plan' && tab.busy) addNote('📋 I switched to plan mode to think this through first. Nothing changes until you approve.', '', tab);
        if (tab === active()) renderBrain();
        break;

      case 'aside':
        if (cur) asideRow(cur).appendChild(asideChip(ev.text));
        if (!show) break;
        showAside(ev.text);
        Sfx.hmm();
        express(pick(['happy', 'open', 'open']), pick(['o', 'smile']), 1400);
        break;

      case 'status':
        if (cur) cur.toolStatus = ev.text;
        setTabStatus(tab, `${ev.text}…`);
        break;

      case 'done': {
        if (ev.kind === 'compact') {
          finishCompact(tab);
          break;
        }
        // Claude's turn on a note is over: no more 🔧 on its sticky (a bonk's rerun carries on with it)
        if (tab.noteId && !(ev.interrupted && tab.bonk)) ipc.notesAct('working', { id: tab.noteId, working: false });
        const done = finishCurrent(tab);
        expireQuestion(tab);
        if (ev.interrupted) {
          if (done) {
            const said = done.text.slice(done.offset || 0).trim();
            const why = tab.bonk ? '🔨 restarting quicker' : 'stopped';
            finishText(done, { note: said ? `_…(${why})_` : '', empty: tab.bonk ? '_🔨 Restarting, quicker!_' : '_Okay, okay, I stopped._' });
          }
          if (tab.bonk) break; // the rerun follows straight away
          tab.noteId = '';
          if (tab.linkReq) linkAnswer(tab, { error: 'it was stopped before it finished' });
          if (show) setActivity(restingActivity());
          express('flat', 'o', 1200);
          renderTabs();
          break;
        }
        if (done) {
          const said = done.text.slice(done.offset || 0).trim();
          if (!said && done.asked && !hasSteps(done)) done.el.remove(); // nothing more after the answer
          else finishText(done, { text: done.asked ? '' : ev.text, empty: '_(no words, just vibes)_' });
          if (ev.isError) done.el.classList.add('error');
          if (ev.denials?.length) done.el.appendChild(deniedNote(ev.denials));
          if (done.el.isConnected) {
            rawText.set(done.el, done.asked ? done.text.slice(done.offset || 0) : done.text || ev.text);
            msgActions(done.el, 'bot', tab);
            sides.attach(done.el, ev.at, tab); // (side questions about it go under it)
          }
          if (tab.vocabWord && !ev.isError) done.el.appendChild(saveWordChip(tab.vocabWord));
          tab.vocabWord = '';
          if (tab.noteId && !ev.isError) done.el.appendChild(tickNoteChip(tab.noteId));
        }
        tab.noteId = ''; // (the chip goes on that one answer only)
        // another robot asked this: its answer goes back to it (main robotLink.js)
        if (tab.linkReq) {
          const said = done ? (done.asked ? done.text.slice(done.offset || 0) : done.text) : '';
          linkAnswer(tab, ev.isError ? { error: said || ev.text || 'it hit an error' } : { text: said || ev.text || '' });
        }
        if (!ev.isError) socialReport({ kind: 'done' });
        if (ev.isError) islandNews('error', ev.text || 'It hit an error.');
        else islandNews('done', (done ? (done.asked ? done.text.slice(done.offset || 0) : done.text) : '') || ev.text || `“${tab.title}” is done.`);
        if (tab !== active()) tab.status = ev.isError ? 'error' : 'done'; // unread
        if (!show) {
          // a background tab finished while you watch another one
          Sfx.key.done();
          express('happy', 'o', 1200);
          showPop(`“${tab.title}” is done!`, 2600);
        } else if (ev.isError) {
          Sfx.key.oops();
          setActivity('error', 3500);
          express('dizzy', 'flat', 2200);
          showPop(pick(persona().oops));
        } else if (ev.denials?.length) {
          Sfx.key.oops();
          setActivity('locked', 3500);
          express('flat', 'flat', 2200);
          showPop('They locked me out of some tools!');
        } else {
          Sfx.key.done();
          setActivity('done', 2600);
          express('happy', 'smile', 2000);
          showPop(tab === active() ? pick(persona().done) : `“${tab.title}” is done!`, 2400);
        }
        if (!state.awake) body.classList.add('has-badge');
        scrollDown(tab);
        renderTabs();
        refreshCommands();
        break;
      }

      case 'fail': {
        if (tab.queue.some((q) => q.turnId === ev.turnId)) {
          dropQueued(tab, ev.turnId, ev.cancelled ? 'not sent' : `not sent: ${ev.message}`);
          break;
        }
        if (tab.compacting) finishCompact(tab, ev.message);
        // a note it was asked about: no more 🔧 on its sticky (you can ask again)
        if (tab.noteId) {
          ipc.notesAct('working', { id: tab.noteId, working: false });
          tab.noteId = '';
        }
        if (tab.linkReq) linkAnswer(tab, { error: ev.cancelled ? 'it was stopped' : ev.message || 'it failed' });
        const done = finishCurrent(tab);
        expireQuestion(tab);
        const said = done ? done.text.slice(done.offset || 0).trim() : '';
        if (ev.cancelled) {
          if (done) finishText(done, { note: said ? '_…(stopped)_' : '', empty: '_Okay, okay, I stopped._' });
          if (show) setActivity(restingActivity());
          express('flat', 'flat', 1200);
          break;
        }
        if (show) setActivity('error', 3500);
        if (tab !== active()) tab.status = 'error';
        if (done) {
          done.el.classList.add('error');
          finishText(done, { note: `**Oops:** ${ev.message}` });
          msgActions(done.el, 'bot', tab); // (Retry: ask it again)
        } else {
          addBot(`**Oops:** ${ev.message}`, { error: true, tab });
        }
        Sfx.key.oops();
        express('dizzy', 'flat', 2500);
        showPop(tab === active() ? pick(persona().oops) : `“${tab.title}” hit a snag.`);
        islandNews('error', ev.message || 'It hit a snag.');
        if (!state.awake) body.classList.add('has-badge');
        renderTabs();
        break;
      }
    }
  }
  onEvent.quiet = 0; // (when its mouth stops after the words stop coming)

  // ------------------------------------------------------------ poking & dragging

  function poke() {
    const now = Date.now();
    state.pokes = state.pokes.filter((t) => now - t < 4000);
    state.pokes.push(now);
    ipc.robotPoke();
    if (state.pokes.length >= 5) {
      state.pokes = [];
      Sfx.key.annoyed();
      flash('shake', 500);
      express(Math.random() < 0.5 ? 'dizzy' : 'flat', 'flat', 2600);
      showPop(pick(persona().annoyed), 2800);
      return;
    }
    Sfx.key.poke();
    flash('squish', 450);
    flash('blush', 1200);
    express(pick(['happy', 'happy', 'open']), pick(['o', 'smile']), 900);
    showPop(pick(persona().pokes));
  }

  let press: { x: number; y: number; lastX: number; lastT: number; moved: boolean; travel: number; dir?: number; flips?: number[]; bonked?: boolean } | null = null;
  robot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    robot.setPointerCapture(e.pointerId);
    press = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastT: performance.now(), moved: false, travel: 0 };
    stopAntic();
    ipc.robotDrag({ phase: 'start' });
  });

  robot.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 5) return;
    if (!press.moved) {
      press.moved = true;
      body.classList.add('dragging');
      Sfx.key.whee();
      express('open', 'o', 60000);
    }
    const now = performance.now();
    const step = e.screenX - press.lastX;
    const vx = step / Math.max(1, now - press.lastT);
    press.travel += Math.abs(step);
    // 3+ direction reversals within ~600 ms = a bonk, not just a move
    if (Math.abs(step) > 3) {
      const dir = Math.sign(step);
      if (press.dir && dir !== press.dir) {
        press.flips = [...(press.flips || []).filter((t) => now - t < 600), now];
        if (press.flips.length >= 3 && !press.bonked) {
          press.bonked = true;
          bonkRobot();
        }
      }
      press.dir = dir;
    }
    press.lastX = e.screenX;
    press.lastT = now;
    document.documentElement.style.setProperty('--swing', `${clamp(-vx * 18, -28, 28).toFixed(1)}deg`);
    ipc.robotDrag({ phase: 'move', dx, dy });
  });

  let monitorClick = 0; // a pending single click on the monitor (see endPress)
  function endPress(e: PointerEvent) {
    if (!press) return;
    const p = press;
    press = null;
    try { robot.releasePointerCapture(e.pointerId); } catch {}
    ipc.robotDrag({ phase: 'end' });
    body.classList.remove('dragging');
    document.documentElement.style.setProperty('--swing', '0deg');
    state.lastActivity = Date.now();
    if (!p.moved) {
      if (e.ctrlKey && !state.away) {
        // Ctrl+click: picked for the stage (or not any more)
        flash('hop', 450);
        ipc.stagePick();
        return;
      }
      const prop = office.propAt?.(e.clientX, e.clientY);
      if (prop?.kind === 'note' || prop?.kind === 'board') return openNotesFromBoard(prop);
      if (state.away) return awayClick();
      if (prop?.kind === 'hammer') return playWith('bonk');
      if (prop?.kind === 'plug') return playWith('charge');
      const note = office.stickyAt?.(e.clientX, e.clientY);
      if (note?.kind === 'vocab') {
        flash('hop', 500);
        ipc.robotVocabOpen(note.id);
        return;
      }
      if (state.awake && !state.mirroring && !state.collapsed && office.hitsMonitor(e.clientX, e.clientY)) {
        if (monitorClick) {
          clearTimeout(monitorClick);
          monitorClick = 0;
          crashMonitor();
        } else monitorClick = setTimeout(() => ((monitorClick = 0), poke()), 260);
        return;
      }
      if (state.mirroring) openTerminal();
      else if (state.collapsed) openChat();
      else if (state.awake) poke();
      else if (state.character!.clickOpens === 'terminal') openTerminal();
      else bonkAwake();
      return;
    }
    state.face = null;
    if (p.travel > 1800) {
      express('dizzy', 'flat', 2200);
      showPop('Whoa… the room is spinning…');
    } else {
      renderFace();
    }
  }
  robot.addEventListener('pointerup', endPress);
  robot.addEventListener('pointercancel', endPress);

  robot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ipc.robotMenu({ awake: state.awake, away: !!state.away });
  });

  // ------------------------------------------------------------ composer

  function autosize() {
    // (its box is border-box: one line is exactly the buttons' 32 px, so they sit level with it)
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  // ↑ / ↓ in the composer: what you asked before in this tab, as in a terminal (and Claude Code).
  // Only from the first line going up (or the last going down), so a long message still moves.
  let recallAt = -1; // which one is shown (-1: none, your own draft)
  let recallDraft = '';
  const sentOf = (t: ChatTab) => (t.sent ??= (t.data?.history || []).filter((h) => h.role === 'user').map((h) => h.text));
  function recall(dir: -1 | 1) {
    const t = active();
    if (!t || input.selectionStart !== input.selectionEnd) return false;
    const list = sentOf(t);
    const caret = input.selectionStart;
    if (dir < 0 && (!list.length || input.value.slice(0, caret).includes('\n'))) return false;
    if (dir > 0 && (recallAt < 0 || input.value.slice(caret).includes('\n'))) return false;
    if (recallAt < 0) {
      recallDraft = input.value;
      recallAt = list.length;
    }
    const next = recallAt + dir;
    if (next < 0) return true; // (the oldest: stay)
    recallAt = next >= list.length ? -1 : next;
    input.value = recallAt < 0 ? recallDraft : list[recallAt];
    autosize();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  // Edit your last question (✏️ on it): the conversation goes back to before it, and what you
  // send instead takes its place (Claude Code's rewind). Retry (on the last answer) is the same
  // question again.
  let editing: { tab: ChatTab; draft: string } | null = null;
  const editBanner = $('#edit-banner');
  function startEdit(tab: ChatTab, text: string) {
    if (tab.busy || tab.queue.length) return showPop('Wait till I’m done (or stop me) first.', 1800);
    if (!editing) editing = { tab, draft: input.value };
    editing.tab = tab;
    input.value = text;
    autosize();
    editBanner.hidden = false;
    editBanner.querySelector('span')!.textContent = '✏️ Editing your last question: Enter sends it in its place, Esc cancels';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function cancelEdit() {
    if (!editing) return false;
    input.value = editing.draft;
    editing = null;
    editBanner.hidden = true;
    autosize();
    return true;
  }
  $('#edit-cancel').addEventListener('click', () => cancelEdit());
  // take the last question (and its answer) back; then it's asked again, as it is or edited
  async function takeBack(tab: ChatTab) {
    tab.rewinding = true;
    // (off the page first: main's redraw of the shortened history, whenever it comes, shows the same)
    const asked = tab.log.querySelectorAll('.msg.user');
    const last = asked[asked.length - 1];
    if (last) {
      while (last.nextSibling) last.nextSibling.remove();
      last.remove();
    }
    const res = await ipc.robotRewind(tab.id);
    if (!res.ok) {
      tab.rewinding = false;
      renderHistory(tab); // (as it was)
      showPop(res.error, 2600);
      return false;
    }
    const sent = sentOf(tab);
    if (sent.length) sent.pop();
    return true;
  }
  async function retry(tab: ChatTab) {
    if (tab.busy || tab.queue.length) return;
    const question = sentOf(tab)[sentOf(tab).length - 1];
    if (!question || !(await takeBack(tab))) return;
    // (asked again as it was: the draft and files waiting in the composer stay for later)
    const [draft, files] = [input.value, state.attachments];
    state.attachments = [];
    input.value = question;
    void submit({ again: true });
    input.value = draft;
    state.attachments = files;
    renderAttachments();
    autosize();
  }

  // the hover buttons on a message: ✏️ on your last question; Copy and Retry on an answer
  const rawText = new WeakMap<HTMLElement, string>(); // an answer's words, as written (markdown)
  function msgActions(el: HTMLElement, kind: 'user' | 'bot', tab: ChatTab) {
    el.querySelector(':scope > .msg-actions')?.remove();
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const button = (icon: string, title: string, act: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.innerHTML = Icon(icon, 'sm');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        act();
      });
      bar.appendChild(b);
    };
    if (kind === 'user') {
      button('edit', 'Edit this question (the conversation goes back to before it)', () => {
        const users = tab.log.querySelectorAll('.msg.user:not(.queued):not(.dropped)');
        if (users[users.length - 1] !== el) return showPop('Only the last question can be edited.', 1800);
        startEdit(tab, sentOf(tab)[sentOf(tab).length - 1] ?? el.textContent ?? '');
      });
    } else {
      button('copy', 'Copy this answer', () => {
        navigator.clipboard.writeText(rawText.get(el) ?? el.innerText).then(() => showPop('Copied! 📋', 1200), () => {});
      });
      button('refresh', 'Ask again (this answer is replaced)', () => {
        const answers = tab.log.querySelectorAll('.msg.bot:not(.greet)');
        if (answers[answers.length - 1] !== el) return showPop('Only the last answer can be asked again.', 1800);
        retry(tab);
      });
      button('chat-ask', 'Side question', () => sides.start(el));
    }
    el.appendChild(bar);
  }

  // The composer's tools. ＋: files or pictures (the open dialog), what's on the clipboard, or a
  // box round part of the screen; they go along as chips, as a dropped file does.
  $('#btn-attach').addEventListener('click', () =>
    openMenu(
      $('#btn-attach'),
      'Add to your message',
      [
        { icon: 'file', label: 'Files…', desc: 'anything on this computer', value: 'files' },
        { icon: 'image', label: 'Pictures…', desc: 'screenshots, photos, diagrams', value: 'pictures' },
        { icon: 'copy', label: 'From the clipboard', desc: 'a copied picture or files', value: 'clipboard' },
        { icon: 'scan', label: 'Part of the screen…', desc: 'drag a box round it', value: 'screen' },
      ],
      async (v) => {
        if (v === 'screen') return void ipc.robotScreenAsk();
        if (v === 'clipboard') return void pasteClipboard();
        const picked = await ipc.robotPickFiles(v === 'pictures');
        if (picked.length) eat(picked);
        else input.focus();
      },
    ),
  );

  // Aa: the formatting bar (markdown round what's selected, and changes to the text itself);
  // whether it shows is remembered. Ctrl+B / I / E / K and Ctrl+Shift+E work either way.
  const fmtBar = $('#fmt-bar');
  const fmtBtn = $('#btn-format');
  function showFmt(on: boolean) {
    fmtBar.hidden = !on;
    fmtBtn.classList.toggle('on', on);
    try {
      localStorage.setItem('cbot.fmtBar', on ? '1' : '');
    } catch {}
  }
  try {
    showFmt(localStorage.getItem('cbot.fmtBar') === '1');
  } catch {
    showFmt(false);
  }
  fmtBtn.addEventListener('click', () => {
    showFmt(fmtBar.hidden !== false);
    input.focus();
  });
  function format(kind: string) {
    switch (kind) {
      case 'bold':
        return wrap(input, '**');
      case 'italic':
        return wrap(input, '_');
      case 'strike':
        return wrap(input, '~~');
      case 'code':
        return wrap(input, '`', '`', 'code');
      case 'block':
        return codeBlock(input);
      case 'bullet':
      case 'number':
      case 'quote':
        return prefixLines(input, kind);
      case 'link':
        return link(input);
      case 'transform':
        return openMenu(fmtBar.querySelector<HTMLElement>('[data-fmt="transform"]')!, 'Change the text (what’s selected, or all of it)', TRANSFORMS.map((t) => ({ label: t.label, desc: t.desc, value: t.id })), (id) => {
          if (!transform(input, id)) showPop('Nothing to change there.', 1400);
        });
    }
  }
  fmtBar.addEventListener('mousedown', (e) => e.preventDefault()); // (the selection stays in the box)
  fmtBar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-fmt]');
    if (b) format(b.dataset.fmt!);
  });

  input.addEventListener('input', () => {
    recallAt = -1; // (typing: ↑ starts from the newest again)
    autosize();
    updatePalette();
    state.lastActivity = Date.now();
    // watch the user type
    lookAt(state.placement === 'right' ? 200 : -200, 0, 1200); // at the chat beside it
    body.classList.add('typing');
    clearTimeout(input.t);
    input.t = setTimeout(() => body.classList.remove('typing'), 1200);
  });
  input.addEventListener('click', () => updatePalette());
  input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updatePalette();
  });
  input.addEventListener('keydown', (e) => {
    if (!paletteEl.hidden && paletteKey(e)) return;
    // number keys pick an option while a question is waiting and the box is empty
    const q = active()?.question;
    if (q && !q.sent && !input.value && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      q.pickByNumber(Number(e.key));
      return;
    }
    // Shift+Tab: the next permission mode (plan mode among them), as in Claude Code
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    // formatting keys, as in an editor
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const kind = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' ? 'link' : k === 'e' ? (e.shiftKey ? 'block' : 'code') : '';
      if (kind) {
        e.preventDefault();
        format(kind);
        return;
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing && recall(e.key === 'ArrowUp' ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  // Esc peels back one layer: command list, then history, then off to sleep
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.awake) return;
    if (!menuEl.hidden) closeMenu();
    else if (!paletteEl.hidden) hidePalette();
    else if (cancelEdit()) return;
    else if (history.isOpen()) history.escape();
    else if (helperView.id || helperView.call || helperView.file) backFromView();
    else if (active()?.busy) stopTab(active()); // like Claude Code: Esc interrupts
    else sleep();
  });
  $('#btn-history').addEventListener('click', () => (history.isOpen() ? history.close() : openHistory()));
  $('#btn-terminal').addEventListener('click', () => openTerminal());
  $('#btn-remote').addEventListener('click', () => toggleRemote());
  $('#btn-shell').addEventListener('click', () => toggleShell());
  // the ■ button always means stop, even with a draft in the box
  $('#send').addEventListener('click', (e) => {
    if (!active()?.busy) return;
    e.preventDefault();
    stopTab(active());
  });
  // off to the robot island (with the island turned off: just to sleep; Esc still sleeps)
  $('#btn-island').addEventListener('click', () => (islandOn ? peek() : sleep()));
  $('#btn-collapse').addEventListener('click', () => collapse());
  $('#btn-reset').addEventListener('click', () => ipc.robotReset(activeId!));
  $('#folder').addEventListener('click', () => ipc.robotOpenFolder());

  // ------------------------------------------------------------ terminal mode

  // Full Claude Code in a terminal window. The bubble steps aside and the robot
  // acts out what happens there (from Claude Code's transcript).
  async function openTerminal() {
    const res = await ipc.robotTerminal(activeId!);
    if (!res.ok) {
      if (state.awake) addNote(`⌨️ ${res.error}`);
      express('flat', 'flat', 1500);
      return;
    }
    if (res.already) {
      flash('hop', 600);
      express('happy', 'o', 1200);
      if (state.awake) showPop('Already open! Check your taskbar.', 2200);
    }
  }

  // ------------------------------------------------------------ remote control

  // Like Claude Code's /remote-control: the tab's conversation carries on from claude.ai/code
  // or the Claude app too. What's typed there shows up here, and the robot acts out the answer.
  async function toggleRemote(tab = active()!, on = !tab.data?.remote) {
    tab.remoteAsked = on;
    const res = await ipc.robotRemote(tab.id, on);
    if (!res.ok) {
      tab.remoteAsked = false;
      addNote(`📱 ${res.error}`, '', tab);
      express('flat', 'flat', 1500);
      return;
    }
    if (on) {
      tab.remoteState = 'connecting';
      renderRemote();
      flash('hop', 600);
    }
  }

  function renderRemote() {
    const tab = active();
    const btn = $('#btn-remote');
    const on = !!tab?.data?.remote;
    btn.classList.toggle('on', on);
    btn.dataset.state = on ? tab!.remoteState || '' : '';
  }

  // (its page on claude.ai, and where to find it in the app)
  function remoteNote(tab: ChatTab, url?: string | null) {
    const el = document.createElement('div');
    el.className = 'msg note';
    Icon.text(el, `📱 Remote Control is on! Carry on from the Claude app (Code → “${state.character?.name || 'me'} · C-Bot”)${url ? ' or at ' : '.'}`);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = 'claude.ai/code';
      el.append(a, '.');
    }
    tab.log.appendChild(el);
    scrollDown(tab);
  }

  function onRemote(ev: Extract<ChatEvent, { type: 'remote' }>, tab: ChatTab) {
    const asked = tab.remoteAsked; // (true: turned on from here, false: off from here, unset: by itself)
    tab.remoteAsked = undefined;
    tab.data.remote = ev.on;
    tab.data.remoteUrl = ev.url ?? null;
    if (!ev.on) tab.remoteState = '';
    else if (!tab.remoteState) tab.remoteState = 'ready';
    if (ev.error) {
      addNote(`📱 Remote Control couldn't come on: ${ev.error}`, '', tab);
      express('flat', 'flat', 1500);
    } else if (ev.on && asked) {
      remoteNote(tab, ev.url);
      express('happy', 'smile', 1500);
      Sfx.send();
    } else if (!ev.on && asked === false && tab.id === activeId) {
      addNote('📱 Remote Control is off.', '', tab);
    }
    renderTabs();
  }

  function terminalState(s: 'opened' | 'closed', tab: ChatTab, { quiet = false } = {}) {
    if (s === 'opened') {
      unpeek();
      state.mirroring = true;
      tab.terminal = true;
      renderTabs();
      if (!quiet) addNote('⌨️ Continued in the terminal. I’ll act out what happens there.', '', tab);
      Sfx.send();
      // step out of the chat: no bubble, but awake at the desk
      if (body.classList.contains('expanded')) ipc.robotExpand(false);
      state.collapsed = false;
      body.classList.remove('collapsed');
      renderWorking();
      state.awake = true;
      body.classList.remove('asleep');
      body.classList.add('awake');
      flash('spin', 950);
      setActivity('boot', 900);
    } else {
      state.mirroring = false;
      tab.terminal = false;
      renderTabs();
      body.classList.remove('thinking', 'talking');
      renderHistory(tab);
      addNote('⌨️ Back from the terminal. Everything said there is above.', '', tab);
      Sfx.sleep();
      state.awake = false;
      body.classList.remove('awake', 'expanded');
      body.classList.add('asleep');
      setActivity('off');
    }
    renderFace();
  }

  let mirrorTalk: number | undefined;
  function mirror(ev: Extract<ChatEvent, { type: 'mirror' }>) {
    if (!state.mirroring) return;
    clearTimeout(mirrorTalk);
    body.classList.remove('talking');
    if (ev.kind === 'prompt') {
      body.classList.add('thinking');
      setActivity('think');
      Sfx.send();
    } else if (ev.kind === 'tool') {
      const [, , activity] = TOOLS[ev.name] || ['', '', 'run'];
      body.classList.add('thinking');
      setActivity(activity);
      Sfx.tool();
    } else if (ev.kind === 'question') {
      body.classList.remove('thinking');
      setActivity('ask');
      Sfx.ask();
    } else if (ev.kind === 'text') {
      body.classList.remove('thinking');
      body.classList.add('talking');
      setActivity('talk');
      mirrorTalk = setTimeout(() => {
        body.classList.remove('talking');
        renderFace();
      }, 1800);
    } else if (ev.kind === 'idle') {
      body.classList.remove('thinking');
      setActivity('done', 2600);
      express('happy', 'smile', 2000);
      Sfx.key.done();
    }
    renderFace();
  }

  // ------------------------------------------------------------ questions from Claude

  // Claude Code stopped to ask something (AskUserQuestion). Show the questions
  // as a card with clickable options; the run waits until the answer goes back.
  function askUser({ requestId, questions }: { requestId: string; questions: Question[] }, tab: ChatTab) {
    const cur = tab.current;
    // close the bubble that was streaming, so the answer continues below the card
    if (cur) {
      if (!cur.text.slice(cur.offset || 0).trim() && !hasSteps(cur)) cur.el.remove();
      else finishText(cur);
    }

    const card = document.createElement('div');
    card.className = 'msg q-card';
    card.innerHTML = '<div class="q-title"></div>';
    card.querySelector('.q-title')!.textContent = `${state.character!.name} has ${questions.length > 1 ? `${questions.length} questions` : 'a question'}`;
    const picks = questions.map(() => ({ labels: new Set<string>(), other: '' }));
    const single = questions.length === 1 && !questions[0].multiSelect;
    const blocks: { q: Question; buttons: { b: HTMLButtonElement; label: string }[]; other: HTMLInputElement }[] = [];

    questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'q-block';
      if (q.header) {
        const h = document.createElement('div');
        h.className = 'q-header';
        h.textContent = q.header;
        block.appendChild(h);
      }
      const text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = q.question;
      if (q.multiSelect) {
        const m = document.createElement('span');
        m.className = 'q-multi';
        m.textContent = ' (pick any)';
        text.appendChild(m);
      }
      block.appendChild(text);
      const opts = document.createElement('div');
      opts.className = 'q-opts';
      const buttons = (q.options || []).map((o, oi) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-opt';
        b.innerHTML = '<span class="q-key"></span><b></b><small></small>';
        b.querySelector('.q-key')!.textContent = String(oi + 1);
        b.querySelector('b')!.textContent = o.label;
        b.querySelector('small')!.textContent = o.description && o.description !== o.label ? o.description : '';
        b.addEventListener('click', () => choose(qi, o.label));
        opts.appendChild(b);
        return { b, label: o.label };
      });
      block.appendChild(opts);
      const other = document.createElement('input');
      other.className = 'q-other';
      other.placeholder = 'Something else… (type and press Enter)';
      other.addEventListener('input', () => {
        picks[qi].other = other.value.trim();
        if (!q.multiSelect && picks[qi].other) picks[qi].labels.clear();
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && other.value.trim()) {
          e.preventDefault();
          if (ready()) send();
        }
      });
      block.appendChild(other);
      card.appendChild(block);
      blocks.push({ q, buttons, other });
    });

    const actions = document.createElement('div');
    actions.className = 'q-actions';
    actions.innerHTML = '<button type="button" class="q-send">Send answer</button><span class="q-hint"></span>';
    const sendBtn = actions.querySelector<HTMLButtonElement>('.q-send')!;
    actions.querySelector('.q-hint')!.textContent = single ? 'Click an option, press its number, or type below' : 'or type your answer below';
    sendBtn.addEventListener('click', () => ready() && send());
    card.appendChild(actions);
    if (single) sendBtn.hidden = true;

    function choose(qi: number, label: string) {
      if (pending.sent) return;
      const p = picks[qi];
      if (blocks[qi].q.multiSelect) {
        p.labels.has(label) ? p.labels.delete(label) : p.labels.add(label);
      } else {
        p.labels = new Set([label]);
        p.other = '';
        blocks[qi].other.value = '';
      }
      Sfx.tool();
      refresh();
      if (single) send();
    }

    const answerOf = (qi: number) => [...picks[qi].labels, ...(picks[qi].other ? [picks[qi].other] : [])].join(', ');
    const ready = () => picks.every((_, qi) => answerOf(qi));

    function refresh() {
      blocks.forEach(({ buttons }, qi) => buttons.forEach(({ b, label }) => b.classList.toggle('on', picks[qi].labels.has(label))));
      sendBtn.disabled = !ready();
    }

    async function send() {
      if (pending.sent) return;
      pending.sent = true;
      const answers: Record<string, string> = {};
      const items = questions.map((q, qi) => {
        answers[q.question] = answerOf(qi);
        return { question: q.question, header: q.header, answer: answerOf(qi) };
      });
      card.classList.add('answered');
      card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((el) => (el.disabled = true));
      Icon.text(card.querySelector('.q-title')!, `✋ You answered ${state.character!.name}`);
      const ok = await ipc.robotAnswer(tab.id, requestId, answers, items);
      if (!ok) {
        card.classList.add('expired');
        Icon.text(card.querySelector('.q-title')!, '✋ Too late, that question has closed');
        return;
      }
      handDown(tab, pick(['Got it!', 'Thanks!', 'Noted!', 'Roger that!']));
    }

    const pending: PendingQuestion = {
      sent: false,
      card,
      requestId,
      // composer text answers the first open question; once all are answered it
      // is added to the last one (replacing a single choice, joining a multi-pick)
      typed(text) {
        const open = picks.findIndex((_, i) => !answerOf(i));
        const target = open >= 0 ? open : picks.length - 1;
        blocks[target].other.value = text;
        picks[target].other = text;
        if (!blocks[target].q.multiSelect) picks[target].labels.clear();
        refresh();
        if (ready()) send();
      },
      pickByNumber(n) {
        const qi = Math.max(0, picks.findIndex((_, i) => !answerOf(i)));
        const opt = blocks[qi].buttons[n - 1];
        if (opt) choose(qi, opt.label);
      },
    };
    tab.question = pending;
    tab.log.appendChild(card);
    refresh();
    scrollDown(tab);
    handUp(tab, card, {
      status: 'Waiting for your answer',
      news: questions[0]?.question || 'It has a question for you.',
      away: `“${tab.title}” has a question for you!`,
      here: pick(['Quick question!', 'Psst, I need you!', 'Your call!']),
    });
  }

  // The robot turns round and puts its hand up: a card in the chat waits for you.
  function handUp(tab: ChatTab, card: HTMLElement, say: { status: string; news: string; away: string; here: string }) {
    tab.activity = 'ask';
    setTabStatus(tab, `${say.status}…`);
    if (tab.current) tab.current.toolStatus = say.status;
    renderTabs();
    Sfx.ask();
    express('open', 'o', 1500);
    renderWorking(); // it needs you: if the chat is tucked away, the status bubble says so
    islandNews('ask', say.news);
    if (animates(tab)) {
      state.pose = null; // drop any wave or stretch in progress
      setActivity('ask');
    }
    if (!state.awake) {
      $('#badge').textContent = '?';
      body.classList.add('has-badge');
    } else if (tab !== active()) {
      showPop(say.away, 2600);
    } else {
      showPop(say.here, 1800);
      card.querySelector<HTMLElement>('.q-opt, .q-other')?.focus();
    }
  }

  // You answered its card: hand down, back to work, the rest of the answer below the card.
  function handDown(tab: ChatTab, pop: string) {
    tab.question = null;
    if (!pendingQuestion()) {
      body.classList.remove('has-badge');
      $('#badge').textContent = '!';
    }
    Sfx.key.send();
    express('happy', 'smile', 1400);
    showPop(pop, 1500);
    tab.activity = 'think';
    if (animates(tab)) setActivity('think');
    setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
    renderTabs();
    // the rest of the answer streams into a fresh bubble below the card
    if (tab.current) {
      const el = document.createElement('div');
      el.className = 'msg bot';
      tab.log.appendChild(el);
      moveReply(tab.current, el, tab.current.text.length);
    }
    scrollDown(tab);
    input.focus();
  }

  // ------------------------------------------------------------ plans from Claude

  // In plan mode Claude looks around, changes nothing, and comes back with a plan
  // (ExitPlanMode). The plan shows as a card: go ahead (it carries on building, in the
  // mode you pick), or keep planning, with notes on what to change.
  function reviewPlan({ requestId, plan, file }: { requestId: string; plan: string; file: string }, tab: ChatTab) {
    const cur = tab.current;
    if (cur) {
      if (!cur.text.slice(cur.offset || 0).trim() && !hasSteps(cur)) cur.el.remove();
      else finishText(cur);
    }
    const card = document.createElement('div');
    card.className = 'msg q-card plan-card';
    card.innerHTML = `<div class="q-title">${Icon('plan', 'sm lead')}<span></span></div><div class="plan-body"></div>`;
    card.querySelector('.q-title span')!.textContent = `${state.character!.name}'s plan`;
    card.querySelector('.plan-body')!.innerHTML = md(plan || '_(an empty plan)_');
    if (file) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'plan-file';
      open.dataset.open = file; // (opens in the chat's file view)
      open.innerHTML = `${Icon('file', 'sm')}<span></span>`;
      open.querySelector('span')!.textContent = file.split(/[\\/]/).pop()!;
      card.appendChild(open);
    }
    const ask = document.createElement('div');
    ask.className = 'q-text';
    ask.textContent = 'Go ahead with this plan?';
    card.appendChild(ask);

    // going ahead: with edits accepted, or (where the robot is trusted with it) full access
    const choices: { mode: PermissionMode | null; label: string; desc: string }[] = [
      { mode: 'acceptEdits', label: 'Yes, and auto-accept edits', desc: 'I build it, editing files in my folder without asking' },
      ...(tab.canBypass ? [{ mode: 'bypassPermissions' as PermissionMode, label: 'Yes, with full access', desc: 'I build it, running anything I need' }] : []),
      { mode: null, label: 'No, keep planning', desc: 'Tell me what to change' },
    ];
    const opts = document.createElement('div');
    opts.className = 'q-opts';
    const buttons = choices.map((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'q-opt';
      b.innerHTML = '<span class="q-key"></span><b></b><small></small>';
      b.querySelector('.q-key')!.textContent = String(i + 1);
      b.querySelector('b')!.textContent = c.label;
      b.querySelector('small')!.textContent = c.desc;
      b.addEventListener('click', () => (c.mode ? decide(c.mode) : keepPlanning()));
      opts.appendChild(b);
      return b;
    });
    card.appendChild(opts);
    const notes = document.createElement('textarea');
    notes.className = 'q-other plan-notes-input';
    notes.rows = 2;
    notes.placeholder = 'What should change? (Enter sends it back, Shift+Enter for a new line)';
    notes.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        decide(null, notes.value);
      }
    });
    card.appendChild(notes);

    // "No": the notes box first; a second "No" (or Enter there) sends it back
    function keepPlanning() {
      if (notes.value.trim() || card.classList.contains('noting')) return decide(null, notes.value);
      card.classList.add('noting');
      buttons[buttons.length - 1].classList.add('on');
      notes.focus();
    }

    async function decide(mode: PermissionMode | null, feedback = '') {
      if (pending.sent) return;
      pending.sent = true;
      feedback = feedback.trim();
      buttons[mode ? choices.findIndex((c) => c.mode === mode) : buttons.length - 1].classList.add('on');
      card.classList.add('answered');
      card.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button:not(.plan-file), textarea').forEach((el) => (el.disabled = true));
      const res = await ipc.robotPlan(tab.id, requestId, plan, mode, feedback);
      const title = card.querySelector('.q-title span')!;
      if (!res.ok) {
        card.classList.add('expired');
        title.textContent = res.error ? `Couldn't go ahead: ${res.error}` : 'Too late, that plan has closed';
        return;
      }
      if (mode) {
        tab.mode = mode;
        if (tab === active()) renderBrain();
        title.textContent = `Plan approved, ${GO_LABEL[mode]}`;
        flash('hop', 600);
      } else {
        title.textContent = 'Plan sent back for changes';
        if (feedback) card.appendChild(planNotes(feedback));
      }
      handDown(tab, mode ? pick(['Building it!', 'On it!', 'Here we go!', 'Hammer time!']) : pick(['Back to the drawing board!', 'Let me rethink…', 'Noted!']));
    }

    const pending: PendingQuestion = {
      sent: false,
      card,
      requestId,
      closed: 'This plan closed before you decided',
      // typing in the composer: notes on what to change, and it goes back for another go
      typed(text) {
        decide(null, text);
      },
      pickByNumber(n) {
        buttons[n - 1]?.click();
      },
    };
    tab.question = pending;
    tab.log.appendChild(card);
    scrollDown(tab);
    handUp(tab, card, {
      status: 'Waiting for your go-ahead',
      news: 'It has a plan for you to look over.',
      away: `“${tab.title}” has a plan for you!`,
      here: pick(['Here’s my plan!', 'Plan ready!', 'Have a look!']),
    });
  }

  const pendingQuestion = () => [...tabs.values()].find((t) => t.question && !t.question.sent);

  function answerFromComposer(text: string) {
    input.value = '';
    autosize();
    hidePalette();
    active()!.question!.typed(text); // (only while its question waits)
  }

  // the run ended (or was stopped) before the question was answered
  function expireQuestion(tab: ChatTab) {
    const q = tab.question;
    tab.question = null;
    if (!pendingQuestion()) $('#badge').textContent = '!';
    if (!q || q.sent) return;
    q.card.classList.add('expired');
    q.card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((el) => (el.disabled = true));
    if (q.closed) q.card.querySelector('.q-title span')!.textContent = q.closed;
    else Icon.text(q.card.querySelector('.q-title')!, '✋ This question closed without an answer');
  }

  function addQaSummary(items: QAItem[] = [], tab: ChatTab = active()!) {
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'msg qa-summary';
      el.innerHTML = `${Icon('hand', 'sm lead')}<span></span> → <b></b>`;
      el.querySelector('span')!.textContent = it.question;
      el.querySelector('b')!.textContent = it.answer;
      tab.log.appendChild(el);
    }
    scrollDown(tab);
  }

  // ------------------------------------------------------------ feeding files

  // Drop (or paste) files on the robot: it reaches out, chomps them, and they
  // ride along with the next question.
  state.attachments = [];
  const attachRow = $('#attachments');
  // (and the one-click questions about a box of the screen: see “ask about the screen”)
  const screenAsks = $('#screen-asks');
  const PLACEHOLDER = input.placeholder;
  let screenShot: { path: string; source: string } | null = null; // { path, source } of the box the chips ask about
  let dragDepth = 0;
  let craving: number | undefined;

  // "325123341_704507901174002_2466761744648938636_n.jpg" -> "325123341_7045…_n.jpg": keeps
  // the start and the extension so the robot's speech bubble stays small
  function shortName(name: string, max = 22) {
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot - 2) : name.slice(-6);
    return `${name.slice(0, max - ext.length - 1)}…${ext}`;
  }

  function renderAttachments() {
    attachRow.innerHTML = '';
    attachRow.hidden = !state.attachments.length;
    for (const f of state.attachments) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.title = f.path;
      chip.innerHTML = `<span></span><button type="button" title="Spit it out">${Icon('x', 'sm')}</button>`;
      chip.querySelector('span')!.textContent = f.name;
      chip.querySelector('span')!.dataset.open = f.path; // (the name: a look at it; the ✕ spits it out)
      if (!f.thumb) chip.querySelector('span')!.insertAdjacentHTML('beforebegin', Icon(fileIcon(f), 'sm'));
      if (f.thumb) chip.prepend(thumbImg(f.thumb));
      chip.querySelector('button')!.addEventListener('click', () => {
        state.attachments = state.attachments.filter((a) => a !== f);
        renderAttachments();
        showPop('Ptooey!', 1200);
        input.focus();
      });
      attachRow.appendChild(chip);
    }
    renderScreenAsks();
  }

  function startCraving() {
    if (body.classList.contains('feeding')) return;
    body.classList.add('feeding');
    Sfx.key.ooh();
    showPop(pick(persona().hungry || ['Ooh, snacks?']), 1800);
    const lean = () => {
      strikePose('eager', 450);
      express('happy', 'wide', 450);
    };
    lean();
    craving = setInterval(lean, 300);
  }

  function stopCraving() {
    body.classList.remove('feeding');
    clearInterval(craving);
    state.pose = null;
    state.face = null;
    renderPose();
    renderFace();
  }

  // dropped File objects -> [{ path, name, isDir, isImage }]
  async function toEntries(files: File[]) {
    const paths: string[] = [];
    const pasted: Promise<FileInfo | null>[] = [];
    for (const f of files) {
      const p = ipc.pathForFile(f);
      if (p) paths.push(p);
      else if (f.type.startsWith('image/')) {
        pasted.push(ipc.robotSavePaste(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1]));
      }
    }
    const found = paths.length ? await ipc.robotInspectPaths(paths) : [];
    return [...found, ...((await Promise.all(pasted)).filter(Boolean) as FileInfo[])];
  }

  function eat(entries: FileInfo[]) {
    stopCraving();
    if (!entries.length) {
      showPop("Hmm, I can't taste that one.");
      express('flat', 'flat', 1200);
      return;
    }
    if (!state.awake) wake({ sayHi: false });
    else openChat(); // show the chips even mid-task
    for (const e of entries) if (!state.attachments.some((a) => a.path === e.path)) state.attachments.push(e);
    state.attachments = state.attachments.slice(-20);
    renderAttachments();
    flash('chomp', 1300);
    express('happy', 'chomp', 1300);
    Sfx.key.chomp();
    const name = entries.length === 1 ? shortName(entries[0].name) : `${entries.length} things`;
    setTimeout(() => showPop(fill(pick(persona().yum || ['Yum! {file}!'])).replaceAll('{file}', name), 2400), 700);
    setTimeout(() => express('happy', 'smile', 1200), 1300);
    state.lastActivity = Date.now();
    input.focus();
  }

  const carriesFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    startCraving();
  });
  document.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      stopCraving();
      express('flat', 'o', 900); // aww, it went away
    }
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    eat(await toEntries([...(e.dataTransfer?.files || [])]));
  });
  // Ctrl+V anywhere in the window: screenshots and files are eaten, text goes in the chat box
  document.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    const hasFiles = files.length > 0 || [...(e.clipboardData?.types || [])].includes('Files');
    if (!hasFiles) {
      const text = e.clipboardData?.getData('text');
      if (e.target !== input && text && !(e.target as Element).closest?.('input, textarea, [contenteditable]')) {
        e.preventDefault();
        input.focus();
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
      }
      return; // plain text in the chat box pastes as usual
    }
    e.preventDefault();
    startCraving();
    // Files copied in Explorer come without their paths (the webview doesn't tell them):
    // main reads them off the
    // clipboard instead, real paths and all (a picture there is saved, as it would be here).
    if (!files.some((f) => ipc.pathForFile(f))) {
      const fromMain = (await ipc.robotPasteClipboard()) || [];
      if (fromMain.length) return eat(fromMain);
    }
    eat(await toEntries(files));
  });
  // from the robot's right-click menu: works even while it's asleep
  async function pasteClipboard() {
    startCraving();
    eat((await ipc.robotPasteClipboard()) || []);
  }

  // ------------------------------------------------------------ the bonk

  // 🔨 A squeaky-hammer bonk. Asleep: it jolts awake. Working: it drops what it's doing and starts the
  // same question over, told to hurry. Idle: it just yelps.
  const HURRY = '\n\n⚡ Hurry up! Be quick: keep it short, skip the extras, and go straight to the result.';
  const BONK_COOLDOWN_MS = 3000;

  // The bonk itself: a squeaky toy hammer swings in and bonks the robot on the
  // head (drawn in 3D, see office3d/hammer.js). onHit runs the moment it lands.
  const BONK_HIT_MS = 420; // BONK.hit in office3d/index.js
  function smack(onHit: () => void) {
    flash('bonk', 1100);
    setTimeout(() => Sfx.key.swish(), BONK_HIT_MS - 110); // the swing
    setTimeout(() => {
      Sfx.key.squeak(); // the squeaky toy lands
      flash('shake', 400);
      onHit();
    }, BONK_HIT_MS);
  }

  function bonkRobot() {
    if (quizWord) {
      // a bonk mid-quiz: not now, thanks
      return smack(() => {
        ipc.robotVocabQuiz('later');
        express('dizzy', 'o', 1200);
      });
    }
    smack(bonked);
  }

  // Clicking a sleeping robot: the squeaky hammer wakes it up (no cooldown, and
  // it doesn't hurry a task along, it just wakes up and opens the chat).
  // ------------------------------------------------------------ playing with it

  // Things round the desk to click (office3d props.js): the squeaky hammer on the desk
  // bonks it (and wakes it if it's asleep, like a click), the charger's plug on the floor
  // charges its battery (asleep too, without waking it). A dance party and a high-five it
  // gets up to by itself now and then (awakeAntic), and for a milestone.
  const PLAY_MS = { charge: 2600, highfive: 1300, dance: 4300 };
  // (byUser: you clicked something; its own idle dance or high-five doesn't count as you being around)
  function playWith(what: 'bonk' | keyof typeof PLAY_MS, { byUser = true } = {}) {
    stopAntic(); // whatever idle antic was playing gives way
    if (byUser) state.lastActivity = Date.now();
    if (what === 'bonk') return state.awake ? bonkRobot() : bonkAwake();
    // (one at a time, but your click wins over a dance or high-five it got up to by itself)
    if (state.playing && (!byUser || state.playingByUser)) return;
    if (state.playing) robot.classList.remove(state.playing);
    state.playing = what;
    state.playingByUser = byUser;
    clearTimeout(playWith.timer);
    playWith.timer = setTimeout(() => (state.playing = null), PLAY_MS[what]);
    flash(what, PLAY_MS[what]); // the 3D view acts it out
    if (what === 'charge') {
      Sfx.key.charge();
      express('happy', 'o', 1900);
      setTimeout(() => {
        express('happy', 'smile', 1500);
        flash('hop', 600);
        showPop(pick(['Battery 100%! ⚡', 'Fully charged!', 'Zap! I feel brand new.']), 2000);
      }, 2000);
    } else if (what === 'highfive') {
      strikePose('raise', 1200);
      express('open', 'o', 450);
      setTimeout(() => {
        (byUser ? Sfx.key : Sfx).clap(); // (one it does by itself: an extra)
        express('happy', 'smile', 1200);
        showPop(pick(['Up top! ✋', 'Nice one!', 'Team work! ✋']), 1500);
      }, 450);
    } else if (what === 'dance') {
      (byUser ? Sfx.key : Sfx).dance();
      setActivity('dance', PLAY_MS.dance); // the disco screen
      strikePose('cheer', PLAY_MS.dance);
      express('happy', 'smile', PLAY_MS.dance);
      showPop(pick(['💃 Dance party!', 'Let’s boogie!', 'Disco time! 🕺']), 1800);
    }
  }
  playWith.timer = 0;

  function bonkAwake() {
    if (state.waking) return; // the hammer is already on its way
    state.waking = true;
    smack(() => {
      state.waking = false;
      if (state.awake) return;
      state.lastBonk = Date.now();
      startled();
    });
  }

  // startled awake (after wake(), so its own wake-up face doesn't win)
  function startled() {
    wake({ sayHi: false });
    express(pick(['dizzy', 'flat']), 'o', 1600);
    Sfx.key.annoyed();
    setTimeout(() => showPop(pick(persona().bonked || ['OW!']), 2200), 350);
  }

  function bonked() {
    const now = Date.now();
    if (now - (state.lastBonk || 0) < BONK_COOLDOWN_MS) {
      express('dizzy', 'o', 1200);
      if (state.awake) showPop("I'm already hurrying!", 1400);
      return;
    }
    state.lastBonk = now;
    const working = active()?.busy ? active() : [...tabs.values()].find((t) => t.busy);
    if (working && !working.compacting && !working.terminal && !working.bonk) return hurry(working);
    if (!state.awake) return startled();
    express('flat', 'o', 1400);
    flash('squish', 450);
    showPop(pick(persona().bonked || ['OW!']), 1800);
  }

  async function hurry(tab: ChatTab) {
    const asked = tab.current?.ask;
    if (!asked) {
      showPop(pick(persona().bonked || ['OW!']), 1800);
      return;
    }
    const turnId = uid();
    tab.bonk = { turnId, ask: asked };
    tab.hurried = true;
    robot.dataset.hurry = '1'; // sweat drops and frantic typing (3D)
    addNote('🔨 Bonked! Starting over, quicker.', '', tab);
    setTabStatus(tab, '🔨 Hurrying…');
    renderWorking();
    if (animates(tab)) {
      setActivity('edit');
      express('dizzy', 'o', 1500);
    }
    showPop(pick(persona().bonked || ['OW!']), 2000);
    // queue the hurried rerun, then let it jump the queue (this interrupts the current answer)
    const res = await ipc.robotAsk(tab.id, asked.question + HURRY, asked.paths, turnId, 'bonk');
    if (!res.ok) {
      tab.bonk = null;
      addNote(`🔨 ${res.error}`, '', tab);
      return;
    }
    if (res.queued) ipc.robotSendNow(tab.id, turnId);
  }

  $('#btn-bonk').addEventListener('click', bonkRobot);
  $('#btn-bonk-working').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also open the chat
    bonkRobot();
  });

  // ------------------------------------------------------------ to-do card

  // Claude Code's task list for this tab, as a checklist the robot ticks off.
  const todoEl = $('#todo');

  function renderTodo() {
    const t = active()!; // (it has tasks only with a tab open)
    const tasks = t?.tasks || [];
    todoEl.hidden = !tasks.length;
    if (!tasks.length) return;
    const done = tasks.filter((x) => x.status === 'completed').length;
    todoEl.classList.toggle('collapsed', !!t.todoCollapsed);
    todoEl.innerHTML = '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="todo-list"></ul>';
    todoEl.querySelector('.todo-title')!.textContent = `Plan  ${done}/${tasks.length}`;
    todoEl.querySelector<HTMLElement>('.todo-bar i')!.style.width = `${(done / tasks.length) * 100}%`;
    todoEl.querySelector('.todo-chev')!.textContent = t.todoCollapsed ? 'show' : 'hide';
    todoEl.querySelector('.todo-head')!.addEventListener('click', () => {
      t.todoCollapsed = !t.todoCollapsed;
      renderTodo();
    });
    const list = todoEl.querySelector('.todo-list')!;
    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = `${task.status}${task.id === t.justDone ? ' just-done' : ''}`;
      li.innerHTML = '<span class="ti"></span><span class="tt"></span>';
      li.querySelector('.ti')!.textContent = ''; // (a checkbox drawn in CSS: empty, spinning, ticked)
      li.querySelector('.tt')!.textContent = task.status === 'in_progress' ? task.activeForm || task.subject : task.subject;
      list.appendChild(li);
    }
  }

  function onTasks(tab: ChatTab, ev: Extract<ChatEvent, { type: 'tasks' }>) {
    tab.tasks = ev.tasks;
    const c = ev.change || {};
    const task = tab.tasks.find((x) => x.id === c.id);
    tab.justDone = c.op === 'update' && c.status === 'completed' ? c.id : null;
    if (c.op === 'create') tab.todoCollapsed = false;
    if (tab === active()) renderTodo();
    if (tab !== active() || !animates(tab)) return;
    if (c.op === 'update' && c.status === 'completed') {
      const allDone = tab.tasks.every((x) => x.status === 'completed');
      Sfx.tick();
      flash('hop', 600);
      express('happy', 'smile', 1200);
      if (allDone) {
        strikePose('cheer', 1600);
        showPop('All tasks done! ✨', 2200);
        setTimeout(() => {
          tab.todoCollapsed = true;
          if (tab === active()) renderTodo();
        }, 8000);
      } else if (task) showPop(`✓ ${task.subject.length > 34 ? task.subject.slice(0, 33) + '…' : task.subject}`, 1800);
    }
  }

  // ------------------------------------------------------------ helper agents

  // Helper agents (sub-agents) Claude Code sends out, each with its own card:
  // what it's doing right now, how far it got, and its report when it's back.
  const helpersEl = $('#helpers');
  // (call: a tool step's details instead; file: a file or folder, trail: the ones opened before it, for Back)
  const helperView: { id: string | null; call: ToolCall | null; tab: ChatTab | null; timer: number; file: string | null; trail: string[] } = { id: null, call: null, tab: null, timer: 0, file: null, trail: [] };
  const AGENT_ICON: Record<string, string> = { completed: 'check', failed: 'alert', killed: 'stop', stopped: 'stop' };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const elapsed = (a: Helper) => {
    const s = Math.max(0, Math.round(((a.ended || Date.now()) - a.started) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const stepLabel = (s: { tool: string; detail: string }) => {
    const [emoji, verb] = TOOLS[s.tool] || ['🛠️', `Using ${s.tool}`];
    return `${emoji} ${verb}${s.detail ? ' ' + s.detail : ''}`;
  };
  const helperMeta = (a: Helper) =>
    [a.toolsUsed ?? a.steps.length ? plural(a.toolsUsed ?? a.steps.length, 'step') : '', a.tokens ? `${Math.round(a.tokens / 1000)}k tokens` : '', elapsed(a)].filter(Boolean).join(' · ');

  function onAgent(tab: ChatTab, ev: Extract<ChatEvent, { type: 'agent' }>) {
    tab.agents ||= new Map<string, Helper>();
    const fresh = !tab.agents.has(ev.id);
    const a: Helper = tab.agents.get(ev.id) || { id: ev.id, description: 'Helper', status: 'running', steps: [], text: '', started: Date.now() };
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
        Object.assign(a, { activity: ev.activity || a.activity, tokens: ev.tokens ?? a.tokens, toolsUsed: ev.tools ?? a.toolsUsed });
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
        Object.assign(a, { status: ev.status || 'completed', summary: ev.summary || a.summary, report: ev.report || a.report, ended: a.ended || Date.now() });
        if (ev.tokens) a.tokens = ev.tokens;
        if (ev.tools !== undefined) a.toolsUsed = ev.tools;
        if (wasRunning) {
          tab.justBack = a.id;
          if (animates(tab)) {
            Sfx.tick();
            flash('hop', 600);
            const name = a.description.length > 30 ? a.description.slice(0, 29) + '…' : a.description;
            showPop(a.status === 'completed' ? `🤖 “${name}” is back!` : `🤖 “${name}” ran into trouble`, 2200);
          }
        }
        break;
      }
    }
    if (tab === active()) renderHelpers();
    if (helperView.id === a.id) renderHelperView();
    actOutHelper(tab, ev, fresh);
  }

  // the robot acts out its helpers: a whee as one flies off, a hop when one takes
  // a step, and supervising (chin in hand, watching them circle) while any are out
  function actOutHelper(tab: ChatTab, ev: Extract<ChatEvent, { type: 'agent' }>, fresh: boolean) {
    renderTabs(); // tab dot, and the count of little bots
    renderWorking();
    if (!animates(tab)) return;
    if (ev.op === 'start' && fresh) {
      Sfx.whee();
      flash('hop', 600);
    } else if (ev.op === 'step') {
      flash('helper-step', 400);
      Sfx.tool();
    }
    if (ev.op === 'done' && !helpersOut() && !state.busy) {
      // the last one is back
      setActivity('done', 2600);
      express('happy', 'smile', 2000);
      return;
    }
    const rest = restingActivity();
    // don't cut short a tool or talking scene of the answer in progress
    if (!state.busy && state.activity !== rest && state.activity !== 'done') setActivity(rest);
    else if (state.busy && rest === 'helpers' && (state.activity === 'think' || state.activity === 'agent')) setActivity(rest);
    renderFace();
  }

  function clearFinishedHelpers(tab: ChatTab) {
    if (!tab.agents?.size || [...tab.agents.values()].some((a) => a.status === 'running')) return;
    tab.agents.clear();
    if (tab === active()) renderHelpers();
  }

  function renderHelpers() {
    const t = active()!; // (it has helpers only with a tab open)
    const list = [...(t?.agents?.values() || [])];
    helpersEl.hidden = !list.length;
    if (!list.length) return;
    const back = list.filter((a) => a.status !== 'running').length;
    helpersEl.classList.toggle('collapsed', !!t.helpersCollapsed);
    helpersEl.innerHTML = '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="helper-list"></ul>';
    helpersEl.querySelector('.todo-title')!.textContent = back === list.length ? `${plural(list.length, 'helper')}  all back` : `Helpers  ${back}/${list.length} back`;
    helpersEl.querySelector<HTMLElement>('.todo-bar i')!.style.width = `${(back / list.length) * 100}%`;
    helpersEl.querySelector('.todo-chev')!.textContent = t.helpersCollapsed ? 'show' : 'hide';
    helpersEl.querySelector('.todo-head')!.addEventListener('click', () => {
      t.helpersCollapsed = !t.helpersCollapsed;
      renderHelpers();
    });
    const ul = helpersEl.querySelector('.helper-list')!;
    for (const a of list) {
      const li = document.createElement('li');
      li.className = `${a.status}${a.id === t.justBack ? ' just-back' : ''}`;
      li.title = 'Click to watch it work';
      li.innerHTML = '<span class="hi"></span><span class="hn"></span><span class="hm"></span><span class="hs"></span>';
      li.querySelector('.hi')!.innerHTML = AGENT_ICON[a.status] ? Icon(AGENT_ICON[a.status], 'sm') : '';
      li.querySelector('.hn')!.textContent = `${a.parent ? '↳ ' : ''}${a.description}`;
      li.querySelector('.hm')!.textContent = helperMeta(a);
      const firstLine = (a.summary || a.report || '').split('\n').find((l) => l.trim()) || '';
      li.querySelector('.hs')!.textContent = a.status === 'running' ? a.activity || 'Getting started…' : firstLine || 'Done';
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
      const t = active();
      if (!t) return void (outputsEl.hidden = true);
      const outputs = collectOutputs(t.log);
      // (redrawn only when it changes: not under the mouse every frame the words stream in)
      const drawn = JSON.stringify([t.id, outputs]);
      if (drawn === outputsDrawn) return;
      outputsDrawn = drawn;
      renderOutputsStrip(outputsEl, outputs, { openPanel: () => openOutputsView() });
      if (helperView.file === OUTPUTS_VIEW) showOutputsPanel(outputs);
    });
  }
  new MutationObserver(renderOutputsSoon).observe($('#logs'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

  // all of them, in the helper panel (a file opened from there comes Back to it)
  const OUTPUTS_VIEW = 'outputs:';
  function openOutputsView({ back = false } = {}) {
    if (history.isOpen()) history.close();
    clearInterval(helperView.timer);
    if (!back) helperView.trail = [];
    Object.assign(helperView, { id: null, call: null, tab: active() ?? null, file: OUTPUTS_VIEW });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    const title = $('#hv-title');
    title.innerHTML = Icon('box', 'sm lead');
    title.append('Outputs');
    title.title = 'What this conversation made and changed';
    showOutputsPanel(active() ? collectOutputs(active()!.log) : []);
    $('#hv-body').scrollTop = 0;
  }
  function showOutputsPanel(outputs: ReturnType<typeof collectOutputs>) {
    renderOutputsPanel($('#hv-body'), outputs, {
      folder: state.character?.folder || '',
      thumb: imageUrl,
      openInApp,
      reveal: (p) => ipc.robotOpenFile(p, { reveal: true }),
    });
  }

  // running helpers' clocks keep ticking on the card
  setInterval(() => {
    const t = active();
    if (!helpersEl.hidden && [...(t?.agents?.values() || [])].some((a) => a.status === 'running')) renderHelpers();
  }, 1000);

  function openHelper(tab: ChatTab, id: string) {
    if (!tab.agents?.has(id)) return;
    if (history.isOpen()) history.close();
    Object.assign(helperView, { id, tab, call: null, file: null, trail: [] });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    renderHelperView(true);
    clearInterval(helperView.timer);
    helperView.timer = setInterval(() => helperView.tab?.agents?.get(helperView.id!)?.status === 'running' && renderHelperView(), 1000);
  }

  // One tool step up close (the same panel as a helper): what it was called with, field by
  // field, and what it gave back. Asking another robot shows the whole question and answer.
  function openToolView(tab: ChatTab, call: ToolCall) {
    if (history.isOpen()) history.close();
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
    const look = toolLook(c.name, c.detail);
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
    Icon.text(bodyEl.querySelector(`.pill-${status}`)!, { running: '⏳ Working', failed: '⚠️ Error', completed: '✅ Done' }[status]);
    bodyEl.querySelector('.hv-kind')!.textContent = c.name;
    // the input, field by field
    const argsEl = bodyEl.querySelector('.tv-args')!;
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
          val.innerHTML = md(v);
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
    const outEl = bodyEl.querySelector<HTMLElement>('.tv-out')!;
    const media = Array.isArray(c.media) ? c.media : [];
    if (media.length && !c.running) outEl.after(stepMedia(media, args));
    if (c.running) outEl.innerHTML = '<p class="hv-empty">Still working on it…</p>';
    else if (c.output === undefined || c.output === null) outEl.innerHTML = media.length ? '' : `<p class="hv-empty">${missing}</p>`;
    else if (!c.output) outEl.innerHTML = media.length ? '' : '<p class="hv-empty">(nothing)</p>';
    else {
      bodyEl.querySelector<HTMLElement>('[data-copy="output"]')!.hidden = false;
      // another robot's answer reads as its message; everything else as the tool gave it
      if (/^mcp__cbot__/.test(c.name) && !c.isError) {
        outEl.className = 'tv-out hv-words';
        outEl.innerHTML = md(c.output);
      } else {
        outEl.className = `tv-out block${c.isError ? ' error' : ''}`;
        outEl.textContent = c.output;
      }
    }
    for (const b of bodyEl.querySelectorAll<HTMLElement>('.tv-copy')) {
      b.addEventListener('click', () => {
        const text = b.dataset.copy === 'args' ? JSON.stringify(c.args ?? {}, null, 2) : String(c.output ?? '');
        navigator.clipboard.writeText(text).then(() => showPop('Copied! 📋', 1200), () => {});
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
      el.querySelector('b')!.textContent = title;
      el.querySelector('small')!.textContent = sub;
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
        box.appendChild(card('image', fileName || 'A picture', file ? 'Not kept in the saved history (too big): click to open the file' : 'Not kept in the saved history (too big)'));
      } else if (m.kind === 'document') {
        const kind = /pdf/i.test(m.mimeType || '') ? 'PDF' : (m.mimeType || 'Document').replace(/^application\//, '').toUpperCase();
        const size = m.size ? ` · ${m.size < 1024 ? `${m.size} B` : m.size < 1048576 ? `${Math.round(m.size / 1024)} KB` : `${(m.size / 1048576).toFixed(1)} MB`}` : '';
        box.appendChild(card('file', fileName || `A ${kind} document`, `${kind}${size}${file ? ' · click to open' : ''}`));
      }
    }
    return box;
  }

  function closeHelper() {
    clearInterval(helperView.timer);
    Object.assign(helperView, { id: null, call: null, tab: null, file: null, trail: [] });
    $('#helper-view').hidden = true;
    document.body.classList.remove('helper-open');
    scrollDown();
    input.focus();
  }
  // Back: to the file or folder opened before this one, or out to the chat
  function backFromView() {
    const prev = helperView.file && helperView.trail.pop();
    if (prev === OUTPUTS_VIEW) openOutputsView({ back: true });
    else if (prev) openFileView(prev, { back: true });
    else closeHelper();
  }
  $('#hv-back').addEventListener('click', backFromView);

  // A file or folder up close, in the chat (chat/fileview.ts): clicking a file in the chat
  // shows it here; a file in a folder's list (or the folder a file is in) opens in its place.
  let fileViewSeq = 0;
  async function openFileView(path: string, { back = false } = {}) {
    if (history.isOpen()) history.close();
    clearInterval(helperView.timer);
    if (!back && helperView.file && helperView.file !== path) helperView.trail.push(helperView.file);
    if (!helperView.file) helperView.trail = [];
    Object.assign(helperView, { id: null, call: null, tab: active() ?? null, file: path });
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    const title = $('#hv-title');
    title.textContent = name;
    title.title = path;
    const bodyEl = $('#hv-body');
    const seq = ++fileViewSeq;
    const res = await ipc.robotReadFile(path).catch((err) => ({ ok: false as const, error: String(err) }));
    if (seq !== fileViewSeq || helperView.file !== path) return; // (another was opened meanwhile)
    if (!res.ok) {
      bodyEl.innerHTML = '<div class="fv-card"><div class="fv-card-what"></div><button type="button" class="fv-card-open" data-icon="open">Open in its app</button></div>';
      bodyEl.querySelector('.fv-card-what')!.textContent = res.error;
      bodyEl.querySelector('.fv-card-open')!.addEventListener('click', () => openInApp(path));
      Icon.fill(bodyEl);
      return;
    }
    title.innerHTML = Icon(viewIcon(res), 'sm lead');
    title.append(res.name);
    renderFileView(bodyEl, res, {
      md,
      fileUrl: FILE_URL,
      open: (p) => openFileView(p),
      openInApp,
      reveal: (p) => ipc.robotOpenFile(p, { reveal: true }),
      copy: (text, btn) =>
        navigator.clipboard.writeText(text).then(() => {
          btn.classList.add('done');
          setTimeout(() => btn.classList.remove('done'), 1400);
          showPop('Copied! 📋', 1200);
        }, () => {}),
    });
    Icon.fill(bodyEl);
    bodyEl.scrollTop = 0;
  }

  function renderHelperView(top = false) {
    const a = helperView.tab?.agents?.get(helperView.id!);
    if (!a) return closeHelper();
    const bodyEl = $('#hv-body');
    const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
    const open = bodyEl.querySelector('details')?.open;
    Icon.text($('#hv-title'), `🤖 ${a.description}`);
    const status = ({ running: '⏳ Working', completed: '✅ Done', failed: '⚠️ Failed', killed: '🛑 Stopped', stopped: '🛑 Stopped' } as Record<string, string>)[a.status] || a.status;
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${a.status}"></span><span class="hv-kind"></span><span class="hv-stats"></span></div>
      <details><summary>Its job (what it was asked)</summary><div class="hv-prompt"></div></details>
      <h4>Steps</h4><ul class="hv-steps"></ul>
      <div class="hv-said" hidden><h4>What it says</h4><div class="hv-words md-said"></div></div>
      <div class="hv-rep" hidden><h4>Report</h4><div class="hv-words md-rep"></div></div>`;
    Icon.text(bodyEl.querySelector(`.pill-${a.status}`)!, status);
    bodyEl.querySelector('.hv-kind')!.textContent = `${a.kind || 'helper'}${a.background ? ' · in the background' : ''}`;
    bodyEl.querySelector('.hv-stats')!.textContent = helperMeta(a);
    bodyEl.querySelector('.hv-prompt')!.textContent = a.prompt || '(not shared)';
    if (open) bodyEl.querySelector('details')!.open = true;
    const steps = bodyEl.querySelector('.hv-steps')!;
    if (!a.steps.length) steps.innerHTML = `<li class="hv-empty">${a.status === 'running' ? (a.activity ? '' : 'Getting started…') : 'No steps reported.'}</li>`;
    if (!a.steps.length && a.status === 'running' && a.activity) steps.querySelector('.hv-empty')!.textContent = a.activity;
    a.steps.forEach((s, i) => {
      const li = document.createElement('li');
      if (a.status === 'running' && i === a.steps.length - 1) li.className = 'now';
      li.innerHTML = '<span class="st"></span><span class="sw"></span>';
      Icon.text(li.querySelector('.st')!, stepLabel(s));
      li.querySelector<HTMLElement>('.st')!.title = stepLabel(s);
      li.querySelector('.sw')!.textContent = `+${Math.max(0, Math.round((s.at - a.started) / 1000))}s`;
      steps.appendChild(li);
    });
    const report = a.report || a.summary || '';
    if (a.text && a.text.trim() !== report.trim()) {
      bodyEl.querySelector<HTMLElement>('.hv-said')!.hidden = false;
      bodyEl.querySelector('.md-said')!.innerHTML = md(a.text);
    }
    if (report) {
      bodyEl.querySelector<HTMLElement>('.hv-rep')!.hidden = false;
      bodyEl.querySelector('.md-rep')!.innerHTML = md(report);
    }
    if (top) bodyEl.scrollTop = 0;
    else if (nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ------------------------------------------------------------ brain: model, effort, memory

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
  const EFFORT_ICONS: Record<string, string> = { low: 'signal-low', medium: 'signal-medium', high: 'signal-high', xhigh: 'signal', max: 'rocket' };
  const models = (): (typeof FALLBACK_MODELS)[number][] => (brainInfo.models.length ? brainInfo.models : FALLBACK_MODELS);
  const modelName = (v?: string) => (models().find((m) => m.value === (v || '')) || { displayName: v || 'Default' }).displayName.replace(/\s*\(recommended\)/i, '');

  async function loadBrain(tab: ChatTab) {
    const info = await ipc.robotBrain(tab.id);
    if (!info) return;
    if (info.models?.length) brainInfo.models = info.models;
    tab.model = info.model;
    tab.effort = info.effort;
    tab.mode = info.permissionMode;
    tab.canBypass = info.canBypass;
    if (info.context) tab.context = info.context;
    if (tab === active()) renderBrain();
  }

  function renderBrain() {
    const t = active();
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
    body.classList.toggle('plan-mode', mode === 'plan');
    input.placeholder = mode === 'plan' ? 'Plan something with me… (Shift+Tab: mode)' : 'Ask me something… (/ for commands, @ for files)';
    const meter = $('#brain-meter');
    const ctx = t.context;
    const pct = ctx ? Math.max(0, Math.min(100, ctx.percentage)) : null;
    meter.querySelector<HTMLElement>('.bm-bar i')!.style.width = `${pct ?? 0}%`;
    meter.querySelector('.bm-pct')!.textContent = pct === null ? '–' : `${pct}%`;
    meter.classList.toggle('warm', (pct ?? 0) >= 60 && (pct ?? 0) < 80);
    meter.classList.toggle('full', (pct ?? 0) >= 80);
    meter.title = ctx
      ? `Memory: ${Math.round(ctx.totalTokens / 1000)}k of ${Math.round(ctx.maxTokens / 1000)}k tokens${ctx.autoCompact && ctx.autoCompactAt ? ` · auto-squishes near ${Math.round((ctx.autoCompactAt / ctx.maxTokens) * 100)}%` : ''}\nClick for options`
      : 'Memory: ask me something first';
    // the 3D robot shows its brain: eye colour per model, a headband at high effort, steam when full
    robot.dataset.model = t.model || 'default';
    robot.dataset.effort = t.effort || '';
    robot.dataset.brain = (pct ?? 0) >= 80 ? 'full' : '';
    if ((pct ?? 0) >= 80 && !t.warnedFull && t === active()) {
      t.warnedFull = true;
      showPop('My head is getting full… /compact?', 3000);
    }
    if ((pct ?? 0) < 60) t.warnedFull = false;
  }

  const menuEl = $('#menu');
  function openMenu(anchor: HTMLElement, title: string, items: { icon?: string; label: string; desc?: string; value: string; on?: boolean }[], onPick: (value: string) => void) {
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
      el.querySelector('b')!.textContent = it.label;
      el.querySelector('small')!.textContent = it.desc || '';
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
    if (!menuEl.hidden && !menuEl.contains(e.target as Element) && !(e.target as Element).closest('#brainbar')) closeMenu(); // (a press lands on an element)
  });

  function openModelMenu() {
    const t = active()!;
    openMenu($('#brain-model'), 'Brain (model) for this tab', models().map((m) => ({ label: m.displayName, desc: m.description, value: m.value, on: (t.model || '') === m.value })), (v) => setBrain(t, { model: v }));
  }
  function openEffortMenu() {
    const t = active()!;
    const allowed = models().find((m) => m.value === (t.model || ''))?.efforts;
    const levels = Object.keys(EFFORTS).filter((l) => !allowed?.length || allowed.includes(l));
    openMenu($('#brain-effort'), 'How hard I think (effort)', [
      { icon: 'zap', label: 'auto', desc: "Claude Code's default", value: '', on: !t.effort },
      ...levels.map((l) => ({ icon: EFFORT_ICONS[l], label: l, desc: EFFORTS[l][1], value: l, on: t.effort === l })),
    ], (v) => setBrain(t, { effort: v }));
  }
  function openMemoryMenu() {
    const t = active()!;
    openMenu($('#brain-meter'), 'Memory (context)', [
      { icon: 'collapse', label: 'Compact now', desc: 'Squish the conversation into a summary to free up room', value: 'compact' },
      { icon: 'gauge', label: 'What’s in my head?', desc: 'How full my memory is', value: 'context' },
    ], (v) => (v === 'compact' ? compactTab(t) : showContext(t)));
  }
  const modeOf = (t: ChatTab): PermissionMode => t.mode || state.character?.permissionMode || 'default';
  // the modes this tab may switch to, in Shift+Tab order (full access only where the robot is trusted with it)
  const modesFor = (t: ChatTab) => (Object.keys(MODES) as PermissionMode[]).filter((m) => m !== 'bypassPermissions' || t.canBypass || modeOf(t) === m);
  function openModeMenu() {
    const t = active()!;
    openMenu($('#brain-mode'), 'Permissions for this tab (Shift+Tab)', modesFor(t).map((m) => ({ icon: MODES[m][0], label: MODES[m][1], desc: MODES[m][2], value: m, on: modeOf(t) === m })), (v) =>
      setBrain(t, { permissionMode: v as PermissionMode }),
    );
  }
  function cycleMode() {
    const t = active()!;
    const all = modesFor(t);
    setBrain(t, { permissionMode: all[(all.indexOf(modeOf(t)) + 1) % all.length] });
  }
  $('#brain-mode').addEventListener('click', openModeMenu);
  $('#brain-model').addEventListener('click', openModelMenu);
  $('#brain-effort').addEventListener('click', openEffortMenu);
  $('#brain-meter').addEventListener('click', openMemoryMenu);

  function pickModel(arg: string) {
    const q = arg.toLowerCase();
    const m = models().find((x) => x.value === q || x.displayName.toLowerCase().startsWith(q) || (q === 'default' && !x.value));
    if (m) setBrain(active()!, { model: m.value });
    else addNote(`🧠 I don't know a model called “${arg}”. Try: ${models().map((x) => x.value || 'default').join(', ')}`);
  }
  function pickEffort(arg: string) {
    const l = arg.toLowerCase();
    if (l === 'auto' || EFFORTS[l]) setBrain(active()!, { effort: l === 'auto' ? '' : l });
    else addNote(`⚡ Effort can be: auto, ${Object.keys(EFFORTS).join(', ')}`);
  }

  // Swap the brain mid-chat: the robot spins, its monitor reboots and its eyes change colour.
  async function setBrain(tab: ChatTab, patch: { model: string } | { effort: string } | { permissionMode: PermissionMode }) {
    if ('permissionMode' in patch && patch.permissionMode === modeOf(tab)) return;
    const res = await ipc.robotSetBrain(tab.id, patch);
    if (!res.ok) {
      addNote(`🧠 Couldn't switch: ${res.error || 'unknown problem'}`, '', tab);
      return;
    }
    if ('permissionMode' in patch) tab.mode = patch.permissionMode;
    else Object.assign(tab, patch);
    if (tab === active()) renderBrain();
    if ('permissionMode' in patch) {
      const mode = patch.permissionMode;
      addNote(mode === 'plan' ? '📋 Plan mode: I look around and write a plan. Nothing changes until you approve it.' : `🔒 ${MODES[mode][1]}: ${MODES[mode][2].toLowerCase()}`, '', tab);
      flash(mode === 'plan' ? 'hop' : 'shake', 500);
      Sfx.swap();
      showPop(mode === 'plan' ? pick(['Let me plan first!', 'Thinking cap on!', 'Blueprints out!']) : `${MODES[mode][1]}!`, 1600);
    }
    if ('model' in patch) {
      addNote(`🧠 Brain swapped to ${modelName(patch.model)} for this tab`, '', tab);
      flash('spin', 950);
      Sfx.swap();
      if (!state.busy) setActivity('boot', 900);
      showPop(`🧠 ${modelName(patch.model)} installed!`, 2000);
    }
    if ('effort' in patch) {
      const [emoji, words] = EFFORTS[patch.effort] || ['⚡', 'Back to auto'];
      addNote(`${emoji} Effort: ${patch.effort || 'auto'}`, '', tab);
      flash(patch.effort === 'max' || patch.effort === 'xhigh' ? 'shake' : 'hop', 600);
      Sfx.swap();
      showPop(`${emoji} ${words}!`, 1800);
    }
  }

  // /compact: the robot squishes its papers into a cube on the monitor.
  async function compactTab(tab: ChatTab | undefined) {
    if (!tab) return;
    if (tab.busy) {
      showPop('Let me finish this first!', 1800);
      return;
    }
    const turnId = uid();
    startCompact(tab);
    const res = await ipc.robotCompact(tab.id, turnId);
    if (!res.ok) finishCompact(tab, res.error);
  }

  function startCompact(tab: ChatTab) {
    if (tab.compacting) return;
    tab.compacting = true;
    tab.compactResult = null;
    if (!tab.busy) setBusy(tab, true);
    addNote('🗜️ Squishing my memory…', '', tab);
    setTabStatus(tab, 'Compacting my memory…');
    tab.activity = 'compact';
    if (animates(tab)) {
      setActivity('compact');
      Sfx.crunch();
    }
  }

  function finishCompact(tab: ChatTab, error?: string) {
    if (!tab.compacting) return;
    tab.compacting = false;
    setBusy(tab, false);
    if (error) {
      addNote(`🗜️ Couldn't compact: ${error}`, '', tab);
      return;
    }
    const r = tab.compactResult;
    // (Claude Code doesn't always say how big it is after)
    const sizes = r?.pre ? (r.post != null ? `: ${Math.round(r.pre / 1000)}k → ${Math.round(r.post / 1000)}k tokens` : ` (was ${Math.round(r.pre / 1000)}k tokens)`) : '';
    addNote(`🗜️ Compacted my memory${sizes}`, '', tab);
    if (animates(tab)) {
      setActivity('done', 2000);
      flash('squish', 500);
      express('happy', 'smile', 1500);
      Sfx.done();
      showPop('Ahh, much lighter!', 2000);
    }
  }

  async function showContext(tab: ChatTab) {
    const info = await ipc.robotBrain(tab.id);
    const c = info?.context;
    if (!c) {
      addNote('📊 My memory is empty so far. Ask me something first!', '', tab);
      return;
    }
    tab.context = c;
    renderBrain();
    addBot(
      `**📊 My memory:** ${Math.round(c.totalTokens / 1000)}k of ${Math.round(c.maxTokens / 1000)}k tokens (${c.percentage}%)` +
        (c.autoCompact && c.autoCompactAt ? `\n\nI'll squish it myself near ${Math.round((c.autoCompactAt / c.maxTokens) * 100)}%, or say \`/compact\` to do it now.` : ''),
      { tab }
    );
  }

  // ------------------------------------------------------------ tabs

  // Bring the renderer's tabs in line with the main process's list.
  function syncTabs(c: RobotView) {
    const seen = new Set<string>();
    for (const t of c.tabs) {
      seen.add(t.id);
      const key = `${t.sessionId}|${t.history.length}|${t.history[t.history.length - 1]?.at || ''}`;
      let tab = tabs.get(t.id);
      if (!tab) {
        const el = document.createElement('div');
        el.className = 'log';
        el.setAttribute('role', 'log');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        logs.appendChild(el);
        // (its title from the start: a busy tab draws the tab strip before the rest is set, below)
        tab = { id: t.id, title: t.title, custom: t.custom, log: el, busy: false, current: null, question: null, statusText: '', status: 'idle', activity: 'idle', draft: '', queue: [] } as Partial<ChatTab> as ChatTab; // (its data and tasks follow)
        tabs.set(t.id, tab);
        tab.data = t;
        renderHistory(tab);
        if (t.busy) {
          // it was already working when this window (re)loaded: keep listening
          addNote('(still working on this one…)', '', tab);
          startReply(tab);
          setBusy(tab, true);
        }
      } else {
        const hadHistory = tab.data.history.length;
        tab.data = t;
        if (!tab.busy && key !== tab.key) {
          if (!t.history.length && hadHistory && !tab.rewinding) {
            tab.log.innerHTML = '';
            addNote('✨ Fresh start! My memory is squeaky clean.', '', tab);
            if (tab.id === activeId) flash('spin', 850);
          } else renderHistory(tab);
        }
      }
      tab.key = key;
      tab.title = t.title;
      tab.custom = t.custom;
      tab.tasks = t.tasks || [];
      if (t.context) tab.context = t.context;
      if ('model' in t) tab.model = t.model;
      if ('effort' in t) tab.effort = t.effort;
    }
    for (const [id, tab] of tabs) {
      if (seen.has(id)) continue;
      clearInterval(tab.verbs);
      tab.log.remove();
      tabs.delete(id);
      shell.forget(id); // (main ended its shells with it)
    }
    // follow the main process when it switches tabs (new tab, resume, close)
    if (c.activeTab !== lastMainActive || !tabs.has(activeId!)) {
      lastMainActive = c.activeTab;
      activateTab(tabs.has(c.activeTab) ? c.activeTab : c.tabs[0].id, { quiet: true });
    }
    renderTabs();
  }

  function activateTab(id: string, { quiet = false } = {}) {
    const next = tabs.get(id);
    if (!next) return;
    const prev = active();
    if (prev !== next) cancelEdit(); // (an edit belongs to its tab)
    if (prev && prev !== next) prev.draft = input.value; // each tab keeps its half-typed message
    activeId = id;
    sides.tabShown(id); // (the side panel holds another tab's thread: it shuts)
    for (const t of tabs.values()) t.log.hidden = t !== next;
    shell.switchTo(id); // (its own shells)
    if (next.status === 'done' || next.status === 'error') next.status = 'idle'; // read it
    if (prev !== next) {
      input.value = next.draft || '';
      autosize();
      hidePalette();
      if (!quiet) ipc.robotTabActivate(id);
    }
    syncChrome();
    renderTabs();
    renderTodo();
    renderHelpers();
    if ((helperView.id || helperView.call || helperView.file) && helperView.tab !== next) closeHelper();
    renderBrain();
    loadBrain(next);
    scrollDown(next);
    // the robot shows what the visible tab is up to
    if (next.busy) setActivity(next.question && !next.question.sent ? 'ask' : next.activity || 'think');
    else if (!state.busy && !state.mirroring) setActivity(restingActivity());
  }

  const statusOf = (t: ChatTab) => {
    if (t.terminal) return 'terminal';
    if (t.question && !t.question.sent) return 'question';
    if (t.busy) return 'busy';
    if (helpersOut(t)) return 'helpers';
    return t.status;
  };
  const STATUS_LABEL = { helpers: 'helpers still working…', busy: 'working…', question: 'has a question for you', done: 'finished', error: 'hit a snag', terminal: 'open in the terminal', idle: '' };

  function renderTabs() {
    if (!state.character) return;
    robot.dataset.helpers = String(helpersOut()); // the little bots circling the desk
    tabStrip.innerHTML = '';
    for (const { id } of state.character.tabs) {
      const t = tabs.get(id);
      if (!t) continue;
      const s = statusOf(t);
      const el = document.createElement('div');
      const temp = !!t.data?.temporary;
      el.className = `tab s-${s}${t.id === activeId ? ' on' : ''}${temp ? ' temporary' : ''}${t.data?.remote ? ' remote' : ''}`;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t.id === activeId));
      el.title = `${temp ? 'Temporary chat (nothing is kept): ' : ''}${t.title}${STATUS_LABEL[s] ? ` (${STATUS_LABEL[s]})` : ''}\nDouble-click to rename`;
      el.innerHTML = `${temp ? Icon('eye', 'sm tab-temp') : ''}<span class="tab-dot"></span><span class="tab-title"></span><button class="tab-x" type="button" title="Close tab (Ctrl+W)">×</button>`;
      el.querySelector('.tab-title')!.textContent = t.title;
      el.addEventListener('click', (e) => {
        if (!(e.target as Element).closest('.tab-x') && t.id !== activeId) activateTab(t.id);
      });
      el.addEventListener('dblclick', (e) => {
        if (!(e.target as Element).closest('.tab-x')) renameTab(t.id, el.querySelector<HTMLElement>('.tab-title')!);
      });
      el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(t.id)); // middle-click closes
      el.querySelector('.tab-x')!.addEventListener('click', () => closeTab(t.id));
      tabStrip.appendChild(el);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New conversation in a new tab (Ctrl+T)';
    add.disabled = tabs.size >= 8;
    add.addEventListener('click', () => newTab());
    tabStrip.appendChild(add);
    const temp = document.createElement('button');
    temp.type = 'button';
    temp.className = 'tab-add tab-add-temp';
    temp.innerHTML = Icon('eye', 'sm');
    temp.title = 'New temporary chat: nothing is kept, and it’s gone (transcript too) when you close it (/temp)';
    temp.disabled = tabs.size >= 8;
    temp.addEventListener('click', () => newTab({ temporary: true }));
    tabStrip.appendChild(temp);
    const closed = state.character.closedTabs || [];
    if (closed.length) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'tab-add tab-reopen';
      back.textContent = '↺';
      back.title = `Reopen closed tab: “${closed[closed.length - 1].title}” (Ctrl+Shift+T)${closed.length > 1 ? `\n${closed.length} closed tabs can come back` : ''}`;
      back.addEventListener('click', () => reopenTab());
      tabStrip.appendChild(back);
    }
    tabStrip.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderRemote();
  }

  async function newTab({ temporary = false } = {}) {
    openChat(); // asking something else mid-task needs the chat
    const res = await ipc.robotTabNew(temporary);
    if (!res.ok) {
      showPop(res.error, 2200);
      return;
    }
    flash('hop', 600);
    Sfx.send();
    setActivity('boot', 800); // fresh page on the monitor
    input.focus();
  }

  async function closeTab(id: string) {
    const t = tabs.get(id);
    if (!t) return;
    const hadChat = !!(t.data?.history?.length || t.data?.sessionId);
    const temp = !!t.data?.temporary;
    if (t.busy && !confirm(`“${t.title}” is still working. Stop it and close the tab?`)) return;
    if (temp && hadChat && !t.busy && !confirm('This temporary chat will be gone for good (it can’t be reopened). Close it?')) return;
    const res = await ipc.robotTabClose(id);
    if (!res.ok) return addNote(`📑 ${res.error}`, '', t);
    if (hadChat && !temp) offerUndo(`“${t.title}” closed`);
  }

  // Closing a tab (× or Ctrl+W) can be taken back: Undo for a few seconds, then ↺ / Ctrl+Shift+T.
  const undoBar = document.createElement('div');
  undoBar.id = 'undo';
  undoBar.hidden = true;
  undoBar.innerHTML = '<span></span><button type="button">Undo</button>';
  $('#panel').appendChild(undoBar);
  undoBar.querySelector('button')!.addEventListener('click', () => {
    undoBar.hidden = true;
    reopenTab();
  });
  function offerUndo(text: string) {
    undoBar.querySelector('span')!.textContent = text;
    undoBar.hidden = false;
    clearTimeout(offerUndo.t);
    offerUndo.t = setTimeout(() => (undoBar.hidden = true), 8000);
  }
  offerUndo.t = 0;

  async function reopenTab() {
    const res = await ipc.robotTabReopen();
    if (!res.ok) return showPop(res.error, 2200);
    flash('hop', 600);
    Sfx.send();
    showPop(`“${res.title}” is back!`, 1800);
  }

  function renameTab(id: string, titleEl: HTMLElement) {
    const t = tabs.get(id);
    if (!t || titleEl.querySelector('input')) return;
    const field = document.createElement('input');
    field.value = t.title;
    titleEl.textContent = '';
    titleEl.appendChild(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save && field.value.trim() && field.value.trim() !== t.title) ipc.robotTabRename(id, field.value.trim());
      else renderTabs();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    field.addEventListener('blur', () => finish(true));
  }

  // Ctrl+T new · Ctrl+W close · Ctrl+Tab / Ctrl+Shift+Tab switch · Ctrl+1…8 jump
  document.addEventListener('keydown', (e) => {
    if (!state.awake || !e.ctrlKey || e.altKey) return;
    const order = state.character!.tabs.map((t) => t.id).filter((id) => tabs.has(id));
    const i = order.indexOf(activeId!);
    if ((e.key === 't' || e.key === 'T') && e.shiftKey) reopenTab();
    else if (e.key === 't' || e.key === 'T') newTab();
    else if (e.key === 'w' || e.key === 'W') closeTab(activeId!);
    else if (e.key === 'Tab') activateTab(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
    else if (/^[1-8]$/.test(e.key) && order[Number(e.key) - 1]) activateTab(order[Number(e.key) - 1]);
    else return;
    e.preventDefault();
  });

  // ------------------------------------------------------------ slash commands

  // Handled right here in the app. Anything else starting with "/" goes to
  // Claude Code as-is, so its own commands and skills work too.
  const LOCAL_COMMANDS = [
    { name: 'resume', args: '[search]', description: 'Pick up a past conversation' },
    { name: 'history', description: 'Browse past conversations' },
    { name: 'new', description: 'Start another conversation in a new tab' },
    { name: 'temp', description: 'A temporary chat: nothing kept, gone when you close it' },
    { name: 'clear', description: 'Wipe this tab and start over' },
    { name: 'close', description: 'Close this tab' },
    { name: 'model', args: '[name]', description: 'Switch my brain (model) for this tab' },
    { name: 'effort', args: '[low…max]', description: 'How hard I think' },
    { name: 'plan', args: '[task]', description: 'Plan mode: I plan first and change nothing until you approve (Shift+Tab)' },
    { name: 'compact', description: 'Squish my memory to free up room' },
    { name: 'context', description: 'How full my memory is' },
    { name: 'terminal', description: 'Continue in full Claude Code, in a terminal' },
    { name: 'remote-control', args: '[on|off]', description: 'Carry on from claude.ai or the Claude app (Remote Control)' },
    { name: 'folder', description: 'Open my folder' },
    { name: 'shell', description: 'A shell in my folder, right here (Ctrl+`; another: Ctrl+Shift+`)' },
    { name: 'refine', args: '[text]', description: 'Refine, translate or explain some text (Quick actions)' },
    { name: 'screen', description: 'Drag a box round part of the screen and ask about it' },
    { name: 'note', args: '<text>', description: 'Jot a note down (it goes on my corkboard)' },
    { name: 'notes', description: 'Open my notebook' },
    { name: 'sleep', description: 'Send me to bed' },
    { name: 'help', description: 'What I can do' },
  ];
  const paletteEl = $('#palette');
  let paletteItems: PaletteCommand[] | PaletteFile[] = [];
  let paletteIndex = 0;

  function helpText() {
    const lines = LOCAL_COMMANDS.map((c) => `- \`/${c.name}${c.args ? ' ' + c.args : ''}\` ${c.description.toLowerCase()}`);
    return [
      '**Tricks I know**',
      ...lines,
      '- any other `/command` (like your skills) goes straight to Claude Code',
      '',
      'Tabs: ＋ or Ctrl+T for a new one, Ctrl+Tab to switch, Ctrl+W to close (↺ or Ctrl+Shift+T brings it back), double-click a tab to rename it.',
      'Drag me anywhere, click me for a poke, right-click for options. Esc sends me to sleep.',
    ].join('\n');
  }

  function runLocalCommand(text: string) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return false;
    const arg = m[2].trim();
    switch (m[1].toLowerCase()) {
      case 'new':
      case 'tab':
        newTab();
        return true;
      case 'temp':
      case 'temporary':
        newTab({ temporary: true });
        return true;
      case 'clear':
      case 'reset':
        ipc.robotReset(activeId!);
        return true;
      case 'close':
        closeTab(activeId!);
        return true;
      case 'resume':
      case 'history':
      case 'conversations':
        openHistory(arg);
        return true;
      case 'terminal':
      case 'cli':
        openTerminal();
        return true;
      case 'remote-control':
      case 'remote':
      case 'rc': {
        const tab = active()!;
        const on = /^(on|start|yes)$/i.test(arg) ? true : /^(off|stop|no)$/i.test(arg) ? false : !tab.data?.remote;
        if (on === !!tab.data?.remote) {
          if (on) remoteNote(tab, tab.data.remoteUrl);
          else addNote('📱 Remote Control is already off.', '', tab);
        } else toggleRemote(tab, on);
        return true;
      }
      case 'model':
        if (arg) pickModel(arg);
        else openModelMenu();
        return true;
      case 'effort':
        if (arg) pickEffort(arg);
        else openEffortMenu();
        return true;
      case 'plan': {
        // on (or, with nothing after it, off again: back to editing); with a task, it's planned straight away
        const tab = active()!;
        const off = !arg && modeOf(tab) === 'plan';
        setBrain(tab, { permissionMode: off ? 'acceptEdits' : 'plan' }).then(() => {
          if (!arg || modeOf(tab) !== 'plan' || tab !== active()) return;
          input.value = arg;
          submit();
        });
        return true;
      }
      case 'compact':
        compactTab(active());
        return true;
      case 'context':
        showContext(active()!);
        return true;
      case 'folder':
        ipc.robotOpenFolder();
        return true;
      case 'shell':
        toggleShell({ show: true });
        return true;
      case 'screen':
      case 'snip':
        ipc.robotScreenAsk();
        return true;
      case 'refine':
      case 'quick':
        ipc.quickOpenBlank({ text: arg });
        return true;
      case 'note':
        if (!arg) ipc.notesOpen({ focus: 'add' });
        else ipc.notesAdd(arg).then((n) => n && addNote(`📝 Noted: ${n.text}${n.important ? ' (important)' : ''}`));
        return true;
      case 'notes':
        ipc.notesOpen({ focus: null });
        return true;
      case 'sleep':
        sleep();
        return true;
      case 'help':
        addBot(helpText());
        return true;
      default:
        return false;
    }
  }

  function updatePalette() {
    // "@" before the caret: files in the robot's folder (quoted for paths with spaces)
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const at = before.match(/(?:^|\s)@"([^"\n]*)$/) || before.match(/(?:^|\s)@([^\s"@]*)$/);
    if (at) return updateMentions(at[1], before.lastIndexOf('@'));
    mentionSeq++;
    const m = input.value.match(/^\/(\S*)$/);
    if (!m) return hidePalette();
    const q = m[1].toLowerCase();
    const local = LOCAL_COMMANDS.filter((c) => c.name.startsWith(q)).map((c): PaletteCommand => ({ ...c, kind: 'local' }));
    const taken = new Set(LOCAL_COMMANDS.map((c) => c.name));
    const claude = (state.claudeCommands || [])
      .filter((c) => !taken.has(c.name) && c.name.toLowerCase().includes(q))
      .slice(0, 40)
      .map((c): PaletteCommand => ({ ...c, kind: 'claude' }));
    paletteItems = [...local, ...claude];
    if (!paletteItems.length) return hidePalette();
    paletteIndex = Math.min(paletteIndex, paletteItems.length - 1);
    paletteEl.innerHTML = '';
    let group: string | null = null;
    paletteItems.forEach((item, i) => {
      if (item.kind !== group) {
        group = item.kind;
        const g = document.createElement('div');
        g.className = 'p-group';
        g.textContent = group === 'local' ? state.character?.name || 'Robot' : 'Claude Code';
        paletteEl.appendChild(g);
      }
      const row = document.createElement('div');
      row.className = `p-item${i === paletteIndex ? ' on' : ''}`;
      row.setAttribute('role', 'option');
      row.innerHTML = '<span class="p-name"></span><span class="p-desc"></span>';
      row.querySelector('.p-name')!.textContent = `/${item.name}`;
      if (item.args) {
        const a = document.createElement('span');
        a.className = 'p-args';
        a.textContent = ` ${item.args}`;
        row.querySelector('.p-name')!.appendChild(a);
      }
      row.querySelector('.p-desc')!.textContent = item.description || '';
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        choose(item, true);
      });
      paletteEl.appendChild(row);
    });
    paletteEl.hidden = false;
    paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function hidePalette() {
    paletteEl.hidden = true;
    paletteIndex = 0;
  }

  // ------------------------------------------------------------ @-mentions

  let mentionSeq = 0;
  let mentionStart = 0;
  async function updateMentions(query: string, start: number) {
    const seq = ++mentionSeq;
    const items = await ipc.robotFiles(query);
    if (seq !== mentionSeq) return; // typed on since
    mentionStart = start;
    paletteItems = items.map((e): PaletteFile => ({ ...e, kind: 'file' }));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
    paletteEl.innerHTML = '';
    const g = document.createElement('div');
    g.className = 'p-group';
    Icon.text(g, `📁 ${folderName()}`);
    paletteEl.appendChild(g);
    if (!paletteItems.length) {
      const none = document.createElement('div');
      none.className = 'p-empty';
      none.textContent = query ? `No files match “${query}”` : 'This folder looks empty';
      paletteEl.appendChild(none);
    }
    paletteItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `p-item p-file${i === paletteIndex ? ' on' : ''}`;
      row.setAttribute('role', 'option');
      row.innerHTML = '<span class="p-icon"></span><span class="p-name"></span><span class="p-desc"></span>';
      const slash = item.rel.lastIndexOf('/');
      row.querySelector('.p-icon')!.innerHTML = Icon(item.dir ? 'folder' : 'file', 'sm');
      row.querySelector('.p-name')!.textContent = item.rel.slice(slash + 1) + (item.dir ? '/' : '');
      row.querySelector('.p-desc')!.textContent = slash > 0 ? item.rel.slice(0, slash) : '';
      row.title = item.rel;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        insertMention(item);
      });
      paletteEl.appendChild(row);
    });
    paletteEl.hidden = false;
    paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  // put "@path" in place of what was typed after @; a folder stays open to pick inside it
  function insertMention(item: PaletteFile) {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(caret).replace(/^[^\s"]*"?/, ''); // the rest of the half-typed path
    const rel = item.rel + (item.dir ? '/' : '');
    const spaced = /\s/.test(rel);
    const token = spaced ? `@"${rel}${item.dir ? '' : '"'}` : `@${rel}`;
    const tail = item.dir ? '' : ' ';
    input.value = before + token + tail + after;
    const pos = (before + token + tail).length;
    input.setSelectionRange(pos, pos);
    paletteIndex = 0;
    autosize();
    input.focus();
    if (item.dir) updatePalette();
    else hidePalette();
  }

  // run = Enter/click: our own commands run straight away; Claude Code ones are completed so you can add arguments
  function choose(item: PaletteCommand | PaletteFile, run: boolean) {
    if (item.kind === 'file') return insertMention(item);
    if (run && item.kind === 'local') {
      input.value = `/${item.name}`;
      submit();
      return;
    }
    input.value = `/${item.name} `;
    autosize();
    hidePalette();
    input.focus();
  }

  function paletteKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = paletteItems.length;
      if (!n) return true;
      paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      updatePalette();
      return true;
    }
    if (!paletteItems.length) return false; // "no files match": Enter sends as usual
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      choose(paletteItems[paletteIndex], e.key === 'Enter');
      return true;
    }
    return false;
  }

  async function refreshCommands() {
    state.claudeCommands = await ipc.robotCommands();
  }

  // ------------------------------------------------------------ a shell in my folder

  // A drawer between the chat and the box you type in (chat/shell.ts); it keeps running while
  // put away, and ends when the robot goes to sleep.
  // Each conversation has shells of its own: switching tabs switches them too.
  const shell = ShellDrawer({
    chatTab: () => activeId,
    folderName: () => folderName(),
    onShown: () => body.classList.add('shell-open'),
    onHidden: ({ quiet }) => {
      body.classList.remove('shell-open');
      if (!quiet && state.awake && !state.collapsed) input.focus();
    },
    onError: (message) => {
      express('flat', 'flat', 1500);
      showPop(message, 2600);
    },
  });

  // (show: from a menu or /shell, out it comes; the button and Ctrl+` put it away again;
  // another: a new tab, another shell)
  function toggleShell({ show = false, another = false } = {}) {
    if (state.mirroring) return showPop('Busy in the terminal!', 1800);
    if (!state.awake) wake({ sayHi: false });
    if (state.collapsed) openChat({ focus: false });
    if (another) shell.add();
    else if (show) shell.show();
    else shell.toggle();
  }
  // Ctrl+` the drawer, Ctrl+Shift+` another shell in it
  // its Claude, in the shells of a conversation (terminal_* tools: app/src/shell.rs): the drawer
  // comes out for it if that conversation is showing
  ipc.on('robot:shell-ask', async (a) => {
    const answer = await shell.ask(a, { showing: state.awake && !state.collapsed && !state.mirroring });
    ipc.robotShellReply(a.req, answer);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey) return;
    e.preventDefault();
    toggleShell({ another: e.shiftKey });
  });

  // ------------------------------------------------------------ side questions (chat/sides.ts)

  const sides = SideQuestions({
    md,
    tabOf: (id) => tabs.get(id),
    staged: () => staged,
    // a side answer taken back to the conversation: into the box, to send (or not)
    useInMain: (text) => {
      const had = input.value.trimEnd();
      input.value = had ? `${had}\n\n${text}` : text;
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    showPop,
  });

  // ------------------------------------------------------------ past conversations

  const history = HistoryView({
    md,
    robotName: () => state.character?.name || 'me',
    activeTabId: () => activeId!,
    onResumed: (res) => {
      const tab = tabs.get(res.tabId) || active()!;
      activateTab(tab.id);
      if (res.already) {
        addNote('↩ That conversation is already open here.', 'resumed', tab);
        return;
      }
      const more = res.total > 30 ? ` (showing the latest of ${res.total} messages)` : '';
      addNote(`↩ Picked up “${res.title}”${more}. Carry on!`, 'resumed', tab);
      Sfx.key.wake();
      flash('spin', 950);
      setActivity('read', 1600); // flick through the old notes
      input.focus();
    },
    onClose: () => input.focus(),
  });

  function openHistory(query = '') {
    if (!state.awake) wake();
    else openChat();
    hidePalette();
    history.open(query);
  }

  // ------------------------------------------------------------ ambient life

  function blinkLoop() {
    if (state.awake || state.busy) flash('blink', 170);
    setTimeout(blinkLoop, rand(2200, 6000));
  }

  // ------------------------------------------------------------ idle antics

  // Little things it gets up to when nobody's asking it anything: sipping
  // coffee, sneezing, snot bubbles in its sleep… The 3D view plays them
  // (office3d/antics/); their lengths and the moments cued below are mirrored
  // from there, so the sounds and words land on time.
  const ANTIC_SEC: Record<string, number> = {
    sip: 3.4, 'sip-empty': 3.8, tip: 3.2, toss: 2.8, 'toss-hit': 2.8, hum: 4.5, sneeze: 2.2, lamp: 2.8,
    drum: 2.6, slump: 2.8, dvd: 9, 'dvd-lucky': 9, feed: 9.6, standdesk: 21, milktea: 5.6, dumbbell: 6, phone: 7, sleepphone: 8, pushup: 10,
    dictionary: 30, 'word-show': 4.2, 'quiz-card': 120, 'word-glance': 7, 'robot-antenna': 2.4, 'robot-defrag': 1.8,
    bubble: 5.2, mumble: 3.6, dream: 6.5, sleeptype: 4.2, slide: 6.5, snore: 2.4, drift: 10, drool: 2.6,
    // IT office life
    duck: 6, reboot: 7, stackoverflow: 5, cable: 4.5, crumbs: 5, 'crumbs-cookie': 5, merge: 6, standup: 7, jira: 5.5, works: 5, jitter: 6.5,
    friday: 4.5, monday: 6, noodles: 7, payday: 6, eyebreak: 6, bsod: 4.2,
    // more sleep
    nightmare: 6.5, snorebar: 9, ping: 5, vacuum: 9, burrito: 8,
    // your notes and the corkboard (office3d/antics/notes.js)
    // the other robots (office3d/antics/social.js)
    'turn-to': 2.6, listen: 10, 'clap-at': 2.2, 'plane-throw': 1.8, 'plane-catch': 2.6, 'plane-read': 2.6, 'feet-up': 4.6,
    notewrite: 30, notepin: 2.4, notetoss: 2.8, boardlift: 3.4, boardglance: 2.6, allclear: 1.8, clockout: 2.6,
    // wandering off round the screen and being brought back
    stepout: 4, stepin: 1.4,
  };
  const CRITTER_ANTICS: Record<string, string[]> = { kit: ['robot-antenna', 'robot-defrag'] };
  const DREAMS: Record<string, string[]> = { kit: ['🔋', '⚙️', '💾'], loopy: ['🪵', '🌲', '🥕'], cat: ['🐟', '🧶', '🐭'], nerd: ['🍕', '💾', '🎮'], girl: ['🧋', '🐱', '🌸'], robot: ['🔋', '⚙️', '💾'] };
  const quip = <K extends keyof Quips>(k: K) => persona().quips?.[k];
  // what lights up its phone at 3 am
  const PINGS = ['Boss: quick question?', 'PROD ALERT 🔥', 'Can you hop on a call?', 'Is the site down??', '@channel standup moved to 7am'];
  let anticSeq = 0;
  let anticUntil = 0;
  let lastAntic: string | undefined = '';

  function antic(name: string, text = '') {
    robot.dataset.antic = name;
    robot.dataset.anticText = text;
    robot.dataset.anticSeq = String(++anticSeq);
    anticUntil = Date.now() + (ANTIC_SEC[name] || 3) * 1000;
    lastAntic = name;
  }
  // something more important came up: the 3D view drops whatever it was playing
  function stopAntic() {
    state.slacking = 0;
    // stopped getting up to leave (a click, a task): the walker that was getting ready goes
    if (state.leaving && !state.away) {
      state.leaving = false;
      ipc.robotWalker('cancel');
    }
    if (!robot.dataset.antic) return;
    robot.dataset.antic = '';
    robot.dataset.anticSeq = String(++anticSeq);
    anticUntil = 0;
  }
  // do this `sec` seconds into the antic, if it's still the one playing
  function cue(sec: number, fn: () => void) {
    const seq = anticSeq;
    setTimeout(() => seq === anticSeq && robot.dataset.antic && fn(), sec * 1000);
  }
  // a weighted pick that won't play the same thing twice in a row
  function pickAntic(weights: Record<string, number>) {
    const options = Object.entries(weights).filter(([k, w]) => w > 0 && k !== lastAntic);
    let r = Math.random() * options.reduce((n, [, w]) => n + w, 0);
    for (const [k, w] of options) if ((r -= w) < 0) return k;
    return options[0]?.[0];
  }

  const idleAwake = () => state.awake && !state.busy && !helpersOut() && !state.mirroring && !press && !state.away && !state.peek;
  const idleAsleep = () => !state.awake && !state.busy && !helpersOut() && !state.mirroring && !press && !state.away && !state.peek;

  // after 10 pm it sleeps in a nightcap, or, still up, codes with its hood up in the monitor's glow
  function nightcap() {
    const h = new Date().getHours();
    const late = h >= 22 || h < 6;
    robot.dataset.nightcap = idleAsleep() && late ? '1' : '';
    robot.dataset.lateNight = state.awake && late ? '1' : '';
  }

  // ---- wandering off
  // Now and then it gets up and goes for a walk round the screen (asleep, it
  // sleepwalks), in a little window of its own; the desk stands empty with a BRB
  // note. To use it again, drag it back onto its desk (main.js / walker.js dock it).
  const wanders = () => state.character?.wanders !== false; // the Workshop's "Wanders off"
  const AWAY_NOTE = '🚶 Out for a walk: drag me back to my desk!';

  function leaveDesk() {
    if (state.away || state.busy || helpersOut() || state.mirroring || state.peek) return;
    if (state.hosting && !state.visiting) return; // (a visitor's at its desk: it stays put)
    stopAntic();
    if (state.awake) collapse(); // the chat tucks away: it can't chat from out there
    antic('stepout');
    // the walker window loads (hidden) while it gets up...
    state.leaving = true;
    ipc.robotWanderPrep({ asleep: !state.awake });
    // ...and once it's up and turned, takes over with its feet on this very spot ('handoff'
    // below) and walks it off from there
    cue(0.7, () => {
      ipc.robotWander({ asleep: !state.awake, feet: office.feetPosition() }).then((ok) => ok || stopAntic());
    });
    cue(3.8, () => state.away || stopAntic()); // (no walker came: it sits back down)
  }

  // the walker window has it now: the desk lets go of its own
  function goneWalking() {
    if (state.away) return;
    state.leaving = false;
    state.away = true;
    robot.dataset.away = '1';
    // (its status strip: out to lunch, visiting, or just out for a walk)
    const v = state.visiting;
    state.news = state.awayNews = v?.mode === 'lunch' ? `🍜 Out for lunch with ${v.host}` : v ? `🚶 Visiting ${v.host}` : AWAY_NOTE;
    renderWorking();
  }

  // dropped back on the desk (or called back from the tray): it hops into its chair
  function backToDesk({ quiet = false, feet = null }: { quiet?: boolean; feet?: Point | null } = {}) {
    if (!state.away) return;
    state.away = false;
    awayNote.classList.remove('show');
    robot.dataset.away = '';
    body.classList.remove('dock-target');
    if (state.news === AWAY_NOTE || state.news === state.awayNews) state.news = '';
    renderWorking();
    state.lastActivity = Date.now();
    if (quiet) return;
    // it stands where it was put down (if that's on the desk's floor), then goes to its chair
    const at = feet && office.floorAt(feet.x, feet.y);
    antic('stepin', at ? `${at.x.toFixed(3)},${at.z.toFixed(3)}` : '');
    // once it's drawn here, the walker window can go (no blink in between)
    requestAnimationFrame(() => requestAnimationFrame(() => ipc.robotWalker('docked')));
    cue(1.0, () => Sfx.boing());
    if (state.awake) {
      cue(1.1, () => {
        express('happy', 'smile', 1400);
        showPop(quip('back') || "I'm back!", 1800);
      });
    }
  }

  // ---- the group chat's meeting room (main groupChat.js / meeting.js)
  // It gets up from its chair and leaves (it rolls into the meeting room's window there); the
  // desk stands empty, drawn only now and then (office3d: data-meeting). When the chat's over
  // it's straight back in its chair, ready for work.
  const MEETING_NOTE = '👥 In the meeting room (group chat)';
  function toMeeting(tries = 0) {
    if (state.meeting) return;
    // (out for a walk: main's calling it back first)
    if (state.away || state.leaving) return void (tries < 24 && setTimeout(() => toMeeting(tries + 1), 500));
    state.meeting = true;
    stopAntic();
    const leave = () => {
      if (!state.meeting) return;
      stopAntic();
      state.away = true;
      robot.dataset.away = '1';
      robot.dataset.meeting = '1';
      state.news = state.awayNews = MEETING_NOTE;
      renderWorking();
    };
    // up out of the chair and turned to go, then gone (straight away if it's in the middle of work)
    if (state.busy || helpersOut() || state.mirroring) return leave();
    antic('stepout');
    setTimeout(leave, 900);
  }
  function fromMeeting() {
    if (!state.meeting) return;
    state.meeting = false;
    robot.dataset.meeting = '';
    stopAntic(); // (still getting up)
    if (state.away) {
      state.away = false;
      robot.dataset.away = '';
      awayNote.classList.remove('show');
      if (state.news === MEETING_NOTE) state.news = '';
      renderWorking();
    }
    state.lastActivity = Date.now();
  }

  // the empty desk was clicked: it waves from wherever it is
  const awayNote = $('#away-note');
  function awayClick() {
    const name = state.character?.name || 'Your robot';
    if (!state.meeting) ipc.robotWalker('wave');
    awayNote.textContent = state.meeting
      ? `👥 ${name} is in the meeting room for the group chat. It's back at its desk as soon as the chat ends.`
      : state.visiting?.mode === 'lunch'
      ? `🍜 ${name} is out for lunch with ${state.visiting.host}. Click ${name} to call it back, or drag it here.`
      : state.visiting
      ? `🚶 ${name} is visiting ${state.visiting.host}. Click ${name} to call it back, or drag it here.`
      : `🚶 ${name} is out for a walk. Drag ${name} back onto this desk to use it again.`;
    awayNote.classList.add('show');
    clearTimeout(awayClick.t);
    awayClick.t = setTimeout(() => awayNote.classList.remove('show'), 3200);
  }
  awayClick.t = 0;

  // Office-calendar gags: what the clock makes more likely right now
  function calendarWeights() {
    const now = new Date();
    const day = now.getDay();
    const h = now.getHours();
    return {
      friday: day === 5 && h >= 15 ? 2.5 : 0, // no deploys on a Friday afternoon
      monday: day === 1 && h < 12 ? 2 : 0, // Monday morning: coffee on a drip
      noodles: h === 12 ? 2.5 : 0, // lunch at the desk
      payday: now.getDate() === 25 ? 1.5 : 0,
    };
  }
  // and once an hour, in its first ten minutes, a stretch and a 20-20-20 eye break
  let eyeBreakHour = '';
  function eyeBreakDue() {
    const now = new Date();
    const key = `${now.toDateString()} ${now.getHours()}`;
    if (now.getMinutes() >= 10 || key === eyeBreakHour) return false;
    eyeBreakHour = key;
    return true;
  }

  // Double-clicking the monitor crashes the computer, and it knows it was you
  function crashMonitor() {
    if (!idleAwake()) return poke();
    stopAntic();
    antic('bsod');
    Sfx.key.crash();
    express('open', 'wide', 1100);
    cue(1.2, () => {
      express('flat', 'flat', 2800);
      showPop(quip('bsod') || 'You did this.', 2400);
    });
  }

  // Leaning back, hands behind its head… until your mouse comes near, when it
  // spins round to the monitor and types furiously, as if it was working all along.
  function slack() {
    const { dx, dy } = state.lastCursor;
    if (Math.hypot(dx, dy) < 260) return; // you're right there; it wouldn't dare
    strikePose('slack', 9000);
    state.slacking = Date.now() + 9000;
    anticUntil = state.slacking;
    lastAntic = 'slack';
  }
  function busted() {
    state.slacking = 0;
    state.pose = null;
    robot.dataset.hurry = '1';
    setActivity('edit', 2200);
    express('open', 'o', 2200);
    showPop(pick(quip('busted') || ['Working!']), 2000);
    setTimeout(() => {
      if (![...tabs.values()].some((t) => t.hurried)) robot.dataset.hurry = '';
    }, 2200);
  }

  // Awake and idle. The longer you leave it, the more it gets up to: first a
  // few small fidgets, then the bigger bits, then sighing, drumming and waving at you.
  function awakeAntic(boredFor: number) {
    const sec = boredFor / 1000;
    const crit = CRITTER_ANTICS[robot.dataset.body!] || []; // (its body: set with the robot)
    const name = pickAntic({
      look: 3, wave: 1.2, hop: 1, spin: 1, stretch: 1, smile: 1,
      sip: 2.2, 'sip-empty': 0.6, hum: 1.5, lamp: 0.4, tip: 1, milktea: 1.6, dumbbell: 1.2, phone: 1.3,
      pushup: sec > 20 ? 0.9 : 0, // gets down on the floor for a set of push-ups
      sneeze: sec > 30 ? 0.9 : 0, toss: sec > 30 ? 0.9 : 0, 'toss-hit': sec > 30 ? 0.35 : 0,
      dvd: sec > 40 ? 0.7 : 0, 'dvd-lucky': sec > 40 ? 0.15 : 0, slack: sec > 40 ? 0.9 : 0,
      feed: sec > 15 ? 1.3 : 0, // swivels round to the monitor and scrolls a social feed
      standdesk: sec > 20 ? 0.8 : 0, // presses the desk's ▲ and works standing up for a bit
      talk: sec > 25 ? 1.4 : 0, critter: crit.length ? 2 : 0,
      slump: sec > 90 ? 1.5 : 0, drum: sec > 90 ? 1.5 : 0, attention: sec > 120 ? 1.2 : 0,
      // IT office life
      duck: 1, stackoverflow: 0.9, cable: 0.6, crumbs: 0.6, 'crumbs-cookie': 0.25, jira: 0.8, works: 0.8,
      reboot: sec > 20 ? 0.8 : 0, merge: sec > 30 ? 0.7 : 0, jitter: sec > 30 ? 0.6 : 0, standup: sec > 40 ? 0.6 : 0,
      ...calendarWeights(),
      // bored for three minutes: off for a walk round the screen (not with its chat open: you may
      // be reading it, and walking off would tuck it away. Right-click → Go for a walk still works)
      wander: wanders() && sec > 180 && state.collapsed ? 1.5 : 0,
      'word-glance': sight.length ? 2 : 0, // one of your English words up on its monitor, read out
      boardglance: board.total ? 1.2 : 0, // a look over at the corkboard, a pin straightened, a look at you
      notestress: board.total >= 8 ? 0.8 : 0, // so… many… notes…
      dance: 0.7, highfive: 0.9, // a little dance party, or a high-five up at you
    });
    lastAntic = name;
    if (name === 'word-glance') return wordGlance();
    switch (name) {
      case 'dance':
      case 'highfive':
        playWith(name, { byUser: false });
        anticUntil = Date.now() + PLAY_MS[name];
        break;
      case 'boardglance':
        antic(name);
        cue(1.2, () => Sfx.tool());
        cue(1.6, () => {
          express('open', 'flat', 900);
          if (Math.random() < 0.5) showPop(quip('notesNudge') || 'Psst… your notes!', 1600);
        });
        break;
      case 'notestress':
        // a full board weighs on it
        antic('slump');
        express('dizzy', 'flat', 2200);
        cue(0.9, () => showPop(quip('notesStress') || 'So… many… notes…', 1800));
        break;
      case 'look':
        lookAt(rand(-300, 300), rand(-100, 100), 1100);
        setTimeout(() => lookAt(rand(-300, 300), rand(-100, 100), 900), 1100);
        break;
      case 'wave':
        strikePose('wave', 1500);
        break;
      case 'hop':
        flash('hop', 600);
        break;
      case 'spin':
        // spin around in the office chair
        flash('spin', 950);
        Sfx.whee();
        break;
      case 'stretch':
        // big stretch and a yawn
        strikePose('cheer', 1300);
        express('closed', 'o', 1300);
        break;
      case 'smile':
        express('happy', 'smile', 1200);
        break;
      case 'talk':
        // thinking out loud
        showPop(fill(pick(persona().bored || ['…'])), 2600);
        express('open', 'talk', 1200);
        break;
      case 'slack':
        slack();
        break;
      case 'attention':
        strikePose('wave', 2000);
        express('happy', 'wide', 2000);
        showPop(quip('attention') || 'Hey!', 2200);
        break;
      case 'critter': {
        const c = pick(crit);
        antic(c);
        if (c === 'robot-antenna') cue(0.6, () => Sfx.boing());
        if (c === 'robot-defrag') express('dizzy', 'flat', 1800);
        break;
      }
      case 'pushup':
        // timings match office3d/antics/pushup.js: hop down 0.45, reps from 1.3 every 1.1 s, hop back 8.9
        antic(name);
        cue(0.45, () => Sfx.boing());
        [1.3, 2.4, 3.5, 4.6, 5.7].forEach((at, i) => cue(at + (i === 4 ? 0.8 : 0.45), () => Sfx.grunt()));
        cue(5.7, () => express('flat', 'flat', 1600)); // the last one's a struggle
        cue(8.9, () => Sfx.boing());
        cue(9.1, () => {
          express('happy', 'wide', 1400);
          showPop(quip('flex') || 'Feel the burn! 💪', 1600);
        });
        break;
      case 'phone':
        // doom scrolling; timings match office3d/antics/phone.js
        antic(name);
        cue(0.4, () => Sfx.pop());
        for (let at = 0.9; at < 6; at += 0.8) cue(at, () => Sfx.tool()); // thumb flicks
        cue(3.4, () => {
          Sfx.giggle();
          express('happy', 'wide', 1300);
        });
        cue(6.3, () => Sfx.pop());
        break;
      case 'dumbbell':
        // three curls, the last a struggle, then a flex; timings match the antic in office3d/antics/awake.js
        antic(name);
        cue(0.15, () => Sfx.pop());
        cue(1.0, () => showPop('1!', 600));
        cue(1.8, () => showPop('2!', 600));
        cue(2.4, () => {
          express('closed', 'flat', 600);
          Sfx.grunt();
        });
        cue(2.9, () => {
          express('happy', 'wide', 700);
          showPop('…3!!', 700);
        });
        cue(4.0, () => {
          Sfx.done();
          express('happy', 'smile', 1300);
          showPop(quip('flex') || 'Gains!', 1500);
        });
        break;
      case 'feed':
        // scrolling a feed on the monitor; timings match office3d/feeds.js
        antic(name, pick(['facebook', 'tiktok', 'youtube']));
        cue(0.6, () => express('open', 'flat', 4000)); // the glazed scrolling stare
        for (const at of [1.0, 2.0, 3.0, 4.0, 7.0, 8.0]) cue(at, () => Sfx.wheel());
        cue(4.8, () => {
          Sfx.giggle();
          express('happy', 'wide', 1400);
        });
        cue(6.2, () => {
          Sfx.pop();
          express('happy', 'smile', 1200);
        });
        cue(7.4, () => express('open', 'flat', 1800));
        break;
      case 'milktea':
        drinkMilkTea();
        break;
      case 'standdesk':
        // timings match the antic in office3d/antics/awake.js
        antic(name);
        cue(1.5, () => Sfx.beep());
        cue(1.6, () => Sfx.motor(true));
        cue(4.6, () => express('flat', 'o', 900)); // hm, too low now
        cue(5.6, () => Sfx.hiss());
        cue(8.6, () => express('happy', 'smile', 1800));
        cue(16.3, () => Sfx.beep());
        cue(16.4, () => Sfx.motor(false));
        break;
      case 'sip-empty':
        antic(name);
        cue(1.6, () => {
          express('flat', 'flat', 1300);
          showPop(quip('empty') || '…', 1600);
        });
        break;
      case 'tip':
        antic(name);
        cue(1.5, () => {
          Sfx.oops();
          express('open', 'wide', 600);
        });
        cue(2.2, () => showPop(quip('tip') || '…', 1500));
        break;
      case 'toss':
      case 'toss-hit':
        antic(name);
        cue(1.9, () => {
          if (name === 'toss-hit') {
            Sfx.done();
            express('happy', 'wide', 1000);
            showPop(quip('score') || '!', 1400);
          } else {
            express('flat', 'flat', 1000);
            showPop(quip('miss') || '…', 1400);
          }
        });
        break;
      case 'hum':
        antic(name);
        express('happy', 'o', 4300);
        Sfx.hum();
        cue(2.2, () => Sfx.hum());
        break;
      case 'sneeze':
        antic(name);
        cue(0.2, () => express('closed', 'o', 700));
        cue(0.9, () => {
          Sfx.sneeze();
          express('closed', 'wide', 500);
          showPop(quip('sneeze') || 'Achoo!', 1100);
        });
        break;
      case 'lamp':
        antic(name);
        for (const at of [1.0, 1.3, 1.5, 1.9]) cue(at, () => Sfx.tool());
        break;
      case 'slump':
        antic(name);
        express('flat', 'flat', 2600);
        break;
      case 'duck':
        // rubber duck debugging: explains, the duck squeaks, OH!
        antic(name);
        cue(0.3, () => Sfx.pop());
        cue(0.8, () => {
          express('open', 'talk', 2600);
          showPop(quip('duck') || '…', 2400);
        });
        cue(3.8, () => Sfx.squeak());
        cue(4.3, () => {
          Sfx.done();
          express('happy', 'wide', 1200);
          showPop(quip('oh') || 'OH!', 1500);
        });
        break;
      case 'reboot':
        // the screen freezes: glare, tap tap, power off and on again
        antic(name);
        cue(0.3, () => express('flat', 'flat', 1600));
        for (const at of [1.4, 1.7, 3.0]) cue(at, () => Sfx.tool());
        cue(3.6, () => Sfx.wake());
        cue(5.8, () => {
          express('happy', 'smile', 1100);
          showPop(quip('reboot') || 'Fixed!', 1300);
        });
        break;
      case 'stackoverflow':
        antic(name);
        for (const at of [1.8, 2.9]) cue(at, () => Sfx.thunk());
        cue(3.6, () => express('open', 'flat', 1200));
        cue(3.8, () => showPop(quip('so') || '…', 1300));
        break;
      case 'cable':
        antic(name);
        for (const at of [1.2, 1.6]) cue(at, () => Sfx.tool());
        cue(2.2, () => {
          Sfx.thunk();
          express('open', 'wide', 1500);
        });
        cue(2.9, () => showPop(quip('cable') || 'Oops.', 1500));
        break;
      case 'crumbs':
      case 'crumbs-cookie':
        antic(name);
        cue(1.2, () => Sfx.rattle());
        if (name === 'crumbs-cookie') {
          cue(2.7, () => {
            Sfx.ooh();
            express('happy', 'wide', 1300);
            showPop(quip('cookie') || '!', 1500);
          });
        }
        break;
      case 'merge':
        antic(name);
        cue(1.2, () => {
          express('dizzy', 'flat', 1800);
          showPop(quip('merge') || '?!', 1700);
        });
        cue(3.2, () => express('closed', 'smile', 2400));
        cue(3.4, () => showPop((quip('breathe') || [])[0] || '…', 1100));
        cue(4.6, () => showPop((quip('breathe') || [])[1] || '…', 1100));
        break;
      case 'standup': {
        // the daily stand-up, standing on its chair
        antic(name);
        const lines = quip('standup') || ['Yesterday: stuff.', 'Today: more stuff.', 'Blockers: you.'];
        lines.forEach((line, i) => cue(1.0 + i * 1.8, () => {
          express('open', 'talk', 1500);
          showPop(line, 1700);
        }));
        break;
      }
      case 'jira':
        // (with notes of your own, it juggles those)
        antic(name, board.items.slice(0, 3).map((n) => n.text).join('|'));
        cue(4.0, () => {
          Sfx.oops();
          express('closed', 'flat', 1000);
        });
        cue(5.4, () => showPop(quip('jira') || '…', 1400));
        break;
      case 'works':
        antic(name);
        cue(0.3, () => {
          express('happy', 'smile', 1500);
          showPop(quip('works') || 'Works on my machine!', 1700);
        });
        cue(1.8, () => Sfx.thunk());
        cue(2.5, () => express('happy', 'smile', 1800));
        break;
      case 'jitter':
        // three coffees in a row, then warp-speed typing
        antic(name);
        for (const at of [0.8, 1.5, 2.2]) cue(at, () => Sfx.slurp());
        cue(2.4, () => express('open', 'wide', 3800));
        cue(2.6, () => showPop(quip('jitter') || '!!!', 1500));
        break;
      case 'friday':
        antic(name);
        express('flat', 'flat', 4000);
        cue(0.5, () => showPop(quip('friday') || 'No deploys on Friday!', 2600));
        break;
      case 'monday':
        antic(name);
        express('flat', 'flat', 5600);
        cue(1.0, () => showPop(quip('monday') || '…coffee.', 2000));
        break;
      case 'noodles':
        eatNoodles();
        break;
      case 'payday':
        antic(name);
        cue(0.3, () => {
          Sfx.kaching();
          express('happy', 'wide', 2400);
        });
        cue(4.2, () => {
          express('flat', 'flat', 1600);
          showPop(quip('payday') || '…', 1600);
        });
        break;
      case 'wander':
        leaveDesk();
        break;
      case 'dvd-lucky':
        antic(name);
        cue(6.0, () => {
          Sfx.done();
          express('happy', 'wide', 1500);
          showPop(quip('corner') || '!', 1800);
        });
        break;
      default:
        if (name) antic(name);
    }
  }

  // Asleep: now and then a snot bubble, some sleep-talk, a dream, a big snore…
  // one of the words you're learning on its monitor; it reads it out (antics/vocab.js word-glance)
  function wordGlance() {
    const x = sightWord();
    if (!x) return;
    antic('word-glance', `${x.word}|${shortVi(x.vi)}|${x.phrase || ''}`);
    cue(3.4, () => {
      express('happy', 'talk', 1600);
      showPop(`${x.word}… ${shortVi(x.vi)}`, 2800);
    });
  }

  function asleepAntic() {
    // on the floor there's no chair or keyboard to sleep-type at, slide down or drift round on
    const chair = robot.dataset.sleepStyle !== 'floor' ? 0.8 : 0;
    // ...nor an eye mask to slide up for a sneaky scroll on the phone
    const name = pickAntic({ bubble: 1.2, mumble: 1.2, dream: 1.2, sleeptype: chair, slide: chair, snore: 1.3, drift: chair, drool: 0.7, sleepphone: chair && 1.0,
      nightmare: 0.9, snorebar: 1, ping: 0.9, vacuum: 0.8, burrito: chair ? 0 : 1.2, // the burrito needs the blanket on the floor
      sleepwalk: wanders() ? 0.6 : 0 });
    if (name === 'sleepwalk') return leaveDesk();
    if (name === 'sleepphone') {
      // mask up, eyes open, scroll a bit, mask down, eyes shut (office3d/antics/phone.js)
      antic(name);
      cue(0.5, () => express('open', 'flat', 6800));
      cue(0.6, () => Sfx.pop());
      for (let at = 1.1; at < 6.6; at += 0.9) cue(at, () => Sfx.tool());
      cue(6.8, () => Sfx.pop());
      return;
    }
    if (name === 'mumble') {
      const x = Math.random() < 0.5 ? sightWord() : null; // half the time, one of your words
      antic(name, x ? `…${x.word}… ${shortVi(x.vi)}…` : fill(pick(persona().sleeptalk || ['…mm…'])));
      cue(0.3, () => express('closed', 'talk', 3000));
    }
    else if (name === 'dream') {
      // a third of the time it dreams of one of your words (on its monitor), and mumbles it
      const x = sight.length && Math.random() < 0.35 ? sightWord() : null;
      antic(name, x ? x.word : pick(DREAMS[robot.dataset.body!] || ['⭐', '🍰', '🌈']));
      if (x) cue(2.5, () => express('closed', 'talk', 1500));
    }
    else if (name === 'bubble') {
      antic(name, pick(['huh?', 'wha—?', 'mm? huh?']));
      cue(4.4, () => Sfx.pop());
      cue(4.5, () => express('open', 'talk', 700));
    } else if (name && name !== 'nightmare' && name !== 'ping') antic(name); // those two come with words, below
    if (name === 'slide') cue(5.4, () => Sfx.oops());
    // more sleep (office3d/antics/sleepy.js and night.js)
    if (name === 'nightmare') {
      antic(name, quip('justdream') || '…just a dream.');
      cue(0.4, () => express('closed', 'flat', 2100));
      cue(2.6, () => {
        Sfx.gasp();
        express('open', 'wide', 1600);
      });
      cue(4.2, () => express('open', 'talk', 1300));
    } else if (name === 'snorebar') {
      for (const at of [0.6, 2.4, 4.2, 6.0]) cue(at, () => Sfx.snore());
      cue(6.2, () => Sfx.tick());
    } else if (name === 'ping') {
      antic(name, pick(PINGS));
      for (const at of [0.3, 0.9, 1.5]) cue(at, () => Sfx.buzz());
      cue(2.8, () => Sfx.thunk());
    } else if (name === 'vacuum') {
      for (const at of [0.3, 4.0]) cue(at, () => Sfx.vacuum());
      for (const at of [2.0, 2.8, 3.6]) cue(at, () => Sfx.tool());
    } else if (name === 'burrito') {
      cue(0.5, () => Sfx.swish());
      cue(4.0, () => Sfx.snore());
    }
    if (name === 'snore') cue(0.6, () => Sfx.snore());
  }

  function antics() {
    const boredFor = Date.now() - state.lastActivity;
    nightcap();
    if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && eyeBreakDue()) {
      antic('eyebreak');
      cue(0.3, () => express('closed', 'o', 1400));
      cue(2.2, () => showPop(quip('eyebreak') || '20-20-20!', 2000));
    } else if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && Math.random() < 0.9) awakeAntic(boredFor);
    // (never while its chat is open: you may be reading it, or about to type)
    if (state.awake && state.collapsed && !state.busy && !helpersOut() && !state.mirroring && !input.value && boredFor > AUTO_SLEEP_MS) {
      stopAntic();
      showPop(pick(persona().sleepy), 1500);
      express('closed', 'o', 1500);
      setTimeout(() => sleep({ auto: true }), 1400);
    }
    setTimeout(antics, rand(7000, 14000));
  }

  // once every 30–60 s while it sleeps, so it stays calm on your desktop
  function dozeLoop() {
    nightcap();
    if (idleAsleep() && Date.now() > anticUntil) asleepAntic();
    setTimeout(dozeLoop, rand(30000, 60000));
  }

  // ------------------------------------------------------------ chat size and click-through

  // The chat panel's size: drag its outer edge for the width (the window grows or shrinks), its
  // free end for the height, or the corner between them for both; double-click one to reset it.
  // The height: shorter than the screen if you like (down to CHAT_H_MIN), remembered per
  // robot. The window stays the height of the screen (the rest lets clicks through), so this is
  // just the page: the panel hangs from the top with the robot up there, else stands on the bottom,
  // and its free edge is the one you drag. Double-click: the whole height again.
  const CHAT_H_MIN = 320;
  let chatH: number | null = null; // (null: the height of the screen)
  let winH = innerHeight; // (the window's height in the last layout: it's resized just after)
  const fullH = () => winH - 22; // (8 px above, 14 below, as #panel sits)
  function placePanel() {
    if (staged) return; // (on the stage the chat fills its tile: robot:layout)
    const root = document.documentElement.style;
    const h = chatH == null ? fullH() : Math.max(Math.min(CHAT_H_MIN, fullH()), Math.min(chatH, fullH()));
    const fromTop = state.robotY + (ROBOT_H * (state.scale || 1)) / 2 < winH / 2;
    const top = fromTop ? 8 : winH - 14 - h;
    root.setProperty('--panel-top', `${top}px`);
    root.setProperty('--panel-bottom', `${winH - top - h}px`);
    body.classList.toggle('chat-from-top', fromTop);
    body.classList.toggle('chat-short', h < fullH() - 2);
    // the tail points at the robot's head (kept on the panel's straight edge)
    const headY = state.robotY + office.headPosition().y - top;
    root.setProperty('--tail-y', `${Math.round(Math.min(Math.max(headY, 40), h - 70))}px`);
  }
  function sizeGrip(grip: HTMLElement, width: boolean, height: boolean) {
    const way = width && height ? 'd' : width ? 'h' : 'v';
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const [startX, startY] = [e.screenX, e.screenY];
      const startH = $('#panel').getBoundingClientRect().height;
      const fromTop = body.classList.contains('chat-from-top');
      let raf = 0;
      body.classList.add('resizing', `resizing-${way}`);
      if (width) ipc.robotResize({ phase: 'start' });
      const move = (ev: PointerEvent) => {
        if (height) {
          const dy = ev.screenY - startY;
          chatH = Math.round(Math.max(CHAT_H_MIN, Math.min(fullH(), startH + (fromTop ? dy : -dy))));
          placePanel();
        }
        if (!width) return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => ipc.robotResize({ phase: 'move', dx: ev.screenX - startX }));
      };
      let ended = false;
      // (let go, or the drag taken away: another window grabbed the mouse)
      const end = () => {
        if (ended) return;
        ended = true;
        cancelAnimationFrame(raf);
        grip.removeEventListener('pointermove', move);
        for (const k of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.removeEventListener(k, end);
        body.classList.remove('resizing', `resizing-${way}`);
        if (width) ipc.robotResize({ phase: 'end' });
        if (height) {
          if (chatH != null && chatH >= fullH() - 2) chatH = null; // (all the way: the height of the screen, whatever screen)
          ipc.robotChatHeight(chatH);
        }
        scrollDown();
      };
      grip.addEventListener('pointermove', move);
      for (const k of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(k, end);
    });
    grip.addEventListener('dblclick', () => {
      if (width) ipc.robotResize({ phase: 'reset' });
      if (!height) return;
      chatH = null;
      placePanel();
      ipc.robotChatHeight(null);
    });
  }
  sizeGrip($('#panel .resize-grip'), true, false);
  sizeGrip($('#panel .resize-grip-v'), false, true);
  sizeGrip($('#panel .resize-grip-d'), true, true);

  // The awake window is the height of the screen and mostly see-through: let
  // clicks on the see-through parts through to whatever is behind it.
  let clickThrough = false;
  function setClickThrough(on: boolean) {
    if (on === clickThrough) return;
    clickThrough = on;
    ipc.robotClickThrough(on);
  }
  document.addEventListener('mousemove', (e) => {
    const roomy = body.classList.contains('expanded') || state.placement.startsWith('tuck'); // windows with see-through parts
    if (!roomy || body.classList.contains('resizing') || body.classList.contains('dragging')) return setClickThrough(false);
    setClickThrough(e.target === document.body || e.target === document.documentElement);
  });

  // ------------------------------------------------------------ the stage (app/src/stage.rs)

  // On the stage its window is a tile of a grid over the screen: the chat fills it (inset a
  // few px, so the gap between two chats is half each window's), the robot hides and its face
  // goes in the title bar. Drag a gap and main shares the room out again; drag the title bar
  // onto another tile and they change places. In the spotlight it's big, the others strips
  // beside it (just the latest of their chat: click one to bring it to the spotlight).
  let staged = false;
  const edges = [...document.querySelectorAll<HTMLElement>('.stage-edge')];
  function setStaged(tile: StageTileInfo | null, inset: number) {
    staged = !!tile;
    body.classList.toggle('staged', staged);
    body.classList.toggle('stage-spot', !!tile?.spot);
    body.classList.toggle('stage-strip', !!tile?.strip);
    if (!tile) body.classList.remove('stage-target');
    const root = document.documentElement.style;
    root.setProperty('--stage-inset', `${inset}px`);
    if (staged) {
      root.setProperty('--panel-top', `${inset}px`);
      root.setProperty('--panel-bottom', `${inset}px`);
    }
    for (const e of edges) {
      const split = tile?.edges?.[e.dataset.side as 'left'] ?? '';
      e.dataset.split = split;
      e.hidden = !split;
    }
  }
  for (const edge of edges) {
    const across = edge.dataset.side === 'left' || edge.dataset.side === 'right';
    edge.addEventListener('pointerdown', (e) => {
      const split = edge.dataset.split;
      if (e.button !== 0 || !split) return;
      e.preventDefault();
      edge.setPointerCapture(e.pointerId);
      const start = across ? e.screenX : e.screenY;
      body.classList.add('resizing');
      if (!across) body.classList.add('resizing-v');
      ipc.stageSplit({ phase: 'start', split });
      const move = (ev: PointerEvent) => ipc.stageSplit({ phase: 'move', split, d: (across ? ev.screenX : ev.screenY) - start });
      const end = () => {
        edge.removeEventListener('pointermove', move);
        body.classList.remove('resizing', 'resizing-v');
        ipc.stageSplit({ phase: 'end', split });
        scrollDown();
      };
      edge.addEventListener('pointermove', move);
      edge.addEventListener('pointerup', end, { once: true });
      edge.addEventListener('pointercancel', end, { once: true });
    });
    edge.addEventListener('dblclick', () => {
      if (edge.dataset.split) ipc.stageSplit({ phase: 'even', split: edge.dataset.split });
    });
  }
  $('#btn-spot').addEventListener('click', () => ipc.stageTile('spot'));
  $('#btn-unstage').addEventListener('click', () => ipc.stageTile('leave'));
  // its title bar: drag it onto another tile to change places; double-click: the spotlight
  const header = $('#panel > header');
  const onButton = (e: Event) => !!(e.target as HTMLElement).closest('button');
  header.addEventListener('pointerdown', (e) => {
    if (!staged || e.button !== 0 || onButton(e)) return;
    header.setPointerCapture(e.pointerId);
    const from = { x: e.screenX, y: e.screenY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.screenX - from.x, ev.screenY - from.y) < 6) return;
      if (!moved) {
        moved = true;
        body.classList.add('swapping');
        ipc.stageSwap('start');
      }
      ipc.stageSwap('move');
    };
    const end = () => {
      header.removeEventListener('pointermove', move);
      body.classList.remove('swapping');
      if (moved) ipc.stageSwap('end');
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end, { once: true });
    header.addEventListener('pointercancel', end, { once: true });
  });
  header.addEventListener('dblclick', (e) => {
    if (staged && !onButton(e)) ipc.stageTile('spot');
  });
  // a strip beside the spotlight: a click brings it there
  $('#panel').addEventListener('click', (e) => {
    if (body.classList.contains('stage-strip') && !onButton(e)) ipc.stageTile('spot');
  });

  // Sent to everyone on the stage: asked in its active tab as if typed there (waiting its
  // turn if it's busy), tagged with who else got it. What you'd typed here stays put.
  function askFromStage(a: Extract<StageEvent, { kind: 'ask' }>, files: FileInfo[]) {
    if (state.away) return;
    if (!state.awake) wake({ sayHi: false });
    const tab = active();
    if (!tab) return;
    const draft = { text: input.value, files: state.attachments };
    const tag = a.all ? `📣 to everyone on stage (${a.to.length})` : `📣 to ${a.to.join(', ')}`;
    input.value = a.prompt;
    state.attachments = files;
    // (both put the message in the chat straight away, then wait for main)
    if (tab.busy) queueQuestion(tab, a.prompt, tag);
    else submit({ again: true, tag });
    input.value = draft.text;
    state.attachments = draft.files;
    renderAttachments();
    autosize();
  }

  ipc.on('robot:stage', async (ev) => {
    if (ev.kind === 'pick') {
      const pickEl = $('#stage-pick');
      pickEl.hidden = ev.n == null;
      pickEl.textContent = ev.n == null ? '' : String(ev.n);
      body.classList.toggle('stage-picked', ev.n != null);
    } else if (ev.kind === 'target') {
      body.classList.toggle('stage-target', ev.on);
    } else if (ev.kind === 'ask') {
      const files = ev.paths.length ? await ipc.robotInspectPaths(ev.paths) : [];
      askFromStage(ev, files);
    }
  });

  // ------------------------------------------------------------ main-process events

  ipc.on('robot:layout', (l) => {
    const root = document.documentElement.style;
    state.placement = l.placement;
    state.robotX = l.robotX;
    state.robotY = l.robotY;
    root.setProperty('--robot-x', `${l.robotX}px`);
    root.setProperty('--robot-y', `${l.robotY}px`);
    setStaged(l.placement === 'stage' ? (l.stage ?? {}) : null, l.inset ?? 4);
    if (l.panel && staged) {
      root.setProperty('--panel-x', `${l.panel.x}px`);
      root.setProperty('--panel-w', `${l.panel.w}px`);
      winH = l.bounds.height;
    } else if (l.panel) {
      root.setProperty('--panel-x', `${l.panel.x}px`);
      root.setProperty('--panel-w', `${l.panel.w}px`);
      winH = l.bounds.height;
      placePanel(); // (its height, and the tail at the robot's head)
    }
    sides.layout(l); // (the side panel open: it shares the panel's room)
    body.classList.toggle('expanded', l.expanded);
    body.classList.toggle('side-left', l.placement === 'left');
    body.classList.toggle('side-right', l.placement === 'right');
    body.classList.toggle('room-above', l.robotY > 60);
    body.classList.toggle('tuck-above', l.placement === 'tuck-above');
    body.classList.toggle('tuck-below', l.placement === 'tuck-below');
    body.classList.toggle('tuck-left', l.side === 'left'); // (which side the chat opens on: the strip lines up with the robot on that side)
    if (l.placement === 'none' || l.placement === 'hidden') setClickThrough(false);
    if (l.expanded) scrollDown();
    laidOut(l);
  });
  // Once this layout is on screen at the window's new size (main keeps the window see-through
  // meanwhile, so the old picture never shows at the new place), replay the panel's pop-in.
  // The resize lands just after this message: wait for it, then a few frames for the page to
  // be redrawn (a timer, not requestAnimationFrame, which can stall while it's see-through).
  const DRAW_WAIT = 50;
  function laidOut(l: Layout) {
    if (!l.masked) return;
    const sized = () => Math.abs(innerWidth - l.bounds.width) <= 2 && Math.abs(innerHeight - l.bounds.height) <= 2; // (Windows may round)
    const drawn = () =>
      setTimeout(() => {
        // the panel's pop-in played while the window was hidden: play it now it shows
        if (l.expanded) {
          const panel = $('#panel');
          panel.style.animation = 'none';
          void panel.offsetWidth;
          panel.style.animation = '';
        }
      }, DRAW_WAIT);
    if (sized()) return drawn();
    const onResize = () => {
      if (!sized()) return;
      removeEventListener('resize', onResize);
      drawn();
    };
    addEventListener('resize', onResize);
    setTimeout(() => removeEventListener('resize', onResize), 400); // (main shows it anyway by then)
  }

  // cursor position arrives relative to the robot box; aim from the robot's head
  ipc.on('robot:cursor', (c) => {
    if (state.peek) return;
    const head = office.headPosition();
    state.lastCursor = { dx: c.x - head.x, dy: c.y - head.y };
    look();
    propCursor(c);
    if ((state.slacking ?? 0) > Date.now() && Math.hypot(state.lastCursor.dx, state.lastCursor.dy) < 200) busted();
  });

  ipc.on('robot:event', onEvent);

  ipc.on('robot:character', (c) => {
    applyCharacter(c);
    syncTabs(c);
  });

  // the Sounds setting: essential / all / off (off keeps the word-reading voice quiet too)
  let muted = false;
  function setSounds(s: Settings) {
    muted = s.sounds === 'off';
    Sfx.setLevel(s.sounds);
  }
  ipc.on('robot:settings', (s) => {
    setSounds(s);
    islandButton(s);
  });
  // the 🏝️ button: to sleep instead while the island's turned off
  let islandOn = true;
  function islandButton(s: Settings) {
    islandOn = s.island !== false;
    const b = $('#btn-island');
    b.title = islandOn ? 'Send to island' : 'Sleep (Esc)';
    b.dataset.tip = b.title;
    b.innerHTML = Icon(islandOn ? 'island' : 'moon');
  }
  // you're presenting or in a full-screen app: only a question for you still dings (main)
  ipc.on('robot:hush', (on) => Sfx.setHush(on));

  // ------------------------------------------------------------ English words (main/vocab.js)

  // You select a word anywhere and press the hotkey: the robot nearest the mouse
  // catches it, leafs through its dictionary while Claude looks it up (the word
  // card beside it shows the word meanwhile), then says the word, holds up a
  // flash card of it and pops it into the word box on its desk.
  const wordOf = (w?: VocabWord | null) => w?.word || w?.text || '';
  // the words to keep in sight (main: sightWords): [{ id, word, vi, phrase, box }], still-learning first
  let sight: SightWord[] = [];
  let quizWord: VocabWord | null = null; // the word on the quiz card it's holding up
  const shortVi = (vi = '') => vi.split(/[;,(]/)[0].trim();
  // the first three on sticky notes on its monitor (office3d: data-vocab-stickies)
  function setSight(words: SightWord[] = []) {
    sight = words;
    robot.dataset.vocabStickies = JSON.stringify(words.slice(0, 3).map((x) => ({ id: x.id, text: x.word, sub: shortVi(x.vi) })));
  }
  // one of them, the ones you're still learning more often
  function sightWord() {
    if (!sight.length) return null;
    const weights = sight.map((x) => 1 / (1 + (x.box || 0)));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (const [i, wt] of weights.entries()) if ((r -= wt) < 0) return sight[i];
    return sight[0];
  }
  const QUIZ_LINES = ['Pop quiz! 🃏 Remember “{w}”?', "Quick one: what's “{w}”? 🤔", 'Do you still know “{w}”?', 'Word time! “{w}” means…?'];
  let countLater: number | undefined;
  let leafingSince = 0; // when it opened the dictionary: it reads for a moment even when the answer is quick
  const READ_AT_LEAST = 2500;
  const setVocabCount = (n?: number) => (robot.dataset.vocabCount = String(n || 0));
  // free to act it out (not in the middle of a job)
  const canAct = () => !state.busy && !helpersOut() && !state.mirroring && !press;
  // awake enough to show it: a sleeping robot wakes up, its chat staying tucked away
  function vocabReady() {
    if (state.away) return false;
    if (!state.awake) wake({ sayHi: false, tucked: true });
    state.lastActivity = Date.now();
    return true;
  }

  // read a word out with an English voice, the mouth going along
  function sayWord(text: string) {
    if (!text || !window.speechSynthesis || muted) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => v.lang === 'en-US' && /natural|aria|jenny|guy/i.test(v.name)) || voices.find((v) => v.lang === 'en-US') || voices.find((v) => v.lang.startsWith('en')) || null;
    u.lang = 'en-US';
    u.rate = 0.9;
    u.onstart = () => express('happy', 'talk', 900);
    speechSynthesis.speak(u);
  }

  // "what does meticulous mean?", "define X", "X nghĩa là gì": the word asked about ('' if none)
  const ASKED = [
    /\bwhat(?:'s| does| do| is)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+mean\b/i,
    /\b(?:meaning of|define|definition of)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s*(?:[?.!]|$)/i,
    /(?:^|\s)["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+(?:có\s+)?nghĩa\s+là\s+gì/i,
  ];
  // ("what does this error mean?" is about something else)
  const NOT_A_WORD = /^(this|that|these|those|it|the|a|an|my|your|our|his|her|their)\b/i;
  function askedWord(text = '') {
    for (const re of ASKED) {
      const w = re.exec(text)?.[1]?.trim();
      if (w && w.split(/\s+/).length <= 4 && !NOT_A_WORD.test(w)) return w;
    }
    return '';
  }
  // ------------------------------------------------------------ notes
  // Your notes (main notes.js): the corkboard on the desk shows the open ones
  // (data-board), the robot pins new ones up and tosses done ones in the bin, holds the
  // board up for the start- and end-of-day reminders, clocks out after the evening one,
  // and takes a note on in a chat when you ask Claude about it.
  let board: NotesBoard = { items: [], total: 0 };
  let shownBoard = board; // what the corkboard shows (behind `board` while the robot's hand is on its way)
  let lastBoard = { board, before: board, at: 0 }; // the latest change, and the board just before it
  let holding = 0;
  function setBoard(b: NotesBoard) {
    board = b || { items: [], total: 0 };
    lastBoard = { board, before: shownBoard, at: Date.now() };
    if (!holding) showBoard(board);
  }
  function showBoard(b: NotesBoard) {
    shownBoard = b;
    robot.dataset.board = JSON.stringify(b);
  }
  // the board as it was until `sec` from now (the robot's hand is on its way), then the latest.
  // (main sends the change just before it tells the robot, so a change a moment ago is undone)
  function holdBoardFor(sec: number) {
    clearTimeout(holding);
    if (Date.now() - lastBoard.at < 600) showBoard(lastBoard.before);
    holding = setTimeout(() => {
      holding = 0;
      showBoard(board);
    }, sec * 1000);
  }
  // free to act it out: awake (or dozing in its chair), at its desk, not working
  const canActNotes = () => !state.away && !state.busy && !helpersOut() && !state.mirroring && !press && !state.playing;

  function onNotes(ev: NotesEvent) {
    switch (ev.phase) {
      case 'board':
        setBoard(ev.board);
        break;
      case 'added': {
        // it writes it on a sticky and pins it up (asleep: half-awake, eyes shut, mumbling)
        if (!canActNotes()) {
          if (state.awake && !state.away) showPop(quip('noted') || 'Noted! 📝', 1400);
          break;
        }
        if (!state.awake && robot.dataset.sleepStyle === 'floor') {
          // asleep on the floor it can't reach the board: it just mumbles it
          stopAntic();
          antic('mumble', '…noted…');
          break;
        }
        holdBoardFor(1.25);
        stopAntic();
        antic('notepin', state.awake ? '' : '…noted…');
        if (!state.awake) express('closed', 'talk', 1800);
        cue(1.25, () => Sfx.key.pop());
        if (state.awake) cue(1.4, () => showPop(quip('noted') || 'Noted! 📝', 1500));
        break;
      }
      case 'done': {
        // it takes that sticky down, crumples it and bins it; the last one: all clear!
        if (!canActNotes() || !state.awake) break;
        holdBoardFor(0.6);
        stopAntic();
        antic('notetoss', ev.note?.id || '');
        cue(1.4, () => Sfx.swish());
        cue(2.1, () => {
          Sfx.key.pop();
          express('happy', 'smile', 900);
        });
        if (ev.left === 0) {
          setTimeout(() => {
            if (!canActNotes() || !state.awake) return;
            antic('allclear');
            Sfx.key.done();
            express('happy', 'wide', 1600);
            showPop(quip('allclear') || 'All clear! ✨', 1800);
          }, 2900);
        }
        break;
      }
      case 'opened':
        if (state.awake && canActNotes()) express('happy', 'smile', 900);
        break;
      case 'writing':
        // you're typing a note: it writes it down on a sticky pad (antics/notes.js notewrite)
        if (ev.on) {
          if (!state.awake || !canActNotes() || robot.dataset.antic === 'notewrite') break;
          stopAntic();
          antic('notewrite');
          express('happy', 'smile', 1200);
        } else if (robot.dataset.antic === 'notewrite') stopAntic();
        break;
      case 'remind':
        remindNotes(ev.kind, ev.info || {});
        break;
      case 'clockout':
        // the end-of-day look is done: a big stretch and a yawn, and off to sleep
        if (!state.awake || !canActNotes()) break;
        stopAntic();
        antic('clockout');
        cue(0.3, () => express('closed', 'o', 1300));
        cue(0.6, () => showPop(quip('notesClockout') || 'Good work today! 😴', 1600));
        cue(2.45, () => state.collapsed && sleep({ auto: true })); // (with its chat open it stays up)
        break;
      case 'ask':
        askInNewTab(ev.prompt, ev.note?.id || '', { draft: !!ev.draft });
        break;
    }
  }

  // A reminder: it holds its board up and points at you, says so, then the notebook opens.
  // Out walking it can't: the walker waves and the notebook opens straight away.
  function remindNotes(kind: 'morning' | 'evening', info: Partial<NotesReminder>) {
    const counts = kind === 'morning' ? info.taken || info.open : info.today || info.open;
    const line = `${quip(kind === 'morning' ? 'notesMorning' : 'notesEvening') || (kind === 'morning' ? 'Morning! Your notes:' : 'Before you go: your notes!')}${info.open ? ` (${info.open} open)` : ''}`;
    const open = () => ipc.notesRemindOpen({ kind, info: { ...info, line } });
    if (state.away) {
      ipc.robotWalker('wave');
      return open();
    }
    if (!state.awake) wake({ sayHi: false, tucked: true });
    setTimeout(() => {
      stopAntic();
      antic('boardlift');
      Sfx.ask();
      cue(0.9, () => {
        express('open', 'talk', 1400);
        showPop(line, 2600);
      });
      cue(2.6, open);
      setTimeout(() => state.away || (robot.dataset.antic !== 'boardlift' && open()), 3600); // (if it got cut short)
    }, state.awake ? 0 : 900);
    return counts;
  }

  // Clicked the board (or a sticky on it): the notebook, beside it. The robot glances over.
  function openNotesFromBoard(hit: { kind: string; id?: string }) {
    ipc.notesOpen({ focus: hit.kind === 'note' ? hit.id : null });
    if (state.awake && canActNotes()) lookAt(-260, 40, 1200);
  }

  // "Ask Claude" about a note, or "Summarise my day": a new chat tab with it, sent straight away
  // (draft: typed in for you to finish, not sent)
  async function askInNewTab(prompt: string, noteId = '', { draft = false } = {}) {
    if (!prompt) return;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    const before = activeId;
    const res = await ipc.robotTabNew();
    if (res.ok) {
      for (let i = 0; i < 60 && activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const tab = active()!;
    if (!res.ok && tab.busy) {
      showPop(res.error, 2200);
      if (noteId) ipc.notesAct('working', { id: noteId, working: false });
      return;
    }
    if (!res.ok && activeId === before) addNote('📑 No free tab: asking here.', '', tab);
    tab.noteId = noteId;
    input.value = prompt;
    if (draft) {
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    await submit();
  }

  // ------------------------------------------------------------ ask about the screen
  // A box you dragged round part of the screen (main: askScreen): it opens a fresh tab with
  // the screenshot attached, and offers a few one-click questions above the box, or you type
  // your own. The chips go once the screenshot's sent or spat out.
  const SCREEN_ASKS = [
    ['bulb', 'Explain this', 'Explain what this shows.'],
    ['wrench', "What's wrong?", "What's wrong here, and how do I fix it?"],
    ['languages', 'Translate', 'Translate the text in this into Vietnamese.'],
    ['summary', 'Sum it up', 'Sum this up in a few short bullet points.'],
  ];

  function renderScreenAsks() {
    const on = !!screenShot && state.attachments.some((a) => a.path === screenShot!.path);
    if (!on) screenShot = null;
    input.placeholder = on ? 'Ask about this… (or pick one)' : PLACEHOLDER;
    if (on === !screenAsks.hidden) return;
    screenAsks.hidden = !on;
    screenAsks.innerHTML = '';
    if (!on) return;
    const label = document.createElement('span');
    label.className = 'sa-label';
    label.textContent = 'Ask';
    screenAsks.append(label);
    SCREEN_ASKS.forEach(([icon, text, prompt], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = Icon(icon, 'sm lead');
      b.append(text);
      b.style.animationDelay = `${i * 40}ms`;
      b.addEventListener('click', () => {
        if (active()!.busy) return showPop('One thing at a time! 😅', 1500);
        const typed = input.value.trim();
        input.value = [prompt, typed, screenShot?.source ? `(It's from: ${screenShot.source})` : ''].filter(Boolean).join('\n\n');
        submit();
      });
      screenAsks.append(b);
    });
  }

  async function onScreen({ file, source = '' }: { file: FileInfo; source?: string }) {
    if (!file?.path || state.away) return;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    // a fresh tab, unless the one you're on is new and empty
    const tab = active()!;
    if (tab.busy || tab.log.querySelector('.msg.user')) {
      const res = await ipc.robotTabNew();
      if (res.ok) for (let i = 0; i < 60 && activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    screenShot = { path: file.path, source };
    state.attachments = [...state.attachments.filter((a) => a.path !== file.path), file].slice(-20);
    renderAttachments();
    flash('hop', 600);
    express('wide', 'o', 900);
    Sfx.key.ooh();
    showPop(pick(['Ooh, let me see! 🔍', 'What have we got here? 👀', 'Show me! 🔍']), 1800);
    state.lastActivity = Date.now();
    input.focus();
  }
  ipc.on('robot:screen', onScreen);

  // the action menu's hotkey (main: openPalette): it sends its drone off to you with a wave
  ipc.on('robot:palette', (ev) => {
    if (ev.phase !== 'launch' || state.away || !state.awake || state.busy) return;
    strikePose('raise', 700);
    express('happy', 'o', 700);
    Sfx.whee();
  });
  $('#btn-screen').addEventListener('click', () => ipc.robotScreenAsk());

  // Speaking instead of typing (voice.rs): the system's own dictation types into the box (on
  // Windows its voice typing, Win+H, with its own bar showing it listen). No engine, no mic.
  const micBtn = $('#btn-mic');
  ipc.voiceEngine().then((v) => {
    if (!v.name) return;
    micBtn.hidden = false;
    if (v.name === 'windows-voice-typing') micBtn.title = 'Speak instead of typing (Windows voice typing, Win+H)';
  }, () => {});
  micBtn.addEventListener('mousedown', (e) => e.preventDefault()); // (the box keeps the keyboard, and where you were in it)
  micBtn.addEventListener('click', async () => {
    if (document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    micBtn.classList.add('on');
    setTimeout(() => micBtn.classList.remove('on'), 1600);
    try {
      await ipc.voiceStart();
      showPop('🎙️ Listening… say it, I’ll type it', 2200);
    } catch (err) {
      showPop(String(err), 2400);
    }
  });

  // ------------------------------------------------------------ the other robots
  // Robots noticing each other (main social.js decides when; it hears how this one is every
  // few seconds): it waves at a neighbour, claps when one finishes a task, yawns when one
  // dozes off, joins a dance, walks over for a visit (the walker does the walking) or, at
  // its own desk, turns to a visitor and chats back. A visitor that found it asleep leaves a
  // sticky on its monitor (office3d: data-visit-notes), read out when it wakes.
  // free for one of these: idle, not in a quiz, a play, a question or a walk
  function socialFree() {
    if (state.away || state.leaving || state.mirroring || state.peek || helpersOut() || state.busy) return false;
    return state.awake ? !quizWord && !state.playing && !pendingQuestion() : true;
  }
  function socialReport(extra?: SocialReport) {
    ipc.socialReport(extra || {
      awake: state.awake,
      busy: !!state.busy || helpersOut() > 0,
      chat: body.classList.contains('expanded'),
      idleMs: Date.now() - state.lastActivity,
      free: socialFree(),
      away: !!state.away,
      wanders: wanders(),
    });
  }
  // look over at the robot on that side of the screen
  const lookSide = (side: Side, ms: number) => lookAt(side === 'L' ? -420 : 420, -10, ms);
  let visitFound = '';
  let deskPlane: { from: string; text: string } | null = null; // a paper plane that landed on its desk: { from, text }, read when it's free
  let pendingTreat: { kind: 'food' | 'tea'; text: string } | null = null; // food or milk tea that came: { kind: 'food' | 'tea', text }
  // eat it (or drink it): asleep it wakes for it (its chat tucked away); busy, it waits
  function haveTreat() {
    if (!pendingTreat || state.away || state.peek) return; // (hidden at the edge: it saves it for later)
    if (!state.awake) return wake({ sayHi: false, tucked: true }); // (eaten on the next look)
    if (!socialFree() || body.classList.contains('expanded') || Date.now() < anticUntil) return;
    const t = pendingTreat;
    pendingTreat = null;
    stopAntic();
    showPop(t.text || (t.kind === 'tea' ? 'Milk tea! 🧋' : 'Food! 😋'), 2000);
    setTimeout(() => (t.kind === 'tea' ? drinkMilkTea() : eatNoodles()), 900);
  }
  // a bubble tea pops into its hand; timings match the antic in office3d/antics/awake.js
  function drinkMilkTea() {
    antic('milktea');
    cue(0.35, () => Sfx.pop());
    cue(1.25, () => {
      express('happy', 'o', 2300);
      Sfx.slurp();
    });
    cue(2.3, () => Sfx.slurp());
    cue(3.75, () => express('happy', 'smile', 1600));
  }
  // a bowl of noodles at the desk (office3d/antics/calendar.js)
  function eatNoodles() {
    antic('noodles');
    cue(0.3, () => Sfx.pop());
    for (const at of [1.5, 2.7, 3.9]) cue(at, () => {
      Sfx.slurp();
      express('happy', 'o', 700);
    });
  }
  const planeLine = (p: { from: string; text: string }) => `From ${p.from}: “${p.text}”`;
  // read the plane on its desk: picks it up, reads it out, and waves over to whoever threw it
  function readDeskPlane() {
    // (not while you're using it: its chat open)
    if (!deskPlane || !state.awake || !socialFree() || body.classList.contains('expanded') || Date.now() < anticUntil) return;
    const p = deskPlane;
    deskPlane = null;
    stopAntic();
    antic('plane-read');
    cue(0.5, () => (robot.dataset.deskPlane = ''));
    cue(1.0, () => {
      Sfx.pop();
      showPop(planeLine(p), 2800);
      express('happy', 'talk', 1400);
    });
    cue(2.4, () => socialReport({ kind: 'plane-read' }));
  }
  function onSocial(ev: SocialEvent) {
    const free = socialFree();
    switch (ev.phase) {
      case 'wave':
      case 'wave-back':
        if (!free || !state.awake) break;
        stopAntic();
        antic('turn-to', ev.side);
        strikePose('wave', 1700);
        lookSide(ev.side, 2200);
        express('happy', 'smile', 1600);
        break;
      case 'stir': // waved at in its sleep
        if (!state.awake && !state.away) express('closed', 'o', 700);
        break;
      case 'clap':
        if (!free || !state.awake) break;
        stopAntic();
        antic('clap-at', ev.side);
        lookSide(ev.side, 2000);
        cue(0.35, () => Sfx.clap());
        express('happy', 'wide', 1800);
        if (ev.text) cue(0.5, () => showPop(ev.text, 1800));
        break;
      case 'yawn':
        if (!free || !state.awake) break;
        stopAntic();
        strikePose('cheer', 1300); // (a big stretch)
        express('closed', 'o', 1400);
        // a while idle already: it nods off soon too
        if (ev.sleepSoon) state.lastActivity = Math.min(state.lastActivity, Date.now() - (AUTO_SLEEP_MS - 40_000));
        break;
      case 'dance':
        if (free && state.awake) playWith('dance', { byUser: false });
        break;
      case 'visit':
        // off to another robot's desk (main gives the walker its errand)
        if (!free || !state.awake || !wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        state.visiting = { host: ev.host, mode: ev.mode };
        leaveDesk();
        break;
      case 'visit-over':
        state.visiting = null;
        break;
      case 'go-out': // asked out to lunch (it said yes): off it goes with the other robot
        if (!free || !state.awake || !wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        state.visiting = { host: ev.with, mode: 'lunch' };
        leaveDesk();
        break;
      case 'treat': // the lunch order or the milk tea came: eaten now if it's free, else when it is
        pendingTreat = { kind: ev.kind, text: ev.text };
        haveTreat();
        break;
      case 'hosting': // another robot is visiting its desk
        state.hosting = !!ev.on;
        break;
      case 'tidy': {
        // the evening housemaid at its desk (main maid.js): sparkles while she dusts, the bin
        // emptied; free, it lifts its feet so she can sweep under the desk and thanks her
        state.hosting = true; // (it stays put till she's done)
        robot.dataset.tidy = '1';
        clearTimeout(onSocial.bin);
        onSocial.bin = setTimeout(() => {
          robot.dataset.binEmpty = '1';
          binEmptied = new Date().toDateString();
          Sfx.swish();
        }, 3600);
        if (state.away || !state.awake) break; // (asleep: it sleeps on; out: an empty desk)
        lookSide(ev.side, 7000);
        if (ev.mood === 'free' && free && !body.classList.contains('expanded')) {
          stopAntic();
          antic('feet-up', ev.side);
          cue(0.5, () => express('o', 'o', 900));
          cue(4.5, () => {
            strikePose('wave', 1600);
            express('happy', 'smile', 2200);
            if (ev.thanks) showPop(ev.thanks, 2600);
          });
        } else if (ev.mood !== 'busy') express('happy', 'smile', 1600);
        break;
      }
      case 'tidy-end':
        state.hosting = false;
        robot.dataset.tidy = '';
        break;
      case 'listen': // a visitor is chatting beside the desk
        if (!state.awake || state.away || state.busy) break;
        stopAntic();
        antic('listen', ev.side);
        lookSide(ev.side, 9000);
        break;
      case 'say':
        if (!state.awake || state.away) break;
        showPop(ev.text, 2600);
        express('happy', 'talk', 1500);
        break;
      case 'listen-end':
        if (robot.dataset.antic === 'listen') stopAntic();
        if (ev.wave && state.awake && !state.away) strikePose('wave', 1300);
        break;
      case 'throw': // a paper plane at the robot on that side (main's plane window flies it)
        if (!free || !state.awake) break;
        stopAntic();
        antic('plane-throw', ev.side);
        lookSide(ev.side, 2000);
        express('happy', 'smile', 1800);
        cue(0.95, () => Sfx.swish());
        break;
      case 'catch': // a plane coming its way: a hand up, caught, read out
        if (!free || !state.awake) {
          deskPlane = { from: ev.from, text: ev.text };
          robot.dataset.deskPlane = '1';
          break;
        }
        stopAntic();
        antic('plane-catch', ev.side);
        lookSide(ev.side, 1200);
        cue(0.3, () => {
          Sfx.pop();
          express('open', 'o', 500);
        });
        cue(0.9, () => {
          showPop(planeLine(ev), 2800);
          express('happy', 'talk', 1500);
        });
        break;
      case 'plane-land': // landed on its desk while it was busy or asleep: read later
        deskPlane = { from: ev.from, text: ev.text };
        robot.dataset.deskPlane = '1';
        if (state.awake && !state.away) Sfx.pop();
        break;
      case 'oops': // its plane missed and flew off past the desk
        if (!state.awake || state.away) break;
        express('flat', 'o', 1300);
        showPop('Oops! 😅', 1500);
        break;
      case 'visit-note': // a visitor found it asleep: a sticky on its monitor
        robot.dataset.visitNotes = JSON.stringify([{ id: 'visit', text: 'came by 👋', sub: ev.from || '', color: '#ffd1e3' }]);
        visitFound = ev.found || '';
        break;
    }
  }
  onSocial.bin = 0; // (when the housemaid empties its bin)
  // awake: the visitor's sticky is read, and taken down a little later
  function readVisitNote() {
    if (!robot.dataset.visitNotes) return;
    const found = visitFound;
    visitFound = '';
    if (found) setTimeout(() => showPop(found, 2600), 3400); // (after its wake-up words)
    setTimeout(() => (robot.dataset.visitNotes = ''), 9000);
  }

  // ------------------------------------------------------------ messages from other robots
  // Another robot's Claude asked this one something (main robotLink.js: it flew over as a
  // paper plane). It takes it on in a tab of its own chat, in its own folder, like any
  // question (follow-ups in that exchange go to the same tab, so it remembers), and its
  // answer goes back when the turn's done (linkAnswer, from the done / fail events).
  function linkAnswer(tab: ChatTab, r: { text: string } | { error: string }) {
    ipc.robotsAnswer({ reqId: tab.linkReq!, ...r }); // (only for a tab another robot asked)
    tab.linkReq = '';
  }
  async function onLink(ev: LinkEvent) {
    if (ev.phase !== 'incoming') return;
    const fail = (error: string) => ipc.robotsAnswer({ reqId: ev.reqId, error });
    // (out walking: main's calling it back to its desk)
    // (in the group chat's meeting room it still answers, from its chat)
    for (let i = 0; i < 60 && state.away && !state.meeting; i++) await new Promise((r) => setTimeout(r, 100));
    if (state.away && !state.meeting) return fail("it's out for a walk and didn't come back to its desk");
    if (!state.awake) wake({ sayHi: false, tucked: true }); // (its chat stays tucked away: you see it working)
    let tab = [...tabs.values()].find((t) => t.exchange === ev.exchange);
    if (!tab) {
      const res = await ipc.robotTabNew();
      if (!res.ok) return fail(res.error || 'it has no free tab');
      for (let i = 0; i < 60 && !tabs.get(res.tabId); i++) await new Promise((r) => setTimeout(r, 50));
      tab = tabs.get(res.tabId);
      if (!tab) return fail('its new tab never opened');
      tab.exchange = ev.exchange;
    }
    activateTab(tab.id);
    tab.linkReq = ev.reqId;
    if (ev.task) {
      tab.task = ev.task.id; // (its desk tag opens this tab)
      ipc.robotTabRename(tab.id, `📋 ${ev.task.title}`);
    }
    if (state.awake) {
      Sfx.pop();
      showPop(ev.task ? `📋 ${ev.from} handed me a task!` : `📨 ${ev.from} asks…`, 1800);
    }
    input.value = ev.text;
    await submit();
  }

  // ------------------------------------------------------------ handed-off tasks
  // Work one robot handed another (main robotLink.js hand_off_task): a tag on both desks.
  // Here, "⏳ From Lead: Add /orders"; on Lead's desk, "⏳ To BE: Add /orders" (✅ when done).
  // A click opens the chat (the task's own tab, on the robot doing it). A finished task's
  // tag stays a little while (main drops it), and the one who handed it off says so.
  const tasksEl = $('#tasks');
  const TASK_STATE = { sent: ['✈️', 'on its way'], working: ['⏳', 'working'], done: ['✅', 'done'], failed: ['⚠️', "couldn't do it"], cancelled: ['✖️', 'cancelled'] };
  let shownTasks = new Map<string, LinkTask['status']>(); // id -> status, to notice a change
  function renderTasks(list: LinkTask[] = []) {
    tasksEl.replaceChildren();
    const next = new Map<string, LinkTask['status']>();
    for (const t of list.slice(-3)) {
      next.set(t.id, t.status);
      const [icon, word] = TASK_STATE[t.status] || TASK_STATE.sent;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `task-chip ${t.status}${t.mine ? ' mine' : ''}`;
      chip.textContent = `${icon} ${t.mine ? 'From' : 'To'} ${t.other}: ${t.title}`;
      chip.title = `${t.mine ? `A task from ${t.other}` : `Handed to ${t.other}`}: ${t.title} (${word})${t.report && t.status !== 'working' ? `\n\n${t.report}` : ''}`;
      chip.addEventListener('pointerdown', (e) => e.stopPropagation()); // (not a drag or a poke)
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openTask(t);
      });
      tasksEl.appendChild(chip);
      // the one who handed it off hears how it went
      const was = shownTasks.get(t.id);
      if (!t.mine && was && was !== t.status && state.awake && !state.away) {
        if (t.status === 'done') {
          Sfx.key.done();
          showPop(`✅ ${t.other} finished: ${t.title}`, 2600);
        } else if (t.status === 'failed') showPop(`⚠️ ${t.other} couldn't finish: ${t.title}`, 2600);
      }
    }
    shownTasks = next;
    tasksEl.hidden = !list.length;
  }
  function openTask(t: LinkTask) {
    if (state.away) return awayClick();
    const tab = t.mine ? [...tabs.values()].find((x) => x.task === t.id) : null;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    if (tab) activateTab(tab.id);
  }
  ipc.on('robot:tasks', renderTasks);
  ipc.robotTasks().then(renderTasks, () => {});

  // ------------------------------------------------------------ quick actions
  // Quick actions on text you selected (main quickWindow.js): while Claude refines or sums
  // it up the robot writes on its pad, while it translates or explains it leafs through
  // its dictionary; a little hop when the answer goes back into your app. Asleep or out
  // for a walk, it lets you get on with it.
  const QUICK_ANTICS = ['notewrite', 'dictionary'];
  let quickSince = 0;
  function onQuick(ev: Events['robot:quick']) {
    if (state.away) return;
    const free = state.awake && canActNotes();
    switch (ev.phase) {
      case 'start':
        if (!free) break;
        if (!QUICK_ANTICS.includes(robot.dataset.antic!)) {
          stopAntic();
          antic(ev.action === 'refine' || ev.action === 'summarise' ? 'notewrite' : 'dictionary');
          quickSince = Date.now();
        }
        if (Math.random() < 0.6) showPop(quip('quickStart') || 'On it! ✍️', 1400);
        break;
      case 'done':
      case 'fail':
        // (it writes for a moment at least, even when the answer is quick)
        setTimeout(() => {
          if (QUICK_ANTICS.includes(robot.dataset.antic!)) stopAntic();
          if (!state.awake) return;
          if (ev.phase === 'done') express('happy', 'smile', 1000);
          else {
            express('flat', 'o', 1400);
            showPop("Hmm, that didn't work.", 1800);
          }
        }, Math.max(0, 900 - (Date.now() - quickSince)));
        break;
      case 'replaced':
        if (!free) break;
        flash('hop', 600);
        Sfx.key.done();
        showPop(quip('quickDone') || 'Done! ✨', 1500);
        break;
      case 'copied':
        if (state.awake) showPop('Copied! 📋', 1200);
        break;
    }
  }

  function tickNoteChip(id: string) {
    const b = document.createElement('button');
    b.className = 'chip save-word';
    Icon.text(b, '✅ Tick it off my notes');
    b.addEventListener('click', () => {
      b.disabled = true;
      Icon.text(b, '✅ Ticked off');
      ipc.notesAct('done', { id });
    });
    return b;
  }

  // the mouse over the board, the hammer or the plug: it lights up, and a label by the mouse
  // says what a click does (drawn here, not a tooltip)
  const boardLabel = $('#board-label');
  const propLabel = (kind: string | undefined) =>
    kind === 'hammer'
      ? state.away ? '🔨 (out for a walk)' : state.awake ? '🔨 Bonk!' : '🔨 Bonk me awake'
      : kind === 'plug'
        ? state.away ? '🔌 (out for a walk)' : '🔌 Charge my battery'
        : board.total ? `📋 ${board.total} note${board.total === 1 ? '' : 's'}: click to open` : '📋 Notes: all clear (click to add one)';
  function clearPropHover() {
    robot.dataset.propHover = '';
    robot.classList.remove('over-prop');
    boardLabel.classList.remove('show');
  }
  // (Windows may not tell a transparent window the mouse left: robot:cursor is the backstop)
  function propCursor(c: Point) {
    if (!robot.dataset.propHover) return;
    const s = state.scale || 1;
    if (c.x < -6 || c.y < -6 || c.x > ROBOT_W * s + 6 || c.y > ROBOT_H * s + 6) clearPropHover();
  }
  let boardRaf = 0;
  robot.addEventListener('mousemove', (e) => {
    if (boardRaf) return;
    boardRaf = requestAnimationFrame(() => {
      boardRaf = 0;
      // a word's sticky note on the monitor: it zooms up to read (office3d scene.js stickies)
      const note = (!press && office.stickyAt?.(e.clientX, e.clientY)) || null;
      robot.dataset.stickyHover = note?.kind === 'vocab' ? note.id : '';
      robot.classList.toggle('over-sticky', note?.kind === 'vocab');
      const hit = !press && office.propAt?.(e.clientX, e.clientY);
      if (!hit) return clearPropHover();
      const kind = hit.kind === 'note' ? 'board' : hit.kind;
      robot.dataset.propHover = kind;
      robot.classList.add('over-prop');
      const r = robot.getBoundingClientRect();
      Icon.text(boardLabel, propLabel(kind));
      boardLabel.style.left = `${e.clientX - r.left}px`;
      boardLabel.style.top = `${e.clientY - r.top}px`;
      boardLabel.classList.add('show');
    });
  });
  robot.addEventListener('mouseleave', () => {
    robot.dataset.stickyHover = '';
    robot.classList.remove('over-sticky');
    clearPropHover();
  });

  function saveWordChip(word: string) {
    const b = document.createElement('button');
    b.className = 'chip save-word';
    Icon.text(b, `📚 Save “${word}” to my words`);
    b.addEventListener('click', () => {
      b.disabled = true;
      Icon.text(b, `📚 “${word}” saved`);
      ipc.robotVocabSave(word);
    });
    return b;
  }

  function onVocab(ev: VocabEvent) {
    const w = wordOf(ev.word);
    switch (ev.phase) {
      case 'count':
        // a card on its way into the box lands first
        clearTimeout(countLater);
        if (robot.dataset.antic === 'word-show') countLater = setTimeout(() => setVocabCount(ev.count), Math.max(0, anticUntil - 300 - Date.now()));
        else setVocabCount(ev.count);
        break;
      case 'empty':
        if (!vocabReady()) return;
        express('flat', 'o', 1400);
        showPop(`Select a word, then ${ev.hotkey}!`, 3000);
        break;
      case 'too-long':
        if (!vocabReady()) return;
        express('dizzy', 'o', 1400);
        showPop("Too long! Just a word or two.", 2600);
        break;
      case 'catch':
        if (!vocabReady()) return;
        Sfx.key.ooh();
        flash('hop', 600);
        express('happy', 'o', 900);
        showPop(`Ooh, “${w}”!`, 2400);
        state.news = `📖 Looking up “${w}”…`;
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('dictionary', w);
          leafingSince = Date.now();
        }
        break;
      case 'found':
      case 'known': {
        const wait = robot.dataset.antic === 'dictionary' ? READ_AT_LEAST - (Date.now() - leafingSince) : 0;
        if (wait > 0) return void setTimeout(() => onVocab(ev), wait);
        state.news = `📚 “${w}” is in your words`;
        renderWorking();
        if (!vocabReady()) return;
        const vi = ev.word?.senses?.[0]?.vi || '';
        if (canAct()) {
          antic('word-show', w);
          cue(0.3, () => Sfx.whee());
          cue(3.9, () => Sfx.pop());
        }
        Sfx.key.done();
        sayWord(w);
        setTimeout(() => showPop(ev.phase === 'known' ? `Already got “${w}”!` : vi ? `${w}: ${vi}` : `Got it: ${w}!`, 4200), 900);
        break;
      }
      case 'failed':
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'dictionary') stopAntic();
        if (!vocabReady()) return;
        Sfx.key.oops();
        express('dizzy', 'flat', 1600);
        showPop("My dictionary's stuck!", 2600);
        break;
      case 'sight':
        setSight(ev.words);
        break;
      case 'reading':
        // the box you dragged round a word: it squints at it while Claude reads it
        if (!vocabReady()) return;
        Sfx.key.ooh();
        express('happy', 'o', 1200);
        showPop('Ooh, let me read that… 🔍', 2400);
        state.news = '🔍 Reading the word in your box…';
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('dictionary', '…');
        }
        break;
      case 'unreadable':
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'dictionary') stopAntic();
        if (!vocabReady()) return;
        Sfx.key.oops();
        express('dizzy', 'flat', 1600);
        showPop("I can't find a word in there!", 2600);
        break;
      case 'quiz':
        // a reminder (main/reminders.js): it holds up the word, the card asks you
        if (!vocabReady()) return;
        quizWord = ev.word;
        Sfx.key.ooh();
        flash('hop', 600);
        express('happy', 'o', 900);
        showPop(pick(QUIZ_LINES).replace('{w}', w), 3600);
        state.news = `🃏 Do you remember “${w}”?`;
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('quiz-card', w);
        }
        break;
      case 'answered': {
        quizWord = null;
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'quiz-card') stopAntic();
        if (!state.awake) return;
        if (ev.how === 'knew') {
          Sfx.key.done();
          flash('hop', 600);
          strikePose('cheer', 1400);
          express('happy', 'smile', 1800);
          showPop(pick(['Yes! 🎉', 'You got it! ✨', 'Nailed it!', 'Smart cookie! 🍪']), 2200);
        } else if (ev.how === 'forgot') {
          express('flat', 'smile', 1600);
          showPop(pick([`No worries, “${w}” comes back soon!`, `We'll get “${w}” next time!`]), 2600);
        } else if (ev.how === 'later') {
          express('happy', 'smile', 1000);
          showPop('OK, later! ⏰', 1600);
        }
        break;
      }
      case 'dream': {
        // a word that's due: it dreams of it (on its monitor) and mumbles it; the dream
        // bubble beside it shows the meaning and an example
        if (state.awake || state.away) break;
        stopAntic();
        antic('dream', w);
        cue(1.2, () => express('closed', 'talk', 2200));
        cue(1.3, () => Sfx.hmm?.());
        break;
      }
      case 'knowit':
        // ✓ I know this one, from its dream: a sleepy little smile
        if (!state.awake) express('closed', 'smile', 1800);
        break;
      case 'milestone': {
        // 10 words learnt, a week-long streak…: a dance party, after its reaction to the answer
        setTimeout(() => {
          if (!vocabReady()) return;
          if (canAct()) playWith('dance');
          setTimeout(() => showPop(ev.learnt ? `🎓 ${ev.learnt} words learnt!` : `🔥 ${ev.streak} days in a row!`, 3000), 600);
          if (ev.unlocked) setTimeout(() => showPop('New hat in the Workshop! 🎓', 3200), 3800);
        }, 2600);
        break;
      }
      case 'undone':
        if (!state.awake) return;
        express('flat', 'smile', 1200);
        showPop(`OK, “${w}” is gone.`, 1800);
        break;
      case 'ask': {
        // the card's 💬 Ask more: the question waits in the chat for you to send
        if (state.away) return awayClick();
        if (!state.awake) wake({ sayHi: false });
        else openChat();
        const vi = ev.word?.senses?.[0]?.vi;
        const fill = () => {
          input.value = `Tell me more about the English word “${w}”${vi ? ` (${vi})` : ''}: when and how is it used, its common collocations, and similar words and how they differ. Answer in Vietnamese, with English examples.`;
          autosize();
          input.focus();
        };
        // in a tab of its own, unless this one is still empty
        if (active()!.busy || active()!.log.querySelector('.msg.user, .msg.bot')) newTab().then(() => setTimeout(fill, 250));
        else fill();
        break;
      }
    }
  }
  ipc.on('robot:vocab', onVocab);
  ipc.on('robot:notes', onNotes);
  ipc.on('robot:quick', onQuick);
  ipc.on('robot:social', onSocial);
  ipc.on('robot:link', onLink);
  let binEmptied = ''; // the day the housemaid emptied its bin (it fills up again overnight)
  setInterval(() => {
    socialReport();
    islandReport.again(); // (in case the island was away when it last said)
    if (binEmptied && binEmptied !== new Date().toDateString()) {
      binEmptied = '';
      robot.dataset.binEmpty = '';
    }
    readDeskPlane(); // (a plane on its desk, read once it's free)
    haveTreat(); // (food or milk tea that came, had once it's free)
  }, 5000);
  setTimeout(() => socialReport(), 1500);

  ipc.on('robot:action', (action) => {
    if (action === 'sleep') sleep();
    else if (action === 'wake') wake();
    else if (action === 'peek') peek();
    else if (action === 'unpeek') unpeek();
    else if (action === 'chat') {
      // (the island: out, and its chat open)
      unpeek();
      if (!state.awake) wake();
      else openChat();
    }
    else if (action === 'wake-tucked') wake({ sayHi: false, tucked: true });
    else if (action === 'tuck') collapse(); // (off the stage: back at its desk, still at work) // (main groupChat.js: the chat stays put away)
    else if (action === 'meeting') toMeeting();
    else if (action === 'meeting-end') fromMeeting();
    else if (action === 'reset') ipc.robotReset(activeId!);
    else if (action === 'new-tab') {
      if (!state.awake) wake({ sayHi: false });
      newTab();
    }
    else if (action === 'history') openHistory();
    else if (action === 'terminal') openTerminal();
    else if (action === 'shell') toggleShell({ show: true });
    else if (action === 'bonk') bonkRobot();
    else if (action === 'paste') pasteClipboard();
    else if (action === 'wander') {
      // right-click menu: off for a walk now (not in the middle of a job, though)
      if (state.busy || helpersOut() || state.mirroring) showPop("Can't go now, I'm working!", 1800);
      else leaveDesk();
    }
    else if (action === 'handoff') goneWalking();
    else if (action === 'dock' || String(action).startsWith('dock:')) {
      const [x, y] = String(action).slice(5).split(',').map(Number);
      backToDesk({ feet: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    }
    else if (action === 'dock-hover') body.classList.add('dock-target');
    else if (action === 'dock-leave') body.classList.remove('dock-target');
  });

  // ------------------------------------------------------------ boot

  (async () => {
    const init = await ipc.robotInit();
    if (!init.character) return;
    state.personalities = init.personalities;
    state.user = init.user;
    setSounds(init.settings);
    islandButton(init.settings);
    Sfx.setHush(!!init.hush);
    applyCharacter(init.character);
    setVocabCount(init.vocabCount);
    setSight(init.vocabSight || []);
    setBoard(init.notesBoard);
    syncTabs(init.character);
    if (init.character.peek) {
      // (away on the island when it was last closed: main keeps it veiled)
      state.peek = true;
      robot.dataset.peek = '1';
    }
    ipc.robotExpand(false); // every (re)load starts asleep; keep the window in sync
    if (init.character.terminalOpen && tabs.get(init.character.terminalTab!)) terminalState('opened', tabs.get(init.character.terminalTab!)!, { quiet: true });
    setActivity('off');
    renderFace();
    refreshCommands();
    blinkLoop();
    setTimeout(antics, 8000);
    setTimeout(dozeLoop, rand(20000, 40000));
  })();
})();
