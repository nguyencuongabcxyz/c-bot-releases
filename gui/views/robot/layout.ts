// Where main has put the window (robot:layout): the robot's spot on the screen, the chat panel's
// room beside it (or the stage's tile), which side it opens on; and the panel's pop-in, played
// again once the window shows at its new size.
// (robot.ts calls createWindowLayout with its hub.)
import type { ChatSizeApi } from '@/features/chat/size';
import type { ChatLogApi } from '@/features/chat/log';
import type { StageApi } from '@/features/robots/stage/tile';
import type { SidePanelApi } from '@/features/chat/side/panel';
import type { RobotState } from './types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { Layout } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type WindowLayoutNeeds = {
  readonly body: HTMLElement;
  readonly chatSizePart: ChatSizeApi;
  readonly placePanel: ChatSizeApi['placePanel'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly setClickThrough: ChatSizeApi['setClickThrough'];
  readonly setStaged: StageApi['setStaged'];
  readonly sides: SidePanelApi['sides'];
  readonly stagePart: StageApi;
  readonly state: RobotState;
};

export function createWindowLayout(r: WindowLayoutNeeds) {
  ipc.on('robot:layout', (l) => {
    const root = document.documentElement.style;
    r.state.placement = l.placement;
    r.state.robotX = l.robotX;
    r.state.robotY = l.robotY;
    root.setProperty('--robot-x', `${l.robotX}px`);
    root.setProperty('--robot-y', `${l.robotY}px`);
    r.setStaged(l.placement === 'stage' ? (l.stage ?? {}) : null, l.inset ?? 4);
    if (l.panel && r.stagePart.staged) {
      root.setProperty('--panel-x', `${l.panel.x}px`);
      root.setProperty('--panel-w', `${l.panel.w}px`);
      r.chatSizePart.winH = l.bounds.height;
    } else if (l.panel) {
      root.setProperty('--panel-x', `${l.panel.x}px`);
      root.setProperty('--panel-w', `${l.panel.w}px`);
      r.chatSizePart.winH = l.bounds.height;
      r.placePanel(); // (its height, and the tail at the robot's head)
    }
    r.sides.layout(l); // (the side panel open: it shares the panel's room)
    r.body.classList.toggle('expanded', l.expanded);
    r.body.classList.toggle('side-left', l.placement === 'left');
    r.body.classList.toggle('side-right', l.placement === 'right');
    r.body.classList.toggle('room-above', l.robotY > 60);
    r.body.classList.toggle('tuck-above', l.placement === 'tuck-above');
    r.body.classList.toggle('tuck-below', l.placement === 'tuck-below');
    r.body.classList.toggle('tuck-left', l.side === 'left'); // (which side the chat opens on: the strip lines up with the robot on that side)
    if (l.placement === 'none' || l.placement === 'hidden') r.setClickThrough(false);
    if (l.expanded) r.scrollDown();
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
  return {};
}
export type WindowLayoutApi = ReturnType<typeof createWindowLayout>;
