// Quick actions on text you selected (main quickWindow.js): while Claude refines or sums
// it up the robot writes on its pad, while it translates or explains it leafs through
// its dictionary; a little hop when the answer goes back into your app. Asleep or out
// for a walk, it lets you get on with it.
// (robot.ts calls createQuickActions with its hub.)
import { ROBOT_H, ROBOT_W } from '@/views/robot/constants';
import { pick } from '@/lib/random';
import type { OtherRobotsApi } from '@/features/robots/reactions';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { IdleAnticsApi } from '@/views/robot/life/antics';
import type { ComposerApi } from '@/features/chat/composer/composer';
import type { VocabApi } from '@/features/vocab/robot';
import type { NotesApi } from '@/features/notes/robot';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { FaceApi } from '@/views/robot/life/face';
import type { TabsApi } from '@/features/chat/tabs';
import type { RobotMessagesApi } from '@/features/robots/link/asks';
import type { PlayApi } from '@/views/robot/life/play';
import type { PokingApi } from '@/views/robot/life/poke';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { Office3DView } from '@/office3d';
import type { OfficeData } from '@/office3d/protocol';
import type { Events } from '@/types/ipc';
import type { Point, VocabEvent } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type QuickActionsNeeds = {
  readonly current: () => ChatTab;
  readonly activeId: string | null;
  readonly antic: IdleAnticsApi['antic'];
  readonly autosize: ComposerApi['autosize'];
  readonly awayClick: IdleAnticsApi['awayClick'];
  readonly backToDesk: IdleAnticsApi['backToDesk'];
  readonly body: HTMLElement;
  readonly canAct: VocabApi['canAct'];
  readonly canActNotes: NotesApi['canActNotes'];
  readonly collapse: LifeCycleApi['collapse'];
  readonly cue: IdleAnticsApi['cue'];
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly fromMeeting: IdleAnticsApi['fromMeeting'];
  readonly goneWalking: IdleAnticsApi['goneWalking'];
  readonly haveTreat: OtherRobotsApi['haveTreat'];
  readonly idleAnticsPart: IdleAnticsApi;
  readonly input: HTMLTextAreaElement;
  readonly islandReport: LifeCycleApi['islandReport'];
  readonly islandReportAgain: LifeCycleApi['islandReportAgain'];
  readonly newTab: TabsApi['newTab'];
  readonly notesPart: NotesApi;
  readonly office: Office3DView;
  readonly onLink: RobotMessagesApi['onLink'];
  readonly onNotes: NotesApi['onNotes'];
  readonly onSocial: OtherRobotsApi['onSocial'];
  readonly openChat: LifeCycleApi['openChat'];
  readonly peek: LifeCycleApi['peek'];
  readonly playWith: PlayApi['playWith'];
  readonly pokingPart: PokingApi;
  readonly quip: IdleAnticsApi['quip'];
  readonly QUIZ_LINES: VocabApi['QUIZ_LINES'];
  readonly READ_AT_LEAST: VocabApi['READ_AT_LEAST'];
  readonly readDeskPlane: OtherRobotsApi['readDeskPlane'];
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly robot: HTMLElement;
  readonly sayWord: VocabApi['sayWord'];
  readonly setSight: VocabApi['setSight'];
  readonly setVocabCount: VocabApi['setVocabCount'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly socialReport: OtherRobotsApi['socialReport'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly toMeeting: IdleAnticsApi['toMeeting'];
  readonly unpeek: LifeCycleApi['unpeek'];
  readonly vocabPart: VocabApi;
  readonly vocabReady: VocabApi['vocabReady'];
  readonly wake: LifeCycleApi['wake'];
  readonly wordOf: VocabApi['wordOf'];
};

export function createQuickActions(rw: QuickActionsNeeds) {
  // (robots/link/tasks.ts)

  // Quick actions on text you selected (main quickWindow.js): while Claude refines or sums
  // it up the robot writes on its pad, while it translates or explains it leafs through
  // its dictionary; a little hop when the answer goes back into your app. Asleep or out
  // for a walk, it lets you get on with it.
  const QUICK_ANTICS = ['notewrite', 'dictionary'];
  let quickSince = 0;
  function onQuick(ev: Events['robot:quick']) {
    if (rw.state.away) return;
    const free = rw.state.awake && rw.canActNotes();
    switch (ev.phase) {
      case 'start':
        if (!free) break;
        if (!QUICK_ANTICS.includes(rw.deskState.antic ?? '')) {
          rw.stopAntic();
          rw.antic(ev.action === 'refine' || ev.action === 'summarise' ? 'notewrite' : 'dictionary');
          quickSince = Date.now();
        }
        if (Math.random() < 0.6) rw.showPop(rw.quip('quickStart') || 'On it! ✍️', 1400);
        break;
      case 'done':
      case 'fail':
        // (it writes for a moment at least, even when the answer is quick)
        setTimeout(
          () => {
            if (QUICK_ANTICS.includes(rw.deskState.antic ?? '')) rw.stopAntic();
            if (!rw.state.awake) return;
            if (ev.phase === 'done') rw.express('happy', 'smile', 1000);
            else {
              rw.express('flat', 'o', 1400);
              rw.showPop("Hmm, that didn't work.", 1800);
            }
          },
          Math.max(0, 900 - (Date.now() - quickSince)),
        );
        break;
      case 'replaced':
        if (!free) break;
        rw.flash('hop', 600);
        Sfx.key.done();
        rw.showPop(rw.quip('quickDone') || 'Done! ✨', 1500);
        break;
      case 'copied':
        if (rw.state.awake) rw.showPop('Copied! 📋', 1200);
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
      ? rw.state.away
        ? '🔨 (out for a walk)'
        : rw.state.awake
          ? '🔨 Bonk!'
          : '🔨 Bonk me awake'
      : kind === 'plug'
        ? rw.state.away
          ? '🔌 (out for a walk)'
          : '🔌 Charge my battery'
        : rw.notesPart.board.total
          ? `📋 ${rw.notesPart.board.total} note${rw.notesPart.board.total === 1 ? '' : 's'}: click to open`
          : '📋 Notes: all clear (click to add one)';
  function clearPropHover() {
    rw.deskState.propHover = '';
    rw.robot.classList.remove('over-prop');
    boardLabel.classList.remove('show');
  }
  // (Windows may not tell a transparent window the mouse left: robot:cursor is the backstop)
  function propCursor(c: Point) {
    if (!rw.deskState.propHover) return;
    const s = rw.state.scale || 1;
    if (c.x < -6 || c.y < -6 || c.x > ROBOT_W * s + 6 || c.y > ROBOT_H * s + 6) clearPropHover();
  }
  let boardRaf = 0;
  rw.robot.addEventListener('mousemove', (e) => {
    if (boardRaf) return;
    boardRaf = requestAnimationFrame(() => {
      boardRaf = 0;
      // a word's sticky note on the monitor: it zooms up to read (office3d scene.js stickies)
      const note = (!rw.pokingPart.held && rw.office.stickyAt?.(e.clientX, e.clientY)) || null;
      rw.deskState.stickyHover = note?.kind === 'vocab' ? note.id : '';
      rw.robot.classList.toggle('over-sticky', note?.kind === 'vocab');
      const hit = !rw.pokingPart.held && rw.office.propAt?.(e.clientX, e.clientY);
      if (!hit) return clearPropHover();
      const kind = hit.kind === 'note' ? 'board' : hit.kind;
      rw.deskState.propHover = kind;
      rw.robot.classList.add('over-prop');
      const r = rw.robot.getBoundingClientRect();
      Icon.text(boardLabel, propLabel(kind));
      boardLabel.style.left = `${e.clientX - r.left}px`;
      boardLabel.style.top = `${e.clientY - r.top}px`;
      boardLabel.classList.add('show');
    });
  });
  rw.robot.addEventListener('mouseleave', () => {
    rw.deskState.stickyHover = '';
    rw.robot.classList.remove('over-sticky');
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
    const w = rw.wordOf(ev.word);
    switch (ev.phase) {
      case 'count':
        // a card on its way into the box lands first
        clearTimeout(rw.vocabPart.countLater);
        if (rw.deskState.antic === 'word-show')
          rw.vocabPart.countLater = setTimeout(
            () => rw.setVocabCount(ev.count),
            Math.max(0, rw.idleAnticsPart.anticUntil - 300 - Date.now()),
          );
        else rw.setVocabCount(ev.count);
        break;
      case 'empty':
        if (!rw.vocabReady()) return;
        rw.express('flat', 'o', 1400);
        rw.showPop(`Select a word, then ${ev.hotkey}!`, 3000);
        break;
      case 'too-long':
        if (!rw.vocabReady()) return;
        rw.express('dizzy', 'o', 1400);
        rw.showPop('Too long! Just a word or two.', 2600);
        break;
      case 'catch':
        if (!rw.vocabReady()) return;
        Sfx.key.ooh();
        rw.flash('hop', 600);
        rw.express('happy', 'o', 900);
        rw.showPop(`Ooh, “${w}”!`, 2400);
        rw.state.news = `📖 Looking up “${w}”…`;
        rw.renderWorking();
        if (rw.canAct()) {
          rw.stopAntic();
          rw.antic('dictionary', w);
          rw.vocabPart.leafingSince = Date.now();
        }
        break;
      case 'found':
      case 'known': {
        const wait =
          rw.deskState.antic === 'dictionary' ? rw.READ_AT_LEAST - (Date.now() - rw.vocabPart.leafingSince) : 0;
        if (wait > 0) return void setTimeout(() => onVocab(ev), wait);
        rw.state.news = `📚 “${w}” is in your words`;
        rw.renderWorking();
        if (!rw.vocabReady()) return;
        const vi = ev.word?.senses?.[0]?.vi || '';
        if (rw.canAct()) {
          rw.antic('word-show', w);
          rw.cue(0.3, () => Sfx.whee());
          rw.cue(3.9, () => Sfx.pop());
        }
        Sfx.key.done();
        rw.sayWord(w);
        setTimeout(
          () => rw.showPop(ev.phase === 'known' ? `Already got “${w}”!` : vi ? `${w}: ${vi}` : `Got it: ${w}!`, 4200),
          900,
        );
        break;
      }
      case 'failed':
        rw.state.news = '';
        rw.renderWorking();
        if (rw.deskState.antic === 'dictionary') rw.stopAntic();
        if (!rw.vocabReady()) return;
        Sfx.key.oops();
        rw.express('dizzy', 'flat', 1600);
        rw.showPop("My dictionary's stuck!", 2600);
        break;
      case 'sight':
        rw.setSight(ev.words);
        break;
      case 'reading':
        // the box you dragged round a word: it squints at it while Claude reads it
        if (!rw.vocabReady()) return;
        Sfx.key.ooh();
        rw.express('happy', 'o', 1200);
        rw.showPop('Ooh, let me read that… 🔍', 2400);
        rw.state.news = '🔍 Reading the word in your box…';
        rw.renderWorking();
        if (rw.canAct()) {
          rw.stopAntic();
          rw.antic('dictionary', '…');
        }
        break;
      case 'unreadable':
        rw.state.news = '';
        rw.renderWorking();
        if (rw.deskState.antic === 'dictionary') rw.stopAntic();
        if (!rw.vocabReady()) return;
        Sfx.key.oops();
        rw.express('dizzy', 'flat', 1600);
        rw.showPop("I can't find a word in there!", 2600);
        break;
      case 'quiz':
        // a reminder (main/reminders.js): it holds up the word, the card asks you
        if (!rw.vocabReady()) return;
        rw.vocabPart.quizWord = ev.word;
        Sfx.key.ooh();
        rw.flash('hop', 600);
        rw.express('happy', 'o', 900);
        rw.showPop(pick(rw.QUIZ_LINES).replace('{w}', w), 3600);
        rw.state.news = `🃏 Do you remember “${w}”?`;
        rw.renderWorking();
        if (rw.canAct()) {
          rw.stopAntic();
          rw.antic('quiz-card', w);
        }
        break;
      case 'answered': {
        rw.vocabPart.quizWord = null;
        rw.state.news = '';
        rw.renderWorking();
        if (rw.deskState.antic === 'quiz-card') rw.stopAntic();
        if (!rw.state.awake) return;
        if (ev.how === 'knew') {
          Sfx.key.done();
          rw.flash('hop', 600);
          rw.strikePose('cheer', 1400);
          rw.express('happy', 'smile', 1800);
          rw.showPop(pick(['Yes! 🎉', 'You got it! ✨', 'Nailed it!', 'Smart cookie! 🍪']), 2200);
        } else if (ev.how === 'forgot') {
          rw.express('flat', 'smile', 1600);
          rw.showPop(pick([`No worries, “${w}” comes back soon!`, `We'll get “${w}” next time!`]), 2600);
        } else if (ev.how === 'later') {
          rw.express('happy', 'smile', 1000);
          rw.showPop('OK, later! ⏰', 1600);
        }
        break;
      }
      case 'dream': {
        // a word that's due: it dreams of it (on its monitor) and mumbles it; the dream
        // bubble beside it shows the meaning and an example
        if (rw.state.awake || rw.state.away) break;
        rw.stopAntic();
        rw.antic('dream', w);
        rw.cue(1.2, () => rw.express('closed', 'talk', 2200));
        rw.cue(1.3, () => Sfx.hmm?.());
        break;
      }
      case 'knowit':
        // ✓ I know this one, from its dream: a sleepy little smile
        if (!rw.state.awake) rw.express('closed', 'smile', 1800);
        break;
      case 'milestone': {
        // 10 words learnt, a week-long streak…: a dance party, after its reaction to the answer
        setTimeout(() => {
          if (!rw.vocabReady()) return;
          if (rw.canAct()) rw.playWith('dance');
          setTimeout(
            () => rw.showPop(ev.learnt ? `🎓 ${ev.learnt} words learnt!` : `🔥 ${ev.streak} days in a row!`, 3000),
            600,
          );
          if (ev.unlocked) setTimeout(() => rw.showPop('New hat in the Workshop! 🎓', 3200), 3800);
        }, 2600);
        break;
      }
      case 'undone':
        if (!rw.state.awake) return;
        rw.express('flat', 'smile', 1200);
        rw.showPop(`OK, “${w}” is gone.`, 1800);
        break;
      case 'ask': {
        // the card's 💬 Ask more: the question waits in the chat for you to send
        if (rw.state.away) return rw.awayClick();
        if (!rw.state.awake) rw.wake({ sayHi: false });
        else rw.openChat();
        const vi = ev.word?.senses?.[0]?.vi;
        const fill = () => {
          rw.input.value = `Tell me more about the English word “${w}”${vi ? ` (${vi})` : ''}: when and how is it used, its common collocations, and similar words and how they differ. Answer in Vietnamese, with English examples.`;
          rw.autosize();
          rw.input.focus();
        };
        // in a tab of its own, unless this one is still empty
        if (rw.current().busy || rw.current().log.querySelector('.msg.user, .msg.bot'))
          rw.newTab().then(() => setTimeout(fill, 250));
        else fill();
        break;
      }
    }
  }
  ipc.on('robot:vocab', onVocab);
  ipc.on('robot:notes', rw.onNotes);
  ipc.on('robot:quick', onQuick);
  ipc.on('robot:social', rw.onSocial);
  ipc.on('robot:link', rw.onLink);
  let binEmptied = ''; // the day the housemaid emptied its bin (it fills up again overnight)
  setInterval(() => {
    rw.socialReport();
    rw.islandReportAgain(); // (in case the island was away when it last said)
    if (binEmptied && binEmptied !== new Date().toDateString()) {
      binEmptied = '';
      rw.deskState.binEmpty = '';
    }
    rw.readDeskPlane(); // (a plane on its desk, read once it's free)
    rw.haveTreat(); // (food or milk tea that came, had once it's free)
  }, 5000);
  setTimeout(() => rw.socialReport(), 1500);

  ipc.on('robot:action', (action) => {
    if (action === 'peek') rw.peek();
    else if (action === 'unpeek') rw.unpeek();
    else if (action === 'chat') {
      // (the island: out, and its chat open)
      rw.unpeek();
      if (!rw.state.awake) rw.wake();
      else rw.openChat();
    } else if (action === 'wake-tucked') rw.wake({ sayHi: false, tucked: true });
    else if (action === 'tuck')
      rw.collapse(); // (off the stage: back at its desk, still at work) // (main groupChat.js: the chat stays put away)
    else if (action === 'meeting') rw.toMeeting();
    else if (action === 'meeting-end') rw.fromMeeting();
    else if (action === 'reset') ipc.robotReset(rw.activeId ?? undefined);
    else if (action === 'handoff') rw.goneWalking();
    else if (action === 'dock' || String(action).startsWith('dock:')) {
      const [x, y] = String(action).slice(5).split(',').map(Number);
      rw.backToDesk({ feet: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    } else if (action === 'dock-hover') rw.body.classList.add('dock-target');
    else if (action === 'dock-leave') rw.body.classList.remove('dock-target');
  });
  return {
    propCursor,
    saveWordChip,
    tickNoteChip,
    get binEmptied() {
      return binEmptied;
    },
    set binEmptied(v) {
      binEmptied = v;
    },
  };
}
export type QuickActionsApi = ReturnType<typeof createQuickActions>;
