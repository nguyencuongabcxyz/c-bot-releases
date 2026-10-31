// Its days: waking up and falling asleep, opening the chat and tucking it away, peeking from
// the screen's edge, and what it tells the island about itself.
// (robot.ts calls createLifeCycle with its hub.)
import type { ShellsApi } from '@/features/workbench/shell/drawer';
import type { SidePanelApi } from '@/features/chat/side/panel';
import { pick } from '@/lib/random';
import type { CommentaryApi } from '@/features/chat/reply/commentary';
import type { DeskActivityApi } from './desk';
import type { OtherRobotsApi } from '@/features/robots/reactions';
import type { ChatLogApi } from '@/features/chat/log';
import type { PlansApi } from '@/features/chat/plan/card';
import type { IdleAnticsApi } from './antics';
import type { ChatSizeApi } from '@/features/chat/size';
import type { FaceApi } from './face';
import type { SlashApi } from '@/features/chat/composer/slash';
import type { ChatMarkdownApi } from '@/features/chat/reply/local-files';
import { planSummary } from '@/features/chat/plan/modes';
import { Sfx } from '../sound';
import type { ChatTab, RobotState } from '../types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { Office3DView } from '@/office3d';
import { writeJson, type OfficeData } from '@/office3d/protocol';
import type { IslandNews, IslandReport } from '@/types/ipc';
import type { Personality, RobotSize, RobotView } from '@/types/model';
import { headSvg } from '@/icons/head';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type LifeCycleNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly addBot: ChatLogApi['addBot'];
  readonly addNote: CommentaryApi['addNote'];
  readonly addQaSummary: PlansApi['addQaSummary'];
  readonly addUser: ChatLogApi['addUser'];
  readonly awayClick: IdleAnticsApi['awayClick'];
  readonly body: HTMLElement;
  readonly chatSizePart: ChatSizeApi;
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly fill: (line: string) => string;
  readonly flash: FaceApi['flash'];
  readonly folderName: () => string;
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly office: Office3DView;
  readonly pendingQuestion: PlansApi['pendingQuestion'];
  readonly persona: () => Personality;
  readonly placePanel: ChatSizeApi['placePanel'];
  readonly plain: CommentaryApi['plain'];
  readonly readVisitNote: OtherRobotsApi['readVisitNote'];
  readonly renderFace: FaceApi['renderFace'];
  readonly renderPose: DeskActivityApi['renderPose'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly shell: ShellsApi['shell'];
  readonly sides: SidePanelApi['sides'];
  readonly socialReport: OtherRobotsApi['socialReport'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly tabs: Map<string, ChatTab>;
};

export function createLifeCycle(r: LifeCycleNeeds) {
  // (life/desk.ts)

  function applyCharacter(c: RobotView) {
    r.state.character = c;
    if (!r.body.classList.contains('resizing-v') && (c.chatHeight ?? null) !== r.chatSizePart.chatH) {
      r.chatSizePart.chatH = c.chatHeight ?? null; // (how tall you made its chat)
      if (r.body.classList.contains('expanded')) r.placePanel();
    }
    document.documentElement.style.setProperty('--paint', c.color || '#5ac8fa');
    const face = $('#stage-face');
    if (!face.firstChild) face.innerHTML = headSvg();
    face.style.color = c.color || '#5ac8fa';
    $('#name').textContent = c.name;
    $('#nametag').textContent = c.name;
    const chip = $('#folder');
    chip.innerHTML = `${Icon('folder', 'sm')}<span></span>`;
    $(':scope > span:last-child', chip).textContent = r.folderName();
    chip.title = c.folder;
    r.deskState.acc = c.accessory || 'none';
    // its size: the robot box scales as one, the 3D view renders sharp at that size
    const k = ({ small: 0.7, large: 1.35, huge: 1.7 } as Partial<Record<RobotSize, number>>)[c.size ?? 'normal'] || 1;
    document.documentElement.style.setProperty('--s', String(k));
    r.state.scale = k;
    r.office.setScale(k);
    r.deskState.body = 'kit';
    writeJson(r.deskState, 'kit', c.kit || {}); // (its parts: office3d/kit3d.ts)
    r.deskState.theme = c.theme || 'classic';
    r.deskState.name = c.name;
    document.title = c.name;
  }

  function renderHistory(tab: ChatTab = r.current()) {
    tab.log.innerHTML = '';
    if (tab.data?.temporary)
      r.addNote(
        '🕶️ Temporary chat: nothing here is kept. It’s gone, Claude Code’s transcript too, when you close this tab.',
        'temp-note',
        tab,
      );
    for (const h of (tab.data.history || []).slice(-30)) {
      if (h.role === 'qa') r.addQaSummary(h.items, tab);
      else if (h.role === 'plan') tab.log.appendChild(planSummary(r.md, h));
      else if (h.role === 'note') r.addNote(h.text, '', tab);
      else if (h.role === 'user') r.addUser(h.text, h.files, tab, h.tag, h.briefs);
      else
        r.sides.attach(
          r.addBot(h.interrupted ? `${h.text || ''}\n\n_…(stopped)_` : h.text, {
            error: h.isError,
            denials: h.denials,
            tools: h.tools,
            asides: h.asides,
            edits: h.edits,
            apps: h.apps,
            images: h.images,
            tokens: h.tokens,
            costUsd: h.costUsd,
            tab,
          }),
          h.at,
          tab,
        );
    }
  }

  // tucked: just awake enough to show something (a word you caught), the chat stays tucked away
  function wake({ sayHi = true, tucked = false } = {}) {
    if (r.state.away) return r.awayClick(); // it's out: drag it back first
    if (r.state.awake) return;
    unpeek(); // (away on the island: it comes back out first)
    r.state.awake = true;
    r.stopAntic();
    r.state.lastActivity = Date.now();
    r.body.classList.remove('asleep');
    r.body.classList.add('awake');
    (tucked ? Sfx : Sfx.key).wake(); // (woken for something it shows by itself: an extra)
    r.flash('shake', 500);
    r.express('open', 'o', 700);
    // jolt awake and boot the computer (unless it's already busy working)
    if (!r.state.busy) r.setActivity('boot', 1000);
    else r.renderPose();
    if (tucked) {
      r.state.collapsed = true;
      r.body.classList.add('collapsed');
      renderWorking();
      ipc.robotExpand(false, { tucked: true });
    } else ipc.robotExpand(true);
    const hadBadge = r.body.classList.contains('has-badge');
    r.body.classList.remove('has-badge');
    r.readVisitNote();
    setTimeout(() => {
      r.flash('hop', 600);
      if (!hadBadge && !r.state.busy && sayHi) greet();
      r.scrollDown();
      if (!tucked) r.input.focus();
    }, 300);
  }

  // The chat stays open while the robot works, unless you tuck it away (🔽) to
  // watch the robot instead: a status bubble says what it's up to. It stays
  // tucked away until you click the bubble or the robot, even when the task is
  // done or Claude needs you; the bubble says so instead.
  function collapse() {
    if (!r.state.awake || r.state.collapsed || r.state.mirroring) return;
    r.state.collapsed = true;
    r.hidePalette();
    panelOut(() => {
      if (!r.state.collapsed || !r.state.awake) return; // (opened again meanwhile)
      r.body.classList.add('collapsed');
      renderWorking();
      ipc.robotExpand(false, { tucked: true });
    });
  }

  // The chat panel shrinks away before the window does (then main hides the window's resize)
  const PANEL_OUT = 140;
  function panelOut(then: () => void) {
    if (!r.body.classList.contains('expanded')) return then();
    r.body.classList.add('panel-out');
    setTimeout(() => {
      r.body.classList.remove('panel-out');
      then();
    }, PANEL_OUT);
  }

  function openChat({ focus = true } = {}) {
    if (r.state.away) return r.awayClick(); // it's out for a walk: drag it back first
    if (!r.state.collapsed) return;
    r.state.collapsed = false;
    r.state.news = '';
    r.body.classList.remove('collapsed');
    renderWorking();
    ipc.robotExpand(true, { focus });
    if (focus) r.input.focus();
  }

  const workingEl = $('#working');
  function renderWorking() {
    islandReport(); // (the island hears what it's up to, too)
    workingEl.hidden = !r.state.collapsed;
    if (!r.state.collapsed) return;
    const asking = [...r.tabs.values()].some((x) => x.question);
    const t = r.active()?.busy ? r.active() : [...r.tabs.values()].find((x) => x.busy);
    const out = r.helpersOut();
    $('#working-text').textContent = r.plain(
      asking
        ? '✋ I have a question for you. Click to answer'
        : t
          ? t.statusText || 'Working on it…'
          : out
            ? `🤖 ${out === 1 ? 'A helper is' : `${out} helpers are`} still working…`
            : r.state.news || 'Waiting for a question',
    );
    workingEl.classList.toggle('news', asking || (!t && !!r.state.news));
    workingEl.classList.toggle('idle', !asking && !t && !out && !r.state.news); // (its dots keep still)
  }
  workingEl.addEventListener('click', () => openChat());

  function sleep({ auto = false } = {}) {
    if (!r.state.awake) return;
    if (auto && r.shell.running()) return; // (dozing off would end them: a dev server, say)
    r.shell.end(); // (its shell goes to bed too, with whatever was running in it)
    if (r.state.away) ipc.robotWalker('asleep'); // dozes off out there: it sleepwalks
    r.state.awake = false;
    r.stopAntic();
    r.state.collapsed = false;
    r.state.news = '';
    r.body.classList.remove('collapsed');
    renderWorking();
    (auto ? Sfx : Sfx.key).sleep(); // (dozing off by itself: an extra)
    r.express('closed', 'o', 900);
    r.body.classList.remove('awake');
    r.body.classList.add('asleep');
    panelOut(() => {
      if (r.state.awake) return; // (woken again meanwhile)
      r.body.classList.remove('expanded');
      ipc.robotExpand(false);
    });
    // a busy robot keeps working at its desk; otherwise the monitor goes dark
    if (!r.state.busy) r.setActivity('off');
    else r.renderPose();
    r.renderFace();
    r.socialReport({ kind: 'slept' });
  }

  // ---- away on the robot island
  // Out of your way: its window is veiled (main, robots/mod.rs, with the "hidden" layout) and
  // its face waits on the robot island at the screen's edge (robots/island.rs), which says what
  // it's up to and shows its news. It keeps working meanwhile; the 3D desk stops drawing.
  // Bringing it out from the island (or anything that wakes it) brings it back.
  function peek() {
    if (r.state.peek || r.state.away || r.state.leaving || r.state.mirroring) return;
    if (r.state.awake) {
      sleep(); // (busy, it keeps working away)
      return void setTimeout(() => r.state.awake || peek(), PANEL_OUT + 60);
    }
    r.state.peek = true;
    r.stopAntic();
    Sfx.swish();
    r.deskState.peek = '1';
    ipc.robotPeek(true);
    r.socialReport();
    islandReport();
  }
  function unpeek() {
    if (!r.state.peek) return;
    r.state.peek = false;
    r.deskState.peek = '';
    ipc.robotPeek(false);
    islandReport();
    Sfx.pop();
    setTimeout(() => r.flash('hop', 600), 120);
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
  /** Say it again even if nothing changed (the island may have missed it). */
  function islandReportAgain() {
    islandSaid = '';
    islandReport();
  }
  function islandNow(): IslandReport {
    const t = r.active()?.busy ? r.active() : [...r.tabs.values()].find((x) => x.busy);
    const out = r.helpersOut();
    const text = t
      ? r.plain(t.statusText || 'Working on it…')
      : out
        ? `${out === 1 ? 'A helper is' : `${out} helpers are`} still working…`
        : '';
    return {
      awake: r.state.awake,
      busy: !!t || out > 0,
      text,
      since: t?.turnStart || null,
      asking: !!r.pendingQuestion(),
    };
  }
  // its news, while it's away: what it said, in a line
  function islandNews(kind: IslandNews['kind'], text: string) {
    if (!r.state.peek) return; // (out on the desk, its own bubble says it)
    const line = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>|[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    islandReport({ kind, text: line.length > 140 ? `${line.slice(0, 139)}…` : line });
  }

  function greet() {
    for (const el of r.current().log.querySelectorAll('.greet')) el.remove();
    const el = r.addBot(r.fill(pick(r.persona().greetings)));
    el.classList.add('greet');
    setTimeout(() => r.strikePose('wave', 1600), 700);
  }
  return {
    applyCharacter,
    collapse,
    islandNews,
    islandReport,
    islandReportAgain,
    openChat,
    peek,
    renderHistory,
    renderWorking,
    sleep,
    unpeek,
    wake,
  };
}
export type LifeCycleApi = ReturnType<typeof createLifeCycle>;
