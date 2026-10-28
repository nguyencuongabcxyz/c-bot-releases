// What a conversation reports as it happens (main's robot:event: ChatEvent in @/types/model.ts),
// one function per kind. HANDLERS names every kind, so a new one has to be handled here.
// (robot.ts calls createChatEvents with its hub; the reply being streamed is built by reply/ask.ts.)
import { pick } from '@/lib/random';
import { Sfx } from '@/views/robot/sound';
import type { Ask, ChatTab, Reply, ToolCall } from '@/views/robot/types';
import type { AskingApi } from './reply/ask';
import * as ipc from '@/ipc';
import type { RobotEvent } from '@/types/model';

type Ev<K extends RobotEvent['type']> = Extract<RobotEvent, { type: K }>;
/** Where it happened: the tab, the answer being streamed there, and whether you're watching. */
type At = { tab: ChatTab; cur: Reply | null; show: boolean };

/** What it uses of the robot window (robot.ts's hub). */
export type ChatEventsNeeds = Omit<import('./reply/ask').AskingNeeds, 'onEvent'> &
  Pick<
    AskingApi,
    | 'asideRow'
    | 'dropQueued'
    | 'finishCurrent'
    | 'finishText'
    | 'hasSteps'
    | 'partFor'
    | 'renderCurrent'
    | 'setBusy'
    | 'startReply'
  >;

export function createChatEvents(r: ChatEventsNeeds) {
  let quiet = 0; // (the timer that stops the talking face once the words pause)
  // (an assertion function is called by a name with its type written out)
  const startReply: AskingApi['startReply'] = r.startReply;

  function onTurnStart(ev: Ev<'turn-start'>, { tab }: At) {
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
      r.startCompact(tab);
      return;
    }
    if (tab.current?.turnId !== ev.turnId) {
      startReply(tab);
      tab.current.turnId = ev.turnId;
      if (asked) tab.current.ask = asked;
    }
    if (!tab.busy) r.setBusy(tab, true);
    Object.assign(tab, { turnStart: Date.now(), outTokens: 0, outChars: 0 }); // (the status line counts this turn)
    if (tab.hurried) r.setTabStatus(tab, '🔨 Hurrying…');
  }

  function onDropped(ev: Ev<'dropped'>, { tab }: At) {
    for (const t of ev.turnIds) r.dropQueued(tab, t, 'not sent (stopped)');
  }

  function onTasks(ev: Ev<'tasks'>, { tab }: At) {
    r.onTasks(tab, ev);
  }

  function onAgent(ev: Ev<'agent'>, { tab }: At) {
    r.onAgent(tab, ev);
  }

  function onContext(ev: Ev<'context'>, { tab }: At) {
    tab.context = ev.context;
    if (tab === r.active()) r.renderBrain();
  }

  function onCompact(ev: Ev<'compact'>, { tab }: At) {
    if (ev.phase === 'start') r.startCompact(tab);
    else tab.compactResult = ev;
  }

  function onThinking(_ev: Ev<'thinking'>, { tab, show }: At) {
    tab.activity = 'think';
    if (!show) return;
    r.body.classList.add('thinking');
    if (r.state.activity !== 'talk') r.setActivity('think');
  }

  function onThinkingText(ev: Ev<'thinking-text'>, { tab }: At) {
    const call = tab.calls?.get(ev.id);
    if (call) call.output = (call.output || '') + ev.delta;
    const box = [...tab.log.querySelectorAll<HTMLElement>('.step.think')]
      .find((d) => d.dataset.call === ev.id)
      ?.querySelector('.think-text');
    if (box) box.textContent += ev.delta;
    tab.outChars = (tab.outChars || 0) + ev.delta.length;
  }

  function onUsage(ev: Ev<'usage'>, { tab }: At) {
    tab.outTokens = ev.outputTokens;
    if (tab === r.active()) r.renderMeta();
  }

  function onRequestCancelled(ev: Ev<'request-cancelled'>, { tab }: At) {
    if (tab.question?.requestId === ev.requestId) r.expireQuestion(tab);
  }

  function onText(ev: Ev<'text'>, { tab, cur, show }: At) {
    if (!cur) return;
    r.settleThinking(tab);
    tab.outChars = (tab.outChars || 0) + ev.delta.length;
    // the moment words start flowing after some work: lightbulb!
    if (show && r.state.activity !== 'talk' && !cur.text.trim()) r.flash('idea', 1100);
    if (tab.activity !== 'talk') {
      cur.toolStatus = '💬 Writing it up';
      r.setTabStatus(tab, '💬 Writing it up…');
    }
    r.partFor(cur, 'text'); // (after some steps, the words carry on below them)
    cur.text += ev.delta;
    tab.activity = 'talk';
    if (show) {
      if (r.state.activity !== 'talk') r.setActivity('talk');
      r.body.classList.add('talking');
      r.body.classList.remove('thinking');
      r.renderFace();
      Sfx.chirp();
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        r.body.classList.remove('talking');
        if (r.state.busy) {
          r.body.classList.add('thinking');
          if (r.state.activity === 'talk') r.setActivity('think');
        }
        r.renderFace();
      }, 700);
    }
    r.renderCurrent(tab);
  }

  function onTool(ev: Ev<'tool'>, { tab, cur, show }: At) {
    if (!cur) return;
    r.settleThinking(tab);
    if (ev.name === 'Thinking') {
      const call = { id: ev.id, name: ev.name, detail: '', running: true };
      tab.calls ||= new Map<string, ToolCall>();
      tab.calls.set(ev.id, call);
      const steps = r.partFor(cur, 'steps').el;
      steps.appendChild(r.thinkRow(call));
      steps.classList.add('live');
      r.foldSteps(steps);
      r.scrollDown(tab);
      return;
    }
    const { label, activity } = r.toolLook(ev.name, ev.detail);
    // (the chip: a line icon for the kind of step, then what it did; click it for the details)
    const call = { id: ev.id, name: ev.name, detail: ev.detail, args: ev.args, running: true };
    if (ev.id) {
      tab.calls ||= new Map<string, ToolCall>();
      tab.calls.set(ev.id, call);
    }
    const chip = r.callChip(call, tab);
    if ((ev.name === 'Agent' || ev.name === 'Task') && ev.id) {
      chip.classList.add('agent-chip');
      chip.title = `${label} (click to watch it work)`;
    }
    const steps = r.partFor(cur, 'steps').el;
    steps.appendChild(chip); // (where it happened: after the words so far)
    steps.classList.add('live');
    r.foldSteps(steps);
    cur.toolStatus = label;
    tab.activity = activity;
    r.setTabStatus(tab, `${label}…`);
    if (show) {
      r.setActivity(activity);
      r.body.classList.add('thinking');
      r.body.classList.remove('talking');
      clearTimeout(quiet);
      r.renderFace();
      Sfx.tool();
    }
    r.scrollDown(tab);
  }

  function onToolOutput(ev: Ev<'tool-output'>, { tab }: At) {
    // what a step gave back: on its chip (an error shows), and in its details if they're open
    const call = tab.calls?.get(ev.id);
    if (!call) return;
    Object.assign(call, { output: ev.text, media: ev.media, isError: ev.isError, running: false });
    for (const row of tab.log.querySelectorAll<HTMLElement>('.step[data-call]')) {
      if (row.dataset.call !== ev.id) continue;
      row.classList.remove('running');
      row.classList.toggle('failed', !!ev.isError);
      r.setStepOut(row, call);
      if (row.classList.contains('open')) r.renderStepDetail(row, tab);
      if (row.parentElement) r.foldSteps(row.parentElement);
    }
    if (r.helperView.call === call) r.renderToolView();
  }

  function onEdit(ev: Ev<'edit'>, { tab, cur }: At) {
    if (!cur) return;
    r.partFor(cur, 'made').el.appendChild(r.diffCard(ev));
    r.scrollDown(tab);
  }

  /** an MCP tool's own view (e.g. an Excalidraw drawing) */
  function onApp(ev: Ev<'app'>, { tab, cur }: At) {
    if (!cur) return;
    r.partFor(cur, 'made').el.appendChild(r.appCard(ev));
    r.scrollDown(tab);
  }

  function onAppResult(ev: Ev<'app-result'>) {
    r.appResult(ev.id, ev.result);
  }

  /** pictures an MCP tool returned (a screenshot, a rendered chart) */
  function onToolImages(ev: Ev<'tool-images'>, { tab, cur }: At) {
    if (!cur) return;
    r.partFor(cur, 'made').el.appendChild(r.toolPics(ev.images));
    r.scrollDown(tab);
  }

  function onTerminal(ev: Ev<'terminal'>, { tab }: At) {
    r.terminalState(ev.state, tab);
  }

  function onMirror(ev: Ev<'mirror'>) {
    r.mirror(ev);
  }

  function onRemote(ev: Ev<'remote'>, { tab }: At) {
    r.onRemote(ev, tab);
  }

  function onRemoteState(ev: Ev<'remote-state'>, { tab }: At) {
    tab.remoteState = ev.state;
    r.renderRemote();
    return;

    // a message typed on claude.ai/code or in the Claude app: yours, from afar
  }

  function onRemotePrompt(ev: Ev<'remote-prompt'>, { tab, show }: At) {
    r.addUser(ev.text, [], tab, ev.tag);
    if (show) {
      r.flash('hop', 600);
      r.express('happy', 'o', 1200);
    }
  }

  function onQuestion(ev: Ev<'question'>, { tab }: At) {
    r.askUser(ev, tab);
  }

  function onPlan(ev: Ev<'plan'>, { tab }: At) {
    r.reviewPlan(ev, tab);
    return;

    // it went into plan mode by itself, a plan was approved, or the Workshop changed its permissions
  }

  function onMode(ev: Ev<'mode'>, { tab }: At) {
    if (!tab.busy) r.loadBrain(tab); // (and whether full access is on offer now)
    if (ev.mode === tab.mode) return;
    tab.mode = ev.mode;
    if (ev.mode === 'plan' && tab.busy)
      r.addNote('📋 I switched to plan mode to think this through first. Nothing changes until you approve.', '', tab);
    if (tab === r.active()) r.renderBrain();
  }

  function onAside(ev: Ev<'aside'>, { cur, show }: At) {
    if (cur) r.asideRow(cur).appendChild(r.asideChip(ev.text));
    if (!show) return;
    r.showAside(ev.text);
    Sfx.hmm();
    r.express(pick(['happy', 'open', 'open']), pick(['o', 'smile']), 1400);
  }

  function onStatus(ev: Ev<'status'>, { tab, cur }: At) {
    if (cur) cur.toolStatus = ev.text;
    r.setTabStatus(tab, `${ev.text}…`);
  }

  function onDone(ev: Ev<'done'>, { tab, show }: At) {
    if (ev.kind === 'compact') {
      r.finishCompact(tab);
      return;
    }
    // Claude's turn on a note is over: no more 🔧 on its sticky (a bonk's rerun carries on with it)
    if (tab.noteId && !(ev.interrupted && tab.bonk)) ipc.notesAct('working', { id: tab.noteId, working: false });
    const done = r.finishCurrent(tab);
    r.expireQuestion(tab);
    if (ev.interrupted) {
      if (done) {
        const said = done.text.slice(done.offset || 0).trim();
        const why = tab.bonk ? '🔨 restarting quicker' : 'stopped';
        r.finishText(done, {
          note: said ? `_…(${why})_` : '',
          empty: tab.bonk ? '_🔨 Restarting, quicker!_' : '_Okay, okay, I stopped._',
        });
      }
      if (tab.bonk) return; // the rerun follows straight away
      tab.noteId = '';
      if (tab.linkReq) r.linkAnswer(tab, { error: 'it was stopped before it finished' });
      if (show) r.setActivity(r.restingActivity());
      r.express('flat', 'o', 1200);
      r.renderTabs();
      return;
    }
    if (done) {
      const said = done.text.slice(done.offset || 0).trim();
      if (!said && done.asked && !r.hasSteps(done))
        done.el.remove(); // nothing more after the answer
      else r.finishText(done, { text: done.asked ? '' : ev.text, empty: '_(no words, just vibes)_' });
      if (ev.isError) done.el.classList.add('error');
      if (ev.denials?.length) done.el.appendChild(r.deniedNote(ev.denials));
      if (done.el.isConnected) {
        r.rawText.set(done.el, done.asked ? done.text.slice(done.offset || 0) : done.text || ev.text);
        r.msgActions(done.el, 'bot', tab);
        r.sides.attach(done.el, ev.at, tab); // (side questions about it go under it)
      }
      if (tab.vocabWord && !ev.isError) done.el.appendChild(r.saveWordChip(tab.vocabWord));
      tab.vocabWord = '';
      if (tab.noteId && !ev.isError) done.el.appendChild(r.tickNoteChip(tab.noteId));
    }
    tab.noteId = ''; // (the chip goes on that one answer only)
    // another robot asked this: its answer goes back to it (main robotLink.js)
    if (tab.linkReq) {
      const said = done ? (done.asked ? done.text.slice(done.offset || 0) : done.text) : '';
      r.linkAnswer(tab, ev.isError ? { error: said || ev.text || 'it hit an error' } : { text: said || ev.text || '' });
    }
    if (!ev.isError) r.socialReport({ kind: 'done' });
    if (ev.isError) r.islandNews('error', ev.text || 'It hit an error.');
    else
      r.islandNews(
        'done',
        (done ? (done.asked ? done.text.slice(done.offset || 0) : done.text) : '') ||
          ev.text ||
          `“${tab.title}” is done.`,
      );
    if (tab !== r.active()) tab.status = ev.isError ? 'error' : 'done'; // unread
    if (!show) {
      // a background tab finished while you watch another one
      Sfx.key.done();
      r.express('happy', 'o', 1200);
      r.showPop(`“${tab.title}” is done!`, 2600);
    } else if (ev.isError) {
      Sfx.key.oops();
      r.setActivity('error', 3500);
      r.express('dizzy', 'flat', 2200);
      r.showPop(pick(r.persona().oops));
    } else if (ev.denials?.length) {
      Sfx.key.oops();
      r.setActivity('locked', 3500);
      r.express('flat', 'flat', 2200);
      r.showPop('They locked me out of some tools!');
    } else {
      Sfx.key.done();
      r.setActivity('done', 2600);
      r.express('happy', 'smile', 2000);
      r.showPop(tab === r.active() ? pick(r.persona().done) : `“${tab.title}” is done!`, 2400);
    }
    if (!r.state.awake) r.body.classList.add('has-badge');
    r.scrollDown(tab);
    r.renderTabs();
    r.refreshCommands();
  }

  function onFail(ev: Ev<'fail'>, { tab, show }: At) {
    if (tab.queue.some((q) => q.turnId === ev.turnId)) {
      r.dropQueued(tab, ev.turnId, ev.cancelled ? 'not sent' : `not sent: ${ev.message}`);
      return;
    }
    if (tab.compacting) r.finishCompact(tab, ev.message);
    // a note it was asked about: no more 🔧 on its sticky (you can ask again)
    if (tab.noteId) {
      ipc.notesAct('working', { id: tab.noteId, working: false });
      tab.noteId = '';
    }
    if (tab.linkReq) r.linkAnswer(tab, { error: ev.cancelled ? 'it was stopped' : ev.message || 'it failed' });
    const done = r.finishCurrent(tab);
    r.expireQuestion(tab);
    const said = done ? done.text.slice(done.offset || 0).trim() : '';
    if (ev.cancelled) {
      if (done) r.finishText(done, { note: said ? '_…(stopped)_' : '', empty: '_Okay, okay, I stopped._' });
      if (show) r.setActivity(r.restingActivity());
      r.express('flat', 'flat', 1200);
      return;
    }
    if (show) r.setActivity('error', 3500);
    if (tab !== r.active()) tab.status = 'error';
    if (done) {
      done.el.classList.add('error');
      r.finishText(done, { note: `**Oops:** ${ev.message}` });
      r.msgActions(done.el, 'bot', tab); // (Retry: ask it again)
    } else {
      r.addBot(`**Oops:** ${ev.message}`, { error: true, tab });
    }
    Sfx.key.oops();
    r.express('dizzy', 'flat', 2500);
    r.showPop(tab === r.active() ? pick(r.persona().oops) : `“${tab.title}” hit a snag.`);
    r.islandNews('error', ev.message || 'It hit a snag.');
    if (!r.state.awake) r.body.classList.add('has-badge');
    r.renderTabs();
  }

  const HANDLERS: { [K in Exclude<RobotEvent['type'], 'side'>]: (ev: Ev<K>, at: At) => void } = {
    'turn-start': onTurnStart,
    dropped: onDropped,
    tasks: onTasks,
    agent: onAgent,
    context: onContext,
    compact: onCompact,
    thinking: onThinking,
    'thinking-text': onThinkingText,
    usage: onUsage,
    'request-cancelled': onRequestCancelled,
    text: onText,
    tool: onTool,
    'tool-output': onToolOutput,
    edit: onEdit,
    app: onApp,
    'app-result': onAppResult,
    'tool-images': onToolImages,
    terminal: onTerminal,
    mirror: onMirror,
    remote: onRemote,
    'remote-state': onRemoteState,
    'remote-prompt': onRemotePrompt,
    question: onQuestion,
    plan: onPlan,
    mode: onMode,
    aside: onAside,
    status: onStatus,
    done: onDone,
    fail: onFail,
  };

  function onEvent(ev: RobotEvent) {
    if (ev.type === 'side') return r.sides.onEvent(ev); // (a side question's answer: chat/side/threads.ts)
    const tab = r.tabs.get(ev.tabId);
    if (!tab) return;
    const at = { tab, cur: tab.current, show: r.animates(tab) };
    r.state.lastActivity = Date.now();
    // (each kind to its own handler: the table's type ties them together)
    (HANDLERS[ev.type] as (ev: RobotEvent, at: At) => void)(ev, at);
  }
  return { onEvent };
}
export type ChatEventsApi = ReturnType<typeof createChatEvents>;
