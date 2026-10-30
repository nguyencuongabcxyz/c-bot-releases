// The chat panel's size: drag its outer edge for the width (the window grows or shrinks), its
// free end for the height, or the corner between them for both; double-click one to reset it.
// The height: shorter than the screen if you like (down to CHAT_H_MIN), remembered per
// robot. The window stays the height of the screen (the rest lets clicks through), so this is
// just the page: the panel hangs from the top with the robot up there, else stands on the bottom,
// and its free edge is the one you drag. Double-click: the whole height again.
// (robot.ts calls createChatSize with its hub.)
import { ROBOT_H } from '@/views/robot/constants';
import type { ChatLogApi } from './log';
import type { StageApi } from '@/features/robots/stage/tile';
import type { RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';
import type { Office3DView } from '@/office3d';

/** What it uses of the robot window (robot.ts's hub). */
export type ChatSizeNeeds = {
  readonly body: HTMLElement;
  readonly jumpDown: ChatLogApi['jumpDown'];
  readonly office: Office3DView;
  readonly stagePart: StageApi;
  readonly state: RobotState;
};

export function createChatSize(r: ChatSizeNeeds) {
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
    if (r.stagePart.staged) return; // (on the stage the chat fills its tile: robot:layout)
    const root = document.documentElement.style;
    const h = chatH == null ? fullH() : Math.max(Math.min(CHAT_H_MIN, fullH()), Math.min(chatH, fullH()));
    const fromTop = r.state.robotY + (ROBOT_H * (r.state.scale || 1)) / 2 < winH / 2;
    const top = fromTop ? 8 : winH - 14 - h;
    root.setProperty('--panel-top', `${top}px`);
    root.setProperty('--panel-bottom', `${winH - top - h}px`);
    r.body.classList.toggle('chat-from-top', fromTop);
    r.body.classList.toggle('chat-short', h < fullH() - 2);
    // the tail points at the robot's head (kept on the panel's straight edge)
    const headY = r.state.robotY + r.office.headPosition().y - top;
    root.setProperty('--tail-y', `${Math.round(Math.min(Math.max(headY, 40), h - 70))}px`);
  }
  function sizeGrip(grip: HTMLElement, width: boolean, height: boolean) {
    const way = width && height ? 'd' : width ? 'h' : 'v';
    onDrag(grip, (e) => {
      e.preventDefault();
      const startH = $('#panel').getBoundingClientRect().height;
      const fromTop = r.body.classList.contains('chat-from-top');
      let raf = 0;
      r.body.classList.add('resizing', `resizing-${way}`);
      if (width) ipc.robotResize({ phase: 'start' });
      return {
        move: ({ dx, dy }) => {
          if (height) {
            chatH = Math.round(Math.max(CHAT_H_MIN, Math.min(fullH(), startH + (fromTop ? dy : -dy))));
            placePanel();
          }
          if (!width) return;
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => ipc.robotResize({ phase: 'move', dx }));
        },
        end: () => {
          cancelAnimationFrame(raf);
          r.body.classList.remove('resizing', `resizing-${way}`);
          if (width) ipc.robotResize({ phase: 'end' });
          if (height) {
            if (chatH != null && chatH >= fullH() - 2) chatH = null; // (all the way: the height of the screen, whatever screen)
            ipc.robotChatHeight(chatH);
          }
          r.jumpDown();
        },
      };
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
    const roomy = r.body.classList.contains('expanded') || r.state.placement.startsWith('tuck'); // windows with see-through parts
    if (!roomy || r.body.classList.contains('resizing') || r.body.classList.contains('dragging'))
      return setClickThrough(false);
    setClickThrough(e.target === document.body || e.target === document.documentElement);
  });
  return {
    placePanel,
    setClickThrough,
    get chatH() {
      return chatH;
    },
    set chatH(v) {
      chatH = v;
    },
    get winH() {
      return winH;
    },
    set winH(v) {
      winH = v;
    },
  };
}
export type ChatSizeApi = ReturnType<typeof createChatSize>;
