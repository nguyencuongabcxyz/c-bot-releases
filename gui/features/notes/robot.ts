// Your notes (main notes.js): the corkboard on the desk shows the open ones
// (data-board), the robot pins new ones up and tosses done ones in the bin, holds the
// board up for the start- and end-of-day reminders, clocks out after the evening one,
// and takes a note on in a chat when you ask Claude about it.
// (robot.ts calls createNotes with its hub.)
import type { CommentaryApi } from '@/features/chat/reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { IdleAnticsApi } from '@/views/robot/life/antics';
import type { ComposerApi } from '@/features/chat/composer/composer';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { AskingApi } from '@/features/chat/reply/ask';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { writeJson, type OfficeData } from '@/office3d/protocol';
import type { NotesBoard, NotesEvent, NotesReminder } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type NotesNeeds = {
  readonly current: () => ChatTab;
  readonly activeId: string | null;
  readonly addNote: CommentaryApi['addNote'];
  readonly antic: IdleAnticsApi['antic'];
  readonly autosize: ComposerApi['autosize'];
  readonly cue: IdleAnticsApi['cue'];
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly input: HTMLTextAreaElement;
  readonly lookAt: DeskActivityApi['lookAt'];
  readonly openChat: LifeCycleApi['openChat'];
  readonly held: boolean;
  readonly quip: IdleAnticsApi['quip'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly sleep: LifeCycleApi['sleep'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly submit: AskingApi['submit'];
  readonly wake: LifeCycleApi['wake'];
};

export function createNotes(rw: NotesNeeds) {
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
    writeJson(rw.deskState, 'board', b);
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
  const canActNotes = () =>
    !rw.state.away && !rw.state.busy && !rw.helpersOut() && !rw.state.mirroring && !rw.held && !rw.state.playing;

  function onNotes(ev: NotesEvent) {
    switch (ev.phase) {
      case 'board':
        setBoard(ev.board);
        break;
      case 'added': {
        // it writes it on a sticky and pins it up (asleep: half-awake, eyes shut, mumbling)
        if (!canActNotes()) {
          if (rw.state.awake && !rw.state.away) rw.showPop(rw.quip('noted') || 'Noted! 📝', 1400);
          break;
        }
        if (!rw.state.awake && rw.deskState.sleepStyle === 'floor') {
          // asleep on the floor it can't reach the board: it just mumbles it
          rw.stopAntic();
          rw.antic('mumble', '…noted…');
          break;
        }
        holdBoardFor(1.25);
        rw.stopAntic();
        rw.antic('notepin', rw.state.awake ? '' : '…noted…');
        if (!rw.state.awake) rw.express('closed', 'talk', 1800);
        rw.cue(1.25, () => Sfx.key.pop());
        if (rw.state.awake) rw.cue(1.4, () => rw.showPop(rw.quip('noted') || 'Noted! 📝', 1500));
        break;
      }
      case 'done': {
        // it takes that sticky down, crumples it and bins it; the last one: all clear!
        if (!canActNotes() || !rw.state.awake) break;
        holdBoardFor(0.6);
        rw.stopAntic();
        rw.antic('notetoss', ev.note?.id || '');
        rw.cue(1.4, () => Sfx.swish());
        rw.cue(2.1, () => {
          Sfx.key.pop();
          rw.express('happy', 'smile', 900);
        });
        if (ev.left === 0) {
          setTimeout(() => {
            if (!canActNotes() || !rw.state.awake) return;
            rw.antic('allclear');
            Sfx.key.done();
            rw.express('happy', 'wide', 1600);
            rw.showPop(rw.quip('allclear') || 'All clear! ✨', 1800);
          }, 2900);
        }
        break;
      }
      case 'opened':
        if (rw.state.awake && canActNotes()) rw.express('happy', 'smile', 900);
        break;
      case 'writing':
        // you're typing a note: it writes it down on a sticky pad (antics/notes.js notewrite)
        if (ev.on) {
          if (!rw.state.awake || !canActNotes() || rw.deskState.antic === 'notewrite') break;
          rw.stopAntic();
          rw.antic('notewrite');
          rw.express('happy', 'smile', 1200);
        } else if (rw.deskState.antic === 'notewrite') rw.stopAntic();
        break;
      case 'remind':
        remindNotes(ev.kind, ev.info || {});
        break;
      case 'clockout':
        // the end-of-day look is done: a big stretch and a yawn, and off to sleep
        if (!rw.state.awake || !canActNotes()) break;
        rw.stopAntic();
        rw.antic('clockout');
        rw.cue(0.3, () => rw.express('closed', 'o', 1300));
        rw.cue(0.6, () => rw.showPop(rw.quip('notesClockout') || 'Good work today! 😴', 1600));
        rw.cue(2.45, () => rw.state.collapsed && rw.sleep({ auto: true })); // (with its chat open it stays up)
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
    const line = `${rw.quip(kind === 'morning' ? 'notesMorning' : 'notesEvening') || (kind === 'morning' ? 'Morning! Your notes:' : 'Before you go: your notes!')}${info.open ? ` (${info.open} open)` : ''}`;
    const open = () => ipc.notesRemindOpen({ kind, info: { ...info, line } });
    if (rw.state.away) {
      ipc.robotWalker('wave');
      return open();
    }
    if (!rw.state.awake) rw.wake({ sayHi: false, tucked: true });
    setTimeout(
      () => {
        rw.stopAntic();
        rw.antic('boardlift');
        Sfx.ask();
        rw.cue(0.9, () => {
          rw.express('open', 'talk', 1400);
          rw.showPop(line, 2600);
        });
        rw.cue(2.6, open);
        setTimeout(() => rw.state.away || (rw.deskState.antic !== 'boardlift' && open()), 3600); // (if it got cut short)
      },
      rw.state.awake ? 0 : 900,
    );
    return counts;
  }

  // Clicked the board (or a sticky on it): the notebook, beside it. The robot glances over.
  function openNotesFromBoard(hit: { kind: string; id?: string }) {
    ipc.notesOpen({ focus: hit.kind === 'note' ? hit.id : null });
    if (rw.state.awake && canActNotes()) rw.lookAt(-260, 40, 1200);
  }

  // "Ask Claude" about a note, or "Summarise my day": a new chat tab with it, sent straight away
  // (draft: typed in for you to finish, not sent)
  async function askInNewTab(prompt: string, noteId = '', { draft = false } = {}) {
    if (!prompt) return;
    if (!rw.state.awake) rw.wake({ sayHi: false });
    else rw.openChat();
    const before = rw.activeId;
    const res = await ipc.robotTabNew();
    if (res.ok) {
      for (let i = 0; i < 60 && rw.activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const tab = rw.current();
    if (!res.ok && tab.busy) {
      rw.showPop(res.error, 2200);
      if (noteId) ipc.notesAct('working', { id: noteId, working: false });
      return;
    }
    if (!res.ok && rw.activeId === before) rw.addNote('📑 No free tab: asking here.', '', tab);
    tab.noteId = noteId;
    rw.input.value = prompt;
    if (draft) {
      rw.autosize();
      rw.input.focus();
      rw.input.setSelectionRange(rw.input.value.length, rw.input.value.length);
      return;
    }
    await rw.submit();
  }
  return {
    canActNotes,
    onNotes,
    openNotesFromBoard,
    setBoard,
    get board() {
      return board;
    },
    set board(v) {
      board = v;
    },
  };
}
export type NotesApi = ReturnType<typeof createNotes>;
