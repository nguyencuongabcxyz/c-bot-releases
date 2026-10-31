// Asking it: what you type goes to its Claude (or waits its turn while it's busy), and the answer
// streams into a bubble: its words, the steps between them and what they made, in order.
// (robot.ts calls createAsking with its hub.)
import type { SidePanelApi } from '../side/panel';
import { THINKING_VERBS } from '@/views/robot/constants';
import { pick } from '@/lib/random';
import type { CommentaryApi } from './commentary';
import type { AppViewsApi } from '@/features/mcp/apps';
import type { BrainApi } from '../brain';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { RemoteControlApi } from '../remote';
import type { TodoCardApi } from '../todo';
import type { OtherRobotsApi } from '@/features/robots/reactions';
import type { ChatLogApi } from '../log';
import type { PlansApi } from '../plan/card';
import type { VocabApi } from '@/features/vocab/robot';
import type { QuestionsApi } from '../questions';
import type { ComposerApi } from '../composer/composer';
import type { HelpersApi } from '../agents';
import type { ChatMarkdownApi } from './local-files';
import type { FaceApi } from '@/views/robot/life/face';
import type { SlashApi } from '../composer/slash';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { RobotMessagesApi } from '@/features/robots/link/asks';
import type { MentionsApi } from '../composer/mentions';
import type { AttachmentsApi } from '../composer/attachments';
import type { BriefsApi } from '../brief';
import type { TabsApi } from '../tabs';
import type { QuickActionsApi } from '@/features/workbench/quick/robot';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, Part, Reply, RobotState, TextPart } from '@/views/robot/types';
import type { ChatEventsApi } from '../events';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { OfficeData } from '@/office3d/protocol';
import type { Personality } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type AskingNeeds = {
  readonly onEvent: ChatEventsApi['onEvent'];
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly addBot: ChatLogApi['addBot'];
  readonly addNote: CommentaryApi['addNote'];
  readonly addUser: ChatLogApi['addUser'];
  readonly animates: CommentaryApi['animates'];
  readonly answerFromComposer: PlansApi['answerFromComposer'];
  readonly appCard: AppViewsApi['appCard'];
  readonly appResult: AppViewsApi['appResult'];
  readonly asideChip: AppViewsApi['asideChip'];
  readonly askedWord: VocabApi['askedWord'];
  readonly askUser: QuestionsApi['askUser'];
  readonly autosize: ComposerApi['autosize'];
  readonly body: HTMLElement;
  readonly callChip: ChatLogApi['callChip'];
  readonly clearFinishedHelpers: HelpersApi['clearFinishedHelpers'];
  readonly composerPart: ComposerApi;
  readonly dedupePics: ChatMarkdownApi['dedupePics'];
  readonly deniedNote: CommentaryApi['deniedNote'];
  readonly usageLine: CommentaryApi['usageLine'];
  readonly deskState: OfficeData;
  readonly diffCard: ChatLogApi['diffCard'];
  readonly editBanner: ComposerApi['editBanner'];
  readonly expireQuestion: PlansApi['expireQuestion'];
  readonly express: FaceApi['express'];
  readonly finishCompact: BrainApi['finishCompact'];
  readonly flash: FaceApi['flash'];
  readonly foldSteps: ChatLogApi['foldSteps'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly helperView: HelpersApi['helperView'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly islandNews: LifeCycleApi['islandNews'];
  readonly linkAnswer: RobotMessagesApi['linkAnswer'];
  readonly loadBrain: BrainApi['loadBrain'];
  readonly md: ChatMarkdownApi['md'];
  readonly mirror: RemoteControlApi['mirror'];
  readonly msgActions: ComposerApi['msgActions'];
  readonly onAgent: HelpersApi['onAgent'];
  readonly onRemote: RemoteControlApi['onRemote'];
  readonly onTasks: TodoCardApi['onTasks'];
  readonly persona: () => Personality;
  readonly rawText: ComposerApi['rawText'];
  readonly refreshCommands: MentionsApi['refreshCommands'];
  readonly renderAttachments: AttachmentsApi['renderAttachments'];
  readonly renderBrain: BrainApi['renderBrain'];
  readonly renderFace: FaceApi['renderFace'];
  readonly renderMeta: CommentaryApi['renderMeta'];
  readonly renderRemote: RemoteControlApi['renderRemote'];
  readonly renderStepDetail: ChatLogApi['renderStepDetail'];
  readonly renderTabs: TabsApi['renderTabs'];
  readonly renderToolView: HelpersApi['renderToolView'];
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly restingActivity: DeskActivityApi['restingActivity'];
  readonly reviewPlan: PlansApi['reviewPlan'];
  readonly runLocalCommand: SlashApi['runLocalCommand'];
  readonly saveWordChip: QuickActionsApi['saveWordChip'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly sentOf: ComposerApi['sentOf'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly setStatus: CommentaryApi['setStatus'];
  readonly setStepOut: ChatLogApi['setStepOut'];
  readonly setTabStatus: CommentaryApi['setTabStatus'];
  readonly settleThinking: ChatLogApi['settleThinking'];
  readonly showAside: CommentaryApi['showAside'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly sides: SidePanelApi['sides'];
  readonly socialReport: OtherRobotsApi['socialReport'];
  readonly startCompact: BrainApi['startCompact'];
  readonly state: RobotState;
  readonly tabs: Map<string, ChatTab>;
  readonly takeBack: ComposerApi['takeBack'];
  readonly terminalState: RemoteControlApi['terminalState'];
  readonly thinkRow: ChatLogApi['thinkRow'];
  readonly tickNoteChip: QuickActionsApi['tickNoteChip'];
  readonly toolLook: ChatLogApi['toolLook'];
  readonly toolPics: ChatLogApi['toolPics'];
  readonly takeBriefs: BriefsApi['takeBriefs'];
  readonly waitForBriefs: BriefsApi['waitForBriefs'];
};

export function createAsking(r: AskingNeeds) {
  function setBusy(tab: ChatTab, busy: boolean) {
    tab.busy = busy;
    clearInterval(tab.verbs);
    if (busy) {
      Object.assign(tab, { turnStart: Date.now(), outTokens: 0, outChars: 0 });
      tab.activity = 'think';
      if (r.animates(tab)) r.setActivity(r.helpersOut() ? 'helpers' : 'think'); // keep supervising helpers still out
      r.setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      tab.verbs = setInterval(() => {
        if (!tab.current?.toolStatus) r.setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      }, 2800);
    } else {
      r.setTabStatus(tab, '');
    }
    syncChrome();
    r.renderTabs();
    r.renderFace();
  }

  // composer, send button and antenna follow the tabs' state
  function syncChrome() {
    const t = r.active();
    r.body.classList.toggle('busy', !!t?.busy);
    $('#send').innerHTML = Icon(t?.busy ? 'stop' : 'send');
    $('#send').title = t?.busy ? 'Stop' : 'Send (Enter)';
    if (!r.state.busy) r.body.classList.remove('thinking', 'talking');
    else if (!r.body.classList.contains('talking')) r.body.classList.add('thinking');
    r.setStatus(t?.statusText || '');
  }

  async function submit({ again = false, tag = '' } = {}) {
    const tab = r.current();
    // briefs still being written (@#tab): the message waits for them
    if (r.state.briefs.some((b) => b.text === null)) {
      if (!(await r.waitForBriefs()) || r.active() !== tab) return;
    }
    const text = r.input.value.trim();
    // an edited question: the old one (and its answer) goes first, then this is asked in its place
    if (r.composerPart.editing && r.composerPart.editing.tab === tab && !tab.busy && !again) {
      if (!text) return;
      if (!(await r.takeBack(tab))) return;
      const draft = r.composerPart.editing?.draft ?? '';
      r.composerPart.editing = null;
      r.editBanner.hidden = true;
      tab.draft = draft;
    }
    if (tab.busy) {
      // while working: app commands still run, empty Enter stops, anything else waits its turn
      if (!text && !r.state.attachments.length) ipc.robotCancel(tab.id);
      else if (r.runLocalCommand(text)) {
        r.input.value = '';
        r.autosize();
        r.hidePalette();
      } else if (tab.question && !tab.question.sent) {
        r.answerFromComposer(text);
      } else queueQuestion(tab, text, tag);
      return;
    }
    if (!text && !r.state.attachments.length) return;
    r.state.lastActivity = Date.now();
    r.input.value = '';
    r.autosize();

    r.hidePalette();
    if (r.runLocalCommand(text)) return;

    const files = r.state.attachments;
    r.state.attachments = [];
    const briefs = r.takeBriefs(tab);
    r.renderAttachments();
    const question = text || (files.length === 1 ? 'Take a look at this.' : 'Take a look at these.');
    tab.vocabWord = r.askedWord(text); // "what does X mean?": offer to save X under the answer
    for (const el of tab.log.querySelectorAll('.greet')) el.remove();
    r.clearFinishedHelpers(tab);
    r.addUser(question, files, tab, tag, briefs).classList.add('enter');
    r.sentOf(tab).push(question);
    tab.rewinding = false;
    r.composerPart.recallAt = -1;
    if (!tab.custom && tab.title === 'New chat') {
      const t = question.replace(/\s+/g, ' ').trim();
      tab.title = t.length > 28 ? `${t.slice(0, 27)}…` : t;
    }
    Sfx.key.send();
    r.flash('hop', 600);
    const turnId = uid();
    startReply(tab);
    tab.current.turnId = turnId;
    tab.current.ask = { question, paths: files.map((f) => f.path), briefs };
    setBusy(tab, true);

    const res = await ipc.robotAsk(
      tab.id,
      question,
      files.map((f) => f.path),
      turnId,
      undefined,
      tag || undefined,
      briefs,
    );
    if (!res.ok) r.onEvent({ type: 'fail', tabId: tab.id, turnId, message: res.error });
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Typed while the robot is still answering: it waits its turn (or jumps the queue with ⚡).
  async function queueQuestion(tab: ChatTab, text: string, tag = '') {
    const files = r.state.attachments;
    r.state.attachments = [];
    const briefs = r.takeBriefs(tab);
    r.renderAttachments();
    r.input.value = '';
    r.autosize();
    r.hidePalette();
    const question = text || 'Take a look at this.';
    const turnId = uid();
    const el = r.addUser(question, files, tab, tag, briefs);
    r.sentOf(tab).push(question);
    r.composerPart.recallAt = -1;
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
    tab.queue.push({ turnId, el, ask: { question, paths: files.map((f) => f.path), briefs } });
    Sfx.key.send();
    r.flash('hop', 600);
    r.express('happy', 'o', 900);
    r.showPop(pick(['📨 Noted! Next up.', 'Got it, right after this!', 'Queued! ✍️']), 1800);
    const res = await ipc.robotAsk(
      tab.id,
      question,
      files.map((f) => f.path),
      turnId,
      undefined,
      tag || undefined,
      briefs,
    );
    if (!res.ok) {
      dropQueued(tab, turnId, 'not sent');
      r.addNote(`📨 ${res.error}`, '', tab);
    }
  }

  function dropQueued(tab: ChatTab, turnId: string, why: string) {
    const i = tab.queue.findIndex((q) => q.turnId === turnId);
    if (i < 0) return;
    const [q] = tab.queue.splice(i, 1);
    q.el.classList.remove('queued');
    q.el.classList.add('dropped');
    Icon.text($('.queue-actions', q.el), `📭 ${why}`);
  }

  // Stop: interrupt the answer (the conversation carries on); queued messages are returned
  function stopTab(tab: ChatTab | undefined) {
    if (!tab?.busy) return;
    ipc.robotCancel(tab.id);
    r.express('o', 'o', 900);
    r.showPop(pick(['Okay, stopping!', 'Halting!', 'Brakes on! 🛑']), 1500);
  }

  // an empty bot bubble that the next streamed reply fills in
  function startReply(tab: ChatTab): asserts tab is ChatTab & { current: Reply } {
    const el = document.createElement('div');
    el.className = 'msg bot enter';
    tab.log.appendChild(el);
    tab.current = { el, parts: [], text: '' };
    partFor(tab.current, 'text'); // (its blinking caret, until the first words or step)
    r.scrollDown(tab);
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
  const partText = (cur: Reply, p: TextPart) =>
    cur.text.slice(Math.max(p.from, cur.offset || 0), p.to ?? cur.text.length);
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
  function finishText(
    cur: Reply,
    { text = '', note = '', empty = '' }: { text?: string; note?: string; empty?: string } = {},
  ) {
    for (const p of cur.parts) if (p.kind === 'text') p.el.innerHTML = r.md(partText(cur, p));
    const said = cur.parts.filter((p) => p.kind === 'text' && partText(cur, p).trim()) as TextPart[]; // (text parts only)
    const lastText = said[said.length - 1];
    if (!said.length && (text || note || empty)) {
      const p = partFor(cur, 'text');
      p.el.innerHTML = r.md(text ? `${text}${note ? `\n\n${note}` : ''}` : note || empty);
    } else if (note && lastText) lastText.el.innerHTML = r.md(`${partText(cur, lastText)}\n\n${note}`);
    for (const p of cur.parts) p.el.classList.remove('cursor');
    r.dedupePics(cur.el);
  }

  function renderCurrent(tab: ChatTab) {
    if (tab.renderQueued) return;
    tab.renderQueued = true;
    requestAnimationFrame(() => {
      tab.renderQueued = false;
      const cur = tab.current;
      if (!cur) return;
      // (only the words still coming: the parts before them are done)
      const last = cur.parts[cur.parts.length - 1];
      if (last?.kind === 'text') last.el.innerHTML = r.md(partText(cur, last));
      r.dedupePics(cur.el);
      r.scrollDown(tab);
    });
  }

  function finishCurrent(tab: ChatTab) {
    const cur = tab.current;
    tab.current = null;
    r.settleThinking(tab);
    // (a step still showing as running when the answer ended: it was cut short)
    for (const row of tab.log.querySelectorAll<HTMLElement>('.step.running')) row.classList.remove('running');
    // (and its runs of steps are done: as they were, folded unless you opened one)
    for (const run of tab.log.querySelectorAll<HTMLElement>('.tools.live')) {
      run.classList.remove('live');
      r.foldSteps(run);
    }
    if (cur) for (const p of cur.parts) p.el.classList.remove('cursor');
    setBusy(tab, false);
    // the task you sent is over: if you tucked the chat away, the status bubble says so — unless a bonk restarts it
    if (r.state.collapsed && !tab.bonk) {
      r.state.news = '✅ Done! Click to read the answer';
      r.renderWorking();
    }
    if (!tab.bonk) {
      tab.hurried = false;
      if (![...r.tabs.values()].some((t) => t.hurried)) r.deskState.hurry = '';
    }
    return cur;
  }

  return {
    asideRow,
    dropQueued,
    finishCurrent,
    finishText,
    hasSteps,
    moveReply,
    partFor,
    queueQuestion,
    renderCurrent,
    setBusy,
    startReply,
    stopTab,
    submit,
    syncChrome,
    uid,
  };
}
export type AskingApi = ReturnType<typeof createAsking>;
