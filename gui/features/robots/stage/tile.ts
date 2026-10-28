// On the stage its window is a tile of a grid over the screen: the chat fills it (inset a
// few px, so the gap between two chats is half each window's), the robot hides and its face
// goes in the title bar. Drag a gap and main shares the room out again; drag the title bar
// onto another tile and they change places. In the spotlight it's big, the others strips
// beside it (just the latest of their chat: click one to bring it to the spotlight).
// (robot.ts calls createStage with its hub.)
import type { ComposerApi } from '@/features/chat/composer/composer';
import type { AskingApi } from '@/features/chat/reply/ask';
import type { AttachmentsApi } from '@/features/chat/composer/attachments';
import type { ChatLogApi } from '@/features/chat/log';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';
import type { StageEvent } from '@/types/ipc';
import type { FileInfo, StageTileInfo } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type StageNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly autosize: ComposerApi['autosize'];
  readonly body: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly queueQuestion: AskingApi['queueQuestion'];
  readonly renderAttachments: AttachmentsApi['renderAttachments'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly state: RobotState;
  readonly submit: AskingApi['submit'];
  readonly wake: LifeCycleApi['wake'];
};

export function createStage(r: StageNeeds) {
  // On the stage its window is a tile of a grid over the screen: the chat fills it (inset a
  // few px, so the gap between two chats is half each window's), the robot hides and its face
  // goes in the title bar. Drag a gap and main shares the room out again; drag the title bar
  // onto another tile and they change places. In the spotlight it's big, the others strips
  // beside it (just the latest of their chat: click one to bring it to the spotlight).
  let staged = false;
  const edges = [...document.querySelectorAll<HTMLElement>('.stage-edge')];
  function setStaged(tile: StageTileInfo | null, inset: number) {
    staged = !!tile;
    r.body.classList.toggle('staged', staged);
    r.body.classList.toggle('stage-spot', !!tile?.spot);
    r.body.classList.toggle('stage-strip', !!tile?.strip);
    if (!tile) r.body.classList.remove('stage-target');
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
    onDrag(edge, (e) => {
      const split = edge.dataset.split;
      if (!split) return;
      e.preventDefault();
      r.body.classList.add('resizing');
      if (!across) r.body.classList.add('resizing-v');
      ipc.stageSplit({ phase: 'start', split });
      return {
        move: ({ dx, dy }) => ipc.stageSplit({ phase: 'move', split, d: across ? dx : dy }),
        end: () => {
          r.body.classList.remove('resizing', 'resizing-v');
          ipc.stageSplit({ phase: 'end', split });
          r.scrollDown();
        },
      };
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
  onDrag(
    header,
    (e) => {
      if (!staged || onButton(e)) return;
      return {
        begin: () => {
          r.body.classList.add('swapping');
          ipc.stageSwap('start');
        },
        move: () => ipc.stageSwap('move'),
        end: ({ moved }) => {
          r.body.classList.remove('swapping');
          if (moved) ipc.stageSwap('end');
        },
      };
    },
    { threshold: 6 },
  );
  header.addEventListener('dblclick', (e) => {
    if (staged && !onButton(e)) ipc.stageTile('spot');
  });
  // a strip beside the spotlight: a click brings it there
  $('#panel').addEventListener('click', (e) => {
    if (r.body.classList.contains('stage-strip') && !onButton(e)) ipc.stageTile('spot');
  });

  // Sent to everyone on the stage: asked in its active tab as if typed there (waiting its
  // turn if it's busy), tagged with who else got it. What you'd typed here stays put.
  function askFromStage(a: Extract<StageEvent, { kind: 'ask' }>, files: FileInfo[]) {
    if (r.state.away) return;
    if (!r.state.awake) r.wake({ sayHi: false });
    const tab = r.active();
    if (!tab) return;
    const draft = { text: r.input.value, files: r.state.attachments };
    const tag = a.all ? `📣 to everyone on stage (${a.to.length})` : `📣 to ${a.to.join(', ')}`;
    r.input.value = a.prompt;
    r.state.attachments = files;
    // (both put the message in the chat straight away, then wait for main)
    if (tab.busy) r.queueQuestion(tab, a.prompt, tag);
    else r.submit({ again: true, tag });
    r.input.value = draft.text;
    r.state.attachments = draft.files;
    r.renderAttachments();
    r.autosize();
  }

  ipc.on('robot:stage', async (ev) => {
    if (ev.kind === 'pick') {
      const pickEl = $('#stage-pick');
      pickEl.hidden = ev.n == null;
      pickEl.textContent = ev.n == null ? '' : String(ev.n);
      r.body.classList.toggle('stage-picked', ev.n != null);
    } else if (ev.kind === 'target') {
      r.body.classList.toggle('stage-target', ev.on);
    } else if (ev.kind === 'ask') {
      const files = ev.paths.length ? await ipc.robotInspectPaths(ev.paths) : [];
      askFromStage(ev, files);
    }
  });
  return {
    setStaged,
    get staged() {
      return staged;
    },
    set staged(v) {
      staged = v;
    },
  };
}
export type StageApi = ReturnType<typeof createStage>;
